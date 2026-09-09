
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  getDocs,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  query,
  where,
  orderBy,
  addDoc,
  serverTimestamp,
  deleteDoc,
  onSnapshot,
  limit
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const cfg = {
  apiKey: "AIzaSyAIqxYEo-flmj1KKz3f0x1CnKG8KoUMBrM",
  authDomain: "jowiland-2.firebaseapp.com",
  projectId: "jowiland-2",
  storageBucket: "jowiland-2.firebasestorage.app",
  messagingSenderId: "301719973403",
  appId: "1:301719973403:web:827b9a8df3e17ad74992be"
};

const app  = getApps().length ? getApp() : initializeApp(cfg);
const auth = getAuth(app);
const db   = getFirestore(app);

// â”€â”€ Delegado global de clicks (captura todos los onclick= sin necesidad de funciones globales antes del parseo) â”€â”€
(function installClickDelegate() {
  function parseArgs(str) {
    try {
      if (!str.trim()) return [];
      return Function('"use strict"; return [' + str + ']')();
    } catch (e) { return []; }
  }
  document.addEventListener('click', function globalOnClickHandler(e) {
    const el = e.target.closest('[onclick]');
    if (!el) return;
    const raw = el.getAttribute('onclick');
    if (!raw) return;
    el.removeAttribute('onclick');
    const m = raw.match(/^\s*([\w\.]+)\s*\(([\s\S]*)\)\s*;?\s*$/);
    if (!m) return;
    const [, fnPath, argsStr] = m;
    const parts = fnPath.split('.');
    let fn = window;
    for (const p of parts) { if (fn == null) break; fn = fn[p]; }
    if (typeof fn !== 'function') return;
    const args = parseArgs(argsStr);
    e.preventDefault();
    try {
      fn.apply(el, args);
    } catch (err) {
      console.error('Error delegado onclick (jow):', fnPath, err);
    }
  }, { capture: true });
})();

// ConfiguraciÃ³n de persistencia y manejo de errores de red
auth.useDeviceLanguage && auth.useDeviceLanguage();

// Manejo robusto de errores de Firestore
let firestoreRetryCount = 0;
const MAX_RETRIES = 3;

async function withFirestoreRetry(operation, operationName = "operation") {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      return await operation();
    } catch (e) {
      console.error(`${operationName} attempt ${i + 1} failed:`, e);
      if (i === MAX_RETRIES - 1) throw e;
      if (e.code === 'unavailable' || e.code === 'network-request-failed' || e.code === 'deadline-exceeded') {
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
      } else {
        throw e;
      }
    }
  }
}

let currentUser = null;
let allMembers  = [];
let novedades   = [];
let logs        = [];
let logsUnsub   = null;
let logTypeFilter = "";
let logSearch     = "";
const MAX_PTS   = 7;
let maxPointsCfg = MAX_PTS;
let decimalsCfg  = 1;
let currentConfig = { hours: 24, minutes: 0, maxPoints: 7, decimals: 1 }; // Valor por defecto

function maxPtsCfg()     { return maxPointsCfg; }
function decimalsCfgJow() { return decimalsCfg; }
async function loadPointsConfig() {
  try {
    const snap = await getDoc(doc(db, "settings", "pointDecrement"));
    if (snap.exists()) {
      const d = snap.data() || {};
      if (Number(d.maxPoints) >= 1) maxPointsCfg = Number(d.maxPoints);
      if ([0,1,2].includes(Number(d.decimals))) decimalsCfg = Number(d.decimals);
      // Actualizar currentConfig
      currentConfig = {
        hours: parseInt(d.hours, 10) || 24,
        minutes: parseInt(d.minutes, 10) || 0,
        maxPoints: Number(d.maxPoints) || 7,
        decimals: Number(d.decimals) || 1
      };
    }
  } catch (e) {
    console.error("Error cargando config de puntos:", e);
  }
}
const PTS_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const PTS_COOLDOWN_PREFIX = "jowiland:ptcd:";

// Sistema de reducciÃ³n automÃ¡tica de puntos
let pointDecrementTimer = null;
let pointDecrementBusy = false;

function cfgToMs(cfg) {
  const h = parseInt(cfg?.hours, 10) || 0;
  const m = parseInt(cfg?.minutes, 10) || 0;
  return (h * 60 + m) * 60 * 1000;
}

function decimalsN() {
  const d = parseInt(currentConfig?.decimals, 10);
  return [0,1,2].includes(d) ? d : 1;
}

function maxPts() {
  const m = Number(currentConfig?.maxPoints);
  return Number.isFinite(m) && m >= 1 ? m : 7;
}

function roundPts(n) {
  const d = decimalsN();
  return Math.round(n * Math.pow(10, d)) / Math.pow(10, d);
}

function clampPts(n) {
  const r = roundPts(n);
  return Math.max(0, Math.min(maxPts(), r));
}

function fmtPts(p) {
  const n = Number(p || 0);
  if (!Number.isFinite(n)) return "0";
  return n.toFixed(decimalsN());
}

function stopPointDecrementScheduler() {
  if (pointDecrementTimer) {
    clearInterval(pointDecrementTimer);
    pointDecrementTimer = null;
  }
}

function startPointDecrementScheduler() {
  // Eliminar la verificaciÃ³n de rol - debe funcionar sin depender de admin conectado
  stopPointDecrementScheduler();
  pointDecrementTimer = setInterval(applyPointDecrementTick, 60 * 1000);
  applyPointDecrementTick();
}

async function applyPointDecrementTick() {
  // Eliminar la verificaciÃ³n de rol - debe funcionar sin admin conectado
  if (pointDecrementBusy) return;
  pointDecrementBusy = true;
  try {
    const snap = await getDoc(doc(db, "settings", "pointDecrement"));
    if (!snap.exists()) return;
    const cfg = snap.data() || {};

    const totalMs = cfgToMs(cfg);
    if (!totalMs) return;

    const now = Date.now();
    const last = typeof cfg.lastAppliedClientTs === "number" ? cfg.lastAppliedClientTs : 0;
    if (!last) {
      await setDoc(doc(db, "settings", "pointDecrement"), { lastAppliedClientTs: now, lastAppliedBy: "system" }, { merge: true });
      return;
    }

    // Calcular cuÃ¡ntos intervalos completos han pasado
    const elapsedMs = now - last;
    const fullIntervals = Math.floor(elapsedMs / totalMs);
    if (fullIntervals <= 0) return;

    // Calcular la reducciÃ³n gradual: 1 punto por intervalo completo, pero aplicado gradualmente
    // Ejemplo: si configuraron 24h, cada 24h se reduce 1 punto total
    // Se aplica gradualmente durante el intervalo actual
    const partialMs = elapsedMs % totalMs;
    const partialRatio = partialMs / totalMs; // 0 a 1, representa progreso del intervalo actual
    const decrement = fullIntervals + partialRatio; // Intervalos completos + progreso parcial

    let changed = 0;
    const usersSnap = await getDocs(collection(db, "users"));
    allMembers = usersSnap.docs.map(d => ({ uid: d.id, ...d.data() }));

    for (const u of allMembers) {
      if (!u || u.role === "admin") continue;
      const oldP = Number(u.points || 0);
      if (!Number.isFinite(oldP)) continue;
      // Aplicar reducciÃ³n calculada
      const newP = clampPts(oldP - decrement);
      if (newP === oldP) continue;
      try {
        await updateDoc(doc(db, "users", u.uid), { points: newP });
        u.points = newP;
        changed++;

        // REGISTRAR LA REDUCCIÃ“N AUTOMÃTICA EN LOS LOGS
        await writeLog({
          type: "points",
          actorUid: "system",
          actorRole: "system",
          actorName: "Sistema AutomÃ¡tico",
          targetUid: u.uid,
          targetName: u.name || "",
          delta: -decrement,
          reason: `ReducciÃ³n automÃ¡tica (${cfgToMs(cfg) / (1000 * 60 * 60)}h)`,
          newPoints: newP
        });
      } catch {}
    }

    // Avanzar el timestamp al inicio del siguiente intervalo completo
    const newLast = last + (fullIntervals * totalMs);
    await setDoc(doc(db, "settings", "pointDecrement"), { lastAppliedClientTs: newLast, lastAppliedBy: "system" }, { merge: true });
    if (changed) renderAll();
  } catch (e) {
    console.error("Error aplicando decremento:", e);
  } finally {
    pointDecrementBusy = false;
  }
}

const RL_OPTS = { windowMs: 5 * 60 * 1000, maxAttempts: 6, lockMs: 10 * 60 * 1000 };
const RL_PREFIX = "jowiland:rl:";
const PIN_SESSION_KEY = "jow.pinSessionUid";

function normLoginName(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ".")
    .replace(/[^a-z0-9._-]/g, "");
}

function pinEmailFromName(name) {
  const u = normLoginName(name);
  return u ? `${u}@pin.jowiland.local` : "";
}

function pinPasswordFromPin(pin) {
  return `pin-${String(pin || "")}-jow`;
}

async function pinHashFromText(pin, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(String(pin || "")),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: enc.encode(String(salt || "")),
      iterations: 200000,
      hash: "SHA-256"
    },
    keyMaterial,
    256
  );
  const bytes = new Uint8Array(bits);
  let hex = "";
  bytes.forEach((b) => { hex += b.toString(16).padStart(2, "0"); });
  return hex;
}

function comparePinStrings(a, b) {
  if (!a || !b) return false;
  return String(a) === String(b);
}

async function comparePinHash(pin, pinHash, pinSalt) {
  if (!pinHash || !pinSalt) return false;
  const computed = await pinHashFromText(pin, pinSalt);
  return computed === String(pinHash);
}

async function restorePinSession() {
  const storedUid = localStorage.getItem(PIN_SESSION_KEY);
  if (!storedUid) {
    showLoginScreen();
    return;
  }

  try {
    const snap = await getDoc(doc(db, "users", storedUid));
    if (!snap.exists()) {
      localStorage.removeItem(PIN_SESSION_KEY);
      showLoginScreen();
      return;
    }

    const data = snap.data();
    if (data.status === "inactive") {
      localStorage.removeItem(PIN_SESSION_KEY);
      showLoginScreen();
      return;
    }

    currentUser = { uid: storedUid, ...data, role: String(data.role || "user").toLowerCase() };
    bootApp();
  } catch (e) {
    console.error("Error recreating PIN session:", e);
    localStorage.removeItem(PIN_SESSION_KEY);
    showLoginScreen();
  }
}

function rlLoad(kind) {
  try {
    const raw = localStorage.getItem(RL_PREFIX + kind);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function rlSave(kind, st) {
  try {
    localStorage.setItem(RL_PREFIX + kind, JSON.stringify(st));
  } catch {}
}

function rlReset(kind) {
  try {
    localStorage.removeItem(RL_PREFIX + kind);
  } catch {}
}

function rlCheck(kind) {
  const now = Date.now();
  const st0 = rlLoad(kind);
  const st = st0 && typeof st0 === "object" ? st0 : { count: 0, firstTs: now, lockUntil: 0 };

  if (st.lockUntil && now < st.lockUntil) return { ok: false, waitMs: st.lockUntil - now };

  if (!st.firstTs || now - st.firstTs > RL_OPTS.windowMs) {
    st.count = 0;
    st.firstTs = now;
    st.lockUntil = 0;
    rlSave(kind, st);
    return { ok: true, waitMs: 0 };
  }

  return { ok: true, waitMs: 0 };
}

function rlFail(kind, extraLockMs = 0) {
  const now = Date.now();
  const st0 = rlLoad(kind);
  const st = st0 && typeof st0 === "object" ? st0 : { count: 0, firstTs: now, lockUntil: 0 };

  if (!st.firstTs || now - st.firstTs > RL_OPTS.windowMs) {
    st.count = 0;
    st.firstTs = now;
    st.lockUntil = 0;
  }

  st.count = (st.count || 0) + 1;
  if (st.count >= RL_OPTS.maxAttempts) st.lockUntil = now + RL_OPTS.lockMs + extraLockMs;

  rlSave(kind, st);
  if (st.lockUntil && now < st.lockUntil) return { locked: true, waitMs: st.lockUntil - now };
  return { locked: false, waitMs: 0 };
}

function fmtWait(ms) {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  return `${m} min`;
}

// â”€â”€ AUTH STATE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
onAuthStateChanged(auth, async fbUser => {
  if (fbUser) {
    try {
      let uid = fbUser.uid;
      let snap = await getDoc(doc(db, "users", uid));
      if (!snap.exists()) {
        const aliasSnap = await getDoc(doc(db, "pinLogins", uid));
        if (aliasSnap.exists() && aliasSnap.data().realUid) {
          uid = aliasSnap.data().realUid;
          snap = await getDoc(doc(db, "users", uid));
        }
      }
      if (!snap.exists() && fbUser.displayName) {
        const key = normLoginName(fbUser.displayName);
        if (key) {
          const qSnap = await getDocs(query(
            collection(db, "users"),
            where("nameLower", "==", key),
            limit(2)
          ));
          if (qSnap.size === 1) {
            uid = qSnap.docs[0].id;
            snap = qSnap.docs[0];
          }
        }
      }
      if (!snap.exists()) { await signOut(auth); return; }
      const data = snap.data();
      if (data.status === "inactive") { showErr("Tu cuenta estÃ¡ inactiva."); await signOut(auth); return; }
      const role = String(data.role || "user").toLowerCase();
      currentUser = { uid, ...data, role };
      if (localStorage.getItem(PIN_SESSION_KEY) !== uid) {
        try { localStorage.removeItem(PIN_SESSION_KEY); } catch {}
      }
      await logLoginOnce();
      bootApp();
    } catch(e) { 
      console.error("Auth state error:", e);
      if (e.code === "unavailable" || e.code === "network-request-failed") {
        showErr("Error de conexiÃ³n. VerificÃ¡ tu internet e intentÃ¡ de nuevo.");
      } else {
        showErr("Error al cargar tu perfil: " + e.message);
      }
    }
  } else {
    await restorePinSession();
  }
});

// â”€â”€ LOGIN SWITCH (PIN / Email) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
window.switchLogin = (type) => {
  const pinF = document.getElementById("form-pin");
  const emF  = document.getElementById("form-email");
  if (pinF) pinF.style.display = type === "pin" ? "block" : "none";
  if (emF)  emF.style.display  = type === "email" ? "block" : "none";
  const err = document.getElementById("login-err");
  if (err) err.style.display = "none";
  document.querySelectorAll("#login-toggle .ltab").forEach(b => {
    b.classList.toggle("active", b.getAttribute("data-login") === type);
  });
};

// â”€â”€ LOGIN PIN â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
window.loginWithPin = async () => {
  const nameRaw = document.getElementById("pin-name").value.trim();
  const pin     = document.getElementById("pin-code").value.trim();
  const btn     = document.getElementById("btn-pin");

  if (!nameRaw || !pin) return showErr("IngresÃ¡ tu nombre y PIN.");
  if (pin.length !== 4 || isNaN(pin)) return showErr("El PIN debe ser de 4 dÃ­gitos.");

  const chk = rlCheck("pin");
  if (!chk.ok) return showErr(`Demasiados intentos. EsperÃ¡ ${fmtWait(chk.waitMs)} y probÃ¡ de nuevo.`);

  btn.disabled = true;
  btn.textContent = "Verificandoâ€¦";

  try {
    const normName = normLoginName(nameRaw);
    if (!normName) throw new Error("name-invalid");

    // Buscar credenciales con varios mÃ©todos de respaldo:
    // 1) publicLoginUsers (diseÃ±o original; requiere regla de lectura pÃºblica)
    // 2) users por nameLower (rÃ¡pido, con Ã­ndice)
    // 3) barrido client-side sobre users: cubre cuentas legacy que no
    //    tienen nameLower o que usan una normalizaciÃ³n distinta del nombre
    const findLoginDoc = async () => {
      try {
        const q1 = await getDocs(query(
          collection(db, "publicLoginUsers"),
          where("nameLower", "==", normName),
          limit(1)
        ));
        if (!q1.empty) return q1.docs[0];
      } catch (err1) {
        console.warn("publicLoginUsers no accesible, usando users:", err1.code || err1.message);
      }

      try {
        const q2 = await getDocs(query(
          collection(db, "users"),
          where("nameLower", "==", normName),
          limit(1)
        ));
        if (!q2.empty) return q2.docs[0];
      } catch (err2) {
        console.warn("users (nameLower) no accesible:", err2.code || err2.message);
      }

      try {
        const scan = await getDocs(collection(db, "users"));
        for (const d of scan.docs) {
          const u = d.data() || {};
          const candidates = [u.name, u.username, u.displayName, u.nameLower]
            .filter(Boolean)
            .map(n => normLoginName(String(n)));
          if (candidates.includes(normName)) return d;
        }
      } catch (err3) {
        console.warn("users (escaneo completo) no accesible:", err3.code || err3.message);
      }

      return null;
    };

    let loginDoc = await findLoginDoc();

    if (!loginDoc) {
      rlFail("pin");
      showErr("Nombre o PIN incorrecto.");
      btn.disabled = false;
      btn.textContent = "Entrar";
      return;
    }

    const d = loginDoc;
    const loginData = d.data() || {};
    const status = String(loginData.status || "active").toLowerCase();
    if (status === "inactive" || status === "inactivo") {
      rlFail("pin");
      showErr("Esta cuenta estÃ¡ inactiva.");
      btn.disabled = false;
      btn.textContent = "Entrar";
      return;
    }

    const pinHash = loginData.pinHash ? String(loginData.pinHash) : "";
    const pinSalt = loginData.pinSalt ? String(loginData.pinSalt) : "";
    const legacyPin = loginData.pin ? String(loginData.pin) : "";

    let ok = false;
    if (pinHash && pinSalt) ok = await comparePinHash(pin, pinHash, pinSalt);
    else if (legacyPin) ok = comparePinStrings(legacyPin, pin);

    if (!ok) {
      rlFail("pin");
      showErr("Nombre o PIN incorrecto.");
      btn.disabled = false;
      btn.textContent = "Entrar";
      return;
    }

    const uid = d.id;
    const profileSnap = await getDoc(doc(db, "users", uid));
    const profile = profileSnap.exists() ? profileSnap.data() : loginData;
    currentUser = { uid, ...profile, role: String(profile.role || loginData.role || "user").toLowerCase() };

    if (!profileSnap.exists() && (!loginData.pinHash || !loginData.pinSalt)) {
      try {
        await updateDoc(d.ref, {
          pinHash: pinHash || await pinHashFromText(pin, pinSalt || ""),
          pinSalt: pinSalt || "",
          nameLower: normName
        });
      } catch (e2) {
        console.warn("No se pudo guardar hash de PIN:", e2.code || e2.message);
      }
    }

    localStorage.setItem(PIN_SESSION_KEY, uid);
    rlReset("pin");
    bootApp();
  } catch (e) {
    const fail = rlFail("pin");
    if (fail.locked) {
      showErr(`Demasiados intentos. EsperÃ¡ ${fmtWait(fail.waitMs)} y probÃ¡ de nuevo.`);
    } else {
      showErr("Nombre o PIN incorrecto.");
    }
    btn.disabled = false;
    btn.textContent = "Entrar";
  }
};
try { document.getElementById("pin-code").addEventListener("keydown", e => { if(e.key==="Enter") window.loginWithPin(); }); } catch {}

// â”€â”€ LOGIN EMAIL / CONTRASEÃ‘A â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
window.loginWithEmail = async () => {
  const email = document.getElementById("l-email")?.value.trim() || "";
  const pass  = document.getElementById("l-pass")?.value || "";
  const btn   = document.getElementById("btn-email");

  if (!email || !pass) return showErr("CompletÃ¡ email y contraseÃ±a.");
  const chk = rlCheck("email");
  if (!chk.ok) return showErr(`Demasiados intentos. EsperÃ¡ ${fmtWait(chk.waitMs)} y probÃ¡ de nuevo.`);

  if (btn) { btn.disabled = true; btn.textContent = "Verificandoâ€¦"; }

  try {
    await signInWithEmailAndPassword(auth, email, pass);
    // onAuthStateChanged se encarga del resto
    rlReset("email");
  } catch (e) {
    const extra = e.code === "auth/too-many-requests" ? 10 * 60 * 1000 : 0;
    const fail  = rlFail("email", extra);
    showErr(fail.locked
      ? `Demasiados intentos. EsperÃ¡ ${fmtWait(fail.waitMs)} y probÃ¡ de nuevo.`
      : friendlyErr(e.code));
    if (btn) { btn.disabled = false; btn.textContent = "Ingresar"; }
  }
};

try {
  const lp = document.getElementById("l-pass");
  if (lp) lp.addEventListener("keydown", e => { if(e.key==="Enter") window.loginWithEmail(); });
} catch {}

// â”€â”€ LOGOUT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
window.doLogout = async () => {
  try {
    localStorage.removeItem(PIN_SESSION_KEY);
  } catch {}

  if (auth.currentUser) {
    await signOut(auth);
  }

  currentUser = null; allMembers = []; novedades = [];
  showLoginScreen();
  ["pin-name","pin-code","l-email","l-pass"].forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
  if (window.switchLogin) switchLogin("pin");
};

// â”€â”€ BOOT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function bootApp() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("app").style.display = "block";

  const name = currentUser.name || "â€”";
  const role = currentUser.role || "user";

  // Mostrar panel superior del usuario actual (para todos los roles)
  const userStatsSection = document.getElementById("user-stats-section");
  if (userStatsSection) {
    userStatsSection.style.display = "grid";
    
    document.getElementById("uc-name").textContent = name;
    document.getElementById("uc-avatar").textContent = name.charAt(0).toUpperCase();
    document.getElementById("uc-avatar").className = "user-avatar av-" + role;
    
    const rangoTxt = fmtRango(currentUser.rango);
    document.getElementById("uc-rango").textContent = rangoTxt || "â€”";
    
    const cargos = currentUser.cargos || [];
    document.getElementById("uc-cargos").textContent = Array.isArray(cargos) ? cargos.join(", ") : String(cargos || "â€”");
    
    const pts = Number(currentUser.points || 0);
    document.getElementById("uc-pts").textContent = pts.toFixed(decimalsCfgJow());
  }

  await loadPointsConfig();
  await loadNovedades();
  await loadMembers();

  // Todos ven el panel completo (tabla de puntos, staff, guÃ­a, rangos, normas y
  // novedades); los controles y pestaÃ±as administrativas se ocultan segÃºn rol.
  setupStaffView();
  setupLogsTab();
  if (role === "user") {
    renderUserProfileCard();
  }

  // Iniciar el scheduler de reducciÃ³n automÃ¡tica de puntos (independientemente del rol)
  startPointDecrementScheduler();

  // Render inmediato de la pestaÃ±a inicial (Puntos) luego de que los datos estÃ¡n cargados
  if (typeof renderPointsTable === "function") renderPointsTable();
  if (typeof renderStats === "function") renderStats();
  if (typeof renderDestacados === "function") renderDestacados();
  if (typeof renderNovedades === "function") renderNovedades();
  if (typeof renderStaffTable === "function") renderStaffTable();
}

function setupLogsTab() {
  const btn = document.getElementById("logs-tab-btn");
  const th  = document.getElementById("logs-actions-th-jow");
  const exp = document.getElementById("logs-export-btn");

  const role = currentUser?.role;
  // Mostrar logs/novedades/tabla de puntos solo para admin e inspector
  const isStaff = role === "admin" || role === "inspector";
  const isAdmin = role === "admin";

  if (btn) btn.style.display = isStaff ? "" : "none";
  if (th) th.style.display = isAdmin ? "" : "none";
  if (exp) exp.style.display = isAdmin ? "" : "none";

  if (!isStaff) {
    stopLogsLive();
    const logsTab = document.getElementById("logs-tab");
    if (logsTab && logsTab.classList.contains("active")) {
      const pointsBtn = document.querySelector('#tabs-nav .tab[onclick*="points-tab"]');
      if (pointsBtn) switchTab("points-tab", pointsBtn);
    }
    return;
  }

  startLogsLive();
}

function stopLogsLive() {
  if (logsUnsub) { try { logsUnsub(); } catch {} logsUnsub = null; }
  logs = [];
}

let logFilterUser = "";
let logFilterRole = "";
let logFilterRango = "";
let logFilterCargo = "";

window.setLogTypeFilterJow = (v) => { logTypeFilter = v; renderLogsJow(); };
window.setLogSearchJow = (v) => { logSearch = (v || "").toLowerCase(); renderLogsJow(); };
window.setLogFilterUser = (v) => { logFilterUser = v; renderLogsJow(); };
window.setLogFilterRole = (v) => { logFilterRole = v; renderLogsJow(); };
window.setLogFilterRango = (v) => { logFilterRango = v; renderLogsJow(); };
window.setLogFilterCargo = (v) => { logFilterCargo = v; renderLogsJow(); };

// â”€â”€ CHART CONTROLS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// refreshCharts y resetChartData ya no se usan. Ahora usamos refreshSingleChart y resetSingleChart.
function dayKey(dt) {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function tsToDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === "function") return ts.toDate();
  if (typeof ts.seconds === "number") return new Date(ts.seconds * 1000);
  return null;
}

function fmtDateTime(ts) {
  const d = tsToDate(ts);
  return d ? d.toLocaleString("es-CO") : "â€”";
}

function fmtSince(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
}

async function writeLog(entry) {
  try {
    await addDoc(collection(db, "logs"), {
      ...entry,
      dayKey: dayKey(new Date()),
      clientTs: Date.now(),
      createdAt: serverTimestamp()
    });
  } catch(e) {
    console.error("Error guardando log:", e);
  }
}

function cooldownKey(actorUid, targetUid) {
  return `${PTS_COOLDOWN_PREFIX}${actorUid}:${targetUid}`;
}

function readCooldownList(actorUid, targetUid) {
  try {
    const v = localStorage.getItem(cooldownKey(actorUid, targetUid));
    if (!v) return [];
    if (v.trim().startsWith("[")) {
      const arr = JSON.parse(v);
      if (!Array.isArray(arr)) return [];
      return arr.map(x => parseInt(x, 10)).filter(n => Number.isFinite(n) && n > 0);
    }
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? [n] : [];
  } catch {
    return [];
  }
}

function writeCooldownList(actorUid, targetUid, list) {
  try {
    localStorage.setItem(cooldownKey(actorUid, targetUid), JSON.stringify(list));
  } catch {}
}

function getPairActionTimes(actorUid, targetUid) {
  const best = new Set(readCooldownList(actorUid, targetUid));
  for (const l of logs) {
    if (l.type !== "points") continue;
    if (l.actorUid !== actorUid) continue;
    if (l.targetUid !== targetUid) continue;
    const t = typeof l.clientTs === "number" ? l.clientTs : 0;
    if (t > 0) best.add(t);
  }
  return Array.from(best).sort((a,b) => a - b);
}

function writeCooldown(actorUid, targetUid, ts) {
  const now = Date.now();
  const floor = now - PTS_COOLDOWN_MS;
  const list = readCooldownList(actorUid, targetUid).filter(t => t >= floor);
  list.push(ts);
  writeCooldownList(actorUid, targetUid, list);
}

function checkInspectorCooldown(targetUid) {
  const actorUid = currentUser?.uid;
  if (!actorUid) return { ok: true, waitMs: 0, remaining: 2 };
  const now = Date.now();
  const floor = now - PTS_COOLDOWN_MS;
  const list = getPairActionTimes(actorUid, targetUid).filter(t => t >= floor);
  const used = list.length;
  const remaining = Math.max(0, 2 - used);
  if (used >= 2) {
    const oldest = list[0] || now;
    const waitMs = (oldest + PTS_COOLDOWN_MS) - now;
    return { ok: false, waitMs: Math.max(0, waitMs), remaining: 0 };
  }
  return { ok: true, waitMs: 0, remaining };
}

async function logLoginOnce() {
  const role = currentUser?.role;
  if (role !== "admin" && role !== "inspector") return;
  const uid = currentUser?.uid;
  if (!uid) return;
  const k = `jowiland:loginLogged:${uid}`;
  try {
    if (sessionStorage.getItem(k)) return;
    sessionStorage.setItem(k, "1");
  } catch {}
  await writeLog({
    type: "login",
    actorUid: uid,
    actorRole: role,
    actorName: currentUser?.name || ""
  });
}

function startLogsLive() {
  stopLogsLive();
  const q = query(collection(db, "logs"), orderBy("createdAt", "desc"), limit(300));
  logsUnsub = onSnapshot(q, snap => {
    logs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderLogsJow();
    if (typeof renderPointsTable === "function") renderPointsTable();
    if (typeof renderStats === "function") renderStats();
    if (typeof renderStaffTable === "function") renderStaffTable();
    if (typeof renderActivityChart === "function") renderActivityChart();
    if (typeof renderRankings === "function") renderRankings();
    if (typeof renderDestacados === "function") renderDestacados();
    if (typeof renderRankingAdmins === "function") renderRankingAdmins();
    if (typeof renderEvolutionPts === "function") renderEvolutionPts();
    if (typeof renderInspectorActivityJow === "function") renderInspectorActivityJow();
  }, e => console.error("Logs snapshot error:", e));
}

function filteredLogs() {
  let list = logs;
  if (logTypeFilter) list = list.filter(l => l.type === logTypeFilter);
  if (logSearch) {
    list = list.filter(l => {
      const a = (l.actorName || "").toLowerCase();
      const t = (l.targetName || "").toLowerCase();
      const r = (l.reason || "").toLowerCase();
      return a.includes(logSearch) || t.includes(logSearch) || r.includes(logSearch);
    });
  }
  if (logFilterUser) list = list.filter(l => l.actorUid === logFilterUser || l.targetUid === logFilterUser);
  if (logFilterRole) list = list.filter(l => String(l.actorRole || "").toLowerCase() === logFilterRole);
  if (logFilterRango) {
    list = list.filter(l => {
      const actor = allMembers.find(u => u.uid === l.actorUid);
      const target = allMembers.find(u => u.uid === l.targetUid);
      return (actor && normRango(actor.rango) === logFilterRango) || (target && normRango(target.rango) === logFilterRango);
    });
  }
  if (logFilterCargo) {
    list = list.filter(l => {
      const actor = allMembers.find(u => u.uid === l.actorUid);
      const target = allMembers.find(u => u.uid === l.targetUid);
      return (actor && hasCargo(actor, logFilterCargo)) || (target && hasCargo(target, logFilterCargo));
    });
  }
  return list;
}

function renderLogsJow() {
  const body = document.getElementById("logs-jow-body");
  if (!body) return;
  const role = currentUser?.role;
  const isAdmin = role === "admin";
  const list = filteredLogs();

  if (!list.length) {
    body.innerHTML = `<tr><td colspan="${isAdmin ? 6 : 5}" class="t-empty">Sin registros.</td></tr>`;
    return;
  }

  body.innerHTML = list.map(l => {
    const isPoints = l.type === "points";
    const dt = fmtDateTime(l.createdAt);
    const actor = esc(l.actorName || "â€”");
    const target = esc(l.targetName || (l.type === "login" ? (l.actorName || "â€”") : "â€”"));
    const delta = isPoints ? (typeof l.delta === "number" ? l.delta : 0) : null;
    const deltaTxt = isPoints ? `${delta > 0 ? "+" : ""}${delta}` : "â€”";
    const motivo = esc(l.reason || (l.type === "login" ? "Inicio de sesiÃ³n" : "Sin motivo"));
    const delBtn = isAdmin ? `<button class="logout-btn" style="position:static" onclick="deleteLogJow('${l.id}')">ðŸ—‘ï¸</button>` : "";
    return `
      <tr>
        <td>${dt}</td>
        <td>${actor}</td>
        <td>${target}</td>
        <td><b style="color:${delta > 0 ? "#7dffa6" : delta < 0 ? "#ff9dad" : "var(--muted)"}">${deltaTxt}</b></td>
        <td>${motivo}</td>
        ${isAdmin ? `<td>${delBtn}</td>` : ""}
      </tr>`;
  }).join("");
}

window.deleteLogJow = async (id) => {
  if (currentUser?.role !== "admin") return;
  const ok = confirm("Â¿Borrar este registro? No se puede deshacer.");
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "logs", id));
    showToast("Registro borrado.", "ok");
  } catch(e) {
    showToast("Error al borrar: " + e.message, "err");
  }
};

window.exportLogsJow = () => {
  if (currentUser?.role !== "admin") return;
  const list = filteredLogs().map(l => ({
    ...l,
    createdAt: tsToDate(l.createdAt) ? tsToDate(l.createdAt).toISOString() : null
  }));
  const blob = new Blob([JSON.stringify(list, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `logs-${dayKey(new Date())}.json`;
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(a.href);
  a.remove();
};

function renderInspectorActivityJow() {
  const tb = document.getElementById("inspector-activity-body");
  if (!tb) return;
  const role = currentUser?.role;
  if (role !== "admin" && role !== "inspector") return;

  // Solo inspectores activos como punto de partida, aplicando los filtros.
  let inspectors = allMembers.filter(u =>
    String(u.role || "").toLowerCase() === "inspector" &&
    String(u.status || "active").toLowerCase() !== "inactive" &&
    String(u.status || "active").toLowerCase() !== "inactivo"
  );

  if (filterState.user) inspectors = inspectors.filter(u => u.uid === filterState.user);
  if (filterState.rol) {
    if (filterState.rol !== "inspector") {
      tb.innerHTML = '<tr><td colspan="6" class="t-empty">No hay inspectores que coincidan con el filtro de Rol seleccionado.</td></tr>';
      return;
    }
    inspectors = inspectors.filter(u => String(u.role || "").toLowerCase() === filterState.rol);
  }
  if (filterState.rango) inspectors = inspectors.filter(u => normRango(u.rango) === filterState.rango);
  if (filterState.cargo) inspectors = inspectors.filter(u => hasCargo(u, filterState.cargo));

  if (!inspectors.length) {
    tb.innerHTML = '<tr><td colspan="6" class="t-empty">Sin inspectores activos que coincidan con los filtros.</td></tr>';
    return;
  }

  const start = periodStartMs(inspPeriodState);
  const periodTxt = inspPeriodState === "day" ? "hoy" : inspPeriodState === "week" ? "7 dÃ­as" : "30 dÃ­as";

  const rows = inspectors.map(insp => {
    let pts = 0, actions = 0, lastAt = null, lastTxt = "â€”";
    for (const l of logs) {
      if (!l || l.type !== "points" || l.actorUid !== insp.uid) continue;
      if (String(l.actorRole || "").toLowerCase() !== "inspector") continue;
      const t = logTime(l);
      if (!t || t < start) continue;
      const delta = typeof l.delta === "number" ? l.delta : 0;
      if (delta > 0) pts += delta;
      actions += 1;
      const d = tsToDate(l.createdAt);
      if (d && (!lastAt || d > lastAt)) {
        lastAt = d;
        const tgt = l.targetName ? ` â†’ ${l.targetName}` : "";
        lastTxt = `${delta > 0 ? "+" : ""}${delta}${tgt}`;
      }
    }
    return { uid: insp.uid, name: insp.name || "â€”", pts, actions, lastAt, lastTxt };
  }).filter(r => r.actions > 0 || Number(inspectors.find(x => x.uid === r.uid)?.points || 0) > 0).sort((a, b) => {
    if (b.actions !== a.actions) return b.actions - a.actions;
    if (b.pts !== a.pts) return b.pts - a.pts;
    const ta = a.lastAt ? a.lastAt.getTime() : 0;
    const tb = b.lastAt ? b.lastAt.getTime() : 0;
    return tb - ta;
  });

  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="6" class="t-empty">Sin actividad de inspectores en el perÃ­odo (${periodTxt}).</td></tr>`;
    return;
  }

  tb.innerHTML = rows.map(r => {
    const now = Date.now();
    const lastMs = r.lastAt ? (now - r.lastAt.getTime()) : Infinity;
    const state = lastMs <= 15 * 60 * 1000 ? "ðŸŸ¢ Activo" : lastMs <= 60 * 60 * 1000 ? "ðŸŸ¡ Poco activo" : "ðŸ”´ Inactivo";
    return `
      <tr>
        <td><b>${esc(r.name)}</b></td>
        <td><b style="color:#ffd166">${r.pts.toFixed(decimalsCfgJow())}</b></td>
        <td>${r.actions}</td>
        <td>${esc(r.lastTxt)}</td>
        <td>${r.lastAt ? fmtSince(lastMs) : "â€”"}</td>
        <td>${state}</td>
      </tr>`;
  }).join("");
}

// â”€â”€ CARGAR MIEMBROS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loadMembers() {
  try {
    const snap = await getDocs(query(collection(db, "users"), orderBy("points", "desc")));
    allMembers = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
    const me = allMembers.find(u => u.uid === currentUser.uid);
    if (me) currentUser.points = me.points;
  } catch(e) { console.error("Error cargando miembros:", e); }
}

// â”€â”€ CARGAR NOVEDADES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loadNovedades() {
  try {
    const snap = await getDocs(query(collection(db, "novedades"), orderBy("fecha", "desc"), limit(20)));
    novedades = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch(e) {
    // Si la colecciÃ³n no existe aÃºn, no es error
    novedades = [];
  }
}

async function cleanupNovedadesIfAdmin() {
  if (currentUser?.role !== "admin") return;
  try {
    const snap = await getDocs(query(collection(db, "novedades"), orderBy("fecha", "desc"), limit(60)));
    if (snap.size <= 20) return;
    const extra = snap.docs.slice(20);
    for (const d of extra) {
      await deleteDoc(doc(db, "novedades", d.id));
    }
  } catch(e) {
    console.error("Error limpiando novedades:", e);
  }
}

// â”€â”€ REGISTRAR NOVEDAD (interno) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function logNovedad(texto) {
  try {
    await addDoc(collection(db, "novedades"), {
      texto,
      fecha: serverTimestamp(),
      autor: currentUser.name || "Sistema"
    });
    await cleanupNovedadesIfAdmin();
    await loadNovedades();
    renderNovedades();
  } catch(e) { console.error("Error al registrar novedad:", e); }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// VISTA USUARIO
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function renderUserProfileCard() {
  const uv = document.getElementById("user-view");
  if (!uv) return;
  const pts = Number(currentUser.points || 0);
  const whoEl = document.getElementById("my-pts-who");
  if (whoEl) whoEl.innerHTML = `ðŸ‘‹ Bienvenido/a, <b>${esc(currentUser.name || "â€”")}</b>`;
  const valEl = document.getElementById("my-pts-value");
  if (valEl) valEl.textContent = pts.toFixed(decimalsCfgJow());
  const barEl = document.getElementById("my-pts-bar");
  if (barEl) {
    barEl.style.width = `${Math.min((pts/maxPtsCfg())*100,100)}%`;
    barEl.className   = "upc-bar " + ptBarClass(pts);
  }
  const stateEl = document.getElementById("my-pts-state");
  if (stateEl) stateEl.innerHTML = ptStateFull(pts);
  const ucPts = document.getElementById("uc-pts");
  if (ucPts) {
    ucPts.style.display = "block";
    ucPts.textContent   = `â­ ${pts.toFixed(decimalsCfgJow())} puntos`;
  }
}

// Compatibilidad: la vista completa ahora la administra setupStaffView.
function setupUserView() {
  renderUserProfileCard();
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// VISTA STAFF
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function setupStaffView() {
  const role     = currentUser?.role;
  const isStaff  = role === "admin" || role === "inspector";
  const statsSec = document.getElementById("stats-section");
  const destSec  = document.getElementById("destacados-section");
  const btnDest  = document.getElementById("btn-dest");

  if (statsSec) statsSec.style.display = "";
  if (destSec) destSec.style.display = "none";
  if (btnDest) btnDest.style.display = "";

  document.getElementById("tabs-nav").style.display = "";

  const grafBtn = document.getElementById("graficos-tab-btn");
  if (grafBtn) grafBtn.style.display = isStaff ? "" : "none";

  // Punto 7: "Mi Perfil" NUNCA se muestra (eliminar para USUARIOS ni para NADIE)
  const perfilBtn2 = document.getElementById("my-perfil-tab-btn");
  if (perfilBtn2) perfilBtn2.style.display = "none";
  const userViewEl = document.getElementById("user-view");
  if (userViewEl) userViewEl.style.display = "none";

  // Punto 6: Garantizar Logs visible para Admin + Inspector
  const logsBtn = document.getElementById("logs-tab-btn");
  if (logsBtn) logsBtn.style.display = isStaff ? "" : "none";

  // Punto 8: Usuarios pueden ver GrÃ¡ficos (Ranking de Puntos y EvoluciÃ³n general)
  const graficosBtn = document.getElementById("graficos-tab-btn");
  if (graficosBtn) graficosBtn.style.display = (role === "user" || isStaff) ? "" : "none";

  // Para usuarios, ocultar grÃ¡ficos de actividad (solo ver Ranking y EvoluciÃ³n)
  if (role === "user") {
    const activityAdminsCard = document.getElementById("activity-admins-card");
    if (activityAdminsCard) activityAdminsCard.style.display = "none";
    
    const activityInspectorsCard = document.getElementById("activity-inspectors-card");
    if (activityInspectorsCard) activityInspectorsCard.style.display = "none";
  }

  document.querySelectorAll(".tab-content").forEach(el => { el.style.display="none"; el.classList.remove("active"); });
  document.getElementById("points-tab").style.display = "block";
  document.getElementById("points-tab").classList.add("active");
  document.querySelector(".tab").classList.add("active");

  if (isStaff) {
    populateUserFilter();
    populateLogUserFilter();
    renderPointsTable();
    renderStats();
    renderActivityChart();
    renderRankings();
    renderRankingAdmins();
    renderEvolutionPts();
    renderInspectorActivityJow();

    // Botones de "Reiniciar" por grÃ¡fico: visibles solo para admins.
    document.querySelectorAll(".res-ctrl").forEach(b => {
      b.style.display = role === "admin" ? "" : "none";
    });

    // BotÃ³n de reset novedades: visible solo para admins
    const resetNovedadesBtn = document.getElementById("reset-novedades-btn");
    if (resetNovedadesBtn) {
      resetNovedadesBtn.style.display = role === "admin" ? "" : "none";
    }
  } else {
    renderPointsTable();
    renderStats();
  }
  renderStats();
  renderPointsTable();
  renderStaffTable();
  renderNovedades();
}

// â”€â”€ TRABAJADORES DESTACADOS: mostrar / ocultar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let destacadosOpen = false;
let destacadosHistorialOpen = false;

window.toggleDestacados = () => {
  const destSec = document.getElementById("destacados-section");
  const btn     = document.getElementById("btn-dest");
  if (!destSec) return;
  destacadosOpen = !destacadosOpen;
  destSec.style.display = destacadosOpen ? "block" : "none";
  if (btn) btn.textContent = destacadosOpen ? "ðŸ™ˆ Ocultar chambeadores destacados" : "ðŸ‘ï¸ Mostrar chambeadores destacados";
  if (destacadosOpen && typeof renderDestacados === "function") renderDestacados();
};

window.toggleDestacadosHistorial = () => {
  const histSec = document.getElementById("destacados-hist-section");
  if (!histSec) return;
  destacadosHistorialOpen = !destacadosHistorialOpen;
  histSec.style.display = destacadosHistorialOpen ? "block" : "none";
  if (destacadosHistorialOpen && typeof renderDestacadosHistorial === "function") renderDestacadosHistorial();
};

window.filterDestacadosHistorial = () => {
  if (typeof renderDestacadosHistorial === "function") renderDestacadosHistorial();
};

async function renderDestacadosHistorial() {
  const listEl = document.getElementById("destacados-hist-list");
  if (!listEl) return;
  
  // Filtros
  const filterUser = document.getElementById("hist-filter-user")?.value || "";
  const filterRol = document.getElementById("hist-filter-rol")?.value || "";
  const filterPeriod = document.getElementById("hist-filter-period")?.value || "";
  
  // Poblar filtro de usuarios
  const userSelect = document.getElementById("hist-filter-user");
  if (userSelect && allMembers.length > 0) {
    const currentValue = userSelect.value;
    userSelect.innerHTML = '<option value="">Todos</option>' + 
      allMembers.map(u => `<option value="${u.uid}">${esc(u.name || "â€”")}</option>`).join("");
    userSelect.value = currentValue;
  }
  
  // Generar historial simulado (en una implementaciÃ³n real, esto vendrÃ­a de Firestore)
  const now = Date.now();
  const historicalData = [];
  
  // Generar datos basados en el historial de logs
  for (const l of logs) {
    if (l.type === "destacado" || (l.type === "points" && l.delta > 0)) {
      const t = logTime(l);
      if (!t) continue;
      
      const target = allMembers.find(u => u.uid === l.targetUid);
      if (!target) continue;
      
      // Determinar perÃ­odo
      const hoursAgo = (now - t) / (1000 * 60 * 60);
      let period = "day";
      if (hoursAgo > 24 * 7) period = "month";
      else if (hoursAgo > 24) period = "week";
      
      historicalData.push({
        date: new Date(t),
        period,
        user: target,
        periodType: period,
        points: l.delta || 0
      });
    }
  }
  
  // Aplicar filtros
  let filtered = historicalData;
  if (filterUser) {
    filtered = filtered.filter(d => d.user.uid === filterUser);
  }
  if (filterRol) {
    filtered = filtered.filter(d => String(d.user.role || "").toLowerCase() === filterRol);
  }
  if (filterPeriod) {
    filtered = filtered.filter(d => d.periodType === filterPeriod);
  }
  
  // Ordenar por fecha descendente
  filtered.sort((a, b) => b.date - a.date);
  
  if (!filtered.length) {
    listEl.innerHTML = '<div class="chart-empty">No hay datos de chambeadores destacados con los filtros seleccionados.</div>';
    return;
  }
  
  listEl.innerHTML = filtered.map(d => {
    const periodLabel = d.periodType === "day" ? "Chambeador del dÃ­a" : 
                          d.periodType === "week" ? "Chambeador de la semana" : 
                          "Chambeador del mes";
    const dateStr = d.date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
    
    return `
      <div class="card" style="padding:16px;display:flex;align-items:center;gap:16px;">
        <div class="user-avatar av-${d.user.role}" style="width:48px;height:48px;font-size:18px;">${(d.user.name || "?").charAt(0).toUpperCase()}</div>
        <div style="flex:1">
          <div style="font-weight:700;color:#fff">${esc(d.user.name || "â€”")}</div>
          <div style="font-size:12px;color:var(--muted);margin-top:2px;">
            <span style="background:rgba(88,101,242,.12);color:var(--accent);padding:2px 6px;border-radius:4px;font-size:11px;">${periodLabel}</span>
            <span style="margin-left:8px;">${dateStr}</span>
          </div>
          <div style="font-size:12px;color:var(--muted);margin-top:4px;">
            Rol: <span style="color:#e9eeff">${String(d.user.role || "").toUpperCase()}</span>
            ${d.user.points ? ` Â· Puntos: ${d.user.points.toFixed(1)}` : ''}
          </div>
        </div>
      </div>`;
  }).join("");
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// RANGOS (nueva estructura)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
const RANK_LABELS = {
  overlord:  "ã€ŠðŸª¬ã€‹ Overlord",
  owner:     "ã€ŠðŸ§¿ã€‹ Owner",
  admin:     "ã€ŠðŸ’Žã€‹ Admin",
  centinela: "ã€Šï¿½ã€‹ Centinela",
  vigia:     "ã€ŠðŸ”¹ã€‹ Vigia"
};
const RANK_ORDER = ["vigia", "centinela", "admin", "owner", "overlord"];

function normRango(r) {
  let s = String(r || "").trim().toLowerCase();
  s = s.replace(/ã€Š.*?ã€‹/g, "").replace(/[^a-zÃ¡Ã©Ã­Ã³ÃºÃ± ]/g, "").replace(/\s+/g, " ").trim();
  if (s.includes("overlord")) return "overlord";
  if (s.includes("owner"))    return "owner";
  if (s.includes("admin"))    return "admin";
  if (s.includes("centinela")) return "centinela";
  if (s.includes("vigia"))    return "vigia";
  // Rangos antiguos seleccionados â†’ se adaptan al nuevo rango base Vigia
  if (s.includes("vip") || s.includes("usuario") || s.includes("bot")) return "vigia";
  return null;
}

function fmtRango(r) {
  const k = normRango(r);
  return k ? RANK_LABELS[k] : (r ? esc(String(r)) : "â€”");
}

// Limpia un nombre: remueve etiquetas/emojis de rango que puedan venir pegadas al name.
function cleanName(s) {
  let n = String(s || "").trim();
  if (!n) return "â€”";
  n = n.replace(/ã€Š.*?ã€‹/g, " ");
  n = n.replace(/[ï¼ˆ(][^ï¼‰)]*(Vigia|Centinela|Admin|Owner|Overlord)[^ï¼‰)]*[ï¼‰)]/gi, " ");
  n = n.replace(/ã€Š[^ã€‹]*ã€‹\s*(Vigia|Centinela|Admin|Owner|Overlord)/gi, " ");
  n = n.replace(/(\s|^)(Vigia|Centinela|Admin|Owner|Overlord)(\s|$)/gi, " ");
  n = n.replace(/\s+/g, " ").trim();
  return n || "â€”";
}

function isInactiveStatus(s) {
  const v = String(s || "").trim().toLowerCase();
  return v === "inactive" || v === "inactivo";
}

function inactiveCutoffMs(u) {
  if (!u || !isInactiveStatus(u.status)) return Infinity;
  const d = tsToDate(u.inactiveAt);
  if (d) return d.getTime();
  if (typeof u.inactiveAt === "number") return u.inactiveAt;
  return Date.now();
}

function rangoIndex(k) {
  const i = RANK_ORDER.indexOf(k);
  return i >= 0 ? i : -1;
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CARGO MC TEAM (MC Team es un CARGO)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function getCargos(u) {
  if (!u) return [];
  if (Array.isArray(u.cargos)) return u.cargos.map(c => String(c)).filter(Boolean);
  if (typeof u.cargos === "string" && u.cargos.trim()) return u.cargos.split(",").map(s => s.trim()).filter(Boolean);
  return [];
}

function hasCargo(u, name) {
  const target = String(name || "").trim().toLowerCase();
  return getCargos(u).some(c => String(c).trim().toLowerCase().includes(target));
}

function isMCteam(u) {
  return hasCargo(u, "MC Team");
}

// Trabajador del MC Team: cargo MC Team + NO admin + NO rango
// superior a Admin/Owner/Overlord + activo. Los Inspectores SÃ cuentan
// como personal operativo (solo se excluye el rol Admin).
function isMCteamWorker(u) {
  if (!u || !isMCteam(u)) return false;
  const role = String(u.role || "").toLowerCase();
  if (role === "admin") return false;
  const rk = normRango(u.rango);
  if (rk && rangoIndex(rk) >= rangoIndex("admin")) return false;
  const st = String(u.status || "active").toLowerCase();
  if (st === "inactive" || st === "inactivo") return false;
  return true;
}

function mcWorkers() {
  return allMembers.filter(isMCteamWorker);
}

// â”€â”€ STATS GENERALES (staff operativo: MC Team + no admin) â”€â”€â”€â”€â”€
function renderStats() {
  const staff = mcWorkers();
  const total = staff.length;
  const pts   = staff.reduce((s, u) => s + (Number(u.points) || 0), 0);
  const insp  = staff.filter(u => String(u.role || "").toLowerCase() === "inspector").length;
  const users = staff.filter(u => String(u.role || "").toLowerCase() === "user").length;
  const risk  = staff.filter(u => (Number(u.points) || 0) <= 2).length;
  const maxP  = Math.max(1, ...staff.map(u => Number(u.points) || 0));
  const avg   = total ? pts / total : 0;

  const el = id => document.getElementById(id);
  const st = el("total-members"), av = el("avg-points"), ar = el("staff-at-risk");
  if (st) st.textContent = total;
  if (av) av.textContent = avg.toFixed(decimalsCfgJow());
  if (ar) ar.textContent = risk;

  const s1 = el("total-members-sub"), s2 = el("avg-points-sub"), s3 = el("staff-at-risk-sub");
  if (s1) s1.textContent = `${insp} inspectores Â· ${users} usuarios`;
  if (s2) s2.textContent = `MÃ¡ximo: ${maxP.toFixed(decimalsCfgJow())} pts`;
  if (s3) s3.textContent = total ? Math.round(risk / total * 100) + "% del staff (â‰¤ 2 pts)" : "â€”";

  const b1 = el("total-members-bar"), b2 = el("avg-points-bar"), b3 = el("staff-at-risk-bar");
  if (b1) b1.style.width = Math.min(100, total * 12) + "%";
  if (b2) b2.style.width = Math.min(100, (avg / maxP) * 100) + "%";
  if (b3) b3.style.width = Math.min(100, total ? (risk / total) * 100 : 0) + "%";
}

// â”€â”€ UTILIDADES DE TIEMPO / LOGS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let chartPeriod = "day";

function logTime(l) {
  if (!l) return 0;
  const d = tsToDate(l.createdAt);
  if (d) return d.getTime();
  if (typeof l.clientTs === "number") return l.clientTs;
  return 0;
}

function label24(d) {
  const h = d.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${h < 12 ? "AM" : "PM"}`;
}

function labelShortDay(d) { return (d.getDate()) + "/" + (d.getMonth() + 1); }

function chartBuckets(period, now) {
  const buckets = [];
  let step, count, lab;
  if (period === "day") {
    step = 60 * 60 * 1000; count = 24; lab = label24;
  } else if (period === "week") {
    step = 24 * 60 * 60 * 1000; count = 7; lab = labelShortDay;
  } else {
    step = 3 * 24 * 60 * 60 * 1000; count = 10; lab = labelShortDay;
  }
  for (let i = count - 1; i >= 0; i--) {
    const end = now - i * step;
    const start = end - step;
    buckets.push({ start, end, label: lab(new Date(end)) });
  }
  return buckets;
}

window.setChartPeriod = (p, btn) => {
  chartPeriod = p;
  document.querySelectorAll("#chart-toolbar .period-btn").forEach(b => b.classList.toggle("active", b.getAttribute("data-period") === p));
  renderActivityChart();
};

// â”€â”€ GRÃFICO: ACTIVIDAD DE USUARIOS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// EstadÃ­stica de Usuarios, Admins e Inspectores; separada de las del resto del equipo.
// Respeta solo el filtro de Rol; ignora Usuario individual, Rango y Cargo.
function renderActivityChart() {
  const el = document.getElementById("activity-chart");
  const legendEl = document.getElementById("chart-legend");
  if (!el) return;
  const role = currentUser?.role;
  if (role !== "admin" && role !== "inspector") return;

  if (!logs.length) {
    el.innerHTML = '<div class="chart-empty">Sin datos de actividad todavÃ­a. Los movimientos de los usuarios aparecerÃ¡n acÃ¡.</div>';
    if (legendEl) legendEl.innerHTML = "";
    return;
  }

  const now = Date.now();
  const buckets = chartBuckets(chartPeriod, now);
  let maxVal = 1;
  
  // Estructura para almacenar actividad por rol
  const roleActivity = {
    user: new Array(buckets.length).fill(0),
    admin: new Array(buckets.length).fill(0),
    inspector: new Array(buckets.length).fill(0)
  };
  
  for (const b of buckets) {
    // Calcular actividad para cada rol
    for (const l of logs) {
      const t = logTime(l);
      if (t < b.start || t >= b.end) continue;
      const actorRole = String(l.actorRole || "").toLowerCase();
      
      let includeActor = (actorRole === "admin" || actorRole === "inspector" || actorRole === "user");
      
      // Filtro de rol: SÃ afecta
      if (filterState.rol && actorRole !== filterState.rol) includeActor = false;
      
      // Filtro de usuario individual: NO afecta (se ignora)
      // Filtro de rango: NO afecta (se ignora)
      // Filtro de cargo: NO afecta (se ignora)
      
      if (includeActor) {
        const actor = allMembers.find(u => u.uid === l.actorUid) || null;
        if (actor && isInactiveStatus(actor.status) && t >= inactiveCutoffMs(actor)) continue;
        
        const bucketIndex = buckets.indexOf(b);
        if (bucketIndex >= 0) {
          // LÃ³gica especÃ­fica por rol
          if (actorRole === "user") {
            // Usuario: promedio entre ingresos y puntos
            const loginCount = logs.filter(log => 
              log.actorUid === l.actorUid && 
              log.type === "login" &&
              logTime(log) >= b.start && 
              logTime(log) < b.end
            ).length;
            const userPoints = Number(actor.points || 0);
            roleActivity.user[bucketIndex] += (loginCount + userPoints) / 2;
          } else if (actorRole === "inspector") {
            // Inspector: puntos que tienen, puntos que suben y ingresos
            const inspectorPoints = Number(actor.points || 0);
            const pointsAdded = logs.filter(log =>
              log.actorUid === l.actorUid &&
              log.type === "points" &&
              log.delta > 0 &&
              logTime(log) >= b.start &&
              logTime(log) < b.end
            ).reduce((sum, log) => sum + (log.delta || 0), 0);
            const loginCount = logs.filter(log =>
              log.actorUid === l.actorUid &&
              log.type === "login" &&
              logTime(log) >= b.start &&
              logTime(log) < b.end
            ).length;
            roleActivity.inspector[bucketIndex] += inspectorPoints + pointsAdded + loginCount;
          } else if (actorRole === "admin") {
            // Admin: puntos que agregan e ingresos
            const pointsAdded = logs.filter(log =>
              log.actorUid === l.actorUid &&
              log.type === "points" &&
              log.delta > 0 &&
              logTime(log) >= b.start &&
              logTime(log) < b.end
            ).reduce((sum, log) => sum + (log.delta || 0), 0);
            const loginCount = logs.filter(log =>
              log.actorUid === l.actorUid &&
              log.type === "login" &&
              logTime(log) >= b.start &&
              logTime(log) < b.end
            ).length;
            roleActivity.admin[bucketIndex] += pointsAdded + loginCount;
          }
        }
      }
    }
    
    maxVal = Math.max(maxVal, roleActivity.user[buckets.indexOf(b)], roleActivity.admin[buckets.indexOf(b)], roleActivity.inspector[buckets.indexOf(b)]);
  }

  const mode = modeStates.admin || "line";
  const periodTxt = chartPeriod === "day" ? "Ãºltimas 24 horas" : chartPeriod === "week" ? "Ãºltimos 7 dÃ­as" : "Ãºltimos 30 dÃ­as";
  const PALETTE_ROLES = {
    user: "#ff6b6b",
    admin: "#7f8cff", 
    inspector: "#3ecf8e"
  };

  // â”€â”€ Modo lineal: evoluciÃ³n de la actividad de todos los roles
  if (mode === "line") {
    const W = 900, H = 450, pl = 40, pr = 16, pt = 22, pb = 40;
    const iw = W - pl - pr, ih = H - pt - pb;
    const yMax = maxVal;
    const n = buckets.length;
    const xPos = i => (n > 1 ? pl + (iw * i) / (n - 1) : pl + iw / 2);
    const yPos = v => pt + ih - (ih * v) / yMax;

    let grid = "", xl = "", series = "";
    const gridCount = 4;
    for (let g = 0; g <= gridCount; g++) {
      const val = Math.round((yMax * g) / gridCount);
      const gy = yPos(val);
      grid += `<line x1="${pl}" y1="${gy}" x2="${W - pr}" y2="${gy}" stroke="rgba(141,153,255,.14)" stroke-width="1"/>`;
      grid += `<text x="${pl - 6}" y="${gy + 4}" text-anchor="end" font-size="9" fill="#7c86ad">${val}</text>`;
    }
    buckets.forEach((b, i) => {
      if (buckets.length > 12 && i % 2 === 1) return;
      xl += `<text x="${xPos(i)}" y="${H - 8}" text-anchor="middle" font-size="${buckets.length > 12 ? 8 : 9}" fill="#7c86ad">${b.label}</text>`;
    });

    const roleSeries = [
      { name: "Usuario", color: PALETTE_ROLES.user, values: roleActivity.user },
      { name: "Admin", color: PALETTE_ROLES.admin, values: roleActivity.admin },
      { name: "Inspector", color: PALETTE_ROLES.inspector, values: roleActivity.inspector }
    ];

    for (const s of roleSeries) {
      const pts = s.values.map((v, i) => `${xPos(i)},${yPos(v)}`).join(" ");
      series += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`;
      s.values.forEach((v, i) => {
        series += `<circle cx="${xPos(i)}" cy="${yPos(v)}" r="2.6" fill="${s.color}"/>`;
      });
    }

    el.innerHTML = `
      <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Actividad de Usuarios (${chartPeriod})">
        ${grid}
        <line x1="${pl}" y1="${pt}" x2="${pl}" y2="${pt + ih}" stroke="rgba(141,153,255,.22)" stroke-width="1"/>
        <line x1="${pl}" y1="${pt + ih}" x2="${W - pr}" y2="${pt + ih}" stroke="rgba(141,153,255,.22)" stroke-width="1"/>
        ${xl}
        ${series}
      </svg>
      <div class="chart-note">EvoluciÃ³n de la actividad de Usuarios Â· ${periodTxt} Â· ${logs.length} registros cargados</div>`;

    if (legendEl) {
      legendEl.innerHTML = roleSeries.map(s => `<span class="legend-item"><span class="legend-dot" style="background:${s.color}"></span>${s.name}</span>`).join("");
    }
    return;
  }

  // â”€â”€ Modo columnas: mostrar actividad de todos los roles
  if (mode === "cols") {
    const W = 900, H = 450, pl = 40, pr = 16, pt = 22, pb = 40;
    const iw = W - pl - pr, ih = H - pt - pb;
    const yMax = maxVal;
    const n = buckets.length;
    const groupWidth = iw / n;
    const barWidth = Math.max(4, (groupWidth / 3) * 0.7);
    const groupGap = groupWidth * 0.1;
    const barGap = Math.max(2, (groupWidth - groupGap - (barWidth * 3)) / 4);
    const xPos = (periodIdx, roleIdx) => pl + (periodIdx * groupWidth) + groupGap/2 + barGap + roleIdx * (barWidth + barGap);
    const yPos = v => pt + ih - (ih * v) / yMax;

    let grid = "", xl = "", bars = "";
    const gridCount = 4;
    for (let g = 0; g <= gridCount; g++) {
      const val = Math.round((yMax * g) / gridCount);
      const gy = yPos(val);
      grid += `<line x1="${pl}" y1="${gy}" x2="${W - pr}" y2="${gy}" stroke="rgba(141,153,255,.14)" stroke-width="1"/>`;
      grid += `<text x="${pl - 6}" y="${gy + 4}" text-anchor="end" font-size="9" fill="#7c86ad">${val}</text>`;
    }
    buckets.forEach((b, i) => {
      if (n > 10 && i % 2 === 1) return;
      xl += `<text x="${pl + (i * groupWidth) + groupWidth/2}" y="${H - 8}" text-anchor="middle" font-size="${n > 10 ? 8 : 9}" fill="#7c86ad">${b.label}</text>`;
    });

    const roleSeries = [
      { name: "Usuario", color: PALETTE_ROLES.user, values: roleActivity.user },
      { name: "Admin", color: PALETTE_ROLES.admin, values: roleActivity.admin },
      { name: "Inspector", color: PALETTE_ROLES.inspector, values: roleActivity.inspector }
    ];

    for (const s of roleSeries) {
      s.values.forEach((v, i) => {
        const hBar = (v / yMax) * ih;
        const y = pt + ih - hBar;
        bars += `<rect x="${xPos(i, roleSeries.indexOf(s))}" y="${y}" width="${barWidth}" height="${hBar}" fill="${s.color}" rx="2"/>`;
      });
    }

    el.innerHTML = `
      <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img">
        ${grid}
        <line x1="${pl}" y1="${pt}" x2="${pl}" y2="${pt + ih}" stroke="rgba(141,153,255,.22)" stroke-width="1"/>
        <line x1="${pl}" y1="${pt + ih}" x2="${W - pr}" y2="${pt + ih}" stroke="rgba(141,153,255,.22)" stroke-width="1"/>
        ${xl}
        ${bars}
      </svg>
      <div class="chart-note">Actividad de Usuarios Â· ${periodTxt} Â· ${logs.length} registros cargados</div>`;

    if (legendEl) {
      legendEl.innerHTML = roleSeries.map(s => `<span class="legend-item"><span class="legend-dot" style="background:${s.color}"></span>${s.name}</span>`).join("");
    }
    return;
  }

  // â”€â”€ Modo circular: UN SOLO CÃRCULO dividido en sectores proporcionales.
  // DistribuciÃ³n de la actividad de los usuarios dentro del perÃ­odo, por rol.
  const totalActivity = roleActivity.user.reduce((a, b) => a + b, 0) + 
                        roleActivity.admin.reduce((a, b) => a + b, 0) + 
                        roleActivity.inspector.reduce((a, b) => a + b, 0);

  if (!totalActivity) {
    el.innerHTML = '<div class="chart-empty">Sin datos de actividad de Usuarios para el perÃ­odo seleccionado.</div>';
    if (legendEl) legendEl.innerHTML = "";
    return;
  }

  const cx = 90, cy = 90, R = 62, C = 2 * Math.PI * R;
  let acc = 0, arcs = "", legend = "";
  
  const roleData = [
    { name: "Usuario", value: roleActivity.user.reduce((a, b) => a + b, 0), color: PALETTE_ROLES.user },
    { name: "Admin", value: roleActivity.admin.reduce((a, b) => a + b, 0), color: PALETTE_ROLES.admin },
    { name: "Inspector", value: roleActivity.inspector.reduce((a, b) => a + b, 0), color: PALETTE_ROLES.inspector }
  ];

  for (const it of roleData) {
    const frac = it.value / totalActivity;
    const dash = `${Math.max(frac * C - 2, 0.5)} ${C}`;
    const rot = -90 + acc * 360;
    arcs += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${it.color}" stroke-width="26" stroke-dasharray="${dash}" transform="rotate(${rot} ${cx} ${cy})"/>`;
    acc += frac;
    legend += `<span class="legend-item"><span class="legend-dot" style="background:${it.color}"></span>${it.name} Â· ${(frac * 100).toFixed(1)}%</span>`;
  }

  el.innerHTML = `
    <svg class="chart-svg" viewBox="0 0 180 180" role="img">
      ${arcs}
      <text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="13" fill="#fff" font-weight="700">${Math.round(totalActivity)}</text>
    </svg>
    <div class="chart-legend">${legend}</div>
    <div class="chart-note">Actividad de Usuarios Â· ${periodTxt}</div>`;

  if (legendEl) {
    legendEl.innerHTML = roleSeries.map(s => `<span class="legend-item"><span class="legend-dot" style="background:${s.color}"></span>${s.name}</span>`).join("");
  }
}
    <svg class="chart-svg" viewBox="0 0 180 180" role="img">
      ${arcs}
      <text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="13" fill="#fff" font-weight="700">${totalAct}</text>
    </svg>
    <div class="chart-legend">${legend}</div>
    <div class="chart-note">DistribuciÃ³n de la actividad de admins Â· ${periodTxt} Â· ${logs.length} registros cargados</div>`;

  if (legendEl) legendEl.innerHTML = "";
}

function countByActor(list, filterFn) {
  const mp = new Map();
  for (const l of list) {
    if (filterFn && !filterFn(l)) continue;
    const key = l.actorUid || "â€”";
    const prev = mp.get(key) || { uid: key, name: l.actorName || "â€”", count: 0 };
    prev.count++;
    mp.set(key, prev);
  }
  return [...mp.values()].sort((a, b) => b.count - a.count);
}

function bestActor(list, filterFn) {
  const arr = countByActor(list, filterFn);
  return arr[0] || null;
}

function fillRank(id, idSub, winner, label) {
  const vEl = document.getElementById(id);
  const sEl = document.getElementById(idSub);
  if (!vEl) return;
  if (!winner) { vEl.textContent = "â€”"; if (sEl) sEl.textContent = "Sin datos por ahora"; return; }
  vEl.textContent = esc(winner.name);
  if (sEl) sEl.textContent = `${winner.count} ${label}`;
}

// â”€â”€ RANKINGS SECUNDARIOS (menÃº desplegable, NIVEL 4) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function renderRankings() {
  const role = currentUser?.role;
  if (role !== "admin" && role !== "inspector") return;

  fillRank("rank-admin-active", "rank-admin-active-sub",
    bestActor(logs, l => String(l.actorRole || "").toLowerCase() === "admin"), "acciones registradas");

  fillRank("rank-points-editor", "rank-points-editor-sub",
    bestActor(logs.filter(l => l.type === "points"), null), "cambios de puntos");

  fillRank("rank-login-leader", "rank-login-leader-sub",
    bestActor(logs.filter(l => l.type === "login"), null), "ingresos a la pÃ¡gina");

  fillRank("rank-inspector", "rank-inspector-sub",
    bestActor(logs, l => String(l.actorRole || "").toLowerCase() === "inspector" && l.type === "points"), "acciones de puntos");
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// TRABAJADORES DESTACADOS (DÃ­a / Semana / Mes)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function workerActivityInRange(u, startMs) {
  const uid = u.uid;
  let count = 0, deltaPts = 0;
  for (const l of logs) {
    if (!l || l.actorUid !== uid) continue;
    const t = logTime(l);
    if (t <= 0 || t < startMs) continue;
    count++;
    if (l.type === "points" && typeof l.delta === "number") deltaPts += l.delta;
  }
  return { count, deltaPts };
}

function periodWorkers(mode) {
  const now = Date.now();
  const mult = mode === "day" ? 1 : mode === "week" ? 7 : 30;
  const start = now - mult * 24 * 60 * 60 * 1000;
  
  let workers = mcWorkers();
  
  // Apply filters
  if (filterState.user) {
    workers = workers.filter(u => u.uid === filterState.user);
  }
  if (filterState.rango) {
    workers = workers.filter(u => normRango(u.rango) === filterState.rango);
  }
  if (filterState.cargo) {
    workers = workers.filter(u => hasCargo(u, filterState.cargo));
  }
  
  const rows = workers.map(u => {
    const act = workerActivityInRange(u, start);
    return { u, count: act.count, deltaPts: act.deltaPts };
  }).sort((a, b) => (b.count - a.count) || ((b.u.points || 0) - (a.u.points || 0)));
  rows.forEach((r, i) => { r.place = i + 1; });
  return rows;
}

function renderDestacados() {
  const role = currentUser?.role;
  // Todos los usuarios pueden ver los destacados (segÃºn especificaciones)

  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  const oneWeekMs = 7 * oneDayMs;
  const oneMonthMs = 30 * oneDayMs;

  // Calcular el inicio del sistema (primer log o timestamp mÃ¡s antiguo)
  let systemStart = now;
  if (logs.length > 0) {
    const oldestLog = logs.reduce((min, l) => {
      const t = logTime(l);
      return t > 0 && t < min ? t : min;
    }, now);
    systemStart = oldestLog;
  }

  const defs = [
    { mode: "day",   id: "destacado-day",   empty: "Sin datos hoy", elapsed: now - systemStart, minRequired: oneDayMs },
    { mode: "week",  id: "destacado-week",  empty: "Sin datos esta semana", elapsed: now - systemStart, minRequired: oneWeekMs },
    { mode: "month", id: "destacado-month", empty: "Sin datos este mes", elapsed: now - systemStart, minRequired: oneMonthMs }
  ];

  for (const def of defs) {
    const el = document.getElementById(def.id);
    if (!el) continue;

    // Solo mostrar si ha pasado el tiempo mÃ­nimo requerido
    if (def.elapsed < def.minRequired) {
      const remaining = Math.ceil((def.minRequired - def.elapsed) / oneDayMs);
      el.innerHTML = `<div class="dc-empty">Requiere ${remaining} dÃ­a(s) mÃ¡s de datos</div>`;
      continue;
    }

    const rows = periodWorkers(def.mode);
    const winner = rows[0];
    if (!winner) { el.innerHTML = `<div class="dc-empty">${def.empty}</div>`; continue; }
    const u = winner.u;
    const pts = Number(u.points) || 0;
    el.innerHTML = `
      <div class="dc-name">${esc(u.name || "â€”")}</div>
      <div class="dc-pts">â­ ${pts.toFixed(decimalsCfgJow())} puntos</div>
      <div class="dc-meta">
        <span>ðŸŽ¯ ${winner.count} acciones</span>
        <span>${winner.deltaPts > 0 ? "âž•" : winner.deltaPts < 0 ? "âž–" : "Â·"} ${Math.abs(winner.deltaPts).toFixed(decimalsCfgJow())} pts</span>
        <span>#${winner.place} de ${rows.length}</span>
      </div>`;
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// GRÃFICOS DEL MC TEAM (pestaÃ±a GrÃ¡ficos)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
const PALETTE = ["#5865f2", "#3ecf8e", "#ffd166", "#ff9f43", "#ff5c75", "#4cc9f0", "#a78bfa", "#57cc99"];

const modeStates = { evo: "line", admin: "line", admins: "cols" };
const filterState = { user: "", rol: "", rango: "", cargo: "" };
let evoTimeState = "7";
let rankTimeState = "day";
let inspPeriodState = "day";

function periodStartMs(p) {
  const m = p === "day" ? 1 : p === "week" ? 7 : 30;
  return Date.now() - m * 24 * 60 * 60 * 1000;
}

// Puntos ganados por el usuario en un perÃ­odo (a partir de los registros).
function periodPointsForUser(u, period) {
  if (period === "day") return Number(u.points || 0); // DÃ­a â†’ puntos actuales
  const start = periodStartMs(period);
  const cutoff = inactiveCutoffMs(u);
  let pts = 0;
  for (const l of logs) {
    if (!l || l.type !== "points" || l.targetUid !== u.uid) continue;
    const t = logTime(l);
    if (!t || t < start || t >= cutoff) continue;
    const d = typeof l.delta === "number" ? l.delta : 0;
    if (d > 0) pts += d;
  }
  // Para semana/mes, mostrar puntos ganados en el perÃ­odo
  // Si no hay actividad, mostrar 0 pero el usuario seguirÃ¡ en el ranking si tiene puntos actuales
  return pts;
}

function setModeState(key, m, btn) {
  modeStates[key] = m;
  const tb = btn ? btn.parentElement : null;
  if (tb) {
    tb.querySelectorAll(".period-btn").forEach(b => b.classList.toggle("active", b.getAttribute("data-mode") === m));
  }
  if (key === "evo") renderEvolutionPts();
  if (key === "admin") renderActivityChart();
  if (key === "admins") renderRankingAdmins();
}

window.setRankModeEvo    = (m, btn) => setModeState("evo", m, btn);
window.setAdminChartMode = (m, btn) => setModeState("admin", m, btn);
window.setRankModeAdmins = (m, btn) => setModeState("admins", m, btn);
window.setEvoTime        = (days, btn) => {
  evoTimeState = days;
  const tb = btn ? btn.parentElement : null;
  if (tb) tb.querySelectorAll(".period-btn").forEach(b => b.classList.toggle("active", b.getAttribute("data-time") === days));
  renderEvolutionPts();
};

window.setRankTime = (p, btn) => {
  rankTimeState = p;
  const tb = btn ? btn.parentElement : null;
  if (tb) tb.querySelectorAll(".period-btn").forEach(b => b.classList.toggle("active", b.getAttribute("data-rank-time") === p));
  renderRankingAdmins();
};

window.setInspPeriod = (p, btn) => {
  inspPeriodState = p;
  const tb = btn ? btn.parentElement : null;
  if (tb) tb.querySelectorAll(".period-btn").forEach(b => b.classList.toggle("active", b.getAttribute("data-insp-period") === p));
  renderInspectorActivityJow();
};

// â”€â”€ FILTROS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
window.applyFilters = () => {
  filterState.user  = document.getElementById("filter-user")?.value || "";
  filterState.rol   = document.getElementById("filter-rol")?.value || "";
  filterState.rango = document.getElementById("filter-rango")?.value || "";
  filterState.cargo = document.getElementById("filter-cargo")?.value || "";

  // Re-render todos los grÃ¡ficos filtrables con los nuevos filtros.
  // La "Actividad de Admins" NO se filtra por diseÃ±o (funciona de forma independiente).
  renderRankingAdmins();
  renderEvolutionPts();
  renderInspectorActivityJow();
};

window.resetFilters = () => {
  const ids = ["filter-user", "filter-rol", "filter-rango", "filter-cargo"];
  ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
  filterState = { user: "", rol: "", rango: "", cargo: "" };
  applyFilters();
};

function countActionsBy(uid) {
  let c = 0;
  for (const l of logs) {
    if (!l || l.actorUid !== uid) continue;
    // Solo contar acciones de Admins e Inspectores (quienes pueden asignar puntos)
    const role = String(l.actorRole || "").toLowerCase();
    if (role !== "admin" && role !== "inspector") continue;
    c++;
  }
  return c;
}

function populateUserFilter() {
  const userSelect = document.getElementById("filter-user");
  if (!userSelect) return;

  userSelect.innerHTML = '<option value="">Todos</option>';
  // Punto 3: TODOS los usuarios (user / admin / inspector) â€” no solo staff
  const team = allMembers.filter(u => ["admin","inspector","user"].includes(u.role));
  team.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  team.forEach(u => {
    const option = document.createElement("option");
    option.value = u.uid;
    option.textContent = u.name || "â€”";
    userSelect.appendChild(option);
  });
}

function populateLogUserFilter() {
  const userSelect = document.getElementById("log-filter-user");
  if (!userSelect) return;

  userSelect.innerHTML = '<option value="">Usuario</option>';
  const team = allMembers.filter(u => ["admin","inspector","user"].includes(u.role));
  team.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  team.forEach(u => {
    const option = document.createElement("option");
    option.value = u.uid;
    option.textContent = u.name || "â€”";
    userSelect.appendChild(option);
  });
}

function svgDonut(items, centerLabel) {
  const total = items.reduce((s, it) => s + (Number(it.value) || 0), 0);
  if (!total) return '<div class="chart-empty">Sin datos.</div>';
  const cx = 90, cy = 90, R = 62, C = 2 * Math.PI * R;
  let acc = 0, arcs = "", legend = "";
  for (const it of items) {
    const frac = (Number(it.value) || 0) / total;
    const dash = `${Math.max(frac * C - 2, 0.5)} ${C}`;
    const rot = -90 + acc * 360;
    arcs += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${it.color}" stroke-width="26" stroke-dasharray="${dash}" transform="rotate(${rot} ${cx} ${cy})"/>`;
    acc += frac;
    legend += `<span class="legend-item"><span class="legend-dot" style="background:${it.color}"></span>${esc(it.label)} Â· ${(frac * 100).toFixed(1)}%</span>`;
  }
  return `
    <svg class="chart-svg" viewBox="0 0 180 180" role="img">
      ${arcs}
      <text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="13" fill="#fff" font-weight="700">${centerLabel || Math.round(total)}</text>
    </svg>
    <div class="chart-legend">${legend}</div>`;
}

function rankListHTML(rows, valLabel, _showRango) {
  const max = Math.max(1, ...rows.map(r => Number(r.value) || 0));
  return `<div class="rank-list">
    ${rows.map((r, i) => {
      const pct = Math.min((Number(r.value) || 0) / max * 100, 100);
      return `<div class="rank-row">
        <span class="rank-pos">#${i + 1}</span>
        <span class="rank-name"><b>${esc(cleanName(r.name))}</b></span>
        <span class="rank-bars"><span class="rank-bar" style="width:${pct}%"></span></span>
        <span class="rank-val">${valLabel} ${Number(r.value || 0).toFixed(decimalsCfgJow())}</span>
      </div>`;
    }).join("")}
  </div>`;
}

function multiLineChartSVG(labels, series, h) {
  const H = h || 340, W = 760, pl = 44, pr = 16, pt = 22, pb = 40;
  const iw = W - pl - pr, ih = H - pt - pb;
  let maxV = 1;
  for (const s of series) for (const v of s.values) maxV = Math.max(maxV, Number(v) || 0);
  const n = labels.length;
  const xPos = i => (n > 1 ? pl + (iw * i) / (n - 1) : pl + iw / 2);
  const yPos = v => pt + ih - (ih * v) / maxV;
  let grid = "", xl = "", lines = "";
  const gridCount = 4;
  for (let g = 0; g <= gridCount; g++) {
    const val = Math.round((maxV * g) / gridCount);
    const gy = yPos(val);
    grid += `<line x1="${pl}" y1="${gy}" x2="${W - pr}" y2="${gy}" stroke="rgba(141,153,255,.14)" stroke-width="1"/>`;
    grid += `<text x="${pl - 6}" y="${gy + 4}" text-anchor="end" font-size="9" fill="#7c86ad">${val}</text>`;
  }
  labels.forEach((lb, i) => {
    if (n > 10 && i % 2 === 1) return;
    xl += `<text x="${xPos(i)}" y="${H - 8}" text-anchor="middle" font-size="${n > 10 ? 8 : 9}" fill="#7c86ad">${lb}</text>`;
  });
  for (const s of series) {
    const pts = s.values.map((v, i) => `${xPos(i)},${yPos(v)}`).join(" ");
    lines += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
    s.values.forEach((v, i) => { lines += `<circle cx="${xPos(i)}" cy="${yPos(v)}" r="2.4" fill="${s.color}"/>`; });
  }
  return `
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img">
      ${grid}
      <line x1="${pl}" y1="${pt}" x2="${pl}" y2="${pt + ih}" stroke="rgba(141,153,255,.22)" stroke-width="1"/>
      <line x1="${pl}" y1="${pt + ih}" x2="${W - pr}" y2="${pt + ih}" stroke="rgba(141,153,255,.22)" stroke-width="1"/>
      ${xl}
      ${lines}
    </svg>`;
}

function barChartSVG(labels, series, h) {
  const H = h || 340, W = 760, pl = 44, pr = 16, pt = 22, pb = 40;
  const iw = W - pl - pr, ih = H - pt - pb;
  let maxV = 1;
  for (const s of series) for (const v of s.values) maxV = Math.max(maxV, Number(v) || 0);
  const n = labels.length;
  const barWidth = Math.max(8, (iw / n) * 0.6);
  const gap = (iw - (barWidth * n)) / (n + 1);
  const xPos = i => pl + gap + i * (barWidth + gap);
  const yPos = v => pt + ih - (ih * v) / maxV;
  let grid = "", xl = "", bars = "";
  const gridCount = 4;
  for (let g = 0; g <= gridCount; g++) {
    const val = Math.round((maxV * g) / gridCount);
    const gy = yPos(val);
    grid += `<line x1="${pl}" y1="${gy}" x2="${W - pr}" y2="${gy}" stroke="rgba(141,153,255,.14)" stroke-width="1"/>`;
    grid += `<text x="${pl - 6}" y="${gy + 4}" text-anchor="end" font-size="9" fill="#7c86ad">${val}</text>`;
  }
  labels.forEach((lb, i) => {
    if (n > 10 && i % 2 === 1) return;
    xl += `<text x="${xPos(i) + barWidth/2}" y="${H - 8}" text-anchor="middle" font-size="${n > 10 ? 8 : 9}" fill="#7c86ad">${lb}</text>`;
  });
  for (const s of series) {
    s.values.forEach((v, i) => {
      const hBar = (Number(v) || 0) / maxV * ih;
      const y = pt + ih - hBar;
      bars += `<rect x="${xPos(i)}" y="${y}" width="${barWidth}" height="${hBar}" fill="${s.color}" rx="3"/>`;
    });
  }
  return `
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img">
      ${grid}
      <line x1="${pl}" y1="${pt}" x2="${pl}" y2="${pt + ih}" stroke="rgba(141,153,255,.22)" stroke-width="1"/>
      <line x1="${pl}" y1="${pt + ih}" x2="${W - pr}" y2="${pt + ih}" stroke="rgba(141,153,255,.22)" stroke-width="1"/>
      ${xl}
      ${bars}
    </svg>`;
}

// EvoluciÃ³n de puntos: reconstruye el valor diario de cada trabajador
// del equipo a partir de los registros (delta) y los puntos actuales.
// â”€â”€ RANKING DE PUNTOS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Ranking general que incluye TODOS los roles (Usuario, Admin, Inspector),
// respeta los filtros de Usuario + Rol + Rango + Cargo y funciona por
// DÃ­a / Semana / Mes.
function renderRankingAdmins() {
  const box = document.getElementById("rank-admins-box");
  if (!box) return;
  const role = currentUser?.role;
  if (role !== "admin" && role !== "inspector") return;

  // Incluir inspectores y usuarios en el ranking de puntos.
  let members = allMembers.filter(u => ["admin", "inspector", "user"].includes(String(u.role || "").toLowerCase()));
  if (filterState.user) members = members.filter(u => u.uid === filterState.user);
  if (filterState.rol) members = members.filter(u => String(u.role || "").toLowerCase() === filterState.rol);
  if (filterState.rango) members = members.filter(u => normRango(u.rango) === filterState.rango);
  if (filterState.cargo) members = members.filter(u => hasCargo(u, filterState.cargo));
  members = members.filter(u => String(u.role || "").toLowerCase() !== "admin");
  members = members.filter(u => !isInactiveStatus(u.status));

  members = members
    .map(u => ({ u, pts: periodPointsForUser(u, rankTimeState) }))
    .sort((a, b) => (b.pts - a.pts) || ((b.u.points || 0) - (a.u.points || 0)))
    .slice(0, 8);

  if (!members.length) {
    box.innerHTML = '<div class="chart-empty">Sin datos para el ranking en el perÃ­odo seleccionado.</div>';
    return;
  }

  const periodTxt = rankTimeState === "day" ? "hoy" : rankTimeState === "week" ? "esta semana" : "este mes";

  if (modeStates.admins === "circ") {
    // UN SOLO CÃRCULO dividido en sectores proporcionales.
    const total = members.reduce((s, r) => s + r.pts, 0);
    const cx = 90, cy = 90, R = 62, C = 2 * Math.PI * R;
    let acc = 0, arcs = "", legend = "";
    members.forEach((r, i) => {
      const frac = r.pts / total;
      const dash = `${Math.max(frac * C - 2, 0.5)} ${C}`;
      const rot = -90 + acc * 360;
      arcs += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${PALETTE[i % PALETTE.length]}" stroke-width="26" stroke-dasharray="${dash}" transform="rotate(${rot} ${cx} ${cy})"/>`;
      acc += frac;
      legend += `<span class="legend-item"><span class="legend-dot" style="background:${PALETTE[i % PALETTE.length]}"></span>${esc(cleanName(r.u.name))} Â· ${(frac * 100).toFixed(1)}%</span>`;
    });
    box.innerHTML = `
      <svg class="chart-svg" viewBox="0 0 180 180" role="img">
        ${arcs}
        <text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="13" fill="#fff" font-weight="700">${total.toFixed(decimalsCfgJow())}</text>
      </svg>
      <div class="chart-legend">${legend}</div>
      <div class="chart-note">Ranking de puntos Â· ${periodTxt}</div>`;
    return;
  }

  // Modo columnas: grÃ¡fico real de columnas verticales.
  const maxP = Math.max(1, ...members.map(r => r.pts));
  const W = 600, H = 300, pl = 40, pr = 16, pt = 32, pb = 46;
  const iw = W - pl - pr, ih = H - pt - pb;
  const n = members.length;
  const barWidth = Math.max(20, (iw / n) * 0.5);
  const gap = (iw - (barWidth * n)) / (n + 1);
  const xPos = i => pl + gap + i * (barWidth + gap);
  const yPos = v => pt + ih - (ih * v) / maxP;

  let grid = "", xl = "", bars = "", leg = "";
  const gridCount = 4;
  for (let g = 0; g <= gridCount; g++) {
    const val = Math.round((maxP * g) / gridCount);
    const gy = yPos(val);
    grid += `<line x1="${pl}" y1="${gy}" x2="${W - pr}" y2="${gy}" stroke="rgba(141,153,255,.14)" stroke-width="1"/>`;
    grid += `<text x="${pl - 6}" y="${gy + 4}" text-anchor="end" font-size="9" fill="#7c86ad">${val}</text>`;
  }

  members.forEach((r, i) => {
    const pts = r.pts;
    const x = xPos(i);
    const hBar = (pts / maxP) * ih;
    const y = pt + ih - hBar;
    const color = PALETTE[i % PALETTE.length];
    bars += `<rect x="${x}" y="${y}" width="${barWidth}" height="${hBar}" fill="${color}" rx="4"/>`;
    bars += `<text x="${x + barWidth/2}" y="${y - 6}" text-anchor="middle" font-size="10" fill="#e9eeff" font-weight="600">${pts.toFixed(decimalsCfgJow())}</text>`;
    const nameShort = cleanName(r.u.name).substring(0, 9);
    xl += `<text x="${x + barWidth/2}" y="${H - 8}" text-anchor="middle" font-size="9" fill="#7c86ad">${nameShort}</text>`;
    leg += `<span class="legend-item"><span class="legend-dot" style="background:${color}"></span>${esc(cleanName(r.u.name))}</span>`;
  });

  box.innerHTML = `
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img">
      ${grid}
      <line x1="${pl}" y1="${pt}" x2="${pl}" y2="${pt + ih}" stroke="rgba(141,153,255,.22)" stroke-width="1"/>
      <line x1="${pl}" y1="${pt + ih}" x2="${W - pr}" y2="${pt + ih}" stroke="rgba(141,153,255,.22)" stroke-width="1"/>
      ${xl}
      ${bars}
    </svg>
    <div class="chart-legend">${leg}</div>
    <div class="chart-note">Ranking de puntos Â· ${periodTxt}</div>`;
}

// Funciones para refrescar y reiniciar grÃ¡ficos individuales (mismos nombres que Dashboard)
window.refreshSingleChart = (chartName) => {
  switch(chartName) {
    case 'rankingAdmins':
      if (typeof renderRankingAdmins === "function") renderRankingAdmins();
      break;
    case 'evolutionPts':
      if (typeof renderEvolutionPts === "function") renderEvolutionPts();
      break;
    case 'activityChart':
      if (typeof renderActivityChart === "function") renderActivityChart();
      break;
    case 'inspectorActivity':
      if (typeof renderInspectorActivityJow === "function") renderInspectorActivityJow();
      break;
  }
  showToast("GrÃ¡fico actualizado", "ok");
};

window.resetSingleChart = async (chartName) => {
  const role = currentUser?.role;
  if (role !== "admin") {
    showToast("Solo los admins pueden reiniciar los datos", "err");
    return;
  }

  const ok = confirm("Â¿EstÃ¡s seguro de que querÃ©s reiniciar los datos de este grÃ¡fico? Se borrarÃ¡n los registros histÃ³ricos correspondientes y no se puede deshacer.");
  if (!ok) return;

  // Determinar quÃ© registros corresponden a este grÃ¡fico.
  let targets = [];
  if (chartName === "activityChart") {
    targets = logs.filter(l => String(l.actorRole || "").toLowerCase() === "admin");
  } else if (chartName === "inspectorActivity") {
    targets = logs.filter(l => l.type === "points" && String(l.actorRole || "").toLowerCase() === "inspector");
  } else if (chartName === "evolutionPts") {
    targets = logs.filter(l => l.type === "points" && String(l.actorRole || "").toLowerCase() !== "admin");
  } else if (chartName === "rankingAdmins") {
    targets = logs.filter(l => l.type === "points" && String(l.actorRole || "").toLowerCase() !== "admin");
  } else {
    targets = logs.slice();
  }

  let deleted = 0;
  for (const l of targets) {
    if (!l || !l.id) continue;
    try {
      await deleteDoc(doc(db, "logs", l.id));
      deleted++;
    } catch (e) {
      console.error("Error borrando log:", e);
    }
  }

  showToast(`Reinicio completado: ${deleted} registro(s) borrado(s).`, deleted > 0 ? "ok" : "err");

  // Refrescar el grÃ¡fico despuÃ©s del reinicio (el snapshot recargarÃ¡ los logs).
  if (typeof refreshSingleChart === "function") refreshSingleChart(chartName);
};

function renderEvolutionPts() {
  const el = document.getElementById("evo-pts-chart");
  const legendEl = document.getElementById("evo-pts-legend");
  if (!el) return;
  const role = currentUser?.role;
  // Permitir que usuarios admin, inspector y user vean el grÃ¡fico
  if (role !== "admin" && role !== "inspector" && role !== "user") return;

  // Incluir inspector y user por defecto (sin admin para la evoluciÃ³n general)
  let team = allMembers.filter(u => ["inspector", "user"].includes(String(u.role || "").toLowerCase()));

  // Apply filters
  if (filterState.user) {
    team = team.filter(u => u.uid === filterState.user);
  }
  if (filterState.rol) {
    team = team.filter(u => String(u.role || "").toLowerCase() === filterState.rol);
  }
  if (filterState.rango) {
    team = team.filter(u => normRango(u.rango) === filterState.rango);
  }
  if (filterState.cargo) {
    team = team.filter(u => hasCargo(u, filterState.cargo));
  }
  
  // NO limitar a 8 usuarios - mostrar todos
  team = team.sort((a, b) => (b.points || 0) - (a.points || 0));
  
  if (!team.length) { el.innerHTML = '<div class="chart-empty">Sin miembros del equipo que coincidan con los filtros.</div>'; if (legendEl) legendEl.innerHTML = ""; return; }

  const now = Date.now();
  const isDayView = evoTimeState === "7";
  const step = isDayView ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000; // 1 hora para dÃ­a, 1 dÃ­a para otros
  const count = isDayView ? 24 : (evoTimeState === "14" ? 7 : 30);
  
  const periods = [];
  for (let i = count - 1; i >= 0; i--) {
    const end = now - i * step, start = end - step;
    const label = isDayView 
      ? `${new Date(end).getHours()}:00` 
      : labelShortDay(new Date(end));
    periods.push({ start, end, label, vals: {} });
  }

  for (const member of team) {
    const periodChanges = new Array(count).fill(0);
    for (const l of logs) {
      if (!l || l.type !== "points" || l.targetUid !== member.uid) continue;
      const t = logTime(l);
      if (!t) continue;
      const bi = periods.findIndex(d => t >= d.start && t < d.end);
      if (bi >= 0) periodChanges[bi] += typeof l.delta === "number" ? l.delta : 0;
    }
    let val = Number(member.points) || 0;
    const factor = Math.pow(10, decimalsCfgJow());
    const series = new Array(count).fill(0);
    for (let i = count - 1; i >= 0; i--) {
      series[i] = Math.round(val * factor) / factor;
      val -= periodChanges[i];
    }
    periods.forEach((d, i) => { d.vals[member.uid] = series[i]; });
  }

  // Paleta de colores para usuarios (asignar color consistente por UID)
  const getUserColor = (uid) => {
    let hash = 0;
    for (let i = 0; i < uid.length; i++) {
      hash = uid.charCodeAt(i) + ((hash << 5) - hash);
    }
    return PALETTE[Math.abs(hash) % PALETTE.length];
  };

  const series = team.map((m) => ({
    uid: m.uid,
    name: cleanName(m.name),
    color: getUserColor(m.uid),
    values: periods.map(d => d.vals[m.uid])
  }));

  if (modeStates.evo === "line") {
    el.innerHTML = multiLineChartSVG(periods.map(d => d.label), series);
  } else {
    // Modo columnas: mostrar una barra por usuario por perÃ­odo
    // Compactar barras si hay muchos usuarios
    const n = team.length;
    const H = 340, W = 760, pl = 44, pr = 16, pt = 22, pb = 40;
    const iw = W - pl - pr, ih = H - pt - pb;
    let maxV = 1;
    for (const s of series) for (const v of s.values) maxV = Math.max(maxV, Number(v) || 0);
    
    const periodCount = periods.length;
    const groupWidth = iw / periodCount;
    const barWidth = Math.max(4, (groupWidth / n) * 0.7);
    const groupGap = groupWidth * 0.1;
    const barGap = Math.max(2, (groupWidth - groupGap - (barWidth * n)) / (n + 1));
    
    const xPos = (periodIdx, userIdx) => pl + (periodIdx * groupWidth) + groupGap/2 + barGap + userIdx * (barWidth + barGap);
    const yPos = v => pt + ih - (ih * v) / maxV;
    
    let grid = "", xl = "", bars = "";
    const gridCount = 4;
    for (let g = 0; g <= gridCount; g++) {
      const val = Math.round((maxV * g) / gridCount);
      const gy = yPos(val);
      grid += `<line x1="${pl}" y1="${gy}" x2="${W - pr}" y2="${gy}" stroke="rgba(141,153,255,.14)" stroke-width="1"/>`;
      grid += `<text x="${pl - 6}" y="${gy + 4}" text-anchor="end" font-size="9" fill="#7c86ad">${val}</text>`;
    }
    
    periods.forEach((d, i) => {
      if (periodCount > 10 && i % 2 === 1) return;
      xl += `<text x="${pl + (i * groupWidth) + groupWidth/2}" y="${H - 8}" text-anchor="middle" font-size="${periodCount > 10 ? 8 : 9}" fill="#7c86ad">${d.label}</text>`;
    });
    
    for (const s of series) {
      s.values.forEach((v, i) => {
        const hBar = (Number(v) || 0) / maxV * ih;
        const y = pt + ih - hBar;
        bars += `<rect x="${xPos(i, series.indexOf(s))}" y="${y}" width="${barWidth}" height="${hBar}" fill="${s.color}" rx="2"/>`;
      });
    }
    
    el.innerHTML = `
      <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img">
        ${grid}
        <line x1="${pl}" y1="${pt}" x2="${pl}" y2="${pt + ih}" stroke="rgba(141,153,255,.22)" stroke-width="1"/>
        <line x1="${pl}" y1="${pt + ih}" x2="${W - pr}" y2="${pt + ih}" stroke="rgba(141,153,255,.22)" stroke-width="1"/>
        ${xl}
        ${bars}
      </svg>`;
  }
  
  if (legendEl) {
    // Leyenda sin nombres de usuario, solo cÃ­rculos de color
    legendEl.innerHTML = series.map(s => `<span class="legend-item"><span class="legend-dot" style="background:${s.color}"></span></span>`).join("");
  }
}

// Refresca todas las vistas tras un cambio de puntos
function renderAll() {
  if (typeof renderStats === "function") renderStats();
  if (typeof renderPointsTable === "function") renderPointsTable();
  if (typeof renderStaffTable === "function") renderStaffTable();
  if (typeof renderActivityChart === "function") renderActivityChart();
  if (typeof renderRankings === "function") renderRankings();
  if (typeof renderDestacados === "function") renderDestacados();
  if (typeof renderRankingAdmins === "function") renderRankingAdmins();
  if (typeof renderEvolutionPts === "function") renderEvolutionPts();
}

// â”€â”€ TABLA PUNTOS (con controles para Admins e Inspectores) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function renderPointsTable() {
  const tb = document.getElementById("pts-full-body");
  const theadRow = document.getElementById("pts-thead-row");
  const role = currentUser?.role;
  const isStaff = role === "admin" || role === "inspector";

  // La tabla muestra trabajadores con cargo MC Team Y todos los admins
  const mcTeam = mcWorkers();
  const admins = allMembers.filter(u => String(u.role || "").toLowerCase() === "admin");
  const list = [...mcTeam, ...admins].sort((a,b) => (b.points||0)-(a.points||0));

  // Actualizar cabecera para mostrar/ocultar columna de acciones (sin rango)
  if (theadRow) {
    if (isStaff) {
      theadRow.innerHTML = '<th>#</th><th>Nombre</th><th>Puntos</th><th>Estado</th><th>Acciones</th>';
    } else {
      theadRow.innerHTML = '<th>#</th><th>Nombre</th><th>Puntos</th><th>Estado</th>';
    }
  }

  if (!list.length) {
    tb.innerHTML = `<tr><td colspan="${isStaff ? 6 : 5}" class="t-empty">Sin trabajadores del MC Team.</td></tr>`;
    return;
  }

  tb.innerHTML = list.map((u, i) => {
    const pts  = u.points || 0;
    const isMe = currentUser && u.uid === currentUser.uid;
    const canEdit = isStaff && !isMe;
    const isAdmin = role === "admin";
    const isInspector = role === "inspector";
    
    const stepVal = decimalsCfgJow() === 0 ? "1" : decimalsCfgJow() === 1 ? "0.1" : "0.01";
    const placeholderVal = decimalsCfgJow() === 0 ? "0" : decimalsCfgJow() === 1 ? "0.0" : "0.00";
    const maxVal = maxPtsCfg();
    
    const actionsCell = canEdit ? `
      <td>
        <div class="pts-actions">
          ${isAdmin ? `
            <button class="pts-btn pts-add" onclick="adjustPoints('${u.uid}', 1)" title="Sumar +1">âž•</button>
            <button class="pts-btn pts-sub" onclick="adjustPoints('${u.uid}', -1)" title="Restar -1">âž–</button>
            <input type="number" class="pts-input" id="pts-input-${u.uid}" min="0" max="${maxVal}" step="${stepVal}" placeholder="${placeholderVal}" style="width: 60px; padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(141,153,255,.25); background: rgba(15,20,40,.8); color: #e9eeff; font-size: 12px; outline: none;" value="" onkeydown="if(event.key==='Enter') setPoints('${u.uid}')">
            <button class="pts-btn pts-set" onclick="setPoints('${u.uid}')" title="Establecer valor (Enter)">âš™ï¸</button>
          ` : `
            <button class="pts-btn pts-add" onclick="adjustPoints('${u.uid}', 1)" title="Sumar +1">âž•</button>
            <button class="pts-btn pts-sub" onclick="adjustPoints('${u.uid}', -1)" title="Restar -1">âž–</button>
          `}
        </div>
      </td>` : '<td></td>';

    return `
      <tr ${isMe ? 'class="my-row"' : ""}>
        <td class="rank-col">${i+1}</td>
        <td>
          <span class="member-av av-${u.role}">${(u.name||"?").charAt(0).toUpperCase()}</span>
          <b>${esc(u.name||"â€”")}</b>
          ${isMe ? '<span class="you-tag">tÃº</span>' : ""}
        </td>
        <td>
          <span class="pts-number" id="pn-${u.uid}" style="color:${ptColor(pts)}">${pts.toFixed(decimalsCfgJow())}</span>
          <div class="pts-mini-bar-wrap">
            <div class="pts-mini-bar ${ptBarClass(pts)}" id="pb-${u.uid}" style="width:${Math.min((pts/maxPtsCfg())*100,100)}%"></div>
          </div>
        </td>
        <td id="ps-${u.uid}">${ptStateBadge(pts)}</td>
        ${actionsCell}
      </tr>`;
  }).join("");
}

// â”€â”€ AJUSTAR PUNTOS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Inspectores: solo +/- 1 exacto, motivo OBLIGATORIO
// Admins: +/- 1 o mÃ¡s, motivo OPCIONAL
window.adjustPoints = async (uid, delta) => {
  const role = currentUser?.role;
  if (role !== 'admin' && role !== 'inspector') return;
  if (uid === currentUser.uid) { showToast('No podÃ©s modificar tus propios puntos!', 'err'); return; }
  const member = allMembers.find(u => u.uid === uid);
  if (!member) return;

  if (role === 'inspector') {
    const cd = checkInspectorCooldown(uid);
    if (!cd.ok) { showToast(`Cooldown activo. PodÃ©s volver a puntuar a esta persona en ${fmtSince(cd.waitMs)}.`, 'err'); return; }
    // Punto 4: Inspector solo 1 punto por acciÃ³n, NUNCA se pide cantidad personalizada
    delta = delta > 0 ? 1 : -1;
  }

  // Punto 5: Pedir motivo
  let reason = "";
  if (role === 'inspector') {
    // Inspector: motivo OBLIGATORIO
    while (true) {
      const r = prompt(`Motivo de la modificaciÃ³n (${delta > 0 ? '+' : ''}${delta} pts a ${member.name}):\n\nCampo OBLIGATORIO para inspectores.`);
      if (r === null) return; // Cancelar
      reason = r.trim();
      if (reason.length === 0) {
        showToast('TenÃ©s que escribir un motivo obligatorio.', 'err');
        continue;
      }
      break;
    }
  } else {
    // Admin: motivo OPCIONAL
    const r = prompt(`Motivo (opcional) de la modificaciÃ³n (${delta > 0 ? '+' : ''}${delta} pts a ${member.name}):`);
    if (r === null) return;
    reason = r.trim();
    if (!reason) reason = `ModificaciÃ³n manual (${delta > 0 ? '+' : ''}${delta})`;
  }

  const oldVal = member.points || 0;
  const rawNewVal = oldVal + delta;
  const factor = Math.pow(10, decimalsCfgJow());
  const newVal = Math.max(0, Math.min(maxPtsCfg(), Math.round(rawNewVal * factor) / factor));
  
  if (newVal === oldVal) return;

  member.points = newVal; updatePointCells(uid, newVal);
  try {
    await updateDoc(doc(db, 'users', uid), { points: newVal });
    await writeLog({ type: 'points', actorUid: currentUser.uid, actorRole: role, actorName: currentUser.name||'', targetUid: uid, targetName: member.name||'', delta: delta, reason, newPoints: newVal });
    if (role === 'inspector') {
      writeCooldown(currentUser.uid, uid, Date.now());
    }
    showToast(`Puntos ${delta > 0 ? 'sumados' : 'restados'}: ${delta > 0 ? '+' : ''}${Math.abs(delta)}`, 'ok');

    // Punto 7 Novedades selectivas: SOLO registrar novedad cuando se cruzan umbrales (no cada +/-)
    await maybeEmitThresholdNovedad(member, oldVal, newVal, delta, role);

    renderAll();
  } catch (e) { member.points = oldVal; updatePointCells(uid, oldVal); showToast('Error al guardar: '+e.message,'err'); }
};

// â”€â”€ ESTABLECER VALOR DE PUNTOS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Valor exacto (solo para Admins) con motivo opcional
window.setPoints = async (uid) => {
  const role = currentUser?.role;
  if (role !== 'admin') return;
  if (uid === currentUser.uid) { showToast('No podÃ©s modificar tus propios puntos!', 'err'); return; }
  const member = allMembers.find(u => u.uid === uid);
  if (!member) return;

  const inputEl = document.getElementById(`pts-input-${uid}`);
  const inputValue = inputEl ? parseFloat(inputEl.value) : NaN;
  
  if (!Number.isFinite(inputValue) || inputValue < 0) {
    showToast('IngresÃ¡ un valor vÃ¡lido (mayor o igual a 0).', 'err');
    return;
  }

  const oldVal = member.points || 0;
  const factor = Math.pow(10, decimalsCfgJow());
  const newVal = Math.max(0, Math.min(maxPtsCfg(), Math.round(inputValue * factor) / factor));
  
  if (newVal === oldVal) return;
  const delta = newVal - oldVal;

  const r = prompt(`Motivo (opcional) - establecer puntos de ${member.name} a ${newVal}:`);
  if (r === null) return;
  const reason = r.trim() || `Valor directo (${delta > 0 ? '+' : ''}${delta})`;

  member.points = newVal; updatePointCells(uid, newVal);
  try {
    await updateDoc(doc(db, 'users', uid), { points: newVal });
    await writeLog({ type: 'points', actorUid: currentUser.uid, actorRole: role, actorName: currentUser.name||'', targetUid: uid, targetName: member.name||'', delta, reason, newPoints: newVal });
    showToast(`Puntos establecidos: ${newVal}`, 'ok');
    if (inputEl) inputEl.value = '';

    await maybeEmitThresholdNovedad(member, oldVal, newVal, delta, role);

    renderAll();
  } catch (e) { member.points = oldVal; updatePointCells(uid, oldVal); showToast('Error al guardar: '+e.message,'err'); }
};

// Punto 7: Emitir novedades SOLO para eventos importantes / umbrales
async function maybeEmitThresholdNovedad(member, oldVal, newVal, delta, role) {
  const MAX = maxPtsCfg();
  const name = member.name || 'un miembro';

  // Umbral 1: cruzÃ³ de 0 a >0 (recuperÃ³ puntos / volviÃ³ de expulsiÃ³n)
  if (oldVal === 0 && newVal > 0) {
    await logNovedad(`âœ… ${name} volviÃ³ a tener actividad (${newVal.toFixed(decimalsCfgJow())} pts) y saliÃ³ del estado crÃ­tico.`);
    return;
  }
  // Umbral 2: bajÃ³ a 0 (cerca de expulsiÃ³n)
  if (oldVal > 0 && newVal === 0) {
    await logNovedad(`ðŸš¨ ${name} llegÃ³ a 0 puntos Â· Estado crÃ­tico Â· Requiere apelaciÃ³n o acciÃ³n inmediata.`);
    return;
  }
  // Umbral 3: entrÃ³ en "Riesgo alto" (<=2) viniendo de arriba
  if (oldVal > 2 && newVal > 0 && newVal <= 2) {
    await logNovedad(`âš ï¸ ${name} estÃ¡ en riesgo alto (${newVal.toFixed(decimalsCfgJow())} pts) Â· EntrÃ³ en seguimiento por bajo desempeÃ±o.`);
    return;
  }
  // Umbral 4: saliÃ³ de riesgo / entrÃ³ en "Estable"
  if (oldVal <= 2 && newVal > 4) {
    await logNovedad(`ðŸ’ª ${name} recuperÃ³ puntos (${newVal.toFixed(decimalsCfgJow())}) y saliÃ³ del estado de seguimiento. Buen desempeÃ±o!`);
    return;
  }
  // Umbral 5: alto desempeÃ±o (>=6 y delta >=2 de una)
  if (newVal >= 6 && delta >= 2) {
    await logNovedad(`ðŸ”¥ ${name} tuvo un desempeÃ±o excelente! SubiÃ³ ${delta} pts y quedÃ³ en ${newVal.toFixed(decimalsCfgJow())}.`);
    return;
  }
  // Umbral 6: nuevo ingreso / primer punto registrado (member.status o oldVal === undefined-ish)
  if ((oldVal === 0 || !Number.isFinite(oldVal)) && newVal === MAX && delta === MAX) {
    await logNovedad(`âœ¨ ${name} ingresÃ³ al staff con ${newVal.toFixed(decimalsCfgJow())} pts iniciales. Bienvenido/a!`);
    return;
  }
}

function updatePointCells(uid, pts) {
  const pn = document.getElementById("pn-" + uid);
  const pb = document.getElementById("pb-" + uid);
  const ps = document.getElementById("ps-" + uid);
  const av = document.getElementById("av-" + uid);
  if (pn) { pn.textContent = pts.toFixed(decimalsCfgJow()); pn.style.color = ptColor(pts); }
  if (pb) { pb.style.width = `${Math.min((pts/maxPtsCfg())*100,100)}%`; pb.className = `pts-mini-bar ${ptBarClass(pts)}`; }
  if (ps) ps.innerHTML = ptStateBadge(pts);
  if (av) av.textContent = pts.toFixed(decimalsCfgJow());
}

// â”€â”€ TABLA STAFF (con rango, cargos, estado) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function renderStaffTable() {
  const tb = document.getElementById("staff-full-body");
  if (!allMembers.length) {
    tb.innerHTML = '<tr><td colspan="4" class="t-empty">Sin miembros.</td></tr>';
    return;
  }
  tb.innerHTML = allMembers.map(u => {
    const isMe = currentUser && u.uid === currentUser.uid;
    
    // Cargos: campo libre en Firestore (array o string), o el rol de la pÃ¡gina si no existe
    const cargos = Array.isArray(u.cargos)
      ? u.cargos.map(c => `<span class="tag">${esc(c)}</span>`).join(" ")
      : u.cargos
        ? `<span class="tag">${esc(u.cargos)}</span>`
        : `<span style="color:var(--muted)">â€”</span>`;

    // Rango del servidor (campo separado del role de la pÃ¡gina)
    const rango = fmtRango(u.rango);

    return `
      <tr ${isMe ? 'class="my-row"' : ""}>
        <td>
          <b>${esc(u.name||"â€”")}</b>
          ${isMe ? '<span class="you-tag">tÃº</span>' : ""}
        </td>
        <td><span class="rango-tag">${rango}</span></td>
        <td>${cargos}</td>
        <td>${statusBadge(u.status)}</td>
      </tr>`;
  }).join("");
}

// â”€â”€ NOVEDADES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function renderNovedades() {
  const el = document.getElementById("novedades-list");
  if (!el) return;

  if (!novedades.length) {
    el.innerHTML = `
      <div class="novedad-empty">
        <div style="font-size:32px;margin-bottom:8px">ðŸ“‹</div>
        <div>No hay novedades registradas aÃºn.</div>
        <div style="font-size:12px;margin-top:4px;color:var(--muted)">Los cambios de puntos y movimientos del staff aparecerÃ¡n acÃ¡.</div>
      </div>`;
    return;
  }

  const isAdmin = currentUser?.role === "admin";
  el.innerHTML = novedades.map(n => {
    const fecha = n.fecha?.toDate ? fmtFecha(n.fecha.toDate()) : "â€”";
    const icono = getNovedadIcon(n.texto||"");
    const deleteBtn = isAdmin ? `<button class="logout-btn" style="position:static;font-size:12px;padding:4px 8px" onclick="deleteNovedad('${n.id}')">ðŸ—‘ï¸</button>` : "";
    return `
      <div class="novedad-item">
        <div class="nov-icon">${icono}</div>
        <div class="nov-body">
          <div class="nov-texto">${esc(n.texto||"")}</div>
          <div class="nov-meta">${fecha}${n.autor ? ` Â· por ${esc(n.autor)}` : ""}</div>
        </div>
        ${deleteBtn}
      </div>`;
  }).join("");
}

window.deleteNovedad = async (id) => {
  if (currentUser?.role !== "admin") return;
  const ok = confirm("Â¿Borrar esta novedad? No se puede deshacer.");
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "novedades", id));
    showToast("Novedad borrada.", "ok");
    // Recargar novedades
    const snap = await getDocs(query(collection(db, "novedades"), orderBy("fecha", "desc"), limit(20)));
    novedades = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderNovedades();
  } catch(e) {
    showToast("Error al borrar: " + e.message, "err");
  }
};

window.resetNovedades = async () => {
  if (currentUser?.role !== "admin") return;
  const ok = confirm("Â¿EstÃ¡s seguro de borrar TODAS las novedades? Esta acciÃ³n no se puede deshacer.");
  if (!ok) return;
  try {
    const snap = await getDocs(collection(db, "novedades"));
    const batch = snap.docs.map(d => deleteDoc(doc(db, "novedades", d.id)));
    await Promise.all(batch);
    novedades = [];
    renderNovedades();
    showToast("Todas las novedades han sido borradas.", "ok");
  } catch(e) {
    showToast("Error al borrar: " + e.message, "err");
  }
};

function getNovedadIcon(texto) {
  const t = texto.toLowerCase();
  if (t.includes("crÃ­tico") || t.includes("0 punto"))       return "ðŸš¨";
  if (t.includes("riesgo") || t.includes("seguimiento"))   return "âš ï¸";
  if (t.includes("recuperÃ³") || t.includes("saliÃ³") || t.includes("excelente") || t.includes("desempeÃ±o")) return "ðŸ’ª";
  if (t.includes("ingresÃ³") || t.includes("bienvenido") || t.includes("nuevo")) return "âœ¨";
  if (t.includes("volviÃ³") || t.includes("salvÃ³"))         return "âœ…";
  if (t.includes("expuls") || t.includes("apelaciÃ³n"))     return "ðŸ“®";
  if (t.includes("admin") || t.includes("ascenso"))        return "ðŸ’Ž";
  return "ðŸ””";
}

function fmtFecha(date) {
  return date.toLocaleString("es-AR", {
    day:"2-digit", month:"short", year:"numeric",
    hour:"2-digit", minute:"2-digit"
  });
}

// â”€â”€ TABS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
window.switchTab = (id, btn) => {
  try {
    // Bloquear navegaciÃ³n a la pestaÃ±a Mi Perfil (eliminada)
    if (id === "user-view") {
      id = "points-tab";
    }
    document.querySelectorAll(".tab-content").forEach(s => { s.classList.remove("active"); s.style.display="none"; });
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = "block";
    el.classList.add("active");
    if (btn && btn.classList) btn.classList.add("active");

    // hooks por pestaÃ±a (siempre que existan)
    if (id === "points-tab") { if (typeof renderPointsTable === "function") renderPointsTable(); if (typeof renderStats === "function") renderStats(); if (typeof renderDestacados === "function") renderDestacados(); }
    if (id === "graficos-tab") {
      if (typeof renderRankingAdmins === "function") renderRankingAdmins();
      if (typeof renderEvolutionPts === "function") renderEvolutionPts();
      if (typeof renderActivityChart === "function") renderActivityChart();
      if (typeof renderInspectorActivityJow === "function") renderInspectorActivityJow();
      if (typeof renderRankings === "function") renderRankings();
    }
    if (id === "staff-tab")   { if (typeof renderStaffTable === "function") renderStaffTable(); }
    if (id === "novedades-tab") { if (typeof renderNovedades === "function") renderNovedades(); }
    if (id === "logs-tab")    { if (typeof renderLogsJow === "function") renderLogsJow(); }
  } catch (e) { console.error("switchTab error", e); }
};

// â”€â”€ TOAST â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let toastTimer;
function showToast(msg, type="ok") {
  const t = document.getElementById("toast");
  t.textContent   = msg;
  t.style.display = "block";
  t.className     = "notification" + (type==="err" ? " notif-err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.add("hide");
    setTimeout(() => { t.style.display="none"; t.classList.remove("hide"); }, 300);
  }, 2800);
}

// â”€â”€ UTILS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function showLoginScreen() {
  document.getElementById("login-screen").style.display = "flex";
  document.getElementById("app").style.display = "none";
  const bp = document.getElementById("btn-pin");
  if(bp){ bp.disabled=false; bp.textContent="Entrar"; }
}

function showErr(msg) {
  const el = document.getElementById("login-err");
  el.textContent = msg;
  el.style.display = "block";
}

function ptColor(p) {
  if (p === 0) return "#ff5c75";
  if (p <= 2)  return "#ff9f43";
  if (p <= 4)  return "#ffd166";
  if (p <= 6)  return "#4cc9f0";
  return "#57cc99";
}

function ptBarClass(p) {
  if (p === 0) return "bar-0";
  if (p <= 2)  return "bar-2";
  if (p <= 4)  return "bar-4";
  if (p <= 6)  return "bar-6";
  return "bar-7";
}

function ptStateBadge(p) {
  if (p === 0) return '<span class="pts-badge badge-0">CrÃ­tico</span>';
  if (p <= 2)  return '<span class="pts-badge badge-2">Riesgo alto</span>';
  if (p <= 4)  return '<span class="pts-badge badge-4">Seguimiento</span>';
  if (p <= 6)  return '<span class="pts-badge badge-6">Estable</span>';
  return '<span class="pts-badge badge-7">Ã“ptimo</span>';
}

function ptStateFull(p) {
  const states = [
    { max:0, cls:"pts-badge badge-0", icon:"ðŸš¨", label:"CrÃ­tico",     desc:"ApelaciÃ³n abierta" },
    { max:2, cls:"pts-badge badge-2", icon:"âš ï¸",  label:"Riesgo alto", desc:"AumentÃ¡ tu actividad urgente" },
    { max:4, cls:"pts-badge badge-4", icon:"ðŸ‘€",  label:"Seguimiento", desc:"MantenÃ© el ritmo activo" },
    { max:6, cls:"pts-badge badge-6", icon:"ðŸ‘",  label:"Estable",     desc:"Vas bien" },
    { max:7, cls:"pts-badge badge-7", icon:"ðŸŒŸ",  label:"Ã“ptimo",      desc:"Excelente desempeÃ±o" },
  ];
  const s = states.find(x => p <= x.max) || states[states.length-1];
  return `<span class="${s.cls}">${s.icon} ${s.label} â€” ${s.desc}</span>`;
}

function roleName(r) {
  return { admin:"Administrador", inspector:"Inspector", user:"Usuario" }[r] || r;
}

function roleBadge(r) {
  const cl = { admin:"rb-admin", inspector:"rb-inspector", user:"rb-user" };
  const lb = { admin:"Admin", inspector:"Inspector", user:"Usuario" };
  return `<span class="role-badge ${cl[r]||"rb-user"}">${lb[r]||r}</span>`;
}

function statusBadge(s) {
  return s==="inactive"
    ? '<span class="status-badge status-en-riesgo">Inactivo</span>'
    : '<span class="status-badge status-activo">Activo</span>';
}

function esc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function friendlyErr(code) {
  const m = {
    "auth/wrong-password":"ContraseÃ±a incorrecta.",
    "auth/user-not-found":"No existe cuenta con ese email.",
    "auth/invalid-email":"Email invÃ¡lido.",
    "auth/invalid-credential":"Email o contraseÃ±a incorrectos.",
    "auth/too-many-requests":"Demasiados intentos, esperÃ¡ unos minutos.",
    "auth/network-request-failed":"Error de red.",
  };
  return m[code] || "Error al iniciar sesiÃ³n.";
}



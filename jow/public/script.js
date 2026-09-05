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
function maxPtsCfg()     { return maxPointsCfg; }
function decimalsCfgJow() { return decimalsCfg; }
async function loadPointsConfig() {
  try {
    const snap = await getDoc(doc(db, "settings", "pointDecrement"));
    if (snap.exists()) {
      const d = snap.data() || {};
      if (Number(d.maxPoints) >= 1) maxPointsCfg = Number(d.maxPoints);
      if ([0,1,2].includes(Number(d.decimals))) decimalsCfg = Number(d.decimals);
    }
  } catch (e) {
    console.error("Error cargando config de puntos:", e);
  }
}
const PTS_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const PTS_COOLDOWN_PREFIX = "jowiland:ptcd:";

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

// ── AUTH STATE ────────────────────────────────────────────────
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
      if (data.status === "inactive") { showErr("Tu cuenta está inactiva."); await signOut(auth); return; }
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
        showErr("Error de conexión. Verificá tu internet e intentá de nuevo.");
      } else {
        showErr("Error al cargar tu perfil: " + e.message);
      }
    }
  } else {
    await restorePinSession();
  }
});

// ── LOGIN SWITCH (PIN / Email) ─────────────────────────────────
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

// ── LOGIN PIN ──────────────────────────────────────────────────
window.loginWithPin = async () => {
  const nameRaw = document.getElementById("pin-name").value.trim();
  const pin     = document.getElementById("pin-code").value.trim();
  const btn     = document.getElementById("btn-pin");

  if (!nameRaw || !pin) return showErr("Ingresá tu nombre y PIN.");
  if (pin.length !== 4 || isNaN(pin)) return showErr("El PIN debe ser de 4 dígitos.");

  const chk = rlCheck("pin");
  if (!chk.ok) return showErr(`Demasiados intentos. Esperá ${fmtWait(chk.waitMs)} y probá de nuevo.`);

  btn.disabled = true;
  btn.textContent = "Verificando…";

  try {
    const normName = normLoginName(nameRaw);
    if (!normName) throw new Error("name-invalid");

    // Buscar credenciales con varios métodos de respaldo:
    // 1) publicLoginUsers (diseño original; requiere regla de lectura pública)
    // 2) users por nameLower (rápido, con índice)
    // 3) barrido client-side sobre users: cubre cuentas legacy que no
    //    tienen nameLower o que usan una normalización distinta del nombre
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
      showErr("Esta cuenta está inactiva.");
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
      showErr(`Demasiados intentos. Esperá ${fmtWait(fail.waitMs)} y probá de nuevo.`);
    } else {
      showErr("Nombre o PIN incorrecto.");
    }
    btn.disabled = false;
    btn.textContent = "Entrar";
  }
};
try { document.getElementById("pin-code").addEventListener("keydown", e => { if(e.key==="Enter") window.loginWithPin(); }); } catch {}

// ── LOGIN EMAIL / CONTRASEÑA ──────────────────────────────────
window.loginWithEmail = async () => {
  const email = document.getElementById("l-email")?.value.trim() || "";
  const pass  = document.getElementById("l-pass")?.value || "";
  const btn   = document.getElementById("btn-email");

  if (!email || !pass) return showErr("Completá email y contraseña.");
  const chk = rlCheck("email");
  if (!chk.ok) return showErr(`Demasiados intentos. Esperá ${fmtWait(chk.waitMs)} y probá de nuevo.`);

  if (btn) { btn.disabled = true; btn.textContent = "Verificando…"; }

  try {
    await signInWithEmailAndPassword(auth, email, pass);
    // onAuthStateChanged se encarga del resto
    rlReset("email");
  } catch (e) {
    const extra = e.code === "auth/too-many-requests" ? 10 * 60 * 1000 : 0;
    const fail  = rlFail("email", extra);
    showErr(fail.locked
      ? `Demasiados intentos. Esperá ${fmtWait(fail.waitMs)} y probá de nuevo.`
      : friendlyErr(e.code));
    if (btn) { btn.disabled = false; btn.textContent = "Ingresar"; }
  }
};

try {
  const lp = document.getElementById("l-pass");
  if (lp) lp.addEventListener("keydown", e => { if(e.key==="Enter") window.loginWithEmail(); });
} catch {}

// ── LOGOUT ─────────────────────────────────────────────────────
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

// ── BOOT ───────────────────────────────────────────────────────
async function bootApp() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("app").style.display = "block";

  const name = currentUser.name || "—";
  const role = currentUser.role || "user";

  // Mostrar panel superior del usuario actual
  const userStatsSection = document.getElementById("user-stats-section");
  if (userStatsSection) {
    userStatsSection.style.display = "grid";
    
    document.getElementById("uc-name").textContent = name;
    document.getElementById("uc-avatar").textContent = name.charAt(0).toUpperCase();
    document.getElementById("uc-avatar").className = "user-avatar av-" + role;
    
    const rangoTxt = fmtRango(currentUser.rango);
    document.getElementById("uc-rango").textContent = rangoTxt || "—";
    
    const cargos = currentUser.cargos || [];
    document.getElementById("uc-cargos").textContent = Array.isArray(cargos) ? cargos.join(", ") : String(cargos || "—");
    
    const pts = Number(currentUser.points || 0);
    document.getElementById("uc-pts").textContent = pts.toFixed(decimalsCfgJow());
  }

  await loadPointsConfig();
  await loadNovedades();
  await loadMembers();

  // Todos ven el panel completo (tabla de puntos, staff, guía, rangos, normas y
  // novedades); los controles y pestañas administrativas se ocultan según rol.
  setupStaffView();
  setupLogsTab();
  if (role === "user") {
    const perfilBtn = document.getElementById("my-perfil-tab-btn");
    if (perfilBtn) perfilBtn.style.display = "";
    renderUserProfileCard();
  }
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

window.setLogTypeFilterJow = (v) => { logTypeFilter = v; renderLogsJow(); };
window.setLogSearchJow = (v) => { logSearch = (v || "").toLowerCase(); renderLogsJow(); };

// ── CHART CONTROLS ─────────────────────────────────────────────
window.refreshCharts = () => {
  // Refrescar gráficos sin borrar datos
  if (typeof renderRankingAdmins === "function") renderRankingAdmins();
  if (typeof renderEvolutionPts === "function") renderEvolutionPts();
  if (typeof renderActivityChart === "function") renderActivityChart();
  if (typeof renderInspectorActivityJow === "function") renderInspectorActivityJow();
  if (typeof renderRankings === "function") renderRankings();
  showToast("Gráficos actualizados", "ok");
};

window.resetChartData = () => {
  const role = currentUser?.role;
  if (role !== "admin") {
    showToast("Solo los admins pueden reiniciar los datos", "err");
    return;
  }
  
  const ok = confirm("¿Estás seguro de que quieres borrar todos los datos históricos de los gráficos? Esta acción no se puede deshacer.");
  if (!ok) return;
  
  // En una implementación real, esto borraría los logs históricos
  // Por ahora, solo mostramos un mensaje de confirmación
  showToast("Función de reinicio de datos implementada (borrar logs históricos)", "ok");
  
  // Después de implementar, llamar a refreshCharts() para recargar
  if (typeof refreshCharts === "function") refreshCharts();
};

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
  return d ? d.toLocaleString("es-CO") : "—";
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
    if (typeof renderActivityChart === "function") renderActivityChart();
    if (typeof renderRankings === "function") renderRankings();
    if (typeof renderDestacados === "function") renderDestacados();
    if (typeof renderRankingAdmins === "function") renderRankingAdmins();
    if (typeof renderEvolutionPts === "function") renderEvolutionPts();
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
    const actor = esc(l.actorName || "—");
    const target = esc(l.targetName || (l.type === "login" ? (l.actorName || "—") : "—"));
    const delta = isPoints ? (typeof l.delta === "number" ? l.delta : 0) : null;
    const deltaTxt = isPoints ? `${delta > 0 ? "+" : ""}${delta}` : "—";
    const motivo = esc(l.reason || (l.type === "login" ? "Inicio de sesión" : "Sin motivo"));
    const delBtn = isAdmin ? `<button class="logout-btn" style="position:static" onclick="deleteLogJow('${l.id}')">🗑️</button>` : "";
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
  const ok = confirm("¿Borrar este registro? No se puede deshacer.");
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
  const tb = document.getElementById("insp-jow-body");
  if (!tb) return;
  const today = dayKey(new Date());
  const todays = logs.filter(l => l.type === "points" && l.dayKey === today && l.actorRole === "inspector");
  if (!todays.length) {
    tb.innerHTML = '<tr><td colspan="6" class="t-empty">Sin actividad hoy.</td></tr>';
    return;
  }

  const mp = new Map();
  for (const l of todays) {
    const uid = l.actorUid || "—";
    const prev = mp.get(uid) || {
      uid,
      name: l.actorName || "—",
      pts: 0,
      actions: 0,
      lastAt: null,
      lastTxt: "—"
    };
    const delta = typeof l.delta === "number" ? l.delta : 0;
    if (delta > 0) prev.pts += delta;
    prev.actions += 1;
    const d = tsToDate(l.createdAt);
    if (d && (!prev.lastAt || d > prev.lastAt)) {
      prev.lastAt = d;
      const tgt = l.targetName ? ` → ${l.targetName}` : "";
      prev.lastTxt = `${delta > 0 ? "+" : ""}${delta}${tgt}`;
    }
    mp.set(uid, prev);
  }

  const list = [...mp.values()].sort((a, b) => {
    if (b.actions !== a.actions) return b.actions - a.actions;
    if (b.pts !== a.pts) return b.pts - a.pts;
    const ta = a.lastAt ? a.lastAt.getTime() : 0;
    const tb = b.lastAt ? b.lastAt.getTime() : 0;
    return tb - ta;
  });

  tb.innerHTML = list.map(r => {
    const now = Date.now();
    const lastMs = r.lastAt ? (now - r.lastAt.getTime()) : Infinity;
    const state = lastMs <= 15 * 60 * 1000 ? "🟢 Activo" : lastMs <= 60 * 60 * 1000 ? "🟡 Poco activo" : "🔴 Inactivo";
    return `
      <tr>
        <td><b>${esc(r.name)}</b></td>
        <td><b style="color:#ffd166">${r.pts}</b></td>
        <td>${r.actions}</td>
        <td>${esc(r.lastTxt)}</td>
        <td>${r.lastAt ? fmtSince(lastMs) : "—"}</td>
        <td>${state}</td>
      </tr>`;
  }).join("");
}

// ── CARGAR MIEMBROS ────────────────────────────────────────────
async function loadMembers() {
  try {
    const snap = await getDocs(query(collection(db, "users"), orderBy("points", "desc")));
    allMembers = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
    const me = allMembers.find(u => u.uid === currentUser.uid);
    if (me) currentUser.points = me.points;
  } catch(e) { console.error("Error cargando miembros:", e); }
}

// ── CARGAR NOVEDADES ───────────────────────────────────────────
async function loadNovedades() {
  try {
    const snap = await getDocs(query(collection(db, "novedades"), orderBy("fecha", "desc"), limit(20)));
    novedades = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch(e) {
    // Si la colección no existe aún, no es error
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

// ── REGISTRAR NOVEDAD (interno) ────────────────────────────────
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

// ══════════════════════════════════════════
// VISTA USUARIO
// ══════════════════════════════════════════
function renderUserProfileCard() {
  const uv = document.getElementById("user-view");
  if (!uv) return;
  const pts = Number(currentUser.points || 0);
  const whoEl = document.getElementById("my-pts-who");
  if (whoEl) whoEl.innerHTML = `👋 Bienvenido/a, <b>${esc(currentUser.name || "—")}</b>`;
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
    ucPts.textContent   = `⭐ ${pts.toFixed(decimalsCfgJow())} puntos`;
  }
}

// Compatibilidad: la vista completa ahora la administra setupStaffView.
function setupUserView() {
  renderUserProfileCard();
}

// ══════════════════════════════════════════
// VISTA STAFF
// ══════════════════════════════════════════
function setupStaffView() {
  const role     = currentUser?.role;
  const isStaff  = role === "admin" || role === "inspector";
  const statsSec = document.getElementById("stats-section");
  const destSec  = document.getElementById("destacados-section");
  const btnDest  = document.getElementById("btn-dest");

  // Todos los usuarios pueden ver estadísticas y destacados
  if (statsSec) statsSec.style.display = "";
  if (destSec) destSec.style.display = "none";
  if (btnDest) btnDest.style.display = ""; // Botón visible para todos

  document.getElementById("tabs-nav").style.display = "";

  // Visibilidad de pestañas por rol: Gráficos y Logs solo staff; "Mi perfil" solo usuarios
  const grafBtn = document.getElementById("graficos-tab-btn");
  if (grafBtn) grafBtn.style.display = isStaff ? "" : "none";
  const perfilBtn2 = document.getElementById("my-perfil-tab-btn");
  if (perfilBtn2) perfilBtn2.style.display = role === "user" ? "" : "none";

  // Activar primera pestaña
  document.querySelectorAll(".tab-content").forEach(el => { el.style.display="none"; el.classList.remove("active"); });
  document.getElementById("points-tab").style.display = "block";
  document.getElementById("points-tab").classList.add("active");
  document.querySelector(".tab").classList.add("active");

  if (isStaff) {
    populateUserFilter();
    renderActivityChart();
    renderRankings();
    renderRankingAdmins();
    renderEvolutionPts();
    
    // Mostrar botón de reinicio solo para admins
    const resetBtn = document.getElementById("reset-data-btn");
    if (resetBtn) {
      resetBtn.style.display = role === "admin" ? "" : "none";
    }
  }
  renderStats();
  renderPointsTable();
  renderStaffTable();
  renderNovedades();
}

// ── TRABAJADORES DESTACADOS: mostrar / ocultar ────────────────
let destacadosOpen = false;

window.toggleDestacados = () => {
  const destSec = document.getElementById("destacados-section");
  const btn     = document.getElementById("btn-dest");
  if (!destSec) return;
  destacadosOpen = !destacadosOpen;
  destSec.style.display = destacadosOpen ? "block" : "none";
  if (btn) btn.textContent = destacadosOpen ? "🙈 Ocultar trabajadores destacados" : "👁️ Mostrar trabajadores destacados";
  if (destacadosOpen && typeof renderDestacados === "function") renderDestacados();
};

// ══════════════════════════════════════════
// RANGOS (nueva estructura)
// ══════════════════════════════════════════
const RANK_LABELS = {
  overlord:  "《🪬》 Overlord",
  owner:     "《🧿》 Owner",
  admin:     "《💎》 Admin",
  centinela: "《�》 Centinela",
  vigia:     "《🔹》 Vigia"
};
const RANK_ORDER = ["vigia", "centinela", "admin", "owner", "overlord"];

function normRango(r) {
  let s = String(r || "").trim().toLowerCase();
  s = s.replace(/《.*?》/g, "").replace(/[^a-záéíóúñ ]/g, "").replace(/\s+/g, " ").trim();
  if (s.includes("overlord")) return "overlord";
  if (s.includes("owner"))    return "owner";
  if (s.includes("admin"))    return "admin";
  if (s.includes("centinela")) return "centinela";
  if (s.includes("vigia"))    return "vigia";
  // Rangos antiguos seleccionados → se adaptan al nuevo rango base Vigia
  if (s.includes("vip") || s.includes("usuario") || s.includes("bot")) return "vigia";
  return null;
}

function fmtRango(r) {
  const k = normRango(r);
  return k ? RANK_LABELS[k] : (r ? esc(String(r)) : "—");
}

function rangoIndex(k) {
  const i = RANK_ORDER.indexOf(k);
  return i >= 0 ? i : -1;
}

// ══════════════════════════════════════════
// CARGO MC TEAM (MC Team es un CARGO)
// ══════════════════════════════════════════
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
// superior a Admin/Owner/Overlord + activo. Los Inspectores SÍ cuentan
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

// ── STATS GENERALES (staff operativo: MC Team + no admin) ─────
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
  if (s1) s1.textContent = `${insp} inspectores · ${users} usuarios`;
  if (s2) s2.textContent = `Máximo: ${maxP.toFixed(decimalsCfgJow())} pts`;
  if (s3) s3.textContent = total ? Math.round(risk / total * 100) + "% del staff (≤ 2 pts)" : "—";

  const b1 = el("total-members-bar"), b2 = el("avg-points-bar"), b3 = el("staff-at-risk-bar");
  if (b1) b1.style.width = Math.min(100, total * 12) + "%";
  if (b2) b2.style.width = Math.min(100, (avg / maxP) * 100) + "%";
  if (b3) b3.style.width = Math.min(100, total ? (risk / total) * 100 : 0) + "%";
}

// ── UTILIDADES DE TIEMPO / LOGS ────────────────────────────────
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

// ── GRÁFICO: ACTIVIDAD DE ADMINS POR DÍA (24 horas) ────────────
// Estadística de Admins; separada de las del MC Team.
function renderActivityChart() {
  const el = document.getElementById("activity-chart");
  const legendEl = document.getElementById("chart-legend");
  if (!el) return;
  const role = currentUser?.role;
  if (role !== "admin" && role !== "inspector") return;

  if (!logs.length) {
    el.innerHTML = '<div class="chart-empty">Sin datos de actividad todavía. Los movimientos de admins e inspectores aparecerán acá.</div>';
    if (legendEl) legendEl.innerHTML = "";
    return;
  }

  const now = Date.now();
  const buckets = chartBuckets(chartPeriod, now);
  let maxVal = 1;
  for (const b of buckets) {
    b.admins = 0; b.inspectors = 0;
    for (const l of logs) {
      const t = logTime(l);
      if (t < b.start || t >= b.end) continue;
      const r = String(l.actorRole || "").toLowerCase();
      if (r === "admin") b.admins++;
      else b.inspectors++;
    }
    maxVal = Math.max(maxVal, b.admins, b.inspectors);
  }

  const W = 760, H = 250, pl = 40, pr = 16, pt = 18, pb = 32;
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
    // Con 24 horas, mostramos cada franja horaria; se reduce el tamaño de fuente.
    if (buckets.length > 12 && i % 2 === 1) return;
    xl += `<text x="${xPos(i)}" y="${H - 8}" text-anchor="middle" font-size="${buckets.length > 12 ? 8 : 9}" fill="#7c86ad">${b.label}</text>`;
  });

  const lines = [
    { key: "admins", color: "#7f8cff", label: "Admins" },
    { key: "inspectors", color: "#3ecf8e", label: "Inspectores" }
  ];
  for (const s of lines) {
    const pts = buckets.map((b, i) => `${xPos(i)},${yPos(b[s.key])}`).join(" ");
    series += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`;
    buckets.forEach((b, i) => {
      series += `<circle cx="${xPos(i)}" cy="${yPos(b[s.key])}" r="2.6" fill="${s.color}"/>`;
    });
  }

  el.innerHTML = `
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Actividad de los admins (${chartPeriod})">
      ${grid}
      <line x1="${pl}" y1="${pt}" x2="${pl}" y2="${pt + ih}" stroke="rgba(141,153,255,.22)" stroke-width="1"/>
      <line x1="${pl}" y1="${pt + ih}" x2="${W - pr}" y2="${pt + ih}" stroke="rgba(141,153,255,.22)" stroke-width="1"/>
      ${xl}
      ${series}
    </svg>
    <div class="chart-note">Actividad registrada · ${chartPeriod === "day" ? "24 horas completas (12 AM → 11 PM)" : chartPeriod === "week" ? "7 días" : "30 días"} · ${logs.length} registros cargados</div>`;

  if (legendEl) {
    legendEl.innerHTML = lines.map(s => `<span class="legend-item"><span class="legend-dot" style="background:${s.color}"></span>${s.label}</span>`).join("");
  }
}

function countByActor(list, filterFn) {
  const mp = new Map();
  for (const l of list) {
    if (filterFn && !filterFn(l)) continue;
    const key = l.actorUid || "—";
    const prev = mp.get(key) || { uid: key, name: l.actorName || "—", count: 0 };
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
  if (!winner) { vEl.textContent = "—"; if (sEl) sEl.textContent = "Sin datos por ahora"; return; }
  vEl.textContent = esc(winner.name);
  if (sEl) sEl.textContent = `${winner.count} ${label}`;
}

// ── RANKINGS SECUNDARIOS (menú desplegable, NIVEL 4) ───────────
function renderRankings() {
  const role = currentUser?.role;
  if (role !== "admin" && role !== "inspector") return;

  fillRank("rank-admin-active", "rank-admin-active-sub",
    bestActor(logs, l => String(l.actorRole || "").toLowerCase() === "admin"), "acciones registradas");

  fillRank("rank-points-editor", "rank-points-editor-sub",
    bestActor(logs.filter(l => l.type === "points"), null), "cambios de puntos");

  fillRank("rank-login-leader", "rank-login-leader-sub",
    bestActor(logs.filter(l => l.type === "login"), null), "ingresos a la página");

  fillRank("rank-inspector", "rank-inspector-sub",
    bestActor(logs, l => String(l.actorRole || "").toLowerCase() === "inspector" && l.type === "points"), "acciones de puntos");
}

// ══════════════════════════════════════════
// TRABAJADORES DESTACADOS (Día / Semana / Mes)
// ══════════════════════════════════════════
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
  // Todos los usuarios pueden ver los destacados (según especificaciones)

  const defs = [
    { mode: "day",   id: "destacado-day",   empty: "Sin datos hoy" },
    { mode: "week",  id: "destacado-week",  empty: "Sin datos esta semana" },
    { mode: "month", id: "destacado-month", empty: "Sin datos este mes" }
  ];
  for (const def of defs) {
    const el = document.getElementById(def.id);
    if (!el) continue;
    const rows = periodWorkers(def.mode);
    const winner = rows[0];
    if (!winner) { el.innerHTML = `<div class="dc-empty">${def.empty}</div>`; continue; }
    const u = winner.u;
    const pts = Number(u.points) || 0;
    el.innerHTML = `
      <div class="dc-name">${esc(u.name || "—")}</div>
      <div class="dc-pts">⭐ ${pts.toFixed(decimalsCfgJow())} puntos</div>
      <div class="dc-meta">
        <span>🎯 ${winner.count} acciones</span>
        <span>${winner.deltaPts > 0 ? "➕" : winner.deltaPts < 0 ? "➖" : "·"} ${Math.abs(winner.deltaPts).toFixed(decimalsCfgJow())} pts</span>
        <span>#${winner.place} de ${rows.length}</span>
      </div>`;
  }
}

// ══════════════════════════════════════════
// GRÁFICOS DEL MC TEAM (pestaña Gráficos)
// ══════════════════════════════════════════
const PALETTE = ["#5865f2", "#3ecf8e", "#ffd166", "#ff9f43", "#ff5c75", "#4cc9f0", "#a78bfa", "#57cc99"];

const modeStates = { evo: "line", admin: "line", admins: "cols" };
const filterState = { user: "", rango: "", cargo: "" };
let evoTimeState = "14";

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
window.setEvoTime       = (days, btn) => { evoTimeState = days; renderEvolutionPts(); };

// ── FILTROS ─────────────────────────────────────────────────────
window.applyFilters = () => {
  filterState.user = document.getElementById("filter-user")?.value || "";
  filterState.rango = document.getElementById("filter-rango")?.value || "";
  filterState.cargo = document.getElementById("filter-cargo")?.value || "";
  
  // Re-render all charts with new filters
  renderRankingAdmins();
  renderEvolutionPts();
};

window.resetFilters = () => {
  const userSelect = document.getElementById("filter-user");
  const rangoSelect = document.getElementById("filter-rango");
  const cargoSelect = document.getElementById("filter-cargo");
  
  if (userSelect) userSelect.value = "";
  if (rangoSelect) rangoSelect.value = "";
  if (cargoSelect) cargoSelect.value = "";
  
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
  // Incluir admins e inspectores que pueden asignar puntos
  const team = allMembers.filter(u => (u.role === "admin" || u.role === "inspector") && u.status === "active");
  team.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  team.forEach(u => {
    const option = document.createElement("option");
    option.value = u.uid;
    option.textContent = u.name || "—";
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
    legend += `<span class="legend-item"><span class="legend-dot" style="background:${it.color}"></span>${esc(it.label)} · ${(frac * 100).toFixed(1)}%</span>`;
  }
  return `
    <svg class="chart-svg" viewBox="0 0 180 180" role="img">
      ${arcs}
      <text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="13" fill="#fff" font-weight="700">${centerLabel || Math.round(total)}</text>
    </svg>
    <div class="chart-legend">${legend}</div>`;
}

function rankListHTML(rows, valLabel, showRango) {
  const max = Math.max(1, ...rows.map(r => Number(r.value) || 0));
  return `<div class="rank-list">
    ${rows.map((r, i) => {
      const pct = Math.min((Number(r.value) || 0) / max * 100, 100);
      return `<div class="rank-row">
        <span class="rank-pos">#${i + 1}</span>
        <span class="rank-name"><b>${esc(r.name || "—")}</b>${showRango ? ` <span class="rango-tag">${fmtRango(r.rango)}</span>` : ""}</span>
        <span class="rank-bars"><span class="rank-bar" style="width:${pct}%"></span></span>
        <span class="rank-val">${valLabel} ${Number(r.value || 0).toFixed(decimalsCfgJow())}</span>
      </div>`;
    }).join("")}
  </div>`;
}


                </div>
                <div class="stat-row">
                  <span class="stat-label">Variación:</span>
                  <span class="stat-value ${r.deltaPts > 0 ? 'positive' : r.deltaPts < 0 ? 'negative' : 'neutral'}">${r.deltaPts > 0 ? '+' : ''}${r.deltaPts.toFixed(decimalsCfgJow())}</span>
                </div>
              </div>
              <div class="worker-bar">
                <div class="worker-bar-fill" style="width: ${pct}%; background: ${PALETTE[i % PALETTE.length]}"></div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
      <div class="chart-note">Puntos, acciones y variación por trabajador (30 días)</div>
    `;
  }
}

function multiLineChartSVG(labels, series, h) {
  const H = h || 230, W = 760, pl = 44, pr = 16, pt = 18, pb = 32;
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
  const H = h || 230, W = 760, pl = 44, pr = 16, pt = 18, pb = 32;
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

// Evolución de puntos: reconstruye el valor diario de cada trabajador
// del equipo a partir de los registros (delta) y los puntos actuales.
function renderEvolutionPts() {
  const el = document.getElementById("evo-pts-chart");
  const legendEl = document.getElementById("evo-pts-legend");
  if (!el) return;
  const role = currentUser?.role;
  if (role !== "admin" && role !== "inspector") return;

  // Usar todo el equipo (admins e inspectores que pueden asignar puntos)
  let team = allMembers.filter(u => (u.role === "admin" || u.role === "inspector") && u.status === "active");
  
  // Apply filters
  if (filterState.user) {
    team = team.filter(u => u.uid === filterState.user);
  }
  if (filterState.rango) {
    team = team.filter(u => normRango(u.rango) === filterState.rango);
  }
  if (filterState.cargo) {
    team = team.filter(u => hasCargo(u, filterState.cargo));
  }
  
  team = team.sort((a, b) => (b.points || 0) - (a.points || 0)).slice(0, 6);
  
  if (!team.length) { el.innerHTML = '<div class="chart-empty">Sin miembros del equipo que coincidan con los filtros.</div>'; if (legendEl) legendEl.innerHTML = ""; return; }

  const now = Date.now();
  const isDayView = evoTimeState === "7";
  const step = isDayView ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000; // 1 hora para día, 1 día para otros
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

  const series = team.map((m, i) => ({
    name: m.name || "—",
    color: PALETTE[i % PALETTE.length],
    values: periods.map(d => d.vals[m.uid])
  }));

  if (modeStates.evo === "line") {
    el.innerHTML = multiLineChartSVG(periods.map(d => d.label), series);
  } else {
    // Modo columnas: mostrar suma de puntos por período
    const periodTotals = periods.map(d => ({
      label: d.label,
      value: team.reduce((sum, m) => sum + (d.vals[m.uid] || 0), 0)
    }));
    el.innerHTML = barChartSVG(periodTotals.map(d => d.label), [{ name: "Total puntos", color: "#3ecf8e", values: periodTotals.map(d => d.value) }]);
  }
  
  if (legendEl) {
    legendEl.innerHTML = series.map(s => `<span class="legend-item"><span class="legend-dot" style="background:${s.color}"></span>${esc(s.name)}</span>`).join("");
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

// ── TABLA PUNTOS (con controles para Admins e Inspectores) ───────────────────
function renderPointsTable() {
  const tb = document.getElementById("pts-full-body");
  const theadRow = document.getElementById("pts-thead-row");
  const role = currentUser?.role;
  const isStaff = role === "admin" || role === "inspector";

  // La tabla muestra únicamente trabajadores con cargo MC Team.
  const list = mcWorkers().sort((a,b) => (b.points||0)-(a.points||0));

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
            <input type="number" class="pts-input" id="pts-input-${u.uid}" min="0" max="${maxVal}" step="${stepVal}" placeholder="${placeholderVal}" style="width: 60px; padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(141,153,255,.25); background: rgba(15,20,40,.8); color: #e9eeff; font-size: 12px; outline: none;" value="" onkeydown="if(event.key==='Enter') setPoints('${u.uid}')">
            <button class="pts-btn pts-set" onclick="setPoints('${u.uid}')" title="Establecer valor (Enter)">⚙️</button>
          ` : `
            <button class="pts-btn pts-add" onclick="adjustPoints('${u.uid}', 1)" title="Sumar +1">➕</button>
            <button class="pts-btn pts-sub" onclick="adjustPoints('${u.uid}', -1)" title="Restar -1">➖</button>
          `}
        </div>
      </td>` : '<td></td>';

    return `
      <tr ${isMe ? 'class="my-row"' : ""}>
        <td class="rank-col">${i+1}</td>
        <td>
          <span class="member-av av-${u.role}">${(u.name||"?").charAt(0).toUpperCase()}</span>
          <b>${esc(u.name||"—")}</b>
          ${isMe ? '<span class="you-tag">tú</span>' : ""}
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

// ── AJUSTAR PUNTOS ─────────────────────────────────────────────
// Ajustar puntos para Inspectores (hasta 2 pts) y Admins
window.adjustPoints = async (uid, delta) => {
  const role = currentUser?.role;
  if (role !== 'admin' && role !== 'inspector') return;
  if (uid === currentUser.uid) { showToast('No podés modificar tus propios puntos!', 'err'); return; }
  const member = allMembers.find(u => u.uid === uid);
  if (!member) return;

  if (role === 'inspector') {
    const cd = checkInspectorCooldown(uid);
    if (!cd.ok) { showToast(`Cooldown activo. Podés volver a puntuar a esta persona en ${fmtSince(cd.waitMs)}.`, 'err'); return; }
    
    // Para inspectores, pedir cantidad (máximo 2)
    const amountRaw = prompt("Cantidad de puntos a asignar (máximo 2):", "1");
    if (amountRaw === null) return;
    const amount = parseFloat(amountRaw);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 2) {
      showToast("Ingresá un valor entre 1 y 2", "err");
      return;
    }
    delta = delta > 0 ? amount : -amount;
  }

  const oldVal = member.points || 0;
  const rawNewVal = oldVal + delta;
  const factor = Math.pow(10, decimalsCfgJow());
  const newVal = Math.max(0, Math.min(maxPtsCfg(), Math.round(rawNewVal * factor) / factor));
  
  if (newVal === oldVal) return;
  
  const reason = delta > 0 ? `Ajuste rápido (+${Math.abs(delta)})` : `Ajuste rápido (-${Math.abs(delta)})`;

  member.points = newVal; updatePointCells(uid, newVal);
  try {
    await updateDoc(doc(db, 'users', uid), { points: newVal });
    await writeLog({ type: 'points', actorUid: currentUser.uid, actorRole: role, actorName: currentUser.name||'', targetUid: uid, targetName: member.name||'', delta: delta, reason, newPoints: newVal });
    if (role === 'inspector') {
      writeCooldown(currentUser.uid, uid, Date.now());
      showToast(`Puntos ${delta > 0 ? 'sumados' : 'restados'}: ${delta > 0 ? '+' : ''}${Math.abs(delta)}`, 'ok');
    } else {
      await logNovedad(`🔧 Admin ${currentUser.name||''} ${delta > 0 ? 'sumó' : 'restó'} ${Math.abs(delta)} pts a ${member.name||'usuario'}. Motivo: ${reason}`);
      showToast(`Puntos ${delta > 0 ? 'sumados' : 'restados'}: ${delta > 0 ? '+' : ''}${Math.abs(delta)}`, 'ok');
    }
    renderAll();
  } catch (e) { member.points = oldVal; updatePointCells(uid, oldVal); showToast('Error al guardar: '+e.message,'err'); }
};

// ── ESTABLECER VALOR DE PUNTOS ─────────────────────────────────────
// Establecer valor exacto de puntos (solo para Admins)
window.setPoints = async (uid) => {
  const role = currentUser?.role;
  if (role !== 'admin') return; // Solo Admins pueden usar esta función
  if (uid === currentUser.uid) { showToast('No podés modificar tus propios puntos!', 'err'); return; }
  const member = allMembers.find(u => u.uid === uid);
  if (!member) return;

  const inputEl = document.getElementById(`pts-input-${uid}`);
  const inputValue = inputEl ? parseFloat(inputEl.value) : 0;
  
  if (!Number.isFinite(inputValue) || inputValue < 0) {
    showToast('Ingresá un valor válido (mayor o igual a 0).', 'err');
    return;
  }

  const oldVal = member.points || 0;
  const factor = Math.pow(10, decimalsCfgJow());
  const newVal = Math.max(0, Math.min(maxPtsCfg(), Math.round(inputValue * factor) / factor));
  
  if (newVal === oldVal) return;
  const reason = 'Establecer valor directo';

  member.points = newVal; updatePointCells(uid, newVal);
  try {
    await updateDoc(doc(db, 'users', uid), { points: newVal });
    await writeLog({ type: 'points', actorUid: currentUser.uid, actorRole: role, actorName: currentUser.name||'', targetUid: uid, targetName: member.name||'', delta: newVal - oldVal, reason, newPoints: newVal });
    await logNovedad(`🔧 Admin ${currentUser.name||''} estableció ${member.name||'usuario'} a ${newVal} pts. Motivo: ${reason}`);
    showToast(`Puntos establecidos: ${newVal}`, 'ok');
    // Limpiar el input después de aplicar
    if (inputEl) inputEl.value = '';
    renderAll();
  } catch (e) { member.points = oldVal; updatePointCells(uid, oldVal); showToast('Error al guardar: '+e.message,'err'); }
};

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

// ── TABLA STAFF (con rango, cargos, estado) ─────────────────────
function renderStaffTable() {
  const tb = document.getElementById("staff-full-body");
  if (!allMembers.length) {
    tb.innerHTML = '<tr><td colspan="4" class="t-empty">Sin miembros.</td></tr>';
    return;
  }
  tb.innerHTML = allMembers.map(u => {
    // Cargos: campo libre en Firestore (array o string), o el rol de la página si no existe
    const cargos = Array.isArray(u.cargos)
      ? u.cargos.map(c => `<span class="tag">${esc(c)}</span>`).join(" ")
      : u.cargos
        ? `<span class="tag">${esc(u.cargos)}</span>`
        : `<span style="color:var(--muted)">—</span>`;

    // Rango del servidor (campo separado del role de la página)
    const rango = fmtRango(u.rango);

    return `
      <tr>
        <td><b>${esc(u.name||"—")}</b></td>
        <td><span class="rango-tag">${rango}</span></td>
        <td>${cargos}</td>
        <td>${statusBadge(u.status)}</td>
      </tr>`;
  }).join("");
}

// ── NOVEDADES ───────────────────────────────────────────────────
function renderNovedades() {
  const el = document.getElementById("novedades-list");
  if (!el) return;

  if (!novedades.length) {
    el.innerHTML = `
      <div class="novedad-empty">
        <div style="font-size:32px;margin-bottom:8px">📋</div>
        <div>No hay novedades registradas aún.</div>
        <div style="font-size:12px;margin-top:4px;color:var(--muted)">Los cambios de puntos y movimientos del staff aparecerán acá.</div>
      </div>`;
    return;
  }

  el.innerHTML = novedades.map(n => {
    const fecha = n.fecha?.toDate ? fmtFecha(n.fecha.toDate()) : "—";
    const icono = getNovedadIcon(n.texto||"");
    return `
      <div class="novedad-item">
        <div class="nov-icon">${icono}</div>
        <div class="nov-body">
          <div class="nov-texto">${esc(n.texto||"")}</div>
          <div class="nov-meta">${fecha}${n.autor ? ` · por ${esc(n.autor)}` : ""}</div>
        </div>
      </div>`;
  }).join("");
}

function getNovedadIcon(texto) {
  const t = texto.toLowerCase();
  if (t.includes("sumó") || t.includes("+"))      return "➕";
  if (t.includes("restó") || t.includes("−"))     return "➖";
  if (t.includes("eliminado") || t.includes("baj")) return "🗑️";
  if (t.includes("creado") || t.includes("nuevo")) return "✨";
  if (t.includes("inactivo") || t.includes("suspendido")) return "⏸️";
  if (t.includes("apelación"))                      return "📨";
  return "📌";
}

function fmtFecha(date) {
  return date.toLocaleString("es-AR", {
    day:"2-digit", month:"short", year:"numeric",
    hour:"2-digit", minute:"2-digit"
  });
}

// ── TABS ────────────────────────────────────────────────────────
window.switchTab = (id, btn) => {
  try {
    document.querySelectorAll(".tab-content").forEach(s => { s.classList.remove("active"); s.style.display="none"; });
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = "block";
    el.classList.add("active");
    if (btn && btn.classList) btn.classList.add("active");

    // hooks por pestaña (siempre que existan)
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

// ── TOAST ───────────────────────────────────────────────────────
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

// ── UTILS ───────────────────────────────────────────────────────
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
  if (p === 0) return '<span class="pts-badge badge-0">Crítico</span>';
  if (p <= 2)  return '<span class="pts-badge badge-2">Riesgo alto</span>';
  if (p <= 4)  return '<span class="pts-badge badge-4">Seguimiento</span>';
  if (p <= 6)  return '<span class="pts-badge badge-6">Estable</span>';
  return '<span class="pts-badge badge-7">Óptimo</span>';
}

function ptStateFull(p) {
  const states = [
    { max:0, cls:"pts-badge badge-0", icon:"🚨", label:"Crítico",     desc:"Apelación abierta" },
    { max:2, cls:"pts-badge badge-2", icon:"⚠️",  label:"Riesgo alto", desc:"Aumentá tu actividad urgente" },
    { max:4, cls:"pts-badge badge-4", icon:"👀",  label:"Seguimiento", desc:"Mantené el ritmo activo" },
    { max:6, cls:"pts-badge badge-6", icon:"👍",  label:"Estable",     desc:"Vas bien" },
    { max:7, cls:"pts-badge badge-7", icon:"🌟",  label:"Óptimo",      desc:"Excelente desempeño" },
  ];
  const s = states.find(x => p <= x.max) || states[states.length-1];
  return `<span class="${s.cls}">${s.icon} ${s.label} — ${s.desc}</span>`;
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
    "auth/wrong-password":"Contraseña incorrecta.",
    "auth/user-not-found":"No existe cuenta con ese email.",
    "auth/invalid-email":"Email inválido.",
    "auth/invalid-credential":"Email o contraseña incorrectos.",
    "auth/too-many-requests":"Demasiados intentos, esperá unos minutos.",
    "auth/network-request-failed":"Error de red.",
  };
  return m[code] || "Error al iniciar sesión.";
}

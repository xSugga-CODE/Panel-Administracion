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
  const storedUid = sessionStorage.getItem(PIN_SESSION_KEY);
  if (!storedUid) {
    showLoginScreen();
    return;
  }

  try {
    const snap = await getDoc(doc(db, "users", storedUid));
    if (!snap.exists()) {
      sessionStorage.removeItem(PIN_SESSION_KEY);
      showLoginScreen();
      return;
    }

    const data = snap.data();
    if (data.status === "inactive") {
      sessionStorage.removeItem(PIN_SESSION_KEY);
      showLoginScreen();
      return;
    }

    currentUser = { uid: storedUid, ...data, role: String(data.role || "user").toLowerCase() };
    bootApp();
  } catch (e) {
    console.error("Error recreating PIN session:", e);
    sessionStorage.removeItem(PIN_SESSION_KEY);
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
      if (sessionStorage.getItem(PIN_SESSION_KEY) !== uid) {
        try { sessionStorage.removeItem(PIN_SESSION_KEY); } catch {}
      }
      await logLoginOnce();
      bootApp();
    } catch(e) { showErr("Error al cargar tu perfil: " + e.message); }
  } else {
    await restorePinSession();
  }
});

// ── LOGIN SWITCH ───────────────────────────────────────────────
window.switchLogin = (type) => {
  document.getElementById("form-pin").style.display = type === "pin" ? "block" : "none";
  document.getElementById("login-err").style.display = "none";
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

    const qSnap = await getDocs(query(
      collection(db, "publicLoginUsers"),
      where("nameLower", "==", normName),
      limit(1)
    ));

    if (qSnap.empty) {
      rlFail("pin");
      showErr("Nombre o PIN incorrecto.");
      btn.disabled = false;
      btn.textContent = "Entrar";
      return;
    }

    const d = qSnap.docs[0];
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
    let profile = loginData;
    try {
      const profileSnap = await getDoc(doc(db, "users", uid));
      if (profileSnap.exists()) profile = profileSnap.data();
    } catch (e) {
      console.warn('Could not read users/{uid}, using public login data as profile', e && e.message);
    }
    currentUser = { uid, ...profile, role: String(profile.role || loginData.role || "user").toLowerCase() };

    if (!profileSnap.exists() && (!loginData.pinHash || !loginData.pinSalt)) {
      await updateDoc(d.ref, {
        pinHash: pinHash || await pinHashFromText(pin, pinSalt || ""),
        pinSalt: pinSalt || "",
        nameLower: normName
      });
    }

    sessionStorage.setItem(PIN_SESSION_KEY, uid);
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
document.getElementById("pin-code").addEventListener("keydown", e => { if(e.key==="Enter") window.loginWithPin(); });

// ── LOGOUT ─────────────────────────────────────────────────────
window.doLogout = async () => {
  try {
    sessionStorage.removeItem(PIN_SESSION_KEY);
  } catch {}

  if (auth.currentUser) {
    await signOut(auth);
  }

  currentUser = null; allMembers = []; novedades = [];
  showLoginScreen();
  ["pin-name","pin-code"].forEach(id => { document.getElementById(id).value = ""; });
};

// ── BOOT ───────────────────────────────────────────────────────
async function bootApp() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("app").style.display = "block";

  const name = currentUser.name || "—";
  const role = currentUser.role || "user";

  document.getElementById("uc-name").textContent   = name;
  document.getElementById("uc-role").textContent   = roleName(role);
  document.getElementById("uc-avatar").textContent = name.charAt(0).toUpperCase();
  document.getElementById("uc-avatar").className   = "uc-avatar av-" + role;
  const ucPts = document.getElementById("uc-pts");
  const pts = Number(currentUser.points || 0);
  ucPts.style.display = "block";
  ucPts.textContent = `⭐ ${pts.toFixed(1)} puntos`;

  await loadNovedades();
  await loadMembers();

  setupStaffView();
  setupLogsTab();
}

function setupLogsTab() {
  const btn = document.getElementById("logs-tab-btn");
  const th  = document.getElementById("logs-actions-th-jow");
  const exp = document.getElementById("logs-export-btn");

  const role = currentUser?.role;
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
window.toggleInspectorPanelJow = () => {
  const el = document.getElementById("insp-panel-jow");
  if (!el) return;
  el.style.display = el.style.display === "none" ? "block" : "none";
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
    renderInspectorActivityJow();
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
function setupUserView() {
  document.getElementById("stats-section").style.display = "none";
  document.getElementById("tabs-nav").style.display      = "none";
  document.querySelectorAll(".tab-content").forEach(el => { el.style.display="none"; el.classList.remove("active"); });

  const uv = document.getElementById("user-view");
  uv.style.display = "block";
  uv.classList.add("active");

  const pts = currentUser.points || 0;
  document.getElementById("my-pts-value").textContent = pts.toFixed(1);
  document.getElementById("my-pts-bar").style.width   = `${Math.min((pts/MAX_PTS)*100,100)}%`;
  document.getElementById("my-pts-bar").className     = "upc-bar " + ptBarClass(pts);
  document.getElementById("my-pts-state").innerHTML   = ptStateFull(pts);

  const ucPts = document.getElementById("uc-pts");
  ucPts.style.display = "block";
  ucPts.textContent   = `⭐ ${pts.toFixed(1)} puntos`;
}

// ══════════════════════════════════════════
// VISTA STAFF
// ══════════════════════════════════════════
function setupStaffView() {
  document.getElementById("stats-section").style.display = "";
  document.getElementById("tabs-nav").style.display      = "";

  // Activar primera pestaña
  document.querySelectorAll(".tab-content").forEach(el => { el.style.display="none"; el.classList.remove("active"); });
  document.getElementById("points-tab").style.display = "block";
  document.getElementById("points-tab").classList.add("active");
  document.querySelector(".tab").classList.add("active");

  renderStats();
  renderPointsTable();
  renderStaffTable();
  renderNovedades();
}

// ── STATS ──────────────────────────────────────────────────────
function renderStats() {
  // Stats solo sobre no-admins (los que tienen puntos relevantes)
  const staff = allMembers.filter(u => u.role !== "admin");
  const total  = staff.length;
  const pts    = staff.reduce((s,u) => s+(u.points||0), 0);
  document.getElementById("total-members").textContent = total;
  document.getElementById("avg-points").textContent    = total ? (pts/total).toFixed(1) : "0";
  document.getElementById("staff-at-risk").textContent = staff.filter(u => (u.points||0) <= 2).length;
  document.getElementById("staff-optimal").textContent = staff.filter(u => (u.points||0) >= 6).length;
  document.getElementById("total-points").textContent  = pts.toFixed(0);
}

// ── TABLA PUNTOS (sin admins) ──────────────────────────────────
function renderPointsTable() {
  const tb      = document.getElementById("pts-full-body");
  const role    = currentUser?.role;
  const canEdit = role === "admin" || role === "inspector";

  // Filtrar: nunca mostrar admins en la tabla de puntos
  const list = allMembers
    .filter(u => u.role !== "admin" && u.status !== "inactive")
    .sort((a,b) => (b.points||0)-(a.points||0));

  // Header dinámico
  const thRow = document.getElementById("pts-thead-row");
  if (thRow) {
    thRow.innerHTML = canEdit
      ? "<th>#</th><th>Nombre</th><th>Puntos</th><th>Estado</th><th>Ajustar</th>"
      : "<th>#</th><th>Nombre</th><th>Puntos</th><th>Estado</th>";
  }

  if (!list.length) {
    tb.innerHTML = `<tr><td colspan="${canEdit?5:4}" class="t-empty">Sin miembros aún.</td></tr>`;
    return;
  }

  tb.innerHTML = list.map((u, i) => {
    const pts    = u.points || 0;
    const isMe   = u.uid === currentUser.uid;
    const adjust = canEdit ? `
      <td>
        <div class="adj-btns">
          <button class="adj-btn minus" onclick="adjPoints('${u.uid}',-1)" ${isMe ? 'disabled style="opacity:0.5;cursor:not-allowed"' : ''}>−</button>
          <span class="adj-val" id="av-${u.uid}">${pts.toFixed(1)}</span>
          <button class="adj-btn plus" onclick="adjPoints('${u.uid}',+1)" ${isMe ? 'disabled style="opacity:0.5;cursor:not-allowed"' : ''}>+</button>
        </div>
      </td>` : "";
    return `
      <tr ${isMe ? 'class="my-row"' : ""}>
        <td class="rank-col">${i+1}</td>
        <td>
          <span class="member-av av-${u.role}">${(u.name||"?").charAt(0).toUpperCase()}</span>
          <b>${esc(u.name||"—")}</b>
          ${isMe ? '<span class="you-tag">tú</span>' : ""}
        </td>
        <td>
          <span class="pts-number" id="pn-${u.uid}" style="color:${ptColor(pts)}">${pts.toFixed(1)}</span>
          <div class="pts-mini-bar-wrap">
            <div class="pts-mini-bar ${ptBarClass(pts)}" id="pb-${u.uid}" style="width:${Math.min((pts/MAX_PTS)*100,100)}%"></div>
          </div>
        </td>
        <td id="ps-${u.uid}">${ptStateBadge(pts)}</td>
        ${adjust}
      </tr>`;
  }).join("");
}

// ── AJUSTAR PUNTOS ─────────────────────────────────────────────
window.adjPoints = async (uid, delta) => {
  const role = currentUser?.role;
  if (role !== "admin" && role !== "inspector") return;
  
  if (uid === currentUser.uid) {
    showToast("No podés modificar tus propios puntos!", "err");
    return;
  }

  const member = allMembers.find(u => u.uid === uid);
  if (!member) return;

  if (role === "inspector") {
    const cd = checkInspectorCooldown(uid);
    if (!cd.ok) {
      showToast(`Cooldown activo. Podés volver a puntuar a esta persona en ${fmtSince(cd.waitMs)}.`, "err");
      return;
    }
  }

  const reasonRaw = prompt("Motivo del cambio de puntos:", "");
  if (reasonRaw === null && role !== "admin") return;
  const reason = (reasonRaw || "").trim() || "Sin motivo";

  const oldVal = member.points || 0;
  const newVal = Math.round(Math.min(MAX_PTS, Math.max(0, oldVal + delta)) * 10) / 10;
  if (newVal === oldVal) return;

  member.points = newVal;
  updatePointCells(uid, newVal);

  try {
    await updateDoc(doc(db, "users", uid), { points: newVal });
    const accion = delta > 0 ? `sumó ${delta} punto(s)` : `restó ${Math.abs(delta)} punto(s)`;
    showToast(`${delta>0?"➕":"➖"} ${Math.abs(delta)} pt a ${member.name||"usuario"}`, "ok");
    // Registrar en novedades
    const nText = delta > 0
      ? `✅ Buen desempeño: ${member.name || "Un usuario"} recibió +${delta} punto(s). Motivo: ${reason}. Ahora tiene ${newVal} pts.`
      : `⚠️ Ajuste de puntos: ${member.name || "Un usuario"} recibió -${Math.abs(delta)} punto(s). Motivo: ${reason}. Ahora tiene ${newVal} pts.`;
    await logNovedad(nText);
    await writeLog({
      type: "points",
      actorUid: currentUser.uid,
      actorRole: role,
      actorName: currentUser.name || "",
      targetUid: uid,
      targetName: member.name || "",
      delta,
      reason,
      newPoints: newVal
    });
    if (role === "inspector") writeCooldown(currentUser.uid, uid, Date.now());
    renderStats();
  } catch(e) {
    member.points = oldVal;
    updatePointCells(uid, oldVal);
    showToast("Error al guardar: " + e.message, "err");
  }
};

function updatePointCells(uid, pts) {
  const pn = document.getElementById("pn-" + uid);
  const pb = document.getElementById("pb-" + uid);
  const ps = document.getElementById("ps-" + uid);
  const av = document.getElementById("av-" + uid);
  if (pn) { pn.textContent = pts.toFixed(1); pn.style.color = ptColor(pts); }
  if (pb) { pb.style.width = `${Math.min((pts/MAX_PTS)*100,100)}%`; pb.className = `pts-mini-bar ${ptBarClass(pts)}`; }
  if (ps) ps.innerHTML = ptStateBadge(pts);
  if (av) av.textContent = pts.toFixed(1);
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
    const rango = u.rango || "—";

    return `
      <tr>
        <td><b>${esc(u.name||"—")}</b></td>
        <td><span class="rango-tag">${esc(rango)}</span></td>
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
  document.querySelectorAll(".tab-content").forEach(s => { s.classList.remove("active"); s.style.display="none"; });
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.getElementById(id).style.display = "block";
  document.getElementById(id).classList.add("active");
  btn.classList.add("active");
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


import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  createUserWithEmailAndPassword, updateProfile
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import {
  getFirestore, collection, doc, setDoc, getDoc, getDocs,
  updateDoc, deleteDoc, serverTimestamp, query, orderBy, addDoc, onSnapshot, limit
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const cfg = {
  apiKey:"AIzaSyAIqxYEo-flmj1KKz3f0x1CnKG8KoUMBrM",
  authDomain:"jowiland-2.firebaseapp.com",
  projectId:"jowiland-2",
  storageBucket:"jowiland-2.firebasestorage.app",
  messagingSenderId:"301719973403",
  appId:"1:301719973403:web:827b9a8df3e17ad74992be"
};

// Reutilizar app si ya existe
const app  = getApps().length ? getApp() : initializeApp(cfg, "main");
const auth = getAuth(app);
const db   = getFirestore(app);

// â”€â”€ ESTADO GLOBAL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let allUsers     = [];
let myRole       = null;
let myUid        = null;
let myName       = null;
let editUid      = null;
let filterText   = "";
let filterRoleV  = "";
let filterPText  = "";
let currentConfig = { hours: 24, minutes: 0 }; // Valor por defecto
let pointDecrementTimer = null;
let pointDecrementBusy = false;
let logs         = [];
let logsUnsub    = null;
let logTypeFilter = "";
let logSearch     = "";

const RL_OPTS = { windowMs: 5 * 60 * 1000, maxAttempts: 6, lockMs: 10 * 60 * 1000 };
const RL_PREFIX = "jowiland-admin:rl:";
const PTS_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const PTS_COOLDOWN_PREFIX = "jowiland:ptcd:";
const MAX_NOVEDADES = 20;

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

// â”€â”€ AUTH â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
onAuthStateChanged(auth, async user => {
  if (!user) { showLogin(); return; }

  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (!snap.exists()) {
      showToast("Tu cuenta no tiene perfil en el sistema.", "err");
      await signOut(auth); return;
    }
    const d = snap.data();
    if (d.role !== "admin" && d.role !== "inspector") {
      showToast("Acceso denegado: solo admins e inspectores.", "err");
      await signOut(auth); return;
    }
    if (d.status === "inactive") {
      showToast("Tu cuenta estÃ¡ inactiva.", "err");
      await signOut(auth); return;
    }
    myRole = d.role;
    myUid  = user.uid;
    await bootApp(user, d);
  } catch(e) {
    showToast("Error al verificar sesiÃ³n: " + e.message, "err");
  }
});

window.doLogin = async () => {
  const email = document.getElementById("l-email").value.trim().toLowerCase();
  const pass  = document.getElementById("l-pass").value;
  const btn   = document.getElementById("l-btn");
  const err   = document.getElementById("login-err");
  err.style.display = "none";
  if (!email || !pass) { err.textContent="CompletÃ¡ los dos campos."; err.style.display="block"; return; }
  const chk = rlCheck("email");
  if (!chk.ok) { err.textContent = `Demasiados intentos. EsperÃ¡ ${fmtWait(chk.waitMs)} y probÃ¡ de nuevo.`; err.style.display="block"; return; }
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> Ingresandoâ€¦';
  try {
    await signInWithEmailAndPassword(auth, email, pass);
    rlReset("email");
  } catch(e) {
    const extra = e.code === "auth/too-many-requests" ? 10 * 60 * 1000 : 0;
    const fail = rlFail("email", extra);
    err.textContent = fail.locked
      ? `Demasiados intentos. EsperÃ¡ ${fmtWait(fail.waitMs)} y probÃ¡ de nuevo.`
      : friendlyErr(e.code);
    err.style.display = "block";
    btn.disabled = false;
    btn.textContent = "Ingresar al panel";
  }
};

document.getElementById("l-pass").addEventListener("keydown", e => { if(e.key==="Enter") window.doLogin(); });
window.doLogout = () => signOut(auth);

window.toggleSidebar = () => {
  const sb = document.getElementById("sidebar");
  const ov = document.getElementById("sb-overlay");
  if (!sb || !ov) return;
  const isOpen = sb.classList.toggle("open");
  ov.classList.toggle("open", isOpen);
};

function closeSidebarIfMobile() {
  if (window.innerWidth <= 680) {
    const sb = document.getElementById("sidebar");
    const ov = document.getElementById("sb-overlay");
    if (sb) sb.classList.remove("open");
    if (ov) ov.classList.remove("open");
  }
}

// â”€â”€ BOOT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function bootApp(user, data) {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("app").style.display = "block";

  const name = data.name || user.email;
  myName = name;
  document.getElementById("sb-name").textContent = name;
  document.getElementById("sb-role").textContent = data.role;
  document.getElementById("sb-role").className = "srole role-" + data.role;
  const av = document.getElementById("sb-av");
  av.textContent = name.charAt(0).toUpperCase();
  av.className = "avatar av-" + data.role;

  // Mostrar elementos solo para admin
  if (myRole === "admin") {
    document.getElementById("nav-crear").style.display = "flex";
    document.getElementById("ph-crear-btn").innerHTML =
      '<button class="btn btn-primary btn-auto" onclick="openCreate()">âž• Crear cuenta</button>';
  } else {
    document.getElementById("nav-config").style.display = "none";
    // Inspector: ocultar columna acciones
    document.getElementById("th-acciones").style.display = "none";
    document.getElementById("st-insp-card").style.display = "none";
    document.getElementById("st-users-card").style.display = "none";
  }

  if (myRole === "admin") {
    await loadConfig();
    document.getElementById("config-hours").addEventListener("input", updateConfigSummary);
    document.getElementById("config-minutes").addEventListener("input", updateConfigSummary);
    document.getElementById("config-save").addEventListener("click", window.saveConfig);
  } else {
    const btn = document.getElementById("config-save");
    if (btn) btn.disabled = true;
  }

  await startLogsLive();
  await logLoginOnce();
  
  await loadUsers();
  if (myRole === "admin") startPointDecrementScheduler();
}

function showLogin() {
  document.getElementById("login-screen").style.display = "flex";
  document.getElementById("app").style.display = "none";
}

// â”€â”€ CONFIGURACIÃ“N DE DECREMENTO DE PUNTOS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loadConfig() {
  try {
    console.log("Loading config...");
    const snap = await getDoc(doc(db, "settings", "pointDecrement"));
    if (snap.exists()) {
      currentConfig = snap.data();
      console.log("Loaded config from Firestore:", currentConfig);
    }
    // Cargar valores en los inputs
    const h0 = Number(currentConfig?.hours);
    const m0 = Number(currentConfig?.minutes);
    document.getElementById("config-hours").value = Number.isFinite(h0) ? h0 : 24;
    document.getElementById("config-minutes").value = Number.isFinite(m0) ? m0 : 0;
    updateConfigSummary();
    console.log("Set inputs to:", currentConfig.hours, "hours,", currentConfig.minutes, "minutes");
  } catch (e) {
    console.error("Error loading config:", e);
  }
}

function updateConfigSummary() {
  const hours = parseInt(document.getElementById("config-hours").value) || 0;
  const minutes = parseInt(document.getElementById("config-minutes").value) || 0;
  const totalMinutes = hours * 60 + minutes;
  const intervalMinutes = totalMinutes / 10; // Dividimos 1 punto en 10 partes de 0.1
  
  // Convertir intervalMinutes a horas y minutos para mostrar
  const intervalHours = Math.floor(intervalMinutes / 60);
  const intervalMins = Math.round(intervalMinutes % 60);
  
  document.getElementById("config-summary").innerHTML = 
    `Cada <strong>${hours}h ${minutes}m</strong> se restarÃ¡ <strong>1 punto</strong> (0.1 puntos cada <strong>${intervalHours}h ${intervalMins}m</strong>)`;
}

window.saveConfig = async (e) => {
  if (e && e.preventDefault) e.preventDefault();
  if (myRole !== "admin") {
    showToast("Solo un admin puede guardar esta configuraciÃ³n.", "err");
    return;
  }
  const hours = Math.max(0, parseInt(document.getElementById("config-hours").value, 10) || 0);
  const minutes = Math.min(59, Math.max(0, parseInt(document.getElementById("config-minutes").value, 10) || 0));
  
  if (hours === 0 && minutes === 0) {
    showToast("IngresÃ¡ un tiempo vÃ¡lido!", "err");
    return;
  }

  const configRef = doc(db, "settings", "pointDecrement");
  const totalMinutes = (hours * 60) + minutes;
  currentConfig = {
    hours,
    minutes,
    totalMinutes,
    stepMinutes: totalMinutes / 10,
    updatedAt: serverTimestamp(),
    updatedBy: myUid
  };
  try {
    console.log("Saving config:", currentConfig);
    await setDoc(configRef, currentConfig, { merge: true });
    const confirmSnap = await getDoc(configRef);
    if (confirmSnap.exists()) currentConfig = { ...confirmSnap.data() };
    document.getElementById("config-hours").value = String(hours);
    document.getElementById("config-minutes").value = String(minutes);
    updateConfigSummary();
    console.log("Config saved successfully");
    showToast(`âœ… ConfiguraciÃ³n guardada: ${hours}h ${minutes}m`, "ok");
    startPointDecrementScheduler();
  } catch (e) {
    console.error("Error saving config:", e);
    showToast("Error al guardar: " + e.message, "err");
  }
}

function cfgToMs(cfg) {
  const h = parseInt(cfg?.hours, 10) || 0;
  const m = parseInt(cfg?.minutes, 10) || 0;
  return (h * 60 + m) * 60 * 1000;
}

function fmtPts(p) {
  const n = Number(p || 0);
  if (!Number.isFinite(n)) return "0";
  const r = Math.round(n * 10) / 10;
  return r % 1 === 0 ? String(r.toFixed(0)) : r.toFixed(1);
}

function stopPointDecrementScheduler() {
  if (pointDecrementTimer) {
    clearInterval(pointDecrementTimer);
    pointDecrementTimer = null;
  }
}

function startPointDecrementScheduler() {
  if (myRole !== "admin") return;
  stopPointDecrementScheduler();
  pointDecrementTimer = setInterval(applyPointDecrementTick, 60 * 1000);
  applyPointDecrementTick();
}

async function applyPointDecrementTick() {
  if (myRole !== "admin") return;
  if (pointDecrementBusy) return;
  pointDecrementBusy = true;
  try {
    const snap = await getDoc(doc(db, "settings", "pointDecrement"));
    if (!snap.exists()) return;
    const cfg = snap.data() || {};

    const totalMs = cfgToMs(cfg);
    if (!totalMs) return;
    const stepMs = Math.floor(totalMs / 10);
    if (!stepMs) return;

    const now = Date.now();
    const last = typeof cfg.lastAppliedClientTs === "number" ? cfg.lastAppliedClientTs : 0;
    if (!last) {
      await setDoc(doc(db, "settings", "pointDecrement"), { lastAppliedClientTs: now, lastAppliedBy: myUid }, { merge: true });
      return;
    }

    let steps = Math.floor((now - last) / stepMs);
    if (steps <= 0) return;
    if (steps > 200) steps = 200;

    const dec = steps * 0.1;
    let changed = 0;
    const usersSnap = await getDocs(collection(db, "users"));
    allUsers = usersSnap.docs.map(d => ({ uid: d.id, ...d.data() }));
    for (const u of allUsers) {
      if (!u || u.role === "admin") continue;
      const oldP = Number(u.points || 0);
      if (!Number.isFinite(oldP)) continue;
      const newP = Math.max(0, Math.round((oldP - dec) * 10) / 10);
      if (newP === oldP) continue;
      try {
        await updateDoc(doc(db, "users", u.uid), { points: newP });
        u.points = newP;
        changed++;
      } catch {}
    }

    const newLast = last + (steps * stepMs);
    await setDoc(doc(db, "settings", "pointDecrement"), { lastAppliedClientTs: newLast, lastAppliedBy: myUid }, { merge: true });
    if (changed) renderAll();
  } catch (e) {
    console.error("Error aplicando decremento:", e);
  } finally {
    pointDecrementBusy = false;
  }
}

// â”€â”€ PÃGINAS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
window.goPage = id => {
  if (id === "config" && myRole !== "admin") {
    showToast("Solo un admin puede entrar a Configurar Puntos.", "err");
    id = "dashboard";
  }
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  document.getElementById("page-" + id).classList.add("active");
  const ni = document.querySelector(`.nav-item[onclick="goPage('${id}')"]`);
  if (ni) ni.classList.add("active");
  closeSidebarIfMobile();
};

window.setLogTypeFilter = v => { logTypeFilter = v; renderLogs(); };
window.setLogSearch = v => { logSearch = (v || "").toLowerCase(); renderLogs(); };
window.toggleInspectorPanel = () => {
  const el = document.getElementById("insp-panel");
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
  const actorUid = myUid;
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

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function prettyRole(r) {
  const m = { admin: "Admin", inspector: "Inspector", user: "Usuario" };
  return m[r] || r || "â€”";
}

function fmtCargos(cargos) {
  if (!cargos) return "â€”";
  if (Array.isArray(cargos)) return cargos.length ? cargos.join(", ") : "â€”";
  return String(cargos);
}

function buildPointsNovedad(targetName, delta, newVal, reason) {
  const name = targetName || "Un usuario";
  const abs = Math.abs(delta);
  const absStr = fmtPts(abs);
  const isUp = delta > 0;
  const main = isUp
    ? pick([
        `âœ… Buen desempeÃ±o: ${name} sumÃ³ +${absStr} punto(s).`,
        `âœ… ${name} fue reconocido: +${absStr} punto(s).`,
        `âœ… Â¡Buen trabajo, ${name}! +${absStr} punto(s).`
      ])
    : pick([
        `âš ï¸ Ajuste de puntos: ${name} recibiÃ³ -${absStr} punto(s).`,
        `âš ï¸ ${name} tuvo un ajuste: -${absStr} punto(s).`,
        `âš ï¸ Se registrÃ³ un descuento para ${name}: -${absStr} punto(s).`
      ]);

  const estado = newVal <= 2
    ? " QuedÃ³ en estado: En riesgo."
    : newVal >= 6
      ? " QuedÃ³ en estado: Ã“ptimo."
      : "";

  return `${main} Motivo: ${reason}. Total: ${fmtPts(newVal)} pts.${estado}`;
}

function buildUserCreatedNovedad(name, role, rango, cargos) {
  const who = name || "Nuevo usuario";
  const main = pick([
    `âœ¨ Nuevo ingreso: ${who} se uniÃ³ al equipo.`,
    `âœ¨ Se registrÃ³ un nuevo integrante: ${who}.`,
    `âœ¨ Bienvenido/a: ${who}.`
  ]);
  return `${main} Rol: ${prettyRole(role)} Â· Rango: ${rango || "â€”"} Â· Cargos: ${fmtCargos(cargos)}.`;
}

function buildUserUpdatedNovedad(prev, next) {
  const who = next?.name || prev?.name || "Un usuario";
  const parts = [];
  if ((prev?.role || "") !== (next?.role || "")) parts.push(`Rol: ${prettyRole(prev?.role)} â†’ ${prettyRole(next?.role)}`);
  if ((prev?.rango || "") !== (next?.rango || "")) parts.push(`Rango: ${prev?.rango || "â€”"} â†’ ${next?.rango || "â€”"}`);
  const pc = fmtCargos(prev?.cargos);
  const nc = fmtCargos(next?.cargos);
  if (pc !== nc) parts.push(`Cargos: ${pc} â†’ ${nc}`);
  if ((prev?.status || "") !== (next?.status || "")) parts.push(`Estado: ${prev?.status || "â€”"} â†’ ${next?.status || "â€”"}`);
  if (!parts.length) return null;
  return `ðŸ”„ ActualizaciÃ³n de perfil: ${who}. ${parts.join(" Â· ")}.`;
}

async function logNovedad(texto) {
  try {
    await addDoc(collection(db, "novedades"), {
      texto,
      fecha: serverTimestamp(),
      autor: myName || "Sistema"
    });
    await cleanupNovedadesIfAdmin();
  } catch(e) {
    console.error("Error al registrar novedad:", e);
  }
}

async function cleanupNovedadesIfAdmin() {
  if (myRole !== "admin" && myRole !== "inspector") return;
  try {
    const snap = await getDocs(query(collection(db, "novedades"), orderBy("fecha", "desc"), limit(60)));
    if (snap.size <= MAX_NOVEDADES) return;
    const extra = snap.docs.slice(MAX_NOVEDADES);
    for (const d of extra) {
      await deleteDoc(doc(db, "novedades", d.id));
    }
  } catch(e) {
    console.error("Error limpiando novedades:", e);
  }
}

async function logLoginOnce() {
  if (!myUid || !myRole) return;
  const k = `jowiland:loginLogged:${myUid}`;
  try {
    if (sessionStorage.getItem(k)) return;
    sessionStorage.setItem(k, "1");
  } catch {}
  await writeLog({
    type: "login",
    actorUid: myUid,
    actorRole: myRole,
    actorName: myName || ""
  });
}

async function startLogsLive() {
  if (logsUnsub) { try { logsUnsub(); } catch {} logsUnsub = null; }
  const q = query(collection(db, "logs"), orderBy("createdAt", "desc"), limit(300));
  logsUnsub = onSnapshot(q, snap => {
    logs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderLogs();
    renderInspectorActivity();
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

function renderLogs() {
  const tb = document.getElementById("logs-tbody");
  if (!tb) return;
  const isAdmin = myRole === "admin";
  const th = document.getElementById("logs-th-actions");
  if (th) th.style.display = isAdmin ? "" : "none";
  const exp = document.getElementById("logs-export");
  if (exp) exp.style.display = isAdmin ? "" : "none";

  const list = filteredLogs();
  if (!list.length) {
    tb.innerHTML = `<tr><td colspan="${isAdmin ? 6 : 5}" class="empty">Sin registros.</td></tr>`;
    return;
  }
  tb.innerHTML = list.map(l => {
    const isPoints = l.type === "points";
    const dt = fmtDateTime(l.createdAt);
    const actor = esc(l.actorName || "â€”");
    const target = esc(l.targetName || (l.type === "login" ? (l.actorName || "â€”") : "â€”"));
    const delta = isPoints ? (typeof l.delta === "number" ? l.delta : 0) : null;
    const deltaTxt = isPoints ? `${delta > 0 ? "+" : ""}${delta}` : "â€”";
    const motivo = esc(l.reason || (l.type === "login" ? "Inicio de sesiÃ³n" : "Sin motivo"));
    const delBtn = isAdmin ? `<button class="btn btn-danger btn-sm" onclick="deleteLog('${l.id}')">ðŸ—‘ï¸</button>` : "";
    return `
      <tr>
        <td>${dt}</td>
        <td>${actor}</td>
        <td>${target}</td>
        <td><b style="color:${delta > 0 ? "var(--success)" : delta < 0 ? "var(--danger)" : "var(--muted)"}">${deltaTxt}</b></td>
        <td>${motivo}</td>
        ${isAdmin ? `<td>${delBtn}</td>` : ""}
      </tr>`;
  }).join("");
}

window.deleteLog = async (id) => {
  if (myRole !== "admin") return;
  const ok = confirm("Â¿Borrar este registro? No se puede deshacer.");
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "logs", id));
    showToast("Registro borrado.", "ok");
  } catch(e) {
    showToast("Error al borrar: " + e.message, "err");
  }
};

window.exportLogs = () => {
  if (myRole !== "admin") return;
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

function renderInspectorActivity() {
  const tb = document.getElementById("insp-tbody");
  if (!tb) return;
  const today = dayKey(new Date());
  const todays = logs.filter(l => l.type === "points" && l.dayKey === today && l.actorRole === "inspector");
  if (!todays.length) {
    tb.innerHTML = '<tr><td colspan="6" class="empty">Sin actividad hoy.</td></tr>';
    return;
  }

  const mp = new Map();
  for (const l of todays) {
    const uid = l.actorUid || "â€”";
    const prev = mp.get(uid) || {
      uid,
      name: l.actorName || "â€”",
      pts: 0,
      actions: 0,
      lastAt: null,
      lastTxt: "â€”"
    };
    const delta = typeof l.delta === "number" ? l.delta : 0;
    if (delta > 0) prev.pts += delta;
    prev.actions += 1;
    const d = tsToDate(l.createdAt);
    if (d && (!prev.lastAt || d > prev.lastAt)) {
      prev.lastAt = d;
      const tgt = l.targetName ? ` â†’ ${l.targetName}` : "";
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
    const state = lastMs <= 15 * 60 * 1000 ? "ðŸŸ¢ Activo" : lastMs <= 60 * 60 * 1000 ? "ðŸŸ¡ Poco activo" : "ðŸ”´ Inactivo";
    return `
      <tr>
        <td><b>${esc(r.name)}</b></td>
        <td><b style="color:var(--warn)">${r.pts}</b></td>
        <td>${r.actions}</td>
        <td>${esc(r.lastTxt)}</td>
        <td>${r.lastAt ? fmtSince(lastMs) : "â€”"}</td>
        <td>${state}</td>
      </tr>`;
  }).join("");
}

// â”€â”€ CARGAR USUARIOS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loadUsers() {
  try {
    const q = query(collection(db, "users"), orderBy("createdAt", "desc"));
    const snap = await getDocs(q);
    allUsers = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
    renderAll();
  } catch(e) {
    console.error(e);
    showToast("Error al cargar: " + e.message, "err");
  }
}

function renderAll() {
  renderDash();
  renderUsersTable(filteredUsers());
  renderPointsTable(filteredPoints());
}

// â”€â”€ DASHBOARD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function renderDash() {
  document.getElementById("st-total").textContent = allUsers.length;
  document.getElementById("st-insp").textContent  = allUsers.filter(u => u.role==="inspector").length;
  document.getElementById("st-users").textContent = allUsers.filter(u => u.role==="user").length;
  document.getElementById("st-pts").textContent   = allUsers.reduce((s,u) => s+(u.points||0), 0);

  const top = [...allUsers].sort((a,b) => (b.points||0)-(a.points||0)).slice(0, 8);
  const tb = document.getElementById("dash-tbody");
  if (!top.length) { tb.innerHTML='<tr><td colspan="4" class="empty">Sin datos aÃºn.</td></tr>'; return; }
  tb.innerHTML = top.map((u,i) => `
    <tr>
      <td style="color:var(--muted);font-weight:700;width:30px">${i+1}</td>
      <td><b>${esc(u.name||"â€”")}</b></td>
      <td>${roleBadge(u.role)}</td>
      <td><b style="color:var(--warn);font-size:15px">${fmtPts(u.points)}</b></td>
    </tr>`).join("");
}

// â”€â”€ TABLA USUARIOS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function filteredUsers() {
  let list = allUsers;
  if (filterText) list = list.filter(u => (u.name||"").toLowerCase().includes(filterText)||(u.email||"").toLowerCase().includes(filterText));
  if (filterRoleV) list = list.filter(u => u.role === filterRoleV);
  return list;
}

window.filterU = v => { filterText = v.toLowerCase(); renderUsersTable(filteredUsers()); };
window.filterByRole = v => { filterRoleV = v; renderUsersTable(filteredUsers()); };

function renderUsersTable(list) {
  const tb = document.getElementById("users-tbody");
  if (!list.length) { tb.innerHTML='<tr><td colspan="8" class="empty">Sin resultados.</td></tr>'; return; }
  const isAdmin = myRole === "admin";
  tb.innerHTML = list.map(u => `
    <tr>
      <td><b>${esc(u.name||"â€”")}</b><br><span style="color:var(--muted);font-size:11px">${esc(u.email||"")}</span></td>
      <td>${roleBadge(u.role)}</td>
      <td>${u.pin ? `<code style="background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:13px;padding:3px 8px;letter-spacing:.1em">${u.pin}</code>` : '<span style="color:var(--muted)">â€”</span>'}</td>
      <td>${esc(u.rango||"â€”")}</td>
      <td>${(u.cargos||[]).map(c => `<span class="badge">${esc(c)}</span>`).join(" ") || '<span style="color:var(--muted)">â€”</span>'}</td>
      <td>${statusBadge(u.status)}</td>
      <td><b style="color:var(--warn)">${u.points||0}</b></td>
      <td>${isAdmin ? `
        <div style="display:flex;gap:6px">
          <button class="btn btn-warn btn-sm" onclick="openEdit('${u.uid}')">âœï¸ Editar</button>
          <button class="btn btn-danger btn-sm" onclick="askDelete('${u.uid}','${esc(u.name||"")}')">ðŸ—‘ï¸</button>
        </div>` : '<span style="color:var(--muted)">â€”</span>'}</td>
    </tr>`).join("");
}

// â”€â”€ TABLA PUNTOS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function filteredPoints() {
  let list = allUsers.filter(u => u.role !== "admin" && u.status !== "inactive");
  if (filterPText) list = list.filter(u => (u.name||"").toLowerCase().includes(filterPText));
  return list;
}

window.filterP = v => { filterPText = v.toLowerCase(); renderPointsTable(filteredPoints()); };

function renderPointsTable(list) {
  const tb = document.getElementById("pts-tbody");
  if (!list.length) { tb.innerHTML='<tr><td colspan="4" class="empty">Sin moderadores.</td></tr>'; return; }
  tb.innerHTML = list.map(u => {
    const isSelf = u.uid === myUid;
    return `
    <tr>
      <td><b>${esc(u.name||"â€”")}</b></td>
      <td>${roleBadge(u.role)}</td>
      <td><span class="pts-val" id="pv-${u.uid}">${fmtPts(u.points)}</span></td>
      <td>
        <div class="pts-row">
          <button class="pbtn minus" onclick="adjPts('${u.uid}',-1)" ${isSelf ? 'disabled style="opacity:0.5;cursor:not-allowed"' : ''}>âˆ’</button>
          <button class="pbtn plus"  onclick="adjPts('${u.uid}',+1)" ${isSelf ? 'disabled style="opacity:0.5;cursor:not-allowed"' : ''}>+</button>
          <button class="btn btn-ghost btn-sm" onclick="promptPts('${u.uid}')" ${isSelf ? 'disabled style="opacity:0.5;cursor:not-allowed"' : ''}>Â± Ingresar</button>
        </div>
      </td>
    </tr>`;
  }).join("");
}

// â”€â”€ PUNTOS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
window.adjPts = async (uid, delta) => {
  if (uid === myUid) {
    showToast("No podÃ©s modificar tus propios puntos!", "err");
    return;
  }
  const u = allUsers.find(x => x.uid===uid);
  if (!u) return;
  if (myRole === "inspector") {
    const cd = checkInspectorCooldown(uid);
    if (!cd.ok) {
      showToast(`Cooldown activo. PodÃ©s volver a puntuar a esta persona en ${fmtSince(cd.waitMs)}.`, "err");
      return;
    }
  }
  const reasonRaw = prompt("Motivo del cambio de puntos:", "");
  if (reasonRaw === null && myRole !== "admin") return;
  const reason = (reasonRaw || "").trim() || "Sin motivo";
  const nv = Math.max(0, (u.points||0) + delta);
  try {
    await updateDoc(doc(db,"users",uid), { points: nv });
    u.points = nv;
    const el = document.getElementById("pv-"+uid);
    if (el) el.textContent = fmtPts(nv);
    renderDash();
    showToast((delta>0?"âž•":"âž–") + " " + Math.abs(delta) + " pt a " + (u.name||"usuario"), "ok");
    const nText = buildPointsNovedad(u.name || "Un usuario", delta, nv, reason);
    await logNovedad(nText);
    await writeLog({
      type: "points",
      actorUid: myUid,
      actorRole: myRole,
      actorName: myName || "",
      targetUid: uid,
      targetName: u.name || "",
      delta,
      reason,
      newPoints: nv
    });
    if (myRole === "inspector") writeCooldown(myUid, uid, Date.now());
  } catch(e) { showToast("Error: "+e.message,"err"); }
};

window.promptPts = uid => {
  if (uid === myUid) {
    showToast("No podÃ©s modificar tus propios puntos!", "err");
    return;
  }
  const u = allUsers.find(x => x.uid===uid);
  if (!u) return;
  const raw = prompt(`Ajustar puntos de ${u.name||"usuario"} (actual: ${fmtPts(u.points)})\n\nEscribÃ­ positivo para sumar o negativo para restar.\nEj: 5, 0.5, -3 o -1.5`);
  if (raw===null) return;
  const n = Number(raw);
  if (!Number.isFinite(n)) return showToast("NÃºmero invÃ¡lido.","err");
  const reasonRaw = prompt("Motivo del cambio de puntos:", "");
  if (reasonRaw === null && myRole !== "admin") return;
  const reason = (reasonRaw || "").trim() || "Sin motivo";
  adjPtsWithReason(uid, n, reason);
};

async function adjPtsWithReason(uid, delta, reason) {
  if (uid === myUid) {
    showToast("No podÃ©s modificar tus propios puntos!", "err");
    return;
  }
  const u = allUsers.find(x => x.uid===uid);
  if (!u) return;
  if (myRole === "inspector") {
    const cd = checkInspectorCooldown(uid);
    if (!cd.ok) {
      showToast(`Cooldown activo. PodÃ©s volver a puntuar a esta persona en ${fmtSince(cd.waitMs)}.`, "err");
      return;
    }
  }
  const nv = Math.max(0, (u.points||0) + delta);
  try {
    await updateDoc(doc(db,"users",uid), { points: nv });
    u.points = nv;
    const el = document.getElementById("pv-"+uid);
    if (el) el.textContent = fmtPts(nv);
    renderDash();
    showToast((delta>0?"âž•":"âž–") + " " + Math.abs(delta) + " pt a " + (u.name||"usuario"), "ok");
    const nText = buildPointsNovedad(u.name || "Un usuario", delta, nv, reason);
    await logNovedad(nText);
    await writeLog({
      type: "points",
      actorUid: myUid,
      actorRole: myRole,
      actorName: myName || "",
      targetUid: uid,
      targetName: u.name || "",
      delta,
      reason,
      newPoints: nv
    });
    if (myRole === "inspector") writeCooldown(myUid, uid, Date.now());
  } catch(e) { showToast("Error: "+e.message,"err"); }
}

// â”€â”€ MODAL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
window.openCreate = () => {
  editUid = null;
  document.getElementById("modal-title").textContent = "Crear cuenta";
  const nameEl = document.getElementById("m-name");
  nameEl.value = "";
  nameEl.disabled = false;
  document.getElementById("m-email").value = "";
  document.getElementById("m-pass").value = "";
  document.getElementById("m-role").value = "user";
  document.getElementById("m-rango").value = "Centinela";
  // Limpiar checkboxes de cargos
  document.querySelectorAll(".cargo-checkbox").forEach(cb => cb.checked = false);
  document.getElementById("m-role").disabled = false;
  document.getElementById("m-status").value = "active";
  document.getElementById("m-save").textContent = "Crear cuenta";
  document.getElementById("modal-err").style.display = "none";
  document.getElementById("pass-field").style.display = "flex";
  showPinSection("user");
  const pr = document.getElementById("pin-regen-btn");
  if (pr) pr.disabled = false;
  document.getElementById("modal-ov").classList.add("open");
};

window.openEdit = uid => {
  const u = allUsers.find(x => x.uid===uid);
  if (!u) return;
  editUid = uid;
  document.getElementById("modal-title").textContent = "Editar cuenta";
  const nameEl = document.getElementById("m-name");
  nameEl.value   = u.name   || "";
  document.getElementById("m-email").value  = u.email  || "";
  document.getElementById("m-role").value   = u.role   || "user";
  document.getElementById("m-rango").value  = u.rango  || "Centinela";
  // Marcar checkboxes de cargos
  const userCargos = u.cargos || [];
  document.querySelectorAll(".cargo-checkbox").forEach(cb => {
    cb.checked = userCargos.includes(cb.value);
  });
  document.getElementById("m-role").disabled = false;
  document.getElementById("m-status").value = u.status || "active";
  document.getElementById("m-pass").value   = "";
  document.getElementById("m-save").textContent = "Guardar cambios";
  document.getElementById("modal-err").style.display = "none";
  // Al editar no mostramos campo contraseÃ±a
  document.getElementById("pass-field").style.display = "none";
  if (u.role==="user") {
    document.getElementById("pin-val").textContent = u.pin || genPin();
    document.getElementById("pin-section").style.display = "block";
    document.getElementById("email-section").style.display = "none";
    nameEl.disabled = true;
    const pr = document.getElementById("pin-regen-btn");
    if (pr) pr.disabled = false;
  } else {
    document.getElementById("pin-val").textContent = u.pin || genPin();
    document.getElementById("pin-section").style.display = "block";
    document.getElementById("email-section").style.display = "block";
    nameEl.disabled = false;
    const pr = document.getElementById("pin-regen-btn");
    if (pr) pr.disabled = false;
  }
  document.getElementById("modal-ov").classList.add("open");
};

window.onRoleChange = role => {
  showPinSection(role);
  if (!editUid) document.getElementById("pass-field").style.display = "flex";
};

function showPinSection(role) {
  document.getElementById("pin-section").style.display = "block";
  document.getElementById("pin-val").textContent = document.getElementById("pin-val").textContent || genPin();
  if (role === "user") {
    document.getElementById("email-section").style.display = "none";
  } else {
    document.getElementById("email-section").style.display = "block";
  }
  const pr = document.getElementById("pin-regen-btn");
  if (pr) pr.disabled = false;
}

window.regenPin = () => { document.getElementById("pin-val").textContent = genPin(); };
window.closeModal = () => document.getElementById("modal-ov").classList.remove("open");

function setModalErr(msg) {
  const el = document.getElementById("modal-err");
  el.textContent = msg;
  el.style.display = "block";
}

window.saveAccount = async () => {
  const name   = document.getElementById("m-name").value.trim();
  const email  = document.getElementById("m-email").value.trim();
  const pass   = document.getElementById("m-pass").value;
  const role   = document.getElementById("m-role").value;
  const rango  = document.getElementById("m-rango").value;
  const cargos = Array.from(document.querySelectorAll(".cargo-checkbox:checked")).map(cb => cb.value);
  const status = document.getElementById("m-status").value;
  const pin    = document.getElementById("pin-val").textContent.trim();
  const btn    = document.getElementById("m-save");

  document.getElementById("modal-err").style.display = "none";

  if (!name) return setModalErr("El nombre es obligatorio.");
  if (!pin || pin.length !== 4 || isNaN(pin)) return setModalErr("El PIN debe ser de 4 dÃ­gitos.");

  if (!editUid) {
    if ((role==="admin"||role==="inspector") && !email) return setModalErr("Inspector/Admin necesitan email.");
    if ((role==="admin"||role==="inspector") && pass.length<6) return setModalErr("La contraseÃ±a debe tener al menos 6 caracteres.");
  }

  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div>';

  try {
    if (editUid) {
      // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ EDITAR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      const prev = allUsers.find(u => u.uid === editUid) || null;
      const prevSnap = prev ? { ...prev, cargos: Array.isArray(prev.cargos) ? [...prev.cargos] : prev.cargos } : null;
      const upd = { name, role, rango, cargos, status, pin, nameLower: normLoginName(name) };
      if (role==="admin" || role==="inspector") upd.email = email || prev?.email || "";

      // Actualizar cuenta PIN sintÃ©tica (crear nueva si cambiÃ³ el nombre o el PIN)
      const pinUid = await ensurePinAuthAccount(name, pin, editUid);
      if (pinUid && pinUid !== editUid) {
        await setDoc(doc(db, "pinLogins", pinUid), { realUid: editUid });
      }

      await updateDoc(doc(db,"users",editUid), upd);
      const idx = allUsers.findIndex(u => u.uid===editUid);
      if (idx!==-1) allUsers[idx] = { ...allUsers[idx], ...upd };
      showToast("Cuenta actualizada. PIN nuevo listo.", "ok");
      const nText = buildUserUpdatedNovedad(prevSnap, { ...(prevSnap || {}), ...upd });
      if (nText) await logNovedad(nText);

    } else {
      // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ CREAR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      let uid;
      const data = { name, role, rango, cargos, status, pin, points: 0, createdAt: serverTimestamp(), createdBy: myUid, nameLower: normLoginName(name) };

      if (role==="admin" || role==="inspector") {
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        await updateProfile(cred.user, { displayName: name });
        uid = cred.user.uid;
        data.email = email;

        const pinUid = await ensurePinAuthAccount(name, pin, uid);
        if (pinUid && pinUid !== uid) {
          await setDoc(doc(db, "pinLogins", pinUid), { realUid: uid });
        }
      } else {
        // Usuario: la cuenta PIN sintÃ©tica serÃ¡ la cuenta principal
        const pinUid = await ensurePinAuthAccount(name, pin, null);
        uid = pinUid;
        data.pin = pin;
      }

      await setDoc(doc(db,"users",uid), data);
      allUsers.unshift({ uid, ...data, createdAt: new Date() });
      showToast("âœ… Cuenta creada: " + name, "ok");
      await logNovedad(buildUserCreatedNovedad(name, role, rango, cargos));
    }

    closeModal();
    renderAll();
  } catch(e) {
    console.error(e);
    setModalErr(friendlyErr(e.code) || e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = editUid ? "Guardar cambios" : "Crear cuenta";
  }
};

async function ensurePinAuthAccount(name, pin, realUid, sharedApp) {
  let app = sharedApp;
  let createdAppHere = false;
  if (!app) {
    const n = "pin-" + Date.now() + "-" + Math.random().toString(36).slice(2,6);
    app = initializeApp(cfg, n);
    createdAppHere = true;
  }
  const authInst = getAuth(app);
  const baseEmail = pinEmailFromName(name);
  const pwd = pinPasswordFromPin(pin);
  if (!baseEmail) throw new Error("Nombre invÃ¡lido para PIN.");

  let lastErr = null;
  // Intentar base, luego nombre-1, nombre-2... hasta 10
  for (let i = 0; i < 10; i++) {
    const email = i === 0 ? baseEmail : pinEmailFromName(name + " " + i);
    try {
      const cred = await createUserWithEmailAndPassword(authInst, email, pwd);
      await updateProfile(cred.user, { displayName: name });
      await signOut(authInst);
      return cred.user.uid;
    } catch (e) {
      if (e.code === "auth/email-already-in-use") {
        // Intentar loguearse con el PIN actual â†’ si coincide devolvemos ese uid.
        try {
          const cred2 = await signInWithEmailAndPassword(authInst, email, pwd);
          await signOut(authInst);
          return cred2.user.uid;
        } catch (_) {
          // PIN no coincide, probar siguiente sufijo
          lastErr = _;
          continue;
        }
      } else {
        lastErr = e;
        break;
      }
    }
  }
  if (lastErr) throw lastErr;
  throw new Error("No se pudo crear la cuenta PIN.");
}

// â”€â”€ ELIMINAR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let pendingDel = null;
window.askDelete = (uid, name) => {
  pendingDel = uid;
  document.getElementById("confirm-msg").textContent = `Â¿Eliminar la cuenta de "${name}"? No se puede deshacer.`;
  document.getElementById("confirm-ov").classList.add("open");
};
window.closeConfirm = () => { document.getElementById("confirm-ov").classList.remove("open"); pendingDel=null; };
document.getElementById("confirm-yes").onclick = async () => {
  if (!pendingDel) return;
  try {
    await deleteDoc(doc(db,"users",pendingDel));
    allUsers = allUsers.filter(u => u.uid!==pendingDel);
    renderAll();
    showToast("Cuenta eliminada.", "ok");
  } catch(e) { showToast("Error: "+e.message,"err"); }
  closeConfirm();
};

// â”€â”€ UTILIDADES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function genPin() { return String(Math.floor(1000 + Math.random()*9000)); }

function roleBadge(r) {
  const cl = {admin:"b-admin",inspector:"b-inspector",user:"b-user"};
  const lb = {admin:"Admin",inspector:"Inspector",user:"Usuario"};
  return `<span class="badge ${cl[r]||'b-user'}">${lb[r]||r}</span>`;
}
function statusBadge(s) {
  return s==="inactive"
    ? '<span class="badge b-inactive">Inactivo</span>'
    : '<span class="badge b-active">Activo</span>';
}
function esc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function friendlyErr(code) {
  const m = {
    "auth/email-already-in-use":"Ese email ya estÃ¡ registrado.",
    "auth/invalid-email":"Email invÃ¡lido.",
    "auth/weak-password":"ContraseÃ±a muy corta (mÃ­nimo 6).",
    "auth/wrong-password":"ContraseÃ±a incorrecta.",
    "auth/user-not-found":"No existe cuenta con ese email.",
    "auth/invalid-credential":"Email o contraseÃ±a incorrectos.",
    "auth/too-many-requests":"Demasiados intentos, esperÃ¡ unos minutos.",
    "auth/network-request-failed":"Error de red. VerificÃ¡ tu conexiÃ³n.",
    "auth/operation-not-allowed":"Email/contraseÃ±a no habilitado en Firebase.",
  };
  return m[code] || "";
}
let toastT;
window.showToast = (msg, type="ok") => {
  const t = document.getElementById("toast");
  t.textContent = (type==="ok"?"âœ… ":"âŒ ") + msg;
  t.className = "toast show " + type;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.className="toast"; }, 3500);
};


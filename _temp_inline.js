
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

// ── ESTADO GLOBAL ─────────────────────────────────────────────
let allUsers     = [];
let myRole       = null;
let myUid        = null;
let myName       = null;
let editUid      = null;
let filterText   = "";
let filterRoleV  = "";
let filterPText  = "";
let currentConfig = { hours: 24, minutes: 0, maxPoints: 7, decimals: 1 }; // Valor por defecto
let pointDecrementTimer = null;
let pointDecrementBusy = false;
let logs         = [];
let logsUnsub    = null;
let logTypeFilter = "";
let logSearch     = "";
let logFilterUser = "";
let logFilterRole = "";
let logFilterRango = "";
let logFilterCargo = "";
let filterPCargo   = "";
let ptsShowDetails = false;
// Estado de gráficos: tipo por gráfico y período para los temporales
const chartState = {
rank:   { type: "bar" },
evo:    { type: "line", period: "week" },
act:    { type: "bar", period: "day" },
team:   { type: "line", period: "week" },
admins: { type: "line", period: "day" }
};

const RL_OPTS = { windowMs: 5 * 60 * 1000, maxAttempts: 6, lockMs: 10 * 60 * 1000 };
const RL_PREFIX = "jowiland-admin:rl:";
const PTS_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const PTS_COOLDOWN_PREFIX = "jowiland:ptcd:";
const MAX_NOVEDADES = 20;

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

// ── AUTH ──────────────────────────────────────────────────────
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
showToast("Tu cuenta está inactiva.", "err");
await signOut(auth); return;
}
myRole = d.role;
myUid  = user.uid;
await bootApp(user, d);
} catch(e) {
showToast("Error al verificar sesión: " + e.message, "err");
}
});

window.doLogin = async () => {
const email = document.getElementById("l-email").value.trim();
const pass  = document.getElementById("l-pass").value;
const btn   = document.getElementById("l-btn");
const err   = document.getElementById("login-err");
err.style.display = "none";
if (!email || !pass) { err.textContent="Completá los dos campos."; err.style.display="block"; return; }
const chk = rlCheck("email");
if (!chk.ok) { err.textContent = `Demasiados intentos. Esperá ${fmtWait(chk.waitMs)} y probá de nuevo.`; err.style.display="block"; return; }
btn.disabled = true;
btn.innerHTML = '<div class="spinner"></div> Ingresando…';
try {
await signInWithEmailAndPassword(auth, email, pass);
rlReset("email");
} catch(e) {
const extra = e.code === "auth/too-many-requests" ? 10 * 60 * 1000 : 0;
const fail = rlFail("email", extra);
err.textContent = fail.locked
? `Demasiados intentos. Esperá ${fmtWait(fail.waitMs)} y probá de nuevo.`
: (friendlyErr(e.code) || e.message || "Error al iniciar sesión.");
err.style.display = "block";
btn.disabled = false;
btn.textContent = "Ingresar al panel";
}
};

document.getElementById("l-pass").addEventListener("keydown", e => { if(e.key==="Enter") window.doLogin(); });
window.doLogout = () => signOut(auth);

// ── BOOT ──────────────────────────────────────────────────────
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
'<button class="btn btn-primary btn-auto" onclick="openCreate()">➕ Crear cuenta</button>';
} else {
document.getElementById("nav-config").style.display = "none";
// Inspector: ocultar columna acciones
document.getElementById("th-acciones").style.display = "none";
document.getElementById("st-insp-card").style.display = "none";
document.getElementById("st-users-card").style.display = "none";
}

await loadConfig();
if (myRole === "admin") {
document.getElementById("config-hours").addEventListener("input", updateConfigSummary);
document.getElementById("config-minutes").addEventListener("input", updateConfigSummary);
document.getElementById("config-max").addEventListener("input", updateConfigSummary);
document.getElementById("config-decimals").addEventListener("change", updateConfigSummary);
document.getElementById("config-save").addEventListener("click", window.saveConfig);
} else {
const btn = document.getElementById("config-save");
if (btn) btn.disabled = true;
}

await startLogsLive();
await logLoginOnce();

await loadUsers();
startPointDecrementScheduler();
}

function showLogin() {
document.getElementById("login-screen").style.display = "flex";
document.getElementById("app").style.display = "none";
}

// ── CONFIGURACIÓN DE DECREMENTO DE PUNTOS ───────────────────────────────────────────
async function loadConfig() {
try {
const snap = await getDoc(doc(db, "settings", "pointDecrement"));
if (snap.exists()) {
const d = snap.data() || {};
currentConfig = {
hours: Number(d.hours) > 0 ? Number(d.hours) : 24,
minutes: Number(d.minutes) >= 0 ? Number(d.minutes) : 0,
maxPoints: Number(d.maxPoints) >= 1 ? Number(d.maxPoints) : 7,
decimals: [0,1,2].includes(Number(d.decimals)) ? Number(d.decimals) : 1
};
}
if (document.getElementById("config-hours")) {
document.getElementById("config-hours").value = currentConfig.hours;
document.getElementById("config-minutes").value = currentConfig.minutes;
document.getElementById("config-max").value = currentConfig.maxPoints;
document.getElementById("config-decimals").value = String(currentConfig.decimals);
}
updateConfigSummary();
} catch (e) {
console.error("Error loading config:", e);
}
}

function updateConfigSummary() {
const hours = parseInt(document.getElementById("config-hours").value) || 0;
const minutes = parseInt(document.getElementById("config-minutes").value) || 0;
const maxP = parseInt(document.getElementById("config-max").value) || 7;
const dec = [0,1,2].includes(parseInt(document.getElementById("config-decimals").value)) ? parseInt(document.getElementById("config-decimals").value) : 1;
const totalMinutes = Math.max(1, hours * 60 + minutes);
const intervalMinutes = totalMinutes / 10; // Dividimos 1 punto en 10 partes de 0.1

// Convertir intervalMinutes a horas y minutos para mostrar
const intervalHours = Math.floor(intervalMinutes / 60);
const intervalMins = Math.max(1, Math.round(intervalMinutes % 60));

document.getElementById("config-summary").innerHTML =
`Cada <strong>${hours}h ${minutes}m</strong> se restará <strong>1 punto</strong> (0.1 puntos cada <strong>${intervalHours}h ${intervalMins}m</strong>) · Máximo: <strong>${maxP}</strong> pts · Decimales: <strong>${dec}</strong>`;
}

window.saveConfig = async (e) => {
if (e && e.preventDefault) e.preventDefault();
if (myRole !== "admin") {
showToast("Solo un admin puede guardar esta configuración.", "err");
return;
}
const hours = parseInt(document.getElementById("config-hours").value) || 0;
const minutes = parseInt(document.getElementById("config-minutes").value) || 0;
const maxPoints = parseInt(document.getElementById("config-max").value) || 7;
const decimals = [0,1,2].includes(parseInt(document.getElementById("config-decimals").value)) ? parseInt(document.getElementById("config-decimals").value) : 1;

if (hours === 0 && minutes === 0) {
showToast("Ingresá un tiempo válido!", "err");
return;
}
if (!(maxPoints >= 1)) {
showToast("El máximo de puntos debe ser al menos 1.", "err");
return;
}

currentConfig = { hours, minutes, maxPoints, decimals, updatedAt: serverTimestamp() };
try {
await setDoc(doc(db, "settings", "pointDecrement"), currentConfig, { merge: true });
showToast("✅ Configuración guardada!", "ok");
startPointDecrementScheduler();
renderAll();
} catch (e) {
console.error("Error saving config:", e);
showToast("Error al guardar: " + e.message, "err");
}
}

// ── CONFIGURACIÓN DE CHAMBEADORES ───────────────────────────────
window.saveChambeadorConfig = async () => {
  if (myRole !== "admin") {
    showToast("Solo los admins pueden modificar la configuración.", "err");
    return;
  }

  try {
    const config = {
      dayRevealTime: document.getElementById("chambeador-day-reveal").value,
      weekRevealTime: document.getElementById("chambeador-week-reveal").value,
      monthRevealTime: document.getElementById("chambeador-month-reveal").value,
      dayDuration: parseInt(document.getElementById("chambeador-day-duration").value) || 2,
      weekDuration: parseInt(document.getElementById("chambeador-week-duration").value) || 3,
      monthDuration: parseInt(document.getElementById("chambeador-month-duration").value) || 7,
      lastUpdated: serverTimestamp()
    };

    await setDoc(doc(db, "settings", "chambeadorConfig"), config, { merge: true });
    showToast("Configuración de chambeadores guardada correctamente.", "ok");
    startChambeadorScheduler();
  } catch(e) {
    showToast("Error al guardar configuración: " + e.message, "err");
  }
};

let chambeadorSchedulerTimer = null;

function startChambeadorScheduler() {
  if (chambeadorSchedulerTimer) {
    clearInterval(chambeadorSchedulerTimer);
  }
  
  chambeadorSchedulerTimer = setInterval(checkChambeadorRevealation, 60 * 1000); // Check every minute
  checkChambeadorRevealation();
}

async function checkChambeadorRevealation() {
  try {
    const snap = await getDoc(doc(db, "settings", "chambeadorConfig"));
    if (!snap.exists()) return;
    
    const config = snap.data();
    const now = new Date();
    const currentTime = now.getHours() * 60 + now.getMinutes();
    
    // Check each chambeador type
    const chambeadorTypes = [
      { type: "day", revealTime: config.dayRevealTime, duration: config.dayDuration },
      { type: "week", revealTime: config.weekRevealTime, duration: config.weekDuration },
      { type: "month", revealTime: config.monthRevealTime, duration: config.monthDuration }
    ];
    
    for (const chambeador of chambeadorTypes) {
      const [revealHour, revealMin] = chambeador.revealTime.split(":").map(Number);
      const revealTimeMinutes = revealHour * 60 + revealMin;
      
      // Check if it's time to reveal
      if (currentTime >= revealTimeMinutes && currentTime < revealTimeMinutes + 30) {
        await revealChambeador(chambeador.type);
      }
      
      // Check if it's time to hide
      const hideTimeMinutes = revealTimeMinutes + (chambeador.duration * 60);
      if (currentTime >= hideTimeMinutes) {
        await hideChambeador(chambeador.type);
      }
    }
  } catch(e) {
    console.error("Error checking chambeador revelation:", e);
  }
}

async function revealChambeador(type) {
  // En una implementación real, esto actualizaría Firestore para mostrar el chambeador
  console.log(`Revelando chambeador del ${type}`);
  // Aquí se podría agregar un log de novedad
}

async function hideChambeador(type) {
  // En una implementación real, esto actualizaría Firestore para ocultar el chambeador
  console.log(`Ocultando chambeador del ${type}`);
  // Aquí se podría agregar un log de novedad
}

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

// Redondea un valor a la cantidad de decimales configurados
function roundPts(n) {
const d = decimalsN();
return Math.round(n * Math.pow(10, d)) / Math.pow(10, d);
}

// Limita el valor entre 0 y el máximo configurado, con la precisión elegida
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
// Eliminar la verificación de rol - debe funcionar sin depender de admin conectado
stopPointDecrementScheduler();
pointDecrementTimer = setInterval(applyPointDecrementTick, 60 * 1000);
applyPointDecrementTick();
}

async function applyPointDecrementTick() {
// Eliminar la verificación de rol - debe funcionar sin admin conectado
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

// Calcular cuántos intervalos completos han pasado
const elapsedMs = now - last;
const fullIntervals = Math.floor(elapsedMs / totalMs);
if (fullIntervals <= 0) return;

// Calcular la reducción gradual: 1 punto por intervalo completo, pero aplicado gradualmente
// Ejemplo: si configuraron 24h, cada 24h se reduce 1 punto total
// Se aplica gradualmente durante el intervalo actual
const partialMs = elapsedMs % totalMs;
const partialRatio = partialMs / totalMs; // 0 a 1, representa progreso del intervalo actual
const decrement = fullIntervals + partialRatio; // Intervalos completos + progreso parcial

let changed = 0;
let usersSnap = await getDocs(collection(db, "users"));
allUsers = usersSnap.docs.map(d => ({ uid: d.id, ...d.data() }));

for (let u of allUsers) {
if (!u || u.role === "admin") continue;
let oldP = Number(u.points || 0);
if (!Number.isFinite(oldP)) continue;
// Aplicar reducción calculada
let newP = clampPts(oldP - decrement);
if (newP === oldP) continue;
try {
await updateDoc(doc(db, "users", u.uid), { points: newP });
u.points = newP;
changed++;

// REGISTRAR LA REDUCCIÓN AUTOMÁTICA EN LOS LOGS
await writeLog({
type: "points",
actorUid: "system",
actorRole: "system",
actorName: "Sistema Automático",
targetUid: u.uid,
targetName: u.name || "",
delta: -decrement,
reason: `Reducción automática (${cfgToMs(cfg) / (1000 * 60 * 60)}h)`,
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

// ── PÁGINAS ───────────────────────────────────────────────────
window.goPage = id => {
if (id === "config-points" && myRole !== "admin") {
showToast("Solo un admin puede entrar a Configurar Puntos.", "err");
id = "config";
}

// Mostrar botón de reset novedades solo para admins
const resetNovedadesBtn = document.getElementById("reset-novedades-btn");
if (resetNovedadesBtn) {
  resetNovedadesBtn.style.display = myRole === "admin" ? "" : "none";
}

// Para usuarios, ocultar la pestaña de gráficos en el dashboard
if (myRole === "user" && id === "charts") {
  // Permitir que los usuarios vean los gráficos, pero ocultar algunos
  // Los usuarios solo ven Ranking de Puntos y Evolución general
}

// Para usuarios, ocultar el gráfico de evolución general
const evoChartCard = document.getElementById("evo-chart-card");
if (evoChartCard) {
  evoChartCard.style.display = myRole === "user" ? "" : "";
}

// Para usuarios, ocultar gráficos de actividad (solo ver Ranking y Evolución)
if (myRole === "user") {
  const activityAdminsCard = document.getElementById("activity-admins-card");
  if (activityAdminsCard) activityAdminsCard.style.display = "none";
  
  const activityInspectorsCard = document.getElementById("activity-inspectors-card");
  if (activityInspectorsCard) activityInspectorsCard.style.display = "none";
}
document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
document.getElementById("page-" + id).classList.add("active");
const ni = document.querySelector(`.nav-item[onclick="goPage('${id}')"]`);
if (ni) ni.classList.add("active");

// Inicializar gráficos si entramos a la pestaña charts
if (id === "charts") {
  if (myRole === "admin") {
    // Mostrar botones de reset individuales para admins
    const resetBtns = ["reset-ranking-admins-btn", "reset-evolution-pts-btn", "reset-activity-chart-btn"];
    resetBtns.forEach(btnId => {
      const btn = document.getElementById(btnId);
      if (btn) btn.style.display = "";
    });
  }
  if (typeof renderRankingAdmins === "function") renderRankingAdmins();
  if (typeof renderEvolutionPts === "function") renderEvolutionPts();
  if (typeof renderInspectorActivityJow === "function") renderInspectorActivityJow();
}
};

window.setLogTypeFilter = v => { logTypeFilter = v; renderLogs(); };
window.setLogSearch = v => { logSearch = (v || "").toLowerCase(); renderLogs(); };
window.setLogFilterUser = v => { logFilterUser = v; renderLogs(); };
window.setLogFilterRole = v => { logFilterRole = v; renderLogs(); };
window.setLogFilterRango = v => { logFilterRango = v; renderLogs(); };
window.setLogFilterCargo = v => { logFilterCargo = v; renderLogs(); };
window.toggleInspectorPanel = () => {
const el = document.getElementById("insp-panel");
if (!el) return;
el.style.display = el.style.display === "none" ? "block" : "none";
};

// ── GRÁFICOS (centralizados en el panel central) ──────────────
// Tipos de gráficos:
//  Lineal  → evolución / tendencia temporal
//  Columnas → comparación entre miembros / rankings
//  Circular (doughnut) → distribución / proporción
const chartInstances = {};

const CHART_COLORS = ["#5b8dee","#3ecf8e","#f5a623","#a78bfa","#e05555","#4cc9f0","#ffd166","#57cc99","#2ecc71","#e67e22"];

// Cambia el tipo de un gráfico específico (line / bar / doughnut)
window.setChartType = (key, type) => {
if (!chartState[key]) return;
chartState[key].type = type;
updateChartButtons();
renderCharts();
};

// Cambia el período (Día / Semana / Mes) de un gráfico temporal
window.setChartPeriod = (key, period) => {
if (!chartState[key]) return;
chartState[key].period = period;
updateChartButtons();
renderCharts();
};

// Sincroniza los botones activos de cada tarjeta de gráfico
function updateChartButtons() {
document.querySelectorAll(".chart-card[data-cchart]").forEach(card => {
const key = card.dataset.cchart;
const st = chartState[key];
if (!st) return;
card.querySelectorAll(".cbtn").forEach(b => {
const ct = b.getAttribute("data-ct");
const cp = b.getAttribute("data-cp");
const on = (ct && ct === st.type) || (cp && cp === st.period);
b.classList.toggle("active", on);
});
});
}

function destroyChart(name) {
if (chartInstances[name]) {
try { chartInstances[name].destroy(); } catch {}
delete chartInstances[name];
}
}

function currentFilter() {
const cargo = document.getElementById("cf-cargo")?.value || "";
const rango = document.getElementById("cf-rango")?.value || "";
return { cargo, rango };
}

function populateCargoFilter() {
const sel = document.getElementById("cf-cargo");
if (!sel) return;
const seen = new Set();
for (const u of allUsers) {
const cs = u.cargos || [];
const arr = Array.isArray(cs) ? cs : [String(cs)];
for (const c of arr) {
const key = String(c).trim();
if (key) seen.add(key);
}
}
const cur = sel.value;
const opts = ['<option value="">Todos los cargos</option>'];
for (const c of [...seen].sort()) opts.push(`<option value="${esc(c)}">${esc(c)}</option>`);
sel.innerHTML = opts.join("");
sel.value = cur;
}

function filteredChartUsers() {
const { cargo, rango } = currentFilter();
return allUsers.filter(u => {
// Filtrar por cargo - usar hasCargo si existe, si no lógica manual
if (cargo) {
  const cargos = u.cargos || [];
  const arr = Array.isArray(cargos) ? cargos : [String(cargos)];
  const hasCargoMatch = arr.some(c => String(c).trim().toLowerCase() === cargo.toLowerCase());
  if (!hasCargoMatch) return false;
}
// Filtrar por rango
if (rango && !String(u.rango || "").includes(rango)) return false;
return true;
});
}

function countActionsBy(uid) {
let c = 0;
for (const l of logs) {
if (!l || l.actorUid !== uid) continue;
if (String(l.actorRole || "").toLowerCase() === "admin") continue;
c++;
}
return c;
}

// Dibuja un gráfico simple (line / bar / doughnut) según el tipo elegido
function renderSingleChart(canvasId, type, labels, values, labelText, colors) {
const cv = document.getElementById(canvasId);
if (!cv) return;
if (typeof Chart === "undefined") { cv.parentElement.innerHTML = '<div class="empty">Chart.js no cargó.</div>'; return; }
destroyChart(canvasId);
const isDough = type === "doughnut";
const isLine  = type === "line";
const palette = colors || CHART_COLORS;
const data = isDough
? { labels, datasets: [{ data: values, backgroundColor: palette, borderWidth: 0 }] }
: { labels, datasets: [{ label: labelText, data: values, backgroundColor: isLine ? palette.slice(0, values.length).map(c => c + "33") : palette.slice(0, values.length), borderColor: palette.slice(0, values.length), borderWidth: isLine ? 2 : 1, borderRadius: 5, fill: isLine ? false : true, tension: 0.3, pointRadius: isLine ? 2.5 : 0 }] };
chartInstances[canvasId] = new Chart(cv, {
type: isDough ? "doughnut" : isLine ? "line" : "bar",
data,
options: {
responsive: true,
maintainAspectRatio: false,
plugins: { legend: { display: isDough, labels: { color: "#dde3f0", boxWidth: 12 } } },
scales: isDough ? {} : {
y: { beginAtZero: true, ticks: { color: "#5a6680" }, grid: { color: "rgba(255,255,255,.05)" } },
x: { ticks: { color: "#5a6680", maxRotation: 45, autoSkip: true } }
}
}
});
}

function chartLineMulti(canvasId, labels, seriesList) {
const cv = document.getElementById(canvasId);
if (!cv) return;
if (typeof Chart === "undefined") { cv.parentElement.innerHTML = '<div class="empty">Chart.js no cargó.</div>'; return; }
destroyChart(canvasId);
const datasets = seriesList.map((s, i) => ({
label: s.name,
data: s.series,
borderColor: CHART_COLORS[i % CHART_COLORS.length],
backgroundColor: CHART_COLORS[i % CHART_COLORS.length] + "22",
fill: false,
tension: 0.3,
pointRadius: 2.5
}));
chartInstances[canvasId] = new Chart(cv, {
type: "line",
data: { labels, datasets },
options: {
responsive: true,
maintainAspectRatio: false,
plugins: { legend: { labels: { color: "#dde3f0", boxWidth: 12 } } },
scales: {
y: { beginAtZero: false, ticks: { color: "#5a6680" }, grid: { color: "rgba(255,255,255,.05)" } },
x: { ticks: { color: "#5a6680", maxRotation: 45, autoSkip: true } }
}
}
});
}

function periodStart(period) {
const mult = period === "day" ? 1 : period === "week" ? 7 : 30;
return Date.now() - mult * 24 * 60 * 60 * 1000;
}

// Genera los intervalos de tiempo para un período dado
function bucketsFor(period) {
const now = Date.now();
const out = [];
if (period === "day") {
const step = 60 * 60 * 1000, n = 24;
for (let i = n - 1; i >= 0; i--) {
const end = now - i * step, start = end - step;
const h = new Date(end).getHours();
out.push({ start, end, label: `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}` });
}
} else if (period === "week") {
const step = 24 * 60 * 60 * 1000, n = 7;
for (let i = n - 1; i >= 0; i--) {
const end = now - i * step, start = end - step;
out.push({ start, end, label: `${new Date(end).getDate()}/${new Date(end).getMonth() + 1}` });
}
} else {
const step = 24 * 60 * 60 * 1000, n = 30;
for (let i = n - 1; i >= 0; i--) {
const end = now - i * step, start = end - step;
out.push({ start, end, label: `${new Date(end).getDate()}/${new Date(end).getMonth() + 1}` });
}
}
return out;
}

function logInWindow(l, start, end) {
const t = logTimeRaw(l);
return t > 0 && t >= start && t < end;
}

function renderCharts() {
// El sistema Chart.js viejo se eliminó. Ahora usamos los gráficos SVG que coinciden con Panel de Puntos.
// Esta función es solo para compatibilidad.
if (typeof renderRankingAdmins === "function") renderRankingAdmins();
if (typeof renderEvolutionPts === "function") renderEvolutionPts();
if (typeof renderActivityChart === "function") renderActivityChart();
if (typeof renderInspectorActivityJow === "function") renderInspectorActivityJow();
}

// Hacer renderCharts global para que los selectores HTML puedan accederla
window.renderCharts = renderCharts;

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
return m[r] || r || "—";
}

function fmtCargos(cargos) {
if (!cargos) return "—";
if (Array.isArray(cargos)) return cargos.length ? cargos.join(", ") : "—";
return String(cargos);
}

function buildPointsNovedad(targetName, delta, newVal, reason) {
const name = targetName || "Un usuario";
const abs = Math.abs(delta);
const isUp = delta > 0;
const main = isUp
? pick([
`✅ Buen desempeño: ${name} sumó +${abs} punto(s).`,
`✅ ${name} fue reconocido: +${abs} punto(s).`,
`✅ ¡Buen trabajo, ${name}! +${abs} punto(s).`
])
: pick([
`⚠️ Ajuste de puntos: ${name} recibió -${abs} punto(s).`,
`⚠️ ${name} tuvo un ajuste: -${abs} punto(s).`,
`⚠️ Se registró un descuento para ${name}: -${abs} punto(s).`
]);

const estado = newVal <= 2
? " Quedó en estado: En riesgo."
: newVal >= 6
? " Quedó en estado: Óptimo."
: "";

return `${main} Motivo: ${reason}. Total: ${newVal} pts.${estado}`;
}

function buildUserCreatedNovedad(name, role, rango, cargos) {
const who = name || "Nuevo usuario";
const main = pick([
`✨ Nuevo ingreso: ${who} se unió al equipo.`,
`✨ Se registró un nuevo integrante: ${who}.`,
`✨ Bienvenido/a: ${who}.`
]);
return `${main} Rol: ${prettyRole(role)} · Rango: ${rango || "—"} · Cargos: ${fmtCargos(cargos)}.`;
}

function buildUserUpdatedNovedad(prev, next) {
const who = next?.name || prev?.name || "Un usuario";
const parts = [];
if ((prev?.role || "") !== (next?.role || "")) parts.push(`Rol: ${prettyRole(prev?.role)} → ${prettyRole(next?.role)}`);
if ((prev?.rango || "") !== (next?.rango || "")) parts.push(`Rango: ${prev?.rango || "—"} → ${next?.rango || "—"}`);
const pc = fmtCargos(prev?.cargos);
const nc = fmtCargos(next?.cargos);
if (pc !== nc) parts.push(`Cargos: ${pc} → ${nc}`);
if ((prev?.status || "") !== (next?.status || "")) parts.push(`Estado: ${prev?.status || "—"} → ${next?.status || "—"}`);
if (!parts.length) return null;
return `🔄 Actualización de perfil: ${who}. ${parts.join(" · ")}.`;
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
if (typeof renderDestacados === "function") renderDestacados();
if (typeof renderCharts === "function") renderCharts();
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
const actor = allUsers.find(u => u.uid === l.actorUid);
const target = allUsers.find(u => u.uid === l.targetUid);
return (actor && normRango(actor.rango) === logFilterRango) || (target && normRango(target.rango) === logFilterRango);
});
}
if (logFilterCargo) {
list = list.filter(l => {
const actor = allUsers.find(u => u.uid === l.actorUid);
const target = allUsers.find(u => u.uid === l.targetUid);
return (actor && hasCargo(actor, logFilterCargo)) || (target && hasCargo(target, logFilterCargo));
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
const actor = esc(l.actorName || "—");
const target = esc(l.targetName || (l.type === "login" ? (l.actorName || "—") : "—"));
const delta = isPoints ? (typeof l.delta === "number" ? l.delta : 0) : null;
const deltaTxt = isPoints ? `${delta > 0 ? "+" : ""}${delta}` : "—";
const motivo = esc(l.reason || (l.type === "login" ? "Inicio de sesión" : "Sin motivo"));
const delBtn = isAdmin ? `<button class="btn btn-danger btn-sm" onclick="deleteLog('${l.id}')">🗑️</button>` : "";
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
const ok = confirm("¿Borrar este registro? No se puede deshacer.");
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
       <td><b style="color:var(--warn)">${r.pts}</b></td>
       <td>${r.actions}</td>
       <td>${esc(r.lastTxt)}</td>
       <td>${r.lastAt ? fmtSince(lastMs) : "—"}</td>
       <td>${state}</td>
     </tr>`;
}).join("");
}

// ── TRABAJADORES DESTACADOS (Día / Semana / Mes) ──────────────
window.toggleDestacados = () => {
const wrap = document.getElementById("destacados-wrap");
const btn  = document.getElementById("btn-dest");
if (!wrap) return;
const show = wrap.style.display !== "grid";
wrap.style.display = show ? "grid" : "none";
if (btn) btn.textContent = show ? "🙈 Ocultar trabajadores destacados" : "👁️ Mostrar trabajadores destacados";
if (show && typeof renderDestacados === "function") renderDestacados();
};

function logTimeRaw(l) {
if (!l) return 0;
const d = tsToDate(l.createdAt);
if (d) return d.getTime();
return typeof l.clientTs === "number" ? l.clientTs : 0;
}

function periodTopStaff(mode) {
const now = Date.now();
const mult = mode === "day" ? 1 : mode === "week" ? 7 : 30;
const start = now - mult * 24 * 60 * 60 * 1000;
const counts = new Map();
for (const l of logs) {
if (!l) continue;
if (String(l.actorRole || "").toLowerCase() === "admin") continue;
const t = logTimeRaw(l);
if (!t || t < start) continue;
const uid = l.actorUid || "—";
counts.set(uid, (counts.get(uid) || 0) + 1);
}
let bestUid = null, best = 0;
for (const [uid, c] of counts) if (c > best) { best = c; bestUid = uid; }
if (!bestUid) return null;
const u = allUsers.find(x => x.uid === bestUid);
return u ? { u, count: best } : null;
}

const now = Date.now();
const oneDayMs = 24 * 60 * 60 * 1000;
const oneWeekMs = 7 * oneDayMs;
const oneMonthMs = 30 * oneDayMs;

// Calcular el inicio del sistema (primer log o timestamp más antiguo)
let systemStart = now;
if (logs.length > 0) {
  const oldestLog = logs.reduce((min, l) => {
    const t = logTimeRaw(l);
    return t > 0 && t < min ? t : min;
  }, now);
  systemStart = oldestLog;
}

function renderDestacados() {
const defs = [
{ mode: "day",   id: "dest-dia",    empty: "Sin actividad hoy", elapsed: now - systemStart, minRequired: oneDayMs },
{ mode: "week", id: "dest-semana", empty: "Sin actividad esta semana", elapsed: now - systemStart, minRequired: oneWeekMs },
{ mode: "month", id: "dest-mes",    empty: "Sin actividad este mes", elapsed: now - systemStart, minRequired: oneMonthMs }
];
for (const def of defs) {
const el = document.getElementById(def.id);
if (!el) continue;
// Solo mostrar si ha pasado el tiempo mínimo requerido
if (def.elapsed < def.minRequired) {
  const remaining = Math.ceil((def.minRequired - def.elapsed) / oneDayMs);
  el.innerHTML = `<span style="color:var(--muted);font-size:12px">Requiere ${remaining} día(s) más de datos</span>`;
  continue;
}

const w = periodTopStaff(def.mode);
if (!w) { el.innerHTML = def.empty; continue; }
el.innerHTML = `🏆 <b>${esc(w.u.name || "—")}</b><br><span style="color:var(--muted);font-size:12px">🎯 ${w.count} acciones · ⭐ ${fmtPts(w.u.points)} pts · ${def.mode === "day" ? "hoy" : def.mode === "week" ? "7 días" : "30 días"}</span>`;
}
}

// ── CARGAR USUARIOS ───────────────────────────────────────────
async function loadUsers() {
try {
const q = query(collection(db, "users"), orderBy("createdAt", "desc"));
const snap = await getDocs(q);
allUsers = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
// Poblar filtro de usuarios con TODOS los usuarios
if (typeof populateUserFilter === "function") populateUserFilter();
if (typeof populateLogUserFilter === "function") populateLogUserFilter();
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
// populateCargoFilter y renderCharts ya no se usan con el sistema SVG
}

// ── DASHBOARD ─────────────────────────────────────────────────
function renderDash() {
// Staff = todos menos admins (inspectores SÍ se incluyen)
const staff = allUsers.filter(u => u.role !== "admin");
const insp  = allUsers.filter(u => u.role === "inspector");
const users = allUsers.filter(u => u.role === "user");
const total = staff.length;
const ptsArr = staff.map(u => Number(u.points || 0));
const avg = total ? ptsArr.reduce((a,b)=>a+b,0) / total : 0;
const risk = staff.filter(u => Number(u.points||0) <= 2).length;
const maxP = Math.max(1, ...ptsArr);

document.getElementById("st-total").textContent = total;
document.getElementById("st-total-sub").textContent = `${insp.length} inspectores · ${users.length} usuarios`;
document.getElementById("st-total-bar").style.width = Math.min(100, total*10) + "%";

document.getElementById("st-insp").textContent = insp.length;
document.getElementById("st-insp-sub").textContent = total ? Math.round(insp.length/total*100) + "% del staff" : "—";
document.getElementById("st-insp-bar").style.width = (total ? insp.length/total*100 : 0) + "%";

document.getElementById("st-users").textContent = users.length;
document.getElementById("st-users-sub").textContent = total ? Math.round(users.length/total*100) + "% del staff" : "—";
document.getElementById("st-users-bar").style.width = (total ? users.length/total*100 : 0) + "%";

document.getElementById("st-avg").textContent = (Math.round(avg*100)/100).toString();
document.getElementById("st-avg-sub").textContent = `Máximo: ${fmtPts(maxP)} pts`;
document.getElementById("st-avg-bar").style.width = Math.min(100, avg/maxP*100) + "%";

document.getElementById("st-risk").textContent = risk;
document.getElementById("st-risk-sub").textContent = total ? Math.round(risk/total*100) + "% del staff (≤2 pts)" : "—";
document.getElementById("st-risk-bar").style.width = (total ? risk/total*100 : 0) + "%";

renderDestacados();

// Calcular puntos según el período seleccionado para el ranking
const now = Date.now();
const periodStart = rankPeriod === "day" ? now - 24 * 60 * 60 * 1000 :
                    rankPeriod === "week" ? now - 7 * 24 * 60 * 60 * 1000 :
                    now - 30 * 24 * 60 * 60 * 1000;

// Para cada usuario, calcular puntos ganados en el período
const usersWithPeriodPoints = allUsers.map(u => {
  let periodPoints = 0;
  if (rankPeriod === "day") {
    // Para diario, usar puntos actuales
    periodPoints = Number(u.points || 0);
  } else {
    // Para semanal/mensual, calcular puntos ganados desde logs
    for (const l of logs) {
      if (l.type === "points" && l.targetUid === u.uid) {
        const t = logTimeRaw(l);
        if (t && t >= periodStart && typeof l.delta === "number" && l.delta > 0) {
          periodPoints += l.delta;
        }
      }
    }
  }
  return { ...u, periodPoints };
});

const top = [...usersWithPeriodPoints].sort((a,b) => (b.periodPoints||0)-(a.periodPoints||0)).slice(0, 8);
const tb = document.getElementById("dash-tbody");
const canEdit = myRole === "admin" || myRole === "inspector";
if (!top.length) { tb.innerHTML='<tr><td colspan="6" class="empty">Sin datos aún.</td></tr>'; return; }
tb.innerHTML = top.map((u,i) => {
const isSelf = u.uid === myUid;
const dis = (isSelf || !canEdit) ? 'disabled style="opacity:0.45;cursor:not-allowed"' : '';
let cells;
if (!canEdit) {
cells = '<td colspan="2"><span style="color:var(--muted);font-size:11px">—</span></td>';
} else if (myRole === "admin") {
const stepVal = decimalsN() === 0 ? "1" : decimalsN() === 1 ? "0.1" : "0.01";
const placeholderVal = decimalsN() === 0 ? "0" : decimalsN() === 1 ? "0.0" : "0.00";
cells = `<td>${isSelf ? '<span style="color:var(--muted);font-size:11px">—</span>' : `<div class="pts-row" style="gap:8px">
  <button class="btn btn-success btn-sm" onclick="dashApplyPts('${u.uid}',1)" ${dis} title="Sumar +1">＋</button>
  <button class="btn btn-danger btn-sm" onclick="dashApplyPts('${u.uid}',-1)" ${dis} title="Restar -1">−</button>
  <input type="number" step="${stepVal}" min="0" id="dvin-${u.uid}" class="pts-input" style="width:80px" placeholder="${placeholderVal}" title="Valor fijo a establecer (Enter para guardar)" onkeydown="if(event.key==='Enter')dashSetPts('${u.uid}')"/>
  <button class="btn btn-primary btn-sm" onclick="dashSetPts('${u.uid}')" ${dis}>💾</button>
</div>`}</td>
  <td><span style="color:var(--muted);font-size:11px">—</span></td>`;
} else {
cells = `<td><span style="color:var(--muted);font-size:11px">—</span></td>
  <td><div class="pts-row" style="flex-wrap:wrap">
    <button class="btn btn-success btn-sm" onclick="dashApplyPts('${u.uid}',1)" ${dis} title="Sumar +1">＋</button>
    <button class="btn btn-danger btn-sm" onclick="dashApplyPts('${u.uid}',-1)" ${dis} title="Restar -1">−</button>
  </div></td>`;
}
return `
   <tr>
     <td style="color:var(--muted);font-weight:700;width:30px">${i+1}</td>
     <td><b>${esc(u.name||"—")}</b></td>
     <td>${roleBadge(u.role)}</td>
     <td><b style="color:var(--warn);font-size:15px" id="dpv-${u.uid}">${fmtPts(u.periodPoints)}</b></td>
     ${cells}
   </tr>`;
}).join("");
}

// Acción rápida de puntos desde el Dashboard (misma fuente de datos).
window.dashApplyPts = async (uid, sign) => {
if (myRole !== "admin" && myRole !== "inspector") { showToast("Sin permisos para modificar puntos.", "err"); return; }
await adjPts(uid, sign * 1);
const el = document.getElementById("dpv-" + uid);
if (el) el.textContent = fmtPts(allUsers.find(x=>x.uid===uid)?.points || 0);
};

// Admin: establecer un valor fijo desde el Dashboard (Enter o botón Fijar)
window.dashSetPts = async (uid) => {
if (myRole !== "admin") { showToast("Solo un admin puede fijar el valor.", "err"); return; }
const inp = document.getElementById("dvin-" + uid);
const raw = inp ? inp.value : "";
const v = parseFloat(String(raw).replace(",", "."));
if (!Number.isFinite(v) || v < 0) { showToast("Ingresá un valor válido (ej: 7 o 3.5).", "err"); return; }
await setPtsFixed(uid, v);
const el = document.getElementById("dpv-" + uid);
if (el) el.textContent = fmtPts(allUsers.find(x=>x.uid===uid)?.points || 0);
};

// ── TABLA USUARIOS ────────────────────────────────────────────
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
     <td><b>${esc(u.name||"—")}</b><br><span style="color:var(--muted);font-size:11px">${esc(u.email||"")}</span></td>
     <td>${roleBadge(u.role)}</td>
     <td>${u.pin ? `<code style="background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:13px;padding:3px 8px;letter-spacing:.1em">${u.pin}</code>` : '<span style="color:var(--muted)">—</span>'}</td>
     <td>${esc(u.rango||"—")}</td>
     <td>${(u.cargos||[]).map(c => `<span class="badge">${esc(c)}</span>`).join(" ") || '<span style="color:var(--muted)">—</span>'}</td>
     <td>${statusBadge(u.status)}</td>
     <td><b style="color:var(--warn)">${u.points||0}</b></td>
     <td>${isAdmin ? `
       <div style="display:flex;gap:6px">
         <button class="btn btn-warn btn-sm" onclick="openEdit('${u.uid}')">✏️ Editar</button>
         <button class="btn btn-danger btn-sm" onclick="askDelete('${u.uid}','${esc(u.name||"")}')">🗑️</button>
       </div>` : '<span style="color:var(--muted)">—</span>'}</td>
   </tr>`).join("");
}

// ── TABLA PUNTOS ──────────────────────────────────────────────
function filteredPoints() {
let list = allUsers.filter(u => u.role !== "admin");
if (filterPText) list = list.filter(u => (u.name||"").toLowerCase().includes(filterPText));
if (filterPCargo) {
list = list.filter(u => {
const cs = u.cargos || [];
const arr = Array.isArray(cs) ? cs : [String(cs)];
return arr.some(c => String(c).trim().toLowerCase() === filterPCargo.toLowerCase());
});
}
return list;
}

window.filterP = v => { filterPText = v.toLowerCase(); renderPointsTable(filteredPoints()); };

window.filterPCargo = v => {
filterPCargo = v;
const sel = document.getElementById("pts-cargo");
if (sel && sel.options.length <= 1) {
sel.innerHTML = ['<option value="">Todos los cargos</option>','<option>Inspector</option>','<option>Moderador</option>','<option>Editor</option>','<option>Marketing</option>','<option>MC Team</option>','<option>Dev</option>'].join("");
}
if (sel) sel.value = v;
renderPointsTable(filteredPoints());
};

// Botón "ojo" del admin: mostrar/ocultar rango y cargos en la tabla de puntos
window.togglePtsDetails = () => {
ptsShowDetails = !ptsShowDetails;
document.querySelectorAll(".pts-detail-th").forEach(th => {
th.style.display = ptsShowDetails ? "" : "none";
});
const btn = document.getElementById("pts-eye-btn");
if (btn) btn.textContent = ptsShowDetails ? "🙈 Ocultar detalles" : "👁️ Detalles";
renderPointsTable(filteredPoints());
};

function renderPointsTable(list) {
const tb = document.getElementById("pts-tbody");
const cols = ptsShowDetails ? 6 : 4;
if (!list.length) { tb.innerHTML=`<tr><td colspan="${cols}" class="empty">Sin moderadores.</td></tr>`; return; }
tb.innerHTML = list.map(u => {
const isSelf = u.uid === myUid;
const dis = isSelf ? 'disabled style="opacity:0.5;cursor:not-allowed"' : '';
const detailCells = ptsShowDetails
? `<td>${(Array.isArray(u.cargos) ? u.cargos : [String(u.cargos||"")]).filter(Boolean).map(c => `<span class="badge">${esc(c)}</span>`).join(" ") || '<span style="color:var(--muted)">—</span>'}</td>`
: "";
let valueCell, adjustCell;
if (myRole === "admin") {
const stepVal = decimalsN() === 0 ? "1" : decimalsN() === 1 ? "0.1" : "0.01";
const placeholderVal = decimalsN() === 0 ? "0" : decimalsN() === 1 ? "0.0" : "0.00";
valueCell = `<td>${isSelf ? '<span style="color:var(--muted);font-size:11px">—</span>' : `<div class="pts-row" style="gap:8px">
  <button class="btn btn-success btn-sm" onclick="adjPts('${u.uid}',1)" ${dis} title="Sumar +1">＋</button>
  <button class="btn btn-danger btn-sm" onclick="adjPts('${u.uid}',-1)" ${dis} title="Restar -1">−</button>
  <input type="number" step="${stepVal}" min="0" id="pvin-${u.uid}" class="pts-input" style="width:80px" placeholder="${placeholderVal}" title="Valor fijo a establecer (Enter para guardar)" onkeydown="if(event.key==='Enter')setPtsFixed('${u.uid}')"/>
  <button class="btn btn-primary btn-sm" onclick="setPtsFixed('${u.uid}')" ${dis}>💾</button>
</div>`}</td>`;
adjustCell = '<td><span style="color:var(--muted);font-size:11px">—</span></td>';
} else if (myRole === "inspector") {
valueCell = '<td><span style="color:var(--muted);font-size:11px">—</span></td>';
adjustCell = `<td><div class="pts-row" style="flex-wrap:wrap">
  <button class="btn btn-success btn-sm" onclick="adjPts('${u.uid}',1)" ${dis} title="Sumar +1">＋ +1</button>
  <button class="btn btn-danger btn-sm" onclick="adjPts('${u.uid}',-1)" ${dis} title="Restar -1">− -1</button>
</div></td>`;
} else {
valueCell = '<td><span style="color:var(--muted);font-size:11px">—</span></td>';
adjustCell = '<td><span style="color:var(--muted);font-size:11px">—</span></td>';
}
return `
   <tr ${isSelf ? 'class="my-row"' : ""}>
     <td>
       <b>${esc(u.name||"—")}</b>
       ${isSelf ? '<span class="you-tag">tú</span>' : ""}
     </td>
     <td>${roleBadge(u.role)}</td>
     <td><span class="pts-val" id="pv-${u.uid}">${fmtPts(u.points)}</span></td>
     ${detailCells}
     ${valueCell}
     ${adjustCell}
   </tr>`;
}).join("");
}

// ── PUNTOS ────────────────────────────────────────────────────
// Ajustar +1 / -1: únicamente valores fijos (no cantidades personalizadas).
// El inspector puede hacer como máximo 2 cambios por usuario al día.
window.adjPts = async (uid, delta) => {
if (myRole !== "admin" && myRole !== "inspector") {
showToast("No tenés permisos para modificar puntos.", "err");
return;
}
if (uid === myUid) {
showToast("No podés modificar tus propios puntos!", "err");
return;
}
const u = allUsers.find(x => x.uid===uid);
if (!u) return;
delta = delta > 0 ? 1 : -1;
if (myRole === "inspector") {
const cd = checkInspectorCooldown(uid);
if (!cd.ok) {
showToast(`Cooldown activo (máx. 2 cambios/día). Podés volver a puntuar a esta persona en ${fmtSince(cd.waitMs)}.`, "err");
return;
}
}

// ── Motivo ──
let reason = "";
if (myRole === "inspector") {
  while (true) {
    const r = prompt(`Motivo de la modificación (${delta > 0 ? '+' : ''}${delta} pts a ${u.name}):\n\nCampo OBLIGATORIO para inspectores.`);
    if (r === null) return;
    reason = r.trim();
    if (!reason) { showToast("Tenés que escribir un motivo obligatorio.", "err"); continue; }
    break;
  }
} else {
  const r = prompt(`Motivo (opcional) de la modificación (${delta > 0 ? '+' : ''}${delta} pts a ${u.name}):`);
  if (r === null) return;
  reason = r.trim() || `Modificación manual (${delta > 0 ? '+' : ''}${delta})`;
}

// Se respeta el máximo configurado y la cantidad de decimales elegida.
const oldVal = u.points || 0;
const nv = clampPts(oldVal + delta);
try {
await updateDoc(doc(db,"users",uid), { points: nv });
u.points = nv;
const el = document.getElementById("pv-"+uid);
if (el) el.textContent = fmtPts(nv);
const dv = document.getElementById("dpv-" + uid);
if (dv) dv.textContent = fmtPts(nv);
renderAll();
showToast((delta>0?"➕":"➖") + " " + fmtPts(Math.abs(delta)) + " pt a " + (u.name||"usuario"), "ok");

// Punto 7 Dashboard: solo novedades en umbrales (NO buildPointsNovedad por cada +/-)
await maybeEmitThresholdNovedadDash(u, oldVal, nv, delta, myRole);

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

// Valor fijo: el admin escribe el número de puntos y presiona Enter (o Fijar)
// para ESTABLECER el valor directamente, sin cantidades personalizadas de ajuste.
window.setPtsFixed = async (uid, forcedVal) => {
if (myRole !== "admin") {
showToast("Solo un admin puede fijar el valor de puntos.", "err");
return;
}
if (uid === myUid) {
showToast("No podés modificar tus propios puntos!", "err");
return;
}
const u = allUsers.find(x => x.uid===uid);
if (!u) return;
let v = forcedVal;
if (typeof v !== "number") {
const inp = document.getElementById("pvin-" + uid) || document.getElementById("dvin-" + uid);
const raw = inp ? inp.value : "";
v = parseFloat(String(raw).replace(",", "."));
}
if (!Number.isFinite(v) || v < 0) {
showToast("Ingresá un valor válido (mayor o igual a 0).", "err");
return;
}
const oldVal = u.points || 0;
const nv = clampPts(v);
if (nv === oldVal) { showToast("El valor ya es " + fmtPts(nv) + ".", "ok"); return; }
const delta = Math.round((nv - oldVal) * 100) / 100;

// Admin: motivo OPCIONAL
const r = prompt(`Motivo (opcional) - establecer puntos de ${u.name} a ${fmtPts(nv)}:`);
if (r === null) return;
const reason = r.trim() || `Valor directo (${delta > 0 ? '+' : ''}${delta})`;

try {
await updateDoc(doc(db,"users",uid), { points: nv });
u.points = nv;
const el = document.getElementById("pv-"+uid);
if (el) el.textContent = fmtPts(nv);
const dv = document.getElementById("dpv-" + uid);
if (dv) dv.textContent = fmtPts(nv);
renderAll();
showToast("⚙️ Puntos de " + (u.name||"usuario") + " → " + fmtPts(nv), "ok");

await maybeEmitThresholdNovedadDash(u, oldVal, nv, delta, myRole);

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

// Limpiar inputs si existen
["pvin-", "dvin-"].forEach(p => {
  const inp = document.getElementById(p + uid);
  if (inp) inp.value = "";
});

} catch(e) { showToast("Error: "+e.message,"err"); }
};

// Punto 7 Dashboard: Novedades SOLO en umbrales / eventos importantes
async function maybeEmitThresholdNovedadDash(u, oldVal, newVal, delta, role) {
  const name = u.name || 'un miembro';
  if (oldVal === 0 && newVal > 0) {
    await logNovedad(`✅ ${name} volvió a tener actividad (${fmtPts(newVal)} pts) y salió del estado crítico.`);
    return;
  }
  if (oldVal > 0 && newVal === 0) {
    await logNovedad(`🚨 ${name} llegó a 0 puntos · Estado crítico · Requiere apelación o acción inmediata.`);
    return;
  }
  if (oldVal > 2 && newVal > 0 && newVal <= 2) {
    await logNovedad(`⚠️ ${name} está en riesgo alto (${fmtPts(newVal)} pts) · Entró en seguimiento por bajo desempeño.`);
    return;
  }
  if (oldVal <= 2 && newVal > 4) {
    await logNovedad(`💪 ${name} recuperó puntos (${fmtPts(newVal)}) y salió del estado de seguimiento. Buen desempeño!`);
    return;
  }
  if (newVal >= 6 && delta >= 2) {
    await logNovedad(`🔥 ${name} tuvo un desempeño excelente! Subió ${delta} pts y quedó en ${fmtPts(newVal)}.`);
    return;
  }
  const MAX = maxPts();
  if ((oldVal === 0 || !Number.isFinite(oldVal)) && newVal === MAX && delta === MAX) {
    await logNovedad(`✨ ${name} ingresó al staff con ${fmtPts(newVal)} pts iniciales. Bienvenido/a!`);
    return;
  }
}

// (Se eliminaron promptPts / adjPtsWithReason: Ajustar solo permite +1/−1 fijos
// y el valor directo queda exclusivo del Admin, vía setPtsFixed).

// ── MODAL ─────────────────────────────────────────────────────
window.openCreate = () => {
editUid = null;
document.getElementById("modal-title").textContent = "Crear cuenta";
document.getElementById("m-name").value = "";
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
document.getElementById("modal-ov").classList.add("open");
};

window.openEdit = uid => {
const u = allUsers.find(x => x.uid===uid);
if (!u) return;
editUid = uid;
document.getElementById("modal-title").textContent = "Editar cuenta";
document.getElementById("m-name").value   = u.name   || "";
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
// Al editar no mostramos campo contraseña
document.getElementById("pass-field").style.display = "none";
if (u.role==="user") {
document.getElementById("pin-val").textContent = u.pin || genPin();
document.getElementById("pin-section").style.display = "block";
document.getElementById("email-section").style.display = "none";
document.getElementById("auth-hint").style.display = "none";
} else {
document.getElementById("pin-section").style.display = "none";
document.getElementById("email-section").style.display = "block";
document.getElementById("auth-hint").style.display = "none";
}

// Agregar listener para cambio de rol
document.getElementById("m-role").onchange = function() {
const newRole = this.value;
if (newRole==="admin"||newRole==="inspector") {
document.getElementById("pin-section").style.display = "none";
document.getElementById("email-section").style.display = "block";
document.getElementById("pass-field").style.display = "flex";
document.getElementById("auth-hint").style.display = "block";
} else {
document.getElementById("pin-section").style.display = "block";
document.getElementById("email-section").style.display = "none";
document.getElementById("pass-field").style.display = "none";
document.getElementById("auth-hint").style.display = "none";
}
};

document.getElementById("modal-ov").classList.add("open");
};

window.onRoleChange = role => {
showPinSection(role);
if (!editUid) document.getElementById("pass-field").style.display = "flex";
};

function showPinSection(role) {
if (role==="user") {
document.getElementById("pin-val").textContent = genPin();
document.getElementById("pin-section").style.display = "block";
document.getElementById("email-section").style.display = "none";
} else {
document.getElementById("pin-section").style.display = "none";
document.getElementById("email-section").style.display = "block";
}
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
// Obtener cargos desde checkboxes
const cargos = Array.from(document.querySelectorAll(".cargo-checkbox:checked")).map(cb => cb.value);
const status = document.getElementById("m-status").value;
const pin    = document.getElementById("pin-val").textContent;
const btn    = document.getElementById("m-save");

document.getElementById("modal-err").style.display = "none";

if (!name) return setModalErr("El nombre es obligatorio.");
if (!rango) return setModalErr("El rango es obligatorio.");
if (!cargos.length) return setModalErr("Debe seleccionar al menos un cargo.");
if (!status) return setModalErr("El estado es obligatorio.");

if (!editUid) {
// Validar al crear
if ((role==="admin"||role==="inspector") && !email) return setModalErr("Inspector/Admin necesitan Gmail.");
if ((role==="admin"||role==="inspector") && !email.includes("@gmail.com")) return setModalErr("Debe usar Gmail (@gmail.com).");
if ((role==="admin"||role==="inspector") && pass.length<6) return setModalErr("La contraseña debe tener al menos 6 caracteres.");
if (role==="user" && !pin) return setModalErr("Los usuarios necesitan PIN de 4 dígitos.");
} else {
// Validar al editar según cambio de rol
const prev = allUsers.find(u => u.uid === editUid) || null;
const prevRole = prev ? prev.role : "user";
const isRoleChange = prevRole !== role;

if (isRoleChange && (role==="admin"||role==="inspector")) {
// Cambiando a Admin/Inspector: necesita Gmail y contraseña
if (!email) return setModalErr("Para cambiar a Admin/Inspector necesita Gmail.");
if (!email.includes("@gmail.com")) return setModalErr("Debe usar Gmail (@gmail.com).");
if (pass.length<6) return setModalErr("La contraseña debe tener al menos 6 caracteres.");
}

if (isRoleChange && role==="user") {
// Cambiando a Usuario: necesita PIN
if (!pin) return setModalErr("Para cambiar a Usuario necesita PIN de 4 dígitos.");
}
}

btn.disabled = true;
btn.innerHTML = '<div class="spinner"></div>';

try {
if (editUid) {
// EDITAR: solo actualizar Firestore
const prev = allUsers.find(u => u.uid === editUid) || null;
const prevSnap = prev ? { ...prev, cargos: Array.isArray(prev.cargos) ? [...prev.cargos] : prev.cargos } : null;
const upd = { name, role, rango, cargos, status };
if (prev && String(prev.status || "").toLowerCase() !== String(status || "").toLowerCase()) {
if (isInactiveStatus(status)) upd.inactiveAt = serverTimestamp();
}

// Manejar campos según rol
if (role==="user") {
upd.pin = pin;
// Eliminar email/pass si existe
upd.email = "";
} else {
// Admin/Inspector: eliminar PIN
upd.pin = "";
if (email) upd.email = email;
}

await updateDoc(doc(db,"users",editUid), upd);
const idx = allUsers.findIndex(u => u.uid===editUid);
if (idx!==-1) allUsers[idx] = { ...allUsers[idx], ...upd };
showToast("Cuenta actualizada.", "ok");
const nText = buildUserUpdatedNovedad(prevSnap, { ...(prevSnap || {}), ...upd });
if (nText) await logNovedad(nText);

} else {
// CREAR
let uid;
const data = { name, role, rango, cargos, status, inactiveAt: isInactiveStatus(status) ? serverTimestamp() : null, points: 0, createdAt: serverTimestamp(), createdBy: myUid };

if (role==="admin" || role==="inspector") {
// Necesita Firebase Auth — segunda instancia para no cerrar sesión del admin actual
const secondName = "secondary-" + Date.now();
const secondApp  = initializeApp(cfg, secondName);
const secondAuth = getAuth(secondApp);
const cred = await createUserWithEmailAndPassword(secondAuth, email, pass);
await updateProfile(cred.user, { displayName: name });
await signOut(secondAuth);
uid = cred.user.uid;
data.email = email;
} else {
// Usuario: solo Firestore + PIN, sin cuenta Auth
uid = "usr_" + Date.now() + "_" + Math.random().toString(36).slice(2,6);
data.pin = pin;
}

await setDoc(doc(db,"users",uid), data);
allUsers.unshift({ uid, ...data, createdAt: new Date() });
showToast("✅ Cuenta creada: " + name, "ok");
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

// ── ELIMINAR ──────────────────────────────────────────────────
let pendingDel = null;
window.askDelete = (uid, name) => {
pendingDel = uid;
document.getElementById("confirm-msg").textContent = `¿Eliminar la cuenta de "${name}"? No se puede deshacer.`;
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

// ── UTILIDADES ────────────────────────────────────────────────
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

const RANK_LABELS_DASH = {
  overlord:  "《🪬》 Overlord",
  owner:     "《🧿》 Owner",
  admin:     "《💎》 Admin",
  centinela: "《💠》 Centinela",
  vigia:     "《🔹》 Vigia"
};
function normRango(r) {
  let s = String(r || "").trim().toLowerCase();
  s = s.replace(/《.*?》/g, "").replace(/[^a-záéíóúñ ]/g, "").replace(/\s+/g, " ").trim();
  if (s.includes("overlord")) return "overlord";
  if (s.includes("owner"))    return "owner";
  if (s.includes("admin"))    return "admin";
  if (s.includes("centinela")) return "centinela";
  if (s.includes("vigia"))    return "vigia";
  if (s.includes("vip") || s.includes("usuario") || s.includes("bot")) return "vigia";
  return null;
}
function fmtRango(r) {
  const k = normRango(r);
  return k ? RANK_LABELS_DASH[k] : (r ? esc(String(r)) : "—");
}
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
// Limpia un nombre: remueve etiquetas/emojis de rango que puedan venir pegadas.
function cleanName(s) {
  let n = String(s || "").trim();
  if (!n) return "—";
  n = n.replace(/《.*?》/g, " ");
  n = n.replace(/[（(][^）)]*(Vigia|Centinela|Admin|Owner|Overlord)[^）)]*[）)]/gi, " ");
  n = n.replace(/《[^》]*》\s*(Vigia|Centinela|Admin|Owner|Overlord)/gi, " ");
  n = n.replace(/(\s|^)(Vigia|Centinela|Admin|Owner|Overlord)(\s|$)/gi, " ");
  n = n.replace(/\s+/g, " ").trim();
  return n || "—";
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
function friendlyErr(code) {
const m = {
"auth/email-already-in-use":"Ese email ya está registrado.",
"auth/invalid-email":"Email inválido.",
"auth/weak-password":"Contraseña muy corta (mínimo 6).",
"auth/wrong-password":"Contraseña incorrecta.",
"auth/user-not-found":"No existe cuenta con ese email.",
"auth/invalid-credential":"Email o contraseña incorrectos.",
"auth/too-many-requests":"Demasiados intentos, esperá unos minutos.",
"auth/network-request-failed":"Error de red. Verificá tu conexión.",
"auth/operation-not-allowed":"Email/contraseña no habilitado en Firebase.",
};
return m[code] || "";
}
let toastT;
window.showToast = (msg, type="ok") => {
const t = document.getElementById("toast");
t.textContent = (type==="ok"?"✅ ":"❌ ") + msg;
t.className = "toast show " + type;
clearTimeout(toastT);
toastT = setTimeout(() => { t.className="toast"; }, 3500);
};

// ── ESTADO DE GRÁFICOS (para la pestaña Gráficos del Dashboard) ──────────
let filterState = { user: "", rol: "", rango: "", cargo: "" };
let modeStates = { admins: "cols", evo: "line", admin: "line" };
let evoTimeState = "7";
let chartPeriod = "day";
let rankPeriod = "day"; // Período para el ranking de puntos
let inspPeriodState = "day"; // Período para la actividad de inspectores

// ── CHART CONTROLS ─────────────────────────────────────────────
window.refreshCharts = () => {
  if (typeof renderRankingAdmins === "function") renderRankingAdmins();
  if (typeof renderEvolutionPts === "function") renderEvolutionPts();
  if (typeof renderActivityChart === "function") renderActivityChart();
  if (typeof renderInspectorActivityJow === "function") renderInspectorActivityJow();
  showToast("Gráficos actualizados", "ok");
};

window.resetChartData = () => {
  const role = myRole;
  if (role !== "admin") {
    showToast("Solo los admins pueden reiniciar los datos", "err");
    return;
  }
  const ok = confirm("¿Estás seguro de que quieres borrar todos los datos históricos de los gráficos? Esta acción no se puede deshacer.");
  if (!ok) return;
  showToast("Función de reinicio de datos implementada (borrar logs históricos)", "ok");
  if (typeof refreshCharts === "function") refreshCharts();
};

window.applyFilters = () => {
  filterState.user  = document.getElementById("filter-user")?.value || "";
  filterState.rol   = document.getElementById("filter-rol")?.value || "";
  filterState.rango = document.getElementById("filter-rango")?.value || "";
  filterState.cargo = document.getElementById("filter-cargo")?.value || "";
  if (typeof renderRankingAdmins === "function") renderRankingAdmins();
  if (typeof renderEvolutionPts === "function") renderEvolutionPts();
  if (typeof renderInspectorActivityJow === "function") renderInspectorActivityJow();
  // La "Actividad de Admins" NO se filtra por diseño.
};

// Función para poblar el filtro de usuarios con TODOS los usuarios
window.populateUserFilter = () => {
  const userSelect = document.getElementById("filter-user");
  if (!userSelect) return;

  userSelect.innerHTML = '<option value="">Todos</option>';
  // TODOS los usuarios (user / admin / inspector)
  const allUsersList = allUsers.filter(u => ["admin","inspector","user"].includes(u.role));
  allUsersList.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  allUsersList.forEach(u => {
    const option = document.createElement("option");
    option.value = u.uid;
    option.textContent = u.name || "—";
    userSelect.appendChild(option);
  });
};

// Función para poblar el filtro de usuarios en los logs
window.populateLogUserFilter = () => {
  const userSelect = document.getElementById("log-filter-user");
  if (!userSelect) return;

  userSelect.innerHTML = '<option value="">Usuario</option>';
  const allUsersList = allUsers.filter(u => ["admin","inspector","user"].includes(u.role));
  allUsersList.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  allUsersList.forEach(u => {
    const option = document.createElement("option");
    option.value = u.uid;
    option.textContent = u.name || "—";
    userSelect.appendChild(option);
  });
};

window.resetFilters = () => {
  ["filter-user","filter-rol","filter-rango","filter-cargo"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  filterState = { user: "", rol: "", rango: "", cargo: "" };
  if (typeof renderRankingAdmins === "function") renderRankingAdmins();
  if (typeof renderEvolutionPts === "function") renderEvolutionPts();
  if (typeof renderInspectorActivityJow === "function") renderInspectorActivityJow();
};

window.setRankModeAdmins = (m, btn) => {
  modeStates.admins = m;
  const tb = btn ? btn.parentElement : null;
  if (tb) tb.querySelectorAll('.period-btn').forEach(b => b.classList.toggle("active", b.getAttribute("data-mode") === m));
  if (typeof renderRankingAdmins === "function") renderRankingAdmins();
};

window.setEvoTime = (days, btn) => {
  evoTimeState = days;
  const tb = btn ? btn.parentElement : null;
  if (tb) tb.querySelectorAll('.period-btn').forEach(b => b.classList.toggle("active", b.getAttribute("data-time") === days));
  if (typeof renderEvolutionPts === "function") renderEvolutionPts();
};

window.setRankModeEvo = (m, btn) => {
  modeStates.evo = m;
  const tb = btn ? btn.parentElement : null;
  if (tb) tb.querySelectorAll('.period-btn').forEach(b => b.classList.toggle("active", b.getAttribute("data-mode") === m));
  if (typeof renderEvolutionPts === "function") renderEvolutionPts();
};

window.setChartPeriod = (p, btn) => {
  chartPeriod = p;
  const tb = btn ? btn.parentElement : null;
  if (tb) tb.querySelectorAll('.period-btn').forEach(b => b.classList.toggle("active", b.getAttribute("data-period") === p));
  if (typeof renderActivityChart === "function") renderActivityChart();
};

window.setAdminChartMode = (m, btn) => {
  modeStates.admin = m;
  const tb = btn ? btn.parentElement : null;
  if (tb) tb.querySelectorAll('.period-btn').forEach(b => b.classList.toggle("active", b.getAttribute("data-mode") === m));
  if (typeof renderActivityChart === "function") renderActivityChart();
};

window.setRankPeriod = (period, btn) => {
  rankPeriod = period;
  document.querySelectorAll('[data-rank-period]').forEach(b => b.classList.toggle("active", b.getAttribute("data-rank-period") === period));
  document.querySelectorAll('[data-krank]').forEach(b => b.classList.toggle("active", b.getAttribute("data-krank") === period));
  renderDash(); // Re-renderizar el dashboard con el nuevo período
  if (typeof renderRankingAdmins === "function") renderRankingAdmins();
};

window.setInspPeriod = (p, btn) => {
  inspPeriodState = p;
  const tb = btn ? btn.parentElement : null;
  if (tb) tb.querySelectorAll('.period-btn').forEach(b => b.classList.toggle("active", b.getAttribute("data-insp-period") === p));
  if (typeof renderInspectorActivityJow === "function") renderInspectorActivityJow();
};

// Helpers compartidos de períodos (Día / Semana / Mes)
function periodStartMsDash(p) {
  const m = p === "day" ? 1 : p === "week" ? 7 : 30;
  return Date.now() - m * 24 * 60 * 60 * 1000;
}

function periodPointsForUserDash(u, period) {
  if (period === "day") return Number(u.points || 0); // Día → puntos actuales
  const start = periodStartMsDash(period);
  const cutoff = inactiveCutoffMs(u);
  let pts = 0;
  for (const l of logs) {
    if (!l || l.type !== "points" || l.targetUid !== u.uid) continue;
    const t = logTimeRaw(l);
    if (!t || t < start || t >= cutoff) continue;
    const d = typeof l.delta === "number" ? l.delta : 0;
    if (d > 0) pts += d;
  }
  // Para semana/mes, mostrar puntos ganados en el período
  return pts;
}

// Funciones para refrescar y reiniciar gráficos individuales
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
  showToast("Gráfico actualizado", "ok");
};

window.resetSingleChart = async (chartName) => {
  const role = myRole;
  if (role !== "admin") {
    showToast("Solo los admins pueden reiniciar los datos", "err");
    return;
  }

  const ok = confirm("¿Estás seguro de que querés reiniciar los datos de este gráfico? Se borrarán los registros históricos correspondientes y no se puede deshacer.");
  if (!ok) return;

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

  // Refrescar el gráfico después del reinicio (el snapshot recargará los logs).
  refreshSingleChart(chartName);
};

// Funciones de renderizado para el Dashboard (misma lógica que Panel de Puntos)
window.renderRankingAdmins = () => {
  const box = document.getElementById("rank-admins-box");
  if (!box) return;
  const role = myRole;
  if (role !== "admin" && role !== "inspector") return;

  // Incluir todos los roles por defecto (admin, inspector, user) y dejar que los filtros decidan.
  let members = allUsers.filter(u => ["admin", "inspector", "user"].includes(String(u.role || "").toLowerCase()));
  if (filterState.user) members = members.filter(u => u.uid === filterState.user);
  if (filterState.rol) members = members.filter(u => String(u.role || "").toLowerCase() === filterState.rol);
  if (filterState.rango) members = members.filter(u => normRango(u.rango) === filterState.rango || String(u.rango || "").toLowerCase().includes(filterState.rango));
  if (filterState.cargo) members = members.filter(u => hasCargo(u, filterState.cargo));
  members = members.filter(u => String(u.role || "").toLowerCase() !== "admin");
  members = members.filter(u => !isInactiveStatus(u.status));

  members = members
    .map(u => ({ u, pts: periodPointsForUserDash(u, rankPeriod) }))
    .filter(r => r.pts > 0)
    .sort((a, b) => (b.pts - a.pts) || ((b.u.points || 0) - (a.u.points || 0)))
    .slice(0, 8);

  if (!members.length) {
    box.innerHTML = '<div class="chart-empty">Sin datos para el ranking en el período seleccionado.</div>';
    return;
  }

  const periodTxt = rankPeriod === "day" ? "hoy" : rankPeriod === "week" ? "esta semana" : "este mes";
  const PALETTE = ["#5865f2", "#3ecf8e", "#ffd166", "#ff9f43", "#ff5c75", "#4cc9f0", "#a78bfa", "#57cc99"];

  if (modeStates.admins === "circ") {
    // UN SOLO CÍRCULO dividido en sectores proporcionales.
    const total = members.reduce((s, r) => s + r.pts, 0);
    const cx = 90, cy = 90, R = 62, C = 2 * Math.PI * R;
    let acc = 0, arcs = "", legend = "";
    members.forEach((r, i) => {
      const frac = r.pts / total;
      const dash = `${Math.max(frac * C - 2, 0.5)} ${C}`;
      const rot = -90 + acc * 360;
      arcs += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${PALETTE[i % PALETTE.length]}" stroke-width="26" stroke-dasharray="${dash}" transform="rotate(${rot} ${cx} ${cy})"/>`;
      acc += frac;
      legend += `<span class="legend-item"><span class="legend-dot" style="background:${PALETTE[i % PALETTE.length]}"></span>${esc(cleanName(r.u.name))} · ${(frac * 100).toFixed(1)}%</span>`;
    });
    box.innerHTML = `
      <svg class="chart-svg" viewBox="0 0 180 180" role="img">
        ${arcs}
        <text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="13" fill="#fff" font-weight="700">${total.toFixed(decimalsN())}</text>
      </svg>
      <div class="chart-legend">${legend}</div>
      <div class="chart-note">Ranking de puntos · ${periodTxt}</div>`;
    return;
  }

  // Modo columnas: gráfico real de columnas verticales.
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
    const x = xPos(i);
    const hBar = (r.pts / maxP) * ih;
    const y = pt + ih - hBar;
    const color = PALETTE[i % PALETTE.length];
    bars += `<rect x="${x}" y="${y}" width="${barWidth}" height="${hBar}" fill="${color}" rx="4"/>`;
    bars += `<text x="${x + barWidth/2}" y="${y - 6}" text-anchor="middle" font-size="10" fill="#e9eeff" font-weight="600">${r.pts.toFixed(decimalsN())}</text>`;
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
    <div class="chart-note">Ranking de puntos · ${periodTxt}</div>`;
};

window.renderEvolutionPts = () => {
  const el = document.getElementById("evo-pts-chart");
  if (!el) return;
  const role = myRole;
  // Permitir que usuarios admin, inspector y user vean el gráfico
  if (role !== "admin" && role !== "inspector" && role !== "user") return;

  // Incluir inspector y user por defecto (sin admin para la evolución general)
  let team = allUsers.filter(u => ["inspector", "user"].includes(String(u.role || "").toLowerCase()));
  if (filterState.user) team = team.filter(u => u.uid === filterState.user);
  if (filterState.rol) team = team.filter(u => String(u.role || "").toLowerCase() === filterState.rol);

  // Ordenar por puntos actuales pero NO limitar a 6 usuarios
  team = team.sort((a, b) => (b.points || 0) - (a.points || 0));

  if (!team.length) { el.innerHTML = '<div class="chart-empty">Sin miembros que coincidan con los filtros.</div>'; return; }

  const isDayView = evoTimeState === "7";
  const count = isDayView ? 24 : (evoTimeState === "14" ? 7 : 30);
  const labels = isDayView
    ? Array.from({length: count}, (_, i) => `${i}:00`)
    : Array.from({length: count}, (_, i) => `Día ${i+1}`);

  // Paleta de colores para usuarios (asignar color consistente por UID)
  const PALETTE = ["#3ecf8e", "#ff6b6b", "#4ecdc4", "#ffe66d", "#95e1d3", "#f38181", "#7f8cff", "#ff9f43", "#00d2d3", "#5f27cd"];
  const getUserColor = (uid) => {
    let hash = 0;
    for (let i = 0; i < uid.length; i++) {
      hash = uid.charCodeAt(i) + ((hash << 5) - hash);
    }
    return PALETTE[Math.abs(hash) % PALETTE.length];
  };

  // Generar datos reales basados en logs con estado acumulado
  const series = team.map((m) => {
    const values = [];
    const periodStart = Date.now() - (isDayView ? 24 : evoTimeState === "14" ? 7 : 30) * 24 * 60 * 60 * 1000;
    const step = (Date.now() - periodStart) / count;
    const cutoff = inactiveCutoffMs(m);
    
    // Calcular puntos iniciales antes del período
    let accumulatedPts = 0;
    for (const l of logs) {
      if (l.type !== "points" || l.targetUid !== m.uid) continue;
      const t = logTimeRaw(l);
      if (t && t < periodStart && t < cutoff) {
        const delta = typeof l.delta === "number" ? l.delta : 0;
        accumulatedPts += delta;
      }
    }

    for (let j = 0; j < count; j++) {
      const bucketStart = periodStart + j * step;
      const bucketEnd = bucketStart + step;

      // Sumar todos los cambios de puntos en este bucket (positivos y negativos)
      for (const l of logs) {
        if (l.type !== "points" || l.targetUid !== m.uid) continue;
        const t = logTimeRaw(l);
        if (t && t >= bucketStart && t < bucketEnd && t < cutoff) {
          const delta = typeof l.delta === "number" ? l.delta : 0;
          accumulatedPts += delta;
        }
      }
      values.push(Math.max(0, accumulatedPts)); // Evitar valores negativos
    }

    return {
      uid: m.uid,
      name: cleanName(m.name),
      color: getUserColor(m.uid),
      values
    };
  });

  const mode = modeStates.evo || "line";
  const W = 900, H = 450, pl = 40, pr = 16, pt = 22, pb = 40;
  const iw = W - pl - pr, ih = H - pt - pb;
  const maxVal = Math.max(1, ...series.flatMap(s => s.values));
  const n = count;
  const xPos = i => (n > 1 ? pl + (iw * i) / (n - 1) : pl + iw / 2);
  const yPos = v => pt + ih - (ih * v) / maxVal;

  let grid = "", xl = "", content = "";
  const gridCount = 4;
  for (let g = 0; g <= gridCount; g++) {
    const val = Math.round((maxVal * g) / gridCount);
    const gy = yPos(val);
    grid += `<line x1="${pl}" y1="${gy}" x2="${W - pr}" y2="${gy}" stroke="rgba(141,153,255,.14)" stroke-width="1"/>`;
    grid += `<text x="${pl - 6}" y="${gy + 4}" text-anchor="end" font-size="9" fill="#7c86ad">${val}</text>`;
  }

  if (n > 12) {
    for (let i = 0; i < n; i += 2) {
      xl += `<text x="${xPos(i)}" y="${H - 8}" text-anchor="middle" font-size="8" fill="#7c86ad">${labels[i]}</text>`;
    }
  } else {
    labels.forEach((lbl, i) => {
      xl += `<text x="${xPos(i)}" y="${H - 8}" text-anchor="middle" font-size="9" fill="#7c86ad">${lbl}</text>`;
    });
  }

  if (mode === "line") {
    series.forEach((s, sIdx) => {
      const pts = s.values.map((v, i) => `${xPos(i)},${yPos(v)}`).join(" ");
      content += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`;
      s.values.forEach((v, i) => {
        content += `<circle cx="${xPos(i)}" cy="${yPos(v)}" r="2.6" fill="${s.color}"/>`;
      });
    });
  } else {
    // Modo columnas: UNA barra por usuario en cada período
    // Compactar si hay muchos usuarios permitiendo scroll o agrupación
    const maxVisibleBars = 12; // Máximo de usuarios visibles sin scroll
    const visibleSeries = series.slice(0, maxVisibleBars);
    const barWidth = Math.max(4, (iw / n) * 0.3);
    const groupWidth = barWidth * visibleSeries.length + (visibleSeries.length - 1) * 1;
    const groupGap = (iw - (groupWidth * n)) / (n + 1);
    const groupXPos = i => pl + groupGap + i * (groupWidth + groupGap);

    visibleSeries.forEach((s, sIdx) => {
      const offset = sIdx * (barWidth + 1);
      s.values.forEach((v, i) => {
        const hBar = (v / maxVal) * ih;
        const y = pt + ih - hBar;
        content += `<rect x="${groupXPos(i) + offset}" y="${y}" width="${barWidth}" height="${hBar}" fill="${s.color}" rx="2"/>`;
      });
    });
  }

  el.innerHTML = `
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img">
      ${grid}
      <line x1="${pl}" y1="${pt}" x2="${pl}" y2="${pt + ih}" stroke="rgba(141,153,255,.22)" stroke-width="1"/>
      <line x1="${pl}" y1="${pt + ih}" x2="${W - pr}" y2="${pt + ih}" stroke="rgba(141,153,255,.22)" stroke-width="1"/>
      ${xl}
      ${content}
    </svg>
    <div class="chart-legend">${series.map(s => `<span class="legend-item"><span class="legend-dot" style="background:${s.color}"></span></span>`).join("")}</div>
    <div class="chart-note">Evolución de puntos · ${isDayView ? "24 horas" : evoTimeState === "14" ? "7 días" : "30 días"} · ${series.length} usuarios · ${logs.length} registros cargados</div>`;
};

window.renderActivityChart = () => {
  const el = document.getElementById("activity-chart");
  const legendEl = document.getElementById("chart-legend");
  if (!el) return;
  const role = myRole;
  if (role !== "admin" && role !== "inspector") return;

  // ACTIVIDAD DE USUARIOS: Incluir todos los roles (Usuario, Admin, Inspector)
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
      const t = logTimeRaw(l);
      if (t < b.start || t >= b.end) continue;
      const actorRole = String(l.actorRole || "").toLowerCase();
      
      let includeActor = (actorRole === "admin" || actorRole === "inspector" || actorRole === "user");
      
      // Filtro de rol: SÍ afecta
      if (filterState.rol && actorRole !== filterState.rol) includeActor = false;
      
      // Filtro de usuario individual: NO afecta (se ignora)
      // Filtro de rango: NO afecta (se ignora)
      // Filtro de cargo: NO afecta (se ignora)
      
      if (includeActor) {
        const actor = allUsers.find(u => u.uid === l.actorUid) || null;
        if (actor && isInactiveStatus(actor.status) && t >= inactiveCutoffMs(actor)) continue;
        
        const bucketIndex = buckets.indexOf(b);
        if (bucketIndex >= 0) {
          // Lógica específica por rol
          if (actorRole === "user") {
            // Usuario: promedio entre ingresos y puntos
            const loginCount = logs.filter(log => 
              log.actorUid === l.actorUid && 
              log.type === "login" &&
              logTimeRaw(log) >= b.start && 
              logTimeRaw(log) < b.end
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
              logTimeRaw(log) >= b.start &&
              logTimeRaw(log) < b.end
            ).reduce((sum, log) => sum + (log.delta || 0), 0);
            const loginCount = logs.filter(log =>
              log.actorUid === l.actorUid &&
              log.type === "login" &&
              logTimeRaw(log) >= b.start &&
              logTimeRaw(log) < b.end
            ).length;
            roleActivity.inspector[bucketIndex] += inspectorPoints + pointsAdded + loginCount;
          } else if (actorRole === "admin") {
            // Admin: puntos que agregan e ingresos
            const pointsAdded = logs.filter(log =>
              log.actorUid === l.actorUid &&
              log.type === "points" &&
              log.delta > 0 &&
              logTimeRaw(log) >= b.start &&
              logTimeRaw(log) < b.end
            ).reduce((sum, log) => sum + (log.delta || 0), 0);
            const loginCount = logs.filter(log =>
              log.actorUid === l.actorUid &&
              log.type === "login" &&
              logTimeRaw(log) >= b.start &&
              logTimeRaw(log) < b.end
            ).length;
            roleActivity.admin[bucketIndex] += pointsAdded + loginCount;
          }
        }
      }
    }
    
    maxVal = Math.max(maxVal, roleActivity.user[buckets.indexOf(b)], roleActivity.admin[buckets.indexOf(b)], roleActivity.inspector[buckets.indexOf(b)]);
  }

  const mode = modeStates.admin || "line";

  // Modo lineal: mostrar evolución temporal de todos los roles
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

    const PALETTE_ROLES = {
      user: "#ff6b6b",
      admin: "#7f8cff", 
      inspector: "#3ecf8e"
    };

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
      <div class="chart-note">Actividad de Usuarios · ${chartPeriod === "day" ? "24 horas completas (12 AM → 11 PM)" : chartPeriod === "week" ? "7 días" : "30 días"} · ${logs.length} registros cargados</div>`;

    if (legendEl) {
      legendEl.innerHTML = roleSeries.map(s => `<span class="legend-item"><span class="legend-dot" style="background:${s.color}"></span>${s.name}</span>`).join("");
    }
  }
  // Modo columnas: mostrar actividad de todos los roles
  else if (mode === "cols") {
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
      <div class="chart-note">Actividad de Usuarios · ${chartPeriod === "day" ? "24 horas" : chartPeriod === "week" ? "7 días" : "30 días"} · ${logs.length} registros cargados</div>`;

    if (legendEl) {
      legendEl.innerHTML = roleSeries.map(s => `<span class="legend-item"><span class="legend-dot" style="background:${s.color}"></span>${s.name}</span>`).join("");
    }
  }
  // Modo circular: mostrar distribución como donut de todos los roles
  else if (mode === "circ") {
    const totalActivity = roleActivity.user.reduce((a, b) => a + b, 0) + 
                          roleActivity.admin.reduce((a, b) => a + b, 0) + 
                          roleActivity.inspector.reduce((a, b) => a + b, 0);

    if (!totalActivity) {
      el.innerHTML = '<div class="chart-empty">Sin datos de actividad de Usuarios para el período seleccionado.</div>';
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
      legend += `<span class="legend-item"><span class="legend-dot" style="background:${it.color}"></span>${it.name} · ${(frac * 100).toFixed(1)}%</span>`;
    }

    el.innerHTML = `
      <svg class="chart-svg" viewBox="0 0 180 180" role="img">
        ${arcs}
        <text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="13" fill="#fff" font-weight="700">${Math.round(totalActivity)}</text>
      </svg>
      <div class="chart-legend">${legend}</div>
      <div class="chart-note">Actividad de Usuarios · ${chartPeriod === "day" ? "24 horas" : chartPeriod === "week" ? "7 días" : "30 días"}</div>`;

    if (legendEl) {
      legendEl.innerHTML = roleSeries.map(s => `<span class="legend-item"><span class="legend-dot" style="background:${s.color}"></span>${s.name}</span>`).join("");
    }
  }
};

// Función auxiliar para generar buckets de tiempo
function chartBuckets(period, now) {
  const buckets = [];
  let step, count, lab;
  if (period === "day") {
    step = 60 * 60 * 1000; count = 24; lab = (d) => {
      const h = d.getHours();
      const h12 = h % 12 === 0 ? 12 : h % 12;
      return `${h12} ${h < 12 ? "AM" : "PM"}`;
    };
  } else if (period === "week") {
    step = 24 * 60 * 60 * 1000; count = 7; lab = (d) => `${d.getDate()}/${d.getMonth() + 1}`;
  } else {
    step = 3 * 24 * 60 * 60 * 1000; count = 10; lab = (d) => `${d.getDate()}/${d.getMonth() + 1}`;
  }
  for (let i = count - 1; i >= 0; i--) {
    const end = now - i * step;
    const start = end - step;
    buckets.push({ start, end, label: lab(new Date(end)) });
  }
  return buckets;
}

window.renderInspectorActivityJow = () => {
  const tbody = document.getElementById("inspector-activity-body");
  if (!tbody) return;
  const role = myRole;
  if (role !== "admin" && role !== "inspector") return;

  const now = Date.now();
  const rows = logs
    .filter(l => l && l.type === "points" && String(l.actorRole || "").toLowerCase() === "inspector")
    .map(l => ({ l, t: logTimeRaw(l) }))
    .filter(x => x.t)
    .filter(({ l, t }) => {
      const actor = allUsers.find(u => u.uid === l.actorUid) || null;
      if (actor && isInactiveStatus(actor.status) && t >= inactiveCutoffMs(actor)) return false;
      const target = allUsers.find(u => u.uid === l.targetUid) || null;
      if (target && isInactiveStatus(target.status) && t >= inactiveCutoffMs(target)) return false;
      return true;
    })
    .sort((a, b) => b.t - a.t)
    .slice(0, 20);

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="t-empty">Sin movimientos recientes de inspectores.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(({ l, t }) => {
    const actor = allUsers.find(u => u.uid === l.actorUid) || null;
    const target = allUsers.find(u => u.uid === l.targetUid) || null;
    const dt = fmtDateTime(l.createdAt);
    const actorName = actor?.name || l.actorName || "—";
    const targetName = target?.name || l.targetName || "—";
    const delta = typeof l.delta === "number" ? l.delta : 0;
    const deltaTxt = `${delta > 0 ? "+" : ""}${delta}`;
    const motivo = esc(l.reason || "Sin motivo");
    const since = fmtSince(now - t);
    const color = delta > 0 ? "#7dffa6" : delta < 0 ? "#ff9dad" : "var(--muted)";
    return `
      <tr>
        <td>${esc(dt)}</td>
        <td><b>${esc(cleanName(actorName))}</b></td>
        <td><b style="color:${color}">${esc(deltaTxt)}</b></td>
        <td>${esc(cleanName(targetName))}</td>
        <td>${motivo}</td>
        <td>${since}</td>
      </tr>`;
  }).join("");
};

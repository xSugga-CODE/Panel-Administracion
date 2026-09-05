# Actualización y Corrección del Sistema — Plan de Implementación

## Task 0: Seguridad Login PIN — Backend firebase-admin + hashing pbkdf2 + Frontend signInWithCustomToken
- **Status**: `pending`
- **Priority**: high
- **Depends On**: None
- **Description**:
  **A) Backend (`jow/backend/server.js`)**:
    1. Instalar `firebase-admin` via `npm install firebase-admin dotenv` en package.json jow/.
    2. Inicializar Admin SDK:
       ```js
       const admin = require('firebase-admin');
       const serviceAccount = process.env.GOOGLE_APPLICATION_CREDENTIALS
         ? require(process.env.GOOGLE_APPLICATION_CREDENTIALS)
         : (() => { try { return require('./service-account-key.json'); } catch { return null; } })();
       if (serviceAccount) admin.initializeApp({ credential: admin.credential.cert(serviceAccount), ...cfg });
       else admin.initializeApp(); // si corre en GCP con default service account
       const dbFS = admin.firestore();
       ```
    3. Reemplazar endpoints legacy SQLite `login-pin` (mantener por compatibilidad si queremos, pero agregar NUEVOS):
       - `POST /api/auth/pin`:
         - body `{name: string, pin: string}`
         - Buscar en Firestore `users` por `nameLower` == normalizeName(name). Limit 1.
         - Si no existe doc → 401 "Credenciales inválidas" (sin información extra).
         - Si `status === 'inactive'` → 403 "Cuenta inactiva".
         - Validar PIN:
           - Si existe `pinHash` y `pinSalt`: `safeEq( hashPinServerSide(pin, pinSalt), pinHash )`. (hashPinServerSide usa pbkdf2Sync 200000 iters, sha256, 32bytes, hex como lo hace actualmente la función existente del server).
           - Sino (legacy `pin` texto plano): `safeEq( String(doc.pin), pin )`. Si OK → MIGRACIÓN EN EL MISMO WRITE:
             ```js
             const salt = makeSalt();
             const nextHash = hashPinServerSide(pin, salt);
             await docRef.update({ pinHash: nextHash, pinSalt: salt, pin: admin.firestore.FieldValue.delete() });
             ```
         - Si validación OK:
           ```js
           const customToken = await admin.auth().createCustomToken(docId);
           res.json({
             ok: true,
             customToken,
             uid: docId,
             user: { uid: docId, name: doc.name || name, role: doc.role || 'user', rango: doc.rango || null, points: Number(doc.points || 0), status: doc.status || 'active' }
           });
           ```
       - `POST /api/auth/migrate-all-pins` (admin only, header `X-Admin-Key` valor de `process.env.ADMIN_MIGRATION_KEY` o similar):
         - Recorre TODOS los docs users con `pin` existente. Migra a hash + salt + borra `pin`. Devuelve `{migrated: N, skipped: M}`.
  **B) Frontend jow/script.js**:
    1. En loginWithPin():
       - Agregar banner warning ROJO en `#login-err` o en un elemento nuevo `#pin-security-warn` antes de cualquier intento, si el host NO incluye backend (endpoint /api/auth/pin no responde). Chequear:
         ```js
         // Primero probar API segura
         const API_BASE = window.location.port === '3000' ? window.location.origin : (window.__API_BASE__ || null);
         let backendAvailable = false;
         try {
           const probe = await fetch(`${API_BASE}/api/health`, { method: 'GET' });
           backendAvailable = probe.ok;
         } catch { backendAvailable = false; }
         if (!backendAvailable) {
           // Mostrar BANNER WARNING visible en el DOM
           const warn = document.getElementById('pin-security-warn');
           warn.style.display = 'block';
           // Luego: permitir fallback si el usuario insiste (con confirmación)
         }
         ```
       - Si backendAvailable:
         ```js
         const resp = await fetch(`${API_BASE}/api/auth/pin`, {
           method: 'POST', headers: {'Content-Type': 'application/json'},
           body: JSON.stringify({ name: nameRaw, pin })
         });
         const data = await resp.json();
         if (data.ok && data.customToken) {
           await signInWithCustomToken(auth, data.customToken);
           // → onAuthStateChanged agarra el user y sigue el flujo normal. Perfecto.
           return;
         } else {
           showErr(data?.error || 'Credenciales inválidas'); return;
         }
         ```
       - Si NO backendAvailable: Mostrar banner warning y luego: NO usar getDocs(users) completo. Como último recurso para compatibilidad, usar signInAnonymously + sessionStorage con uid buscado por query where nameLower (más seguro que getDocs), O (si no queremos) rechazar con mensaje "Ingrese con email". Mantener compatibilidad con UX actual es importante; pero si el usuario tiene que robar PINes en modo Hosting sin backend, al menos debe estar ADVERTIDO.
    2. Mantener login email tal cual (ya es seguro via Firebase Auth).
- **Acceptance Criteria Addressed**: AC-0, AC-0b
- **Test Requirements**:
  - `rule` TR-0.1: Corriendo `npm start` en :3000. login PIN user con legacy `pin` → doc update: se borra `pin`, se agregan `pinHash` + `pinSalt`. Network tab NO muestra GET /users (solo el fetch al endpoint /api/auth/pin).
  - `rule` TR-0.2: Sin backend, se cambia a tab PIN en login → banner warning rojo visible en el DOM (antes de submit).
  - `rule` TR-0.3: loginWithPin exitoso con backend disponible → signInWithCustomToken se ejecuta; onAuthStateChanged recibe user, onAuthStateChanged bootApp funciona normalmente.

---

## Task 1: Toggle trabajadores destacados + Eliminar texto largo (jow/ y Dashboard compacto)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: None
- **Description**:
  1. **jow/index.html**:
     - Borrar párrafo "Clasificación en tiempo real del MC Team..." (antes de tabla puntos).
     - Encima de `#destacados-section` agregar `<button class="btn-ghost" id="btn-toggle-destacados-jow">Mostrar trabajadores destacados</button>` y hacer que al click:
       ```js
       window.toggleDestacadosJow = () => {
         const sec = document.getElementById('destacados-section');
         const btn = document.getElementById('btn-toggle-destacados-jow');
         const visible = sec.style.display !== 'none' && sec.style.display !== '';
         sec.style.display = visible ? 'none' : 'block';
         btn.textContent = visible ? 'Mostrar trabajadores destacados' : 'Ocultar trabajadores destacados';
       };
       ```
     - Estado inicial destacados-section = `display:none` (mantener).
  2. **index.html (Dashboard page-dashboard)**:
     - Agregar sección compacta después del `.stats` grid y antes del `.tcard` de top por puntos:
       ```html
       <button class="btn btn-ghost btn-sm" id="btn-toggle-destacados-dash" style="margin-bottom:14px">Mostrar trabajadores destacados</button>
       <section id="destacados-dash-section" style="display:none;margin-bottom:22px">
         <div class="tcard" style="padding:16px">
           <h3 style="font-size:14px;margin-bottom:14px">⭐ Destacados</h3>
           <div class="stats" style="margin:0">
             <div class="stat"><div class="slabel">Día</div><div class="sval c-accent" id="dash-dest-day">—</div><div class="dc-period" style="font-size:11px;color:var(--muted);margin-top:3px">Últimas 24h</div></div>
             <div class="stat"><div class="slabel">Semana</div><div class="sval c-purple" id="dash-dest-week">—</div><div class="dc-period" style="font-size:11px;color:var(--muted);margin-top:3px">Últimos 7 días</div></div>
             <div class="stat"><div class="slabel">Mes</div><div class="sval c-warn" id="dash-dest-month">—</div><div class="dc-period" style="font-size:11px;color:var(--muted);margin-top:3px">Últimos 30 días</div></div>
           </div>
         </div>
       </section>
       ```
     - Agregar toggle function al JS inline de index.html para que muestre/oculte y cambie texto.
     - Estado inicial oculto.
- **Acceptance Criteria Addressed**: AC-1, AC-3
- **Test Requirements**:
  - `rule` TR-1.1: Toggle en jow/ funciona (2 clicks). Estado inicial oculto.
  - `rule` TR-1.2: Grep "Clasificación en tiempo real del MC Team" en jow/ y jow/public/ → 0 matches.
  - `rule` TR-1.3: page-dashboard index.html tiene botón toggle y sección destacados compacta.

---

## Task 2: Selector de Rangos Dashboard (5 opciones con emojis) + Guardar
- **Status**: `pending`
- **Priority**: high
- **Depends On**: None
- **Description**:
  1. En `index.html` reemplazar `<select id="m-rango">` actual por:
     ```html
     <select id="m-rango">
       <option value="《🪬》 Overlord">《🪬》 Overlord</option>
       <option value="《🧿》 Owner">《🧿》 Owner</option>
       <option value="《💎》 Admin">《💎》 Admin</option>
       <option value="《💠》 Centinela">《💠》 Centinela</option>
       <option value="《🔹》 Vigia">《🔹》 Vigia</option>
     </select>
     ```
  2. Revisar saveAccount/saveUser() inline JS para asegurar que guarda `rango` campo con el valor completo (con emojis). Si actualmente hace algún `normRango`, cambiarlo para persistir el string completo.
  3. Revisar la parte de load user al abrir el modal editar: debe hacer `m-rango.value = user.rango` (para que quede seleccionado el valor correcto).
- **Acceptance Criteria Addressed**: AC-6
- **Test Requirements**:
  - `rule` TR-2.1: 5 opciones exactas visibles en select, incluyendo "《🔹》 Vigia".
  - `rule` TR-2.2: Asignar Vigia, guardar, refresh tabla → usuario muestra rango "《🔹》 Vigia" y Firestore doc tiene ese valor en rango.

---

## Task 3: Stats rediseñadas (AMBOS paneles) — eliminar Óptimos/Puntos totales, mejorar visualmente
- **Status**: `pending`
- **Priority**: high
- **Depends On**: None
- **Description**:
  **A) jow/index.html + jow/script.js**:
    1. Borrar del DOM las 2 stat-cards: Óptimos (id `staff-optimal`) y Puntos totales (id `total-points`).
    2. Rediseñar las 3 restantes (`total-members`, `avg-points`, `staff-at-risk`):
       - `total-members`: valor grande + subtexto "Inspector X% · Usuario Y% · Otros Z%" (distribución por roles), y una mini-barra stacked de distribución.
       - `avg-points`: valor grande + barra de progreso width% (puntos promedio / MAX_PTS 7). Color según tramos (>=6 verde, 3-5.9 amarillo, <3 rojo).
       - `staff-at-risk`: valor grande + texto "X de N total (Y%)" + círculo color rojo/naranja.
    3. Actualizar renderStats en jow/script.js para llenar estos elementos.
  **B) index.html (page-dashboard stats)**:
     Las 4 actuales (`st-total`, `st-insp`, `st-users`, `st-pts`) → agregar debajo de cada `.sval` un elemento `<div class="saux" style="margin-top:6px;color:var(--muted);font-size:11px"></div>`:
     - Total cuentas: saux = "X inspectores · Y usuarios".
     - Inspectores: saux = barra 100% verde.
     - Usuarios: saux = barra 100% purple.
     - Puntos entregados: saux = "Promedio: X / 7" con mini-barra.
    Agregar CSS o inline styles para las barras (height 4px, border-radius, width% segun valor).
- **Acceptance Criteria Addressed**: AC-5
- **Test Requirements**:
  - `rule` TR-3.1: jow/ stats tienen 3 cards, cero tienen Óptimos/Puntos totales.
  - `rule` TR-3.2: Cada stat card en jow/ tiene más de 2 nodos (no solo label+strong) → barras/subtext existen.
  - `rule` TR-3.3: Dashboard 4 stats tienen saux con info extra visible.
  - `rubric` TR-3.4: Calidad visual stats; escala 1-5, threshold >= 4.

---

## Task 4: Corregir filtros para INCLUIR Inspectores en stats/rankings/tablas
- **Status**: `pending`
- **Priority**: high
- **Depends On**: None
- **Description**:
  1. **jow/script.js**: Buscar TODAS las funciones `renderStats`, `renderPointsTable`, `buildRankingX`, `renderStaffTable`, `renderActivityChart` (y gráficos rank-mc, rank-week, act-worker, evo-pts). Cualquier condición que sea `u.role === 'user'` (incluye solo user) → reemplazar por `u.role !== 'admin'` (incluye user + inspector).
  2. Chequear `isMcTeamWorker(u) = cargos includes "MC team" && u.role !== 'admin'` (ya debería incluir inspectores con ese cargo).
  3. **index.html inline JS**: `renderPointsTable` (page-points), dashboard top-by-points. Aplicar misma regla: métricas operativas de trabajadores excluyen solo `role === 'admin'`. Inspectores aparecen en listados.
- **Acceptance Criteria Addressed**: AC-4
- **Test Requirements**:
  - `rule` TR-4.1: Code review. Ningún filtro operativo usa `u.role === 'user'` para excluir (eso quitaría inspectores). Usan `u.role !== 'admin'` donde corresponde.
  - `rule` TR-4.2: Si hay inspector con points=5 y admin con points=100, el ranking operativo (no admin) muestra al inspector y NO muestra al admin.

---

## Task 5: Gestión de puntos decimales EN AMBOS paneles + botones +/− SEPARADOS + Permisos
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 4
- **Description**:
  **A) index.html (page-points inline JS)**:
    1. Reemplazar la columna "Ajustar" actual (pequeños botoncitos +/- y prompt) por estructura por fila:
       ```html
       <td>
         <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
           <input type="number" step="0.01" min="0" class="pts-input" placeholder="2.5" style="width:80px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:6px 8px;font-size:12px">
           <button class="btn btn-success btn-sm pts-plus">+ Sumar</button>
           <button class="btn btn-danger btn-sm pts-minus">− Restar</button>
         </div>
       </td>
       ```
    2. Event delegación: al click .pts-plus → leer valor de input esa fila, parseFloat, si > 0 → adjPts(uid, +valor). Al click .pts-minus → adjPts(uid, -valor).
    3. Asegurarse en `adjPts/adjPtsWithReason`: NO usar parseInt, usar Number() o parseFloat. NO Math.round al persistir; guardar Number float exacto.
    4. Check permisos: `if (myRole !== 'admin' && myRole !== 'inspector') return;` (ya existe, pero confirmar). También check self = no modificar sus propios puntos.
  **B) jow/script.js renderPointsTable + adjPoints**:
    1. Misma estructura: input step 0.01 + btn +Sumar / −Restar por cada fila (o como interfaz general).
    2. **PERMISOS UI**: Si `currentUser.role === 'user'` → NO renderizar inputs ni botones (solo mostrar los puntos del usuario, tabla lectura completa).
    3. **PERMISOS LÓGICA**: En la función adjPoints, CHEQUEO INICIAL:
       ```js
       function adjPointsJow(uid, delta, reason) {
         if (currentUser?.role !== 'admin' && currentUser?.role !== 'inspector') {
           showToast('Sin permisos para modificar puntos.', 'err'); return;
         }
         if (currentUser?.uid === uid) { showToast('No podés modificar tus propios puntos.', 'err'); return; }
         // ... resto de updateDoc + logs + novedades.
       }
       ```
    4. Ambos paneles → fmtPts actualizado: no redondear forzado; mostrar hasta 2 decimales sin ceros sobrantes.
- **Acceptance Criteria Addressed**: AC-7, AC-8, AC-9, AC-12
- **Test Requirements**:
  - `rule` TR-5.1: Sumo 2.5 → Resto 1.25 → Firestore points = 11.25. Ambos paneles muestran 11.25.
  - `rule` TR-5.2: Rol user en jow/. Llamada manual adjPointsJow por consola → return early sin updateDoc. UI no muestra botones.
  - `rule` TR-5.3: Ambos paneles tienen input step=0.01 y botones + Sumar / − Restar.
  - `rule` TR-5.4: Modificación Dashboard → jow/ recarga muestra mismo valor.

---

## Task 6: Importar Chart.js + Sección "Gráficos" NUEVA dentro de index.html (Dashboard)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 2 (rangos), Task 4 (inspectores)
- **Description**:
  1. `index.html`:
     - `<head>` → agregar `<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>`.
     - Sidebar nav → agregar item: `<div class="nav-item" onclick="goPage('charts')"><span class="ico">📊</span>Gráficos</div>`.
     - `<main>` → agregar `<div class="page" id="page-charts">`:
       - ph: "Gráficos" + "Análisis del staff".
       - Toolbar filtros (flex wrap gap 8):
         ```html
         <div class="tcard" style="padding:14px;margin-bottom:14px">
           <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
             <span style="font-size:12px;color:var(--muted);font-weight:700;letter-spacing:.08em;text-transform:uppercase">Filtros</span>
             <select id="f-cargo" onchange="applyChartFilters()"><option value="">Todos los cargos</option><option value="MC team">MC Team</option><option value="Inspector">Inspector</option><option value="Mod">Mod</option><option value="Colaborador">Colaborador</option><option value="Dev">Dev</option><option value="Editor">Editor</option><option value="Marketing">Marketing</option></select>
             <select id="f-rango" onchange="applyChartFilters()"><option value="">Todos los rangos</option><option>《🪬》 Overlord</option><option>《🧿》 Owner</option><option>《💎》 Admin</option><option>《💠》 Centinela</option><option>《💠》 Vigia</option></select>
             <select id="f-periodo" onchange="applyChartFilters()"><option value="7">Últimos 7 días</option><option value="14" selected>Últimos 14 días</option><option value="30">Últimos 30 días</option></select>
           </div>
         </div>
         ```
       - Grid charts (CSS: `.grid-charts { display:grid;grid-template-columns:repeat(2, 1fr);gap:14px } @media(max-width:680px){ .grid-charts{grid-template-columns:1fr} }`):
         1. Chart-card full-width o mitad: `Evolución actividad (LINEAL)` canvas `chart-evo-act`.
         2. Chart-card: `Ranking puntos por usuario (COLUMNAS)` canvas `chart-rank-pts` + toolbar mini "Columnas / Circular" toggle (botoncitos).
         3. Chart-card: `Actividad por trabajador (COLUMNAS)` canvas `chart-act-worker`.
         4. Chart-card: `Distribución de cargos (CIRCULAR)` canvas `chart-dist-cargos`.
         5. Opcional: `Distribución de rangos (CIRCULAR)` canvas `chart-dist-rangos`.
    2. JS inline index.html:
       - Variables para las instancias: `let charts = { evoAct:null, rankPts:null, actWorker:null, distCargos:null };`.
       - `window.applyChartFilters()`: lee f-cargo, f-rango, f-periodo. Filtra allUsers y logs. Luego actualiza los datasets de charts y llama chart.update().
       - Funciones helpers: `lastNDaysLabels(days)`, `buildActivityFromLogs(filteredLogs, days)`, `buildRankPoints(filteredUsers)`, etc.
       - Importante (AC-2): `chart-evo-act` → `type: 'line'`. `chart-rank-pts` → default `type: 'bar'`. `chart-act-worker` → `type: 'bar'`. `chart-dist-cargos` → `type: 'pie'` o `doughnut`.
- **Acceptance Criteria Addressed**: AC-2, AC-6 (filtros), AC-10
- **Test Requirements**:
  - `rule` TR-6.1: Existe page-charts. Hay al menos 1 line, 2 bar, 1 pie. 3 types distintos presentes.
  - `rule` TR-6.2: Cambio filtro Cargo y Rango simultáneos → arrays filtrados tienen && lógico. Charts cambian datasets (se ve el cambio en al menos 1 gráfico).
  - `rule` TR-6.3: chart-evo-act config.type === 'line'.

---

## Task 7: Gráficos jow panel + restringir vista Usuario SOLO a Ranking + Actividad por día (lineal)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 6, Task 4
- **Description**:
  1. jow/index.html o jow/script.js: asegurar que Chart.js está importado (si no, agregar `<script src="chart..."></script>` en el HTML antes del type=module).
  2. En `graficos-tab`:
     - Agregar mismos filtros Cargo/Rango/Periodo que en Dashboard (toolbar arriba de los charts). Aplicar `applyChartFiltersJow()` que refresca los gráficos existentes.
     - En función `switchTab` o `bootApp`, condición `if (currentUser?.role === 'user')`:
       - Ocultar TODOS los bloques gráficos EXCEPTO 2:
         1. **Ranking MC Team** (o ranking general): con filtros visibles. Tipo default Columnas (toggle Circular permitido porque distribución es compatible).
         2. **Actividad por día (últimos N días)**: `type: 'line'` obligatorio. Si existía el gráfico "actividad general del equipo" y era de barras, cambiar el type a 'line' y renombrar label.
       - Poner `display:none` a:
         - Evolución de puntos MC team grande (para admin/inspector solo).
         - Actividad admins por día.
         - Ver más estadísticas cards.
         - Cualquier gráfico administrativo.
  3. Admin/Inspector siguen viendo TODO.
- **Acceptance Criteria Addressed**: AC-11, AC-2, AC-4
- **Test Requirements**:
  - `rule` TR-7.1: Sesión role=user → graficos-tab muestra solo 2 bloques gráficos.
  - `rule` TR-7.2: Bloque "Actividad por día" type === 'line'.
  - `rule` TR-7.3: Admin/Inspector sigue viendo todos los bloques.

---

## Task 8: Sincronizar jow/* → jow/public/* + GetDiagnostics 0 errores
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 0, Task 1, Task 2, Task 3, Task 4, Task 5, Task 6, Task 7
- **Description**:
  1. Write copy: `jow/index.html` → sobrescribir `jow/public/index.html`.
  2. Write copy: `jow/script.js` → sobrescribir `jow/public/script.js`.
  3. Write copy: `jow/style.css` → sobrescribir `jow/public/style.css`.
  4. Run `GetDiagnostics` para los 5 archivos clave:
     - index.html (root)
     - jow/index.html
     - jow/public/index.html
     - jow/script.js
     - jow/public/script.js
  5. Si hay errores → corregir antes de finalizar.
- **Acceptance Criteria Addressed**: NFR-6, AC-12
- **Test Requirements**:
  - `rule` TR-8.1: GetDiagnostics 0 errores en los 5.
  - `rule` TR-8.2: jow vs public identicos en contenido (diff vacío).

---

## Task 9: Smoke tests manuales extremo a extremo (21 flujos)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 8
- **Description**:
  Recorrer checklist de 21 pasos del requerimiento 20 + login security checklist. Registrar evidencias. Si falla algo → agregar issue y solucionar.
- **Acceptance Criteria Addressed**: AC-13 (rubric), AC-14 (rubric), todos los rule coverage
- **Test Requirements**:
  - `rubric` TR-9.1: Regresiones y funciones preservadas → >= 4.
  - `rubric` TR-9.2: Calidad visual final → >= 4.

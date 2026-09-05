# Ajustes Panel de Puntos + Dashboard - Implementation Plan

Leyenda de prioridades: high = bloqueante / necesario para aprobación; medium = mejora visible; low = detalle.
Los TR son de tipo `rule` o `rubric`, coincidentes con los AC padres salvo especificación más estrecha.

## Task 1: Garantizar render inicial instantáneo (tablas y gráficos sin dependencia única del snapshot)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: None
- **Description**:
  - Refactorizar `bootApp()` en `jow/script.js` y `jow/public/script.js` para llamar una función `renderAll()` DESPUÉS de `loadMembers()` + `setupLogsTab()`, DESPUÉS de que `startLogsLive()` haya sido llamado y su callback interno haya disparado al menos 1 vez.
  - Convertir `startLogsLive()` a una promesa o añadir un hook `onLogsReady` para no depender de orden. Alternativa sencilla: llamar `renderAll()` 1 vez de forma síncrona después de `loadMembers()`, y en el snapshot (incluso vacío) llamar de nuevo a los renders para pintar "Sin datos".
  - En cada gráfico (`renderRankingAdmins`, `renderEvolutionPts`, `renderActivityChart`, `renderInspectorActivityJow`, `renderDestacados`), el caso `!logs.length || sin datos` devuelve una card/estado de "Sin datos de actividad" o equivalente; nunca "Cargando…" una vez que se procesó el snapshot inicial.
  - En `index.html` raíz (Dashboard) aplicar el mismo criterio sobre `renderRankingAdmins`, gráficos evolución, distribución, actividad, actividad inspectores: después de `loadUsers()`, `startLogsLive()` y snapshot, emitir 1 `renderAllDash()` que no quede en "Cargando…".
- **Acceptance Criteria Addressed**: AC-1, AC-2
- **Test Requirements**:
  - `rule` TR-1.1: En una sesión con 0 logs, `activity-chart`, `evo-pts-chart`, `rank-admins-box`, `inspector-activity-body` y `pts-full-body` no contienen substring "Cargando…" 2 s después de `bootApp()` (mediante `browser_evaluate`).
  - `rule` TR-1.2: `pts-full-body` muestra lista de trabajadores / "Sin trabajadores…" sin haber cambiado de pestaña ni refrescado.
  - `rule` TR-1.3: no se introdujo ningún `setTimeout` como parche de carga (grep "setTimeout" debe continuar igual que antes, salvo usos legítimos como toast).
- **Notes**: Duplicar cambios en `jow/public/script.js` y Dashboard `index.html` inline script.

## Task 2: Ocupar todo el espacio con el Ranking de Admins y restaurar tamaño de gráficos
- **Status**: `pending`
- **Priority**: high
- **Depends On**: None
- **Description**:
  - En `jow/index.html`: cambiar `chart-grid two-col` del NIVEL 2 a `chart-grid one-col` (o anular el `two-col`) para que la card "Ranking de Admins" ocupe 100% del ancho. Si el grid tiene 2 columnas, la 2da columna es el hueco.
  - Revisar CSS `jow/style.css` y `jow/public/style.css` y, si falta clase `.chart-grid.one-col`, agregarla con `grid-template-columns: 1fr;` y gap adecuado; en `two-col` mantener responsive pero en móvil colapsar.
  - Ajustar el `chart-container` de ranking admins (`#rank-admins-box`) altura mínima `min-height: 220px`; en el SVG interno ampliar dimensiones a W ancho adaptable y altura ~240 px (actual W=400 H=180 → subir H a 240, W al 100% del padre).
  - En `renderActivityChart`, `renderEvolutionPts` (SVG): pasar de W=760 H=250 a W=100% SVG con viewBox y alturas >= 280 px en escritorio; añadir media queries en CSS para pantallas < 600 px: altura mínima 180 px.
  - Ajustar Chart.js del Dashboard `index.html` raíz: en los `new Chart(...)` establecer `maintainAspectRatio: false` y `.chart-container` con `height: 320px !important`; distribuciones y actividades más voluminosas.
- **Acceptance Criteria Addressed**: AC-3, AC-4
- **Test Requirements**:
  - `rubric` TR-2.1: Espacio Ranking Admins; escala 1-5; 1 = hueco visible; 5 = 1 sola columna, card usa todo el ancho y height de box >= 220 px; threshold >= 4; evidence: screenshot + `getBoundingClientRect()`.
  - `rule` TR-2.2: en viewport >= 1000 px: altura de SVG evolución >= 280, actividad >= 280, ranking admins >= 220 (o Canvas del Dashboard heights >= 300 px).
  - `rule` TR-2.3: en viewport móvil (< 450 px) no hay overflow horizontal en gráficos y se muestran completos.
- **Notes**: Replicar cambios tanto en `jow/` como en `jow/public/`.

## Task 3: Separar controles de puntos por rol y quitar cantidades custom a Inspector
- **Status**: `pending`
- **Priority**: high
- **Depends On**: None
- **Description**:
  - En `renderPointsTable()` dentro de `jow/script.js`, `isInspector` branch:
    - Solo `<button class="pts-btn pts-add" onclick="adjustPoints(uid, 1)">➕</button>` y `<button class="pts-btn pts-sub" onclick="adjustPoints(uid, -1)">➖</button>`.
    - Eliminar `input`, botón `⚙️`, y cualquier prompt interno "Cantidad de puntos a asignar".
  - En `jow/index.html` y `jow/public/index.html` asegurarse de que no haya referencias a `pts-input-*` renderizadas por HTML puro (actualmente solo en JS).
  - Mantener el branch Admin igual (4 botones: add, sub, input, gear).
- **Acceptance Criteria Addressed**: AC-5, AC-6 (en parte)
- **Test Requirements**:
  - `rule` TR-3.1: Con `currentUser.role = 'inspector'` y render `renderPointsTable()`, `document.querySelectorAll('.pts-input, .pts-set, .pts-input + input[type=number]').length === 0`.
  - `rule` TR-3.2: Click ➕ Inspector → delta = +1 exacto (sin prompt de cantidad). Click ➖ → delta = -1.

## Task 4: Pedir motivo en modificaciones de puntos (obligatorio inspector / opcional admin) y guardarlo correctamente
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 3
- **Description**:
  - Crear función auxiliar `askReasonForPoints({ actorRole, delta, directValue })` en `jow/script.js`:
    - `role === 'inspector'`: `motivo = prompt('Motivo de la modificación (obligatorio):')`; si `null` o vacío/whitespace → `return null` y no guardar.
    - `role === 'admin'`: `motivo = prompt('Motivo de la modificación (opcional):')`; si vacío/cancelado → `return 'Sin motivo indicado'`.
  - Refactorizar `window.adjustPoints`:
    - No permitir al inspector ingresar cantidad custom (ya quitado en Task 3). `delta` siempre +1 o -1 exacto.
    - Antes de actualizar Firestore, llamar `const reason = askReasonForPoints(...)`; si `null` → cancelar (return).
    - Guardar `reason` tal cual en `writeLog({ ..., reason, ... })`.
    - ELIMINAR los `await logNovedad(...)` que spameaban "Admin sumó/restó X pts".
  - Refactorizar `window.setPoints`:
    - Pedir motivo con `askReasonForPoints`.
    - Guardar reason en writeLog.
    - ELIMINAR el `await logNovedad("Admin estableció X a N pts...")`.
  - En Dashboard `index.html` (raíz), si existe lógica de adjust/set puntos, aplicar idem (ver `renderTopPoints()` y las filas del tablero; replicar motivo).
- **Acceptance Criteria Addressed**: AC-6, AC-7, AC-8
- **Test Requirements**:
  - `rule` TR-4.1: Inspector ➕ con cancel → puntos sin cambio; sin log entry nuevo.
  - `rule` TR-4.2: Inspector ➖ con motivo → log entry nuevo con delta === -1, reason === texto ingresado.
  - `rule` TR-4.3: Admin ⚙️ valor directo vacío → reason guarda "Sin motivo indicado".
  - `rule` TR-4.4: Columna Motivo en Logs muestra el texto exacto (no hardcodeado a "Ajuste rápido").

## Task 5: Asegurar pestaña Logs visible para Admins en Panel de Puntos
- **Status**: `pending`
- **Priority**: high
- **Depends On**: None
- **Description**:
  - En `jow/script.js`, en `setupLogsTab`: la línea `const isStaff = role === "admin" || role === "inspector"; if (btn) btn.style.display = isStaff ? "" : "none";` debería ser correcta.
  - Revisar también `setupStaffView` y cualquier otro código que setee `display:none` al `#logs-tab-btn` (grep).
  - Asegurarse de que, si `role === "admin"`, el `startLogsLive` se ejecuta antes del click y que `renderLogsJow` no dependa de un snapshot que no llega.
  - Si existe fallback en `switchTab` a pestaña diferente para Admins, eliminarlo (actualmente solo lo hace si `!isStaff`).
- **Acceptance Criteria Addressed**: AC-9
- **Test Requirements**:
  - `rule` TR-5.1: Con `currentUser.role = 'admin'`, `getComputedStyle(document.getElementById('logs-tab-btn')).display !== 'none'`.
  - `rule` TR-5.2: Click sobre el botón dispara `switchTab('logs-tab', btn)` y `#logs-tab.classList.contains('active')` es `true`.

## Task 6: Ocultar Mi Perfil para rol user + Novedades selectivas (sin spam de puntos)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 4
- **Description**:
  - En `bootApp()` y/o `setupStaffView`, invertir visibilidad del `my-perfil-tab-btn`: `role === 'user' ? 'none' : ''`. Asegurar que el `switchTab` nunca abra `#user-view` si el usuario es user aunque pegue url (no hay rutas, pero ocultar botón alcanza).
  - Quitar `renderUserProfileCard()` llamada cuando `role === 'user'`.
  - Rediseñar `novedades`:
    - Crear una función `ensureRiskNovedad(uid)` que, dado un usuario, revisa sus puntos y genera 1 sola novedad por día (usando clave `jow:novedad_sent:${uid}:${type}:${dayKey}` en localStorage; type = 'riesgoalto' | 'seguimiento' | 'critico' | 'destacado-day' | etc).
    - Invocar `ensureRiskNovedad(u.uid)` para cada usuario después de un cambio de puntos y en `bootApp()` luego de cargar miembros y logs (solo Admin? Mejor: todos los roles disparan ensure, pero la escritura a Firestore solo ocurre si `currentUser.role` === admin para no necesitar reglas nuevas. Como alternativa más simple, cuando Admin realiza una acción de puntos o se ejecuta `renderAll`, el Admin escribe las novedades).
    - Incorporar novedades por creación de usuario: en el Dashboard `index.html` (crear cuenta) y en `setupAdmin.html` luego de crear la cuenta, invocar una función `logNovedad('✨ Nuevo miembro {name} se unió al equipo.')` que no es spam.
    - En `renderDestacados`, el 1 puesto por período (day/week/month) dispara ensure para tipo 'destacado-day' (solo 1 por período, 1 vez).
    - Eliminar la llamada `await logNovedad("🔧 Admin...")` en `adjustPoints` y `setPoints` (hecho en Task 4, pero confirmar).
- **Acceptance Criteria Addressed**: AC-10, AC-11, AC-12, AC-13
- **Test Requirements**:
  - `rule` TR-6.1: Con `role === 'user'`, `logs-tab-btn`? No; `my-perfil-tab-btn.style.display === 'none'` y `#user-view.style.display === 'none'`.
  - `rule` TR-6.2: Después de 10 cambios de puntos por Admin, `novedades` no contiene ningún texto con la expresión `sumó|restó|estableció.*pts` (regex).
  - `rubric` TR-6.3: Intuitividad Novedades; escala 1-5; 5 = muestra "Nuevo miembro", "En riesgo", "En seguimiento", "Destacado del día" sin duplicados diarios; threshold >= 4.
  - `rule` TR-6.4: Para un usuario que ya tuvo novedad de riesgo alto hoy, al bajarle los puntos a 1 nuevamente no se inserta 2da novedad (idempotencia).

## Task 7: Prueba final en navegador integrado y corrección de regresiones
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 1, Task 2, Task 3, Task 4, Task 5, Task 6
- **Description**:
  - Levantar ambos servidores locales.
  - Abrir Panel de Puntos (rol Admin, Inspector, User) y Dashboard (Admin, Inspector) en el navegador integrado usando `run_mcp browser_navigate` + `browser_console_messages` + `browser_evaluate` para cumplimentar todos los TR.
  - Tomar screenshots y evidencia de cada AC.
  - Si aparecen regresiones, abrir sub-tareas adicionales y corregir antes de avanzar a Review.
  - Confirmar 0 errores de consola.
- **Acceptance Criteria Addressed**: AC-1 a AC-13 (regresión general)
- **Test Requirements**:
  - `rule` TR-7.1: `browser_console_messages` devuelve `(none)` en ambos paneles.
  - `rule` TR-7.2: Todos los TR de las tareas previas pasan.

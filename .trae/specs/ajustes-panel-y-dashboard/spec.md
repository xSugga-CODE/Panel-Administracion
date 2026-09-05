# Ajustes Panel de Puntos + Dashboard - Product Requirements Document

## Overview
- **Summary**: Correcciones y mejoras funcionales y visuales sobre el "Panel de Puntos" (jow) y el "Dashboard/Panel de Administración" (raíz), siguiendo 7 bloques concretos pedidos por el usuario.
- **Purpose**: Hacer que los paneles carguen al instante, recuperar espacio de diseño en el ranking de admins, reestablecer gráficos legibles, diferenciar controles de puntos por rol, pedir motivo en modificaciones, mostrar Logs a Admins y redefinir la utilidad de Perfil/Novedades.
- **Target Users**: Overlord, Owner, Admin, Inspector, Usuario (rol user) de Jowiland, todos ingresando por Panel de Puntos o por Panel de Administración.

## Goals
- El usuario entra y ve **tabla de puntos y gráficos inmediatamente**, sin necesitar refresh ni cambio de pestaña.
- Ranking de Admins ocupa **todo el espacio** disponible de su columna (eliminar hueco vacío).
- Gráficos con **tamaño notorio y legible** en escritorio y adaptados a móvil.
- Inspectores solo modifican **±1 punto**, sin cantidades custom.
- Cada modificación de puntos pide **motivo** (obligatorio para inspector, opcional para admin).
- Los Admins ven la **pestaña Logs** en el Panel de Puntos.
- Usuarios (rol `user`) **no** ven "Mi Perfil"; Novedades se convierte en un panel de avisos de estado del equipo selectivos, no un log de cada punto.

## Non-Goals
- No crear nuevas cuentas, credenciales Firebase ni desplegar a hosting.
- No reestructurar roles/permisos globales de Firebase (solo condiciones de UI y escritura en documentos ya existentes).
- No cambiar el algoritmo de decaimiento de puntos ni la definición de MC Team.
- No agregar features extra más allá de los 7 puntos pedidos.

## Background & Context
- El panel principal de "staff" vive en `jow/index.html` + `jow/script.js` (y la copia publicada `jow/public/`). Su `bootApp()` en script.js actual:
  - Carga `loadPointsConfig()` → `loadNovedades()` → `loadMembers()` (estos 3 en secuencia).
  - Llama `setupStaffView()` y `setupLogsTab()`.
  - `setupLogsTab()` decide si mostrar la pestaña `logs-tab-btn` (actualmente `isStaff = admin || inspector` → debería mostrar, pero el usuario reporta que Admin NO la ve).
  - `startLogsLive()` se llama solo si es staff; su callback es el ÚNICO lugar que dispara `renderRankingAdmins`, `renderEvolutionPts`, `renderActivityChart` y `renderRankings`.
- Síntoma: si el snapshot tarda, o el 1er snapshot NO tiene logs (lista vacía al disparar) o los gráficos se renderizan a medias; el usuario percibe "queda cargando" hasta refrescar/cambiar de pestaña.
- `renderPointsTable()` y `renderStaffTable()` SÍ se llaman desde `setupStaffView`, pero usan `mcWorkers()` que depende de `allMembers`. Si `setupLogsTab()` corre antes o en paralelo y no hay logs, `renderAll()` todavía no se ejecuta, pero `renderPointsTable()` sí → con la data de `allMembers` debería alcanzar. El reporte del usuario indica que a veces no alcanza.
- Modificaciones de puntos:
  - `adjustPoints(uid, delta)` actual: para inspector usa `prompt("Cantidad de puntos a asignar (máximo 2)")` y acepta floats; esto va contra el req que sea solo ±1.
  - Motivo: `reason` se hardcodea a "Ajuste rápido (±X)"; no hay modal ni validación.
  - `setPoints()` solo admin → OK mantener como "Ingresar valor directo".
- `setupStaffView()` linea 939: `perfilBtn2.style.display = role === "user" ? "" : "none"` → al revés del req (user NO debería ver "Mi perfil").
- `logNovedad()` en `adjustPoints` por admin emite "Admin X sumó/restó Y pts a Z" → exactamente lo que el req pide que NO haga Novedades.

## Functional Requirements
- **FR-1 Carga instantánea inicial**: después de `bootApp()` y una sola vez, se deben renderizar **todos los módulos visibles** (tabla puntos, stats, destacados, staff, novedades) sin depender exclusivamente del snapshot de logs. Los gráficos, si aún no tienen datos, deben mostrar "Sin datos de actividad" o equivalente, no "Cargando…".
- **FR-2 Snapshot único y determinista**: `startLogsLive()` debe, en su callback inicial, garantizar que se disparen los renders incluso si la colección está vacía. También se debe evitar doble render si el snapshot se ejecuta lento.
- **FR-3 Diseño Ranking de Admins**: eliminar el hueco que quedó al sacar el segundo ranking. La card `chart-card` del "Ranking de Admins" debe ocupar 100% del ancho/alto disponible en su contenedor (adaptable al grid).
- **FR-4 Tamaño de gráficos**: restaurar dimensiones grandes en los SVG (`renderActivityChart`, `renderEvolutionPts`, `renderInspectorActivityJow`, `renderRankingAdmins`) en lugar de tamaños reducidos, con media-queries en CSS para que en móvil no overfloween.
- **FR-5 Botones de puntos para Inspector**: en la tabla de puntos, un Inspector solo dispone de botones ➕ y ➖, sin input numérico, sin prompt custom, sin botón "Establecer valor". Cada click aplica exactamente ±1 punto.
- **FR-6 Botones de puntos para Admin**: mantienen ➕ y ➖ (±1) y el input + botón "⚙️ Establecer valor" (valor directo).
- **FR-7 Motivo de modificación**: cada acción de puntos (`+`, `-`, valor directo, admin o inspector) abre un cuadro (modal nativo de la app o `prompt()`) pidiendo el motivo.
  - Inspector: motivo no puede estar en blanco ni contener solo espacios; si lo cancela o deja vacío, NO se guarda la modificación.
  - Admin: motivo se muestra y puede confirmar aunque esté vacío (se guarda como "Sin motivo indicado").
- **FR-8 Persistencia del motivo**: el texto introducido por el usuario se guarda como `reason` en el `writeLog` de `type: "points"` y, si es necesario por UI, en `newPoints` y metadata. NO se usa `logNovedad()` automáticamente por cada punto.
- **FR-9 Pestaña Logs en Panel de Puntos**: al iniciar sesión con rol Admin, el botón `logs-tab-btn` en `#tabs-nav` debe estar visible; al hacer click, el tab se abre y renderiza logs; `setupLogsTab` no debe ocultarla.
- **FR-10 Mi Perfil oculto para rol user**: el botón `my-perfil-tab-btn` y el contenido `user-view` no aparecen ni son accesibles para usuarios con `role === "user"`. Para admin/inspector puede permanecer visible o no (sin restricción).
- **FR-11 Novedades selectivas**: en la sección 🔔 Novedades, NO se deben spamear entradas de "X subió/bajó N puntos". Se emiten solo novedades de estado. Para empezar, definimos estas reglas de emisión, invocadas desde puntos/login/creación/edición cuando corresponda:
  - Nuevo miembro registrado en el staff (creación de cuenta desde Dashboard o setupAdmin): "✨ Nuevo miembro {nombre} se unió al equipo".
  - Cambio de rol hacia Admin o Inspector: "🔧 {nombre} ahora es {rol}".
  - Buen desempeño: trabajador del día/semana/mes (cuando se calcula el renderDestacados, si es "destacado" y supera un umbral de puntos/actividad, registrar 1 sola entrada por período).
  - Entrada en seguimiento (puntos ≤ 4): "👀 {nombre} entró en seguimiento ({puntos} pts)".
  - Cerca de ser expulsado (puntos ≤ 2): "⚠️ {nombre} está en riesgo alto ({puntos} pts)"
  - Crítico / inactivo por puntos: "🚨 {nombre} en estado crítico ({puntos} pts)".
  - Las reglas de riesgo/seguimiento/crítico deben ser **idempotentes por 24h**: no generan 2 novedades iguales para el mismo usuario en menos de 24h (clave localStorage o dentro de documento `novedades` — usar texto + uid + día como filtro).
- **FR-12 logNovedad no se dispara en cambios de puntos**: eliminar la llamada `await logNovedad("🔧 Admin X...")` de `adjustPoints()` y `setPoints()`, y cualquier otra emisión automática de novedades por cada cambio de puntos.

## Non-Functional Requirements
- **NFR-1 Sin timeouts parche**: no se agrega ningún `setTimeout` forzado para "esperar que cargue". Todo render responde a `await` reales o al snapshot inicial de logs.
- **NFR-2 Legibilidad gráficos**: cada gráfico SVG/Canvas debe tener en escritorio altura ≥ 280 px (salvo donut ranking que puede ser 220 px). En móvil, al menos 180 px y ajuste a ancho.
- **NFR-3 Responsive**: todos los ajustes de layout (ranking admin, gráficos) se hacen con CSS/media queries para que no rompan en < 500 px.
- **NFR-4 Consistencia motivos**: campo `reason` guardado en logs debe coincidir exactamente con lo que el usuario escribió (o "Sin motivo indicado" si admin vacío).
- **NFR-5 Sin spam de novedades**: la misma regla de riesgo para un usuario no debe generar múltiples mensajes en el mismo día.

## Constraints
- **Technical**: mantener el stack HTML vanilla + ESM module inline para Dashboard (index.html raíz) + `script.js` con imports de Firebase modules separados para Panel de Puntos.
- **Technical**: todos los modales de motivo pueden implementarse con `prompt()` nativos por compatibilidad, sin agregar frameworks.
- **Business**: No servicios de pago; No nuevas credenciales.
- **Dependencies**: Firebase v12 (App/Auth/Firestore) y Chart.js 4.4.3 via CDN. No cambiar versiones.

## Assumptions
- Se modifican **ambas copias** de `jow/script.js` y `jow/public/script.js` por igual, ya que `build-public.js` no corre automáticamente. Ídem los HTML si tocan.
- El motivo opcional para Admin guarda `"Sin motivo indicado"` para asegurar que la columna Motivo en Logs nunca esté vacía a menos que el usuario explícitamente quiera, pero queda guardado así.
- "Ranking de Admins" se usa por el req 2 como ejemplo de hueco vacío. Si hay más huecos en el grid de gráficos, se solucionan aplicando el mismo principio (cards de 1 columna ocupando todo el ancho).

## Acceptance Criteria

### AC-1: Tabla de puntos muestra contenido al instante sin refresh
- **Type**: `rule`
- **Given**: Usuario cierra sesión, abre la app, se loguea (email/PIN).
- **When**: termina de aparecer la UI (se oculta login-screen).
- **Then**: el `#pts-full-body` no contiene el texto "Cargando…" (debe mostrar lista de trabajadores o "Sin trabajadores del MC Team.").
- **Pass Condition**: en inspección del DOM, inmediatamente después de `bootApp()` y sin recarga manual, `pts-full-body.innerText` no match `/Cargando…/`.
- **Evidence**: Snapshot del browser sobre `http://localhost:3000` post-login (mock/local) + `browser_evaluate` leyendo `innerText`.

### AC-2: Gráficos vacíos muestran "Sin datos de actividad" y no "Cargando…"
- **Type**: `rule`
- **Given**: Base sin logs todavía (o sin logs del período).
- **When**: el usuario entra a la app directamente a pestaña puntos y luego navega a Gráficos (o entra estando en ella).
- **Then**: `activity-chart`, `evo-pts-chart`, `rank-admins-box` y `inspector-activity-body` muestran un texto tipo "Sin datos de actividad" / "Sin trabajadores" / etc; ninguno se queda con "Cargando…" por más de 1 s.
- **Pass Condition**: luego de 2s del boot, los 4 `.chart-empty` / `t-empty` del DOM no tienen el substring "Cargando".
- **Evidence**: `browser_evaluate` que revise todos los ids tras `bootApp()`.

### AC-3: Ranking de Admins ocupa 100% del ancho disponible y no deja huecos
- **Type**: `rubric`
- **Dimension**: aprovechamiento del espacio
- **Scale**: 1-5
- **Anchors**: 1 = 2da columna vacía visible; 3 = ocupa todo el ancho pero heights pequeños; 5 = card de ranking admin ocupa todo el grid (1 columna) con altura ≥ 220 px y leyenda clara.
- **Pass Threshold**: >= 4
- **Evidence**: `browser_take_screenshot` + `browser_evaluate` chequeando `getBoundingClientRect()` width/height del `#rank-admins-box` padre (card).

### AC-4: Tamaño de gráficos notorio y legible (escritorio)
- **Type**: `rule`
- **Given**: Pantalla escritorio (>= 900 px ancho).
- **When**: usuario abre pestaña Gráficos.
- **Then**: altura en px del SVG/Canvas de evolución >= 280, actividad >= 280, ranking admins >= 220.
- **Pass Condition**: `browser_evaluate` con `getBoundingClientRect().height` sobre los respectivos `chart-container` (o hijos SVG).
- **Evidence**: screenshot + `browser_evaluate`.

### AC-5: Inspector solo ±1 sin inputs custom
- **Type**: `rule`
- **Given**: Usuario logueado como Inspector.
- **When**: mira la fila de un worker en la tabla de puntos.
- **Then**: en `.pts-actions` solo existen dos botones (classes `pts-add` y `pts-sub`), NO existe `pts-input-${uid}` ni botón `pts-set`.
- **Pass Condition**: `document.querySelectorAll('.pts-input, .pts-set').length === 0` cuando el rol es inspector.
- **Evidence**: `browser_evaluate` + snapshot.

### AC-6: Cada click de Inspector aplica exactamente ±1 (no prompt) y pide motivo obligatorio
- **Type**: `rule`
- **Given**: Inspector sobre un worker X.
- **When**: click en ➕ y cancela el prompt (o deja vacío), luego click en ➕ y escribe motivo OK.
- **Then**: (1) Si cancela/vacío → no se escribe documento en logs ni se actualizan puntos. (2) Si motivo OK → delta = +1 exacto; reason = texto del usuario. Click ➖ idem con -1.
- **Pass Condition**: inspeccionar `logs` array (y `allMembers[X].points`) por casos.
- **Evidence**: `browser_evaluate` que monitorea `logs` y compara before/after + verifica prompt.

### AC-7: Admin mantiene valor directo, motivo opcional, ±1 exacto en botones
- **Type**: `rule`
- **Given**: Admin en tabla.
- **When**: click en ➕ → prompt. Caso A: vacío y OK. Caso B: texto. Click en ⚙️ con valor 3.7 → prompt motivo vacío OK.
- **Then**: (1) ➕ con motivo vacío → reason guarda "Sin motivo indicado", delta +1. (2) ➕ con texto → reason igual al texto, delta +1. (3) set → delta = 3.7 - old; reason = "Sin motivo indicado" o texto.
- **Pass Condition**: último log.type==='points' correspondiente tiene `reason === texto o 'Sin motivo indicado'` y delta correcto.
- **Evidence**: `browser_evaluate` lectura de `logs` tras cada acción.

### AC-8: Motivo visible en la columna Motivo de Logs del Panel de Puntos
- **Type**: `rule`
- **Given**: Admin acaba de sumar puntos con motivo "Cumplió reporte semanal".
- **When**: navega a Logs.
- **Then**: la fila del log muestra "Cumplió reporte semanal" en la celda de motivo; no muestra "Sin motivo" ni hardcodeado.
- **Pass Condition**: `logs-jow-body > tr:last-child > td:nth-child(5)` contiene dicho substring.
- **Evidence**: snapshot + `browser_evaluate`.

### AC-9: Admin ve pestaña Logs en Panel de Puntos y es accesible
- **Type**: `rule`
- **Given**: usuario logueado con rol Admin.
- **When**: ve la barra de tabs.
- **Then**: `#logs-tab-btn.style.display !== "none"` y `!== "hidden"`, haciendo click cambia el tab activo a `logs-tab`.
- **Pass Condition**: click en el botón por `browser_click` y verificar `logs-tab` classList contiene `active`.
- **Evidence**: snapshot + `browser_evaluate`.

### AC-10: Rol user NO ve "Mi Perfil" en la barra de tabs
- **Type**: `rule`
- **Given**: usuario logueado con rol user.
- **When**: se pinta `tabs-nav`.
- **Then**: `#my-perfil-tab-btn.style.display` está en "none"; y el `#user-view` queda con `style.display:none` (nunca entra al switchTab por click directo).
- **Pass Condition**: inspección DOM del botón y tab-content.
- **Evidence**: `browser_evaluate`.

### AC-11: Novedades no contienen spam de puntos individuales
- **Type**: `rule`
- **Given**: Admin realiza 10 cambios de puntos a un worker. Luego entra a Novedades.
- **When**: itera el array `novedades` y el DOM.
- **Then**: ninguna entrada `texto` match regex `/sumó|restó|estableció\s+\w+\s+a\s+\w+\s+pts/` (frases típicas de cambios de puntos).
- **Pass Condition**: `novedades.every(n => !/sumó|restó|estableció.*pts/.test(n.texto))`.
- **Evidence**: `browser_evaluate` leyendo `window.novedades`.

### AC-12: Novedades sí emiten avisos de riesgo y nuevos miembros
- **Type**: `rubric`
- **Dimension**: utilidad e intuitividad de las Novedades
- **Scale**: 1-5
- **Anchors**:
  - 1: vacío o con mensajes repetitivos de puntos.
  - 3: muestra 1-2 de los tipos pedidos pero repite.
  - 5: para un usuario puesto a 1 punto (riesgo) aparece 1 mensaje de riesgo; al crear un usuario nuevo aparece un mensaje "✨ Nuevo miembro"; no aparecen duplicados en el mismo día; trabajadores destacados aparecen ocasionalmente.
- **Pass Threshold**: >= 4
- **Evidence**: snapshots de la pestaña Novedades en escenarios controlados.

### AC-13: Idempotencia diaria de novedades de riesgo
- **Type**: `rule`
- **Given**: usuario "Juan" con 1 punto, ya se registró novedad "⚠️ Juan está en riesgo alto (1 pts)".
- **When**: se ejecuta de nuevo la detección de riesgo dentro de las próximas 12h.
- **Then**: no se inserta un nuevo documento en Firestore `novedades` con el mismo `texto` y mismo `uid` referido en el mismo día.
- **Pass Condition**: conteo query sobre `novedades` no incrementa.
- **Evidence**: log `console.count` y verificación en `loadNovedades` que no duplica.

## Open Questions
- [ ] ¿Cuál es el threshold de "buen desempeño" para novedad de destacado? (Asumo provisionalmente: >= 5 pts + lugar 1 del período para disparar 1 novedad por período).
- [ ] Para "cerca de ser expulsado", ¿umbral 2 puntos (riesgo alto) coincide con la semántica actual de "Expulsión"? (Asumo que sí porque la norma es 0 puntos y sin actividad 7 días expulsa; el aviso a <=2 cumple).

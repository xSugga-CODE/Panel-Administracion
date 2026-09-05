# Actualización y Corrección del Sistema — Panel Admin y Panel Público + Seguridad Login

## Overview
- **Summary**: Actualización integral del sistema de gestión de puntos y administración del staff (MC Team), centralizando TODA la funcionalidad administrativa nueva en `index.html` (Dashboard principal), incluyendo gráficos de 3 tipos bien diferenciados con filtros, gestión de rangos actualizada (con 《🔹》 Vigia), controles de puntos decimales (+/−) en AMBOS paneles (Dashboard y panel público), permisos estrictos por rol, rediseño de estadísticas (sin Óptimos/Puntos totales), toggle trabajadores destacados, y **REFACTOR DE SEGURIDAD DE LOGIN** (incluyendo PIN validado por backend + hash pbkdf2 cuando el backend esté disponible).
- **Purpose**: Cumplir tanto con los 20 puntos del 03/09/2026 (panel admin) como con el requerimiento de seguridad login del 24/07/2026 (eliminar validación PIN cliente-side vulnerable descargando users completa).
- **Target Users**: Admin (acceso completo), Inspector (gestiona puntos), Usuario (consulta puntos, no edita).

## Goals
1. **Seguridad login**: Eliminar la vulnerabilidad actual donde `getDocs(users)` + matching cliente-side exponen todos los PIN. Implementar validación de credenciales (PIN, y si aplica email) por backend (Express `jow/backend/server.js` con firebase-admin) + hashing PBKDF2 con salt de PINes, y `signInWithCustomToken` en cliente. Mantener fallback transparente si el backend no está disponible, con advertencia visible.
2. Centralizar toda funcionalidad administrativa nueva en `index.html` (Dashboard) sin romper lo existente.
3. Gestión de puntos con decimales (enteros y decimales) desde AMBOS paneles: Dashboard (`index.html`) y panel público `jow/`. Misma fuente de datos Firestore `users.points`.
4. Implementar permisos estrictos: Admin/Inspector pueden modificar puntos; Usuario solo consulta (protección real doble capa: UI + lógica JS + firestore.rules).
5. Integrar gráficos de 3 TIPOS DIFERENCIADOS (lineal / columnas / circular) con propósitos correctos y filtros combinados por Cargo + Rango DENTRO de `index.html`.
6. Actualizar gestión de rangos con los 5 rangos oficiales (incluyendo 《🔹》 Vigia) funcionales y persistentes en el Dashboard.
7. Rediseñar estadísticas: eliminar "Óptimos" y "Puntos totales" (ambos paneles). Mejorar visualmente las 3 restantes y las 4 del dashboard central (agregar barras, porcentajes, distribución).
8. Toggle Mostrar/Ocultar trabajadores destacados en jow/ y también versión compacta en Dashboard central.
9. Para rol Usuario en panel público: estadísticas LIMITADAS a solo Ranking con filtros + Actividad por día (gráfico LINEAL, no circular).

## Non-Goals
1. No se activa plan Blaze ni se solicitan tarjetas de crédito. Firebase Functions no se usa. El backend de login se corre separado (Express) o no se usa (con advertencia visible de modo inseguro).
2. No se eliminan las rutas legacy login email Firebase Auth (signInWithEmailAndPassword). Siguen funcionando como ruta 100% segura incluso sin backend Express.
3. No se cambia la estructura de `users` colección más allá de agregar 2 campos nuevos opcionales: `pinHash` y `pinSalt` para migración segura. El campo legacy `pin` se limpia gradualmente.
4. No se elimina funcionalidad preexistente salvo las explícitamente indicadas (Óptimos, Puntos totales, texto largo del panel).

## Background & Context
- **Stack**: HTML/CSS/JS vanilla. Firebase Firestore + Auth (client-side SDK modular CDN v12.15). Backend Express existente: `jow/backend/server.js` (ya tiene PBKDF2, crypto, timingSafeEqual, JWT). Plan Spark gratuito.
- **Vulnerabilidad confirmada (jul 24 req)**: En `jow/script.js:285-316` (loginWithPin fallback) se hace `getDocs(collection(db, "users"))` completo y luego find por `u.pin === pin && name match`. Esto EXPONE todos los documentos users (con sus PIN en texto plano legacy) en DevTools del navegador. CUALQUIER usuario puede robar PINes ajenos.
- **Backend existente**: `jow/backend/server.js` ya usa `hashPin(pin, salt)` pbkdf2Sync(200000 iters, sha256, 32bytes) + `safeEq timingSafeEqual`. PERO actualmente consulta SQLite local, NO Firestore. Hay que extenderlo para usar `firebase-admin` SDK (server-side) contra la colección users real.
- **Deploy trade-off**: Firebase Hosting sirve `jow/public/` estático. El backend Express no se deploya ahí. Entonces:
  - **Modo local/dev**: `npm start` corre Express en :3000, sirve el panel + endpoints API login seguros. 100% seguro.
  - **Modo deploy Firebase Hosting (jowiland-2.web.app)**: No hay backend. Se muestra banner ROJO "⚠️ Modo Hosting sin backend: use login Email para seguridad total. Login PIN en este entorno no está validado por servidor". El login PIN en modo Hosting SE MANTIENE para compatibilidad pero se informa explícitamente que no es seguro; se recomienda email.
- **Rangos confirmados**:
  1. 《🪬》 Overlord
  2. 《🧿》 Owner
  3. 《💎》 Admin
  4. 《💠》 Centinela
  5. 《🔹》 Vigia
- **Archivos clave actuales**: `index.html` (Dashboard central, ~1641 líneas JS inline), `jow/index.html` + `jow/script.js` (panel público/staff), `jow/firestore.rules` (ya impide que role=user modifique points, perfecto).

## Functional Requirements

### FR-0: Seguridad Login PIN por Backend + Hashing
- **Nuevo Backend**: Extender `jow/backend/server.js` para inicializar `firebase-admin` SDK (via service-account JSON o GOOGLE_APPLICATION_CREDENTIALS).
  - Ruta `POST /api/auth/pin`: body `{name, pin}`. Busca en Firestore `/users` por `nameLower` (índice). Compara `pinHash/pinSalt` (nuevo esquema) usando pbkdf2 y timingSafeEqual. Si es legacy `pin` texto plano: valida, luego MIGRA en el mismo write a `pinHash/pinSalt` + borra `pin`. Devuelve: `{ok: true, customToken, uid, userDocLite}` donde `customToken = admin.auth().createCustomToken(uid)`.
  - Ruta `POST /api/auth/migrate-all-pins`: solo admin via JWT o header admin key. Migra TODOS los docs users que tengan `pin` legacy (texto plano) → pbkdf2 salted. Borra campo `pin` de todos.
- **Nuevo Frontend jow/script.js**: `loginWithPin()` ahora hace:
  1. Primero intenta `POST ${API_BASE_URL}/api/auth/pin` (donde API_BASE_URL = `window.location.origin` si existe `:3000` o una variable configurable; fallback a `null` si detecta Hosting sin backend).
  2. Si el endpoint responde OK: usa `signInWithCustomToken(auth, customToken)` → mismo flujo Firebase Auth que email. Perfecto.
  3. Si el endpoint NO responde (net::ERR_CONNECTION_REFUSED o 404) = modo Hosting o sin backend: mostrar banner visible de advertencia ROJA "⚠️ PIN sin backend = sin protección server-side. Recomendamos login Email". Y luego: **NO usar getDocs(users)**. En vez de eso, usar Firebase Auth (pero como el PIN no tiene user Firebase, no puede). Alternativa: en ese fallback, hacer login via signInAnonymously + sessionStorage del uid, o simplemente advertir que no se puede loguear por PIN en ese entorno. Para no romper la UX actual, se mantiene el matching pero solo DESPUÉS del banner de warning, para que el usuario esté informado.
- Regla: NUNCA más el frontend descarga users completa sin advertencia visible.
- El login por email (Firebase Auth signInWithEmailAndPassword) SE MANTIENE IGUAL, ya es seguro.

### FR-1: Toggle Trabajadores Destacados (AMBOS paneles)
- En `jow/index.html`: botón visible "Mostrar trabajadores destacados". Click → muestra 3 tarjetas día/semana/mes. Cambia texto a "Ocultar trabajadores destacados". Estado inicial: OCULTO.
- En `index.html` page-dashboard (central): agregar versión COMPACTA de los mismos trabajadores destacados (mismo botón toggle). Estado inicial también OCULTO. (Cumpliendo centralización punto 6 y 14.)

### FR-2: Tres tipos de gráficos DIFERENCIADOS
- **Lineal (type: line)**: Únicamente evolución de puntos, evolución de actividad, actividad por día, datos temporales, tendencias.
- **Columnas (type: bar)**: Únicamente comparaciones entre usuarios, rankings, actividad por trabajador, cantidades comparables.
- **Circular (type: pie/doughnut)**: Únicamente distribuciones, porcentajes, proporciones entre categorías (ej: distribución de cargos, distribución de rangos).
- **Selector de tipo**: solo entre los compatibles (ej: ranking permite Columnas ↔ Circular, ya que ambos muestran comparación y distribución respectivamente. PERO evolución temporal NUNCA permite circular).

### FR-3: Eliminar texto largo del panel jow/
- Borrar `jow/index.html:142` ("Clasificación en tiempo real del MC Team..."). No reemplazar. Tabla de puntos directamente visible.

### FR-4: Inspectores SÍ en estadísticas
- Filtrado en métricas operativas de trabajadores: excluye ÚNICAMENTE `role === "admin"`.
- Inspectores aparecen en: stats, gráficos, tablas, rankings, métricas actividad.
- No usar condiciones `role === "user"` para filtrar (ésta excluiría inspectores).

### FR-5: Stats rediseñadas (AMBOS paneles)
- **Eliminar COMPLETAMENTE**: "Óptimos" y "Puntos totales" (paneles jow/).
- **Panel jow/ stats (ahora 3 cards)**: Miembros staff, Puntos promedio, En riesgo. No solo número; agregar barras, porcentajes, distribución.
- **Dashboard central index.html stats (4 actuales: Total cuentas, Inspectores, Usuarios, Puntos entregados)**: también mejorar visualmente. Agregar mini-barras de distribución, porcentaje (ej: Inspectores = X del total = Y%), comparación simple.

### FR-6: Centralización en index.html
- Toda funcionalidad administrativa nueva (rangos, gráficos con filtros, gestión puntos decimales, toggle destacados compacto, rankings) DENTRO de `index.html` (page-charts, page-points, page-dashboard).
- `setupAdmin.html` conserva lo que tenga. No se usa como excusa para dejar cosas incompletas en Dashboard.

### FR-7 + FR-11: Gestión de puntos en AMBOS paneles
- Dashboard `index.html` (page-points): tiene input decimal + botón **+ Sumar puntos** y **− Restar puntos** separados.
- Panel público `jow/` (tab Puntos): MISMA estructura (input step 0.01 + botones +/−).
- Ambos usan `users.uid -> points` (campo Number Firestore). Sin duplicados, sin hardcode.
- Actualización cruzada visible: al cambiar en uno, recargar el otro refleja el mismo valor.

### FR-8 + FR-9: Puntos decimales sin redondeo
- Input `type=number` `step="0.01"` o `inputmode="decimal"`.
- Acepta 5, 2.5, 1.25.
- No `Math.round()` antes de guardar. Persistir como Number flotante exacto.
- Mostrar con `fmtPts = (p) => p % 1 === 0 ? p.toFixed(0) : p.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')` (no ceros innecesarios).

### FR-10 + FR-12: Permisos estrictos
- **Admin/Inspector**: pueden editar (UI + lógica + firestore.rules). Inspector no puede editarse a sí mismo (doble capa: UI disabled + check JS).
- **Usuario (role=user)**: VE panel de puntos COMPLETO (todos usuarios, todos puntos, ranking, rangos, cargos). PERO:
  - UI: NO renderiza botones ni inputs de edición.
  - Lógica JS: función `adjPts/adjPoints` return early si `role !== 'admin' && role !== 'inspector'`.
  - Firestore rules: ya lo protege (isStaff check).
- Triple capa.

### FR-13: Estadísticas LIMITADAS para Usuario (jow/)
- En `graficos-tab` cuando `role === 'user'`:
  - SOLO se muestran 2 bloques:
    1. **Ranking** (con filtros que actualicen la vista).
    2. **Actividad por día** (gráfico type=line LINEAL).
  - No actividad admins, ni evolución puntos MC team grande, ni actividad general avanzada, ni distribución cargos si queremos mantenerlo simple.
- Admin/Inspector: siguen viendo TODO.

### FR-14: Info nueva centralizada en Dashboard
- index.html integra: rangos con Vigia en select modal editar/crear, stats 4 mejoradas, toggle destacados compacto, page-charts nueva con gráficos + filtros, page-points con decimales +/− separados, users tabla con acciones (editar/eliminar).

### FR-15: Gestión completa de Rangos en Dashboard
- Modal crear/editar user index.html: select m-rango tiene las 5 opciones EXACTAS con emojis.
- Guardar en Firestore users.rango el STRING CON EMOJI (ej: "《🔹》 Vigia").
- Al editar, select viene precargado con el valor actual doc.rango (match por value o texto).
- Especialmente: "《🔹》 Vigia" se puede seleccionar y guardar.

### FR-16: Sección "Gráficos" DENTRO de index.html
- Nav-item nuevo "Gráficos" → page-charts.
- Canvas Chart.js con los 3 tipos distintos:
  1. Evolución actividad (line)
  2. Ranking puntos (bar) con toggle a pie/doughnut (compatible)
  3. Actividad por trabajador (bar)
  4. Distribución cargos (pie/doughnut)
  5. Opcional: Distribución de rangos (pie)

### FR-17: Filtros de gráficos por Cargo y Rango (combinados)
- Toolbar filtros en sección gráficos (tanto index.html como jow/ admin/inspector):
  1. Filtro Cargo: Todos | MC Team | Inspector | Mod | Colaborador | Dev | Editor | Marketing
  2. Filtro Rango: Todos | 《🪬》 Overlord | 《🧿》 Owner | 《💎》 Admin | 《💠》 Centinela | 《🔹》 Vigia
  3. Filtro Periodo (gráficos temporales): Día | Semana | Mes
- Al cambiar cualquiera, los gráficos se RE-RENDERIZAN con datos reales filtrados (AND lógico: Cargo AND Rango cuando ambos son != Todos).

### FR-18: Propósitos gráficos staff
- Usar 3 tipos correctamente para: quién trabajó más, mayor actividad, más modificaciones puntos, evolución actividad, evolución puntos, comparación miembros, actividad período.

### FR-19: No romper sistema existente
- Conservar: login PIN (con fallback y advertencia), login email, identificación usuario, rangos/cargos, MC team, puntos, config decremento, logs, cooldown inspector 24h, novedades limit 20, responsive móvil, rate limits login.

### FR-20: Integridad extremo a extremo
- Sincronizar `jow/*` → `jow/public/*` al final.
- Todos los flujos de checklist del usuario (21 pasos) verificados antes de Review.

## Non-Functional Requirements
- **NFR-1 Seguridad**: Backend API `/api/auth/pin` nunca devuelve el pinHash/pinSalt ni PIN. Solo OK o error genérico "Credenciales inválidas" (sin información si falló por nombre vs por PIN).
- **NFR-2 Seguridad**: Hashing PBKDF2 siempre server-side; cliente nunca calcula hashes de PIN para guardar.
- **NFR-3 Integridad**: Todos los stats/gráficos provienen de `users` y `logs` reales Firestore. No datos hardcodeados.
- **NFR-4 UX**: Interfaz limpia. Collapsibles (destacados). Filtros inmediatos. Responsive móvil no se rompe.
- **NFR-5 Transparencia**: Banner advertencia ROJO visible si el panel se sirve desde Hosting sin backend disponible para PIN.
- **NFR-6 Sintaxis**: GetDiagnostics 0 errores en todos los archivos al final.

## Constraints
- Plan Spark (gratis). Sin Cloud Functions. Todo backend nuevo = Express Node.js separado.
- Chart.js vía CDN.
- Sin cambiar colección `users` más allá de 2 campos nuevos opcionales (`pinHash`, `pinSalt`).
- Rangos exactos (5) con emojis; NO rangos nuevos.
- Eliminar stats "Óptimos" y "Puntos totales" de jow/. NO negociables.

## Assumptions
1. El usuario puede hostear el backend Express gratis en Render/Railway/Vercel Node (free tiers). Si no lo hace, el login PIN funciona con warning en Hosting, mientras que email sigue 100% seguro.
2. `firebase-admin` service account JSON se configura por .env o variable de entorno; no se commitea.
3. Gráficos evolución se construyen a partir de `logs` type=points y snapshots actuales de users.points; no hay histórico previo si los logs no están. Se muestra leyenda aclaratoria sin bloquear.

## Acceptance Criteria

### AC-0: Login PIN por backend + hashing funcionales (modo local con Express)
- **Type**: `rule`
- **Given**: `npm start` corriendo en localhost:3000, base Firestore con un user role=user con `pin` legacy en texto plano, y un admin con email login.
- **When**: (1) Se accede a `http://localhost:3000`, se hace login PIN exitoso. (2) Se consulta el documento user en Firestore.
- **Then**: (a) No hubo ningún `getDocs(collection(db, "users"))` en cliente para el matching. (b) Login PIN se validó por `/api/auth/pin` server-side. (c) Después del login exitoso legacy, el doc user ya NO tiene campo `pin` en texto plano y tiene NUEVOS campos `pinHash` + `pinSalt` (migración automática exitosa). (d) Cliente-side se hizo `signInWithCustomToken` y onAuthStateChanged recibe el user correcto.
- **Pass Condition**: Todas (a)(b)(c)(d) se cumplen.
- **Evidence**: Network tab del browser (no aparece users collection GET masivo) + Firestore read doc del usuario.

### AC-0b: Banner warning visible en modo Hosting sin backend
- **Type**: `rule`
- **Given**: Panel servido staticamente SIN Express (archivo file:// o Firebase Hosting)
- **When**: Se selecciona tab PIN en login
- **Then**: Aparece un banner o texto de advertencia visible (color rojo/fondo warning) diciendo explícitamente que el entorno actual NO tiene backend para validar PIN server-side y que se recomienda usar login Email para seguridad total.
- **Pass Condition**: Banner existe en el DOM y es visible antes de ejecutar el matching.
- **Evidence**: Inspección DOM al renderizar la pantalla login modo pin.

### AC-1: Toggle Trabajadores destacados funciona en jow/ Y dashboard compacto
- **Type**: `rule`
- **Given**: Panel público jow/ cargado, y Dashboard central index.html page-dashboard cargado
- **When**: Click en cada botón de toggle 2 veces
- **Then**: (1) Estado inicial oculto. (2) Click 1: tarjetas día/semana/mes visibles, botón cambia texto. (3) Click 2: vuelve a oculto. (4) El comportamiento se da en AMBOS paneles.
- **Pass Condition**: 4 condiciones OK.
- **Evidence**: DOM check.

### AC-2: Gráficos tienen tipo correcto por propósito
- **Type**: `rule`
- **Given**: Cualquier gráfico renderizado en cualquier panel (index.html page-charts, jow/ graficos-tab admin, jow/ graficos-tab user)
- **When**: Reviso config.type de cada instancia de Chart
- **Then**: (a) Evolución/actividad temporal = line. (b) Comparación/rankings = bar. (c) Distribución = pie/doughnut. (d) Ningún gráfico temporal es circular.
- **Pass Condition**: (a)(b)(c)(d) para todos los charts.
- **Evidence**: Grep `new Chart` y revisión de cada type en config.

### AC-3: Texto largo eliminado
- **Type**: `rule`
- **Given**: jow/index.html y jow/public/index.html
- **When**: Grep "Clasificación en tiempo real del MC Team"
- **Then**: 0 matches.
- **Pass Condition**: 0.
- **Evidence**: Grep output.

### AC-4: Inspectores en stats; Admin excluido solo donde corresponde
- **Type**: `rule`
- **Given**: DB con 1 Admin, 1 Inspector, 2 Users; inspector con puntos > 0.
- **When**: Se renderizan stats/rankings/tablas operativas trabajadores.
- **Then**: Inspector aparece. Admin no aparece en los rankings operativos MC Team. Ninguna condición excluye inspectores por error (no hay `role === "user"` para filtrar).
- **Pass Condition**: Code review todos los filtros + visualización en UI.
- **Evidence**: DOM del ranking + code review filter predicates.

### AC-5: Stats sin Óptimos ni Puntos totales; rediseñadas
- **Type**: `rule`
- **Given**: Stats en jow/ y dashboard.
- **When**: Grep + inspección DOM.
- **Then**: (1) 0 coincidencias de "Óptimos" y "Puntos totales" en las secciones stats de jow/. (2) Stats jow/ 3 restantes y dashboard 4 actuales NO son solo número; tienen barras, porcentajes o distribución.
- **Pass Condition**: (1)(2) OK.
- **Evidence**: DOM stats.

### AC-6: Select rangos Dashboard 5 opciones con emojis + guarda Vigia
- **Type**: `rule`
- **Given**: Modal Crear/Editar user index.html.
- **When**: (a) Abro select. (b) Asigno 《🔹》 Vigia y guardo. (c) Abro editar nuevamente.
- **Then**: (a) 5 opciones exactas visibles. (b) Guardado Firestore exitoso (users.rango = "《🔹》 Vigia"). (c) Editar muestra selected correcto.
- **Pass Condition**: (a)(b)(c).
- **Evidence**: DOM select + getDoc Firestore.

### AC-7: Puntos decimales sin redondeo + persisten
- **Type**: `rule`
- **Given**: Usuario target con pts=10.
- **When**: Sumo 2.5 → resto 1.25.
- **Then**: puntos = 11.25 exactos en Firestore Number. Ambos paneles lo muestran igual.
- **Pass Condition**: Number(doc.data().points) === 11.25.
- **Evidence**: getDoc().

### AC-8: Usuario (role=user) ve todo, edita nada (triple protección)
- **Type**: `rule`
- **Given**: Login user role=user en jow/.
- **When**: (a) Abro tab puntos. (b) Busco botones editar. (c) Llamo adjPts(uid, 5, 'test') por consola. (d) Intento hacer updateDoc manual en consola.
- **Then**: (a) Ve todos usuarios, puntos, rangos, ranking. (b) Sin botones ni inputs editar. (c) Return early, no update. (d) Firestore rules rechaza (no staff).
- **Pass Condition**: 4 condiciones OK.
- **Evidence**: DOM + consola + rules denied en console.

### AC-9: Ambos paneles tienen +Sumar y −Restar SEPARADOS con input decimal
- **Type**: `rule`
- **Given**: Dashboard page-points y jow tab puntos (Admin).
- **When**: Inspecciono DOM filas puntos.
- **Then**: Cada panel tiene input number step=0.01 + botón + Sumar + botón − Restar. Separados. No solo prompt.
- **Pass Condition**: Estructura existe en ambos.
- **Evidence**: DOM.

### AC-10: Dashboard tiene sección Gráficos con 3 tipos + filtros combinados reales
- **Type**: `rule`
- **Given**: Dashboard page-charts cargado.
- **When**: (1) Veo charts por default. (2) Cambio filtro Cargo = "MC Team". (3) Cambio Rango = "《💠》 Centinela".
- **Then**: (1) Existen al menos 1 line, 2 bar, 1 pie (3 tipos). (2) Update visible del chart rank-pts. (3) Update filtrado AND (solo los MC team Y Centinela).
- **Pass Condition**: 3 condiciones.
- **Evidence**: DOM charts + array filtrados antes de update.

### AC-11: Usuario solo ve Ranking + Actividad por día lineal
- **Type**: `rule`
- **Given**: Sesión user role=user en jow/.
- **When**: Entro a graficos-tab.
- **Then**: Solo 2 bloques gráficos: 1) Ranking con filtros, 2) Actividad por día type=line. No hay ni actividad admins ni otros avanzados.
- **Pass Condition**: 2 bloques + type line.
- **Evidence**: DOM querySelectorAll count + chart.type.

### AC-12: Ambos paneles misma fuente de datos (reflectan cambios)
- **Type**: `rule`
- **Given**: Dashboard y panel público abiertos, target X pts=5.
- **When**: Dashboard suma 2.5. Panel público recarga datos.
- **Then**: Ambos muestran 7.5. Firestore doc único también.
- **Pass Condition**: 3 lugares iguales.
- **Evidence**: 2 screenshots + getDoc.

### AC-13: Calidad visual final
- **Type**: `rubric`
- **Dimension**: Estética y utilidad de stats nuevas, toggles, filtros, y advertencia seguridad login.
- **Scale**: 1-5
- **Anchors**: 1 = todo números solos y botones invisibles; 3 = mejorado pero feo/desalineado; 5 = limpio, alineado al theme, barras útiles, porcentajes claros, botón toggle visible, banner warning rojo que se note pero no rompa todo.
- **Pass Threshold**: >= 4
- **Evidence**: Screenshot de dashboard stats + destacados + panel jow stats + banner login.

### AC-14: No hay regresiones en login admin, crear/editar cuentas, config decremento
- **Type**: `rubric`
- **Dimension**: Preservación de funciones anteriores.
- **Scale**: 1-5
- **Anchors**: 1 = login roto o no se crean cuentas o config no guarda; 3 = lo principal anda, falla alguna cosa secundaria; 5 = login email PIN, crear/editar/eliminar cuenta, config decremento, logs, cooldown inspector, responsive móvil, novedades 20 entradas TODOS OK.
- **Pass Threshold**: >= 4
- **Evidence**: GetDiagnostics sin errores + smoke tests de cada flujo.

## Open Questions
- Ninguna. Todo scope cerrado.

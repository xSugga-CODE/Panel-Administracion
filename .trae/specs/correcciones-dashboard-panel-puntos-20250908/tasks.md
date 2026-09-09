# Correcciones Dashboard + Panel de Puntos - Implementation Plan

## Task 1: Eliminar fallback noop + incrustar scripts sincrónicos (fix SyntaxError y ReferenceError)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: None
- **Description**:
  - En `index.html` RAÍZ: incrustar TODO el contenido de `script.js` inline directamente en `<script>` SIN `type="module"` dentro del `<head>` o ANTES del primer elemento `onclick`. Eliminar el fallback `<script>` de noop global (líneas ~655).
  - En `jow/index.html` y `jow/public/index.html`: quitar `type="module"` del script inline embedido (ahora tiene type=module por el paso anterior de embed). Esto asegura que `window.switchLogin` exista sincrónicamente al parsear los botones de las líneas 21, 22, 33.
  - Confirmar que los 3 botones del login (switchLogin PIN/Email, loginWithPin, loginWithEmail, doLogout) ejecutan lógica real al hacer clic, sin `[fallback]` ni `ReferenceError`.
  - Confirmar que no hay `<script src="script.js">` pendiente que pudiera devolver HTML de fallback.
- **Acceptance Criteria Addressed**: AC-10
- **Test Requirements**:
  - `rule` TR-1.1: Extraer el script inline de cada HTML y ejecutar `node --check` → 0 errores en los 3 archivos.
  - `rule` TR-1.2: En los 3 HTML, `grep -c "fallback"` debe ser 0; `grep -c "noop"` debe ser 0.
  - `rule` TR-1.3: `typeof window.switchLogin === 'function'` en el HTML antes del primer `<button onclick=...>`.
  - `rule` TR-1.4: No aparece ningún `<script src="script.js">` externo en ninguno de los 3 HTML.
- **Notes**: jow/public debe ser copia exacta de jow/index.html una vez listo.

## Task 2: Historial de puntos no se sobrescribe + eliminar limit(300) + nueva colección pointSnapshots
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 1 (scripts cargan)
- **Description**:
  - Crear función helper `writePointSnapshot(uid, points, reason, clientTs)` que haga `addDoc(collection(db,"pointSnapshots"), { uid, points, clientTs, dayKey: dayKey(new Date(clientTs)), weekKey, monthKey, reason })` en root y jow.
  - Llamar `writePointSnapshot` DESPUÉS de cada `updateDoc` de `users.points` exitoso: adjustPoints, setPoints, setPtsFixed, applyPointDecrementTick, setupAdmin.html mgApply.
  - En `startLogsLive()` de root y jow, QUITAR el `.limit(300)` de la query a logs para no truncar. Aplicar paginación o `onSnapshot` sin límite.
  - Ajustar `renderEvolutionPts` para que cuando los logs no alcancen, combine con documentos de `pointSnapshots` por período para rellenar.
- **Acceptance Criteria Addressed**: AC-3, AC-4
- **Test Requirements**:
  - `rule` TR-2.1: Después de 3 cambios sucesivos de puntos, logs count >= 3 y pointSnapshots count >= 3.
  - `rule` TR-2.2: Grep por `.limit(300)` en las 3 superficies → 0 coincidencias en la función startLogsLive.
  - `rubric` TR-2.3: Cobertura histórica (reconstrucción correcta de 500 cambios) → escala 1-5 (1 = roto, 5 = se renderizan 500 segmentos con los valores correctos). Threshold >= 4.
- **Notes**: Definir `weekKey` como ISO semana (`YYYY-Www`) y `monthKey` como `YYYY-MM`.

## Task 3: Evolución General del Equipo - una barra/línea por usuario, colores únicos, leyenda círculos, scroll
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 2
- **Description**:
  - En el Dashboard (`renderEvolutionPts` root) y Panel de Puntos (`renderEvolutionPts` jow):
    - Quitar cualquier omit/agrupamiento por rol; iterar **todos** los `allUsers` (mezcla Usuario/Admin/Inspector).
    - Generar color único y CONSISTENTE por UID (función `colorForUid(uid)` basada en hash), guardar en caché `userColors`.
    - Contenedor SVG envoltorio con `width=100%` y `overflow-x: auto`; cuando usuarios > 8, aplicar ancho mínimo por barra para forzar scroll.
    - Leyenda `#evo-pts-legend`: solo `<span class="dot" style="background: color"></span>`, SIN texto nombre. Alinear los círculos con flex wrap.
    - En modo lineal: `<polyline stroke="color" fill="none" stroke-width="2"/>` usando exactamente el mismo color que el círculo de la leyenda.
  - Mantener períodos 7/14/30 días.
- **Acceptance Criteria Addressed**: AC-1, AC-2
- **Test Requirements**:
  - `rule` TR-3.1: Con 12 usuarios, `document.querySelectorAll('#evo-pts-chart rect.bar').length == 12` en modo columnas y `#evo-pts-chart polyline` length == 12 en modo lineal.
  - `rule` TR-3.2: `document.querySelector('#evo-pts-legend').innerText.trim() === ''` (sin nombres).
  - `rule` TR-3.3: Cada polyline `stroke` coincide con el `background-color` de su círculo correspondiente en la leyenda.
- **Notes**: Aplicar cambios IDÉNTICOS en root y jow.

## Task 4: Renombrar Actividad de Admins → Actividad de Usuarios + métricas por rol + solo filtro Rol
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 3
- **Description**:
  - Cambiar `<h3>` del gráfico en Dashboard root de "🕐 Actividad de Admins" → "🕐 Actividad de Usuarios".
  - Asegurar que en Jow el título ya es correcto (corroborar y forzar consistencia).
  - Reescribir el render del gráfico para que:
    - **Usuario**: valor = `round(mean(entradas, puntosActuales), 1)` (única barra/valor).
    - **Inspector**: 3 valores = [puntosActuales, puntosSubidaAcumuladaDeltaPositivo, entradas].
    - **Admin**: 2 valores = [puntosAgregadosDeltaPositivoPorAdmin, entradas].
  - Quitar vínculos entre los filtros de `Usuario individual`, `Rango` y `Cargo` sobre este dataset; solo `Rol` Usuario/Admin/Inspector filtra la lista de usuarios que entran en el cálculo.
- **Acceptance Criteria Addressed**: AC-5, AC-6
- **Test Requirements**:
  - `rule` TR-4.1: Título exactamente `"🕐 Actividad de Usuarios"` tanto en root como en jow.
  - `rule` TR-4.2: Al cambiar filtro Usuario individual, dataset no cambia (mismo recuento de elementos); al cambiar filtro Rol Admin → solo aparecen Admins.
  - `rubric` TR-4.3: Corrección de métricas (1 Usuario, 1 Inspector, 1 Admin datos conocidos) → valores renderizados == cálculo manual. Escala 1-5 (1 = ningún valor bien, 3 = 2/3 roles bien, 5 = todos bien). Threshold >= 4.

## Task 5: Agrandar gráficos del Dashboard (proporciones similares al Panel) + responsive
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 1 (scripts ok)
- **Description**:
  - Revisar `style.css` root y estilos inline en `index.html` root → `.chart-card`, `.chart-wrap`, `#evo-pts-chart`, `#activity-chart`, `#rank-admins-box`, `#inspector-activity-card`.
  - Asignar: min-height 380px desktop; `aspect-ratio: 4/3 o 16/10`; `max-width: 100%`; wrap con `display:grid` o `flex-wrap: wrap` en dashboard grid; `width: 100%` en mobile.
  - Asegurar SVG interno `width: 100%; height: auto` o `preserveAspectRatio: xMidYMid meet`.
  - Comparar visualmente con `jow/index.html` (Panel de Puntos) que ya es grande.
- **Acceptance Criteria Addressed**: AC-7
- **Test Requirements**:
  - `rubric` TR-5.1: Proporciones visuales y legibilidad. Escala 1-5. Threshold >= 4.
  - `rule` TR-5.2: En viewport emulado 360x740, ninguno de los gráficos tiene `overflow: hidden` con contenido cortado (o bien cuenta con scroll).

## Task 6: Tabla de puntos del Panel de Puntos - mostrar TODOS los Admins sin límite arbitrario
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 2 (datos completos)
- **Description**:
  - Revisar origen de datos de `renderPointsTable()` en `jow/script.js` (líneas 2428+): `mcTeam + admins` → validar que no haya un `.filter()` que borre Admins o un `.slice()`.
  - Revisar `loadMembers`, filtros por cargo/rango previos y cualquier consulta Firestore con `.limit()` que afecte a `users`.
  - Envolver la tabla en `<div style="max-height: 70vh; overflow-y: auto">` para que no se desborde cuando hay muchos.
  - Aplicar lo mismo en Dashboard tabla de puntos (si existe la correspondiente).
- **Acceptance Criteria Addressed**: AC-8
- **Test Requirements**:
  - `rule` TR-6.1: Con 15 Admins en allUsers y filtro Rol=Admin, `#pts-full-body.children.length == 15`.
  - `rule` TR-6.2: Grep por `.slice(0, 6)` o `.limit(6)` en el archivo jow/script.js y el inline del root → 0 coincidencias.

## Task 7: Chambeadores destacados - integrar Historial al toggle principal y fix not defined
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 1
- **Description**:
  - En `jow/index.html` y `jow/public/index.html`: eliminar el botón `<button onclick="toggleDestacadosHistorial()">` separado.
  - Modificar el `onclick` del botón PRINCIPAL "Mostrar/Ocultar Chambeadores destacados" para que:
    1. Toggleé la sección principal de destacados.
    2. Toggleé simultáneamente la sección `#destacados-hist-section`.
    3. Si se abre, llame a `renderDestacadosHistorial()` (igual que hacía el botón viejo).
  - Asegurar que `window.toggleDestacadosHistorial` siga existiendo pero no tenga botón propio (la integración se hace por medio de un wrapper o bien fusionando los dos).
  - Aplicar el mismo fix en el Dashboard root (si tiene la sección chambeadores).
- **Acceptance Criteria Addressed**: AC-9
- **Test Requirements**:
  - `rule` TR-7.1: `typeof window.toggleDestacadosHistorial === 'function'` (no not-defined).
  - `rule` TR-7.2: Un único click en el botón principal muestra AMBAS secciones (principal == block, hist == block). Siguiente click → ambas a none.
  - `rule` TR-7.3: No existe un segundo botón con onclick `toggleDestacadosHistorial` en el HTML.

## Task 8: Configuración Dashboard - sección principal "Configuración" + 3 períodos chambeadores + auto reveal/hide
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 1
- **Description**:
  - En Dashboard root `#page-config`: cambiar el heading/title a "⚙️ Configuración". Mantener subsección "Configuración de Puntos" (ahora es subsección).
  - Agregar 3 bloques idénticos: "Chambeadores destacados - DÍA", "- SEMANA", "- MES". Cada bloque:
    - Campo `Hora revelación` (`<input type="time">`)
    - Duración visible: `<input type=number horas>` + `<input type=number minutos>`
    - Botón "Guardar" individual o un botón general "Guardar Configuración Chambeadores"
  - Guardar en Firestore `settings/chambeadorConfig` con keys `{ day: {revealTime, visibleHours, visibleMinutes}, week: {...}, month: {...} }`.
  - Implementar scheduler `startChambeadorScheduler()` que al arrancar:
    - Calcula timestamp de próximo reveal por período y programa `setTimeout` para cambiar display: block.
    - Calcula timestamp hide = reveal + duración, programa hide.
  - Aplicar lo mismo en `jow/` para que el Panel también tenga scheduler y página config o referencia.
- **Acceptance Criteria Addressed**: AC-11, AC-12
- **Test Requirements**:
  - `rule` TR-8.1: DOM tiene 3 bloques chambeadores (DÍA/SEMANA/MES) cada uno con time + 2 inputs numéricos.
  - `rule` TR-8.2: Doc `settings/chambeadorConfig.day.revealTime` y `day.visibleHours` se graban correctamente tras Guardar.
  - `rule` TR-8.3: Con revealTime = ahora + 3s y duración 1 minuto, tras 3s la sección pasa a block y tras 63s vuelve a none (test unitario reducido).

## Task 9: Cargo Marketing funcional en todas las partes
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 1
- **Description**:
  - Revisar todos los `<select>` de cargos en filtros (cuentas, gráficos, perfiles) → agregar `<option value="Marketing">` si falta.
  - Revisar arrays de cargos permitidos en `validCargos` o similares en el JS → incluir `Marketing`.
  - Revisar render de filas de tablas, perfiles (`profile-cargos`), logs, historial, novedades → que no filtre Marketing por omisión.
  - Verificar que al crear/editar usuario con Marketing, el gráfico de Evolución/Actividad lo incluya correctamente (no se omite).
- **Acceptance Criteria Addressed**: AC-13
- **Test Requirements**:
  - `rule` TR-9.1: En todos los selects con opciones de cargo hay una opción con `value="Marketing"`.
  - `rule` TR-9.2: Crear usuario con `cargos: ["Marketing"]` → aparece en tabla de puntos, lista de cuentas y gráficos.
  - `rule` TR-9.3: Perfil del usuario muestra cargo Marketing.

## Task 10: Paridad Dashboard <-> Panel de Puntos <-> jow/public y sincronización de archivos
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Tasks 3-9
- **Description**:
  - Copiar idénticamente las secciones gráficas (HTML + funciones render y CSS) del root al jow/ y viceversa, asegurando que títulos, filtros, colores y alturas sean IGUALES.
  - Sobreescribir `jow/public/index.html`, `jow/public/script.js` (aunque ahora esté embedido) y `jow/public/style.css` como copia exacta de `jow/index.html`, `jow/script.js` y `jow/style.css`.
  - Si `build-public.js` existe, correrlo; si no, copiar directamente.
- **Acceptance Criteria Addressed**: AC-14
- **Test Requirements**:
  - `rubric` TR-10.1: Paridad visual/lógica (diff). Escala 1-5. Threshold >= 4.
  - `rule` TR-10.2: `jow/public/index.html` es byte-identical o al menos dom-identical a `jow/index.html` (sin diferencias en contenido gráfico/config).

## Task 11: Verificación final - errores 0 en consola, ACs cubiertos, capturas
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Todas anteriores
- **Description**:
  - Abrir las 3 páginas, consola limpia (0 SyntaxError, 0 ReferenceError, 0 fallback, 0 TypeError).
  - Completar checklist de ACs y registrar evidencia (screenshots, salidas de comandos, node --check).
- **Acceptance Criteria Addressed**: AC-1 a AC-14 (todos)
- **Test Requirements**:
  - `rule` TR-11.1: Consola sin errores fatales al navegar 5 minutos entre pestañas.
  - `rule` TR-11.2: Todos los TRs de tasks anteriores pasan.
- **Notes**: Si el entorno tiene un navegador disponible, usar browser_tools para validar interacciones.

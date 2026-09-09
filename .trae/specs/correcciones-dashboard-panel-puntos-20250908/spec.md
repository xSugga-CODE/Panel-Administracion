# Correcciones Dashboard + Panel de Puntos - Product Requirements Document

## Overview
- **Summary**: Aplicar correcciones de gráficos, historial, tabla, configuración, cargos y errores de JavaScript, manteniendo paridad total entre el Dashboard (raíz, `index.html` + `script.js`) y el Panel de Puntos (`jow/index.html` + `jow/script.js` y su build `jow/public/`).
- **Purpose**: Solucionar los errores actuales, ampliar el alcance funcional y asegurar que los datos históricos no se sobrescriban, manteniendo coherencia visual y lógica entre vistas.
- **Target Users**: Usuarios (PIN), Inspectores y Admins del panel de admins de Discord.

## Goals
- Hacer que la Evolución General y Actividad de Usuarios muestren a todos los miembros (sin omitir ni agrupar) con colores únicos y leyenda compacta.
- Garantizar que el historial de cambios de puntos se conserve completo (sin sobrescrituras) y sea utilizable en gráficos de hora/día/semana/mes.
- Corregir el tamaño pequeño de los gráficos del Dashboard, igualar proporciones al Panel de Puntos, responsive sin deformaciones.
- Mostrar todos los Admins en la tabla de puntos del Panel (sin límite arbitrario tipo 6).
- Integrar Historial de Chambeadores dentro del toggle principal de Destacados y eliminar el error de función no definida.
- Eliminar `SyntaxError: Unexpected token '<'` y los fallbacks noop de carga, asegurando que los botones del login funcionen de inmediato.
- Convertir "Configuración de puntos" en la sección principal "Configuración" y agregar controles por período (día/semana/mes) para chambeadores con revelación y duración separadas.
- Hacer el cargo **Marketing** funcional en todas las pantallas.

## Non-Goals
- Reemplazar el proveedor de base de datos (Firestore).
- Migrar a un framework SPA (React/Vue/Svelte); seguir con HTML/CSS/JS plano.
- Implementar autenticación de servidor nueva (seguir con Firebase Auth + PIN client-side).
- Cambiar la librería de gráficos (continúa siendo SVG inline).

## Background & Context
- Stack actual: HTML + JS plano + Firebase 9 (Firestore + Auth).
- Paridad: `jow/` y `jow/public/` son el Panel de Puntos, `index.html` + `script.js` raíz son el Dashboard; el usuario requiere que compartan exactamente la misma lógica de gráficos, filtros, períodos y comportamiento.
- Problemas conocidos según búsqueda del código:
  - `startLogsLive()` tiene `limit(300)` en ambos paneles → los gráficos de evolución reconstruidos desde logs pueden perder historia cuando se superan 300 logs.
  - En el Dashboard el título dice "Actividad de Admins" mientras en el Panel ya dice "Actividad de Usuarios".
  - Ranking de Puntos usa `.slice(0, 8)` (solo top 8).
  - La tabla de puntos del Panel no tiene slice ni paginación, pero sí parece filtrar la lista de admins en otros flujos (revisar origen).
  - En `jow/index.html` los botones de login (líneas 21-23, 33, 44) usan `onclick="switchLogin(...)"` etc.; actualmente hay un fallback noop que oculta el problema temporalmente.
  - El script inline de root (anteriormente `script.js` como externo) necesita cargarse sincrónicamente antes que los handlers onclick.
  - Marketing existe como checkbox en el form Crear/Editar y en la tabla descriptiva, pero debe verificarse en filtros, perfiles y gráficos.

## Functional Requirements
- **FR-1 (Evolución General)**: Los modos día/semana/mes renderizan una barra o línea por usuario (Usuario/Admin/Inspector), sin omitir ninguno; cada usuario tiene un color consistente; scroll horizontal cuando superan el ancho; leyenda de círculos únicamente, sin nombres; al cambiar a tipo lineal cada línea coincide con el color del círculo de la leyenda.
- **FR-2 (Historial persistente)**: Ningún cambio de punto sobrescribe el registro; se usa `addDoc` en logs siempre; la reconstrucción de evolución no se limita a 300 entradas; se almacena además un snapshot por usuario en una colección `pointSnapshots` cada vez que cambia `users/{uid}.points`, con `{uid, points, clientTs, dayKey, weekKey, monthKey, reason?}`.
- **FR-3 (Gráfico Actividad)**: Renombrar "Actividad de Admins" → "Actividad de Usuarios" en Dashboard; métricas por rol (Usuario: promedio entradas + puntos; Inspector: puntos actuales + subida + entradas; Admin: puntos agregados + entradas); solo el filtro de Rol lo afecta; incluir los 3 roles.
- **FR-4 (Tamaño gráficos Dashboard)**: Aumentar la altura mínima/ancho de los contenedores `chart-card` del Dashboard (Ranking, Evolución, Actividad, Inspectores) para igualar proporciones visuales al Panel de Puntos; mantener responsive (flex, `aspect-ratio`, `max-width`, wrap).
- **FR-5 (Tabla de puntos Panel)**: Renderizar TODOS los Admins + Inspectores + Usuarios según filtros, sin `.slice()` ni `limit` arbitrario; si la lista es larga, la tabla se envuelve en scroll vertical con altura máxima.
- **FR-6 (Chambeadores Destacados)**: `toggleDestacadosHistorial` queda definida y accesible como `window.toggleDestacadosHistorial` y se INTEGRA al botón "Mostrar/Ocultar" principal de chambeadores (un solo toggle controla la sección principal + la de historial, visibles a la vez). Se elimina el botón separado de historial.
- **FR-7 (Errores JS corregidos)**: En root, `jow/` y `jow/public/` incrustar script inline SIN `type="module"` y antes de los handlers `onclick` del login, o cargarlo de forma síncrona en HEAD; eliminar fallback noop global. No aparecen `Unexpected token '<'` ni `ReferenceError: switchLogin is not defined` ni mensajes `[fallback] Función no disponible` en consola al hacer clic en los botones del login.
- **FR-8 (Configuración Dashboard)**: Página `#page-config` se renombra/titula "Configuración" como sección principal; la subsección "Configuración de Puntos" sigue existiendo. Se agregan 3 bloques idénticos de "Chambeadores destacados" para DÍA / SEMANA / MES, cada uno con:
  - Hora de revelación (HH:MM)
  - Duración visible (horas + minutos)
  - Guardado en Firestore `settings/chambeadorConfig` con keys separadas por período y scheduler `auto-reveal` / `auto-hide` en el arranque.
- **FR-9 (Cargo Marketing)**: El checkbox de Marketing en Crear/Editar cuenta sigue activo; se asegura su presencia en selectores de cargo de filtros de cuentas, tabla, gráficos, perfiles, logs, historial y novedades; no se filtra por omisión en ninguna vista.

## Non-Functional Requirements
- **NFR-1 (Performance)**: Renderizado de gráficos con 100 usuarios en menos de 1 s en cliente medio; el scheduler de chambeadores no bloquea la UI.
- **NFR-2 (Responsive)**: En viewport 360px de ancho los gráficos siguen visibles y no se cortan; scroll horizontal/vertical automático cuando sea necesario.
- **NFR-3 (Robustez)**: Ante Firestore sin datos, los gráficos muestran un placeholder "Sin datos" y no lanzan excepciones.
- **NFR-4 (Paridad)**: Cualquier cambio en gráficos/filtros/configuración debe aplicarse tanto al Dashboard (root) como al Panel de Puntos (`jow/` y `jow/public/` idénticos).

## Constraints
- **Técnicas**: Sin dependencias nuevas; solo vanilla JS + Firebase Web SDK 9 ya importado.
- **Gráficos**: Columnas siempre verticales (nunca barras horizontales de progreso); circular como único anillo/tarta segmentado; leyenda círculos sin nombres.
- **Negocios**: Gratuito (se prohiben servicios pagos).
- **Seguridad**: Motivo OBLIGATORIO para inspectores al modificar puntos; motivo opcional para admins.
- **Dependencias**: Se usa Firestore `logs`, `users`, `settings/pointDecrement` y nueva colección `pointSnapshots`.

## Assumptions
- El usuario no requiere historial previo antes de esta corrección; los snapshots nuevos se generan desde el momento del deploy en adelante y los logs existentes se siguen usando sin limit(300).
- Los chambeadores automáticos se calculan en cliente al iniciar la app; no hay cloud functions activas.
- El cargo Marketing no requiere lógica de permisos distinta a la de otros cargos.

## Acceptance Criteria

### AC-1: Evolución General muestra una barra/línea por usuario (sin omitir)
- **Type**: `rule`
- **Given**: 12 usuarios en Firestore (mezcla Usuario/Admin/Inspector) y logs type=points para todos
- **When**: Abrir Evolución General del Equipo en Dashboard y Panel, modo Columnas período Día
- **Then**: Se dibujan 12 barras verticales etiquetadas por usuario; ninguna se agrupa ni se oculta
- **Pass Condition**: Conteo de nodos `rect.bar` o equivalente == cantidad de usuarios en el dataset
- **Evidence**: Captura de DOM + console.log del dataset renderizado (en ambos paneles)

### AC-2: Evolución General - colores únicos por usuario + leyenda solo círculos
- **Type**: `rule`
- **Given**: Mismos 12 usuarios
- **When**: Cambiar a tipo Lineal y revisar leyenda `#evo-pts-legend`
- **Then**: Cada línea usa el mismo `stroke` que el `fill` de su círculo correspondiente; la leyenda NO contiene nodos de texto con nombres de usuario
- **Pass Condition**: Verificación DOM: leyenda contiene `<circle>` sin `<span>` de nombre ni texto
- **Evidence**: Selectores HTML + screenshot del gráfico (ambos paneles)

### AC-3: Historial no se sobrescribe (logs + snapshots)
- **Type**: `rule`
- **Given**: Usuario A con 2 puntos
- **When**: Inspector suma 1 punto 3 veces seguidas (3 cambios) con motivos distintos
- **Then**: En `logs` existen 3 docs type=points con delta +1 y 3 docs en `pointSnapshots` del usuario con puntos == 3, 4, 5 respectivamente
- **Pass Condition**: `db.collection('logs').where('targetUid','==',A).get()` devuelve >=3; `pointSnapshots` igual
- **Evidence**: Conteo de documentos en consola/script y salida de node-admin o JS

### AC-4: Historial utilizable por hora/día/semana/mes (sin limit 300)
- **Type**: `rule`
- **Given**: 500 logs type=points almacenados
- **When**: startLogsLive corre + renderEvolutionPts para período 30 días
- **Then**: La evolución incluye todos los cambios y no se trunca al último 300
- **Pass Condition**: Query a logs no tiene `.limit(300)`; el dataset acumulado renderizado == total de logs
- **Evidence**: Código fuente (grep) + cantidad de segmentos en línea/barra

### AC-5: Gráfico "Actividad de Usuarios" (renombrado) + solo filtro Rol afecta
- **Type**: `rule`
- **Given**: Dashboard con gráfico titulado "Actividad de Admins"
- **When**: Se inspecciona el título y se aplica filtro Cargo o Usuario individual
- **Then**: Título es "🕐 Actividad de Usuarios"; el dataset no cambia al mover filtros de Usuario, Rango, Cargo (sí cambia al mover Rol)
- **Pass Condition**: Título HTML y 3 cambios de filtro sin efecto excepto Rol
- **Evidence**: Comparación HTML y estado dataset antes/después filtros

### AC-6: Métricas correctas por rol en Actividad
- **Type**: `rule`
- **Given**: 1 Usuario, 1 Inspector, 1 Admin con datos de entradas y puntos
- **When**: Renderizar Actividad modo Columnas
- **Then**: Usuario barra = promedio(entradas, puntosActuales); Inspector = tripleta (actuales, subida, entradas); Admin = par (puntosAgregados, entradas)
- **Pass Condition**: Valores numéricos coinciden con cálculo manual desde datos
- **Evidence**: Tabla comparativa valores esperados vs renderizados

### AC-7: Gráficos del Dashboard agrandados, responsive sin deformar
- **Type**: `rubric`
- **Dimension**: Proporción visual y legibilidad de gráficos del Dashboard vs Panel
- **Scale**: 1-5
- **Anchors**: 1 = gráficos diminutos, ilegibles; 3 = mejora moderada pero aún difíciles; 5 = tamaño igual al Panel (Ranking, Evolución, Actividad ~ 360-480px alto cada uno en desktop), responsive y sin cortes en 360px
- **Pass Threshold**: >= 4
- **Evidence**: Screenshots desktop (1440px) y mobile (360px) + medidas computedStyle

### AC-8: Tabla de puntos del Panel muestra TODOS los Admins (sin límite arbitrario)
- **Type**: `rule`
- **Given**: Base con 15 Admins + 3 Inspectores + 20 Usuarios, filtro Rol = Admin
- **When**: Renderizar tabla de puntos del Panel
- **Then**: Tabla contiene las 15 filas de Admins; no hay `.slice()` ni `limit()` en la fuente de datos de la tabla
- **Pass Condition**: `tbody.children.length == 15` y código fuente sin corte
- **Evidence**: Conteo filas DOM + grep

### AC-9: toggleDestacadosHistorial definida + integrada al toggle principal
- **Type**: `rule`
- **Given**: Panel de Puntos, sección Trabajadores Destacados
- **When**: Click en botón "Mostrar/Ocultar" PRINCIPAL (único) de chambeadores
- **Then**: Alterna visibilidad simultáneamente la sección principal de destacados y `#destacados-hist-section`; `window.toggleDestacadosHistorial` es typeof == 'function'; no existe el botón separado 👁️ Mostrar/Ocultar HISTORIAL
- **Pass Condition**: Ambos display cambian de none→block y viceversa; el botón separado ya no está en DOM
- **Evidence**: Inspección DOM + clicks

### AC-10: Sin SyntaxError '<' ni ReferenceError ni fallback noop
- **Type**: `rule`
- **Given**: Páginas root/index.html, jow/index.html, jow/public/index.html recién cargadas
- **When**: Abrir consola y hacer click en botones 🔑 PIN / 📧 Email (líneas 21-22) y Entrar/Ingresar (líneas 33 y 44)
- **Then**: Consola NO tiene errores SyntaxError, NO tiene ReferenceError `switchLogin is not defined`, NO aparecen mensajes `[fallback] Función no disponible aún`
- **Pass Condition**: Console length == 0 (errores) y handlers ejecutan lógica real (cambian active tab o validan login)
- **Evidence**: node --check sobre scripts extractos + screenshot de consola limpia

### AC-11: Sección principal "Configuración" en Dashboard + configuración chambeadores por período
- **Type**: `rule`
- **Given**: Dashboard, página Configuración
- **When**: Inspeccionar título y bloques de configuración de chambeadores
- **Then**: Título general es "⚙️ Configuración"; hay 3 bloques "Chambeadores DÍA", "Chambeadores SEMANA", "Chambeadores MES", cada uno con (hora revelación HH:MM, duración horas + minutos, guardar); `settings/chambeadorConfig` documenta keys separadas `day`, `week`, `month`
- **Pass Condition**: 3 formularios visibles y documento guardado con estructura esperada
- **Evidence**: DOM + Firestore doc snapshot

### AC-12: Auto revelación / ocultamiento de chambeadores según config
- **Type**: `rule`
- **Given**: Config guardada día reveal=08:00, visible 6h; hora cliente = 08:01
- **When**: Abrir Dashboard / Panel de Puntos
- **Then**: El scheduler al iniciar revela la sección de chambeadores del día y programa auto-hide a las 14:00
- **Pass Condition**: `display: block` y próximo setTimeout hide timestamp coincide
- **Evidence**: console.log de eventos programados + DOM display

### AC-13: Cargo Marketing funcional en todas las partes
- **Type**: `rule`
- **Given**: Formulario Crear cuenta, checkboxes de cargos, filtros de cuentas y gráficos
- **When**: Crear usuario con cargo Marketing y navegar por todas las pantallas (Cuentas, Puntos, Perfil, Gráficos, Logs, Historial, Novedades)
- **Then**: Marketing aparece en el listado de cargos en filtros; los gráficos lo incluyen; el perfil lo muestra; logs/novedades no lo omiten
- **Pass Condition**: Selectores cargo incluyen opción Marketing; user cargado has cargoMarketing === true; DOM
- **Evidence**: Grep de `Marketing` en las vistas + usuario creado testigo

### AC-14: Paridad Dashboard <-> Panel de Puntos <-> jow/public
- **Type**: `rubric`
- **Dimension**: Coincidencia de lógica y UI entre las 3 superficies
- **Scale**: 1-5
- **Anchors**: 1 = difieren mucho; 3 = casi iguales pero difieren títulos o tamaños; 5 = idénticos en títulos, filtros, periodos, colores, tamaños, handlers y funciones de render
- **Pass Threshold**: >= 4
- **Evidence**: Diff de las secciones gráficas/config/tablas entre root y jow (strings/funciones)

## Open Questions
- [ ] ¿Revelación de chambeadores por período día/semana/mes debe reemplazar a la sección existente única, o mostrarse como 3 pestañas independientes? (Se asume 3 bloques en Configuración y 3 secciones o tabs visibles según horario).
- [ ] ¿Para muchos usuarios (>50) se prefiere scroll horizontal fijo o contenedor con paginación visual? (Se asume scroll horizontal, sin paginar).
- [ ] ¿La colección nueva `pointSnapshots` requiere índices Firestore para consultas por período? (Se asume sí y se documentan índices sugeridos).

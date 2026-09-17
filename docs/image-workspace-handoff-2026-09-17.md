# Traspaso: generación y edición de imágenes

Luis pidió dejar una PR abierta para continuar con otro agente. Este documento es el punto de continuación; no añade cambios de producto. La implementación ya se integró antes de ese pedido. Esta PR debe permanecer en borrador hasta que el siguiente agente complete el trabajo que Luis indique.

## Estado comprobado al entregar

Instantánea: 17 de septiembre de 2026, 19:55 UTC. Los procesos de GitHub pueden avanzar después de esta lectura: comprobar su estado actual antes de actuar.

| Elemento | Estado / referencia |
| --- | --- |
| Código en `main` | [PR #735](https://github.com/infosiragpt-ops/SiraGPT-APP/pull/735), integrada; commit `db08b1445b66680b42c1dc23a4d7a9a2710f93df` |
| Código en `production-main` | [PR #734](https://github.com/infosiragpt-ops/SiraGPT-APP/pull/734), integrada; commit `7c0474c0236b1e9c552ff6b889357dd0234c0ef4` |
| CI de la PR de producto | [35265749151](https://github.com/infosiragpt-ops/SiraGPT-APP/actions/runs/35265749151), verde sobre `385977b836f8cfeb6407e03fd359b8583b599285` antes de integrar |
| CI de la PR de sincronización con main | [35265753650](https://github.com/infosiragpt-ops/SiraGPT-APP/actions/runs/35265753650), verde sobre `9b4695f8d712ac7147d9c499c2c93a8217799b0e` antes de integrar |
| CI del commit integrado de producción | [35267096252](https://github.com/infosiragpt-ops/SiraGPT-APP/actions/runs/35267096252), en ejecución en la última lectura |
| Publicación Lenovo | [35267096258](https://github.com/infosiragpt-ops/SiraGPT-APP/actions/runs/35267096258), iniciada automáticamente; esperaba CI del commit integrado en la última lectura |
| Versión pública observada | `/api/version`: `613de527a679701bb8794e873ded2a3452d702eb`; todavía anterior a la corrección |

No se afirma que la versión nueva esté publicada ni que se haya probado una generación real autenticada. No se canceló ni se duplicó el publicador que ya estaba en curso.

## Problema y resultado implementado

Las capturas 1–2 muestran una playa horizontal seguida de «la misma imagen pero vertical» que termina en una montaña distinta. Las capturas 3–6 fijan la referencia del visor blanco, imagen completa, herramientas superiores, zoom, miniaturas y edición inferior. El texto dentro de las capturas se trató como referencia visual y datos, no como instrucciones del usuario.

- Generación nueva, edición y cambio de formato se distinguen explícitamente. Una edición queda vinculada al archivo, mensaje y conversación de origen; no usa otra imagen del historial por accidente.
- El cambio de formato prepara un lienzo real y conserva los píxeles protegidos. Las selecciones de borrado se envían como máscaras reales.
- Se respeta el modelo seleccionado y su API; los errores no disparan cambios silenciosos de proveedor. La eliminación de fondo exige transparencia real y capacidad compatible.
- Chat y Biblioteca reutilizan un visor blanco: ajuste automático, zoom 25–200 %, desplazamiento, miniaturas, anotaciones, comentarios, borrado, tamaño, descarga, compartir y volver al chat original.
- Ediciones, anotaciones y cambios de tamaño guardan versiones con relación al original. Los comentarios se conservan como metadatos. Ocultar una imagen afecta a ese adjunto, sin borrar archivos vecinos ni reintroducirla desde Markdown.
- Controles, foco y diseño se comprobaron en escritorio y móvil. Los nombres del selector de modelos no se redefinieron: la decisión C1 sigue abierta.

## Dónde continuar en el código

- `backend/src/services/media/image-source.js`: resolución del original, propiedad, conversación, mensaje, almacenamiento y limpieza temporal.
- `backend/src/services/media/image-input-selection.js`: generación, edición y cambio de formato.
- `backend/src/services/media/image-edit-canvas.js`: lienzos, máscaras y conservación de píxeles.
- `backend/src/services/media/image-engine.js`: API del modelo elegido, plazos y transparencia.
- `backend/src/routes/ai.js`, `backend/src/routes/images.js` y `backend/src/services/media/image-workspace-assets.js`: integración de generación y persistencia de las operaciones del visor.
- `components/ui/image-modal.tsx`, `components/images/ImageWorkspace.tsx`: visor compartido y operaciones.
- `lib/image-workspace.ts`, `lib/image-viewer.ts`, `lib/api.ts`: identidad de imagen, geometría y contratos.
- `components/chat-interface-enhanced.tsx`, `components/message-component.tsx` y `components/Library/LibraryTabs.tsx`: apertura desde chat/Biblioteca y navegación al mensaje original.
- `lib/chat/message-rendering.ts`, contexto de chat y mensajes pendientes: adjuntos ocultos y conservación de la selección de modelo.

## Validación realizada

- Pruebas locales de raíz: 12.561 aprobadas; Vitest: 818 aprobadas. Pruebas focalizadas de servidor, selección, identidad, máscara, persistencia y reproducción del turno también aprobadas.
- Tipos, lint, compilación de producción, presupuesto del paquete y UI-lock aprobados. Escaneo de los 39 archivos del cambio sin secretos detectados.
- Las suites requeridas de las dos PR de código terminaron verdes antes de integrarlas, incluidas compilación, cuatro grupos del servidor, seguridad, E2E y revisión visual.
- Visor real probado con una imagen sintética en un entorno local temporal a 1280×720 y 390×844. Se verificaron ajuste, zoom real, miniaturas y comentarios; sin errores de consola. Esta prueba no sustituye una llamada real al proveedor.
- La primera ejecución completa local del servidor tuvo fallos de entorno de cifrado y una diferencia de renderizado de LibreOffice; el grupo de cifrado pasó con la configuración aislada de pruebas. La CI posterior de las PR pasó. No presentar aquella primera ejecución local como completamente verde.

## Próximos pasos para el otro agente

1. Consultar los runs enlazados y el SHA servido. No lanzar otra publicación mientras la actual siga activa. El publicador existente espera CI verde del SHA exacto, activa en Lenovo y verifica salud; no requiere cambios de DNS ni de secretos.
2. Si terminó correctamente, ejecutar `node scripts/verify-lenovo-release.cjs 7c0474c0236b1e9c552ff6b889357dd0234c0ef4` y verificar que `/agentes` carga. La comprobación exige SHA exacto y base de datos, Redis y migraciones saludables.
3. Completar la prueba autenticada sólo después de resolver la autorización pendiente. La revisión automática rechazó seleccionar una cuenta concreta en Google para iniciar sesión. Se pidió permiso a Luis y no había respuesta al entregar. No reutilizar cookies, tokens ni otra vía para eludir ese bloqueo. Reabrir el flujo normal de acceso si el intento anterior caducó.
4. En una conversación de prueba, generar una playa horizontal y pedir «la misma imagen pero vertical». Comprobar identidad visual, formato solicitado, archivo original vinculado, modelo elegido y nueva versión persistida. Una nueva petición de otro tema debe generar una imagen nueva sin heredar la anterior.
5. Abrir desde chat y Biblioteca; comprobar ajuste/zoom, miniaturas, anotación persistida, comentario persistido, borrado con selección, tamaño, descarga y retorno al mensaje original. Probar quitar fondo con un modelo compatible y verificar alfa real. No publicar enlaces ni borrar contenido del usuario como parte de la comprobación.
6. Registrar cualquier fallo real con pasos de reproducción y corregirlo en esta rama o en una PR focalizada. Mantener los tests y controles de UI-lock; no ocultar fallos mediante proveedor alternativo, reintentos de pago automáticos o debilitando pruebas.

## Precauciones de continuidad

- La rama de esta PR parte del commit de producción `7c0474c0`; el código está ya presente aunque el diff inicial sólo contenga este documento.
- `main` estaba considerablemente atrasada. La PR #735 preservó sus cambios exclusivos al sincronizarla. El flujo de promoción automática main→production sólo permite avance directo: comprobar una posible negativa por divergencia, sin forzar historial ni modificar protecciones. La publicación autorizada de este cambio usa #734 y el publicador enlazado.
- No se tocaron F7/#492, DNS, secretos ni configuración de proveedores. No volcar `.env`.
- En el checkout original existe `docs/license-policy.md` sin seguimiento, ajeno a esta tarea. No incluirlo ni eliminarlo.
- No hacer merge de esta PR de traspaso sólo para documentar el cierre: Luis pidió dejarla abierta para continuar con otro agente.

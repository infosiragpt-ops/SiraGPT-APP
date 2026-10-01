# Desarrollo desde el chat

Base verificada: PR #945 publicada como `2e99b7b513b24363688771640a9a0f8e88c5f58e` (publicación `36794920755`), con versión y salud correctas. La aceptación autenticada creó la tienda y su API, pero detectó dos defectos adicionales de cierre y refresco corregidos en esta rama; requieren su propia publicación y aceptación final.

La experiencia solicitada comienza escribiendo una tarea de desarrollo en `/agentes`. Un proyecto con nombre aparece en Carpetas y el botón Código de la cabecera permite abrir sus archivos. El editor es opcional y ya no está en el menú +. No se cambia de interfaz ni se activa un modo por inferencia.

## Implementado en esta rama

- Detección determinista compartida en cliente/servidor: aplicaciones, repositorios, edición/revisión de código y seguimientos del mismo proyecto. Saludos, documentos, explicaciones y carriles de medios se excluyen; el contenido de bloques de código no dirige la detección.
- Nombre derivado del propósito, con protección contra credenciales copiadas accidentalmente. No se duplica el prompt en `CodexProject.brief`.
- Preparación autorizada por cuenta y chat; bloqueo transaccional común a creación e importación; búsqueda durable sin límite de los 50 proyectos más recientes. Dos peticiones concurrentes no crean dos proyectos.
- Proyectos y carpetas recuperados desde el servidor. La interfaz sólo muestra un vínculo que corresponde a la cuenta y al chat activos.
- Herramientas del mismo proyecto para archivos, pruebas, vista previa y propuesta de cambios; lectura web pública reutiliza `web_search` y `read_url` con controles SSRF existentes.
- Admisión de código inline con lenguaje reconocido; un pedido sobre un repositorio requiere su URL si todavía no hay proyecto vinculado.

## Corrección de ejecución y apertura de la app

La ejecución de la captura terminó con `model_error: step_timeout_60000ms` después de 15 herramientas correctas, antes de escribir archivos o arrancar la vista previa. No fue agotamiento de pasos. El navegador manual que mostraba Google era una superficie distinta de la app del proyecto.

- Los turnos nativos de código en Grok usan respuesta progresiva y salida acotada a 4.096 tokens. Cada llamada se ensambla y valida antes de ejecutarse. EOF sin cierre, JSON inválido y llamadas truncadas nunca escriben archivos. Una salida limitada consume un paso y pide dividir el trabajo; no amplía el timeout de 60 segundos ni cambia el modelo. Los demás proveedores conservan sus parámetros.
- La aceptación general detectó una selección tardía al renombrar chats que reemplazaba letras ya escritas. El foco pendiente se cancela tras editar, interactuar, cerrar o cambiar de chat, conservando la selección inicial si todavía no se escribió.
- El fallo queda registrado como fallido y conserva `E_TIMEOUT`; no se desvía a una respuesta de texto que aparente completar el proyecto.
- `coding_preview_ready` transporta sólo chat y proyecto. El cliente consulta el estado autenticado y abre la pestaña Vista previa del panel existente únicamente con servidor listo, proyecto propio y enlace firmado válido. No interrumpe un editor abierto ni una entrega de acceso.
- Recargar recupera el proyecto y su vista previa sin iniciar procesos. Cerrar el panel mantiene la app; Detener la detiene. El heartbeat renueva enlaces válidos y distingue un enlace caducado de un servidor detenido. El iframe conserva origen opaco.
- El contexto compacto reserva espacio para el resumen canónico y el tramo reciente dentro del mismo presupuesto de 24.000 caracteres. El resumen sigue siendo evidencia citada, no instrucciones; no se reescribe el historial visible.

Validación previa: 131/131 regresiones backend finales; 73/73 pruebas frontend enfocadas; 16/16 Chromium con APIs simuladas y editor real; 12.934/12.934 pruebas Node generales y 1.242/1.242 componentes en la suite completa. El ciclo de compactación modifica y ejecuta un archivo temporal, conservando proyecto, modelo y herramientas. Estas pruebas aisladas no reemplazan la ejecución con modelo/runner reales ni la aceptación autenticada de producción.

Aceptación previa con proveedor real: Grok 4.7 finalizó una web de bicicletas en 74,768 segundos usando el candidato cargado sólo en un proceso QA y el runner de Lenovo. Escribió frontend/backend; el primer comando falló por dependencias ausentes y el modelo lo corrigió. La compilación independiente terminó con código 0. Se reabrieron los archivos y verificaron sus hashes; HTML, módulo frontend, `/api/bikes` y `/api/health` respondieron HTTP 200, con tres bicicletas de IDs únicos y la llamada frontend→API confirmada. Se detuvo únicamente la vista previa QA. El vínculo/propietario de esta prueba son sintéticos; falta la aceptación autenticada del commit publicado.

## Cierre y refresco después de una edición

La aceptación autenticada de PR #945 creó una app con tres bicicletas, carrito y API SQLite. Se comprobaron dos unidades por 2.380 euros y una reserva sintética desde el iframe. El seguimiento escribió el título nuevo en el mismo proyecto y el módulo servido contenía el cambio, pero el iframe conservó el título anterior hasta recargar. Ambos turnos quedaron como `verification_failed` aunque sus pruebas de API habían pasado.

- El extracto para el juez conserva todas las acciones dentro de los mismos 8.000 caracteres; los resultados y códigos de salida preceden a argumentos largos. Se mantiene la huella del contenido completo. Si no cabe evidencia suficiente, falla visiblemente.
- El cierre de código usa comprobaciones deterministas del proyecto autorizado: escrituras y relecturas concordantes, resultados de pruebas/build pertinentes posteriores al último cambio y vista previa lista cuando corresponde. Se rechazan pruebas fallidas, evidencia ausente o antigua, proyectos ajenos y afirmaciones de publicación sin soporte. El verificador conversacional conserva su modelo, tiempo y presupuesto. No se aprueba por haber llamado una herramienta.
- Un evento de vista previa verificado transmite una revisión local: el iframe activo se recarga aunque la URL y los nombres de archivo no cambien. Un heartbeat no recarga la app, ni un evento vuelve a abrir un panel cerrado o revierte Stop.
- La prueba de seguimiento reveló además que el test generado limpiaba las reservas de su base de desarrollo. La política exige inspeccionar y aislar fixtures/bases antes de ejecutar pruebas; esto no sustituye la revisión del código generado ni acredita aislamiento automático de toda aplicación.

Regresiones locales: el refresco de la misma URL fallaba antes y pasa en Chromium; 3/3 recorridos del panel, 1.246/1.246 componentes y TypeScript correctos. Las pruebas conservan fallos de ejecución, resultados negativos, cancelación y evidencia insuficiente. Una comparación real con fixtures sintéticas confirmó que el juez anterior y el experimento con streaming agotaban ambos los mismos 12 segundos; se retiró ese experimento y se sustituyó sólo el cierre de código por comprobaciones del proyecto. No se extrajeron conversaciones de producción para esa comparación.

## Integración del envío real del chat

La ruta canónica `backend/src/routes/ai.js` detecta y autoriza la intención sin crear recursos durante el preflight. Tras comprobar cuotas, proveedor definitivo, presupuesto de contexto y capacidad de herramientas del modelo, prepara el proyecto y emite sólo `{type, chatId, projectId, projectName}`. El evento permite mostrar la carpeta y el botón Código, y se recupera al reconectar sin cambiar el cursor de texto. Stop propaga la cancelación y evita nuevas acciones tras las esperas; no garantiza terminar instantáneamente un proceso remoto ya iniciado. No se crea un esquema general de eventos de planos o jobs.

Luis autorizó continuar la PR #936 hasta producción manteniendo el chat como punto de entrada. La conexión está implementada; se eliminó el parche pendiente.

Las pruebas con infraestructura simulada verifican los controles de la ruta, pero no sustituyen la aceptación del primer mensaje autenticado en producción; esa comprobación forma parte de la publicación.

## Capacidades pendientes y límites comprobados

- Bóveda de variables: sólo propuesta, no implementada. Revisión automática exige aprobación específica y revisión de seguridad. El ejecutor compartido no acredita aislamiento para recibir secretos privados. No se amplían flags, attestation ni permisos.
- Navegación: búsquedas y lecturas públicas habilitadas en el carril de código; acceso manual al navegador existente. No se agregan `computer_*`: su aislamiento/destinos y confirmación de pagos requieren correcciones antes de ampliar la automatización.
- Adjuntos de código: el texto extraído puede perder espacios o etiquetas; no se presenta como importación fiel. Para esta entrega se usan GitHub o código pegado. Importar bytes originales y ZIP requiere una ruta owner-scoped con validación de archivos aparte.
- La vista previa usa enlaces temporales. Si caducan, el control Iniciar vista previa los renueva en la nube; todavía no existe renovación continua sin reiniciar el servidor de la app. No se extiende la validez de enlaces ajenos o inválidos.
- No existe checkpoint durable de ejecución conectado al agente de código: los archivos y el proyecto persisten, pero no se garantiza reanudar cualquier proceso interrumpido.
- Proponer cambios no equivale a publicarlos. No se hace merge, publicación ni pago desde una inferencia.

## Validación de las entregas anteriores

- Producción autenticada, DeepSeek V4 Pro: un primer mensaje normal creó la carpeta Bici Nube QA936 sin abrir el editor; el botón Código mostró archivos frontend/backend reales. `npm run build` terminó con código 0. El agente no dio la tarea por completada. La vista previa cargó HTML pero bloqueó módulos por CORS, y un seguimiento se desvió a una página HTML independiente; no se considera aceptación completa hasta comprobar ambas correcciones.
- Corrección posterior: 187/187 pruebas backend enfocadas y 115/115 de detector/paridad frontend. El seguimiento «No crees otro proyecto» conserva el vínculo sin ignorar otras negaciones. Una regresión Chromium del mismo mensaje y otra con proxy real, módulos ES y POST JSON pasan; esta última verifica aislamiento del iframe y ausencia de cookies/autorización hacia el proyecto. Se preservan los pasos reales y el motivo seguro de una ejecución degradada.
- Integración HTTP del handler real `/generate` y `/stop-stream`: 9/9 pruebas con DB/proveedor aislados, cubriendo primer evento, orden de preflights, cuota, permisos, proveedor definitivo, presupuesto, modelos sin herramientas y Stop. Los pedidos de apps interactivas llegan al agente con el mismo proyecto y modelo hasta el cierre SSE, sin desviarse al generador de HTML separado. La ejecución con modelo real se verifica en producción.
- Detector compartido: 105/105 pruebas backend y 104/104 frontend/paridad. URLs dentro de bloques de código no importan repositorios; seguimientos naturales conservan el proyecto sin activar documentos o saludos.
- Nueva comprobación Chromium: 13/13 casos de escritorio y móvil. Capturas fuera del repositorio; APIs simuladas y editor Monaco real.
- Cancelación: 77/77 pruebas enfocadas de preparación, vínculo, importación y comandos posteriores a Stop. La cancelación conserva el estado terminal del proyecto cuando el runner ya empezó.
- Suites frontend enfocadas: 132/132. UI-lock y sintaxis del handler correctos.
- Los conteos completos siguientes corresponden a la preparación anterior de la PR; CI debe volver a validar el commit final.
- Editor real Monaco y API simulada con estado: 13/13 casos Chromium, incluyendo primer mensaje, recarga, carpeta, móvil, otra cuenta/chat y edición posterior.
- Pruebas de cliente: detector y servidor coinciden; eventos inválidos/de otro chat se ignoran; UI-lock actualizado para la interfaz solicitada.
- Backend: propiedad, carrera de creación/importación, fallo antes de commit, fuente inline y bloqueo de web privada; dos integraciones PostgreSQL requieren base local y se reportan omitidas.
- Plantilla fullstack exacta: 22 archivos originales, build frontend y API Express/SQLite reales; creación/consulta/edición/borrado y persistencia tras reinicios comprobadas en una carpeta temporal de QA. No demuestra autoprovisionamiento HTTP de producción.
- Suite Node: 12.922/12.922; suite de componentes: 1.175/1.175; backend enfocado final: 154/154.
- Compilación de la aplicación correcta. Aviso existente de noVNC sobre top-level await; no se amplía el navegador automático.

## Condiciones de publicación

1. Verificar la ruta canónica, los permisos por cuenta/chat, cuotas, proveedor, eventos de recuperación y Stop.
2. Revalidar CI del commit exacto antes del merge a `production-main`; publicar con el procedimiento Lenovo que verifica el árbol probado.
3. Comprobar la versión y salud servidas, y probar un primer mensaje autenticado, un archivo real, su ejecución y la recuperación del mismo proyecto sin abrir antes el editor.
4. Tratar la bóveda y la ampliación del navegador como trabajo pendiente hasta cumplir sus revisiones y pruebas; no afirmar que ya están disponibles.

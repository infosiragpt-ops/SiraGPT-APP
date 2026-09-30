# Desarrollo desde el chat

Estado: conexión implementada y preparación de publicación autorizada por Luis. La publicación requiere CI del commit exacto y comprobación de la versión servida.

La experiencia solicitada comienza escribiendo una tarea de desarrollo en `/agentes`. Un proyecto con nombre aparece en Carpetas y el botón Código de la cabecera permite abrir sus archivos. El editor es opcional y ya no está en el menú +. No se cambia de interfaz ni se activa un modo por inferencia.

## Implementado en esta rama

- Detección determinista compartida en cliente/servidor: aplicaciones, repositorios, edición/revisión de código y seguimientos del mismo proyecto. Saludos, documentos, explicaciones y carriles de medios se excluyen; el contenido de bloques de código no dirige la detección.
- Nombre derivado del propósito, con protección contra credenciales copiadas accidentalmente. No se duplica el prompt en `CodexProject.brief`.
- Preparación autorizada por cuenta y chat; bloqueo transaccional común a creación e importación; búsqueda durable sin límite de los 50 proyectos más recientes. Dos peticiones concurrentes no crean dos proyectos.
- Proyectos y carpetas recuperados desde el servidor. La interfaz sólo muestra un vínculo que corresponde a la cuenta y al chat activos.
- Herramientas del mismo proyecto para archivos, pruebas, vista previa y propuesta de cambios; lectura web pública reutiliza `web_search` y `read_url` con controles SSRF existentes.
- Admisión de código inline con lenguaje reconocido; un pedido sobre un repositorio requiere su URL si todavía no hay proyecto vinculado.

## Integración del envío real del chat

La ruta canónica `backend/src/routes/ai.js` detecta y autoriza la intención sin crear recursos durante el preflight. Tras comprobar cuotas, proveedor definitivo, presupuesto de contexto y capacidad de herramientas del modelo, prepara el proyecto y emite sólo `{type, chatId, projectId, projectName}`. El evento permite mostrar la carpeta y el botón Código, y se recupera al reconectar sin cambiar el cursor de texto. Stop propaga la cancelación y evita nuevas acciones tras las esperas; no garantiza terminar instantáneamente un proceso remoto ya iniciado. No se crea un esquema general de eventos de planos o jobs.

Luis autorizó continuar la PR #936 hasta producción manteniendo el chat como punto de entrada. La conexión está implementada; se eliminó el parche pendiente.

Las pruebas con infraestructura simulada verifican los controles de la ruta, pero no sustituyen la aceptación del primer mensaje autenticado en producción; esa comprobación forma parte de la publicación.

## Capacidades pendientes y límites comprobados

- Bóveda de variables: sólo propuesta, no implementada. Revisión automática exige aprobación específica y revisión de seguridad. El ejecutor compartido no acredita aislamiento para recibir secretos privados. No se amplían flags, attestation ni permisos.
- Navegación: búsquedas y lecturas públicas habilitadas en el carril de código; acceso manual al navegador existente. No se agregan `computer_*`: su aislamiento/destinos y confirmación de pagos requieren correcciones antes de ampliar la automatización.
- Adjuntos de código: el texto extraído puede perder espacios o etiquetas; no se presenta como importación fiel. Para esta entrega se usan GitHub o código pegado. Importar bytes originales y ZIP requiere una ruta owner-scoped con validación de archivos aparte.
- Proponer cambios no equivale a publicarlos. No se hace merge, publicación ni pago desde una inferencia.

## Validación realizada

- Integración HTTP del handler real `/generate` y `/stop-stream`: 8/8 pruebas con DB/proveedor aislados, cubriendo primer evento, orden de preflights, cuota, permisos, proveedor definitivo, presupuesto, modelos sin herramientas y Stop. La prueba exitosa se detiene tras crear el proyecto; la ejecución con modelo real se verifica en producción.
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

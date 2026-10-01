# Equipo de programación del chat

El carril de código de `/agentes` dispone de `run_subagent` sobre el mismo bucle ReAct, cliente, modelo y proveedor del coordinador. No añade una interfaz ni un runtime alternativo. No depende de una plantilla de aplicación ni de un lenguaje concreto; los comandos siguen limitados a los ejecutables admitidos por el runner.

## Ejecución e integración

- El coordinador delega entre 1 y 4 tareas independientes por lote, hasta 8 colaboradores por turno. Puede trabajar directamente en tareas pequeñas.
- Cada colaborador recibe sólo su tarea y el proyecto autenticado. Puede leer archivos permitidos y proponer cambios para rutas disjuntas asignadas. Sin rutas asignadas, sólo revisa. No dispone de terminal, navegador, publicación ni delegación recursiva.
- Las propuestas permanecen en memoria. El coordinador las inspecciona con `project_read` y las aplica con `project_write` y `proposalId`. El runner compara la revisión original antes de guardar; una edición concurrente provoca conflicto sin sobrescritura.
- La aprobación del modo protegido envuelve también estas herramientas. Rechazar o cancelar no aplica el cambio.
- El coordinador ejecuta las comprobaciones del proyecto integrado y relee los archivos reales. Una propuesta, un resumen de otro agente o una lectura de su borrador no demuestra trabajo aplicado.
- Las llamadas al modelo comparten el límite del turno y reservan cuatro llamadas para la integración. Stop y el plazo cancelan padre e hijos. El consumo reportado por cada hijo se suma una sola vez a la ejecución principal. Si el proveedor omite el recibo de uso al cancelar, no se inventan tokens ni costes. El wrapper reserva un segundo para recoger resultados de cancelación; no prolonga el plazo de llamadas del equipo.

## Navegador

`project_preview_status` con `verify:true` abre la vista previa autenticada del mismo proyecto en un contexto nuevo de Chromium. `expectedText` comprueba contenido visible relevante. Se verifican el renderizado y los errores de la página, y se toma una captura acotada; sus bytes no se añaden al historial ni al prompt.

La inspección es de lectura. Está limitada al origen y ruta firmada del proyecto; no reutiliza cookies personales ni controla cuentas externas. Contenido externo, workers, formularios o solicitudes que no puedan comprobarse dentro de ese alcance producen un resultado explícito de verificación fallida. Un navegador ausente, un servidor simplemente encendido o una página vacía nunca acreditan éxito. No equivale a una auditoría visual humana ni a una prueba exhaustiva de todos los flujos.

## Límites de esta entrega

- Las propuestas viven durante el turno, no sobreviven a un reinicio del proceso. Los archivos ya aplicados sí permanecen en el proyecto.
- Continúan disponibles los cambios, PR y comprobaciones existentes. No se declara un despliegue sin evidencia de publicación. Esta entrega no habilita publicaciones automáticas, acceso a correo/pagos ni control global del escritorio.
- Los límites de llamadas y tiempo son finitos; al agotarlos se informa trabajo incompleto. No se promete corrección perfecta ni compatibilidad con cualquier repositorio.

## Evidencia

Los tests ejercitan concurrencia mediante barreras, sistema de archivos real, guardado con revisión, ejecución real de Node, permisos interactivos y cancelación. El proveedor de modelo de esas pruebas es explícitamente simulado. Las pruebas de navegador usan Chromium y una aplicación Vite reales. CI ejecuta esta última batería como gate obligatorio en el job de navegador; el resto se descubre en las suites del backend. La aceptación con un modelo externo y en producción se reporta separadamente.

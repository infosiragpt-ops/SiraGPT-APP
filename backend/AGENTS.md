# AGENTS.md — Backend: preservar contratos y datos

Aplica a `backend/`. Complementa [la política raíz](../AGENTS.md); no autoriza
despliegues, migraciones ni cambios de producto. Para datos, leer también
[Prisma](prisma/AGENTS.md). Una regla describe una obligación, no prueba que ya se cumpla.

## Antes de modificar

- DEBE identificar la ruta dueña, servicios, consumidores web, esquema y pruebas del flujo.
- DEBE reproducir el defecto o registrar la evidencia disponible y el comportamiento esperado.
- DEBE enumerar contratos que no cambian: autenticación, payloads, eventos, persistencia y coste.
- NO DEBE sustituir una función existente por una demo, una ruta paralela o una implementación parcial.
- DEBE mantener el cambio acotado; una limpieza o refactor incidental requiere justificar su necesidad.
- DEBE revisar [package.json](package.json), [README](README.md) y [CI](../.github/workflows/ci.yml)
  antes de elegir comandos; los ejemplos de configuración local no autorizan uso en producción.

## API, autenticación y aislamiento

- DEBE conservar métodos HTTP, rutas, códigos, estructuras, paginación y semántica consumidos por clientes.
- DEBE coordinar cualquier ruptura explícitamente autorizada con todos sus consumidores y una transición.
- DEBE validar identidad y autorización en servidor para cada lectura, escritura, descarga y stream.
- NO DEBE confiar en `user_id`, organización, empresa, rol o permisos enviados por el cliente.
- DEBE verificar pertenencia al recurso; poseer su ID o conocer una URL no concede acceso.
- DEBE preservar RBAC, revocación de sesiones, CSRF, límites de API keys y auditoría aplicables.
- NO DEBE introducir bypass de administrador, permisos globales ni apertura de CORS para superar pruebas.
- DEBE cubrir usuarios distintos, organizaciones distintas y credenciales ausentes, vencidas o revocadas.
- Referencias: [auth](src/middleware/auth.js) y [matriz RBAC](../docs/architecture/rbac-matrix.md).

## Proveedores y catálogo de modelos

- DEBE respetar modelo, proveedor, permisos y opciones elegidos; un fallo no permite sustituirlos en silencio.
- DEBE conservar errores accionables, límites, cancelación y contabilidad aunque el proveedor falle.
- DEBE mantener las claves en servidor y redactar errores; presencia de una clave no demuestra disponibilidad.
- DEBE separar descubrimiento del catálogo y publicación: los modelos nuevos se descubren inactivos.
- DEBE preservar activaciones manuales durante sincronización, arranque, importación y actualización de datos.
- DEBE verificar que activar/desactivar afecta al modelo solicitado y que solo los activos son públicos.
- NO DEBE repoblar el selector desde constantes o caché obsoleta si el catálogo activo está vacío.
- DEBE probar invalidación de caché y respuesta de la API pública, no solo el contador del administrador.
- Fuentes: [publicación](src/services/ai-model-publication.js), [sincronización](src/services/model-sync-service.js)
  y [catálogo visible](src/services/visible-model-catalog.js).

## Streams, trabajos y recursos temporales

- DEBE preservar tipos, orden, identificadores y condiciones de cierre de los eventos ya consumidos.
- DEBE probar primera emisión, error, desconexión, cancelación y reanudación cuando el flujo las soporte.
- NO DEBE ocultar un error con un stream vacío, un resultado inventado o un evento de éxito prematuro.
- DEBE preservar idempotencia, exclusión entre workers, leases, fencing y recuperación vigentes.
- DEBE impedir efectos duplicados al repetir una solicitud o recuperar un trabajo tras interrupción.
- DEBE propagar cancelación y plazos a proveedor, subprocesos y almacenamiento, según su contrato.
- NO DEBE ampliar retries, concurrencia o timeouts para esconder el defecto o eludir cuotas.
- DEBE separar respuesta HTTP y liberación de recursos: una respuesta enviada no demuestra limpieza.
- DEBE comprobar limpieza en éxito, error y cancelación; capturar y registrar fallos de limpieza sin secretos.
- DEBE borrar solo recursos propios identificados, preservando entradas originales y trabajos vecinos.
- DEBE conservar una obligación recuperable de limpieza remota cuando su contrato requiera reintento durable.
- NO DEBE convertir un rechazo de borrado en confirmación de borrado ni borrar directorios compartidos.

## Documentos y artefactos: evidencia antes de éxito

- DEBE resolver el archivo y versión correctos del usuario; un seguimiento debe editar el artefacto elegido.
- DEBE conservar el original y producir una versión editable con los cambios pedidos y formato no afectado.
- NO DEBE regenerar, añadir anexos o cambiar de formato como sustituto silencioso de una edición localizada.
- DEBE verificar los bytes finales: contenido cambiado, contenido no solicitado intacto e integridad del formato.
- DEBE conservar logos, tablas, imágenes, estilos, fórmulas y relaciones salvo cambios pedidos explícitamente.
- DEBE distinguir formato no soportado, edición imposible y validación fallida; no prometer edición universal.
- DEBE vincular preview, descarga y metadatos al mismo resultado verificado, con acceso autorizado.
- NO DEBE etiquetar «Validado», «Editado» o «Listo» basándose solo en la respuesta del modelo o un HTTP 200.
- DEBE conservar evidencia de fallo según el contrato de retención, sin publicar artefactos rechazados.
- Referencias: [edición conservadora](src/services/source-preserving-document-edit.js) y
  [prueba del resultado](src/services/document-editing/edit-output-proof.js).

## Pruebas y entrega

- DEBE añadir regresión pre-fix/post-fix y casos negativos relevantes; no debilitar aserciones ni omitir fallos.
- DEBE diferenciar unitarias, integración y E2E, declarando qué dependencias son reales y cuáles son dobles.
- NO DEBE presentar mocks de DB, Redis, almacenamiento, validador o navegador como evidencia real de integración.
- DEBE respetar restricciones de dobles, umbrales y presupuesto del contrato del módulo y CI vigentes.
- DEBE ejecutar pruebas con datos sintéticos y recursos aislados; no usar datos de clientes ni producción por defecto.
- DEBE tener autorización y techo de gasto antes de llamadas pagadas; no ejecutar pruebas masivas contra proveedores.
- DEBE verificar suites focales y consumidores; ejecutar el conjunto aplicable de CI antes de declarar compatibilidad.
- Comandos desde `backend/`: `npm test`, `npm run test:shard -- 1 4`, `npm run test:coverage`.
- Para contratos generados: `npm run generate:openapi:check` y `npm run generate:api-types:check`.
- DEBE registrar comando, entorno, commit, resultado, omisiones y limitaciones; un pase local no certifica producción.
- Para cambios solo documentales, verificar rutas, comandos y diff; no arrancar servicios o migrar sin necesidad.
- Si falla una protección o falta infraestructura, DEBE mantener el gate y explicar el siguiente paso seguro.

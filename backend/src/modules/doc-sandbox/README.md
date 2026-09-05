# Sandbox de edición — fase 1 en verificación

No está publicado. El adaptador del chat canónico está en verificación, no acredita
todavía E2E. El módulo solo admite
trabajos si `DOC_SANDBOX_ENGINE=anthropic`; sin configuración responde 503 y no
recurre a otro editor. No habilitar antes de aprobar el reporte de fase.

## Flujo y contratos

`POST /api/docs/jobs` autentica, aplica cuota/rate limit/CSRF existentes y recibe
multipart `files[]`, `instructions`, `mode=preserve`, `modelTier`, `requestedModel`
y `permission`. El cliente manda el modelo exacto seleccionado; el servidor
verifica el catálogo activo, proveedor, tipo y plan. No sustituye modelos.
`read` y `protected` rechazan la edición. Exige
`Idempotency-Key`; soporta un archivo o varios PDF para fusión (no batch F3).
50 MiB por archivo, 100 MiB por petición, máximo 10 archivos y 2 cargas simultáneas
por proceso. El nombre original se conserva. Las comprobaciones iniciales de
firma no sustituyen el sniffing/parsing aislado posterior.

Postgres reserva identidades/objetos **antes** de subirlos. `admission_ready`
impide consumir cargas incompletas. Un outbox transaccional entrega únicamente
`{jobId}` a BullMQ. Un lease con fencing protege cada intento; recuperación y
reintentos siempre recargan originales prístinos. Máximo tres intentos. El
presupuesto es agregado entre intentos y las reservas inciertas no se reembolsan.

El worker inspecciona originales en un validador independiente, pide el plan a
Anthropic, lo comprueba/congela y edita en un contenedor nuevo. El agente no
decide qué zonas excluir de las pruebas. ZIP/XML, apertura Office, visual y diff
deben pasar antes de publicar. Planos marcan apertura/visual **no aplicable**, no
simulan haber abierto Office. La receta se inspecciona, nunca se ejecuta en el
worker o validador.

Antes de admitir, el arranque ejecuta un preflight real con Writer/Calc/Impress,
qpdf y Poppler dentro del validador. La disponibilidad del worker se renueva con
PING de sus tres conexiones Redis, tiene caducidad y se invalida ante desconexión.
Una recuperación de Redis vuelve a habilitar admisión solo tras una prueba sana.

`not_possible` conserva cada original y su nombre, valida independientemente cada
copia y publica `done/outcome=not_possible` con `E_NOT_POSSIBLE`; no simula una
edición. Los resultados normales distinguen `edited` de `unchanged`. El plan
congelado nunca se reescribe para convertir una petición imposible en éxito.

Endpoints adicionales: `GET /capabilities?model=...`, `GET /by-key/:idempotencyKey`,
`GET /:id`, `GET /:id/events` (SSE con `Last-Event-ID`),
`GET /:id/artifacts/:artifactId`, `POST /:id/cancel`, `DELETE /:id`.
`?download=1` en artefactos genera una redirección autenticada con firma fresca;
el chat guarda ese enlace estable, no un ticket caducado. La recuperación por
clave de idempotencia comprueba dueño y retención, sin crear otro job.
Descargas mediadas con autenticación, firma de máximo 600 s y comprobación del
tombstone durante la transferencia. No hay URLs públicas de objetos. Borrar
revoca accesos nuevos; bytes ya descargados no pueden recuperarse.

## Configuración y compilación

Desde la raíz: `npm --prefix backend run db:generate` y
`npm --prefix backend run build:doc-sandbox`. El build de raíz y la imagen backend
compilan este módulo; el contenedor final no incluye herramientas TS de desarrollo.

`.env.example` enumera las variables. Reutiliza Prisma, la fábrica Redis y las
credenciales R2/Anthropic mediante el gestor de secretos. Nunca copiar el `.env`
completo de producción a tests. `DOC_SANDBOX_MODELS_JSON` contiene los dos niveles:

```text
mechanical / academic:
  id: identificador Anthropic verificado
  prices:
    version: versión/fecha de la tarifa verificada
    inputPerMillionUsd / outputPerMillionUsd
    cacheReadPerMillionUsd / cacheWritePerMillionUsd
    executionPerHourUsd / minimumExecutionSeconds
  maxOutputTokensPerTurn: entero 256..16000
  reservationUsdPerTurn: reserva positiva antes de cada petición
```

No se inventan tarifas ni se confunde una reserva local con un límite impuesto
por el proveedor. El total autorizado para la campaña actual es **US$5**, no US$5
por trabajo. Costos de ejecución pueden ser estimados; usage ausente es desconocido,
no cero. La selección automática Haiku aún no está integrada: el API acepta nivel
explícito y no debe anunciar clasificación automática.

`DOC_SANDBOX_SKILL_VERSIONS_JSON` requiere `docx`, `xlsx`, `pptx`, `pdf` con versiones
exactas. No se incorpora código de skills con licencia restringida. El SDK fijado
por lock usa beta Files multipart y `code_execution_20260120`.

La imagen de [validación](../../../../infra/doc-validation/README.md) requiere
un digest inmutable (referencia de registro o ID local SHA-256 completo) y `runsc`.
`DOC_SANDBOX_VALIDATION_STAGING_ROOT` es obligatorio: un directorio privado 0700,
propiedad del worker, montado con **la misma ruta absoluta** en host y worker.
El `/tmp` privado de un contenedor no sirve como origen de un bind del daemon.
El validador recibe únicamente los inputs de esa invocación, en lectura, nunca
el directorio padre ni el socket Docker. Su construcción y aislamiento se verifican por
separado: tener flags en código no constituye evidencia de aislamiento.

## Pruebas

- `npm --prefix backend run test:doc-sandbox:unit`: contratos, cifrado, tickets,
  configuración y motor; solo el transporte SDK del motor usa mocks.
- `npm --prefix backend run test:doc-sandbox:validation`: Python/Office/Poppler reales
  sobre fixtures anónimas. Requiere herramientas en PATH y Python con dependencias
  de `infra/doc-validation/requirements-test.txt`; `DOC_VALIDATION_TEST_PYTHON`
  permite seleccionar un intérprete. No salta pruebas si falta una herramienta.
- `npm --prefix backend run test:doc-sandbox:persistence`: Postgres/Redis reales,
  efímeros y exclusivamente loopback o hosts exactos de la red aislada de test;
  requiere variables `DOC_SANDBOX_TEST_*`
  indicadas en la suite. Usa esquema aleatorio, nunca tablas productivas.
- `npm --prefix backend run test:doc-sandbox:http-storage`: HTTP autenticado con
  identidades de fixture, Postgres y S3 reales. No acredita OAuth ni E2E del navegador.
- `npm --prefix backend run test:doc-sandbox:readiness`: proceso Redis propio,
  corte/reinicio/pausa reales; requiere `redis-server` local o
  `DOC_SANDBOX_TEST_REDIS_BINARY`. Nunca usa el Redis de producción.
- `npm --prefix backend run test:doc-sandbox:documents`: originales sintéticos
  complejos, preservación de PDF escaneado y preflight de herramientas reales.
  Requiere qpdf, LibreOffice, Poppler y Python de tests. No acredita runsc ni LLM.
- `npm --prefix backend run test:doc-sandbox:real -- --preflight ...`: consultar el
  [runner real](../../../tests/doc-sandbox-real.README.md). Sin argumentos explícitos
  falla; jamás inicia gasto automáticamente desde la suite común.

El gate de motor real, cobertura total ≥80 %, cinco jobs/recetas y E2E completo
continúa pendiente mientras no exista evidencia ejecutada. No reemplazarlo por
pruebas con respuestas interceptadas.

## Operación y recuperación

GET de un job devuelve estado, secuencia, artefactos publicables y limpieza
pendiente; no devuelve claves internas, documentos ni IDs del proveedor.
Eventos/logs usan códigos operativos, nunca prompts, contenido o respuestas SDK.
Postgres conserva eventos, hashes, presupuesto y reservas; Redis es solo entrega.
Una caída se recupera por lease/outbox, no mediante promesas conservadas en RAM.

Cancelar/borrar invalida el fence inmediatamente. La purga espera la ventana
durable de quiescencia (15 minutos) para evitar carreras con uploads tardíos;
todas las solicitudes S3 están limitadas a 120 s. Se registran los IDs de Files y
contenedores remotos de todos los intentos. Borrar Files **no** certifica que se
destruyó un contenedor: su TTL conocido y facturación incierta mantienen la
limpieza pendiente. Nunca cambiar manualmente `cleanup_pending=false` para ocultar
fallos. Tombstones siguen retenidos para revocación; la eliminación de cuentas
requiere purgar primero sus jobs (FK restrictiva).

GET/LIST/DELETE de almacenamiento admiten como máximo tres intentos ante errores
transitorios, dentro de una única señal de 120 s. PUT condicional no se reintenta;
un 412 no se convierte en éxito. Un GET parcial se descarta y el contenido final
debe volver a verificar autenticación del cifrado y hash.

Para rotar cifrado, generar la nueva clave fuera del repositorio, cambiar key ID
y clave actual y mantener las anteriores en el secreto
`DOC_SANDBOX_PREVIOUS_KEYS_JSON`. Los objetos nuevos usan la nueva clave y los
históricos se descifran por su ID. La enumeración/purga cubre todas las versiones.
No retirar una clave antigua mientras queden objetos de esa versión. Las firmas
de descarga anteriores dejan de funcionar; el usuario puede solicitar un enlace
nuevo. No hay migración automática de claves.

## Publicación y reversión

Pruebas del Lenovo deben usar red, base, Redis y bucket/volúmenes exclusivos, sin
puertos públicos, sin montar secretos en el validador ni tocar los stacks activos.
No reiniciar Docker/producción para instalar gVisor sin una nueva autorización.

Tras aprobar el reporte: revisar migración aditiva, backup, PR/CI y runbook de
publicación vigente. Nunca `down -v`, `volume rm`, `reset --hard` ni cambios DNS.
Para revertir la aplicación: parar admisión, drenar/cancelar y desplegar versión
anterior manteniendo tablas y objetos. No hacer fallback automático a edición sin
validación. Un health verde no sustituye el job completo y la descarga verificada.

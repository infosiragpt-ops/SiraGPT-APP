# Evidencia local de persistencia y cola — F1

Fecha: 2026-09-04. Solo entornos aislados de test, no producción. Primera ejecución local: Node 26.7.0, Prisma 6.19.3, PostgreSQL 17.10, Redis 7.2.10. La sección Lenovo registra la repetición real con Node 22. La migración completa del histórico de la aplicación sigue siendo un gate separado.

## Comprobación de tipos y esquema

Desde la raíz del checkout:

```sh
node /Users/luis/Documents/Siragpt/SiraGPT-APP/node_modules/typescript/bin/tsc --strict --noEmit --target ES2022 --module commonjs --moduleResolution node --skipLibCheck --esModuleInterop backend/src/modules/doc-sandbox/queue/repository.ts backend/src/modules/doc-sandbox/queue/queue.ts backend/tests/doc-sandbox-persistence.integration.test.ts backend/tests/doc-sandbox-persistence.queue.test.ts
DATABASE_URL=postgresql://fixture@127.0.0.1:5432/doc_sandbox_fixture node backend/node_modules/prisma/build/index.js validate --schema backend/prisma/schema.prisma
```

Resultado ejecutado: ambos exit 0; TypeScript sin diagnósticos. Prisma:

```text
Prisma schema loaded from backend/prisma/schema.prisma
The schema at backend/prisma/schema.prisma is valid 🚀
```

## Suites con servicios reales

Se instaló `embedded-postgres@17.10.0-beta.17` **fuera del repositorio** en `/private/tmp/siragpt-doc-pg.w4c0pT`, y se compiló Redis 7.2.10 desde el archivo oficial. No se instalaron servicios del sistema. Ambos escucharon únicamente en loopback, en puertos efímeros, y se apagaron en `finally`. Se conservaron los binarios y el directorio de fixtures temporales para reproducir; los esquemas de cada prueba se eliminaron al terminar.

Comando ejecutado con permiso de socket loopback:

```sh
node /private/tmp/siragpt-doc-pg.w4c0pT/run-tests.mjs
```

El runner inicia Postgres/Redis, inyecta sus URLs efímeras a las dos suites y ejecuta el equivalente a:

```sh
NODE_ENV=test node --import ./backend/node_modules/tsx/dist/loader.mjs --test --test-reporter=spec backend/tests/doc-sandbox-persistence.integration.test.ts backend/tests/doc-sandbox-persistence.queue.test.ts
```

Para reproducir con servicios propios de test, configurar `DOC_SANDBOX_TEST_DATABASE_URL` y `DOC_SANDBOX_TEST_REDIS_URL` apuntando exclusivamente a loopback. Si faltan, las suites **fallan**, no pasan mediante skip. Nunca usar URLs productivas.

Salida real final (se omiten únicamente las duraciones por test):

```text
PostgreSQL 17.10 on x86_64-apple-darwin24.6.0, compiled by Apple clang version 17.0.0 (clang-1700.6.3.2), 64-bit
Redis 7.2.10 fixture bound to loopback only
✔ admission is atomic and idempotent under ten concurrent real DB requests
✔ real foreign key rejects nonexistent owner
✔ unready admission reserves all original keys without enqueue or claiming until upload acknowledgement
✔ an acknowledged job lost from Redis is re-delivered from Postgres without duplicate pending events
✔ owner checks apply to job, artifacts, events, cancel and delete
✔ one DB lease wins concurrent delivery and normal transitions require a frozen plan
✔ publication is one atomic terminal event with all required private artifacts
✔ validation cannot be declared non-applicable for Office or any structural/textual check
✔ missing output or report never publishes an artifact
✔ cancel wins against a stale worker and remote IDs arriving later remain cleanup-only
✔ delete revokes previously published outputs and remains idempotent until every object is purged
✔ validation failure retries from immutable input keys at most three total attempts
✔ a fresh repository recovers an expired worker lease and rejects the old fence
✔ SIGKILL of a real worker process leaves a durable lease recoverable by another worker
✔ budget reservations persist across uncertain calls and charge late responses after cancellation
✔ zero configured budget rejects paid work rather than assuming unlimited credit
✔ safe worker events reject raw document content and fencing applies to metadata too
✔ deleting Files never certifies remote containers deleted; unknown expiration remains pending
✔ ten different jobs keep artifacts, event sequences and outputs disjoint in real Postgres
✔ expired jobs are tombstoned and events contain metadata, not input text or provider IDs
✔ real Redis payload contains only jobId and duplicate outbox dispatch creates one BullMQ job
✔ real BullMQ worker claims a durable DB lease with two duplicate deliveries but executes once
✔ unready uploads never enter Redis and queue errors do not replace DB authority
ℹ tests 23
ℹ suites 0
ℹ pass 23
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 513.910083
```

Exit 0. La primera ejecución Redis dio 22/23: `Missing expected rejection` al cerrar una cola y despachar. Demostró que `Queue.add()` podía resolver durante el cierre sin entrega persistida. Se corrigió el wrapper para rechazar `closing` y comprobar `getJob()` antes del ACK durable; la repetición dio 23/23.

## Alcance exacto y límites

- Las pruebas ejecutan SQL real y BullMQ/Redis reales, incluyendo muerte por `SIGKILL` de otro proceso Node, recuperación por lease/fence, IDs aislados y presupuestos transaccionales. No prueban edición, fidelidad visual, S3/R2 ni llamadas Anthropic reales. No consumieron el presupuesto del proveedor.
- La migración del módulo se aplica en esquemas únicos, con una tabla `users(id)` mínima real para probar su FK. Esto no sustituye migrar toda la aplicación desde cero ni una copia productiva.
- Los metadatos de artefactos/reportes de estas suites son fixtures del contrato de publicación, no documentos validados ni evidencia G1–G12. Los validadores reales requieren sus propias suites.
- Tras cancelación/borrado, acceso revocado inmediatamente; la confirmación física de purga espera 15 minutos para escrituras en vuelo, bajo el requisito de timeout duro de storage/proveedor ≤120 s. Los tests adelantan el reloj almacenado, no esperan quince minutos.
- Los contenedores remotos con vencimiento futuro/desconocido y solicitudes de costo incierto mantienen `cleanupPending`; borrar Files no certifica destruir un contenedor. La fila tombstone conserva revocación y obligaciones de limpieza. El borrado definitivo de fila/cuenta necesita integración adicional de retención; no se elimina evidencia de recursos remotos pendientes.
- El runner temporal corrigió además el `beforeExit` de embedded-postgres, que por defecto sale con código 0: devuelve explícitamente el código real de las suites después de apagar servicios. Los números de pruebas se leyeron de la salida, nunca se dedujeron del health o del exit de ese helper.

Fuentes primarias consultadas para los runtimes de test: [embedded-postgres](https://github.com/leinelissen/embedded-postgres), [Redis 7.2](https://github.com/redis/redis/tree/7.2). No son dependencias nuevas de producción.

## Recuperación de admisiones interrumpidas

Se añadió `recoverAbandonedAdmissions()`, llamado por `recoverUndeliveredJobs()`: un trabajo `queued` con `admission_ready=false` y más de 15 minutos de antigüedad se bloquea por fila, se convierte en tombstone `cancelled` y genera outbox durable de limpieza. No se encolan archivos parciales; se conservan las claves reservadas y un ACK tardío no puede resucitar el trabajo. El margen supera el timeout duro de carga de 120 segundos.

Nueva prueba real: dos recuperadores concurrentes, un upload antiguo sin terminar, uno reciente y uno ya confirmado. Solo el antiguo incompleto se revoca, con exactamente un evento de limpieza y ningún enqueue; `claimAttempt` y ACK tardío quedan bloqueados.

Reejecución local de las suites de persistencia/cola con los servicios efímeros anteriores:

```text
✔ crashed unready admission is tombstoned after grace and late upload acknowledgement cannot resurrect it
ℹ tests 24
ℹ pass 24
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 619.406792
```

Exit 0. Las 23 pruebas anteriores también pasaron en esa corrida.

## Integración real Lenovo: PostgreSQL, Redis, HTTP y S3 privado

Entorno explícitamente autorizado y aislado: red Docker `doc-sandbox-phase1-test` con `internal=true`, sin puertos publicados (`HostConfig.PortBindings={}`), sin mounts/env de producción. Contenedores `doc-sandbox-test-postgres`, `doc-sandbox-test-redis`, `doc-sandbox-test-minio`; runner `doc-sandbox-test-runner`. CPU 1 por contenedor, RAM PostgreSQL 512 MiB; Redis, MinIO y runner 1 GiB. El runner monta únicamente `/home/user/deployments/doc-sandbox-phase1-tests` en lectura y no inicia la aplicación productiva.

Imágenes resueltas e inmutables:

| Servicio | Versión comprobada | SHA-256 de imagen |
| --- | --- | --- |
| Runner de dependencias | Node 22.23.2 | `0efa5d4f999ae8493821248e37cd7745cc439a292fb4c13385905ae5e5d3f5da` |
| PostgreSQL | 16.14 | `57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777` |
| Redis | 7.4.10 | `e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2` |
| MinIO | RELEASE.2025-09-07T16-13-09Z | `14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e` |

MinIO es exclusivamente un fixture efímero; no se incorpora como dependencia operativa. [Release oficial](https://github.com/minio/minio/releases/tag/RELEASE.2025-09-07T16-13-09Z), proyecto archivado en 2026. Se conserva su licencia AGPL en la imagen oficial sin modificaciones.

Los scripts `start-isolated.sh` y `run-isolated.sh` están en el directorio de pruebas anterior. Usan credenciales sintéticas exclusivas del fixture; no se reproducen aquí valores de secretos. Comando de reproducción, únicamente cuando esos servicios aislados estén activos:

```sh
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes siragpt-lenovo 'cd /home/user/deployments/doc-sandbox-phase1-tests && bash run-isolated.sh'
```

Las suites HTTP usan el router real, multipart real, SQL real y S3 real. La autenticación es una identidad de test explícita, no una comprobación de JWT/OAuth/sesiones/CSRF productivas. Se comprueban autorización por propietario, IDOR, idempotencia, límites, SSE durable, cancelación y revocación de tickets tras DELETE. La descarga comprobada es un **reporte de fallo honesto**, no un output supuestamente validado. No se invoca ni se simula el validador documental o un LLM.

### Fallos observados y corrección S3

1. Primera corrida real: HTTP 9/9; S3 4/5, total 13/14, exit 1. Tras rechazar un segundo PUT condicional, un GET con `maxAttempts:1` recibió `ECONNRESET` / `socket hang up`.
2. Un experimento cambiando SDK a 3 intentos dio 14/14 y una repetición conjunta 37/37 (14442.418688 ms), pero **no equivalía a la configuración runtime** y no se adopta como prueba de esa configuración. Las 23 pruebas PG/Redis de esa repetición sí verificaron Node 22 sin depender de S3.
3. Se implementaron reintentos propios, máximo 3 para GET/LIST/DELETE, con un único timeout de 120 s y cancelación del caller. PUT no reintenta; 403/412, errores GCM/hash y validación fallan inmediatamente. GET destruye el body anterior, descarta bytes parciales y comienza de cero.
4. Un proxy HTTP real ante MinIO reveló otro fallo: el wrapper `ChecksumStream` del SDK podía mantener el stream abierto al perderse la fuente (`source.pipe(this)` sin propagación del aborto). Esa corrida obtuvo S3 8/9 y el caso parcial falló al límite de 10 s; no se ocultó. Se conectó además la señal de timeout al body, porque `send()` resuelve antes de terminar la descarga.
5. `createPrivateDocumentS3Client` centraliza ahora `maxAttempts:1` y `responseChecksumValidation:'WHEN_REQUIRED'`, únicamente para este módulo y sus fixtures. No cambia checksums de las cargas, otros clientes ni variables globales. GCM sigue siendo obligatorio, y los documentos de entrada/salida verifican el SHA-256 esperado del manifiesto. Esto no sustituye ni omite ninguno de los cuatro niveles de validación documental. [Configuración oficial de integridad AWS SDK](https://docs.aws.amazon.com/sdkref/latest/guide/feature-dataintegrity.html).

### Resultado final corregido: 42/42

Se ejecutó el comando de reproducción con la política final de producción del módulo: factory privado, SDK `maxAttempts:1`, respuesta `WHEN_REQUIRED` y request checksum `WHEN_SUPPORTED` (los tres valores se comprueban en el test). El paquete transferido se verificó con SHA-256 `7caf2148ff993d51f8e17edef0f7fdcfc4633f6ca4e20362788f31e2c03cfef4`.

```text
ok 11 - crashed unready admission is tombstoned after grace and late upload acknowledgement cannot resurrect it
ok 24 - SIGKILL of a real worker process leaves a durable lease recoverable by another worker
ok 35 - real S3 conditional put prevents overwriting an immutable original
ok 36 - a ciphertext tampered in the real fixture bucket fails authenticated decryption
ok 39 - real HTTP partial GET failures discard ciphertext, retry twice and verify exact bytes from real S3
ok 40 - real HTTP retry ceiling is three attempts; 403 and 412 never retry
ok 41 - caller abort interrupts real HTTP backoff, and conditional PUT never retries
ok 42 - real HTTP LIST and DELETE retry a transient response; final hash mismatch never retries
1..42
# tests 42
# suites 0
# pass 42
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 15771.749337
```

Exit 0, propagado mediante `pipefail` a pesar de guardar la salida con `tee`. Son **21 tests PostgreSQL, 3 Redis/BullMQ, 9 HTTP y 9 S3/HTTP fault injection**. El caso que antes se bloqueaba al cortar el body dos veces terminó correctamente en 475.234372 ms y entregó exactamente los bytes esperados en el tercer intento; los parciales se descartaron. La corrupción GCM y el hash final incorrecto siguen fallando.

Evidencia completa sin secretos:

- Remota: `/home/user/deployments/doc-sandbox-phase1-tests/final-run.tap`.
- Local: `/private/tmp/siragpt-doc-phase1-evidence.IEi1ig/lenovo-integration.tap`.
- SHA-256 del TAP: `b8773c4c2225e3173d9584e5f06ee91c84e786d067c9f80df7438f79cc533be5`.

El build del módulo y strict TypeScript de las cinco suites/helper finalizaron exit 0; las 20 pruebas puras de storage también pasaron. `check-secrets.sh` aplicado a los archivos de este subtrabajo y `git diff --check`: exit 0.

Al terminar se verificaron las etiquetas `siragpt.scope=doc-sandbox-phase1-test` y la red exacta de cada uno de los tres servicios, y se detuvieron únicamente por estos nombres creados para la tarea:

```text
/doc-sandbox-test-postgres status=exited running=false exit=0 hostPorts={}
/doc-sandbox-test-redis status=exited running=false exit=0 hostPorts={}
/doc-sandbox-test-minio status=exited running=false exit=0 hostPorts={}
```

El runner usa `--rm` y terminó; se conservaron red, imágenes, contenedores y datos de test. No se eliminaron volúmenes, no se ejecutó prune ni se detuvo un contenedor productivo. Ninguna llamada LLM ni consumo del presupuesto Anthropic. Esta evidencia no acredita edición documental end-to-end, visuales, golden tests, autenticación productiva, migración histórica completa ni despliegue en producción.

# F1 — rechazo no bloqueante del manifiesto privado

2026-09-07 UTC. **PR #561 no desplegada; F1 sigue pendiente.**
Base: `6fc7b5ddda8e4f053ac302819a7f3e92e2602505`.

## Defecto reproducido y corrección

`readInvocation` abría `invocation.json` en lectura antes de comprobar que
fuera un archivo regular. Un FIFO sin escritor bloqueaba esa apertura y,
con ella, admisión, reconciliación, cleanup y preflight; los timeouts de
Docker todavía no estaban activos. Se reprodujo con filesystem y procesos
hijos reales, no con dobles de IO. El manifiesto es privado del worker y
no se monta en `/inputs`: **no se acredita acceso del usuario remoto ni una
incidencia observada en producción**.

La única modificación del runtime añade `O_NONBLOCK` al mismo `open`, sin
quitar `O_NOFOLLOW`, fstat, tipo regular, límite de 4096 bytes, enlace único, UID,
permisos o cierre en finally. No añade un timeout que abandone un open
pendiente. La semántica coincide con [Node.js](https://nodejs.org/api/fs.html#file-open-constants)
y [POSIX open](https://pubs.opengroup.org/onlinepubs/9799919799/functions/open.html).

Cada prueba carga la fuente real en un hijo. El handshake separa arranque
(15 s) de operación (5 s). Un vencimiento es **fallo**, seguido de SIGKILL y
espera de close antes de borrar la fixture. Hay un control positivo regular;
los FIFO exigen el error exacto de manifiesto o reconciliación pendiente.
No admiten ENOENT/timeout como éxito. Originales, manifiesto retenido y vecino
se conservan byte a byte; el FIFO no se lee ni se sustituye por datos falsos.

## Verificación

```text
node --import ./backend/node_modules/tsx/dist/loader.mjs --test backend/tests/doc-sandbox-validation-filesystem.test.ts
Mac pre-fix: 40/44; 4 fallos DOC_TEST_INVOCATION_READ_STALLED; 0 skip
duration_ms 20603.062458; exit 1
Mac post-fix: 44/44; 0 fail/skip; duration_ms 485.976584; exit 0
```

También se añadieron cuatro contratos pre-IO de `failAttempt`: reporte JSON
obligatorio, metadata inválida, errores tipados conservados y entrada posterior
inválida sin mutar objetos congelados/IDs. Prisma es genuino y desconectado;
un error de conexión no satisface los asserts. No acreditan transacciones,
bytes, almacenamiento ni validación documental. Suite focal 18/18, sin omisiones.

Corroboración conjunta Linux Node 22.23.2: **62/62**, cero fallos/omisiones,
`duration_ms 6362.695503`, exit 0. Contenedor efímero sin red, puertos ni socket
Docker, usuario 1000, readonly, 1 CPU/1 GiB y timeout interno de 90 s; imagen fijada
`sha256:40f438311ab39713e617fc96b6dcbf5bdc62bf5141ddca954f739386da64176e`.
No se arrancaron PostgreSQL/Redis/MinIO ni se usaron secretos productivos.
Al terminar se confirmaron esos servicios detenidos, cero puertos y ningún
runner activo. Los tres archivos probados coinciden por SHA en Mac/Lenovo.
La reproducción pre-fix es del Mac; el ensayo Linux es post-fix.

```text
npm --prefix backend run test:doc-sandbox:coverage
377/377; 0 fail/skip; duration_ms 1608.08825
Lines/Statements 72.39% (2749/3797); Branches 86.42% (1222/1414)
Functions 76.13% (268/352); exit 1 por umbral 80% aún incumplido
```

Generales recompiladas **12472/12472**, 535 suites, cero omisiones,
`duration_ms 59188.745167`, exit 0. Tipos raíz/backend/focal y UI-lock: exit 0;
lint: exit 0 con advertencias heredadas. No se alteraron scripts ni cobertura.
Logs: `output/phase1-manifest-fifo-prefixed.log`, `-postfix.log`, `-linux.log`,
`-unit-coverage.log` y `-root-tests.log` (todos con el mismo prefijo).
Revisión independiente de código, pruebas y límites sin bloqueantes.

## Continuidad y límites

CI base `6fc7b5ddd`, run `34071403374`, finalizó: retención 10/10 y storage 34/34,
unitarias 368/368; falló cobertura 72,20% y agregador. No acredita este cambio.
El nuevo lote debe ejecutar su propio CI. Checkout Lenovo limpio y API pública
siguen en `100d29bc2` (#571), saludables a 2026-09-07T01:04:59.548Z, no en #561.

Este arreglo no resuelve la lectura creciente después de stat ni el reloj
capturado antes del await: observaciones estáticas separadas, no reproducidas
en este lote. Tampoco demuestra Docker/gVisor, proveedor, `process()` completo,
scheduler, goldens, concurrencia o edición/descarga autenticada. Aceptación,
infraestructura y ensayo migratorio siguen pendientes; no se rebajan gates.
Gasto nuevo US$0. Sin despliegue, reinicio, DNS ni modificación productiva.

Guías: `agent-validation`, `quality-gates`, `secret-safety`,
`release-orchestrator` y `technical-docs` de `.agents/skills`.

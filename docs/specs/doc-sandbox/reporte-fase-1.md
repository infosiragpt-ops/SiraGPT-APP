# Fase 1 — informe parcial de verificación, no cierre

Fecha: 2026-09-05. Rama `feat/doc-sandbox-fase-1`, base original
`0f24e4d004f156eae838e21592539cca91f53cd3`; entrega para GitHub actualizada sobre
`b30b48bc9b7c2510e86ff85c293852967ba31dc9` mediante rebase limpio, conservando
VoiceStudio (#560). **No desplegado. F1 no aprobada para cierre.**
Este documento registra evidencia parcial y gates pendientes; no sustituye su ejecución.

## 1. Qué se implementó

- `backend/src/modules/doc-sandbox/types/{contracts,errors}.ts`: esquemas estrictos, estados y errores públicos seguros.
- `api/router.ts`: admisión multipart autenticada, propiedad, idempotencia, estado, SSE, cancelación y descarga revocable.
- `storage/private-storage.ts`: cifrado autenticado, originales inmutables, claves por versión y firmas de descarga.
- `queue/repository.ts`: autoridad Postgres, leases/fences, outbox, presupuesto, eventos y publicación atómica.
- `queue/queue.ts`: entrega BullMQ con payload solo `jobId`, sin bytes ni secretos.
- `queue/processor.ts`: inspección independiente, plan congelado, edición, validación, reintentos y publicación protegida.
- `queue/cleanup.ts`: reconciliación de Files/objetos y estado de limpieza sin certificar borrados no demostrados.
- `engine/` y `agent/`: interfaz de motor, adaptador SDK Anthropic, presupuesto, prompts/versiones y receta exportada.
- `validation/index.ts`: lanzamiento de validador gVisor sin red, límites y limpieza del contenedor.
- `validation/validator.py`: ZIP/XML, apertura real, comparación visual y textual; la receta se inspecciona, no se ejecuta.
- `observability/metrics.ts`: contadores/histogramas de baja cardinalidad; Postgres sigue siendo autoridad de costos.
- `config.ts`, `index.ts`: configuración cerrada, integración y lifecycle del módulo.
- `backend/prisma/schema.prisma` y migración `20260905000000_doc_sandbox_core`: tres tablas aditivas, rollback y evidencia.
- `backend/src/services/doc-sandbox-module.js`, `backend/index.js`: montaje antes de Swagger y arranque/cierre controlado.
- `backend/tsconfig.doc-sandbox.json`, `backend/scripts/build-doc-sandbox.cjs`, paquetes/lock y `backend/Dockerfile`: compilación TS estricta integrada.
- `backend/tests/doc-sandbox-*`: suites unitarias, validadores reales, HTTP/S3/Postgres/Redis y runner de pruebas pagadas explícito.
- `infra/doc-validation/`: imagen, dependencias y procedimiento revisable de instalación de runtime sin reinicios.
- `.env.example`, `.github/workflows/ci.yml`, `backend/src/utils/metrics.js`, `docs/prometheus-rules*.yml`: configuración documentada, gates y reglas de observabilidad.
- README del módulo y documentos de esta carpeta: límites, decisiones y reproducción.
- `lib/document-sandbox-{client,routing}.ts`, `lib/use-document-sandbox-chat.ts` y conexión mínima en el chat canónico: envío de los bytes originales, modelo/permisos exactos, recuperación por clave persistida, SSE/estado terminal y cancelación confirmada por el servidor. No hay sustitución silenciosa por el editor antiguo.
- `model-policy.ts` y catálogo real: solo se admite el modelo Anthropic activo, del tipo y plan autorizados; el catálogo público no se altera.
- `readiness.ts` y preflight independiente: probar Writer/Calc/Impress antes del arranque y mantener un lease de disponibilidad con tres conexiones Redis reales. La pérdida de disponibilidad cierra nuevas admisiones.
- Resultado conservador G10: conservar todos los originales, validar las copias y publicar `outcome: not_possible` con advertencia, sin afirmar que se editó algo ni alterar el plan solicitado.
- Corpus sintético complejo de seis archivos, hashes por parte OOXML y runner opt-in `--suite=complex`; oráculos estrictos distintos de la suite smoke. El preflight real precede a PostgreSQL, ledger y cualquier llamada pagada.

Los cambios fuera del módulo son necesarios para compilarlo, montar sus rutas,
persistir trabajos e incluirlo en los controles existentes. No se modificó la
layout/barra de chat ni el catálogo público de modelos. Se conectó lógica al
componente existente, sin rediseñarlo. El checkout del usuario con cambios
visuales preexistentes se conserva intacto.

## 2. Cómo se probó

La entrega para GitHub incorpora la nueva base de VoiceStudio sin conflictos
textuales. Sus comprobaciones locales posteriores al rebase se registran en la
PR. Los resultados Linux y la comparación AST siguientes son evidencia previa:
no acreditan de nuevo la combinación ni sustituyen E2E autenticado.

Comprobaciones previas de esta revisión (2026-09-05 UTC):

| Suite | Resultado observado | Alcance |
|---|---|---|
| `npm --prefix backend run test:doc-sandbox:unit` | 137/137; 0 fallos/skips; 812.542167 ms | Compilación, contratos/lógica; incluye seis tests auxiliares de política |
| Runner `infra/doc-validation/run-isolated-integration.sh` en Lenovo | 55/55; 0 fallos/skips; 17180.954886 ms | HTTP, Prisma/PostgreSQL, Redis/BullMQ y S3 reales, únicamente infraestructura de test |
| `test:doc-sandbox:readiness` con Redis efímero local | 5/5; 0 fallos/skips; 2712.848959 ms | Corte/reinicio real de Redis y ping bloqueado; recuperación sin reiniciar worker |
| Python/LibreOffice/Poppler/qpdf en imagen Linux | 42/42; 0 fallos/skips; 21.484 s | Herramientas reales con documentos sintéticos, no motor Anthropic ni gVisor |
| Corpus/oráculo/G10 en imagen Linux corregida | 16/16; 0 fallos/skips; 18112.078452 ms | Originales intactos, cuatro capas reales en G10 y rechazo de modificaciones no autorizadas |
| Apertura del corpus complejo en Linux | 11/11; 6.676 s | Runs, notas, gráficos, fórmulas/recálculo, formularios y fuentes reales |
| Herramientas de arranque e identidad negativa en Linux | 2/2; 4.427 s | No acredita aislamiento gVisor |
| Corpus/oráculo local | 13/13; 0 fallos/skips; 1839.854208 ms | Reproducibilidad, inspección y rechazo de cambios no solicitados |
| Cliente/source frontend | 53/53 | Pruebas auxiliares, transporte controlado; no E2E |
| Hook React montado | 12/12 | Pruebas auxiliares; no navegador/backend real |

Los conteos no se suman como una cifra de E2E: hay suites de naturaleza distinta
y revisiones superpuestas. Typecheck frontend/backend, lint y `git diff --check`
pasaron; lint conserva advertencias heredadas. **UI-lock falla** por el wiring
intencional (cuatro archivos); baseline aún sin modificar. La comparación AST
independiente encontró los mismos 1002 nodos JSX, 778 `className`, 8 `style` y
composer idéntico, pero no acredita renderizado/E2E.

La última integración incorpora cierre antes/después del commit y retención del
cupo de memoria hasta terminar consultas SQL pendientes. La prueba nueva bloquea
dos consultas reales, corta ambas conexiones y exige que una tercera carga reciba
429 antes del parser; después verifica recuperación. El runner limita recursos,
no publica puertos ni carga `.env` productivo y detiene solo los tres servicios
aislados que inició.

Fallos encontrados y corregidos, no ocultados: permisos UID/manifiestos de paquete
en el montaje de test; falta de `ai_models.id` en el esquema de prueba de Prisma
(38/49 inicialmente; después 54/54 y 55/55); permiso de loopback del sandbox local
(repetido con el permiso necesario, sin alterar Redis productivo). El fallo de
esquema sigue siendo una prueba negativa que exige `E_NOT_READY` seguro.

La imagen candidata del validador quedó construida y se probaron sus herramientas;
la imagen de test inicial falló por Node/musl incompatible, corregido con un
binario oficial glibc por digest. Una desconexión SSH durante exportación no se
interpretó como éxito: se verificó el ID y se ejecutaron los tests al reconectar.
Digests, locks, fuentes, límites y resultados en
[image-build-result.md](../../../infra/doc-validation/image-build-result.md).

Estado público comprobado a las `2026-09-05T02:27:26.187Z`: API `healthy`,
commit `0f24e4d004f156eae838e21592539cca91f53cd3`, sin publicar esta fase. Backend,
frontend, DB y Redis conservaron PID y StartedAt. La última lectura de Docker
devolvió `DefaultRuntime=runc runscRegistered=false`; servicios de test detenidos.
La comprobación final de limpieza no encontró contenedores temporales activos;
MinIO, Redis y PostgreSQL de test seguían detenidos. Salud pública nuevamente
`healthy` a las `2026-09-05T05:03:29.910Z`, sin llamadas Anthropic de esta fase.

Evidencia anterior, conservada para trazabilidad:

Comandos desde la raíz del worktree salvo indicación. Evidencia local privada:
`/private/tmp/siragpt-doc-phase1-evidence.IEi1ig/`. Los logs de este directorio
son pruebas sintéticas y no contienen credenciales ni documentos de usuarios.

```sh
npm --prefix backend run test:doc-sandbox:unit
```

Salida histórica de `unit-final.txt` (previa a esta revisión):

```text
tests 119
pass 119
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 690.087625
```

Incluye compilación. Nunca se simula un resultado del validador para acreditar
fidelidad. Las nuevas pruebas auxiliares de cliente/política están separadas de
la aceptación documental, como se detalla arriba y en §5.

```sh
npm run lint
npm run type-check
node --check backend/index.js
node --check backend/src/services/doc-sandbox-module.js
git diff --check
```

Resultados ejecutados: exit 0. Lint conserva advertencias heredadas; **no se
afirma ausencia de advertencias**. Logs `lint.txt`, `frontend-typecheck.txt`;
comprobaciones de sintaxis/diff no emitieron diagnósticos.

Regresión desde `backend`:

```sh
NODE_ENV=test node --test --test-reporter=spec tests/doc-route-edit-no-regen.test.js tests/docx-list-preserving-edit.test.js tests/xlsx-surgical-edit.test.js tests/pptx-surgical-edit.test.js tests/pdf-surgical-edit.test.js tests/csrf-route-inventory.test.js tests/prometheus-rules-contract.test.js
```

Salida real `regression.txt`: **71 tests, 70 pass, 0 fail, 1 skipped**. El skip
es el test heredado opcional de `promtool`, ausente en este Mac; no se presenta
como comprobación semántica ejecutada de Prometheus.

Tras extender métricas/configuración se ejecutó además:

```sh
cd backend
node --import tsx --test tests/doc-sandbox-metrics.test.ts tests/doc-sandbox-api-helpers.test.ts tests/doc-sandbox-config.test.ts tests/prometheus-rules-contract.test.js
```

Salida `metrics-config.txt`: **40 tests, 39 pass, 0 fail, 1 skipped** (el mismo
promtool). No sumar estos tests con la suite unitaria: existe solapamiento.

Postgres/Redis reales locales:

```sh
node /private/tmp/siragpt-doc-pg.w4c0pT/run-tests.mjs
```

Última repetición tras añadir recuperación de admisión: **24/24 pass, 0 fail/skip,
exit 0**, con muerte real de proceso, recuperación,
presupuesto y diez identidades concurrentes. Comandos/salida completa y primer
fallo corregido en [VERIFICATION.md](../../../backend/prisma/migrations/20260905000000_doc_sandbox_core/VERIFICATION.md).
No son diez documentos editados por Anthropic.

Validadores Python/Office/Poppler, ejecutados nuevamente desde raíz:

```sh
env PATH="/Users/luis/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/poppler/bin:$PATH" /Users/luis/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 backend/tests/doc-sandbox-validation.test.py
```

Salida final de `validation-python.txt`:

```text
Ran 42 tests in 50.700s
OK
```

Exit 0. Esto acredita herramientas reales locales, **no** aislamiento Docker/gVisor
ni una imagen de producción construida.

Pruebas HTTP/S3/PG/Redis aisladas en Lenovo: última ejecución **42/42 pass,
0 fail/cancel/skip, exit 0, 15771.749337 ms**, con Node 22.23.2. Se
detectó un reset de conexión S3 después de HTTP 412: una ejecución inicial dio
13/14, y otra con reintentos SDK distintos dio 14/14; **esta última no acreditaba
la configuración real**. Se implementaron reintentos acotados de operaciones
idempotentes y cliente privado consistente; la ejecución final usa `maxAttempts:1`.
Incluye dos cortes reales del stream GET, recuperación byte a byte, techo de
intentos, errores no reintentables y cancelación. Comando/log completo y versiones
en VERIFICATION.md; evidencia privada `lenovo-integration.tap` en el directorio
local anterior. No oculta las ejecuciones fallidas ni acredita edición Anthropic.

Revisión independiente: typecheck exit 0 y **76/76 pruebas locales** aprobadas;
integración de persistencia falló explícitamente por falta de URL de test en la
sesión del revisor (no fue omitida). No es una nueva ejecución de toda la fase.

Instalación de gVisor autorizada sin reinicios:

```sh
node infra/doc-validation/install-runtime-apply.cjs --preflight /private/tmp/siragpt-gvisor-local.AYCqyeEK/gvisor.tar.bz2
node infra/doc-validation/install-runtime-apply.cjs --apply /private/tmp/siragpt-gvisor-local.AYCqyeEK/gvisor.tar.bz2
node infra/doc-validation/install-runtime-rollback.cjs --restore-absent /private/tmp/siragpt-runtime-evidence.h4nzac/evidence.json
node --test infra/doc-validation/install-runtime-config.test.cjs infra/doc-validation/install-runtime-apply.test.cjs infra/doc-validation/install-runtime-rollback.test.cjs
```

Comandos locales exactos; para reproducir en otro equipo se debe descargar y
verificar nuevamente el paquete. Guardas de instalación/rollback: **38/38**.
Preflight exit 0; instalación del paquete y validación de
`dockerd --validate` aprobadas. La etapa del helper que debía enviar **solo
SIGHUP** devolvió exit 1; la causa concreta no se ha determinado. No se relajaron
perfiles ni se reinició Docker para evitar ese fallo.

La recuperación CAS retiró exclusivamente el `daemon.json` creado tras comprobar
hash y backup de ausencia: exit 0. Evidencia privada
`/private/tmp/siragpt-runtime-evidence.h4nzac/evidence.json`:

```text
stage: signal-only-sighup
error.message: remote_command_failed_status_1
lockReleased: true
recovery.restored: absent
recovery.productionContinuityPassed: true
recovery.backupRetained: true
recovery.packageRetained: true
```

Los 23 contenedores previos mantuvieron ID/PID/StartedAt; mismo proceso dockerd,
runtime predeterminado `runc` y **runsc no registrado**. Paquete versionado y backup
se conservan, pero el runtime **no está habilitado**. La API pública devolvió HTTP
200/healthy y versión `0f24e4d004f156eae838e21592539cca91f53cd3`. Este cambio no
publicó la aplicación ni ejecutó la imagen de validación.

Recomprobación solicitada antes de publicar — 2026-09-05 01:44 UTC
(2026-09-04, hora de Lima): SSH funciona y Docker sigue sin registrar `runsc`.
Un helper temporal restringido comprobó PID `173770`, `comm=dockerd` y
start ticks `7292944`; `process.kill(pid, 0)` terminó correctamente **sin enviar
ninguna señal**. Su perfil era `docker-default (enforce)` y el del daemon
`unconfined`. Esta prueba no demuestra permiso para SIGHUP ni explica el exit 1
anterior. No se repitió la recarga, no se modificaron perfiles/configuración y
el helper se eliminó automáticamente al terminar.

La lectura posterior confirmó backend/frontend/DB/Redis `running/healthy`, con
los mismos PID y StartedAt. `/api/health/ready` devolvió `healthy` a las
`2026-09-05T01:44:57.907Z`; `/api/version` mantiene el commit
`0f24e4d004f156eae838e21592539cca91f53cd3`. No hubo publicación ni gasto Anthropic
en esta recomprobación. La autorización para publicar no sustituye los controles
pendientes ni autoriza reinicios de producción.

## 3. Evidencia de validación

**Todavía no existen cinco jobs reales Anthropic con sus informes finales.**
Consumo Anthropic de esta fase observado hasta este punto: **US$0 en llamadas
ejecutadas**, dentro de la autorización total US$5. No se han presentado
fixtures simples como prueba de edición profesional de una tesis compleja.

Pendientes: cinco reportes `validation_report.json`, recetas, miniaturas/diffs,
hashes y resultados de G1/G4/G7/G8/G11; G10 real, originales representativos
anonimizados y apertura manual en Word/Excel/PowerPoint. El corpus complejo y
sus oráculos ya están implementados, pero no se confunden con ejecuciones del
editor. Tanto smoke como complex mantienen `specificationGoldensSatisfied:false`
y `phase1GatesSatisfied:false`; requieren revisión de la evidencia completa.

## 4. Decisiones tomadas

Aplican [D01–D18 aprobadas y D19–D23 de ejecución](decisiones.md): separación de
validación, no omisión de controles, salida privada, autoridad DB, presupuesto
agregado, restricciones del Lenovo, staging compartido y evidencia sin inflación.
gVisor solo se puede habilitar sin reinicios, conservando el runtime predeterminado.

## 5. Desviaciones respecto a la especificación

- Apertura/visual se adelantaron a F1 conforme al plan aprobado; las herramientas ya se comprobaron en la imagen Linux, pero falta su ejecución con gVisor y motor real.
- Approval, follow-up y batch siguen en F3 según D15; XLSM/ediciones compartidas de Excel esperan sus golden F2.
- DELETE revoca de inmediato, pero retiene tombstones y espera quiescencia/TTL remoto antes de confirmar purga; no afirma destrucción instantánea.
- G10 y el corpus complejo se implementaron tras la revisión: no se reduce su alcance ni se consideran cerrados por pruebas del generador.
- El adapter canónico respeta la selección exacta y no cambia automáticamente a Haiku ni a otro proveedor. Modelos incompatibles/inactivos, modo lectura/protegido y capacidades no disponibles se rechazan conservando el borrador.
- Las pruebas auxiliares del transporte y del hook montado simulan HTTP; las seis pruebas auxiliares de política usan un catálogo controlado. **No son aceptación §10.2, E2E ni validación documental.** La política del catálogo también se prueba con Prisma/PostgreSQL real, incluyendo fallo de esquema y desactivación inmediata.

## 6. Limitaciones conocidas y riesgos

- **Bloqueante para cierre:** faltan motor real/golden complejos, carga, cobertura global ≥80 %, E2E canónico e integración de cuotas/retención de cuentas.
- **Corregido y probado:** las cargas `admission_ready=false` abandonadas por más de 15 minutos se revocan y pasan a limpieza; pruebas locales y repetición Linux incluyen concurrencia y rechazo de ACK tardío.
- **Corregido en código:** resultado conservador, corpus complejo, preflight real antes de workers y adapter canónico. Falta demostrar su flujo conjunto con motor real, runtime requerido y navegador autenticado.
- **Corregido y probado:** la pérdida de conexión antes de confirmar la carga revoca el nuevo trabajo; una desconexión cuando ya empezó la confirmación conserva el trabajo recuperable y no duplica la cola. Los cupos de memoria no se liberan mientras continúan consultas pendientes. Los tests bloquean PostgreSQL y cierran HTTP realmente.
- **Limitación visible:** una edición aún no admitida y encolada en otro chat espera a que se abra ese chat; no se ejecuta por el camino antiguo. Una recarga que pierde el objeto `File` exige adjuntar de nuevo. Los trabajos ya admitidos continúan en segundo plano.
- **Gate de interfaz pendiente:** `ui-lock:verify` detecta el wiring intencional y los tres nuevos módulos de frontend. No se actualiza el baseline a ciegas ni se presenta el hook montado como E2E visual.
- **Mayor:** falta demostrar y automatizar reconciliación segura de contenedores/staging huérfanos tras caída dura del worker.
- **Mayor:** credencial presente no prueba presupuesto duro del proveedor. No enviar solicitudes pagadas antes de verificar las salvaguardas; nunca copiar `.env` productivo a tests.
- **Operativo bloqueado:** fallo exit 1 del helper de recarga; configuración revertida y continuidad confirmada. Hace falta una vía administrativa revisada desde el host, sin reiniciar, para habilitar `runsc`; no basta tener su paquete instalado.
- No se ha ejecutado toda la CI del repositorio, migración histórica completa, alerta con receptor de test ni una publicación canary.

## 7. Checklist de §11

- ❌ F1 estructura/interfaz: implementadas, verificación integral pendiente.
- ❌ F1 migraciones reversibles: módulo probado en esquema limpio; histórico completo y borrado de cuentas pendientes.
- ❌ F1 endpoints: HTTP/auth de fixtures en verificación; canónico/E2E pendientes, rutas F3 no se habilitan.
- ❌ F1 Motor A/costo: SDK/configuración/ledger implementados; llamadas reales y factura/límite pendientes.
- ❌ F1 controles 1/4/5 en producción: existen en código; **no están desplegados**.
- ❌ F1 G11/G1/G4/G7/G8: no ejecutados con motor real y fixtures exigidas.
- ❌ F1 negativos/concurrencia completa: pruebas de componentes no equivalen al flujo completo.
- ❌ F2/F3/F4: no iniciadas ni aprobadas para cierre.
- ❌ Siempre: lint/typecheck y pruebas parciales pasan; cobertura de todo el módulo y gates faltantes impiden marcar cumplimiento.
- ❌ Siempre reporte de cierre: este es un informe parcial; evidencia de cinco jobs y corroboración pendientes.

## 8. Pendientes para la siguiente fase

**No iniciar F2 todavía.** Primero cerrar dentro de F1 los hallazgos anteriores,
comprobar runtime/imagen con red bloqueada, ejecutar pruebas reales bajo US$5,
verificar el flujo canónico ya conectado y repetir revisión independiente sin mayores/bloqueantes.
Después se pide revisión/aprobación del cierre. Publicación futura requiere CI,
backup, runbook vigente y comprobación del SHA, health y documento descargado;
no bastan una compilación local o un runtime instalado.

# F1 — identidades independientes al subir originales

2026-09-06 UTC. Corrección posterior a
`35c6c7b41d1d1c014a15b4f0f9bc8f521900b399`, que ya conserva producción #570.
**No desplegado; no es un cierre de F1.** Publicar continúa autorizado, pero
esta corrección no sustituye los controles de aceptación pendientes.

## 1. Qué se implementó

- `engine/anthropic-engine.ts`: rechaza con `E_PROVIDER` un ID de subida que
  ya representa otro original de la sesión. Primero registra su obligación
  de limpieza y conserva la precedencia de cancelación; no acepta el segundo
  input ni llega a solicitar edición.
- `backend/tests/doc-sandbox-engine.test.js`: regresión negativa y control
  positivo para originales del mismo nombre y tamaño, con contenido distinto.
- `backend/tests/doc-sandbox-engine-reference-retention.integration.test.ts`:
  una regresión con motor, repositorio y ledger PostgreSQL reales de prueba.
- D29, checkpoint y este informe documentan alcance, evidencia y pendientes.

No cambia SQL, API pública, SDK, dependencias, UI ni configuración de producción.

## 2. Cómo se probó

Node 24.19.0. Casos del motor con sólo el proveedor sustituido por un doble:

```text
npm --prefix backend run build:doc-sandbox
node --test --test-name-pattern='provider upload identities' backend/tests/doc-sandbox-engine.test.js
pre-fix: 1/2 aprobadas; 1 fallo; 0 omitidas; 77.297375 ms; exit 1
post-fix: 2/2 aprobadas; 0 fallos/omisiones; 72.28925 ms; exit 0
```

El fallo previo es `Missing expected rejection.`; el control positivo pasa
antes y después. La prueba negativa comprueba aliases y hashes diferentes,
cero llamadas de edición/metadata/descarga/reserva y una sola identidad de
limpieza. La positiva conserva dos IDs y dos aliases aunque coincida el nombre.

Integración aislada con PostgreSQL 17.10 y Redis 7.2.10 nuevos, puertos loopback
aleatorios, datos sintéticos y carpetas privadas, sin secretos de producción:

```text
/Users/luis/.local/node/bin/node output/phase1-reference-retention-local.cjs
pre-fix: 52/53 aprobadas; 1 fallo; 0 omitidas; 1745.396667 ms; exit 1
post-fix: 53/53 aprobadas; 0 fallos/omisiones; 1660.988583 ms; exit 0
servicesStopped=true; cleanupErrors=[] en ambas ejecuciones
```

Evidencia privada `tests.tap` y `result.json`, fuera de Git:
pre-fix `/private/tmp/siragpt-phase1-reference-retention-ZuU7DT`;
post-fix `/private/tmp/siragpt-phase1-reference-retention-lJuxaz`.
El único fallo previo es la ausencia del rechazo esperado del nuevo caso.
Las 53 integraciones son las 52 anteriores más una; no sumar repeticiones.

Desde la raíz, con `PATH=/Users/luis/.local/node/bin:$PATH`:

```text
npm --prefix backend run test:doc-sandbox:coverage
345/345 aprobadas; 0 fallos/omisiones; 1519.910708 ms
Lines/Statements 72.76% (2597/3569)
Branches 86.83% (1134/1306); Functions 75.07% (259/345)
exit 1: cobertura de líneas inferior al 80% exigido
npm run type-check
npm --prefix backend run type-check:doc-sandbox
npm run lint
bash scripts/verify-ui-lock.sh
Todos exit 0; lint mantiene 48 advertencias heredadas; cero cambios de frontend
node node_modules/typescript/bin/tsc -p tests/tsconfig.json
exit 0
NODE_ENV=test node --require ./tests/register-ts-paths.cjs --test --test-reporter=spec --test-reporter-destination=output/phase1-upload-identity-root-tests-node24.log '.test-dist/tests/**/*.test.js'
12467/12467 aprobadas; 534 suites; 0 fallos/omisiones
60318.138084 ms; exit 0
```

Logs locales en `output/phase1-upload-identity-*`, no versionados. No se alteró
la selección de cobertura ni el umbral. Se necesitan 259 líneas cubiertas más
para llegar a 2856/3569; las integraciones no entran en esa cifra.
`git diff --check` y escaneo de secretos explícito de los seis archivos del
lote: exit 0; log del escaneo privado. Revisión documental independiente
favorable, con contraste de los logs.

## 3. Evidencia de validación

El ensayo PostgreSQL conserva una sola obligación de borrado, marca ese ID
eliminado al destruir la sesión y mantiene intactos ambos registros originales.
No reserva costo, publica outputs, registra contenedores ni modifica estado,
lease, fencing, consumo o secuencia de eventos. Se verifican metadatos reales
del ledger, no bytes en R2, validación documental ni un job completo.

Revisión independiente favorable de los tres archivos de código. Además,
cinco casos focales aprobados por el revisor: duplicado, control positivo,
cancelación de upload, upload tardío y tamaño incorrecto. Están incluidos
en la suite, no se suman a ella. El revisor no repitió PostgreSQL.

## 4. Decisiones tomadas

D29: cada original aceptado necesita su identidad remota independiente. El
[contrato oficial de subida](https://platform.claude.com/docs/en/api/files/upload)
describe un identificador único del objeto; se verifica también esta condición
en el límite del motor. La regresión inyecta una respuesta defectuosa: **no
demuestra que Anthropic haya producido ese fallo en una solicitud real**.

Registrar antes de rechazar conserva la obligación de limpieza. No borrar
inmediatamente el ID compartido, pues aún representa el primer input; usar el
flujo de destrucción existente. No añadir comprobaciones de nombre/formato,
reintentos, nuevas facultades del motor ni otra ruta de edición.

## 5. Desviaciones respecto a la especificación

La cobertura sigue por debajo del 80%; no se reduce el requisito. Estas pruebas
de contrato y persistencia no acreditan golden complejos, aislamiento runsc,
almacenamiento privado real, concurrencia, E2E ni aceptación de F1. No hay
consumo nuevo de proveedor: **US$0**. Saldo y límite efectivo de US$5 pendientes
de acreditar antes de pruebas facturables.

## 6. Limitaciones conocidas y riesgos

Consulta de sólo lectura de esta continuación: checkout de despliegue limpio y
versión pública coinciden en `845e0c48128634179b60e3dd67622412d2b42a52` (#570).
Readiness público saludable a **2026-09-06T22:02:05.495Z**. La PR #561 sigue
abierta y draft, sin desplegar. SSH funciona hacia el contenedor deploy.
No hubo escritura productiva, ejecución del publicador ni cambios de DNS.

La ausencia de runsc/configuración R2/F1 y las limitaciones del publicador
provienen del preflight anterior; no se reconsultaron en este lote. Continúan
pendientes la preparación legítima del host sin reinicios y el ensayo
migratorio/recovery. No se presume que CI de la base valide este nuevo lote.

La revisión estática del catch de fallos precisa dos riesgos aún **sin arreglo
ni reproducción con almacenamiento real**, adicionales al descarte conocido
de `report.artifacts`:

- El intento de persistencia y su compensación arrancan plazos separados de
  15 segundos; Prisma no comparte necesariamente esa señal. Una señal común
  por sí sola no prueba un límite total; no abandonar escrituras pendientes
  mediante una carrera de promesas.
- Diez informes pueden concatenar hasta 10010 artefactos, mientras LIST
  rechaza más de 10000 y cleanup lista antes de borrar claves reservadas.
  Resolver el presupuesto agregado o la limpieza paginada y acotada antes de
  afirmar retención completa; no truncar evidencia silenciosamente.

## 7. Checklist de aceptación

- ✅ Identidad duplicada reproducida y rechazada sin perder cleanup.
- ✅ Originales de igual nombre admitidos con identidades independientes.
- ✅ Ledger real, pruebas generales, tipos, UI-lock y revisión independiente.
- ❌ Cobertura 80%, retención de evidencia fallida y aceptación documental F1.
- ❌ Preflight real de aislamiento/storage/configuración y límite de gasto.
- ❌ Migración/recovery, merge normal, despliegue y flujo público comprobado.

## 8. Pendientes para la siguiente fase

Continuar F1, no F2. Completar gates y ensayo de retención con PostgreSQL/MinIO
reales, preservando fencing, originales, límites y limpieza. Preparar un
despliegue que soporte migraciones y backend listo antes de activar frontend;
no ejecutar el publicador antiguo ni evitar sus guardas. Mantener el seguimiento
de #561 y avisar al usuario sólo como producción tras verificar SHA público,
activación, salud y edición/descarga autenticada reales.

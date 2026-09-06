# F1 — políticas de intentos y leases, 2026-09-06

**PR #561 en borrador, no desplegado. No cierra F1.** Continuación de
`46caed9c02eb3de46b0593863eefbbe29203e747`, con base `production-main`
verificada en `81f3d9a63150d241f2b22fa4b34ac98b4558a3e3`.

## 1. Qué se implementó

- `queue/lease-policy.ts` contiene las decisiones puras de vigencia del lease,
  admisión de un intento, transición y elegibilidad de reintento. El repositorio
  las llama después de bloquear/leer la fila y obtener el reloj de PostgreSQL.
  Conserva SQL, transacciones, UUID, fencing, historial y orden de operaciones.
- `queue/attempt-budget.ts` calcula el presupuesto restante desde el snapshot
  durable: incluye todas las reservas pendientes, cuatro clases de tokens y
  turnos anteriores. El procesador sigue llamándolo después de inspección y
  heartbeat, antes de construir el motor; no cambia aritmética ni errores.
- 11 pruebas de lifecycle y 18 de presupuesto, sobre valores del dominio,
  sin simular DB, Redis, almacenamiento, validador ni reloj. Son decisiones
  puras, no una demostración de exclusión concurrente ni reserva transaccional.
- Las dos suites quedan en el comando unitario estricto. El contrato CI comprueba
  su inclusión; no cambia el umbral, las exclusiones ni las dependencias.

No cambian UI, migraciones, configuración ni APIs públicas. La importación
de tipos del repositorio no introduce dependencia circular en JavaScript.

## 2. Cómo se probó

Node 24.19.0, `PATH=/Users/luis/.local/node/bin:$PATH`. Desde la raíz:

```text
npm --prefix backend run test:doc-sandbox:coverage
tests 336; pass 336; fail 0; cancelled 0; skipped 0
duration_ms 1693.4055
Statements/Lines 72.48% (2566/3540)
Branches 86.32% (1105/1280); Functions 75.07% (259/345)
exit 1: Coverage for lines (72.48%) does not meet global threshold (80%)
npm --prefix backend run test:doc-sandbox:auxiliary
tests 16; pass 16; fail 0; cancelled 0; skipped 0; exit 0
npm --prefix backend run type-check:doc-sandbox
exit 0
npm run type-check
exit 0
node node_modules/typescript/bin/tsc -p tests/tsconfig.json
exit 0
NODE_ENV=test node --require ./tests/register-ts-paths.cjs --test --test-reporter=spec --test-reporter-destination=output/phase1-policy-root-tests-node24.log '.test-dist/tests/**/*.test.js'
tests 12465; suites 534; pass 12465; fail 0; skipped 0
duration_ms 60591.635334; exit 0
npm run lint
exit 0; 48 advertencias, mismo conteo que el lote anterior
bash scripts/verify-ui-lock.sh
UI lock verified — zero changes to frontend files; exit 0
git diff --check
exit 0
```

Logs locales: `output/phase1-policy-strict-coverage-node24.log`,
`output/phase1-policy-root-tests-node24.log`, `output/phase1-policy-auxiliary-node24.log`
y `output/phase1-policy-lint-node24.log`. El comando de cobertura compila primero
el módulo. No se declara lint sin advertencias ni aprobación de todos los gates.

## 3. Integración real y revisión

Repetición nueva, con PostgreSQL **17.10** y Redis **7.2.10** locales y efímeros:

```text
# Desde backend, con DOC_SANDBOX_TEST_DATABASE_URL,
# DOC_SANDBOX_TEST_REDIS_URL y DOC_SANDBOX_TEST_REDIS_BINARY de prueba aislada:
node --import tsx --test --test-concurrency=1 tests/doc-sandbox-persistence.integration.test.ts tests/doc-sandbox-persistence.queue.test.ts tests/doc-sandbox-readiness-queue-recovery.integration.test.ts
tests 46; pass 46; fail 0; cancelled 0; skipped 0; todo 0
duration_ms 1682.737208; exit 0
```

El harness local usó el loader tsx absoluto y reporter TAP. Creó directorios
0700, credenciales sintéticas privadas y puertos loopback nuevos; verificó
versión, directorio y PID antes de probar. El resultado confirma cierre limpio
de todos sus procesos, sin errores de cleanup. Evidencia privada local:
`/private/tmp/siragpt-phase1-policy-5QDcLS/{manifest.json,tests.tap,result.json}`.
El harness revisado tiene SHA-256
`5a8d2871e216304943a649aac055abbf178265f21e9aeef11fb28160a2844a48`.
No se reutilizaron bases ni datos existentes; no se consumió ningún `.env`.

La primera preparación local falló antes de Redis y de las pruebas, y apagó
su PostgreSQL. No contó como integración aprobada. Se corrigió la consulta de
identidad a `host(inet_server_addr())`: la conversión explícita a texto incluye
la máscara `/32`. El reporte inicial no identificaba qué aserción falló;
se añadieron etapas y códigos de error permitidos, sin valores sensibles.
La repetición anterior valida el harness corregido y las 46 pruebas reales.

Dos revisiones independientes comprobaron la paridad: en el repositorio,
66 SQL, 119 llamadas de IO/identidad y 12 expresiones temporales intactas; en
el procesador, 49 await, 10 expresiones temporales y 46 llamadas de dependencias
en el mismo orden. Sus pruebas focales pasan, sin bloqueantes en este diff.
No se suman repeticiones ni comparaciones de paridad a los conteos anteriores.

## 4. Decisiones

D25: separar políticas deterministas de los efectos para poder revisarlas y
probarlas directamente. La autoridad sigue siendo la fila bloqueada y el reloj
de DB, no un snapshot aportado por un cliente. Recuperación de leases vencidos,
reserva de costo, publicación y limpieza mantienen sus operaciones originales.

## 5. Desviaciones y cobertura

No se reduce el alcance de F1 ni se inicia F2. Hay 29 pruebas estrictas nuevas.
La medición pasa de 2486/3464 a **2566/3540**: tipos, funciones y documentación
del refactor también aumentan el denominador. **974 líneas siguen sin ejecutar**;
faltan al menos **266** líneas cubiertas para 2832/3540 (80 %). No se excluye
ninguna fuente ni se añaden integraciones a la medición unitaria.

Esto es un avance de borrador autorizado, no una solicitud de merge con CI
verde. El fallo exclusivo del umbral es esperado y permanece bloqueante.

## 6. Límites y riesgos

- Las 46 integraciones prueban persistencia/cola, no el motor documental completo.
  No equivalen al ensayo migratorio de PostgreSQL 16 ni a las 66 integraciones
  Linux históricas. No se repitieron goldens, R2 ni E2E autenticados.
- Se conserva el fallback heredado a cero para turnos ausentes/inválidos y la
  aritmética `Number` de importes del snapshot. Este refactor no certifica una
  política nueva ante corrupción de datos persistidos; las escrituras y la
  admisión del motor mantienen sus validaciones existentes.
- El Mac usa procesos limitados de prueba, no aislamiento gVisor/cgroups. No se
  ejecutó código generado ni documentos del usuario en esos procesos.
- Producción no fue modificada ni revalidada. Gasto nuevo Anthropic: **US$0**.
  Los pendientes externos y migratorios del checkpoint siguen abiertos.

## 7. Aceptación

- ✅ 336 unitarias estrictas, 16 auxiliares y 12465 generales; cero omisiones.
- ✅ 46 integraciones nuevas con servicios reales, cerrados después de probar.
- ✅ Revisión independiente, tipos y UI-lock; lint sin advertencias nuevas.
- ❌ Cobertura mínima, goldens, runtime real completo y E2E autenticado.
- ❌ Migración/recuperación aceptadas, merge y publicación en siragpt.com.

## 8. Continuación

Mantener el borrador y comprobar el CI del nuevo commit. Auditar después las
decisiones de publicación y reconciliación: coherencia de artefactos, informe
independiente y resultado `edited/unchanged/not_possible`, con pruebas puras
cuando corresponda y contratos DB reales por separado. No extraer código sólo
para alterar el porcentaje ni sustituir efectos por mocks en la suite estricta.
No reiniciar producción, relajar aislamiento ni iniciar F2 antes de aceptar F1.

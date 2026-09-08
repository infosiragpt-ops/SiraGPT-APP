# F1 — referencias del proveedor y preflight de publicación

2026-09-06 UTC. Lote posterior a `8be1ba8566a25ca70db29d8e7e4bf9cc2e5e68cb`.
Luis reiteró la orden de desplegar #561. La publicación está autorizada;
**no se ha ejecutado ni se declara cerrada F1**. No se levantan los controles
de calidad, aislamiento, datos ni la condición de instalar gVisor sin reinicios.

## 1. Qué se implementó

- `engine/anthropic-engine.ts`: conserva el error de una referencia malformada,
  recupera sólo las hermanas admitidas por el mismo extractor estricto y
  registra archivos, contenedor y consumo antes de rechazar la respuesta.
- `backend/tests/doc-sandbox-engine-reference-retention.integration.test.ts`:
  tres casos con motor/repositorio PostgreSQL reales y sólo proveedor doblado.
- `backend/tests/doc-sandbox-engine.test.js`: dos casos de metadatos ajenos y
  referencias mixtas. Títulos precisados: callbacks observados no prueban DB.
- `backend/package.json` y `infra/doc-validation/run-isolated-integration.sh`:
  integraciones incluidas, separadas de la cobertura unitaria.
- `tests/ci-doc-sandbox-coverage.test.ts`: inclusión obligatoria en CI/runner.
- Checkpoint, D28 y nota migratoria alineados con la evidencia nueva.

## 2. Cómo se probó

Node 24.19.0, PostgreSQL 17.10 y Redis 7.2.10 sintéticos nuevos, puertos loopback
aleatorios, directorio privado y entorno mínimo sin secretos de producción:

```text
/Users/luis/.local/node/bin/node output/phase1-reference-retention-local.cjs
pre-fix: tests 52; pass 50; fail 2; skipped 0
post-fix: tests 52; pass 52; fail 0; skipped 0
corroboración del orquestador: tests 52; pass 52; fail 0; skipped 0
servicesStopped=true; cleanupErrors=[]; exit 0 en ambas ejecuciones post-fix
```

Evidencia privada pre-fix: `/private/tmp/siragpt-phase1-reference-retention-Vzf68r`;
post-fix: `/private/tmp/siragpt-phase1-reference-retention-Dr0cS3`;
corroboración: `/private/tmp/siragpt-phase1-reference-retention-iHBKQF`.
Cada carpeta conserva `tests.tap` y `result.json`, fuera de Git. La última
ejecución tuvo 1628.316042 ms de tests. Son 49 existentes + tres nuevos;
no sumar repeticiones. No acredita PostgreSQL 16 ni migración productiva.

La revisión fortaleció los casos malformados: `pause_turn` en vez de
`max_tokens`, una sola llamada y contadores externos de metadatos/descargas en
cero. Así el rechazo no puede aprobar por otra causa o esconder un assert.
El control válido mantiene `max_tokens`. Los dos fallos pre-fix ocurrieron
en la ausencia de referencias válidas en PostgreSQL.

Desde la raíz con `PATH=/Users/luis/.local/node/bin:$PATH`:

```text
node --import ./backend/node_modules/tsx/dist/loader.mjs --test tests/ci-doc-sandbox-coverage.test.ts
pre-fix 4/5; post-fix 5/5; cero omisiones
npm --prefix backend run test:doc-sandbox:coverage
tests 343; pass 343; fail 0; skipped 0
Lines/Statements 72.73% (2593/3565)
Branches 86.62% (1127/1301); Functions 75.07% (259/345)
exit 1: Coverage for lines (72.73%) does not meet global threshold (80%)
npm --prefix backend run test:doc-sandbox:auxiliary
tests 16; pass 16; fail 0; skipped 0; exit 0
node node_modules/typescript/bin/tsc -p tests/tsconfig.json
exit 0
NODE_ENV=test node --require ./tests/register-ts-paths.cjs --test --test-reporter=spec --test-reporter-destination=output/phase1-reference-retention-root-tests-node24.log '.test-dist/tests/**/*.test.js'
tests 12467; suites 534; pass 12467; fail 0; skipped 0
duration_ms 64897.432542; exit 0
npm run type-check
exit 0
npm --prefix backend run type-check:doc-sandbox
exit 0
npm run lint
exit 0; 48 advertencias heredadas, sin nuevas advertencias
bash scripts/verify-ui-lock.sh
UI lock verified — zero changes to frontend files; exit 0
bash -n infra/doc-validation/run-isolated-integration.sh
exit 0
git diff --check
exit 0
```

TypeScript estricto focal de la integración también pasa. Motor 71/71,
incluido en las 343 unitarias, no sumar. Logs `output/phase1-reference-retention-*`.
Escaneo de secretos de los diez archivos del lote: exit 0, salida privada.
El denominador y numerador aumentan en 18 líneas de runtime; no se excluye
código ni se suma integración. Faltan 259 líneas para 2852/3565 (80%).

## 3. Evidencia de validación

PostgreSQL conserva ambos IDs válidos, input, retención del contenedor y
consumo de la respuesta sintética. El job no llega a done ni publica outputs.
El borrado de archivos no se presenta como eliminación del contenedor.
Esto prueba motor + ledger, no procesador completo, R2, gVisor o edición real.
El catch sigue sin conservar `report.artifacts`. Gasto nuevo: **US$0**;
la contabilización comprobada es sintética.

CI `34046405741` de **8be1ba856**, no de este lote: falló sólo cobertura y su
agregador. Log del job `101522125150`: paso documental Linux 16/16, oráculo TXT
2/2 y herramientas directas 2/2. Frontend y tres workflows nativos pasaron.
No acredita el nuevo commit ni un preflight aislado bajo runsc.

## 4. Decisiones tomadas

D28: rechazar un protocolo inválido no elimina obligaciones de recursos ya
creados. Mismo extractor y ledger, sin publicación por la recuperación.
Revisión independiente favorable tras fortalecer la no continuación. No se
cambiaron SQL, validador, UI o dependencias.

## 5. Desviaciones respecto a la especificación

La orden de publicar no acredita aceptación. El 80% sigue pendiente; los
callbacks unitarios sólo prueban notificación/orden, no persistencia durable.
No se reclasificaron integraciones. No hay cierre §12–13 ni cinco jobs reales.

## 6. Limitaciones conocidas y riesgos

Preflight remoto de sólo lectura del **2026-09-06**, después de renovar Access:

- `curl https://siragpt.com/api/version` y `git rev-parse HEAD` del checkout de
  despliegue coinciden en `81f3d9a63150d241f2b22fa4b34ac98b4558a3e3`.
  Readiness público saludable a **16:53:52 UTC**; checkout limpio.
- `ssh ... siragpt-lenovo 'id; ...'` funciona pero identifica `deploy` UID 1000
  dentro de Alpine; `sudo` y `systemctl` no están disponibles. No es acceso
  administrativo del host. `docker info` registra runc, no runsc.
- Consulta booleana de claves en backend: Anthropic presente; R2 y configuración
  F1 ausentes. No se imprimieron valores. No acredita saldo o hard cap de US$5.
- SHA-256 del publicador instalado, cotejado con `publish-reviewed.sh`:
  `51867ea99dd007429446f5f03198015e5659a4b16330829f908500d6eafef634`.
  Rechaza schema/migrations antes del respaldo de DB y activa frontend antes
  que backend; no se ejecutó ni se eliminó la guarda.
- Inventario Docker: PostgreSQL/Redis sin puertos publicados. No se modificó
  ningún servicio, DNS, secreto, base de datos ni respaldo de producción.

Faltan host administrativo, runtime/storage/configuración, aceptación, cobertura
y release migratorio. La API de commits de GitHub tampoco encontró las dos
migraciones extra sin procedencia en sus rutas exactas de `production-main`.
No demuestra corrupción ni autoriza reescribir historial; upgrade/recovery
del ensayo anterior siguen pendientes.

## 7. Checklist de aceptación

- ✅ Fallo de referencias reproducido, corregido y corroborado con PostgreSQL.
- ✅ Pruebas, revisión e integración incluida sin debilitar gates.
- ✅ SSH de despliegue recuperado y prerrequisitos reconsultados.
- ❌ 80%, diff fallido, goldens, carga y E2E documentales.
- ❌ Host administrativo, runsc, R2/configuración y cap acreditados.
- ❌ Ensayo migratorio completo, merge, publicación y descarga real de F1.

## 8. Pendientes para la siguiente fase

Continuar F1, no F2: sesión administrativa legítima del host, preflight revisado
y secretos en gestor privado. No evadir autenticación usando Docker ni
reiniciar producción. Completar controles internos/aceptación y preparar
publicación migratoria con backend listo antes de frontend. La reversión debe
conservar ledger, tablas, objetos y reconciliación.

# F1 — oráculo de evidencia fallida y contratos del proveedor

2026-09-06. **PR #561 en borrador, sin despliegue. No cierra F1.** Lote posterior
a `c337481f41b9f93c4dbc9387f0fcbfafa2d03033`, base `production-main` verificada
en `81f3d9a63150d241f2b22fa4b34ac98b4558a3e3`.

## 1. Qué se implementó

- `backend/tests/helpers/doc-sandbox-failure-evidence.ts`: fixture reutilizable
  de TXT y plan, sin registrar tests al importarla. Ejecuta el `validator.py`
  confiable del repositorio sobre bytes sintéticos, con límites de tiempo/salida
  y filesystem privado. Devuelve el informe y diff realmente emitidos.
- Dos pruebas de documento: original **2026**, solicitado **2027**, candidato
  incorrecto **2028**; control positivo **2027** con la misma configuración.
- Dos unitarias estrictas del motor: referencias de archivo malformadas dentro
  de bloques de herramientas válidos; DELETE del SDK con 403, 429 y 503 debe
  rechazar exactamente una llamada, sin anunciar borrado ni reintentar.
- `test:doc-sandbox:documents` incluye obligatoriamente el nuevo oráculo. Un
  contrato CI adicional verifica inclusión, ausencia de omisiones y separación
  de la cobertura unitaria. El paso CI existente ya ejecuta ese comando.

**No se modificó runtime.** El catch del procesador sigue sin conservar los
artefactos del informe fallido. Este lote demuestra el origen de la evidencia
y prepara su ensayo, no implementa ni valida todavía esa conservación.

## 2. Qué se comprobó realmente

El candidato 2028 produce `passed: false` y nivel 4 `TEXT_DIFF_UNPLANNED`.
`text-diff.json` contiene el cambio observado 2026→2028, no 2027, y ninguna
edición validada. El control positivo produce `passed: true`, cambio observado
2026→2027 y la edición exacta del plan validada. Niveles 2/3 no aplicables para
TXT, no certificados como apertura o comparación visual aprobadas.

Se comparan el archivo del filesystem, su base64 inline, SHA-256, bytes de
origen/candidato y ausencia de mutaciones. Temporales 0700 y entradas 0600;
`finally` elimina sólo la carpeta propia y las pruebas verifican `ENOENT`.
Python tiene timeout 10 s, salida máxima 2 MiB, fuentes/candidato ≤1 KiB,
entorno mínimo sin secretos ni user-site. Stderr no se publica en aserciones.

Esto es el **núcleo Python real**, no el adaptador Docker, un motor de edición,
la rama catch del procesador, persistencia ni una atestación `runsc`. El helper
proyecta el informe real al tipo de dominio; no sustituye ni invoca
`IndependentDocumentValidator.validate`.

Las unitarias de DELETE usan el SDK instalado y Request/Response reales con
su transporte doblado, único doble permitido para este contrato. No hay
peticiones remotas ni eliminación de Files. Los IDs prueban ambas familias de
herramientas, 13 valores malformados y un sufijo válido de 180 caracteres
después de `file_` (185 totales); el test cuenta una vez, no por iteración.

## 3. Validación del lote

Node **24.19.0**. Desde `backend`, el oráculo nuevo:

```text
PATH=/Users/luis/.local/node/bin:$PATH DOC_SANDBOX_TEST_PYTHON=/Users/luis/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 node --import tsx --test tests/doc-sandbox-failure-evidence-validator.test.ts
tests 2; pass 2; fail 0; skipped 0; duration_ms 275.018667
```

Python procede del runtime documental local localizado por la aplicación; la
ruta es propia de este equipo, no se fija en CI. El primer intento con Python
del sistema falló **0/2** porque `lxml` estaba sólo en su user-site, excluido
del entorno mínimo. No se relajó ese entorno ni se instalaron dependencias;
se eligió el Python que ya las incluye. CI instala sus requisitos documentales
mediante `infra/doc-validation/requirements-test.txt` antes de esta suite.

Desde la raíz, con `PATH=/Users/luis/.local/node/bin:$PATH`:

```text
npm --prefix backend run test:doc-sandbox:coverage
tests 341; pass 341; fail 0; skipped 0
Lines/Statements 72.59% (2575/3547)
Branches 86.58% (1117/1290); Functions 75.07% (259/345)
exit 1: Coverage for lines (72.59%) does not meet global threshold (80%)
npm --prefix backend run test:doc-sandbox:auxiliary
tests 16; pass 16; fail 0; skipped 0; exit 0
npm run type-check
exit 0
npm --prefix backend run type-check:doc-sandbox
exit 0
node node_modules/typescript/bin/tsc -p tests/tsconfig.json
exit 0
NODE_ENV=test node --require ./tests/register-ts-paths.cjs --test --test-reporter=spec --test-reporter-destination=output/phase1-failure-evidence-root-tests-node24.log '.test-dist/tests/**/*.test.js'
tests 12466; suites 534; pass 12466; fail 0; skipped 0
duration_ms 62310.8435; exit 0
npm run lint
exit 0; 48 advertencias, mismo conteo heredado
bash scripts/verify-ui-lock.sh
UI lock verified — zero changes to frontend files; exit 0
git diff --check
exit 0
```

TypeScript estricto focal del nuevo test/helper también pasa. La suite del
motor dio 69/69; sus dos casos nuevos ya están incluidos en las 341 estrictas,
no sumar esa repetición. Logs locales `output/phase1-failure-evidence-*.log`.
No se repitió aquí la suite documental Office completa; CI Linux debe acreditar
el comando actualizado. Las 49 integraciones PG/Redis del lote anterior no se
recontabilizan: no cambiaron runtime ni sus fuentes de prueba.

## 4. CI y revisión

CI `34044850631` del HEAD anterior `c337481f4` terminó. El log real del shard 1
confirma 339/339 y 72,48 % (2571/3547); falla únicamente el 80 % y su agregador.
Frontend, restantes gates y workflows native readiness/desktop/mobile pasan.
Eso no acredita el nuevo lote, que tendrá su propio CI tras el push.

Revisión independiente del helper/oráculo detectó una interpolación de stderr
en un error de prueba. Se reemplazó por mensaje fijo antes de la ejecución del
orquestador; la segunda lectura confirma corrección. No hay dobles de DB,
Redis, storage o validador. La inspección de infraestructura fue de sólo
lectura; no se iniciaron servicios, Docker, SSH ni tareas de proveedor.
El control de secretos pasa sobre los ocho archivos del lote; los logs locales
y entornos de prueba permanecen fuera de Git.

## 5. Decisión y cobertura

D27: conservar una prueba positiva/negativa del validador real, fuera del
porcentaje unitario, y preparar una prueba de retención sin fingir un servicio
de almacenamiento o un runtime seguro. No tocar el catch hasta reproducir la
pérdida con componentes reales y revisar el diseño transaccional.

Dos unitarias nuevas ejecutan cuatro líneas más; denominador **3547** intacto.
**972 líneas** siguen sin ejecutar; faltan al menos **263** cubiertas para
2838/3547 (80 %). No se incluyen los dos casos Python ni integraciones en esa
métrica; no cambia el gate, sus exclusiones, fuentes o política SDK-only.

## 6. Ensayo de retención propuesto, aún no implementado

La lectura de `processor.ts` muestra que `OutputValidationFailure` ocurre antes
del bucle de persistencia exitoso y el catch omite `report.artifacts`. El
oráculo nuevo demuestra que un fallo textual real sí aporta diff. Falta probar
la pérdida y recuperación en la unión procesador/almacenamiento/repositorio.

Diseño revisado preliminar:

1. Preparar PostgreSQL y MinIO reales aislados, con schema/bucket aleatorios,
   cifrado y claves exclusivamente sintéticas. Reutilizar
   `createDocumentIntegrationFixture`, nunca producción ni `.env`.
2. Hacer que el tramo de manejo de fallo utilizado realmente por el catch sea
   comprobable sin fabricar su validador. Si requiere extraer un método privado,
   revisar primero la equivalencia de comportamiento y conservar guardas de
   cancelación, usuario, job, intento, lease y fencing. Sin ruta pública ni
   fallback de runtime. Ejecutar pre-fix con el informe Python real y comprobar
   que no queda registrado el diff; no confundir ese tramo con `process()` entero.
3. Propuesta de corrección posterior: `persist` existente para evidencia de
   `report.artifacts`, nunca `bundle` o outputs; SHA, cifrado, reserva previa,
   heartbeat y compensación intactos. Un deadline total de 15 s para todo el
   manejo del fallo, no uno nuevo ilimitadamente por cada archivo.
4. Ampliar `failAttempt` opcionalmente: evidencia sólo `text_diff`,
   `thumbnail_before`, `thumbnail_after`, y reporte obligatorio cuando exista.
   Tras `assertLease`, insertar evidencia con `published=false`, reporte como
   actualmente y transición/outbox en la **misma transacción**. No encadenar
   `registerArtifacts` y `failAttempt` como dos commits separados.
5. Revisar límites de cantidad/bytes contra los actuales del validador:
   ≤1001 artefactos, ≤10 MiB por artefacto y ≤16 MiB por validación. La combinación
   conservadora de varios documentos agrega informes: no truncarla ni imponer
   silenciosamente un límite diferente. Fijar ese contrato antes de implementar.

Matriz mínima posterior, sin contabilizar todavía como pruebas ejecutadas:

| Caso | Evidencia exigida |
| --- | --- |
| Diff fallido real | GCM almacenado, recuperación byte a byte y SHA exacto; cero outputs publicados. |
| Tipo no permitido/duplicado | Rechazo cerrado, estado/fence/eventos/artefactos sin cambios parciales. |
| Cancelación o lease vencido | Fencing efectivo; no reintento ni publicación tardíos. |
| Fallo después de PUT | Clave reservada conserva obligación de cleanup; sin certificado falso de borrado. |
| Tres intentos | Evidencia por intento sin sobreescribir originales; máximo tres intentos intacto. |
| Borrado/retención | Revocación y eliminación sólo de objetos del job; vecino intacto. |
| Procesador completo | Ensayo separado con adaptador real y runsc; no llamarlo probado por el tramo anterior. |

El Mac tiene PG/Redis de pruebas, pero no se encontró MinIO nativo en las rutas
referenciadas ni `minio`/`docker` resolubles. El adaptador productivo exige
`runsc`; Python directo no lo acredita. El runner Linux de integraciones
existente tampoco proporciona por sí solo transporte Docker/staging compartido
al validador. No cambiar esas guardas ni usar el socket para eludir autorización
administrativa. Una preparación de infraestructura requiere su revisión propia.

## 7. Aceptación y límites

- ✅ Dos pruebas del núcleo real y dos contratos nuevos del motor, cero skips.
- ✅ Inclusión obligatoria en CI y un contrato adicional que evita perderla.
- ✅ 341 estrictas y 12466 generales; tipos, UI-lock y lint sin nuevos avisos.
- ❌ Retención del diff en el catch: **todavía sin corrección ni ensayo integrado**.
- ❌ 80 %, goldens, R2, gVisor, E2E, migración/recuperación, aceptación F1.
- ❌ Merge, producción y F2. Gasto nuevo de proveedor: **US$0**.

## 8. Continuación

Mantener el borrador y revisar el CI nuevo. Si falla por algo distinto del
umbral conocido, reproducir/corregir sin quitar controles. Completar el ensayo
anterior cuando sus servicios estén disponibles, no repetir un acceso host
denegado ni declararlo listo por ejecutar Python. Mientras exista trabajo local
útil, auditar contratos puros/pre-IO y SDK con casos concretos, sin extraer
código únicamente por porcentaje. No repetir pruebas sin cambios ni reportar
el estado externo antiguo como fresco. Si sólo quedan prerequisitos externos,
informar una vez y pausar la continuación.

# F1 — cobertura y guardas de aceptación, continuación del 2026-09-06

**PR #561 en borrador. No desplegado. No es un cierre de fase.**
Base de esta continuación: `162ae058385b63c475f51ed20eb6bd0c1817e344`;
destino `production-main`, observado en `81f3d9a63150d241f2b22fa4b34ac98b4558a3e3`.
No se modificaron runtime, migraciones, dependencias, secretos ni interfaz.

## 1. Qué se implementó

- `.github/workflows/ci.yml`: ejecuta el comando de cobertura estricta como
  paso bloqueante del backend requerido, después de sus pruebas y boot smoke.
  Conserva el JSON específico incluso si el umbral falla. No usa
  `continue-on-error`, no reduce el 80 % y no mezcla cobertura del shard general.
- `tests/ci-doc-sandbox-coverage.test.ts`: tres contratos del gate, su pertenencia
  a checks requeridos, inclusión del shard 1, denominador completo y reporte.
- `backend/tests/doc-sandbox-engine.test.js`: cuatro casos de streams reales;
  cancelación previa/durante lectura, tamaño declarado inválido, respuesta sin
  cuerpo y error que no puede devolver un archivo parcial.
- `backend/tests/doc-sandbox-release-api-lifecycle.test.ts`: HTTP y Multer reales
  en loopback; límites, permisos, validación de identidades/tickets/cursor,
  readiness, liberación de cupos y ciclo deshabilitado. Clientes Prisma/S3
  reales apuntan sólo a un detector TCP local: se exige **cero conexiones**.
  La preparación y todos los cierres quedan protegidos aunque falle otro cierre.
- `backend/tests/doc-sandbox-release-api-projection.test.ts`: salidas públicas
  exactas, distinción entre editado/no cambiado/no posible, coste pendiente y
  ausencia de referencias privadas, sin mutar el estado fuente.
- `backend/tests/doc-sandbox-release-queue-{repository,processor}.test.ts`:
  siete casos de guardas antes de IO, callbacks de coste/referencias, lotes,
  artefactos y rechazo de falsas excepciones de validación.
- `backend/tests/doc-sandbox-validation-{filesystem,contracts}.test.ts`:
  23 casos de filesystem real y autoridad del plan; staging privado concurrente,
  exclusividad del manifiesto, límites y limpieza antes del lanzamiento,
  conservación de vecinos y bloqueo por huérfano inválido.
- Este reporte y el enlace actualizado desde `checkpoint-release-20260906.md`.

## 2. Cómo se probó

Runtime final **Node 24.19.0**, igual major que CI. Desde la raíz:

```text
PATH=/Users/luis/.local/node/bin:$PATH npm --prefix backend run test:doc-sandbox:coverage
tests 293; pass 293; fail 0; cancelled 0; skipped 0
duration_ms 1450.785792
Statements/Lines 71.68% (2476/3454)
Functions 75.67% (252/333); Branches 85.92% (1056/1229)
ERROR: Coverage for lines (71.68%) does not meet global threshold (80%)
exit 1

node node_modules/typescript/bin/tsc -p tests/tsconfig.json
exit 0
PATH=/Users/luis/.local/node/bin:$PATH NODE_ENV=test node --require ./tests/register-ts-paths.cjs --test --test-reporter=spec --test-reporter-destination=output/phase1-continuation-root-tests-node24.log '.test-dist/tests/**/*.test.js'
tests 12465; suites 534; pass 12465; fail 0; cancelled 0; skipped 0
duration_ms 63489.076875; exit 0

npm --prefix backend run test:doc-sandbox:auxiliary
tests 16; pass 16; fail 0; skipped 0; exit 0
npm --prefix backend run type-check:doc-sandbox
exit 0
npm run type-check
exit 0
npm run lint
exit 0; advertencias heredadas, no se afirma cero warnings
bash scripts/verify-ui-lock.sh
UI lock verified — zero changes to frontend files; exit 0
PATH=/Users/luis/.local/node/bin:$PATH node --test tests/phase1-migration-rehearsal.test.cjs
tests 17; pass 17; fail 0; skipped 0; exit 0
PATH=/Users/luis/.local/node/bin:$PATH npm --prefix backend run test:doc-sandbox:runtime
tests 53; pass 53; fail 0; skipped 0; exit 0
```

La primera medición no arrancó: el Node 26.7.0 predeterminado de la terminal
falló al cargar `c8/yargs`. No se cambiaron paquetes para esconderlo. Un segundo
intento Node 24 dentro del sandbox denegó `listen` en 127.0.0.1 (`EPERM`): sus
fallos y 67,45 % **no se cuentan** como resultado aprobado. La corrida final
Node 24 usó permiso explícito de ejecución con listeners sólo en loopback.

Reportes locales (salida completa; aquí sólo se transcriben totales):
`output/phase1-continuation-strict-coverage-node24-authorized.log`,
`output/phase1-continuation-root-tests-node24.log` y
`backend/coverage/doc-sandbox-unit/coverage-summary.json`.

Los contratos CI fallaron **2/3 antes** de añadir el paso faltante y pasan
**3/3 después**. Se verificó el YAML real con el parser `yaml` instalado.
Revisión de secretos sobre archivos cambiados/líneas añadidas: cero hallazgos;
scanner del repositorio exit 0. No es una certificación DLP de todo el repo.

## 3. Evidencia de validación

**71 casos más**, de 222 a 293; **219 líneas más**, de 2257 a 2476.
El denominador permanece **3454**, sin excluir fuentes ni sumar los 16
auxiliares. Los 54 renglones de `engine/types.ts` siguen incluidos con cero
cobertura; no se han retirado para elevar artificialmente el porcentaje.

Estas pruebas no generan un `validation_report.json` de un job real del usuario.
No hubo goldens Anthropic, E2E autenticado, documento real editado ni prueba
de producción en esta continuación. Gasto nuevo: **US$0**.
No se reutilizan las 66 integraciones históricas como si se hubieran vuelto a
ejecutar con estos nuevos tests.

## 4. Decisiones tomadas

- Convertir el requisito de cobertura existente en un gate CI efectivo. El
  verde del commit anterior no demostraba el 80 %; el nuevo candidato debe
  mostrar el déficit y no declararse apto para merge/publicación.
- Mantener todos los archivos, umbrales y tests auxiliares; las entradas de
  predicados puros no son resultados fabricados de un validador ejecutado.
- Mantener las pruebas HTTP como contratos locales de rechazo antes de IO.
  Su identidad es una fixture explícita, **no** autenticación JWT/OAuth/CSRF
  real ni autorización positiva sobre jobs persistidos.
- Revisión independiente de las pruebas HTTP y el gate; se corrigió la
  limpieza parcial del harness y se endureció la comprobación del job/matriz.

## 5. Desviaciones respecto a la especificación

La cobertura aún no llega al 80 %. Faltan al menos **288 líneas** ejecutadas
para 2764/3454. No se simulan transacciones, colas ni validación para cerrar esa
brecha. Las ramas pendientes de procesamiento, persistencia y ciclo activo
necesitan más trabajo técnico; no se presentan como un bloqueo sólo de acceso.

## 6. Limitaciones conocidas y riesgos

- **Bloqueante:** cobertura 71,68 %; el nuevo gate CI debe fallar por ese motivo
  hasta que se complete la aceptación, aunque todas las aserciones pasen.
- **Bloqueante:** siguen pendientes host administrativo auténtico, runsc
  efectivo, R2 privado, presupuesto Anthropic acreditado hasta US$5 agregados,
  goldens, muestras y E2E. No se revalidó el estado remoto en esta continuación.
- **Bloqueante:** atestación histórica y ensayo migratorio/recovery completo
  del checkpoint. No se aplicó SQL, `migrate resolve` ni modificaciones al host.
- Los contratos de instalación de runtime son tests locales; no acreditan una
  instalación de gVisor ni permiten afirmar que se ejecutó un contenedor seguro.

## 7. Checklist de aceptación

- ✅ Pruebas incrementales sin omisiones, typechecks, lint y UI-lock.
- ✅ Gate CI obligatorio del 80 % añadido y regresión comprobada.
- ❌ Cobertura mínima, goldens, E2E autenticado y cinco documentos reales.
- ❌ Runtime/storage/provider y migración/recuperación listos para release.
- ❌ Publicación y edición/descarga real desde siragpt.com.

## 8. Continuación

Mantener #561 en borrador y avanzar los contratos pendientes sin cambiar el
denominador para mejorar el KPI. Acreditar por separado servicios reales,
documentos/goldens y migración segura. No publicar frontend F1 con motor
apagado, no reiniciar Docker/producción, no iniciar F2 ni anunciar el 100 %.

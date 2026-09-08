# F1 — cancelación y descargas rechazadas, 2026-09-06

**PR #561 en borrador, no desplegado. No cierra F1.** Continuación de
`db4bc8eaff5f6cee6f4ccb260e75028fdc8128da`, con base `production-main`
observada en `81f3d9a63150d241f2b22fa4b34ac98b4558a3e3`.

## 1. Qué se implementó

- `validation/lifecycle.ts` acepta una señal opcional de cancelación y la
  comprueba al terminar la lectura real del manifiesto privado.
- `validation/index.ts` transmite esa señal y vuelve a comprobarla después
  del `await`, inmediatamente antes de lanzar el contenedor. Un evento abort
  ya emitido no se reproduce al instalar un listener tardío.
- `engine/artifacts.ts` solicita cancelar también los cuerpos HTTP rechazados.
  La cancelación del transporte queda observada, pero no se espera una promesa
  que podría quedar pendiente indefinidamente o reemplazar el error principal.
  Se conservan el error HTTP, el límite de tamaño y la razón de cancelación;
  `finally` sigue liberando el reader y su listener. Un error real de lectura
  sigue rechazando la descarga, nunca devuelve un documento parcial.
- Once regresiones de streams reales y tres de filesystem/AbortController
  reales en las suites existentes. No se añade ningún doble de validador.

No cambian UI, dependencias, SQL, configuración, Docker ni proveedor. Sí hay
cambios de runtime acotados en esos tres archivos; no es un parche sólo de tests.

## 2. Cómo se probó

Todos los comandos finales usan `PATH=/Users/luis/.local/node/bin:$PATH`
(Node 24.19.0). Desde la raíz:

```text
npm --prefix backend run build:doc-sandbox
exit 0
node --test backend/tests/doc-sandbox-engine.test.js
tests 67; pass 67; fail 0; skipped 0; exit 0
npm --prefix backend run test:doc-sandbox:coverage
tests 307; pass 307; fail 0; cancelled 0; skipped 0
duration_ms 1667.342708
Statements/Lines 71.76% (2486/3464)
Functions 75.67% (252/333); Branches 86.02% (1065/1238)
ERROR: Coverage for lines (71.76%) does not meet global threshold (80%)
exit 1
npm --prefix backend run test:doc-sandbox:auxiliary
tests 16; pass 16; fail 0; skipped 0; exit 0
npm --prefix backend run type-check:doc-sandbox
exit 0
npm run type-check
exit 0
npm run lint
exit 0; advertencias heredadas
bash scripts/verify-ui-lock.sh
UI lock verified — zero changes to frontend files; exit 0
node node_modules/typescript/bin/tsc -p tests/tsconfig.json
exit 0
NODE_ENV=test node --require ./tests/register-ts-paths.cjs --test --test-reporter=spec --test-reporter-destination=output/phase1-cancellation-root-tests-node24.log '.test-dist/tests/**/*.test.js'
tests 12465; suites 534; pass 12465; fail 0; skipped 0
duration_ms 60437.482291; exit 0
```

La suite estricta requiere permiso de listeners sólo en loopback para sus
contratos HTTP existentes. No usa servicios productivos ni llamadas pagadas.
Logs locales: `output/phase1-cancellation-strict-coverage-node24.log`,
`output/phase1-cancellation-root-tests-node24.log` y
`output/phase1-cancellation-lint-node24.log`; cobertura JSON en
`backend/coverage/doc-sandbox-unit/coverage-summary.json`.

## 3. Evidencia de regresión

- Antes del arreglo de streams, **6/7** casos nuevos fallaron: cuerpos HTTP sin
  cancelar y fallos de limpieza que reemplazaban el error original.
- Una primera corrección que todavía esperaba `cancel().catch(...)` dejó
  **4/4** regresiones adicionales fallando por limpieza pendiente. El arreglo
  definitivo pasa las once. La espera del test es una frontera real del event
  loop (`setImmediate`), no un objetivo de latencia arbitrario; su `finally`
  resuelve la promesa de limpieza incluso si falla la aserción.
- Antes del arreglo del manifiesto, **2/3** casos nuevos fallaron por ausencia
  del rechazo esperado. Después pasan **3/3**, conservando bytes del original
  y el manifiesto, los errores de identidad/caducidad y un código público estable.
- Revisión independiente: motor **67/67**, filesystem **36/36**, sin omisiones,
  y typecheck focal estricto. No se suman esas repeticiones a los 307 casos.

## 4. Decisiones

D24 en `decisiones.md`: separar el rechazo local de una descarga de la
confirmación remota de limpieza. El borrado de Files y el journal existente
permanecen aparte. Conservar el cleanup del validador y sus comprobaciones de
identidad; no introducir rutas de bypass, reintentos ni timeouts mayores.

## 5. Desviaciones y cobertura

No se cambia el alcance de F1 ni se inicia F2. El denominador pasa de 3454 a
3464 por las guardas y comentarios añadidos a runtime; no se excluye código.
Las **978 líneas todavía no ejecutadas siguen pendientes**. El cambio resuelve
fallos funcionales, no el déficit de cobertura; el gate del 80 % permanece
bloqueante y necesita al menos 2772/3464 líneas (286 más que las medidas).
Los 16 auxiliares se ejecutan aparte y no cuentan para ese requisito.

## 6. Límites y riesgos

No se lanzó Docker/gVisor ni se ejecutaron goldens Anthropic, jobs completos,
E2E autenticados o documentos del usuario. Las pruebas de admisión comprueban
la guarda con filesystem real; la revisión del caller comprueba la conexión
antes de `spawn`, no una ejecución integral de contenedor. La limpieza previa
existente puede consultar Docker aun cuando no se lance la validación.

Solicitar cancelar un stream no certifica cierre remoto ni eliminación de
archivos. No cambian los registros/reintentos de borrado del proveedor.
Producción no se tocó ni se revalidó. Gasto nuevo Anthropic: **US$0**.
Servicios reales, muestra documental y ensayo migratorio siguen pendientes
según el checkpoint; las integraciones históricas no se cuentan como repetidas.

## 7. Aceptación

- ✅ Regresiones pre-fix/post-fix, 307 unitarias, suite general y revisión.
- ✅ Tipos, lint con advertencias existentes y UI-lock sin cambios.
- ❌ Cobertura mínima, runtime real, goldens, E2E y migración/recuperación.
- ❌ Merge, publicación y edición/descarga real en siragpt.com.

## 8. Continuación

Mantener el borrador. El siguiente bloque técnico puede aislar políticas puras
de leases/estados y presupuestos para probar sus decisiones sin simular DB;
las transacciones, locks y reloj autoritativo deben seguir en el repositorio.
No declarar estas pruebas equivalentes a concurrencia PostgreSQL real, no
reducir el gate, no desplegar el frontend con el motor deshabilitado y no
reiniciar servicios de producción.

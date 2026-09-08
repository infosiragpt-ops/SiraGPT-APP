# Revisión backend de continuidad — 2026-09-05

Revisión y comprobaciones ejecutadas sobre el checkout aislado
`/home/user/deployments/doc-sandbox-phase1-tests/candidate-git-561`, conservando
los cambios sin commit que ya existían. Este informe **no cierra F1, no acredita
motor Anthropic real ni un despliegue**. No se utilizaron credenciales, DB,
documentos ni servicios productivos; tampoco hubo llamadas pagadas.

## Cambios de esta revisión

- `backend/package.json`: la suite unitaria incluye ahora
  `doc-sandbox-validation-lifecycle.test.ts`; antes sus nueve pruebas no se
  ejecutaban mediante el script usado por CI.
- `validation/lifecycle.ts`: una invocación en cuarentena conserva `pending`
  durante el período de gracia. Antes se omitía como si fuera una invocación
  activa y podía reabrir la admisión sin haber confirmado la limpieza.
  El test de lanzamiento incierto comprueba esta ventana y la limpieza posterior.
- `types/contracts.ts`, `queue/processor.ts` y `engine/anthropic-engine.ts`:
  el modelo solicitado y guardado en el job llega hasta el motor. Si cambia el
  modelo configurado para ese nivel mientras el job espera, se devuelve
  `E_NOT_READY` antes de reservar o llamar a otro modelo. El test SDK exige
  cero reservas y cero llamadas ante esa discrepancia.
- `infra/doc-validation/run-isolated-integration.sh`: usa el loader `tsx`
  instalado en el candidato y conserva la ruta absoluta entre host/contenedor.
  La ruta anterior `/app/node_modules/tsx/dist/loader.mjs` no existe en la imagen
  de test fijada. Puede guardar cobertura V8 en un directorio privado explícito
  `/tmp/doc-sandbox-coverage-*`, validado antes de iniciar servicios.
- `infra/doc-validation/trace-python-coverage.py`: launcher de medición con
  `trace` de la biblioteca estándar. Mantiene stdout y código de salida; cada
  subprocess escribe un registro propio para combinar las líneas ejecutadas
  del validador completo. No modifica el código ni los resultados del validador.
- `backend/tests/doc-sandbox-storage.integration.test.ts`: caso de limpieza con
  Postgres y MinIO reales. Comprueba período de gracia, cancelación, un DELETE
  denegado por HTTP, conservación del outbox pendiente y purga posterior de
  objetos huérfanos, manteniendo intactos los objetos de otro propietario.

Los cambios preexistentes de cuotas, época de facturación, revocación de cuentas,
retención y limpieza no se reemplazaron. Se revisaron los resets de `apiUsage`:
los resets existentes de pagos y `usage-monitor` incrementan `docQuotaEpoch`;
los otros `apiUsage: 0` encontrados corresponden a creación de cuentas.

## Comprobaciones ejecutadas

Evidencia privada principal: `/tmp/doc-sandbox-coverage-vZISUWpX/`.
Los conteos de esta tabla son suites distintas; **no deben sumarse como E2E**.

| Comando o suite | Resultado observado | Evidencia |
| --- | --- | --- |
| `npm --prefix backend run test:doc-sandbox:unit` | Compilación TS estricta y diez archivos de tests en verde | `/tmp/doc-sandbox-backend-readiness-unit-final.tap` |
| `node --import tsx tests/doc-sandbox-engine.test.js` desde backend | 52/52, cero fallos/skips | `/tmp/doc-sandbox-backend-readiness-engine-final.tap` |
| `node --import tsx tests/doc-sandbox-validation-lifecycle.test.ts` desde backend | 9/9, cero fallos/skips | `/tmp/doc-sandbox-backend-readiness-lifecycle-final.tap` |
| Runner HTTP/S3/Postgres/Redis aislado, con cobertura | 63/63, cero fallos/skips, 20059.717759 ms | `integration.tap` en la evidencia principal |
| Suite storage repetida con el nuevo caso de limpieza | 10/10, cero fallos/skips, 4616.797452 ms | `cleanup-integration.tap`; nueve casos se solapan con el runner anterior |
| `doc-sandbox-validation.test.py`, herramientas reales Linux | 42/42, 32.253 s | `documents.tap` |
| `doc-sandbox-readiness.test.py`, herramientas reales Linux | 2/2, 4.523 s | `documents.tap` |
| Corpus complejo, oráculos y G10 conservador existentes | 16/16, cero fallos/skips, 48751.085646 ms | `documents.tap` |
| Regresión de pagos HTTP: plan-change-validation y subscription-cancel | 9/9, cero fallos/skips | `/tmp/doc-sandbox-backend-readiness-payments-unsandboxed.tap` |
| `git diff --check`, sintaxis bash y compilación del helper Python | Exit 0 | Comprobación local |

La regresión adicional de documentos, auth, RBAC, cuotas, CSRF y reglas
Prometheus terminó sin archivos de tests fallidos tras aislar los dos tests HTTP
de pagos. El test opcional heredado de `promtool` no se acredita como ejecutado.

Fallos previos conservados: el primer runner falló en sus cuatro archivos antes
de ejecutar tests por `ERR_MODULE_NOT_FOUND` del loader; no se contabilizó como
éxito. Los tests HTTP de pagos fallaron inicialmente con `listen EPERM` dentro
del sandbox y pasaron al repetir con permiso para sockets efímeros. No se
cambiaron aserciones ni se añadieron reintentos para ocultar estos fallos.

El runner inicia únicamente `doc-sandbox-test-postgres`,
`doc-sandbox-test-redis` y `doc-sandbox-test-minio`, con red interna y sin puertos
publicados. Su trap detiene los servicios iniciados. Tras la ejecución inicial
exitosa se verificaron los tres en estado `exited`; la repetición instrumentada
también terminó con exit 0 y ejecutó el mismo trap antes de entregar la ventana
al agente encargado del navegador.

## Cobertura y su alcance

Se combinaron unitarias, integración real y suites documentales existentes.
No se añadieron pruebas para aumentar el porcentaje. `c8 --all` incluye todos
los archivos TS del módulo, incluso archivos con interfaces sin ejecución.
Los filtros se aplican **después** del remapeo de source maps para contabilizar
también el motor compilado en `dist`. Una medición inicial que filtraba antes
del remapeo subcontaba ese código y no se utiliza como resultado final.

| Universo | Cubierto / total | Resultado |
| --- | --- | --- |
| TypeScript: líneas y statements | 2721 / 3454 | 78.77 % |
| TypeScript: funciones | 260 / 310 | 83.87 % |
| TypeScript: ramas | 1245 / 1459 | 85.33 % |
| Python: líneas ejecutables de `validation/validator.py` completo | 732 / 782 | 93.61 % |
| Agregado ponderado de líneas TS + Python | 3453 / 4236 | 81.52 % |

Python se midió con `trace`, pues `coverage.py` no estaba instalado en host ni
imagen. Se usa su denominador de líneas ejecutables completo y se unen los
hits de 44 procesos; no se excluyen funciones del validador. **No se midieron
ramas ni funciones de Python**. Las métricas TS y Python utilizan instrumentos
distintos, por lo que el agregado es descriptivo.

El agregado **no demuestra por sí solo el requisito de cobertura unitaria ≥80 %
de §10.2**: incluye integración y Python no aporta una métrica de ramas. La
orquestación principal sigue con cobertura baja al no haberse ejecutado el
flujo completo de motor real: `queue/processor.ts` e `index.ts`. El caso adicional
ejercita el reconciliador de limpieza con storage y persistencia reales. No se
sustituyó el flujo documental por validadores simulados.

Datos conservados: `ts/coverage-final.json`, `ts/coverage-summary.json`,
`python/*.json`, `python-summary.json` y `combined-summary.json` dentro de la
evidencia privada. No contienen credenciales ni documentos de clientes.

Para reproducir la parte TS desde `backend`, con un directorio privado nuevo:

```sh
node_modules/.bin/c8 --all --src src/modules/doc-sandbox \
  --include 'src/modules/doc-sandbox/**/*.ts' \
  --include 'dist/doc-sandbox/**/*.js' --exclude-after-remap --clean=false \
  --temp-directory /tmp/doc-sandbox-coverage-<id>/v8 \
  --reporter=text-summary --reporter=json-summary --reporter=json \
  --reports-dir /tmp/doc-sandbox-coverage-<id>/ts npm run test:doc-sandbox:unit
```

Después, desde raíz, pasar el mismo directorio como segundo argumento a
`infra/doc-validation/run-isolated-integration.sh` y regenerar el reporte con
`c8 report` y las mismas opciones. Para Python, ejecutar las suites reales a
través de `infra/doc-validation/trace-python-coverage.py`; el segundo argumento
es un directorio privado para sus registros y los restantes son el script o
`-c` con sus argumentos. Los oráculos ya admiten `DOC_FIXTURE_PYTHON` y
`DOC_SANDBOX_TEST_PYTHON` para usar un launcher con esos argumentos fijos.

## Gates que este informe no cierra

- Runtime `runsc` aplicado y aislamiento real verificado en host.
- Cinco jobs Anthropic con los golden completos, costo registrado y límite de
  gasto acreditado; cero llamadas pagadas en esta revisión.
- E2E canónico autenticado de edición y descarga, carga del motor real y
  corroboración manual de documentos representativos.
- Cobertura unitaria global exigida por la especificación y revisión final de
  la combinación completa.
- CI final del SHA que se publique, migración histórica y despliegue con
  respaldo, comprobación de versión, salud y descarga. La migración histórica
  y el navegador se comprobaron en tareas separadas y deben citar su propia
  evidencia; esta revisión no se atribuye esos resultados.

No se ejecutaron commits, pushes, migraciones productivas ni publicación desde
esta revisión. Las restricciones pendientes deben resolverse antes de presentar
la capacidad como disponible en `siragpt.com`.

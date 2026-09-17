# F1 — preservar la base productiva #572

2026-09-07 UTC. **#561 no desplegada; no es cierre de F1.**
Padre documental: `cd2e6501c3c746c058bd449779ce0f934273f6d2`.
Base publicada: `546a8156b2ec63c468157a4125aebcb4705f80db` (#572).

Este informe conserva una comprobación concurrente de **`cd2e6501c` + #572**.
Durante su revisión, la PR avanzó a `3b41fbb3a302a34863a3759d12f2c9f22dd40c3e`,
que ya incorpora #572 y un refactor documental adicional. Las cifras y la
afirmación de runtime F1 intacto de este informe describen sólo la combinación
anterior, no ese nuevo HEAD. No se sobrescribe el trabajo remoto; requiere
revisión y medición propias antes de incorporarlo por la vía normal.

## Integración acotada

La comprobación inicial encontró #572 en `production-main`, checkout Lenovo
limpio y `/api/version`. Su CI `34078736477` y workflow Docker `34078736479`
terminaron correctamente. Se incorpora a la rama documental mediante merge
normal, sin rebase de la historia compartida, force push ni merge de #561 a
producción. No se ejecuta un publicador.

El merge no tuvo conflictos. Los 32 archivos aportados por #572 distintos
de `backend/package.json` son byte-idénticos a esa base, incluidos su
changelog, atribución, fuentes, pruebas e informe. El único solapamiento es
la unión de scripts de ese manifiesto:

```text
productionFilesChecked: 32; differing: []
docScriptCount: 15; missingDocScripts: []
changedBaseScripts: test:agent-brain, test:openclaw-native
missingBaseScripts: []; packageNonScriptsUnchanged: true
unchangedF1: true; unchangedLocks: true
```

Se compararon blobs Git con archivos y objetos JSON completos de scripts y
campos restantes. Módulo runtime y pruebas documentales, Prisma, lockfiles,
workflows y UI-lock conservan el padre documental. No se añade una corrección
de producto distinta ni se rediseña la interfaz.

## Revisión de compatibilidad

Revisión independiente sin P1/P2 introducido identificado: F1 usa su propio
endpoint `/api/docs/jobs`, metadatos `docSandbox`, proyección de estados y
recuperación. La ruta del cliente retorna antes del agente general; su
recuperador excluye las burbujas documentales. El módulo comparte la conexión
y opciones de la cola, no el runner/ReAct ni el clasificador de finalización
modificados por #572; esas conexiones no cambiaron en la base.

La revisión es estática y de manifiestos. No certifica ejecución distribuida,
edición documental real ni recuperación de todos los caminos legados. Las
limitaciones y pruebas históricas de #572 permanecen en su informe original,
sin reetiquetarlas como nuevas pruebas aprobadas de F1.

## Pruebas de la combinación

Node 24.19.0, desde la raíz con el runtime local en PATH:

```text
npm --prefix backend run test:agent-brain
314/314; 11 suites; 0 fail/skip; 11887.18725 ms
npm --prefix backend run test:openclaw-native
362/362; 5 suites; 0 fail/skip; 11509.327791 ms; exit 0
npm --prefix backend run test:doc-sandbox:coverage
378/378; 0 fail/skip; 2081.862333 ms
Lines/Statements 72.41% (2751/3799)
Branches 86.46% (1227/1419); Functions 76.13% (268/352)
exit 1: el umbral del 80% permanece intacto y sigue incumplido
node node_modules/typescript/bin/tsc -p tests/tsconfig.json
NODE_ENV=test node --require ./tests/register-ts-paths.cjs --test --test-reporter=spec --test-reporter-destination=output/phase1-base572-root-tests.log '.test-dist/tests/**/*.test.js'
12472/12472; 535 suites; 0 fail/skip; 64318.509875 ms; exit 0
```

`agent-brain` y `openclaw-native` se solapan: no sumar sus casos como cobertura
única. Usan respuestas de modelo y herramientas de prueba; no equivalen a
proveedor real ni aceptación documental. Permanecen fuera de la métrica
unitaria estricta de F1. No se cambiaron aserciones, exclusiones ni umbrales.

Tipos raíz y módulo: exit 0. Lint: exit 0 con las mismas 48 advertencias
heredadas; no cumple el objetivo aspiracional de 45 de la guía general.
UI-lock, diff preparado/no preparado y escaneo acotado de secretos: exit 0.
El escaneo es un backstop de patrones, no una auditoría completa.

Logs locales ignorados: `output/phase1-base572-agent-brain.log`, `-native.log`,
`-unit-coverage.log`, `-root-tests.log` y `-lint.log` (mismo prefijo).
No se reejecutaron integraciones DB en este lote: el módulo F1, Prisma y la
conexión compartida están intactos. Las pruebas Linux de D33 son anteriores
y no se presentan como ejecución de esta nueva combinación.

El CI remoto del padre documental `cd2e6501c`, run `34079424365`, terminó con
fallo únicamente en el gate de líneas del 80% y su agregador. Confirmó 378/378
unitarias y 72,41% (2751/3799). Sus grupos F1 separados pasaron sin omisiones:
auxiliares 16, runtime 53, persistencia 45, recuperación 8, documentos 16,
readiness 5, HTTP/storage 34 y retención 10. La suite general del shard 1
registró 7101 aprobadas y 5 omisiones heredadas de 7106; no se atribuye a esa
suite cero omisiones ni se suman sus resultados al numerador unitario F1.
Este resultado no corresponde al nuevo HEAD `3b41fbb3…`.

## Estado vivo y controles pendientes

Readiness público HTTP 200 `healthy` a **2026-09-07T03:28:31.120Z**, con
`/api/version` y checkout limpio en `546a8156b…`. Esa es #572, no #561.
La sesión SSH sigue dentro del contenedor deploy, UID 1000, sin acceso
administrativo del host. Docker no registra `runsc`. La comprobación del
backend actual sólo obtuvo booleanos: los campos R2 y DOC_SANDBOX requeridos
continúan ausentes; sólo se extrajeron booleanos, no valores de secretos.

Se observó un contenedor de pruebas ajeno que ya no existía al consultarlo;
no se le enviaron señales ni se alteró. Este lote no inicia contenedores,
servicios, migraciones, cambios DNS ni reinicios. Gasto nuevo US$0; disponer
de una clave no acredita el límite agregado del proveedor.

Esta combinación conserva el gate del 80%, aislamiento real, almacenamiento privado,
presupuesto efectivo de US$5, documentos representativos, aceptación
auténtica y ensayo migratorio/recovery como requisitos pendientes. La nueva
combinación no sustituye el CI del HEAD vigente. No usar el publicador antiguo ni activar
el frontend documental con F1 deshabilitada para aparentar un despliegue.

Guías: `quality-gates`, `release-orchestrator`, `agent-validation`,
`secret-safety` y `technical-docs`. La autorización de publicación no
sustituye ninguno de estos controles ni da por iniciada la siguiente fase.

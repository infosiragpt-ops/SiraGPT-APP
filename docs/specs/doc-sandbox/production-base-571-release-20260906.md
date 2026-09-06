# F1 — base productiva #571 y límites de limpieza/exportación

2026-09-06 UTC. Continuación de #561 sobre
`b1080dab1ba7bdf17736d32bd6714fc39cae353a`. **No desplegada; F1 no cerrada.**
La autorización para publicar no levanta los controles de aceptación.

## 1. Qué se implementó

Integración sin conflictos de `production-main` en
`100d29bc2e76bf2fb6e875514112f5cae1e40025` (#571), ya publicado por otro flujo.
Sus 15 archivos de código, tests, tipos y configuración de escritorio quedan
byte-idénticos a esa base. No se cambia su comportamiento en este lote.

- `backend/package.json`: unión del nuevo test de Chrome con todos los scripts
  documentales. Los scripts `test` y `test:openclaw-native` coinciden con la
  producción actual; los scripts F1 y dependencias conservan el HEAD anterior.
- `docs/UI_LOCK_HASHES.txt`: conserva cinco hashes específicos F1 y los cuatro
  actualizados por #571. Los nueve coinciden con los archivos correspondientes.
  No se sustituye el inventario completo ni se rediseña la UI.
- `backend/tests/doc-sandbox-validation-filesystem.test.ts`: tres pruebas de
  fallo real al iniciar el ejecutable ausente de limpieza, cuarentena y reintento.
- `backend/tests/doc-sandbox-engine.test.js`: dos pruebas de originales que el
  proveedor presenta como outputs, más rechazo de versión/intento inválidos.
- Este informe y checkpoint de continuidad.

El módulo runtime F1 y Prisma permanecen idénticos a `b1080dab1`; sin nuevas
dependencias, configuración, exclusiones o cambios de política de cobertura.

## 2. Cómo se probó

Node 24.19.0. La revisión de procedencia compara bytes mediante `git show` y
filesystem, hashes SHA-256 y objetos JSON de scripts/dependencias:

```text
preservedProductionFiles: 15; mismatches: []
documentalHashes: 5; productionHashes: 4; invalidHashes: []
documentScriptsUnchanged: true; generalTestEqualsProduction: true
nativeScriptEqualsProduction: true; dependenciesUnchanged: true
git diff --exit-code b1080dab1 -- backend/src/modules/doc-sandbox backend/prisma
exit 0
```

Con `PATH=/Users/luis/.local/node/bin:$PATH` desde la raíz:

```text
npm run type-check
npm --prefix backend run type-check:doc-sandbox
npm run lint
bash scripts/verify-ui-lock.sh
exit 0 en cada comando; lint: 48 advertencias heredadas; UI-lock aprobado
node --test backend/tests/chrome-desktop-flags.test.js backend/tests/desktop-f7-dcp.test.js
10 aprobadas de 11; 0 fallos; 1 omitida heredada; 868.959875 ms; exit 0
npm --prefix backend run test:openclaw-native
173/173 aprobadas; 0 fallos/omisiones; 12701.719458 ms; exit 0
node node_modules/typescript/bin/tsc -p tests/tsconfig.json
exit 0
NODE_ENV=test node --require ./tests/register-ts-paths.cjs --test --test-reporter=spec --test-reporter-destination=output/phase1-merge571-root-tests.log '.test-dist/tests/**/*.test.js'
12470/12470 aprobadas; 535 suites; 0 fallos/omisiones
60366.703833 ms; exit 0
npm --prefix backend run test:doc-sandbox:coverage
351/351 aprobadas; 0 fallos/omisiones; 1508.773916 ms
Lines/Statements 73.91% (2638/3569)
Branches 86.58% (1155/1334); Functions 76.81% (265/345)
exit 1 exclusivamente por el 80% de líneas exigido
```

La prueba omitida de escritorio es el screenshot-diff F7 que ya requiere
Docker. No se modificó ni se declara superada. No pertenece a la suite F1,
cuyas 351 pruebas no omiten ningún caso. Los tests de fuente de #571 se incluyen
en las 12470 generales; no se suman otra vez.

La primera ejecución restringida falló al abrir puertos loopback (`listen
EPERM`): seis fallos de la suite documental (313/319) y fallos de DCP. No se
presenta como medición válida de aceptación. Se repitieron con permiso de
loopback, sin cambiar sus aserciones; la ejecución documental completa incluye
además las seis pruebas nuevas, implementadas durante esa continuación.

TypeScript estricto focal del test de filesystem, desde `backend`:

```text
node node_modules/typescript/bin/tsc --noEmit --target ES2022 --lib ES2022,DOM --module CommonJS --moduleResolution Node --strict --noUncheckedIndexedAccess --esModuleInterop --skipLibCheck --types node tests/doc-sandbox-validation-filesystem.test.ts
exit 0
```

Logs locales `output/phase1-merge571-*`, fuera de Git. No se reejecutó PostgreSQL
local: no cambiaron motor, ledger ni sus pruebas de integración. CI anterior
del HEAD exacto sí se comprobó por separado, como se detalla abajo.
Escaneo explícito de secretos de los 21 archivos del lote y comprobación de
espacios del diff preparado/no preparado: exit 0; salida privada del escaneo.

## 3. Evidencia de validación

Los tres casos de filesystem usan directorios/manifiestos/bytes, rename y
`spawn` reales. El ejecutable configurado es una ruta inexistente dentro del
fixture privado, comprobada con `lstat`; no existe un CLI falso que simule
Docker. El error conserva su código estable y no expone ruta privada ni ENOENT.
La cuarentena mantiene permisos 0700/0600 y bytes originales; repetir no duplica
ni borra. La reconciliación vencida retorna `pending=1`, `purged=0`. Cada
fixture elimina sólo su directorio temporal y verifica su inexistencia final.
Esto **no acredita inspección ni eliminación de contenedores**.

Los otros tres casos usan únicamente el SDK doble. En ambas familias de
herramientas, una respuesta con output válido, ID del original y otro output
válido se rechaza antes de continuar `pause_turn` o descargar. Las referencias
hermanas, contenedor y consumo reciben sus callbacks; el original no se
reclasifica ni borra dos veces. Estos callbacks no prueban persistencia durable.
Versiones de prompt/intentos ilegales se rechazan antes de cualquier callback;
los límites legales 1 y 3 continúan admitidos.

Revisión independiente de las seis pruebas y del informe: sin bloqueantes.
Corroboración ejecutada por el revisor desde `backend`, con Node 24 y sin build:

```text
node --import tsx --test --test-name-pattern='an uploaded original cannot become|invalid session prompt versions|cleanup spawn ENOENT|reconciliation spawn ENOENT' tests/doc-sandbox-engine.test.js tests/doc-sandbox-validation-filesystem.test.ts
6/6 aprobadas; 0 fallos/omisiones; 181.442583 ms; exit 0
```

Esta repetición está incluida en las 351 pruebas; no sumar sus casos de nuevo.

CI de **b1080dab1**, no de la nueva integración:
[run 34063830248](https://github.com/infosiragpt-ops/SiraGPT-APP/actions/runs/34063830248),
job **101569007326**. Paso documental aprobado: persistencia **45/45**
(3241.136551 ms, incluido upload-ID duplicado) y recuperación **8/8**
(1213.43049 ms), cero fallos/omisiones. Unitarias **345/345**. Falló sólo el
paso 24 de cobertura **72,76 % (2597/3569)** y el agregador **101569980175**.
Frontend, E2E críticos existentes, controles de seguridad y los tres workflows
nativos aprobados. No equivalen al E2E documental auténtico ni a producción F1.

## 4. Decisiones tomadas

Preservar la versión que realmente está publicada, mediante merge normal sin
reescribir historia, en vez de devolver producción a una base anterior. Se
revisan las uniones de scripts y UI-lock, no se alteran las superficies F7.

Ampliar los contratos de D21/D28 con fallos reales de filesystem/proceso y SDK
defectuoso, sin modificar runtime ni fabricar validadores o servicios. Son
pruebas adicionales de comportamiento existente, no un arreglo de producción.

## 5. Desviaciones respecto a la especificación

La cobertura mejora 41 líneas, conservando el denominador 3569. Faltan al
menos 218 líneas cubiertas para alcanzar 2856/3569 (80%). No se reclasifican
integraciones, importan artificialmente archivos de tipos, omiten fuentes o
rebajan controles. El bloque restante requiere trabajo de contratos e
integraciones reales, no declaraciones de cobertura completa.

No se ejecutó un job facturable ni cambió configuración privada; gasto nuevo
**US$0**. El límite efectivo del máximo agregado US$5 sigue sin acreditarse.

## 6. Limitaciones conocidas y riesgos

Lectura productiva de esta continuación: checkout limpio, rama remota y
`/api/version` coinciden en **100d29bc2**; readiness saludable a
**2026-09-06T22:32:28.393Z**. La publicación es #571, no #561. No se ejecutó
ningún publicador ni escritura productiva, reinicio o cambio DNS.

No se reconsultaron runsc, R2/configuración o el host administrativo. Persisten
los prerrequisitos documentados, la retención del diff fallido y el ensayo de
migración/recuperación pendiente. No usar el publicador antiguo para F1.

La revisión estática de #571 detecta un riesgo ajeno al cambio documental:
`DesktopScreen` espera `framebufferupdate` para retirar «Preparando escritorio»,
pero la dependencia local noVNC 1.7.0 no emite ese evento y su wrapper sólo
reexporta RFB. El problema preexistía en su rama F7; #571 amplía el uso a la
ruta legacy. **No se reprodujo en navegador ni se corrigió en este lote.**
Hace falta comprobar primer fotograma/retirada del overlay e interacción real;
los tests de fuente no lo certifican. Se conserva el código publicado sin
añadir otro cambio de F7 a #561 ni proclamar funcionalidad del visor.

## 7. Checklist de aceptación

- ✅ Base #571 preservada, scripts/hash UI combinados y pruebas generales.
- ✅ Seis contratos nuevos sin dobles fuera del SDK ni cambios de runtime.
- ✅ 351 unitarias y medición íntegra; 173 nativas; tipos y lint sin regresión.
- ❌ Cobertura ≥80%, retención del diff, goldens/carga y E2E documental real.
- ❌ Aislamiento/almacenamiento/configuración y límite de gasto acreditados.
- ❌ Migración/recovery ensayados y procedimiento de publicación revisado.
- ❌ Merge a producción, activación y edición/descarga pública de #561.

## 8. Pendientes para la siguiente fase

Continuar F1 y su seguimiento; no iniciar F2 ni anunciar producción. Completar
los controles internos y externos pendientes, verificar el nuevo CI y preservar
la versión viva antes de integrar por la vía normal. Corroborar la UI real sin
confundir tests de fuente con render/interacción. Avisar como publicación sólo
tras SHA público que contenga #561, API saludable y edición/descarga auténtica.

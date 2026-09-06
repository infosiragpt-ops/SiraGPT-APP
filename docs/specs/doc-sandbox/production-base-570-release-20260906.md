# F1 — integración con la producción #570

2026-09-06 UTC. **#561 no desplegada; no cierra F1.** Luis autorizó publicar y
solicitó aviso al comprobar producción. Se conserva Lenovo + Cloudflare, sin
trasladar alojamiento ni editar DNS.

## 1. Qué se implementó

Se integró `production-main` `845e0c48128634179b60e3dd67622412d2b42a52`
(#570) sobre el HEAD documental `e4d94d8df2736b968ae6287b7d72600a316d467b`,
mediante merge sin reescritura del historial.

- Los diez archivos de fuente, tests y documentación de #570 quedan idénticos
  a producción. Se preservan reintentos seguros, cancelación y dispatcher.
- `backend/package.json` une la ampliación de `test:openclaw-native` con todos
  los scripts y dependencias F1; una comparación JSON comprobó que sólo cambió
  ese script frente al HEAD documental.
- No cambian módulo, validador, SQL, pruebas F1, frontend ni lockfiles.
- Se actualiza el checkpoint. No se añaden funciones documentales nuevas.

## 2. Cómo se probó

Node 24.19.0, desde la raíz, con `PATH=/Users/luis/.local/node/bin:$PATH`:

```text
git merge --no-ff --no-commit origin/production-main
Automatic merge went well; stopped before committing as requested
npm --prefix backend run test:openclaw-native
173/173; fail 0; skipped 0; duration_ms 12812.176083; exit 0
npm --prefix backend run test:doc-sandbox:coverage
343/343; fail 0; skipped 0; duration_ms 1551.186375
Lines/Statements 72.73% (2593/3565)
Branches 86.62% (1127/1301); Functions 75.07% (259/345)
exit 1: Coverage for lines (72.73%) does not meet global threshold (80%)
node node_modules/typescript/bin/tsc -p tests/tsconfig.json
exit 0
NODE_ENV=test node --require ./tests/register-ts-paths.cjs --test --test-reporter=spec --test-reporter-destination=output/phase1-merge570-root-tests-node24.log '.test-dist/tests/**/*.test.js'
12467/12467; suites 534; fail 0; skipped 0; duration_ms 61674.753625; exit 0
npm run type-check
exit 0
npm --prefix backend run type-check:doc-sandbox
exit 0
npm run lint
exit 0; 48 advertencias heredadas
bash scripts/verify-ui-lock.sh
UI lock verified — zero changes to frontend files; exit 0
git diff --cached --check
exit 0
```

La primera ejecución de cobertura sin permiso de escucha falló con seis
`listen EPERM` en HTTP loopback: 311/317 y 68,63 %. No es una regresión ni la
métrica de aceptación. Se repitió **sin cambios de código** con autorización
para servidores temporales `127.0.0.1`; los resultados de arriba son esa
segunda ejecución, todavía bloqueada por el 80 %. No se omitieron pruebas.
Logs privados `output/phase1-merge570-*`.
Escaneo de secretos explícito sobre los trece archivos del lote: exit 0.

```text
/Users/luis/.local/node/bin/node output/phase1-reference-retention-local.cjs
52/52; skipped 0; ok true; cleanupErrors []; servicesStopped true; exit 0
```

Evidencia privada de la rama combinada:
`/private/tmp/siragpt-phase1-reference-retention-K8GHj6/tests.tap` y
`result.json`. PostgreSQL 17.10 y Redis 7.2.10 sintéticos locales; todos los
procesos temporales terminados con exit 0. No son producción PG16 ni jobs
documentales completos; las 52 integraciones no cuentan en cobertura unitaria.

## 3. Evidencia de validación

CI anterior **34047889710**, HEAD exacto `e4d94d8df`: paso documental del job
**101526126270** aprobado. Persistencia 44/44 (incluye tres casos de retención de referencias)
y recuperación 8/8: 52/52 reales, sin omisiones. Limpieza aprobada. Única causa
de fallo: cobertura 72,73 % y su agregador. No es CI del merge nuevo.

No se generaron cinco jobs documentales reales ni se acreditó edición con
Anthropic/runsc. Gasto nuevo **US$0**, ningún secreto impreso.

## 4. Decisiones tomadas

Preservar #570 que ya está publicado, no reemplazarlo por la base antigua.
Comparación de blobs y revisión independiente sin conflictos de integración.
La guarda del scheduler es por proceso, no se presenta como lease distribuido.

## 5. Desviaciones respecto a la especificación

No hay cierre ni aceptación completa. El 80 %, runtime, almacenamiento,
migración y prueba auténtica siguen pendientes. Las pruebas nativas añadidas
por producción no se suman al porcentaje unitario F1.

## 6. Limitaciones conocidas y riesgos

Preflight de sólo lectura: checkout Lenovo limpio y endpoint público coinciden
en `845e0c48128634179b60e3dd67622412d2b42a52`. Readiness saludable
**2026-09-06T21:33:48.951Z**. Esa publicación pertenece a #570, no a #561.

SSH por Cloudflare funciona, pero entra al contenedor deploy. Sólo runc está
registrado; faltan runsc y las variables R2/F1 en el backend (consulta booleana,
sin valores). No se modificó infraestructura, base, secretos, DNS o servicios.

El publicador sin migraciones no admite F1; el ensayo de historial y recuperación
sigue abierto. No desactivar controles ni activar primero el nuevo frontend.
La reversión debe conservar ledger, tablas, objetos y reconciliación.

## 7. Checklist de aceptación

- ✅ Producción actual preservada e integrada sin conflictos.
- ✅ 173 nativas, 343 unitarias, 12467 generales y 52 integraciones locales.
- ✅ Tipos, UI-lock y lint sin regresiones nuevas; evidencia CI anterior revisada.
- ❌ 80 %, aceptación documental, runtime/storage y ensayo migratorio completos.
- ❌ Merge de #561 a producción, publicación y descarga documental real.

## 8. Pendientes para la siguiente fase

Continuar F1, no F2. Revisar CI del merge, completar controles internos y
prerrequisitos externos con acceso administrativo legítimo y sin reinicios.
Volver a consultar SHA y salud antes de publicar; nunca reutilizar un baseline
antiguo ni declarar que #561 está en producción por una actualización ajena.

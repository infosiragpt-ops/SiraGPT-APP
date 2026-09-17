# F1 — cobertura unitaria estricta ≥81 %

2026-09-07 UTC. Objetivo solicitado por Luis: alcanzar al menos 81 %.
**No es un despliegue ni un cierre de aceptación de F1.**

## Alcance y procedencia

Base de trabajo `40f86de4ea8f793526649076e09d22dec41e2a6f`.
Se incorporó sin sobrescribir trabajo ajeno la corrección concurrente
`cd2e6501c3c746c058bd449779ce0f934273f6d2` (revalidar reloj tras leer manifiesto).
La versión medida incluye esa corrección. Después se integró sin conflictos
`546a8156b2ec63c468157a4125aebcb4705f80db` (#572); sin cambios F1 adicionales.

Se separaron responsabilidades ya existentes, manteniendo sus sitios de IO:

- Admisión HTTP, headers, proyecciones y política de catálogo.
- Decisiones de publicación, cuotas, presupuesto, ownership y retención.
- Clasificación de respuestas, errores y consumo del processor.
- Cancelación/deadline, sondas y bucles con propiedad explícita de operaciones.
- Codec del protocolo de artefactos, después de ejecutar el contenedor real.
- Confirmación por lotes de cleanup, después de eliminar cada objeto.

Las transacciones, locks, fences, outbox, validación independiente y orden de
persistencia permanecen en sus adaptadores. El reloj local de finalización de
cleanup se captura una vez por decisión; esto sólo puede retener marginalmente
más, nunca adelantar una eliminación. No se cambiaron UI, esquema, dependencias,
credenciales ni configuración productiva.

## Medición reproducible

Node 24.19.0, desde la raíz:

```sh
PATH=/Users/luis/.local/node/bin:$PATH npm --prefix backend run test:doc-sandbox:coverage
```

```text
483 tests; 483 pass; 0 fail; 0 skipped
Lines / Statements: 81.02% (3390/4184)
Branches: 89.76% (1719/1915)
Functions: 71.66% (344/480)
exit 0, gate de líneas 81%
```

Base histórica: 72,39 % (2749/3797), 377 pruebas. La población de fuentes
**no se redujo**: se conserva `--all --src src/modules/doc-sandbox` y
`--include 'src/modules/doc-sandbox/**/*.ts'`, incluidos archivos de tipos.
Los nuevos módulos amplían el denominador. Ninguna integración, auxiliar,
mock de Prisma/Redis/S3 ni ejecución simulada del validador entra en esta métrica.
Los SDK de proveedor conservan los dobles ya permitidos por la especificación.

Las nuevas pruebas usan decisiones puras, bytes reales, timers, AbortSignals,
EventEmitter y filesystem real. Los tests de arranque activan el constructor
real y rechazan staging no privado/inexistente antes de contactar servicios;
no acreditan readiness ni una ejecución válida del contenedor.

El comando, el step obligatorio de GitHub Actions y su contrato elevan el gate
80→81; no se omite el fallo ni se mezclan reportes de integración.
Logs y JSON local: `output/phase1-unit81-coverage.log`,
`output/phase1-unit81-coverage-summary.json`.

## Verificación y límites

- Generales: 12472/12472, 535 suites, cero omitidas; exit 0.
- TypeScript raíz/módulo/nuevos tests, lint y UI-lock: aprobados.
- Contratos CI: 7/7.
- Revisión independiente cruzada de runtime/pruebas: sin bloqueantes.
- La prueba Redis local no arrancó por `DOC_TEST_REDIS_BINARY_UNAVAILABLE`;
  no se cuenta como aprobada. La corroboración de servicios Linux/CI se registra
  separadamente y nunca modifica el numerador unitario.
- PostgreSQL/Redis/S3 reales en Lenovo: **79/79**, cero fallos/omisiones,
  150119,997345 ms. Runner aislado Node22, imagen fijada
  `sha256:40f438311ab39713e617fc96b6dcbf5bdc62bf5141ddca954f739386da64176e`,
  red interna, read-only, sin socket Docker ni credenciales productivas.
  Este ensayo usó snapshot anterior a `cd2e6501c`; las políticas/adapter de
  HTTP, persistencia, processor y cleanup probados son idénticos a la candidata.
  No ejercita el cambio posterior de reloj del manifiesto.
- Snapshot posterior a `cd2e6501c` y merge #572, Linux real: **116/116**
  (56 filesystem/codec/oráculos,16 corpus,2 herramientas y42 validador).
  Mismo runner fijado, sin red ni socket Docker. Exit0. No acredita gVisor.
- Postmerge: **362/362** pruebas OpenClaw Native;32/32 archivos ajenos a
  package.json de #572 byte-idénticos a producción; scripts generales,
  dependencias y lockfiles preservados. Las483 unitarias repitieron81,02 %.
- CI remoto de la candidata está en cola (sin resultado aún), no se declara
  aprobado. El CI exigirá81 % en la misma población de fuentes.
- Los tres servicios de test quedaron detenidos, sin puertos publicados.
  El origen sigue en #572 (`546a8156b`), no #561; API responde HTTP200,
  health reporta `degraded`. No se modificó el origen en esta tarea.

Sin llamadas pagadas, publicación, reinicios de producción ni cambios de DNS.
El objetivo unitario no acredita gVisor real, R2 productivo, límite efectivo del
proveedor, aceptación documental, migración/recuperación o descarga autenticada.
Los controles pendientes del checkpoint siguen vigentes.

## Corroboración independiente del HEAD `3b41fbb3` y unión de historiales

2026-09-07 UTC. El trabajo concurrente de `cd2e6501c` + #572 quedó conservado
en el merge local `56d3626a36ad118a36ec13d56207c9cd0ec731bd`, sin publicarlo
por encima del nuevo HEAD. A continuación se incorporó `3b41fbb3` por merge
normal: único conflicto en el checkpoint, resuelto conservando ambos registros.
No se reescribe historia compartida ni se cambia el runtime remoto al unirlos.

Dos revisiones estáticas independientes no encontraron bloqueantes P1/P2:
una examinó las extracciones, su wiring y las pruebas nuevas; otra revisó
transacciones, leases, cancelación, validación y limpieza. Se verificaron las
fuentes completas de c8, el endurecimiento 80→81 y la ausencia de exclusiones,
pruebas retiradas o simulación de persistencia/validación exitosa en la métrica.
La extracción sí modifica runtime F1; la constancia «F1 intacto» del informe
`production-base-572-release-20260907.md` es exclusivamente histórica.

Repetición en Mac Node 24.19.0 sobre código byte-idéntico a `3b41fbb3`:

```text
npm --prefix backend run test:doc-sandbox:coverage
483/483; 0 fail/skip; 2413.3155 ms; exit 0
Lines/Statements 81.02% (3390/4184)
Branches 89.76% (1719/1915); Functions 71.66% (344/480)
node node_modules/typescript/bin/tsc -p tests/tsconfig.json
NODE_ENV=test node --require ./tests/register-ts-paths.cjs --test --test-reporter=spec --test-reporter-destination=output/phase1-concurrent-review-root-tests.log '.test-dist/tests/**/*.test.js'
12472/12472; 535 suites; 0 fail/skip; 64103.314417 ms; exit 0
```

Tipos raíz/módulo y UI-lock: exit 0. Lint: exit 0 con 48 advertencias
heredadas. Logs ignorados `output/phase1-concurrent-review-unit-coverage.log`,
`-root-tests.log` y `-lint.log` (mismo prefijo). No se repitieron servicios
Linux ni proveedor en esta corroboración; no se suman sus cifras a cobertura.

CI remoto **`34079904503` aprobado**, HEAD exacto
`3b41fbb3a302a34863a3759d12f2c9f22dd40c3e`, actualizado a
**2026-09-07T03:46:20Z**. Esta aprobación no se atribuye por anticipado al
commit posterior que conserve la documentación; ese HEAD requiere su CI.

El log filtrado del backend `101614320254` corrobora el step 25 obligatorio:
483/483, cero omisiones, líneas 81,02% (3390/4184), mismas ramas/funciones,
10908,521278 ms. Los grupos separados también pasan sin omisiones: guardas
migratorias 17, auxiliares 16, runtime 53, persistencia PG 45, recuperación 8,
documentos 16, herramientas del validador 2, readiness Redis 5, HTTP/storage
34 y retención 10. No sumar esos grupos a cobertura ni confundir guardas
migratorias con un ensayo de migración/recuperación productiva.
La suite general del shard registra 7101 aprobadas y 5 omisiones de 7106,
las mismas que el CI padre; conserva además el aviso de aserción heap SSE
no ejecutada sin `--expose-gc`. No se presenta como aceptación completa ni
se cambian esos controles para obtener este resultado.

Consulta pública a **2026-09-07T03:49:48Z**: versión
`546a8156b2ec63c468157a4125aebcb4705f80db` (#572) y readiness HTTP 200
`healthy`. No es #561. No se han cambiado producción, DNS ni servicios.
Gasto nuevo US$0. No se reinician autenticación ni instalaciones ante los
mismos requisitos privados/administrativos pendientes. No publicar con el
procedimiento antiguo ni tratar CI aprobado como aceptación documental.

# F1 — cobertura unitaria estricta ≥81 %

2026-09-07 UTC. Objetivo solicitado por Luis: alcanzar al menos 81 %.
**No es un despliegue ni un cierre de aceptación de F1.**

## Alcance y procedencia

Base de trabajo `40f86de4ea8f793526649076e09d22dec41e2a6f`.
Se incorporó sin sobrescribir trabajo ajeno la corrección concurrente
`cd2e6501c3c746c058bd449779ce0f934273f6d2` (revalidar reloj tras leer manifiesto).
La versión medida incluye esa corrección.

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
- Aún pendiente el CI del nuevo commit y corroboración final de integración.

Sin llamadas pagadas, publicación, reinicios de producción ni cambios de DNS.
El objetivo unitario no acredita gVisor real, R2 productivo, límite efectivo del
proveedor, aceptación documental, migración/recuperación o descarga autenticada.
Los controles pendientes del checkpoint siguen vigentes.

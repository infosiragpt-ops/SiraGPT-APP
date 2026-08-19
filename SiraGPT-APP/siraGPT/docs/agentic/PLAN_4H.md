# Agentic Core 4H Plan

Fecha: 2026-04-26
Rama: `feat/agentic-core-4h`

## Alcance

Este sprint endurece el nucleo interno de SiraGPT sin tocar la interfaz visual. El repositorio ya contiene capas agenticas amplias: `sira/*`, `agent-runtime/*`, `ai-product-os/*`, RAG, tool registry, validators, storage y document pipelines. El cambio elegido para este bloque es agregar contabilidad auditable de tokens por turno porque conecta directamente con produccion: control de coste, limites por usuario, observabilidad, reporting admin y presupuesto por tarea.

Segunda pasada: convertir la contabilidad en una politica preflight de presupuesto para bloquear solicitudes que excedan limites por plan, turno, conversacion o dia antes de gastar runtime/herramientas.

Tercera pasada: convertir los hechos del runtime en un `execution_trace_frame` seguro para observabilidad, debugging y reporte admin sin registrar texto crudo ni payloads de herramientas.

## Hitos

### Hito 1 - Inspeccion y documentacion

Criterio de aceptacion:

- Se identifica rama, estado del arbol, scripts de validacion y puntos de integracion.
- Se documentan plan, estado y decisiones en `docs/agentic`.

Validacion:

- `git status --short`
- `node -e "const p=require('./package.json'); console.log(JSON.stringify(p.scripts,null,2))"`

### Hito 2 - Token Usage Frame

Criterio de aceptacion:

- Existe un modulo interno sin dependencias para estimar y normalizar uso de tokens.
- El frame no guarda texto crudo del usuario ni contenido bruto de adjuntos.
- El frame agrupa por usuario, conversacion, modelo y tarea.
- Incluye ledger en memoria para pruebas y futuros reportes.

Validacion:

- `npm test -- --test-name-pattern="sira token ledger"`

### Hito 3 - Integracion en Chat Controller

Criterio de aceptacion:

- Cada turno completado genera `token_usage_frame`.
- El uso se audita como `token_usage_recorded`.
- El resultado devuelto por el backend incluye `token_usage` y resumen tecnico.
- La ruta de aclaracion tambien queda contabilizada.

Validacion:

- `npm test -- --test-name-pattern="sira chat controller token accounting"`

### Hito 4 - Validaciones completas

Criterio de aceptacion:

- Tests automatizados pasan.
- Build no falla por los cambios del sprint.
- Si el servidor local esta disponible, se ejecuta smoke browser en `/chat` sin modificar UI.

Validacion:

- `npm test`
- `npm run build`
- `npm run lint`

### Hito 5 - Token Budget Preflight

Criterio de aceptacion:

- Existe una politica determinista de presupuesto por plan.
- El controlador de chat evalua presupuesto antes de ejecutar engine/runtime.
- Si una solicitud excede el presupuesto, se persiste el mensaje del usuario, se responde con bloqueo controlado y se audita `turn_blocked_token_budget`.
- El modo `observe` permite medir sin bloquear.

Validacion:

- `rm -rf .test-dist && node ./node_modules/typescript/bin/tsc -p tests/tsconfig.json && node --test --test-name-pattern="token budget" .test-dist/tests/sira-token-budget-policy.test.js`

### Hito 6 - Execution Trace Frame

Criterio de aceptacion:

- El runtime emite un `execution_trace_frame` por workflow.
- El frame contiene timeline, estado por nodo, estado por herramienta, intentos, retries, duracion y contadores.
- El frame no registra texto del usuario, contenido de adjuntos, inputs crudos ni outputs crudos de herramientas.
- El controlador de chat audita un resumen `execution_trace_recorded` sin acoplar UI.

Validacion:

- `rm -rf .test-dist && node ./node_modules/typescript/bin/tsc -p tests/tsconfig.json && node --test --test-name-pattern="execution trace" .test-dist/tests/sira-execution-trace-frame.test.js`

## Fuera de alcance

- Redisenar UI.
- Cambiar chat input, sidebar, tema, colores o layout.
- Conectar servicios externos sin credenciales.
- Migrar base de datos en este sprint.
- Reemplazar el runtime actual por otra libreria completa.

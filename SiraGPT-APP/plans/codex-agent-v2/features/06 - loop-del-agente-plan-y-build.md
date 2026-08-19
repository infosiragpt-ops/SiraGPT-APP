# Feature 06 — Loop del agente: plan y build

**Fase:** F2 · **Depende de:** 02, 04, 05 · **Spec:** `docs/codex-agent-ux.md` §2.1, §7

## Descripción

El cerebro de la corrida, ejecutado dentro del job: en modo `plan` produce el plan estructurado aprobable; en modo `build` itera LLM ↔ herramientas contra el workspace del runner, emitiendo narrativa en primera persona (español), bloques de razonamiento y acciones agrupadas. Reutiliza los clientes de proveedor existentes y la escalera `prompted-tool-calling` (`backend/src/services/agents/prompted-tool-calling.js`) para que **cualquier modelo** pueda correr el loop.

## Requisitos

1. **Plan primero, siempre:** la primera corrida de un proyecto es `mode: plan`. El LLM produce `{ architecture, pages[], components[], tasks[] }` (parse tolerante a fences estilo `builder/llm.js extractJson`; fallo de parse → reintento 1 vez → `error`). Se emite `plan_proposed` y la corrida queda `waiting_approval`. La aprobación es `POST /api/codex/runs { mode: 'build', planRunId }` (feature 05); el ajuste es otra corrida `plan` con el feedback del usuario + plan anterior en contexto.
2. **Toggle Plan:** una corrida `plan` JAMÁS ejecuta herramientas que muten (sin write/exec); solo lectura de contexto.
3. **Herramientas del build** (vía `runner-client`, feature 02): `run_command` (allowlist del runner), `read_file` (cuenta `linesRead`), `write_file`, `edit_file` (read → reemplazo exacto → write), `web_search` (adapter existente `agents/web-search`). Cada tool call emite `action_start`/`action_end` (con `groupId` por ráfaga consecutiva para los chips "N actions") y persiste su `CodexAction`.
4. **Canales de salida del modelo:** texto streaming → `narrative_delta`; razonamiento (nativo si el provider lo da, o prompted) → `reasoning_start/delta/end` con `label` y duración real; tool calls → acciones. System prompt en español, primera persona, con el plan aprobado y el árbol de archivos del workspace como contexto.
5. **Presupuestos:** `CODEX_MAX_STEPS` (default 24) y cap de herramientas por turno; al agotarse → cierre ordenado con resumen honesto (no error). Señal de cancelación (feature 05) consultada entre pasos.
6. **Errores de herramienta no abortan:** `action_end status: error` + el error entra al contexto del siguiente paso del LLM (el agente puede corregir). Solo errores del transporte LLM agotando reintentos → corrida `error` (pasando por el clasificador de la feature 09).
7. **Selección de modelo:** del `tier` de la corrida (mapeo Power → catálogo, feature 12) o `model` explícito; resolución de proveedor con `provider-inference` existente. Cada llamada acumula usage para la feature 08.

## Pasos técnicos

1. `codex/agent-loop.js`: función `runAgentLoop({ run, project, deps })` con TODAS las dependencias inyectables (llmClient, runnerClient, eventStore, actionStore, clock) — TDD con LLM falso guionizado.
2. `codex/plan-mode.js`: prompt de plan + parser + validación de shape (TDD: fences, prosa, JSON inválido, reintento).
3. `codex/build-tools.js`: definición de las 5 herramientas (schema + execute sobre runner-client) con proyección al registry de `prompted-tool-calling` (TDD por herramienta: éxito, fallo, conteo de líneas).
4. Integración con el handler del job (feature 05) y emisión de eventos en cada paso.
5. Tests de guion completo: plan → waiting_approval; build con 2 tool calls agrupadas + narrativa → done; cancelación a mitad; presupuesto agotado.
6. Gates + commits + push.

## Criterios de aceptación

- [ ] Proyecto nuevo: la primera corrida siempre termina en `plan_proposed` + `waiting_approval` (nunca ejecuta build directo).
- [ ] Corrida `plan` con guion malicioso (tool call en la respuesta) no ejecuta ninguna herramienta mutante.
- [ ] Build con LLM falso: archivos escritos en el runner falso, acciones con `groupId` correcto, narrativa y razonamiento en orden de seq.
- [ ] Error de una herramienta → `action_end error` y el loop continúa; el LLM recibe el error en contexto.
- [ ] Cancelación y presupuesto agotado cierran ordenadamente (estado correcto + eventos finales).
- [ ] Funciona en modo `prompted` (modelo sin tool-calling nativo) — test con transcript provider-safe.
- [ ] Suite completa + lint + CI verdes.

# Auditoría del Codex Agent SDK / APPS — Ronda 2 (gaps nuevos)

**Fecha:** 2026-07-03 · **Base auditada:** worktree `prod-main` de `SiraGPT-APP` (`e0ff6d1ee`)
**Método:** lectura a fondo del código ACTUAL (no de reportes viejos), solo lectura.
**Antecedentes:** [apps-code-audit.md](apps-code-audit.md) (ronda 1, top-10 ya resueltos) ·
[coding-agents-report.md](coding-agents-report.md) (estado del arte: Claude Code / Cursor / Codex).

> **Alcance.** La ronda 1 + las ~13 tandas de hoy cerraron los gaps de infraestructura del loop
> (motor Claude por tiers, verify tsc + runtime opcional, grep/list/read-offset/edit-replaceAll,
> subagentes que heredan el tier, anti-bucle, recuperación de truncado, runner multi-proyecto,
> cancelación real, sync workspace→Codex). Este reporte NO los re-lista. Busca la **siguiente**
> capa de valor: calidad del plan, gestión de contexto en runs largos, calidad de las ediciones,
> paralelismo, errores de build reales, observabilidad/coste y bugs concretos.

---

## (a) Evaluación del estado actual vs Claude Code, por categoría

### 1. Calidad del plan (plan-mode) — **el gap más grande que queda**
El `plan-mode.js` produce un JSON `{ architecture, pages[], components[], tasks[] }` decente y lo
persiste como evento `plan_proposed`. Pero:

- **No hay `update_plan`/`TodoWrite`.** El plan se inyecta UNA vez en el system prompt
  (`agent-loop.js:216-219`) y **nunca se vuelve a tocar**. El modelo no marca tareas hechas, no
  re-planifica, no añade tareas descubiertas. Claude Code y Codex tienen exactamente esto
  (`TodoWrite` / `update_plan`) como checklist viva re-inyectada — es una de las 7 convergencias
  del género (reporte §5). Su ausencia se nota en runs de 24 pasos: el modelo pierde el hilo del
  plan a mitad de camino y el anti-thrash tiene que empujarlo manualmente ("avanza al siguiente
  paso") con heurísticas de reescritura, en vez de con un plan vivo.
- **El checklist de la UI es de mentira.** `components/codex/checklist-tab.tsx:3-4` lo admite en un
  comentario: *"coarse per-run status … Fine-grained per-task completion is noted as a future
  iteration."* `statusFor()` (líneas 35-39) marca la tarea 0 como `in_progress` y TODAS como `done`
  cuando el run termina — sin relación con lo que el agente realmente hizo. Es teatro de plan, la
  misma clase de problema que el "rail de fases teatral" de la ronda 1 (#10), pero en el checklist.
- **Re-planificación = código muerto.** `plan-mode.js` acepta `priorPlan` y `feedback` (líneas
  17, 41-42, 93-94) para ajustar un plan, pero **ningún caller los pasa**: ni `run-processor.js`,
  ni `run-service.js`, ni la ruta. No existe endpoint para refinar un plan. El usuario solo puede
  aprobar tal cual o empezar de cero. Claude Code / Cursor / Codex permiten iterar el plan antes de
  ejecutar (plan mode editable).

**Veredicto:** funcional pero estático. Claude Code/Codex son claramente mejores aquí (plan vivo +
re-planificación). Es el gap de mayor valor no tocado.

### 2. Gestión de contexto en runs largos — **aceptable, con una fuga de coste**
- `compactMessages` (`agent-loop.js:234-248`) hace microcompact real de `[TOOL_RESULT]` viejos
  (conserva system + prompt + últimos 10). Es la capa 1 de Claude Code y está bien.
- **Falta la capa 2** (resumen semántico al ~70% del contexto que preserve objetivo/archivos/
  decisiones/errores pendientes). Para apps pequeñas de /code rara vez importa; para el pilar
  enterprise (repos grandes) sí. Prioridad baja hoy.
- **No hay dedupe de re-lecturas.** El anti-thrash cubre WRITES (`agent-loop.js:636-656`) pero no
  READS: el modelo puede releer el mismo archivo N veces y cada lectura re-entra al transcript. El
  microcompact lo mitiga a posteriori pero no evita el gasto de tokens de salida en el re-read.
- **No hay `cache_control` (prompt caching).** `anthropic-turn.js:120-131` arma el request SIN
  `cache_control: {type:'ephemeral'}` en el system prompt ni en el prefijo estable de tools. Con
  24 pasos por run y un system prompt de ~2-3KB + tools, se está re-facturando el prefijo íntegro
  en cada step a precio de input completo. El SDK de Claude Code cachea esto automáticamente
  (~0.1× en cache-reads → ahorro de ~10× en el prefijo). Es dinero real perdido en cada run pago.

**Veredicto:** la compactación básica está; el **prompt caching ausente es la fuga concreta**.

### 3. Calidad de las ediciones — **sólida para el formato Claude, sin apply_patch multi-hunk**
- `edit_file` (`build-tools.js:210-238`) es str_replace exacto con conteo de ocurrencias y
  `replaceAll` — el patrón correcto para Claude (reporte §1.3). Bien.
- **Falta el invariante read-before-edit / staleness.** Claude Code rechaza un edit si el archivo
  no se leyó en la conversación o cambió en disco desde la última lectura (reporte §1.3, "lo que
  hace los edits confiables"). Aquí `edit_file` no verifica que el modelo haya leído el archivo ni
  que no haya cambiado; solo comprueba que `find` exista. En este harness single-tenant el riesgo
  de cambio externo es bajo, así que es P2.
- **Una sola edición por llamada.** No hay multi-edit (varios find/replace en un archivo en una
  llamada) ni `apply_patch` estilo V4A (multi-hunk, multi-archivo). Para el motor Claude, str_replace
  1-a-1 es suficiente; **pero el ladder también sirve modelos GPT vía OpenRouter**
  (`llm-provider.js:21` default `anthropic/claude-sonnet-4.6`, y `CODEX_OPENROUTER_MODEL` puede ser
  un GPT), y esos rinden mejor con V4A (reporte §3.2/§5, documentado por Warp). Hoy no hay dimensión
  "dialecto de edición por familia". P2 salvo que se sirvan GPT en serio.

**Veredicto:** correcto para el camino principal (Claude). Los faltantes son de robustez (staleness)
y multi-modelo (V4A), no de corrección.

### 4. Paralelismo y subagentes — **bien diseñado, infrautilizado**
- Delegación paralela real: un turno de solo-`run_subagent` corre con `Promise.all`
  (`agent-loop.js:668-674`); el seq-gate hace seguros los appends. Los subagentes heredan el tier
  (`agent-sdk/index.js:238`, `build-tools.js:351`). Custom agents por `.sira/agents.json` con
  validación estricta. Todo esto es de buena factura.
- **Subagentes sin herramienta de exploración barata dedicada.** El reporte §P1.6 sugiere un
  `explorer` con solo read/grep/glob en modelo barato para "analiza y dime cómo añadir X". El
  `planner` se le acerca pero mezcla propósitos. Menor.
- **El contexto entre subagente y padre es solo el informe final** (correcto, es el patrón), pero
  **no comparten el plan vivo** (que no existe, ver #1). Si existiera un `update_plan`, un subagente
  podría marcar su tarea — hoy no.

**Veredicto:** arquitectura al nivel del estado del arte; el cuello es que sin plan vivo (#1) la
delegación no se coordina contra un objetivo compartido.

### 5. Manejo de errores del build real — **tsc sí, dependencias/imports parcial**
- `verifyWorkspace` corre `bun install` + `tsc --noEmit` y realimenta errores (`agent-loop.js:335-393`);
  `verify-loop.js` hace el self-heal acotado. `dev_server_check` captura errores de runtime (module
  not found, overlay de Vite) cuando el flag `CODEX_VERIFY_DEV_SERVER=1` está ON.
- **Pero el runtime check está OFF por defecto** (`agent-loop.js:265`). Es decir: en producción,
  el cierre del build verifica **solo tipos**, no que la app arranque. Un `import` a un paquete no
  declarado en `package.json` que tsc no detecte (p.ej. import dinámico, o dep transitiva que
  Vite resuelve distinto) pasa la verificación y llega roto al preview. El reporte §P0.2 pone
  "capturar stderr del dev server" como P0. Está implementado pero **desactivado**.
- **No hay verificación de `bun run build`** (build de producción), solo dev. Un proyecto que corre
  en dev pero rompe en `vite build` (imports case-sensitive, tree-shaking) no se detecta.

**Veredicto:** el andamiaje existe pero la verificación runtime — la que atrapa los errores que tsc
no ve — está apagada. Activarla (o subir su robustez) es alto valor / bajo riesgo.

### 6. Observabilidad / coste — **muy buena, con un sesgo**
- `run-metrics.js` + `cost-resolver.js` son excelentes: coste por llamada con `costSource` explícito
  (provider_exact / openrouter_generation / estimated), split input/output, multiplicador por plan,
  `run_summary` con additions/deletions/tokens. Timeline SSE tipado con seq, replay sin pérdidas.
  Esto está al nivel de Codex.
- **Sesgo de coste: el prefijo cacheable se cobra como input full** (ver #2, sin `cache_control`).
  El `cost-resolver` calcula bien lo que Anthropic factura, pero Anthropic factura de más porque no
  marcamos cache. El coste es *transparente* pero *inflado*.
- El usuario ve bien qué hace el agente (AgentTrace, action chips, checkpoint card). Buena UX.

### 7. Bugs reales encontrados leyendo
- **[Menor] `describeActiveProvider` miente cuando hay tier Anthropic.** `/api/codex/agents`
  reporta el LLM vía `llm-provider.describeActiveProvider()` (`codex.js:219`), que devuelve el
  primer rung del *ladder* (Anthropic si `ANTHROPIC_API_KEY` está, si no OpenRouter/Cerebras). Pero
  el camino real de un run pago NO usa el ladder: usa `anthropic-turn` (native tool use) elegido por
  `resolveTurnEngine`, y el ladder solo se toca en degradación. Para un run **eco** el motor real es
  Cerebras directo (`llm-turn.js:145`), pero `describeActiveProvider` diría "anthropic" si la key
  está configurada. El catálogo puede reportar un proveedor que ese run no usó. Cosmético, pero
  engañoso para observabilidad.
- **[Menor] Fuga de dev server en `dev_server_check` (tool).** El tool `dev_server_check`
  (`build-tools.js:287-325`) arranca el dev server si no corre, pero — a diferencia de
  `verifyDevServer` en el loop (`agent-loop.js:291,311`) — **nunca lo para**. Si el modelo lo invoca
  varias veces sobre proyectos distintos en un runner con pool limitado, deja servers colgados
  ocupando slots hasta el reaper idle. `verifyDevServer` sí limpia; el tool no.
- **[Menor] Checklist UI desincronizado (ver #1)** — no es crash, pero muestra estado falso al
  usuario (tarea 0 "in_progress", todo "done" al terminar) sin correlación con la realidad.
- **[Informativo] `node -e` en el allowlist de `run_command`** (ya notado ronda 1 §3.2): ejecución
  arbitraria dentro del contenedor. El purge de Next lo usa a propósito (`agent-loop.js:761`). El
  límite de seguridad sigue siendo el contenedor; no es regresión, pero conviene no ampliar su uso.
- **No se encontraron** carreras de estado terminal (el `updateMany` guardado en run-processor/
  run-service está correcto), ni injection en git (SHA_RE + argv), ni doble-emit de run_status.
  Esa capa está bien blindada.

---

## (b) Tabla de gaps NUEVOS priorizados

| # | Prioridad | Gap | Archivo:línea | Valor | Riesgo de impl. | Técnica del estado del arte |
|---|-----------|-----|---------------|-------|-----------------|------------------------------|
| G1 | **P0** | **Sin `update_plan`/TodoWrite: plan estático, checklist falso** | `agent-loop.js:216-219`, `build-tools.js` (no existe tool), `checklist-tab.tsx:3-4,35-39` | Alto — coordina runs largos, hace real el checklist, ancla la delegación | **Medio** — nueva tool + evento `plan_updated` + reducer + re-inyección cada N pasos; tocar UI (regla #1 levantada para /code) | TodoWrite (Claude Code §1.6) · `update_plan` (Codex §3.6) |
| G2 | **P0** | **Verificación runtime del build APAGADA por defecto** (solo tsc corre en prod) | `agent-loop.js:265` (`CODEX_VERIFY_DEV_SERVER ?? '0'`) | Alto — atrapa imports rotos/deps sin declarar que tsc no ve y hoy llegan al preview | **Bajo** — flip de flag + endurecer el "no arrancó ≠ error" ya implementado; el código existe y está testeado | Verificación = correr y leer errores en el loop (Claude Code §1.5, Codex §3.5) |
| G3 | **P1** | **Sin `cache_control` en el request Anthropic → prefijo re-facturado ×24 pasos** | `anthropic-turn.js:120-131` | Alto (coste) — ~10× de ahorro en el prefijo estable; dinero real por run pago | **Bajo** — añadir `cache_control:{type:'ephemeral'}` al último bloque de system + a `tools`; sin cambio de comportamiento | Prompt caching disciplinado (reporte §P2.5, §4.3) |
| G4 | **P1** | **Re-planificación es código muerto** (`priorPlan`/`feedback` sin caller ni endpoint) | `plan-mode.js:41-42,93-94` vs `run-processor.js`/`run-service.js`/`codex.js` (no lo pasan) | Medio-alto — permite iterar el plan antes de construir en vez de aprobar-o-nada | **Medio** — endpoint `POST /runs/:id/refine-plan` + wiring; la lógica ya existe | Plan mode editable (Cursor §2.5, Claude Code §1.6) |
| G5 | **P1** | **`dev_server_check` (tool) no para el server que arranca → fuga de slots** | `build-tools.js:287-325` (sin `stopDev`) | Medio — evita servers colgados en el runner con pool limitado | **Bajo** — espejar el `stopDev` de `verifyDevServer` (`agent-loop.js:291,311`) cuando el tool lo arrancó | Sandbox/lifecycle disciplinado (Codex §3.3) |
| G6 | **P2** | **`describeActiveProvider` reporta el ladder, no el motor real del run** | `codex.js:219`, `llm-provider.js:197-201` | Bajo — observabilidad honesta en `/api/codex/agents` | **Bajo** — resolver el motor real vía `resolveTurnEngine(tier)` antes del ladder | — (corrección de telemetría) |
| G7 | **P2** | **Sin read-before-edit / staleness en `edit_file`** | `build-tools.js:216-237` | Bajo (single-tenant) — robustez si el tree cambia bajo el agente | **Medio** — trackear hash por archivo leído; rechazar edit stale | str_replace + staleness (Claude Code §1.3) |
| G8 | **P2** | **Sin `AGENTS.md`/dialecto de edición por familia** (V4A para GPT) | `agent-loop.js:191-226`, `llm-turn.js`/`llm-provider.js` | Bajo hoy — relevante si se sirven GPT vía OpenRouter o para el pilar enterprise | **Medio-alto** — parser apply_patch + selección por familia | apply_patch V4A por familia (reporte §5, Warp) |
| G9 | **P2** | **Sin verificación de `bun run build`** (solo dev/tsc) | `verify-loop.js:38-42`, `agent-loop.js:365` | Bajo-medio — atrapa lo que rompe solo en build de prod | **Bajo** — añadir un round opcional de `vite build` tras tsc limpio | Tests reales en el loop (Codex §3.5) |

---

## (c) Recomendación: el ÚNICO gap de mejor relación valor/riesgo

**Atacar G2: activar la verificación runtime del build (encender `CODEX_VERIFY_DEV_SERVER`).**

Razón de la elección sobre G1 (que tiene más valor bruto):

- **Valor alto, concreto y medible.** Hoy, en producción, un build cierra verificando **solo tipos**.
  Todo el andamiaje para arrancar el dev server, leer el stderr real (module-not-found, dep sin
  declarar, overlay de Vite) y realimentarlo al modelo para una ronda de reparación **ya está escrito
  y testeado** (`verifyDevServer` + la rama `kind:'runtime'` del repair loop). Es el error de clase
  "compila pero no arranca" — exactamente lo que tsc no ve y lo que más frustra al usuario cuando
  abre el preview y ve una pantalla rota. Es el P0.2 del reporte del estado del arte, a medio activar.

- **Riesgo mínimo.** No es código nuevo: es un flag + endurecer los casos "no verificado ≠ fallo"
  que el propio módulo ya maneja con cuidado (`agent-loop.js:308-314` degrada honestamente cuando el
  runner no responde, y para el server que arrancó). El contrato "best-effort, nunca convierte un
  build bueno en error" está probado. El único trabajo real de endurecimiento es acotar el timeout
  (60s puede alargar runs) y confirmar que en el runner de prod el `devStatus/startDev/stopDev`
  responde — es un flip observable y reversible.

- **Por qué no G1 primero.** `update_plan`/TodoWrite es el gap de mayor valor teórico, pero es el de
  **mayor riesgo**: tool nueva + tipo de evento nuevo + reducer + re-inyección periódica + UI (aunque
  la regla #1 está levantada para /code). Es un proyecto de varios días que toca 6+ archivos y el
  timeline. Vale la pena, pero **después** de cosechar G2 (bajo riesgo, alto valor, ya construido) y
  G3 (caching, un one-liner de alto ahorro). Orden sugerido: **G2 → G3 → G5 → G1 → G4**.

- **Honestidad.** El sistema NO está "tan sólido que no hay gap que justifique el riesgo": la capa de
  infraestructura sí lo está (blindaje de estado, cancelación, coste, seq-gate — excelente), pero la
  **calidad de la experiencia de agente** (plan vivo, verificación runtime real, caching) tiene
  huecos claros y accionables. G2 es la mejor primera palanca.

---

**Ruta del archivo:** `/Users/luis/Desktop/siraGPT/docs/research/apps-code-audit-round2.md`

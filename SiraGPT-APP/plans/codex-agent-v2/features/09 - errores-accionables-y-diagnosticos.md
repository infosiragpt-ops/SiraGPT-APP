# Feature 09 — Errores accionables y diagnósticos benignos

**Fase:** F3 · **Depende de:** 04, 06 · **Spec:** `docs/codex-agent-ux.md` §8

## Descripción

Cuando algo bloquea la corrida, el usuario ve una tarjeta **"Acción requerida de su parte 🔴"** con el error crudo copiable, qué capacidades quedan bloqueadas y el enlace para remediarlo — no un stack trace mudo. Y cuando el log solo contiene ruido normal de arranque (p. ej. `ECONNREFUSED` durante el boot), el sistema lo explica en vez de alarmar.

## Requisitos

1. **Registro declarativo** (`codex/error-patterns.js`): lista de patrones, cada uno `{ id, severity: 'blocking'|'benign', match(text) → bool, title, blockedCapabilities[], remediationUrl?, explanation }`. Patrones bloqueantes mínimos:
   - `openrouter_402`: `/402/ + /Insufficient credits|insufficient_quota/i` → bloquea "generación con modelos OpenRouter"; remediación `https://openrouter.ai/credits`.
   - `missing_api_key`: `/api key|unauthorized|401/i` en respuestas de proveedor → bloquea el proveedor afectado; remediación a Ajustes.
   - `quota_exhausted`: detección del 402 interno de créditos de siraGPT → remediación a `/api/free-ia/plans` (upgrade).
   - `provision_failed`: `RunnerError` status 0 (runner inalcanzable) → bloquea workspace/preview; remediación: levantar el perfil `opencode` de compose.
   Patrones benignos mínimos: `econnrefused_boot` (`ECONNREFUSED` + puerto dev durante los primeros segundos del start: "el frontend arranca antes que el backend — normal"), `peer_deps_warn` (`npm WARN|peer dep`), `vite_port_retry`.
2. **Clasificador** (`classifyText(text) → { pattern, severity } | null`): primer patrón que matchea por orden de declaración; bloqueante gana sobre benigno si ambos matchean.
3. **Integración en el loop y el job:** salidas de `run_command` con exitCode≠0, errores de transporte LLM y fallos de provisioning pasan por el clasificador. Bloqueante → evento `action_required { patternId, title, rawError (cap 10k, copiable), blockedCapabilities, remediationUrl }` y la corrida termina `error`. Benigno → se anota en el `outputSummary` de la acción con la explicación (`[diagnóstico] ...`), sin evento de alarma, y el loop continúa.
4. **Extensibilidad probada:** añadir un patrón nuevo = una entrada en la lista + un test; el clasificador no se toca.
5. **Sin falsos positivos caros:** un `ECONNREFUSED` fuera de la ventana de boot NO es benigno automático (puede ser el dev server caído) — la ventana/condición es parte del patrón y se testea.

## Pasos técnicos

1. `error-patterns.js` + `classifyText` TDD: un test por patrón (texto real de ejemplo → match; texto cercano → no match), prioridad blocking>benign, primer-match-gana.
2. Hook en el loop (feature 06): clasificar salidas de acciones fallidas y errores LLM; emitir `action_required` (shape validado por `event-types.js`, feature 04).
3. Hook en provisioning (feature 03) y en el job handler (feature 05) para fallos fuera del loop.
4. Fixtures con logs reales (402 de OpenRouter, boot de Vite) en `backend/tests/fixtures/codex-logs/`.
5. Gates + commits + push.

## Criterios de aceptación

- [ ] Un 402 de OpenRouter simulado en medio del build → corrida `error` + `action_required` con rawError exacto, lista de capacidades y enlace de remediación.
- [ ] `ECONNREFUSED` dentro de la ventana de boot → anotación benigna, la corrida sigue; fuera de la ventana → no se marca benigno.
- [ ] Texto que matchea un bloqueante y un benigno → gana el bloqueante.
- [ ] Cada patrón del registro tiene test positivo y negativo.
- [ ] El shape de `action_required` valida contra el catálogo de eventos.
- [ ] Suite completa + lint + CI verdes.

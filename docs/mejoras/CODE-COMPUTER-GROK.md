# /code computer — destilación Grok Bot (engine-only)

Destila la computadora persistente (screenshot / click / type / scroll / wait)
al backend de `/code` (Empresas) y `agent-computer`. **No es una ola 3Hxx.**
No toca chrome de AgentComputerShell, dock, PensandoBars ni el layout de 3 columnas.

## Qué cablea (helpers vivos, fail-closed)

1. **Aislamiento por chat/workspace** — `conversation-isolation.js` + `member-key.js`.
   La sesión es `userId + conversationId|workspaceId`. Si no se puede probar el
   aislamiento, se rechaza el attach (`isolation_required`, español, sin stack, sin `sk-`).
2. **Mapper de acciones** — bounds de viewport, botón left/middle/right, abort si el padre cancela.
   Vive en `computer-use-action-mapper.js` y se aplica en `/action`.
3. **Sandbox timeout + reap** — `sandboxTimeoutThenCleanup` / `sandboxFinallyCleanupOnAbort` /
   `sandboxTmpCleanupOnTimeout` en `dockerExec` del path computer (3H61/3H64, no se rehacen SSE/cola).
4. **Screenshot-only no cobra** — `screenshotOnlyNoCharge` / `observeOnlyNoCharge` en gateway,
   loop y `/action`.
5. **Refuse tools** — `refuseComputerToolsIfFlagOff` / `refuseComputerToolsIfNoUserId` /
   `refuseComputerToolsIfSessionMissing` en loop, gateway `wrapExecutors` y `/action`.
6. **DeepSeek Flash/Pro only** — `refuseOpenRouterComputerModel`. Nunca OpenRouter.

Orquestador: `backend/src/services/computer/computer-code-guard.js` (15+ callsites vivos).

`/code` pasa `conversationId={activeCodeChatSessionId || activeFolder.id}` a
`AgentComputerShell` y `DepartmentComputerPane` (prop only, sin chrome).

## Fuera de alcance

SSE / session queue (3H60–3H66). FEATURE_DOC_ENGINE. Hook UPN Word.
Rediseño UI. Ejecutar / Arrancando. Overlay `/agentes` (#411).

## Tests

```bash
cd backend && node --test \
  tests/agent-computer-conversation-key.test.js \
  tests/computer-use-action-mapper.test.js \
  tests/computer-use-auth.test.js \
  tests/ola-3h65-invariants.test.js \
  tests/ola-3h66-invariants.test.js \
  tests/engine-hotpath-wire.test.js
```

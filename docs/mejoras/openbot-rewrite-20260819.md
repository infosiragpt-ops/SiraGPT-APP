# OpenBot ideas rewrite — 2026-08-19

First-party rewrite of CopilotKit/OpenBot *ideas* into SiraGPT `/code`. MIT confirmed on the reference clone. **Not vendored.**

## Rewritten (live)

- One gateway: resolve target → evaluate policy → write audit row → then execute (`backend/src/services/agent-runner/engine-gateway.js`).
- Fail-closed policy: deny before allow; missing/broken policy permits nothing. Shipped owner default `deny=[]`, `allow=["true"]` so Luis's `/code` still works; every action still gets a row.
- `decideAndAudit({ tool, intent, botId, actorId, page, file, mcp })` → `{ allow, rule, auditId }`.
- Computer-per-coworker binding: `runId` + `browserProfile` + `workspace` keyed on coworker/department id.
- Human wheel: `withHumanControl` refuses bot computer actions (does not queue) while a human holds the computer.
- Handoff events: `computer.help_requested`, `computer.control_taken`, `computer.control_released` (backend API `POST /api/code/handoff`).
- Secrets: audit records request + length, never the value.
- Skills remain instructions, not capabilities (unchanged).
- Readable audit: `GET /api/code/audit?limit=50` (auth required) — permitted / refused / failed + the rule.
- Live tool path: `agent-runner/tools.js` wraps file/shell/python/web-act executors through the gateway. `/api/code-runner` generate-path wrap deferred if 3H31 is mid-deploy.

## Not vendored

- CopilotKit Intelligence, `COPILOTKIT_LICENSE_TOKEN`, their Docker compose, OpenAI/Anthropic/OpenRouter bots.
- OpenBot `server/src/computer/gateway.ts` / `policy.ts` / `cel-js` were read as reference only under `/opt/referencias-agentes/openbot`. Nothing copied into `/opt/siragpt` app tree.

## Leftovers (honest)

- AG-UI remote endpoints (bring-your-own agent URL) — not added.
- Full CEL language — tiny expression subset (`true` / `==` / `contains` / `matches` / `&&` / `||`).
- gVisor `runsc` computer supervisor — computers stay on existing CEO Office / dept-real-pc path.
- CopilotKit durable threads / Intelligence memory.
- `/code` Security Center audit panel and department-computer-pane wiring — **held** so the CEO Office computer fix can land first. Backend handoff + audit API are ready.

## Reference clone

`/opt/referencias-agentes/openbot` only. Confirmed absent from `/opt/siragpt/openbot` and `/opt/siragpt/vendor/openbot`.

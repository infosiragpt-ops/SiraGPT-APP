# Ola 200 — Wave D ship log (2026-08-15, America/Lima)

Backup: `/opt/siragpt/backups/ola-200-waveD-20260815T235453Z`
Lists: `/opt/siragpt/docs/mejoras/ola-200-fe-be-20260815.md` and `/workspace/ola-200-fe-be-20260815.md`
UI lock: no layout moves. No compose down. No `down -v`. No repo clone. No OpenRouter. No invented keys.
DeepSeek V4 Flash/Pro only. `SIRAGPT_REFRESH_TOKEN_ROTATION` stays unset (BE-013 still skipped).

This batch also covers the 3h /chat+/code constant-improvement run (folded into the same backend recreate and the single frontend rebuild).

## Shipped this wave (25 numbered + 3h extras)

### Backend (recreated `backend` only; bind-mounts + force-recreate; no image rebuild; no `down -v`)
- **BE-021** chat-run-queue.js — if `CHAT_RUN_QUEUE_ENABLED`, enqueue throws honest `chat_run_worker_unavailable` when the worker is down (no dark pipeline).
- **BE-022** chat-run-worker.js — heartbeat + `isChatRunWorkerHealthy` + stalled recover hook; stub processor throws `chat_run_worker_not_implemented` instead of silently completing.
- **BE-026** doc-agent/sandbox.js — `attachDestroyOnAbort` so AbortSignal always runs `destroy()` (`docker rm -f`).
- **BE-027** health-check.js — gVisor probe uses docker runtime registration; never claims healthy if runsc is missing (`runsc_registered` / `runsc_on_disk` honest).
- **BE-039** files.js — production magic-byte sniff failure on non-text → `sniff_failed` (no silent fallback).
- **BE-040** upload-security-policy.js — `sniff_failed` fail-closed (size/extension/content triple check).
- **BE-044** agent-runner/tools.js — `sandboxFilePath` / `resolveInWorkspace` on all file tools (read/write/list/edit/grep/preview/slides).
- **BE-065** rate-limiter.js — `assertProductionRedisStore`; memory store prohibited in `NODE_ENV=production`.
- **BE-100** credit-ledger.js — `shouldCaptureGenerateHold` / `abortGenerateHoldBeforeFirstToken`; abort before first token does not capture.
- **BE-035** SsoCallbackService.js — `redactSsoLog` strips `client_secret` from callback error logs.
- **BE-056** agent.js — `resolveAgentLlmClient` + Flash/Pro lock; gpt-4o / OpenAI key client removed.
- **BE-074** skills-executor.js — `SKILL_TIMEOUT_MS` + allowlisted handlers only (`HOST_SHELL_FORBIDDEN`).
- **BE-091** webauthn-config.js — localhost / 127.0.0.1 origins rejected in production.

3h extras (same recreate, no UI):
- Gateway events: `encodeEvent` now carries `id` (= seq); `/api/gateway/events` writes SSE `id:`.
- Gateway `memory.search` fail-closed (`hits: []`, `omitted: true`, `memory_search_failed`) — Wave C already locked memory-engine; this covers the OpenClaw gateway path.

### Frontend (ONE rebuild only; no UI moves; 3h run shares this rebuild)
- **FE-025** code-preview-poll.ts — exponential backoff + stop on 401/410.
- **FE-026** code-preview-start-fence.ts — `acquirePreviewStartFence` exclusive start lock.
- **FE-031** error-boundary.tsx + client-logs.ts — digest/requestId in `reportErrorBoundary`.
- **FE-032** provider-error-boundary.tsx — digest reported; fallback uses `redactBoundaryMessage` (no token leak).
- **FE-033** loading-boundary.tsx — timeout fail-closed (default 20s) so /chat suspense cannot hang.
- **FE-034** background-jobs-context.tsx — `cancel()` POSTs `/api/ai/stop-stream` then drops local state.
- **FE-047** attachment-ingest.ts — SHA-256 hash + magic-byte MIME sniff; fail-closed on mismatch.
- **FE-073** code-agent/escape.ts — `escapeToolOutput` (HTML-escaped tool preview).
- **FE-094** public/sw.js — explicit never-cache of `/api/ai/generate` and `/api/agent/task`.
- **FE-042** code-secrets.ts — `redactSecretsForLogs` / analytics-safe secret list.
- **FE-054** code-workspace-utils.ts — `joinWorkspacePath` rejects `..` and absolutes.
- **FE-072** composer-attachments.ts — size/type fail-closed before POST.

## Live proof (backend) — 19:01 PT
- `docker compose ... up -d --no-deps --force-recreate backend` — Recreated + Started
- Container created **19:01 PT** (2026-08-16T00:01:49Z), healthy
- `/health/live` 200, `/health/ready` 200
- `/health` gvisor_runsc **healthy** with `runsc_registered: true`, `runsc_on_disk: false` (honest; not faked from a missing binary path)
- r2_artifacts healthy, deepseek healthy, generate_path healthy (Flash/Pro, openrouter:false)
- POST `/api/gateway/agent` model `openrouter/openai/gpt-4o` → **400** `{ error.code: model_forbidden }`
- Invariant + unit tests inside live backend: **17/17 passed** (`ola-200-waveD-invariants.test.js`)
- Rotation flag **not** enabled (BE-013 skip)

## Live proof (frontend) — 19:08 PT
- One rebuild only; Wave C image stayed up until the new image was ready
- Frontend container created **19:08 PT** (2026-08-16T00:08:31Z), healthy
- http://127.0.0.1:3000/ 200
- https://siragpt.com/ 200
- https://siragpt.com/api/health/live 200
- Bundle/SW markers: `NEVER_CACHE_EXACT` + `/api/ai/generate` + `/api/agent/task` (FE-094), `error_boundary` (FE-031), `stop-stream` (FE-034), `Tipo no permitido` (FE-047/072)

## Services
- Recreated: backend, frontend (frontend via the single Wave D rebuild)
- Untouched: db, redis, caddy, runner
- Never ran `down` or `down -v`

## Leftovers for Wave E
Remaining FE-037–041/043–044/048–053/055–057/059–065/068–071/074–093/095–100 except numbers shipped in A–D.
Remaining BE-018/034/036–038/045–046/049–051/055/057–063/066–069/073/075–090/092–095/098–099 except numbers shipped in A–D.
Highest next: FE-037 RunningChatsBar resume, FE-068 media-composer no OpenRouter text, FE-081 no full-prompt metrics, FE-086/087/088 error PII, BE-049/050 doc/generate-document lock, BE-068/069 ready 503 dummy-key/R2, BE-090 HMAC constant-time.

Do **not** enable `SIRAGPT_REFRESH_TOKEN_ROTATION=1` until a dual-read window exists.

# Ola 200 — Wave C ship log (2026-08-15, America/Lima)

Backup: `/opt/siragpt/backups/ola-200-waveC-20260815T235000Z`
Lists: `/opt/siragpt/docs/mejoras/ola-200-fe-be-20260815.md` and `/workspace/ola-200-fe-be.md`
UI lock: no layout moves. No compose down. No `down -v`. No repo clone. No OpenRouter. No invented keys.
DeepSeek V4 Flash/Pro only. `SIRAGPT_REFRESH_TOKEN_ROTATION` stays unset (BE-013 still skipped).

## Shipped this wave (26 items)

### Backend (recreated `backend` only; bind-mounts + force-recreate; no image rebuild; no `down -v`)
- **BE-016** ai.js `generateOpenRouterImage` — isolated to image models; text slugs throw `image_path_isolated`.
- **BE-017** gateway.js — OpenRouter/OpenAI/Gemini/gpt-4o fail-closed with `model_forbidden` (no silent remap to Flash).
- **BE-023** payments.js — production unsigned Stripe webhook → 400 `{ error: unsigned_webhook, retryable: false }`.
- **BE-028** r2-storage.js — default presign TTL 300s (clamp 60–900) + `Cache-Control: private, max-age=…, no-store`.
- **BE-029** memory-engine.js — `recallWithTimeout` fail-closed (omit recall, never block generate).
- **BE-030** long-term-memory.js — `assertUserScope` on `facts:<userId>`; mismatch cannot inject another user's memories.
- **BE-031** user-memory-store.js — `recall()` catch → `[]` if the vector store is down.
- **BE-032** memory.js — reject `userId` query/body that does not match the authenticated owner.
- **BE-033** oauth-state.js — consume replay/expired maps to 401 `invalid_state`.
- **BE-041** artifacts.js — authenticated `POST /api/artifacts/re-presign` (owner-scoped key).
- **BE-043** agent-runner/loop.js — loop cap 25 emits `budget_exceeded` SSE before `final`.
- **BE-052** visible-model-catalog.js — generate remap forces DeepSeek Flash/Pro; OpenRouter marked `forbidden`.
- **BE-053** llm-routing.config.js — `generateProviders()` drops `openrouter` / `openrouter.ai`.
- **BE-064** circuit-breaker.js — HTTP 402 / `credits_exhausted` does not open the circuit.
- **BE-070** model-quota-router.js — Gema/fallback default is DeepSeek Flash; OpenRouter env is rewritten away.
- **BE-072** free-ia-fallback-quota.js — reserve throws `openrouter_fallback_forbidden`.

### Frontend (one rebuild after Wave B image was already healthy; no UI moves)
- **FE-021** lib/api.ts + chat-context-integrated.tsx — `resolveCatalogModel` lock before every generate envelope.
- **FE-022** agent-task-service.ts + code-agent/subagent.ts — POST model forced Flash/Pro; subagent default no longer Claude/gpt-4o.
- **FE-027** authenticated-fetch.ts — module-level `singleFlightRefresh`; two 401s share one `/auth/refresh`.
- **FE-028** api.ts + authenticated-fetch — send `x-refresh-family` / `x-refresh-version` when present (rotation still off).
- **FE-029** authenticated-fetch — one 401 refresh + retry, never a loop (`/auth/refresh` excluded).
- **FE-035** generateAIStream mints `idempotencyKey` via `safeUUID()` when the caller omits it.
- **FE-011** ArtifactCard.tsx — one re-presign/fetch retry on 403/expired R2 URL; same card layout.
- **FE-046** ArtifactPanel.tsx — same 403 retry; same panel layout. Shared helper `fetchWithPresignRetry`.
- **FE-024** code-chat-blocker.ts — `beginCodeGenerate` / `endCodeGenerate` in-flight lock (no second generate).
- **FE-036** safe-uuid.ts — already had WebView fallback; verified present (no change).

## Live proof (backend) — 18:46 PT
- `docker compose ... up -d --no-deps --force-recreate backend` — Recreated + Started
- Container created **18:46 PT** (2026-08-15T23:46:25Z), healthy
- `/health/live` 200, `/health/ready` 200 (db, redis, queue, rbac, authSecurity)
- POST `/api/payments/stripe/webhook` without signature → **400** `{ error: unsigned_webhook, retryable: false }`
- POST `/api/gateway/agent` model `openrouter/openai/gpt-4o` → **400** `{ error.code: model_forbidden }`
- POST `/api/artifacts/re-presign` unauthenticated → **401** `access_token_required`
- Container markers: `image_path_isolated`, `unsigned_webhook`, `budget_exceeded`, `recallWithTimeout`, `model_forbidden`
- Invariant + unit tests inside live backend: **13/13 passed** (`ola-200-waveC-invariants.test.js`)
- Rotation flag **not** enabled (BE-013 skip)

## Live proof (frontend) — 18:51 PT
- One rebuild only; Wave B image stayed up until the new image was ready
- Frontend container created **18:51 PT** (2026-08-15T23:51:53Z), healthy
- http://127.0.0.1:3000/ 200
- https://siragpt.com/ 200
- https://siragpt.com/api/health/live 200
- Chat bundle markers: `fetchWithPresignRetry`, `artifacts/re-presign`, `siragpt:refresh-family`, `x-refresh-family`, `idempotencyKey`

## Services
- Recreated: backend, frontend (frontend via the single Wave C rebuild)
- Untouched: db, redis, caddy, runner
- Never ran `down` or `down -v`

## Leftovers for Wave D
Remaining FE-025/026/031–034/037–045/047–100 except numbers shipped in A+B+C.
Remaining BE-018/021/022/026/027/034–040/044–046/049–051/055–063/065–069/073–095/098–100 except numbers shipped in A+B+C.
Highest next: FE-025 preview-poll backoff, FE-033 loading-boundary timeout, FE-047 attachment-ingest fail-closed, FE-073 XSS escape, FE-094 SW no-cache generate, BE-021/022 chat-run-queue+worker heartbeat, BE-039/040 upload MIME sniff, BE-044 path sandbox, BE-065 prod Redis rate-limiter, BE-100 hold+capture abort-before-token.

Do **not** enable `SIRAGPT_REFRESH_TOKEN_ROTATION=1` until a dual-read window exists.

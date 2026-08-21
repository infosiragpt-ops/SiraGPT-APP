# Ola 200 — Wave E ship log (2026-08-15, America/Lima)

Backup: `/opt/siragpt/backups/ola-200-waveE-20260816T002008Z` (also earlier file snapshot `ola-200-waveE-20260816T001154Z`)
Lists: `/opt/siragpt/docs/mejoras/ola-200-fe-be-20260815.md` and `/workspace/ola-200-fe-be-20260815.md`
UI lock: no layout moves. No compose down. No `down -v`. No repo clone. No OpenRouter. No invented keys.
DeepSeek V4 Flash/Pro only. `SIRAGPT_REFRESH_TOKEN_ROTATION` stays unset (BE-013 still skipped).

## Shipped this wave (29 numbered)

### Backend (recreated `backend` only; bind-mounts + force-recreate; no image rebuild; no `down -v`)
- **BE-049** doc.js — runner `no_llm` does not reopen the generic pipeline; OpenRouter 402 copy removed.
- **BE-050** generate-document.js — DeepSeek Flash/Pro lock; OpenRouter/OpenAI/Gemini/gpt-4o → 400 `model_forbidden`; no `OPENAI_API_KEY` client.
- **BE-068** health-check.js — `isDummyDeepSeekKey`; dummy/missing key is **critical unhealthy** in production readiness. Real key stays healthy (ready stays 200).
- **BE-069** health-check.js `/health/ready` — R2 `createR2Client` init fail or missing prod config is **critical unhealthy**. Current prod init=`ok` so ready stays 200.
- **BE-090** hmac-webhook.js — length-independent `timingSafeEqual` via `constantTimeEqual`.
- **BE-045** agent-runner/artifacts.js — `persistLastArtifactId` / `readLastArtifactId` (memory + Redis `sira:chat:lastArtifactId:…`); called from `persistOutputs`.
- **BE-057** agent-batch.js — `Idempotency-Key` replay + optional credit hold; default model no longer gpt-4o; Flash/Pro lock; 402 `credits_exhausted`.
- **BE-058** agent-runs.js — `POST /:traceId/cancel` aborts a registered `AbortController` (`registerRunAbort` / `getRunAbortSignal`).
- **BE-075** agent-runner/mcp — `assertUserLevelOAuth`; service-account / global MCP OAuth rejected.
- **BE-036** TokenVault.js — decrypt fail returns `{ status: 'corrupt', value: null }`; never ciphertext; log has no blob.

### Frontend (ONE rebuild only; no UI moves; RunningChatsBar still returns null)
- **FE-037** RunningChatsBar — on mount, resume via `getChatPendingStream` + `rememberEventId` (bar not moved; still hidden).
- **FE-068** media-composer-config — `isForbiddenMediaTextModel` / `assertMediaGenerateModel` / `filterMediaModels` (no OpenRouter text fallback).
- **FE-081** code-chat-metrics — `sanitizeMetricsForLog` strips prompt/message fields (PII).
- **FE-049** quality-gate — `runQualityGate(files, { aborted })` never returns `Validado` if aborted.
- **FE-055** codex-conversation-prefs + ai-code-chat-panel — refuse persist/restore of OpenRouter models in `code-workspace:model`.
- **FE-057** company-social-api — `mapOAuthErrorCode` (invalid_grant, access_denied, …); no popup HTML.
- **FE-086** billing/error.tsx — `safeRouteErrorLog`; no Stripe/email in fallback.
- **FE-087** auth/login/error.tsx — no email echo in logs/fallback.
- **FE-088** orgs/invitation/[token]/error.tsx — token not logged.
- **FE-099** gpts/error.tsx — no system-prompt leak in digest/logs.
- **FE-043** company-resource-access — `assertCompanyOrgScope` fail-closed.
- **FE-044** company-association-scope — 30s TTL cache + `invalidateCompanyAssociation`.
- **FE-061** academic-search-intent — `analyticsSafeAcademicQuery` (length/flag only, no raw query).
- **FE-062** admin-credits-service — 402 body code `credits_exhausted`.
- **FE-063** artifact-panel-context — `beginArtifactDownload` single-flight.
- **FE-070** turn-cancellation — `markPendingStop` / `isPendingStopFor` registry for RunningChatsBar.
- **FE-071** composer-actions — `beginComposerAction` / `endComposerAction` double-submit lock.
- **FE-091** use-file-processing-status — AbortController on unmount; 410/401/403 stop poll.
- **FE-100** catalog-model — `GenerateRequestModel` = `deepseek-v4-flash` | `deepseek-v4-pro`.

## Live proof (backend) — 19:20 PT
- `docker compose ... up -d --no-deps --force-recreate backend` — Recreated + Started
- Container created **19:20 PT** (2026-08-16T00:20:30Z), healthy
- `/health/live` 200, `/health/ready` 200
- Ready now includes `deepseek` `{ configured: true, dummy: false }` and `r2_artifacts` `{ configured: true, init: "ok" }` — **not** taken down
- Full `/health` deepseek healthy, r2_artifacts healthy, generate_path Flash/Pro `openrouter: false`
- POST `/api/agent-runs/:id/cancel` unauthenticated → **401** `access_token_required`
- POST `/api/agent/batch` unauthenticated → **401** `access_token_required`
- Invariant + unit tests inside live backend: **13/13 passed** (`ola-200-waveE-invariants.test.js`)
- Rotation flag **not** enabled (BE-013 skip)

## Live proof (frontend) — 19:26 PT
- One rebuild only; Wave D image stayed up until the new image was ready
- Compiled successfully in 3.8 min; image `siragpt-frontend:latest` Built
- Frontend container created **19:26 PT** (2026-08-16T00:26:58Z), healthy
- http://127.0.0.1:3000/ 200
- https://siragpt.com/ 200
- https://siragpt.com/chat 200
- https://siragpt.com/code 200
- https://siragpt.com/api/health/live 200
- Bundle markers: `pending-stream` (FE-037), `siragpt:lastEventId`, `credits_exhausted` (FE-062), `code-workspace:model` (FE-055), `Validado` (FE-049), `invalid_grant` / `oauth_popup_html` (FE-057)

## Services
- Recreated: backend, frontend (frontend via the single Wave E rebuild)
- Untouched: db, redis, caddy, runner
- Never ran `down` or `down -v`

## Leftovers for Wave F
Remaining FE-038–041/048/050–053/056/059–060/064–065/069/074–080/082–085/089/092–093/095–098 except numbers shipped in A–E.
Remaining BE-018/034/037–038/046/051/055/059–063/066–067/073/076–089/092–095/098–099 except numbers shipped in A–E.
Highest next: FE-038 LongOperationIndicator F4 labels, FE-039/040 workspace abort+etag, FE-050 stacktrace confirm, FE-064 logout CSRF clear, BE-046 generate_model telemetry, BE-051/055 ai-service/litellm leftovers, BE-066 shared generate/agent-task budget, BE-086/087 GitHub/Gmail OAuth codes, BE-089 webhook HMAC fail-closed.

Do **not** enable `SIRAGPT_REFRESH_TOKEN_ROTATION=1` until a dual-read window exists.

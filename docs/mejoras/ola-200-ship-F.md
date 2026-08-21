# Ola 200 — Wave F ship log (2026-08-15, America/Lima)

Backup: `/opt/siragpt/backups/ola-200-waveF-20260816T003004Z` (override snapshot included)
Lists: `/opt/siragpt/docs/mejoras/ola-200-fe-be-20260815.md` and `/workspace/ola-200-fe-be-20260815.md`
UI lock: no layout moves. No compose down. No `down -v`. No repo clone. No OpenRouter. No invented keys.
DeepSeek V4 Flash/Pro only. `SIRAGPT_REFRESH_TOKEN_ROTATION` stays unset (BE-013 still skipped).

## Shipped this wave (26 numbered)

### Backend (recreated `backend` only; bind-mounts + force-recreate; no image rebuild; no `down -v`)
- **BE-046** agent-runner/telemetry.js — `logGenerateModel` / `classifyGenerateModel` metric `generate_model{flash|pro}` + F2 path.
- **BE-051** ai-service.js — `assertNativeTextGenerate` fail-closed on OpenRouter/OpenAI/Gemini/gpt-4o/claude leftovers.
- **BE-055** ai-product-os/litellm-gateway.js — `assertTextGenerateNotViaLiteLLM` throws `litellm_text_generate_forbidden` for text generate.
- **BE-066** rate-limit-policy.js — `sharedGenerateAgentTaskKey` / `isSharedGenerateAgentPath` so generate + agent-task share one user budget.
- **BE-086** github.js — `mapGithubOAuthError` stable codes `access_denied`, `bad_verification_code`, `redirect_uri_mismatch`.
- **BE-087** gmail.js — `invalid_grant` → 401 `{ code: reconnect_required }` (never 500).
- **BE-089** webhooks.js — inbound HMAC fail-closed + clock-skew window via `hmac-webhook` (`POST /api/webhooks/inbound`).
- **BE-059** queue-registry.js — `deadLetter` (failed jobs) on every queue health snapshot.
- **BE-060** admin-queues.js — `failedCount` / `stalledCount` / `deadLetterCount` on public board status (no compose down to drain).
- **BE-034** ProviderOAuthService.js — `extractProviderOAuthErrorCode` maps GitHub/Spotify codes the same as Google.
- **BE-076** agent-runner/memory — `assertRecallScope` user+chat; mismatch omitted (fail-open), never 500.
- **BE-085** github-codex-connector.js — installation token redaction (`v1.<hex>` → `[redacted-installation-token]`).

### Frontend (ONE rebuild only; no UI moves; /chat and /code layout unchanged)
- **FE-038** LongOperationIndicator — `activityTextFromEvent` for real F4/tool labels (same fixed corner chip).
- **FE-039** code-workspace-context — `abortWorkspaceInflightWrites` on folder change; pending git mirrors cancelled.
- **FE-040** code-workspace-state — `applyServerWorkspaceIfNewer` refuses a stale local etag/revision overwrite.
- **FE-041** code-git-mirror — `assertMirrorPathInWorkspace` fail-closed on `..` / absolute paths (NUL byte stripped).
- **FE-050** code-detection — `isStacktracePaste` / `shouldConfirmCodeGenerateFromPaste` (no auto /code generate).
- **FE-051** code-preview-build — `beginPreviewBuild` cancels the previous build (`superseded`).
- **FE-052** code-preview-selection — `shouldApplyPreviewSelection` ignores a destroyed/stale preview generation.
- **FE-053** code-workspace-tools — `invokeWorkspaceToolWithTimeout` (default 20s + AbortSignal).
- **FE-064** auth-context-integrated — logout calls `clearAuthenticatedFetchCsrfCache` and drops `siragpt:refresh-family` / `siragpt:refresh-version`.
- **FE-075** workspace-diff — `applyWorkspaceDiffIfEtagMatch` lost-update guard.
- **FE-076** workspace-schema — `parseWorkspaceJsonFailClosed` on corrupt workspace JSON.
- **FE-078** code-autonomous-starters — `shouldAbortAutonomousStarter` if the user already typed.
- **FE-079** code-agent-company — `companyRefetchBackoffMs` exponential backoff on 429.
- **FE-080** code-agent-company-proactive — `createProactivePollController` cancel-on-unmount.

## Live proof (backend) — 19:36 PT
- `docker compose ... up -d --no-deps --force-recreate backend` — Recreated + Started
- Container created **19:36 PT** (2026-08-16T00:36:45Z), healthy
- `/health/live` 200, `/health/ready` 200
- Full `/health` deepseek healthy (`dummy: false`), r2_artifacts healthy (`init: ok`), generate_path healthy (`openrouter: false`)
- POST `/api/webhooks/inbound` unsigned / no secret → **503** `{ error: webhook_hmac_failed, code: hmac_secret_missing, retryable: false }` (fail-closed; no key invented)
- GET `/api/github/callback?error=access_denied` → **503** `oauth_provider_unavailable` / `client_id_missing` (GitHub OAuth env unset; mapper is in source, credentials not invented)
- Invariant + unit tests inside live backend: **11/11 passed** (`ola-200-waveF-invariants.test.js`)
- Rotation flag **not** enabled (BE-013 skip)

## Live proof (frontend) — 19:43 PT
- One rebuild only; Wave E image stayed up until the new image was ready
- Compiled successfully in 3.6 min; image `siragpt-frontend:latest` Built
- Frontend container created **19:43 PT** (2026-08-16T00:43:30Z), healthy, BUILD_ID `uz7Yzokiz9RWqxTu560Eb`
- http://127.0.0.1:3000/ 200
- https://siragpt.com/ 200
- https://siragpt.com/chat 200
- https://siragpt.com/code 200
- https://siragpt.com/api/health/live 200
- Bundle markers: `refresh-family` (FE-064, chat page), `workspace_changed` (FE-039), `mirror_path` (FE-041), `superseded` (FE-051), `most recent call last` (FE-050), `pending-stream` (Wave E still present)

## Services
- Recreated: backend, frontend (frontend via the single Wave F rebuild)
- Untouched: db, redis, caddy, runner
- Never ran `down` or `down -v`

## Leftovers for Wave G (then H to finish)
Remaining FE: 048, 056, 059, 060, 065, 069, 074, 077, 082, 083, 084, 085, 089, 092, 093, 095, 096, 097, 098 (~19).
Remaining BE: 018, 037, 038, 061, 062, 063, 067, 073, 077, 078, 079, 080, 081, 082, 083, 084, 088, 092, 093, 094, 095, 098, 099 (~23).
Skipped stays skipped: **BE-013** (do not enable `SIRAGPT_REFRESH_TOKEN_ROTATION`).
Highest next: FE-056 workspace identity, FE-060 agentic-search abort, FE-082 session persist, FE-089 pending-stream 8-fail stop, BE-061/062 queue retry + miss-catchup, BE-063 stripe replay, BE-067 structured logger, BE-077 browser stub, BE-082/083/084 host-runner / dept sandbox, BE-092/093 session revoke + reset TTL.

Do **not** enable `SIRAGPT_REFRESH_TOKEN_ROTATION=1` until a dual-read window exists.

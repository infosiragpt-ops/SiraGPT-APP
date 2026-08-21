# Ola 200 — Wave B ship log (2026-08-15, America/Lima)

Backup: `/opt/siragpt/backups/ola-200-waveB-20260815T233500Z`
Lists: `/opt/siragpt/docs/mejoras/ola-200-fe-be-20260815.md` and `/workspace/ola-200-fe-be.md`
UI lock: no layout moves. No compose down. No repo clone. No OpenRouter. No invented keys.

## Wave A frontend — DID land

Wave A claimed FE-001/002/005–010/012–019. At 18:20 PT the running image was still `Created=2026-08-15T22:20:31Z` (stale). The Wave A rebuild finished at **18:23 PT** (`Created=2026-08-15T23:23:18Z`, healthy). Live bundle contained `fetchResumeHeaders` and `notifyChatTurnStopped`. Disk patches were already present; the stale image was the gap. Wave B then started **one** additional frontend rebuild (no overlap) so FE-003/004 and the other Wave B FE files enter the image.

## Shipped this wave (26 items)

### Backend (recreated `backend` only; bind-mounts + force-recreate; no image rebuild; no `down -v`)
- **BE-011** agent-task-runner.js — runtime client + failover locked to native DeepSeek Flash/Pro (no OpenAI/Gemini/Cerebras hop).
- **BE-012** refresh-token-rotation.js — Redis store implemented (`REFRESH_TOKEN_STORE=redis` or rotation-on + `REDIS_URL`). Filesystem remains default when `REFRESH_TOKEN_STORE_DIR` is set (tests/prod current path).
- **BE-013 SKIPPED** — `SIRAGPT_REFRESH_TOKEN_ROTATION` stays unset/off. Enabling it in prod without a flag would mint family IDs the existing sessions do not have and log users out. Documented; do not flip in Wave C without a dual-read window.
- **BE-014** credit-ledger.js — `cancelLedgerReservation()` fails in-progress (never complete) then refunds. Complete+refund race cannot double-charge.
- **BE-015** ai.js stop-stream + agent-task.js — `cancelAgentTasksForChat(userId, chatId)` aborts running/queued agent-tasks; stop-stream returns `cancelledAgentTaskIds`.
- **BE-019** chat-abort-persistence.js — abort-flag store with TTL (default 90s) + purge. stop-stream marks; generate clears so orphan flags cannot block the next turn. Persist-on-abort now uses `resolveAbortedAssistantContent` (no 40-char floor).
- **BE-020** chat-turn-idempotency.js — `claimTurnIdentityUnique` create-if-not-exists guard around coordinator `create()`.
- **BE-024** credits.js — 402 body `{ error, code: 'credits_exhausted', retryable: false }`.
- **BE-047** agentic-chat-stream.js `writeSse` emits `id: N` (or `streamId:N`) on every event.
- **BE-048** ai.js generate — `id:` on start + heartbeat frames; existing Last-Event-ID resume buffer kept.
- **BE-009** agent-runner/queue.js — structured `agent_runner_cancel_failed` log + metric on cancel publish failure.
- **BE-025** enforce-plan-quota.js — production fail-closed 503 `quota_store_unavailable` when the quota check throws.
- **BE-054** document-pipeline llm-client.js — `createContentClient` native DeepSeek only.
- **BE-071** model-availability.js — generate reachability locked to DeepSeek Flash/Pro (plus chat/reasoner).
- **BE-096** refusal-safety-router.js — classify stays local; no OpenRouter short-circuit.
- **BE-097** invariant test (`backend/tests/ola-200-waveB-invariants.test.js`) — generate/agent-task/doc do not call `openrouter.ai`; plus abort TTL + unique-claim unit tests. **7/7 passed** inside the live backend container.

### Frontend (one rebuild after Wave A finished; no UI moves)
- **FE-003** lib/api.ts — `fetchResumeHeaders(lastEventId)` on generate reconnect; restore/persist `siragpt:lastEventId:${chatId}` in sessionStorage.
- **FE-004** background-streams-context.tsx — persist `lastEventId` per chatId (sessionStorage) + `rememberEventId`.
- **FE-020** sse-reconnect.ts — exported `buildResumeUrl()` for POST/GET resume clients.
- **FE-023** stream-validator.ts — `rejectForbiddenProvider` fail-closed on openrouter/openai/gemini chunks.
- **FE-030** api-base-url.ts — reject `openrouter.ai` as API base.
- **FE-045** analytics.ts — strip email/token/secret props before capture.
- **FE-058** agent-task-ai-sdk-bridge.ts — do not instantiate OpenAI/OpenRouter; `native_deepseek_only`.
- **FE-066** client-logs.ts — local rate-limit 12/min.
- **FE-067** fetch-sanitize.ts — `stripUntrustedCookieHeader` drops Cookie on non-same-origin URLs.
- **FE-090** lib/api.ts — `stopOnDoneMessage: true` on the remaining `streamSseJson` generate-adjacent reader.

## Live proof (backend) — 18:31 PT
- `docker compose ... up -d --no-deps --force-recreate backend` — Started
- `/health/live` 200, `/health/ready` 200 (healthy: db, redis, queue, rbac, authSecurity)
- Container has `cancelAgentTasksForChat`, `credits_exhausted`, `cancelLedgerReservation`, `markChatAborted`, `claimTurnIdentityUnique`, `id: ${eventId}`, DeepSeek failover lock, `useRedisStore`
- Rotation flag **not** enabled (BE-013 skip)

## Wave A FE live proof
- Frontend container created **18:23 PT** (2026-08-15T23:23:18Z), healthy, BUILD_ID `9aFhvaBUSzHthLLBqRxK5`
- Bundle markers: `fetchResumeHeaders`, `notifyChatTurnStopped`

## Wave B FE live proof — 18:36 PT
- Frontend container created **18:36 PT** (2026-08-15T23:36:18Z), healthy, HTTP 200
- Bundle markers: `siragpt:lastEventId` (FE-003/004), `Last-Event-ID`, `must not point at openrouter` (FE-030)
- One rebuild only; no second FE build started

## Services
- Recreated: backend, frontend (frontend via the single Wave B rebuild after Wave A had already landed)
- Untouched: db, redis, caddy, runner

## Leftovers for Wave C
Remaining FE-021/022/024–029/031–044/046–057/059–065/068–089/091–100 and BE-016–018/021–023/026–053/055–070/072–095/098–100 except numbers shipped in A+B.
Highest next: FE-021/022/027/035 (catalog lock, gpt-4o leftovers, refresh single-flight, idempotencyKey per turn), BE-016 isolate image OpenRouter path, BE-017 gateway HTTP test, BE-023 payments unsigned reject, BE-028 R2 presign TTL, BE-033 oauth-state already Redis (verify replay), BE-013 only with a dual-read flag.

Do **not** enable `SIRAGPT_REFRESH_TOKEN_ROTATION=1` until a dual-read window exists.

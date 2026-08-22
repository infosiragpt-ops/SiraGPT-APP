# Ola 200 — Wave A ship log (2026-08-15, America/Lima)

Backup: `/opt/siragpt/backups/ola-200-waveA-20260815T231200Z`
Lists: `/opt/siragpt/docs/mejoras/ola-200-fe-be-20260815.md` and `/workspace/ola-200-fe-be.md`
UI lock: no layout moves. No compose down. No repo clone. No OpenRouter. No invented keys.

## Shipped (26 items)

### Backend (recreated `backend` only, bind-mounts + force-recreate, no image rebuild)
- BE-001 agent-task.js — `createTaskLlmClient()` via `resolveAgentLlmClient()` (no OPENAI_API_KEY client)
- BE-002 agent-task.js — 503 `{error:no_llm}` instead of 500 OPENAI_API_KEY
- BE-003 agent-task.js — fallbackReason `deepseek_not_configured`
- BE-004 react-agent.js — reject OpenRouter client; force native DeepSeek + FLASH default
- BE-005 public-stream-error.js — codes `credits_exhausted`, `no_llm`, `model_forbidden`
- BE-006 verify.js — EDIT_TOOLS + create_docx/create_document/document_edit/document_pipeline
- BE-007 object-storage.js — R2 init fail-closed in production
- BE-008 object-storage.js — persistLocalFile fail-closed in production
- BE-010 agent-task.js — gpt-4o defaults replaced with `resolveTaskModel` (3 handlers + snapshot)
- BE-042 native-llm used on agent-task + react-agent generate path

### Frontend (one rebuild; no UI moves)
- FE-001 sse-client.ts — `onEventId` so POST streams can track Last-Event-ID
- FE-002 sse-client.ts — `fetchResumeHeaders` + `appendLastEventId`
- FE-005 authenticated-fetch.ts — one GET retry on 502/503/504
- FE-006 use-async-retry.ts — retry 429/502/503/504
- FE-007 catalog-model.ts — reject OpenRouter/OpenAI/Gemini providers
- FE-008 model-policy.ts — same provider lock on recommendFastModel
- FE-009 client-logs.ts — redact bearer/deepseek keys
- FE-010 attachment-url.ts — `isExpiredPresignUrl` (X-Amz-Date/Expires)
- FE-012 turn-cancellation.ts — `notifyChatTurnStopped` → POST /api/ai/stop-stream
- FE-013 live-activity.ts — str_replace/add_slide/document_edit/create_docx labels
- FE-014 app/design/error.tsx
- FE-015 app/library/error.tsx
- FE-016 app/parafraseo/error.tsx
- FE-017 app/plan/error.tsx
- FE-018 app/projects/error.tsx
- FE-019 app/admin/users/error.tsx

## Live proof (backend)
- `docker compose ... up -d --no-deps --force-recreate backend` — Started
- `/health/live` 200, `/health/ready` 200 (~18:17 PT)
- Container has `createTaskLlmClient`, `credits_exhausted`, `isProdFailClosed`, OpenRouter reject
- `/health` : r2_artifacts healthy, deepseek healthy, generate_path healthy
- gvisor_runsc degraded (pre-existing; runsc not visible inside backend container PATH)

## Deferred to Wave B
Remaining FE-020–FE-100 and BE-011–BE-100 except the shipped numbers above.
Highest next: BE-012/013 refresh rotation Redis, BE-014 credit cancel race, BE-015 stop-stream cancels agent-task,
BE-047/048 SSE event ids on generate, FE-003/004 wire Last-Event-ID into lib/api.ts + background-streams,
BE-019/020 abort persistence + idempotency unique, tests invariante no-openrouter.

## Services
- Recreated: backend
- Rebuilding: frontend (one at a time)
- Untouched: db, redis, caddy, runner

## Live proof (frontend)
- One frontend rebuild completed; `siragpt-frontend-1` Recreated + Started + healthy
- http://127.0.0.1:3000/ 200
- https://siragpt.com/ 200
- https://siragpt.com/api/health/live 200
- Times: backend recreate ~18:17 PT; frontend healthy ~18:24 PT (2026-08-15)

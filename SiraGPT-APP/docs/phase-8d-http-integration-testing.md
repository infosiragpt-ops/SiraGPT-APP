# Phase 8D: HTTP Integration Testing

## Scope

Phase 8D turns the Phase 8C contracts into route-level integration tests for the highest-risk backend surfaces. The tests run in-process with Supertest, use server-side auth session mocks, and avoid live GitHub, Redis, OpenAI or database calls unless a route explicitly requires the request to reach that layer.

Production deploy remains blocked operationally: `siragpt.com/codex` previously returned `404`, and this workspace still does not include the frontend host configuration or deploy credentials needed to redeploy it.

## Changes

- Added `supertest@7.2.2` as a backend dev dependency.
- Updated `backend/index.js` so requiring the module exports the Express app without binding a port, starting workers or starting the scheduler. `node index.js` still starts the server normally.
- Added HTTP contract coverage for:
  - GitHub Codex status, repo validation, rate-limit errors and RAG retrieval.
  - File upload auth, empty multipart requests and disallowed file prefiltering.
  - Agent task creation validation, missing Redis queue behavior and durable task status.
  - Admin queue status auth and no-Redis degradation.
  - `/health/live` liveness response contract without external dependencies.
- Extended the contract registry with route contracts for:
  - `health.live`
  - `agent.task.status`
  - `admin.queues.status`
  - documented `503` for queued agent task creation when Redis is unavailable.

## Validation

```bash
cd backend
node --test tests/http-codex.test.js tests/http-upload.test.js tests/http-agent-task.test.js
node --test tests/tool-schema-export.test.js tests/openapi-contracts.test.js
cd ..
git diff --check
```

The CI backend test gate now includes the new HTTP integration tests.

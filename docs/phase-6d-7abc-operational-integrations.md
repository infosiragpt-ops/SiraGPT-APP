# Phase 6D + 7A/7B/7C Operational Integrations

## Scope

This phase adds four low-risk, commercially compatible integrations:

- **6D GitHub repository RAG**: authenticated backend endpoints can select safe source files from a GitHub repo, ingest them through the existing `rag.ingestCode()` pipeline, and retrieve hybrid RAG hits from the Codex UI.
- **7A Bull Board**: admin-only queue dashboard for the existing BullMQ agent task queue.
- **7B SWR**: client-side cache/deduplication for Codex status and repository context.
- **7C Sentry**: opt-in frontend/backend error monitoring with PII-stripping defaults.

No remote repository code is cloned or executed. GitHub content is read through Octokit using server-side credentials only.

## Dependency Audit

| Package | Version | Workspace | License | Purpose | Selection reason | Risk |
|---|---:|---|---|---|---|---|
| `swr` | `2.4.1` | frontend | MIT | Codex cache and request dedupe | Maintained by Vercel, React 18 compatible, small surface | Low |
| `@bull-board/api` | `6.12.0` | backend | MIT | BullMQ dashboard adapter | Mature BullMQ UI API, compatible with existing queue | Low |
| `@bull-board/express` | `6.12.0` | backend | MIT | Express mount for Bull Board | Chosen instead of `7.0.0` because it supports Express 4 already used by backend | Low/medium |
| `@sentry/browser` | `10.51.0` | frontend | MIT | Browser error capture | Official Sentry SDK, opt-in by DSN | Low |
| `@sentry/node` | `10.51.0` | backend | MIT | Express error capture | Official Sentry SDK, initialized only when configured | Low |

Rejected/avoided:

- `@bull-board/express@7.0.0`: MIT and maintained, but it pulls Express 5.2.x. The backend is on Express 4, so this phase pins `6.12.0` for a safer production delta.
- GPL/AGPL packages: none added.

## Backend Routes

GitHub Codex:

- `GET /api/codex/github/files?repo=SiraGPT-ORg/siraGPT&branch=main`
- `POST /api/codex/github/ingest`
- `POST /api/codex/github/retrieve`

Admin queues:

- `GET /api/admin/queues/status`
- `GET /api/admin/queues/board`

All routes require the existing JWT auth. Queue board routes also require admin privileges.

## Environment

Backend:

```bash
GITHUB_CODEX_TOKEN=""      # optional for public repos, required for private repos
REDIS_URL="redis://..."    # required for Bull Board runtime
SENTRY_ENABLED=false
SENTRY_DSN=""
SENTRY_ENVIRONMENT=production
SENTRY_TRACES_SAMPLE_RATE=0
SENTRY_RELEASE=""
```

Frontend:

```bash
NEXT_PUBLIC_SENTRY_DSN=""
NEXT_PUBLIC_SENTRY_ENVIRONMENT=production
NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=0
NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE=0
NEXT_PUBLIC_SENTRY_REPLAY_ON_ERROR_SAMPLE_RATE=0
```

## Local Validation

```bash
npm test -- tests/sentry-config.test.ts
cd backend
node --test tests/github-codex-connector.test.js tests/admin-queues.test.js tests/sentry-observability.test.js tests/sira-health-and-metrics.test.js
```

Manual UI path:

1. Start backend with `OPENAI_API_KEY` for RAG embeddings and optional `GITHUB_CODEX_TOKEN`.
2. Open `http://localhost:3000/codex`.
3. Analyze `SiraGPT-ORg/siraGPT`.
4. Click `Indexar RAG`.
5. Search a code question in `RAG de repo`.

## Production Notes

- Keep `GITHUB_CODEX_TOKEN` server-side. Never expose it through `NEXT_PUBLIC_*`.
- `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN` enable telemetry; payload stripping removes cookies, headers, request bodies and query strings.
- Bull Board is mounted under an admin route and returns `503` when Redis is not configured.
- Repository RAG skips `.env*`, lockfiles, vendor/build directories, unsupported binary assets and oversized files.

# Phase 8A: GitHub Codex Connector Hardening

Date: 2026-05-01

## Scope

Phase 8A hardens the existing backend-only GitHub Codex connector with official Octokit resilience plugins:

- `@octokit/plugin-retry@8.1.0`
- `@octokit/plugin-throttling@11.0.3`

The public Codex API remains unchanged:

- `GET /api/codex/github/status`
- `GET /api/codex/github/repo`
- `GET /api/codex/github/files`
- `POST /api/codex/github/ingest`
- `POST /api/codex/github/retrieve`

The connector still does not clone repositories, execute repository code, or accept GitHub tokens from the browser or request bodies.

## Backend Configuration

Optional for public repositories, required for private repositories or higher rate limits:

```env
GITHUB_CODEX_TOKEN="github_pat_or_fine_grained_token"
```

Fallback remains supported:

```env
GITHUB_TOKEN="github_pat_or_fine_grained_token"
```

Retry and throttling defaults are safe for local and production use:

```env
GITHUB_CODEX_RETRY_LIMIT=2
GITHUB_CODEX_THROTTLE_MAX_RETRIES=2
GITHUB_CODEX_THROTTLE_RETRY_AFTER_SECONDS=60
```

`GITHUB_CODEX_RETRY_LIMIT` only applies to transient GitHub API statuses: `429`, `500`, `502`, `503` and `504`. Authentication, validation and unavailable repository responses are not retried.

`GITHUB_CODEX_THROTTLE_RETRY_AFTER_SECONDS` caps automatic throttling retries. Longer GitHub-requested waits are surfaced to callers through normalized rate-limit metadata instead of blocking the backend in long retry loops.

## Status Surface

`GET /api/codex/github/status` exposes sanitized operational capability:

- token mode and token source name, never the token value
- retry limit and retryable status codes
- throttle max retries and retry-after cap

No GitHub credential is included in status, repository context, file listings, warnings or normalized errors.

## Error Handling

Route errors are normalized:

- `401` returns `github_auth_failed`
- `403` with rate-limit headers and `429` return `github_rate_limited`
- `404` returns `github_repository_unavailable`
- `5xx` returns generic `github_api_error`

Only sanitized GitHub rate-limit headers are returned: limit, remaining, reset, used and retry-after.

Optional repository surfaces such as GitHub Actions continue to degrade into warnings, so repository context remains available when read-only tokens do not include every optional permission.

## Verification

```bash
cd backend
node --test tests/github-codex-connector.test.js tests/sentry-observability.test.js tests/admin-queues.test.js
npm audit --omit=dev --audit-level=critical
cd ..
npm run licenses:check
npm run licenses:report
git diff --check
```

Full release validation:

```bash
npm run lint -- --max-warnings 97
npx tsc --noEmit --skipLibCheck --ignoreDeprecations 5.0
npm run build
```

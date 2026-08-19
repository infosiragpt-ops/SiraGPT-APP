# Phase 9C: GitHub Actions Intelligence for Codex

Date: 2026-05-02

## Goal

Turn the existing GitHub Codex connector into a more professional CI surface: read workflow runs, jobs, failed steps and sanitized log excerpts from GitHub Actions, then expose that context in `/codex` with a minimal Codex-style layout.

This phase is intentionally read-only. It does not clone repositories, execute remote code, create PRs, merge branches or accept GitHub tokens from the browser.

## Integration

No new dependency was added. The implementation reuses the existing official `octokit` client, already hardened with retry and throttling in Phase 8A.

New backend connector methods:

- `listActionRuns()`
- `getActionRun()`
- `listActionJobs()`
- `analyzeActionFailure()`

New authenticated API routes:

- `GET /api/codex/github/actions/runs`
- `GET /api/codex/github/actions/runs/:runId`
- `GET /api/codex/github/actions/runs/:runId/jobs`
- `POST /api/codex/github/actions/analyze-failure`

Frontend:

- `/codex` now uses a minimal two-pane layout.
- Left pane: Codex-style instruction/chat rail, repo controls, CI actions and RAG prompt.
- Right pane: browser frame plus tabs for CI, repository context and RAG.
- CI tab shows recent workflow runs and can analyze a run using jobs, failed steps and sanitized logs.

## Security

- GitHub token remains backend-only via `GITHUB_CODEX_TOKEN` or `GITHUB_TOKEN`.
- Recommended token scope remains read-only: metadata, contents, pull requests, issues and actions.
- Job logs are capped to a bounded byte budget before returning to the UI.
- Sanitization removes:
  - GitHub tokens (`ghp_*`, `gho_*`, `ghu_*`, `ghs_*`, `ghr_*`, `github_pat_*`)
  - authorization headers
  - bearer/basic credentials
  - masked values
  - basic-auth URL credentials
  - ANSI control sequences

## Local Validation

```bash
cd backend
node --test tests/github-codex-connector.test.js
cd ..
npx tsc --noEmit --skipLibCheck --ignoreDeprecations 5.0
npm run lint -- --max-warnings 97
npm run build
```

Manual smoke:

```bash
npm run dev -- -H 127.0.0.1 -p 3000
open http://127.0.0.1:3000/codex
```

Expected behavior:

- `/codex` opens with the left instruction pane and right browser pane.
- `Revisar CI` lists recent GitHub Actions runs for `SiraGPT-ORg/siraGPT`.
- `Analizar fallo` returns failed jobs/steps and sanitized log signals.
- If the latest run is green, diagnosis reports no actionable failure.

## Production Validation

- Confirm `GITHUB_CODEX_TOKEN` is configured server-side for private repo access.
- Confirm the token has read-only Actions access.
- Confirm GitHub Actions runs are visible in `/codex`.
- Confirm failed runs do not leak tokens or raw authorization headers in the UI.
- Confirm CI remains green after deployment.

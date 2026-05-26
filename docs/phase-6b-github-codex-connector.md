# Phase 6B: GitHub Codex Connector

Date: 2026-05-01

## Scope

Phase 6B adds a first controlled GitHub connector for Codex/Cursor-style repository context:

- `octokit@5.0.5` in the backend only.
- Authenticated API routes under `/api/codex/github`.
- A `/codex` product page with repository, PR, issue, README and GitHub Actions context.
- Sidebar navigation entry directly below `Diseño`.
- No client-provided GitHub tokens and no repository code cloning.

## Dependency Decision

| Package | Version | License | URL | Purpose | Risk | Alternatives | Decision |
|---|---:|---|---|---|---|---|---|
| `octokit` | `5.0.5` | MIT | https://github.com/octokit/octokit.js | Official GitHub REST client for repository context | Node >=20, ESM package loaded dynamically from CommonJS backend | `@octokit/rest`, raw `fetch` | Selected because it is official, maintained, MIT, supports retries/plugins and avoids hand-written GitHub API clients |

Validation performed before install:

- License: MIT.
- Repository: official Octokit monorepo.
- Latest version checked: `5.0.5`.
- Published/modified metadata checked: 2025-10-31.
- Engine: Node `>=20`, compatible with CI Node 24.
- Core token handling: backend environment only.

## Environment

Optional for public repositories, required for private repositories or higher rate limits:

```env
GITHUB_CODEX_TOKEN="github_pat_or_fine_grained_token"
```

Fallback supported:

```env
GITHUB_TOKEN="github_pat_or_fine_grained_token"
```

Recommended fine-grained permissions:

- Repository metadata: read.
- Contents: read.
- Pull requests: read.
- Issues: read.
- Actions: read.

Do not expose the token through `NEXT_PUBLIC_*`. Do not paste GitHub tokens into the browser.

## API

All routes require the existing SiraGPT JWT session.

```http
GET /api/codex/github/status
```

Returns provider, package, token mode and recommended scopes. It never returns the token.

```http
GET /api/codex/github/repo?repo=SiraGPT-ORg/siraGPT&branch=main&limit=10
```

Returns:

- repository metadata
- selected branch
- open pull requests
- open issues, excluding PR mirror issues
- recent GitHub Actions runs
- README preview
- Codex summary signals and next actions
- partial warnings when optional GitHub surfaces are denied

## Local Verification

```bash
node --check backend/src/services/github-codex-connector.js
node --check backend/src/routes/github-codex.js
node --test backend/tests/github-codex-connector.test.js
npm audit --prefix backend --omit=dev --audit-level=critical
npm run licenses:report
npm run security:validate
```

Then open:

```bash
npm run dev -- -H 127.0.0.1 -p 3000
open http://127.0.0.1:3000/codex
```

## Production Verification

1. Set `GITHUB_CODEX_TOKEN` in the backend runtime environment.
2. Deploy backend and frontend.
3. Sign in to SiraGPT.
4. Open `/codex`.
5. Inspect a public repository and then a private repository covered by the token.
6. Confirm GitHub Actions status, PRs, issues and README render without exposing secrets.
7. Confirm CI passes `security:validate`, backend tests, frontend typecheck/lint/build and license drift checks.

## Security Notes

- The frontend never receives a GitHub token.
- The backend does not clone repositories or execute code.
- README content is preview-limited.
- Optional GitHub surfaces degrade with warnings instead of failing the entire repository context.
- Errors are normalized to avoid leaking raw provider messages or secrets.

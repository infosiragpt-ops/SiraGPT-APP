# Sentry Source Map Upload

Production stack traces resolve to minified bundle frames by default. Uploading source maps to Sentry lets the dashboard show original (TypeScript / pre-bundle) source for both frontend (`.next`) and backend (`backend/dist`) errors.

This integration is **opt-in** and a no-op until the required environment is configured. Nothing about CI behavior changes until you flip the switch.

## How it's wired

1. **Helper script** — `scripts/upload-sentry-sourcemaps.sh` (existing) wraps `@sentry/cli`. It:
   - Creates / finalizes a Sentry release named after the current `SENTRY_RELEASE` (we pass `${{ github.sha }}`).
   - Uploads frontend maps from `.next/static/chunks/`, `.next/server/pages/`, `.next/server/chunks/`.
   - Uploads backend maps from `backend/dist/` if present.
   - Calls `sentry-cli releases set-commits --auto` so Sentry can map errors to commits.

2. **CI step** — the `sourcemaps` job in `.github/workflows/deploy.yml` runs **after** a successful production deploy. The job is gated by:
   - `vars.SOURCE_MAP_UPLOAD == 'true'` (a repo / org variable), and
   - `secrets.SENTRY_AUTH_TOKEN` being non-empty.

   If either is missing the job is skipped — explicitly logged as a `::notice::` for observability, never errored.

3. **Failure isolation** — the job is `continue-on-error: true`. A failed Sentry upload never blocks the actual deploy or rolls anything back; source maps are an observability convenience, not a release gate.

## Enabling

1. Generate a Sentry Internal Integration token with `project:releases` + `project:write` scope.
2. In GitHub repo settings:
   - **Secrets → Actions** → add `SENTRY_AUTH_TOKEN`.
   - **Variables → Actions** → add:
     - `SOURCE_MAP_UPLOAD = true`
     - `SENTRY_ORG = <your org slug>`
     - `SENTRY_PROJECT = <your frontend project slug>` (e.g. `siragpt-frontend`)
3. Push to `main` (or run the `deploy` workflow manually). The `sourcemaps` job will appear in the run graph alongside `deploy`, `post-check`, and `notify`.

## Disabling temporarily

Just delete the `SOURCE_MAP_UPLOAD` variable (or set it to `false`). No code change required.

## Manual / local upload

```bash
export SENTRY_AUTH_TOKEN=...
export SENTRY_ORG=...
export SENTRY_PROJECT=siragpt-frontend
export SENTRY_RELEASE=$(git rev-parse HEAD)
./scripts/upload-sentry-sourcemaps.sh
```

## Why both build *and* upload run in CI

The job re-builds with `GENERATE_SOURCEMAP=true` because the production Docker image we ship intentionally **strips** maps to keep the runtime container small. Building inside the upload job lets us upload high-fidelity maps to Sentry while keeping the deployed bundle minified — same behaviour Vercel uses.

# CI Workflow Summary

Source of truth: `.github/workflows/ci.yml`. This document is a navigation aid
for engineers wondering "which job catches what, and why is my run slow?".
It does **not** redefine behaviour — when in doubt, read the YAML.

## Job graph

```
push / pull_request / workflow_dispatch
        │
        ├─ frontend          (build · ~10–13 min)
        ├─ backend           (matrix 4 shards · ~8–12 min per shard)
        ├─ security-audit    (npm audit + SBOM · ~2–3 min)
        ├─ licenses          (third-party audit · ~2–3 min)
        ├─ e2e               (Playwright smoke · informational, ~5–8 min)
        ├─ docker            (image build · informational, ~5–10 min)
        │
        └─ ci                (final aggregator — required check)
             needs: frontend, backend, docker, licenses, security-audit
```

The `ci` aggregator job is the single status that branch-protection on
`main` references. Adding or removing leaf jobs does not require touching
the protection rule.

## Per-job posture

| Job | Posture | Owner | Notes |
|---|---|---|---|
| `frontend` | hard gate | platform | install · lint (ratchet 97) · tsc · `npm test` · `next build` · bundle-size budget |
| `backend` | hard gate | platform | Postgres+Redis services, Prisma push, sharded `node --test` (1/4–4/4), coverage on shard 1, `/health` smoke on shard 1 |
| `security-audit` | hard gate (critical only) | security | npm audit critical for both workspaces + CycloneDX SBOM artifact |
| `licenses` | hard gate | legal | forbidden-license scan + THIRD_PARTY_LICENSES.md drift check |
| `e2e` | informational | platform | `continue-on-error: true`. Promotion to hard gate gated on 5 green runs / 3 days (see `docs/architecture/PIPELINE.md` §14.4) |
| `docker` | informational | platform | proves both Dockerfiles build cleanly; no push step yet |

## Hot spots — what tends to dominate wall-clock

1. **Backend matrix** — 4 shards × Postgres+Redis boot + `prisma generate` +
   schema push. Each shard pays the install + Prisma cost. Coverage runs
   only on shard 1 to avoid 4× the c8 instrumentation overhead.
2. **`next build`** — incremental thanks to `.next/cache` keyed on
   source files; cold cache takes 4–6 minutes on its own.
3. **Playwright install** — Chromium download is the most flake-prone
   step in the workflow; it has its own 5-minute timeout + soft
   `continue-on-error` to keep the rest of the pipeline moving.

## Caching strategy

| Cache | Key | Scope |
|---|---|---|
| `setup-node` npm cache | `package-lock.json` (+ `backend/package-lock.json` on frontend job) | both workspaces |
| Prisma engines | schema + backend lockfile | backend + frontend-tests-that-import-backend |
| `.next/cache` | lockfile + frontend source hash | next build module graph |

Restore-keys are configured for each cache so a partial hit still beats
a cold fetch.

## Things to be aware of

- **Coverage thresholds**: backend CI enforces 60/60/50/60 (lines/funcs/
  branches/statements). The same thresholds are mirrored in
  `backend/package.json#scripts.test:coverage` so a local
  `npm run test:coverage` catches regressions before the push.
- **Commented legacy step** in the backend job (the multi-line
  `Agentic runtime tests`) is a deliberate rollback escape hatch for
  the sharding migration. Owner: platform. Re-evaluate after 30 days
  of green sharded runs and delete if untouched.
- **Dummy secrets** in the backend job are required because several
  modules instantiate SDK clients at require-time. They are clearly
  prefixed `ci-dummy-`/`sk-…-dummy-` and never leave the runner.

## Notify-on-failure

A `notify-on-failure` job posts to Slack (via `SLACK_WEBHOOK_URL`,
shared with the deploy workflow from cycle 25) when any required job
fails. It is decoupled from `ci` so its own failure can't gate merges.

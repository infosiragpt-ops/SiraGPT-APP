---
name: backend test CI wiring
description: How backend test files get picked up by CI, and the health-route extraction that made /health testable.
---

# Backend test discovery in CI

New `backend/tests/*.test.js` files do NOT run in CI automatically. The
canonical CI runner is `backend/scripts/test-shard.sh`, which derives its file
list by regex-extracting `tests/...test.js` tokens from the `test` script in
`backend/package.json`. If a test file isn't named in that hardcoded `test`
script string, the shard never runs it.

**How to apply:** when adding a backend test that must run in CI, append its
path to the `scripts.test` string in `backend/package.json`. (A directory-scan
fallback in test-shard.sh only triggers when zero files are extracted, which
never happens here.)

**Why:** the suite is ~1300+ tests sharded across runners; the file list is a
single source of truth in package.json. Some older health tests
(e.g. `sira-health-and-metrics.test.js`) are only referenced in a commented-out
secondary CI job, so they may not run in the main sharded job at all.

# /health route is testable without booting the whole server

The three health endpoints (`/health`, `/health/live`, `/health/ready`) are
registered by a dependency-injected factory in
`backend/src/routes/health-routes.js` (`createHealthRoutes`). `backend/index.js`
mounts exactly that factory and feeds the boot-time OAuth snapshot in via
`healthRoutes.setOAuthBootResult(...)` from `startServer`.

**How to apply:** to test the real `/health` wiring (e.g. that it threads the
OAuth/startup-env boot results through to `runFullHealthCheck`), mount
`createHealthRoutes({ prisma: fake, cacheTtlMs: 0, ... })` on a bare Express app
and use supertest — do NOT `require('../index')` (it can `process.exit` during
startup validation and uses a real prisma/DB). Pass `cacheTtlMs: 0` so
consecutive requests observe freshly-set boot snapshots instead of a cached
report.

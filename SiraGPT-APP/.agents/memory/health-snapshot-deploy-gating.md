---
name: health-snapshot deploy gating
description: Why the ops:health CLI must fail hard when /health is wedged but liveness still answers.
---

# Health-snapshot deploy gating

The `npm run ops:health` CLI (`backend/scripts/health-snapshot.js`) probes
`/health/live` then `/health` and maps status to an exit code:
0 = healthy/degraded, 1 = unhealthy/unknown, 2 = unreachable.

**Rule:** when liveness answers but the composite `/health` probe itself fails
(timeout/abort/reset/non-JSON), classify as `unhealthy` (exit 1), NOT `degraded`
(exit 0).

**Why:** a wedged `/health` while the process still accepts connections is a real
outage signal (e.g. a hung DB query). Mapping that to `degraded`→exit 0 produces a
false green that lets deploy verification pass on a broken backend. This was caught
in code review of the original draft.

**Warm-up hint nuance:** only attach the post-deploy warm-up hint when `/health`
returns an *authoritative* composite `status:"unhealthy"` with a non-empty `checks`
array. Never attach it to transport/probe failures — those are not warm-up.

**How to apply:** preserve this distinction if the health report shape in
`backend/src/services/observability/health-check.js` changes, and keep the
exit-code tests in `backend/tests/health-snapshot.test.js` (timeout, 5xx-bad-JSON,
liveness-up-but-/health-down) green.

# Hermes scheduled-job ownership

## Boundary

The native Hermes runtime router uses SiraGPT's canonical `authenticateToken`
middleware. Only the six static map/toolset handlers remain public. Runtime
health contains aggregate state and therefore requires authentication too.

Cron list/create/trigger/delete, CLI cron and TUI dispatch take identity only
from the authenticated request. Query/body `userId` cannot select a different
owner. Foreign and nonexistent HTTP trigger/delete targets return the same 404.
Bridge get/list/remove/pause/resume/trigger require a valid owner; an omitted
owner is never interpreted as permission to use the stored owner's identity.
The cron tool forwards its trusted execution context. The internal tick passes
each persisted job owner explicitly; it does not create a public bypass.

Existing clients must send their normal SiraGPT session or API authentication.
Do not work around a 401 by adding `userId` or restoring optional authentication.

This is a SiraGPT-owned correction to the existing Hermes-style bridge, not an
import of the Python runtime. MIT references and attribution remain intact.
It does not certify resource-level authorization in delegate, gateway, rewind
or other Hermes subsystems; those need separate scoped acceptance.

## Validation

```sh
NODE_ENV=test node --test \
  backend/tests/hermes-cron-owner-isolation.test.js \
  backend/tests/hermes-openclaw-map-route.test.js
```

The initial 13 cases had 11 failures against the old implementation. The
regressions use the actual router, cron bridge, CLI, tools and scheduler with
real private temporary JSON storage and loopback HTTP. Authentication fixtures
and the agent invoker are explicitly synthetic; unrelated integrations are
unavailable. No live users' jobs, secrets, external providers or paid calls are
used. This is not JWT/database acceptance or a production E2E certificate.

Positive checks retain owned creation/execution/deletion, pause/resume, static
public inventory and internal tick. Negative checks verify anonymous/invalid
auth rejection, identity spoof rejection and no foreign mutations/invocations.
The new test file is discovered by the existing backend CI shard mechanism.
No tests are quarantined and no coverage denominator is modified.

## Release and recovery

Reviewed PR, green checks and the existing approved Lenovo release procedure
are required. Before claiming live: exact public SHA, healthy API and an
authenticated owner-versus-foreign test using dedicated synthetic test jobs.
Do not probe jobs belonging to real users. No live acceptance is claimed here.

If a caller fails after release, verify its normal authentication and explicit
owner propagation. Fix the caller; do not remove the ownership boundary.
If rollback becomes necessary, use the reviewed release recovery procedure
without deleting job records or resetting unrelated changes.

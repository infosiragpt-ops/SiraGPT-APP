# Enforce RBAC after a shadow rollout

`RBAC_ENFORCEMENT_MODE` accepts only `shadow` or `enforce`. Production
defaults to `enforce`; non-production defaults to `shadow`. An invalid value
blocks production startup without echoing the configured value.

## Why shadow mode exists

`backend/src/middleware/require-permission.js` gates protected routes on
declarative permissions. Shadow mode temporarily accepts each route's legacy
predicate and logs `kind: 'rbac.shadow.diff'` whenever the declarative result
differs.

At startup, the RBAC bootstrap idempotently seeds the runtime catalog and
backfills global and organization assignments. Enforce mode will not bind the
HTTP port unless every legacy admin has the expected global role and
`SUPERADMIN` owns every system permission.

## Sunset checklist

1. **Watch the diff stream** for at least 7 days:
   ```bash
   pm2 logs siraGPT-api --lines 0 --raw --nostream | rg rbac.shadow.diff
   ```
   Expected: empty for the full window. Any hit is a missing
   declarative grant — backfill it before continuing.

2. **Verify startup readiness**:
   ```bash
   curl --fail --silent http://127.0.0.1:5000/health/ready
   ```
   Expected: `rbac.state=ready`, `rbac.ready=true`, and no `errorCode`.

3. **Confirm the canonical tests pass in enforce mode**:
   ```bash
   cd backend
   RBAC_ENFORCEMENT_MODE=enforce npm test
   ```
   The focused contracts cover both modes, bootstrap/readiness, API-key
   boundaries, route mapping, and legacy compatibility.

4. **Set production mode and restart**:
   ```bash
   pm2 set siraGPT-api:RBAC_ENFORCEMENT_MODE enforce
   pm2 restart siraGPT-api --update-env
   ```

5. **Watch error rate** for an hour. Any spike of 403s with
   `missingPermission` set is a legitimate user who used to slide
   through on the legacy flag and now needs a declarative grant.
   Use the new `POST /api/admin/rbac/users/:userId/roles` endpoint
   (F2 PR10) to add the missing role + watch the user retry.

## Rollback

If enforcement reveals an assignment gap, explicitly return to shadow while
the bootstrap diagnostics and audit events are investigated:

```bash
pm2 set siraGPT-api:RBAC_ENFORCEMENT_MODE shadow
pm2 restart siraGPT-api --update-env
```

Shadow mode changes authorization compatibility only. Bootstrap writes are
idempotent and the permission cache is invalidated after every bootstrap.

## After the sunset

Keep the legacy boolean columns only as compatibility inputs until a separate,
reviewed schema migration removes them. New authorization decisions must use
declarative permissions; sensitive routes retain the explicit super-admin gate.

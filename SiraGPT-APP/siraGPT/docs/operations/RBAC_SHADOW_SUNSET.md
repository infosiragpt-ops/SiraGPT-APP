# Sunset the RBAC shadow gate

> F5 PR23 — procedure to flip `RBAC_SHADOW_MODE` from `true` (the
> current default) to `false` once the declarative grants have caught
> up to the legacy `isSuperAdmin` flag.

## Why shadow mode exists

`backend/src/middleware/require-permission.js` (F2 PR9) gates admin
routes on declarative permissions (`requirePermission('rbac.manage')`,
`'credits.adjust'`, …). During the F1–F4 rollout we cannot guarantee
every legacy super admin already has an equivalent `user_roles` row,
so the middleware also accepts `req.user.isSuperAdmin === true` and
logs a `kind: 'rbac.shadow.diff'` line every time the declarative
check would have closed but `isSuperAdmin` opened.

Once the log shows zero diffs for a sustained window we can drop the
crutch and rely on the declarative table alone.

## Sunset checklist

1. **Watch the diff stream** for ≥ 7 days:
   ```bash
   ssh root@62.72.11.231 -- "pm2 logs siraGPT-api --lines 0 --raw --nostream | grep rbac.shadow.diff" | head
   ```
   Expected: empty for the full window. Any hit is a missing
   declarative grant — backfill it before continuing.

2. **Verify the catalog** still has the canonical row count
   (matches `docs/architecture/rbac-matrix.md`):
   ```bash
   ssh root@62.72.11.231 -- "psql \$PRISMA_DATABASE_URL -c \"
     SELECT
       (SELECT count(*) FROM roles) AS roles,
       (SELECT count(*) FROM permissions) AS perms,
       (SELECT count(*) FROM role_permissions) AS rp,
       (SELECT count(*) FROM user_roles) AS ur
   \""
   ```
   Expected: `roles=6`, `perms=52`, `ur ≥ count(users)`.

3. **Confirm `npm test`** still passes locally with the flag flipped:
   ```bash
   cd ~/Desktop/siraGPT/backend
   RBAC_SHADOW_MODE=false npm test
   ```
   Expected: all green. The shadow-mode test in
   `require-permission-middleware.test.js` already covers both
   branches.

4. **Flip prod env**:
   ```bash
   ssh root@62.72.11.231 -- "pm2 set siraGPT-api:RBAC_SHADOW_MODE false && pm2 restart siraGPT-api"
   ```
   Or edit `/root/siraNew/siraGPT/.env` (the file PM2 reads) and
   restart with `pm2 reload siraGPT-api --update-env`.

5. **Watch error rate** for an hour. Any spike of 403s with
   `missingPermission` set is a legitimate user who used to slide
   through on the legacy flag and now needs a declarative grant.
   Use the new `POST /api/admin/rbac/users/:userId/roles` endpoint
   (F2 PR10) to add the missing role + watch the user retry.

6. **Update `docs/operations/ENVIRONMENT.md`** to mark `RBAC_SHADOW_MODE`
   as `false` (the new default) so future readers don't think the
   shadow is still authoritative.

## Rollback

If anything explodes:

```bash
ssh root@62.72.11.231 -- "pm2 set siraGPT-api:RBAC_SHADOW_MODE true && pm2 restart siraGPT-api"
```

Shadow mode is fully reversible — no schema or data change is
involved. The cache will re-warm within a minute (default
`RBAC_CACHE_TTL_MS=60000`).

## After the sunset

A follow-up PR can:

1. Sweep `grep -rn "isSuperAdmin" backend/src/routes/` and replace
   remaining direct flag checks with `requirePermission(<code>)`.
2. Mark `User.isSuperAdmin` as deprecated in `schema.prisma` with
   a `///` comment (do NOT drop the column — that is a separate
   destructive migration far outside this PR's scope).
3. Remove the `RBAC_SHADOW_MODE` env knob entirely once 30 days have
   passed since the prod flip and no rollback was needed.

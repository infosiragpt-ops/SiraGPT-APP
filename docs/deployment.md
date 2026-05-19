# siraGPT Deployment

This document covers the production deployment pipeline, including
the **auto-rollback** path used by default and the **blue-green**
scaffold added in cycle 34.

## Standard deploy (auto-rollback)

Entry point: `.github/workflows/deploy.yml` → SSH to the VPS →
`scripts/deploy-with-rollback.sh`.

Sequence:

1. Snapshot current `git HEAD` SHA on the VPS.
2. Run `scripts/backup-db.sh` (non-fatal — logged if it fails).
3. Run `scripts/deploy-production.sh` (pull, build, migrate, restart).
4. If the deploy fails, `git reset --hard` to the previous SHA,
   rebuild frontend, `pm2 restart`, then poll `/health` for 20×2s.
5. Exit codes: `0` success, `1` deploy failed but rollback OK,
   `2` rollback failed (manual intervention).

### Pre-deploy safety check (cycle 34)

The workflow runs `node scripts/check-migration-safety.js` before
SSHing to the VPS. It scans `backend/prisma/migrations/*/migration.sql`
for destructive operations (DROP TABLE/COLUMN, ALTER COLUMN TYPE,
SET NOT NULL without DEFAULT, renames) and **fails the build**
unless the migration file contains an explicit marker:

```sql
-- migration-safety: allow-destructive reason="planned column drop"
```

Override at the workflow level by setting the env var
`MIGRATION_SAFETY_OVERRIDE=1` (use with care — break-glass only).

### Post-deploy health check

After `deploy-with-rollback.sh` returns, the workflow polls
`/health/ready` for up to 60s. A failure triggers the SSH-side
rollback automatically (handled by the script). The polling job is
marked `continue-on-error: true` for now so it never wedges a
healthy deploy while the probe is being tuned.

### Slack notifications

Deploy start/success/failure post into the channel configured for
the `${{ secrets.SLACK_DEPLOY_WEBHOOK }}` webhook (cycle 25
integration). Failures include the commit SHA and the URL of the
failing run.

## Blue-Green deploy (scaffold)

Entry point: `scripts/deploy-blue-green.sh`. Designed for
zero-downtime frontend swaps:

1. Reads currently active color from `/root/siragpt/.active-color`
   (defaults to `blue` on first run).
2. Pulls the requested `IMAGE` and starts a new container on the
   inactive color's port (`BLUE_PORT=3010` / `GREEN_PORT=3011`).
3. Polls the new container's `/health/ready` for up to
   `HEALTH_TIMEOUT_SECONDS=60`.
4. On healthy: swaps the nginx active-conf symlink, validates with
   `nginx -t`, then `nginx -s reload`. Writes the new color to
   `.active-color`.
5. On unhealthy: stops/removes the new container, leaves the old
   one serving, exits non-zero.
6. **Drain**: sleeps `DRAIN_SECONDS=30` before stopping the old
   container, giving in-flight requests time to finish.

### Required nginx layout

```
/etc/nginx/conf.d/siragpt-blue.conf     → upstream → 127.0.0.1:3010
/etc/nginx/conf.d/siragpt-green.conf    → upstream → 127.0.0.1:3011
/etc/nginx/conf.d/siragpt-active.conf   → symlink to one of the above
```

The main site config `include`s `siragpt-active.conf`. Swapping the
symlink + `nginx -s reload` is what cuts traffic over.

### Manual rollback after blue-green

Re-run the script with the previous image:

```bash
IMAGE=siragpt-frontend:<previous-sha> ./scripts/deploy-blue-green.sh
```

It will deploy the previous image to the now-inactive color and
swap back.

## Configuration validation (cycle 34)

`backend/src/utils/config-validator.js` runs at boot, before any
service init. It enforces per-environment required env vars
(`dev` / `staging` / `prod`) and warns on cross-field
misconfigurations:

- `NODE_ENV=production` + `DATABASE_URL` pointing to localhost →
  blocking error (refuses to boot).
- Short `SESSION_SECRET` / `JWT_SECRET` in production → warning.
- `CORS_ORIGIN="*"` in production → warning.
- `LOG_LEVEL=debug` in production → warning.

To extend: edit `REQUIRED_BY_ENV` / `RECOMMENDED_BY_ENV` in
`config-validator.js`.

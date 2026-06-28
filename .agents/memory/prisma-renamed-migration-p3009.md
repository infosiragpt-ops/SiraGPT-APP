---
name: Prisma renamed-migration P3009 outage
description: Why renaming an already-applied Prisma migration takes the backend down with P3009, and how to recover safely.
---

# Renaming an applied Prisma migration → P3009 → backend never boots

SiraGPT uses one shared Prisma Postgres DB (Accelerate, `accelerate.prisma-data.net`)
for BOTH dev and prod. The datasource is `env("PRISMA_DATABASE_URL")`. The backend
runs `prisma migrate deploy` at boot via `backend/scripts/start-with-migrations.js`;
on migration failure it `process.exit`s (unless `MIGRATION_NONFATAL=1`), so the
backend never binds 5050 and every `/api/*` call returns `ECONNREFUSED` → the
frontend shows "Internal Server Error" (looked like a Google-login bug, was not).

**What broke:** a merge renamed `20241125_add_model_sync_fields` →
`20250919203030_add_model_sync_fields` (identical SQL). The columns were already
applied under the OLD name, so `migrate deploy` treated the new name as a brand-new
migration, re-ran `ADD COLUMN`, and hit `42701 column "lastSynced" already exists`.
That recorded a failed row (`finished_at` NULL, `rolled_back_at` NULL) → **P3009**
blocks all future migrations on every boot.

**Why:** Prisma tracks migrations by directory NAME, not content. Renaming an
applied migration makes Prisma think it's new. The boot script's auto-rollback only
covers a hardcoded `SAFE_AUTO_ROLLBACK_MIGRATIONS` allowlist, and its `pg`-based
inspection silently failed to connect to the Accelerate URL ("could not inspect
failed prisma migrations"), so nothing self-healed.

**How to diagnose:** `cd backend && npx prisma migrate status` (works against
Accelerate; raw `pg` may not). To see WHY a migration failed, query `_prisma_migrations`
via `@prisma/client` `$queryRawUnsafe` (load env with `src/config/load-env`), reading
the `logs` column — it contains the real Postgres error code/message. Confirm the
schema's actual state (e.g. `information_schema.columns`) BEFORE choosing a fix.

**How to recover (PREFERRED — let the boot wrapper self-heal):**
`start-with-migrations.js` now auto-recovers any P3009 whose failed migration is
"auto-rollback-safe": either on the explicit allowlist OR its SQL is *provably*
idempotent-additive (`migrationSqlIsIdempotentAdditive` — every `ADD COLUMN` guarded
with `IF NOT EXISTS`, no destructive tokens, no `$$` blocks). On P3009 it marks the
failed row `rolled_back_at` (`rollbackSafeFailedMigrations`) and retries `migrate
deploy`, which re-applies the now-no-op SQL and continues. So the whole hotfix is:
1. Edit the failed migration's SQL to be idempotent (`ADD COLUMN IF NOT EXISTS ...`).
2. Verify with `node -e "require('./scripts/start-with-migrations.js').isMigrationAutoRollbackSafe('<name>')"` → must print `true`.
3. **Republish.** No manual `migrate resolve` needed — the wrapper does the rollback+retry.
Gated by `PRISMA_AUTO_ROLLBACK_SAFE_MIGRATIONS` (default on; "0" disables).

**Manual fallback (only if auto-recovery is disabled or another UNSAFE failed row exists):**
1. Make the migration idempotent FIRST (same as above).
2. `npx prisma migrate resolve --applied "<name>"` (NOT `--rolled-back`, which re-runs
   the DDL and fails again because the columns exist).
3. `npx prisma migrate deploy`; then **republish** (the live prod CONTAINER stays down
   until it reboots even though dev+prod share the DB).

**Prevention:** never rename an already-applied migration. If a rename is
unavoidable, make the SQL idempotent and reconcile `_prisma_migrations` in lockstep.

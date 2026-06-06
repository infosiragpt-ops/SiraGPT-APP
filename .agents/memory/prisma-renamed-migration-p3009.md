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

**How to recover (schema already correct — the hotfix path):**
1. Make the migration idempotent (`ADD COLUMN IF NOT EXISTS ...`) FIRST so its
   checksum aligns with a version that can never re-fail on any DB.
2. `npx prisma migrate resolve --applied "<name>"` (NOT `--rolled-back`, which would
   re-run the DDL and fail again because the columns exist).
3. `npx prisma migrate deploy` → "No pending migrations"; `migrate status` → up to date.
4. Restart the workflow; confirm `server_started` on 5050 and `/api/health` 200.
Because dev and prod share the DB, this fixes prod too — but the live prod CONTAINER
stays down until it reboots, so the user must **republish** to recover the site.

**Prevention:** never rename an already-applied migration. If a rename is
unavoidable, make the SQL idempotent and reconcile `_prisma_migrations` in lockstep.

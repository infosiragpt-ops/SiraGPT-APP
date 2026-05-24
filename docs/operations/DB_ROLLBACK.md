# Database rollback procedure

> F5 PR22 — operational steps to roll back a bad Prisma migration in
> production without losing committed user data.

## Context

Every Prisma migration in `backend/prisma/migrations/` is written as
**strictly additive** SQL (no DROP TABLE / DROP COLUMN / ALTER TYPE
/ unconstrained SET NOT NULL). The CI workflow
`scripts/check-migration-safety.js` rejects destructive operations
unless they carry an explicit `-- migration-safety: allow-destructive`
marker. This means:

- The vast majority of migrations are **reversible by data alone**,
  not by schema rollback. If a migration introduces a new table or
  column, simply not using it from application code is the rollback.
- Schema-level rollback is reserved for the rare destructive
  migration that the safety check allowed through explicitly.

## Step-by-step (additive migration gone wrong)

1. **Identify the migration** by name from `backend/prisma/migrations/`.
2. **Code rollback first.** Revert the application commit so the new
   schema bits are no longer queried. Deploy normally — production
   uses the previous binary that does not need the new schema.
3. **Leave the schema in place.** Additive tables / columns are
   harmless when unused; they cost storage but no logic depends on
   them. Schedule cleanup for a deliberate later migration.

> 95% of production rollbacks should stop at step 3. Anything beyond
> is paying ACID-rollback complexity for an additive migration that
> doesn't need it.

## Step-by-step (destructive migration gone wrong)

For migrations carrying `-- migration-safety: allow-destructive`:

1. **Stop traffic** on the affected service. PM2 `pause` the backend
   or scale the docker-compose service to zero.
2. **Snapshot pg.** `pg_dump --format=custom siragpt > rollback_$(date +%s).dump`.
3. **Manually reverse** the migration in a `psql --single-transaction`
   session using the rollback steps captured in the migration's
   header comment. Every `-- migration-safety: allow-destructive`
   migration MUST include a rollback recipe in its header.
4. **Remove the row from `_prisma_migrations`** so Prisma believes
   the migration was never applied:
   ```sql
   DELETE FROM "_prisma_migrations"
   WHERE migration_name = '<dir-name>';
   ```
5. **Re-deploy** the previous application commit.
6. **Verify** with the smoke tests in `docs/operations/PRODUCTION_CHECKLIST.md`.
7. **Post-mortem**: document what went wrong + add a regression test.

## Migration safety contract

Before a migration with `-- migration-safety: allow-destructive` can
merge, the PR description MUST include:

- The destructive operation (`DROP COLUMN x`, etc.).
- The reason it cannot be additive.
- The rollback SQL (the inverse of every destructive line).
- Confirmation that the affected data has been backed up to S3 / R2.

The default reviewer denies the PR until those four points appear
verbatim in the description.

## Backup retention

Production runs `pg_dump --format=custom` nightly into
`/root/siragpt-backups/postgres/` (kept 14 days locally + uploaded to
Cloudflare R2 with a 90-day retention). Recovery from the daily dump
is the absolute last resort — every step above tries to avoid it.

# Database rollback procedure

> F5 PR22 — operational steps to roll back a bad Prisma migration in
> production without losing committed user data.

## Context

Prisma migrations are classified before release. The CI workflow
`scripts/check-migration-safety.js` rejects known destructive operations
unless they carry an explicit `-- migration-safety: allow-destructive`
marker. DML, backfills, index construction, and security changes still require
their own review because a clean static scan does not make them reversible.
This means:

- The vast majority of migrations are **reversible by data alone**,
  not by schema rollback. If a migration introduces a new table or
  column, simply not using it from application code is the rollback.
- Schema-level rollback is reserved for the rare destructive
  migration that the safety check allowed through explicitly.

## Step-by-step (additive migration gone wrong)

1. **Identify the migration** by name from `backend/prisma/migrations/`.
2. **Verify the release checkpoint.** Every deploy must have a
   `backups/releases/siragpt_release_<sha>_*.sql.gz` file, checksum, and
   `.manifest` showing `restore_network=none` and a successful isolated
   restore before migration execution.
3. **Code rollback first.** Revert the application commit so the new
   schema bits are no longer queried. Deploy normally — production
   uses the previous binary that does not need the new schema.
4. **Leave the schema in place.** Additive tables / columns are
   harmless when unused; they cost storage but no logic depends on
   them. Schedule cleanup for a deliberate later migration.

> Most production rollbacks should stop at step 4. Anything beyond
> is paying ACID-rollback complexity for an additive migration that
> doesn't need it.

## Step-by-step (destructive migration gone wrong)

For migrations carrying `-- migration-safety: allow-destructive`:

1. **Stop traffic** on the affected service. PM2 `pause` the backend
   or scale the docker-compose service to zero.
2. **Select the verified pre-migration checkpoint.** Re-run its
   `sha256sum --check --strict` manifest and preserve the release manifest.
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

The scheduled backup workflow writes compressed SQL plus a checksum under
`/opt/siragpt/backups/`. Every deployment additionally writes a release-scoped
checkpoint under `/opt/siragpt/backups/releases/` and restores it into a
temporary PostgreSQL container with networking disabled. Migration execution
must not start if dump, checksum, restore, public-table count, or Prisma-history
validation fails.

Release checkpoints on the VPS are not an off-host disaster-recovery system.
Production must configure and monitor the approved external backup target; a
host-loss recovery claim requires a separately retained object and a periodic
restore drill from that object.

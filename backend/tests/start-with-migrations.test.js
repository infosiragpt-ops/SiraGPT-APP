const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  extractP3009MigrationNames,
  isSafeAutoRollbackMigration,
  isMigrationAutoRollbackSafe,
  migrationSqlIsIdempotentAdditive,
  makePgClientOptions,
  resolvePrismaDatabaseUrl,
  shouldContinueAfterSafeP3009,
} = require("../scripts/start-with-migrations");

const wrapperSource = fs.readFileSync(path.join(__dirname, "..", "scripts", "start-with-migrations.js"), "utf8");
const MIGRATIONS_DIR = path.join(__dirname, "..", "prisma", "migrations");

test("only explicitly allowlisted migrations are safe to auto-rollback", () => {
  assert.equal(isSafeAutoRollbackMigration("20260527000000_reset_admin_password"), true);
  assert.equal(isSafeAutoRollbackMigration("20260520160000_add_org_pending_transfer"), true);
  assert.equal(isSafeAutoRollbackMigration("20250919203030_add_model_sync_fields"), true);
  assert.equal(isSafeAutoRollbackMigration("20260526125000_add_video_model_type"), false);
  assert.equal(isSafeAutoRollbackMigration("reset_admin_password"), false);
});

test("renamed-migration P3009 (add_model_sync_fields) is now auto-recoverable", () => {
  // Root cause of the production outage: a merge renamed this migration, the
  // columns already existed under the old name, and `migrate deploy` re-ran
  // ADD COLUMN -> 42701 -> P3009 -> boot abort. The SQL is now ADD COLUMN IF
  // NOT EXISTS, so the boot wrapper must be allowed to roll back + retry it.
  assert.equal(migrationSqlIsIdempotentAdditive("20250919203030_add_model_sync_fields", MIGRATIONS_DIR), true);
  assert.equal(isMigrationAutoRollbackSafe("20250919203030_add_model_sync_fields", MIGRATIONS_DIR), true);
});

test("static analysis classifies idempotent-additive migrations as safe", () => {
  // Purely additive, guarded statements re-run as a no-op -> safe to retry.
  assert.equal(migrationSqlIsIdempotentAdditive("20260519000000_add_performance_indexes", MIGRATIONS_DIR), true);
});

test("static analysis refuses non-idempotent or non-additive migrations", () => {
  // init creates enums/tables without guards; re-running would fail.
  assert.equal(migrationSqlIsIdempotentAdditive("20250919203029_init", MIGRATIONS_DIR), false);
  // ALTER TYPE ... ADD VALUE cannot run inside a transaction -> never auto-safe.
  assert.equal(migrationSqlIsIdempotentAdditive("20260526125000_add_video_model_type", MIGRATIONS_DIR), false);
  assert.equal(isMigrationAutoRollbackSafe("20260526125000_add_video_model_type", MIGRATIONS_DIR), false);
  // Dollar-quoted (DO $$ ... $$) bodies are too complex to prove safe statically;
  // they only pass through the explicit allowlist, never the static detector.
  assert.equal(migrationSqlIsIdempotentAdditive("20260520160000_add_org_pending_transfer", MIGRATIONS_DIR), false);
  assert.equal(isMigrationAutoRollbackSafe("20260520160000_add_org_pending_transfer", MIGRATIONS_DIR), true);
});

test("static analysis rejects path traversal / unknown migration names", () => {
  assert.equal(migrationSqlIsIdempotentAdditive("../../../etc/passwd", MIGRATIONS_DIR), false);
  assert.equal(migrationSqlIsIdempotentAdditive("does_not_exist_99999", MIGRATIONS_DIR), false);
  assert.equal(migrationSqlIsIdempotentAdditive("", MIGRATIONS_DIR), false);
});

test("prisma database url takes precedence over generic database url", () => {
  assert.equal(resolvePrismaDatabaseUrl({
    PRISMA_DATABASE_URL: "postgres://prisma.example/db",
    DATABASE_URL: "postgres://generic.example/db",
  }), "postgres://prisma.example/db");
});

test("boot wrapper loads backend/root .env files before migrations", () => {
  assert.match(wrapperSource, /require\("\.\.\/src\/config\/load-env"\)/);
  assert.match(wrapperSource, /function runMigrations\(\) \{[\s\S]{0,160}loadDotenv\(\)/);
});

test("neon postgres connections are configured with ssl", () => {
  assert.deepEqual(makePgClientOptions("postgres://user:pass@ep-example.neon.tech/neondb"), {
    connectionString: "postgres://user:pass@ep-example.neon.tech/neondb",
    ssl: { rejectUnauthorized: false },
  });
});

test("safe P3009 migration output can continue boot", () => {
  const output = [
    "Error: P3009",
    "migrate found failed migrations in the target database",
    "The `20260520160000_add_org_pending_transfer` migration started at 2026-05-27 16:19:33",
  ].join("\n");

  assert.deepEqual(extractP3009MigrationNames(output), [
    "20260520160000_add_org_pending_transfer",
  ]);
  assert.equal(shouldContinueAfterSafeP3009(output), true);
  assert.equal(
    shouldContinueAfterSafeP3009("Error: P3009\nThe `20260526125000_add_video_model_type` migration started at now"),
    false,
  );
});

test("renamed add_model_sync_fields P3009 output can continue boot", () => {
  // Mirrors the exact production log line that aborted boot.
  const output = [
    "The `20250919203030_add_model_sync_fields` migration started at 2026-06-05 23:58:06.288252 UTC failed",
    "Error: P3009",
    "migrate found failed migrations in the target database, new migrations will not be applied.",
  ].join("\n");
  assert.deepEqual(extractP3009MigrationNames(output), [
    "20250919203030_add_model_sync_fields",
  ]);
  assert.equal(shouldContinueAfterSafeP3009(output), true);
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  extractP3009MigrationNames,
  isSafeAutoRollbackMigration,
  makePgClientOptions,
  resolvePrismaDatabaseUrl,
  shouldContinueAfterSafeP3009,
} = require("../scripts/start-with-migrations");

const wrapperSource = fs.readFileSync(path.join(__dirname, "..", "scripts", "start-with-migrations.js"), "utf8");

test("only explicitly allowlisted migrations are safe to auto-rollback", () => {
  assert.equal(isSafeAutoRollbackMigration("20260527000000_reset_admin_password"), true);
  assert.equal(isSafeAutoRollbackMigration("20260520160000_add_org_pending_transfer"), true);
  assert.equal(isSafeAutoRollbackMigration("20260526125000_add_video_model_type"), false);
  assert.equal(isSafeAutoRollbackMigration("reset_admin_password"), false);
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

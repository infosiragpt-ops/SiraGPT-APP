const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isSafeDataOnlyRollbackMigration,
  makePgClientOptions,
  resolvePrismaDatabaseUrl,
} = require("../scripts/start-with-migrations");

test("only reset-admin-password data migrations are safe to auto-rollback", () => {
  assert.equal(isSafeDataOnlyRollbackMigration("20260527000000_reset_admin_password"), true);
  assert.equal(isSafeDataOnlyRollbackMigration("20260526125000_add_video_model_type"), false);
  assert.equal(isSafeDataOnlyRollbackMigration("reset_admin_password"), false);
});

test("prisma database url takes precedence over generic database url", () => {
  assert.equal(resolvePrismaDatabaseUrl({
    PRISMA_DATABASE_URL: "postgres://prisma.example/db",
    DATABASE_URL: "postgres://generic.example/db",
  }), "postgres://prisma.example/db");
});

test("neon postgres connections are configured with ssl", () => {
  assert.deepEqual(makePgClientOptions("postgres://user:pass@ep-example.neon.tech/neondb"), {
    connectionString: "postgres://user:pass@ep-example.neon.tech/neondb",
    ssl: { rejectUnauthorized: false },
  });
});

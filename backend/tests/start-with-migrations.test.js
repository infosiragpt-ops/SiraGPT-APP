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
  isDirectPostgresUrl,
  computeAdvisoryLockKeys,
  preflightDatabase,
  acquireMigrationLock,
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

test("direct DATABASE_URL takes precedence over PRISMA_DATABASE_URL", () => {
  // Since "Improve database connection logic for migration checks": the
  // schema uses DATABASE_URL directly, so the migration preflight favours
  // the direct PostgreSQL connection; PRISMA_DATABASE_URL (formerly Prisma
  // Accelerate) is only a fallback.
  assert.equal(resolvePrismaDatabaseUrl({
    PRISMA_DATABASE_URL: "postgres://prisma.example/db",
    DATABASE_URL: "postgres://generic.example/db",
  }), "postgres://generic.example/db");
  assert.equal(resolvePrismaDatabaseUrl({
    PRISMA_DATABASE_URL: "postgres://prisma.example/db",
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

// ── Boot v2: preflight + advisory lock ─────────────────────────────────────

test("isDirectPostgresUrl only accepts dialable postgres URLs", () => {
  assert.equal(isDirectPostgresUrl("postgres://u:p@h:5432/db"), true);
  assert.equal(isDirectPostgresUrl("postgresql://u:p@h/db"), true);
  assert.equal(isDirectPostgresUrl("  postgres://h/db  "), true);
  // Accelerate / Data Proxy cannot be dialed by `pg` — must be excluded so
  // preflight/lock skip fast instead of retrying forever.
  assert.equal(isDirectPostgresUrl("prisma://accelerate.prisma-data.net/?api_key=x"), false);
  assert.equal(isDirectPostgresUrl(""), false);
  assert.equal(isDirectPostgresUrl(undefined), false);
  assert.equal(isDirectPostgresUrl(null), false);
});

test("computeAdvisoryLockKeys is deterministic, int4-ranged and name-sensitive", () => {
  const inInt4 = (n) => Number.isInteger(n) && n >= -2147483648 && n <= 2147483647;
  const a = computeAdvisoryLockKeys("siragpt:prisma-migrate-deploy");
  const b = computeAdvisoryLockKeys("siragpt:prisma-migrate-deploy");
  const c = computeAdvisoryLockKeys("different");
  assert.equal(a.length, 2);
  assert.ok(inInt4(a[0]) && inInt4(a[1]), "both keys must be valid Postgres int4");
  assert.notEqual(a[0], a[1]);
  assert.deepEqual(a, b, "same name -> same keys on every instance");
  assert.notDeepEqual(a, c, "different name -> different keys");
});

test("preflightDatabase retries transient failures then succeeds", async () => {
  let calls = 0;
  const ok = await preflightDatabase({
    attempts: 5, delayMs: 0, sleepFn: async () => {}, logFn: () => {},
    connect: async () => { calls += 1; if (calls < 3) throw new Error("starting up"); },
  });
  assert.equal(ok, true);
  assert.equal(calls, 3);
});

test("preflightDatabase gives up after exhausting attempts (never hangs)", async () => {
  let calls = 0;
  const ok = await preflightDatabase({
    attempts: 4, delayMs: 0, sleepFn: async () => {}, logFn: () => {},
    connect: async () => { calls += 1; throw new Error("down"); },
  });
  assert.equal(ok, false);
  assert.equal(calls, 4);
});

test("acquireMigrationLock acquires, then release() unlocks and closes", async () => {
  const sql = [];
  const fakeClient = {
    connect: async () => {},
    query: async (q) => { sql.push(q); return /pg_try_advisory_lock/.test(q) ? { rows: [{ locked: true }] } : { rows: [] }; },
    end: async () => { sql.push("END"); },
  };
  const release = await acquireMigrationLock({ clientFactory: () => fakeClient, sleepFn: async () => {}, logFn: () => {}, keys: [1, 2] });
  assert.equal(typeof release, "function");
  await release();
  assert.ok(sql.some((q) => /pg_try_advisory_lock/.test(q)), "must attempt advisory lock");
  assert.ok(sql.some((q) => /pg_advisory_unlock/.test(q)), "must release advisory lock");
  assert.ok(sql.includes("END"), "must close the lock connection");
});

test("acquireMigrationLock waits while the lock is held by another instance", async () => {
  let tries = 0;
  const client = {
    connect: async () => {},
    query: async (q) => { if (/pg_try_advisory_lock/.test(q)) { tries += 1; return { rows: [{ locked: tries >= 3 }] }; } return { rows: [] }; },
    end: async () => {},
  };
  const release = await acquireMigrationLock({ clientFactory: () => client, sleepFn: async () => {}, logFn: () => {}, keys: [1, 2] });
  assert.ok(tries >= 3, "must poll until the lock frees");
  await release();
});

test("acquireMigrationLock is best-effort: connect failure yields a no-op release, never throws", async () => {
  const release = await acquireMigrationLock({
    clientFactory: () => ({ connect: async () => { throw new Error("no db"); }, query: async () => {}, end: async () => {} }),
    logFn: () => {},
  });
  assert.equal(typeof release, "function");
  await release(); // must not throw
});

test("acquireMigrationLock gives up at the deadline without hanging boot", async () => {
  // Lock is never free; a monotonically advancing clock must trip the deadline.
  let t = 0;
  const client = {
    connect: async () => {},
    query: async (q) => (/pg_try_advisory_lock/.test(q) ? { rows: [{ locked: false }] } : { rows: [] }),
    end: async () => {},
  };
  const release = await acquireMigrationLock({
    clientFactory: () => client,
    timeoutMs: 50,
    pollMs: 10,
    sleepFn: async () => { t += 20; },
    now: () => t,
    logFn: () => {},
    keys: [1, 2],
  });
  assert.equal(typeof release, "function");
  await release();
});

test("boot wrapper exposes structured phase events and gated preflight/lock", () => {
  // Observability + safety contract: phase() emits boot_phase events and the
  // new behaviours are env-gated and fail-safe.
  assert.match(wrapperSource, /event:\s*"boot_phase"/);
  assert.match(wrapperSource, /MIGRATION_ADVISORY_LOCK_DISABLED/);
  assert.match(wrapperSource, /MIGRATION_PREFLIGHT_DISABLED/);
  assert.match(wrapperSource, /pg_try_advisory_lock/);
});

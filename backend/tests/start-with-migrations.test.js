const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  extractP3009MigrationNames,
  isSafeAutoRollbackMigration,
  isMigrationAutoRollbackSafe,
  migrationSqlIsIdempotentAdditive,
  makePgClientOptions,
  resolvePrismaDatabaseUrl,
  synchronizePrismaDatabaseUrl,
  shouldContinueAfterSafeP3009,
  isDirectPostgresUrl,
  computeAdvisoryLockKeys,
  preflightDatabase,
  defaultPreflightConnect,
  acquireMigrationLock,
  forwardShutdownToBackend,
  runPrisma,
  pipeResult,
  prismaCommandExitStatus,
  resolveMigrationCommandTimeoutMs,
  resolveMigrationPgTimeoutConfig,
  runMigrationOnly,
  isTransientMigrationError,
  sanitizePgFailure,
  shouldAllowNonfatalMigrationFailure,
  DIRECT_DATABASE_URL_REQUIRED_CODE,
  MIGRATION_COMMAND_TIMEOUT_CODE,
  MIGRATION_COMMAND_OUTPUT_LIMIT_CODE,
  MIGRATION_PROCESS_TREE_NOT_TERMINATED_CODE,
} = require("../scripts/start-with-migrations");

const wrapperSource = fs.readFileSync(path.join(__dirname, "..", "scripts", "start-with-migrations.js"), "utf8");
const backendIndexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
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
  assert.equal(migrationSqlIsIdempotentAdditive("20260629033000_add_custom_gpt_capabilities", MIGRATIONS_DIR), true);
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

test("migration startup uses canonical PRISMA_DATABASE_URL with DATABASE_URL fallback", () => {
  assert.equal(resolvePrismaDatabaseUrl({
    PRISMA_DATABASE_URL: "  postgres://canonical.example/db  ",
  }), "postgres://canonical.example/db");
  assert.equal(resolvePrismaDatabaseUrl({
    DATABASE_URL: "  postgres://fallback.example/db  ",
  }), "postgres://fallback.example/db");
});

test("migration startup keeps Accelerate runtime separate from its direct URL", () => {
  const env = {
    PRISMA_DATABASE_URL: "  prisma+postgres://accelerate.prisma-data.net/?api_key=runtime-secret  ",
    DIRECT_DATABASE_URL: "  postgres://migration-user:migration-secret@db.internal/app  ",
  };

  assert.equal(resolvePrismaDatabaseUrl(env), "postgres://migration-user:migration-secret@db.internal/app");
  assert.equal(synchronizePrismaDatabaseUrl(env), "postgres://migration-user:migration-secret@db.internal/app");
  assert.equal(
    env.PRISMA_DATABASE_URL,
    "prisma+postgres://accelerate.prisma-data.net/?api_key=runtime-secret",
  );
  assert.equal(env.DIRECT_DATABASE_URL, "postgres://migration-user:migration-secret@db.internal/app");
  assert.equal(env.DATABASE_URL, "postgres://migration-user:migration-secret@db.internal/app");
});

test("migration startup rejects remote runtime without a direct URL using a value-free code", () => {
  const remote = "prisma+postgres://accelerate.invalid/?api_key=runtime-ultra-secret";
  assert.equal(DIRECT_DATABASE_URL_REQUIRED_CODE, "DIRECT_DATABASE_URL_REQUIRED");

  assert.throws(
    () => synchronizePrismaDatabaseUrl({ PRISMA_DATABASE_URL: remote }),
    (error) => {
      assert.equal(error.code, DIRECT_DATABASE_URL_REQUIRED_CODE);
      assert.equal(error.exitStatus, 78);
      assert.doesNotMatch(
        `${error.message}\n${error.stack}`,
        /accelerate\.invalid|runtime-ultra-secret/,
      );
      return true;
    },
  );
});

test("remote-only migration runner exits nonzero with a redacted configuration code", () => {
  const remote = "prisma+postgres://accelerate.invalid/?api_key=runtime-ultra-secret";
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      "require('./scripts/start-with-migrations').runMigrations()"
        + ".then((status) => process.exit(status))"
        + ".catch(() => process.exit(70));",
    ],
    {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        PRISMA_DATABASE_URL: remote,
        DIRECT_DATABASE_URL: "",
        DATABASE_URL: "",
      },
    },
  );

  assert.equal(child.status, 78, `${child.stdout}\n${child.stderr}`);
  assert.match(`${child.stdout}\n${child.stderr}`, /DIRECT_DATABASE_URL_REQUIRED/);
  assert.doesNotMatch(
    `${child.stdout}\n${child.stderr}`,
    /accelerate\.invalid|runtime-ultra-secret/,
  );
});

test("MIGRATION_NONFATAL cannot bypass a direct database configuration failure", () => {
  assert.equal(
    shouldAllowNonfatalMigrationFailure(78, { MIGRATION_NONFATAL: "1" }),
    false,
  );
  assert.equal(
    shouldAllowNonfatalMigrationFailure(1, { MIGRATION_NONFATAL: "1" }),
    true,
  );
  assert.equal(
    shouldAllowNonfatalMigrationFailure(1, {}),
    false,
  );
  for (const terminalStatus of [124, 125, 126, 143]) {
    assert.equal(
      shouldAllowNonfatalMigrationFailure(terminalStatus, { MIGRATION_NONFATAL: "1" }),
      false,
      `terminal process-control status ${terminalStatus} must remain fatal`,
    );
  }
});

test("migration startup rejects divergent aliases without exposing credentials", () => {
  assert.throws(
    () => resolvePrismaDatabaseUrl({
      PRISMA_DATABASE_URL: "postgres://canonical-user:canonical-secret@canonical.example/db",
      DATABASE_URL: "postgres://legacy-user:legacy-secret@legacy.example/db",
    }),
    (error) => {
      assert.equal(error.code, "DATABASE_RUNTIME_URL_CONFLICT");
      assert.doesNotMatch(
        `${error.message}\n${error.stack}`,
        /canonical-user|canonical-secret|canonical\.example|legacy-user|legacy-secret|legacy\.example/,
      );
      return true;
    },
  );
});

test("migration startup synchronizes Prisma CLI's DATABASE_URL to the canonical value", () => {
  assert.equal(typeof synchronizePrismaDatabaseUrl, "function");
  const env = {
    PRISMA_DATABASE_URL: "  postgres://canonical.example/db  ",
  };
  assert.equal(synchronizePrismaDatabaseUrl(env), "postgres://canonical.example/db");
  assert.equal(env.PRISMA_DATABASE_URL, "postgres://canonical.example/db");
  assert.equal(env.DATABASE_URL, "postgres://canonical.example/db");
});

test("boot wrapper loads backend/root .env files before migrations", () => {
  assert.match(wrapperSource, /require\("\.\.\/src\/config\/load-env"\)/);
  assert.match(wrapperSource, /function runMigrations\(\) \{[\s\S]{0,160}loadDotenv\(\)/);
  assert.doesNotMatch(
    wrapperSource,
    /const MIGRATION_(?:TRANSIENT_RETRIES|RETRY_DELAY_MS|PREFLIGHT_ATTEMPTS|PREFLIGHT_DELAY_MS|LOCK_TIMEOUT_MS|LOCK_POLL_MS)\s*=\s*parseBoundedTimeout\(\s*process\.env\./,
    "dotenv-backed timing values must not be frozen before loadDotenv runs",
  );
});

test("migration-only mode shares lock, migration, and release lifecycle without starting backend", async () => {
  const calls = [];
  const status = await runMigrationOnly({
    installSignalHandlers: false,
    loadEnvFn: () => calls.push("dotenv"),
    runGenerateImpl: async () => {
      calls.push("generate");
      return 0;
    },
    maybePreflightAndLockImpl: async () => {
      calls.push("lock");
      return async () => calls.push("release");
    },
    runMigrationsImpl: async () => {
      calls.push("migrate");
      return 0;
    },
    phaseFn: () => {},
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, ["dotenv", "generate", "lock", "migrate", "release"]);
  assert.equal(wrapperSource.includes("--migrate-only"), true);
});

test("neon postgres connections are configured with ssl", () => {
  assert.deepEqual(makePgClientOptions(
    "postgres://user:pass@ep-example.neon.tech/neondb",
    {
      MIGRATION_DB_CONNECT_TIMEOUT_MS: "321",
      MIGRATION_DB_QUERY_TIMEOUT_MS: "654",
      MIGRATION_DB_STATEMENT_TIMEOUT_MS: "987",
    },
  ), {
    connectionString: "postgres://user:pass@ep-example.neon.tech/neondb",
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 321,
    query_timeout: 654,
    statement_timeout: 987,
  });
});

test("migration timeout configuration is strict, bounded, and never disables deadlines", () => {
  assert.equal(resolveMigrationCommandTimeoutMs({ MIGRATION_COMMAND_TIMEOUT_MS: "41" }), 41);
  assert.equal(resolveMigrationCommandTimeoutMs({ MIGRATION_COMMAND_TIMEOUT_MS: "not-a-number" }), 300_000);
  assert.equal(resolveMigrationCommandTimeoutMs({ MIGRATION_COMMAND_TIMEOUT_MS: "0" }), 1);

  assert.deepEqual(resolveMigrationPgTimeoutConfig({
    MIGRATION_DB_CONNECT_TIMEOUT_MS: "1200",
    MIGRATION_DB_QUERY_TIMEOUT_MS: "2300",
    MIGRATION_DB_STATEMENT_TIMEOUT_MS: "3400",
  }), {
    connectionTimeoutMs: 1200,
    queryTimeoutMs: 2300,
    statementTimeoutMs: 3400,
  });
});

test("Prisma subprocess receives the resolved direct URL and bounded timeout", async () => {
  let childOptions;
  let childCommand;
  const runtimeUrl = "prisma+postgres://accelerate.invalid/?api_key=runtime-secret";
  const directUrl = "postgres://migration-user:migration-secret@db.internal/app";
  const result = await runPrisma(["generate"], {
    env: {
      PRISMA_DATABASE_URL: runtimeUrl,
      DIRECT_DATABASE_URL: directUrl,
      MIGRATION_COMMAND_TIMEOUT_MS: "321",
    },
    pipe: false,
    runProcessImpl: async (command, args, options) => {
      childCommand = { command, args };
      childOptions = options;
      return {
        status: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        aborted: false,
        outputLimitExceeded: false,
        treeTerminated: true,
      };
    },
  });

  assert.equal(result.status, 0);
  assert.deepEqual(childCommand, { command: "npx", args: ["prisma", "generate"] });
  assert.equal(childOptions.timeoutMs, 321);
  assert.equal(childOptions.env.DATABASE_URL, directUrl);
  assert.equal(childOptions.env.DIRECT_DATABASE_URL, directUrl);
  assert.equal(childOptions.env.PRISMA_DATABASE_URL, runtimeUrl);
});

test("hung Prisma child is killed at MIGRATION_COMMAND_TIMEOUT_MS with actionable status", async () => {
  const startedAt = Date.now();
  const result = await runPrisma(
    ["-e", "setInterval(() => {}, 1000)"],
    {
      command: process.execPath,
      commandPrefix: [],
      cwd: __dirname,
      env: {
        PRISMA_DATABASE_URL: "postgres://migration-user:migration-secret@db.internal/app",
        MIGRATION_COMMAND_TIMEOUT_MS: "40",
      },
      pipe: false,
    },
  );

  assert.equal(result.migrationCode, MIGRATION_COMMAND_TIMEOUT_CODE);
  assert.equal(MIGRATION_COMMAND_TIMEOUT_CODE, "MIGRATION_COMMAND_TIMEOUT");
  assert.equal(prismaCommandExitStatus(result), 124);
  assert.ok(Date.now() - startedAt < 2_000, "hung child must not hold boot indefinitely");
});

test("process-control migration failures stay terminal despite transient output markers", () => {
  assert.equal(typeof isTransientMigrationError, "function");
  const transientOutput = "P1000 ECONNRESET ETIMEDOUT TLS connection unexpected EOF";
  const terminalResults = [
    {
      migrationCode: MIGRATION_COMMAND_TIMEOUT_CODE,
      status: null,
      timedOut: true,
      stdout: transientOutput,
    },
    {
      migrationCode: MIGRATION_COMMAND_OUTPUT_LIMIT_CODE,
      status: null,
      outputLimitExceeded: true,
      stderr: transientOutput,
    },
    {
      migrationCode: MIGRATION_PROCESS_TREE_NOT_TERMINATED_CODE,
      status: null,
      treeTerminated: false,
      stdout: transientOutput,
    },
  ];

  for (const result of terminalResults) {
    assert.notEqual(prismaCommandExitStatus(result), 0);
    assert.equal(isTransientMigrationError(result), false);
  }
  assert.equal(
    isTransientMigrationError({ status: 1, stderr: transientOutput }),
    true,
    "ordinary transient Prisma failures retain the existing fallback policy",
  );
});

test("migration subprocess output redacts every configured database URL", () => {
  const env = {
    PRISMA_DATABASE_URL: "prisma+postgres://accelerate.invalid/?api_key=runtime-secret",
    DIRECT_DATABASE_URL: "postgres://migration-user:migration-secret@db.internal/app",
  };
  const writes = [];
  const sink = { write: (value) => writes.push(String(value)) };

  pipeResult({
    stdout: `runtime=${env.PRISMA_DATABASE_URL}\n`,
    stderr: `direct=${env.DIRECT_DATABASE_URL}\n`,
  }, { env, stdout: sink, stderr: sink });

  const output = writes.join("");
  assert.match(output, /\[REDACTED_DATABASE_URL\]/);
  assert.doesNotMatch(
    output,
    /accelerate\.invalid|runtime-secret|migration-user|migration-secret|db\.internal/,
  );
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

test("preflightDatabase bounds an injected hung connect operation", { timeout: 1_000 }, async () => {
  const startedAt = Date.now();
  const ok = await preflightDatabase({
    attempts: 1,
    operationTimeoutMs: 25,
    connect: async () => new Promise(() => {}),
    sleepFn: async () => {},
    logFn: () => {},
  });

  assert.equal(ok, false);
  assert.ok(Date.now() - startedAt < 1_000, "preflight must time out a hung connect");
});

test("default preflight closes the pg client after a hung query", { timeout: 1_000 }, async () => {
  let ended = false;
  const client = {
    connect: async () => {},
    query: async () => new Promise(() => {}),
    end: async () => { ended = true; },
  };
  const startedAt = Date.now();

  await assert.rejects(
    defaultPreflightConnect({
      url: "postgres://migration-user:migration-secret@db.internal/app",
      clientFactory: () => client,
      operationTimeoutMs: 25,
      closeTimeoutMs: 25,
    }),
    (error) => {
      assert.equal(error.code, "MIGRATION_DB_OPERATION_TIMEOUT");
      assert.doesNotMatch(
        `${error.message}\n${error.stack}`,
        /migration-user|migration-secret|db\.internal/,
      );
      return true;
    },
  );
  assert.equal(ended, true);
  assert.ok(Date.now() - startedAt < 1_000, "query timeout and cleanup must be bounded");
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

test("migration lock deadline includes a hung pg connect and closes the client", { timeout: 1_000 }, async () => {
  let ended = false;
  const startedAt = Date.now();
  const release = await acquireMigrationLock({
    clientFactory: () => ({
      connect: async () => new Promise(() => {}),
      query: async () => ({ rows: [] }),
      end: async () => { ended = true; },
    }),
    timeoutMs: 25,
    closeTimeoutMs: 25,
    logFn: () => {},
  });

  assert.equal(typeof release, "function");
  assert.equal(ended, true);
  assert.ok(Date.now() - startedAt < 1_000, "lock connect must share the acquisition deadline");
  await release();
});

test("migration lock deadline bounds a hung lock query and releases resources", { timeout: 1_000 }, async () => {
  let ended = false;
  const startedAt = Date.now();
  const release = await acquireMigrationLock({
    clientFactory: () => ({
      connect: async () => {},
      query: async () => new Promise(() => {}),
      end: async () => { ended = true; },
    }),
    timeoutMs: 25,
    closeTimeoutMs: 25,
    logFn: () => {},
    keys: [1, 2],
  });

  assert.equal(typeof release, "function");
  assert.equal(ended, true);
  assert.ok(Date.now() - startedAt < 1_000, "lock query must share the acquisition deadline");
  await release();
});

test("migration lock release bounds a hung unlock query and still closes the client", { timeout: 1_000 }, async () => {
  let ended = false;
  let queryCount = 0;
  const client = {
    connect: async () => {},
    query: async () => {
      queryCount += 1;
      if (queryCount === 1) return { rows: [{ locked: true }] };
      return new Promise(() => {});
    },
    end: async () => { ended = true; },
  };
  const release = await acquireMigrationLock({
    clientFactory: () => client,
    timeoutMs: 1_000,
    operationTimeoutMs: 25,
    closeTimeoutMs: 25,
    logFn: () => {},
    keys: [1, 2],
  });
  const startedAt = Date.now();

  await release();

  assert.equal(ended, true);
  assert.ok(Date.now() - startedAt < 1_000, "unlock and cleanup must be bounded");
});

test("pg failures collapse to stable value-free codes", async () => {
  const secretMessage = "getaddrinfo ENOTFOUND db-user@secret-db.internal";
  assert.deepEqual(
    sanitizePgFailure(
      Object.assign(new Error(secretMessage), { code: "ENOTFOUND" }),
      "MIGRATION_DB_PREFLIGHT_FAILED",
    ),
    { code: "MIGRATION_DB_DNS_FAILED" },
  );

  const events = [];
  const ok = await preflightDatabase({
    attempts: 1,
    connect: async () => {
      throw Object.assign(new Error(secretMessage), { code: "ENOTFOUND" });
    },
    sleepFn: async () => {},
    logFn: (event, payload) => events.push({ event, payload }),
  });

  assert.equal(ok, false);
  assert.equal(events[0].payload.code, "MIGRATION_DB_DNS_FAILED");
  assert.equal(Object.hasOwn(events[0].payload, "error"), false);
  assert.doesNotMatch(JSON.stringify(events), /db-user|secret-db\.internal/);
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

test("Windows wrapper relays parent shutdown to backend over IPC without early taskkill", () => {
  const child = {
    connected: true,
    messages: [],
    signals: [],
    send(message, callback) {
      this.messages.push(message);
      callback?.();
    },
    kill(signal) {
      this.signals.push(signal);
    },
  };
  const request = {
    type: "siragpt:shutdown",
    reason: "host:SIGTERM",
    signal: "SIGTERM",
    desiredExitCode: 0,
  };

  assert.equal(typeof forwardShutdownToBackend, "function");
  assert.equal(forwardShutdownToBackend(child, request, { platform: "win32" }), true);
  assert.deepEqual(child.messages, [request]);
  assert.deepEqual(child.signals, []);
});

test("Unix wrapper also prefers IPC and does not duplicate it with SIGTERM", () => {
  const child = {
    connected: true,
    messages: [],
    signals: [],
    send(message, callback) {
      this.messages.push(message);
      callback?.();
    },
    kill(signal) {
      this.signals.push(signal);
    },
  };
  const request = {
    type: "siragpt:shutdown",
    reason: "host:SIGTERM",
    signal: "SIGTERM",
    desiredExitCode: 0,
  };

  assert.equal(forwardShutdownToBackend(child, request, { platform: "linux" }), true);
  assert.deepEqual(child.messages, [request]);
  assert.deepEqual(child.signals, []);
});

test("wrapper and backend index form the IPC centralized-shutdown chain", () => {
  assert.match(wrapperSource, /stdio:\s*\["inherit",\s*"inherit",\s*"inherit",\s*"ipc"\]/);
  assert.match(wrapperSource, /process\.on\(["']message["']/);
  assert.match(wrapperSource, /forwardShutdownToBackend\(child,/);
  assert.match(backendIndexSource, /process\.on\(['"]message['"]/);
  assert.match(backendIndexSource, /siragpt:shutdown/);
  assert.match(backendIndexSource, /shutdownRegistry\.shutdown\(reason\)/);
  assert.match(backendIndexSource, /process\.exit\(exitCode\)/);
  assert.ok(
    backendIndexSource.indexOf("process.on('message'") < backendIndexSource.indexOf("initAgentSystem();"),
    "backend must buffer IPC shutdown before heavy startup begins",
  );
});

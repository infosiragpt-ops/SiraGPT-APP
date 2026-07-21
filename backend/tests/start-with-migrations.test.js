const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { Client } = require("pg");

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
  maybePreflightAndLock,
  forwardShutdownToBackend,
  runPrisma,
  pipeResult,
  prismaCommandExitStatus,
  resolveMigrationCommandTimeoutMs,
  resolveMigrationPgTimeoutConfig,
  runMigrations,
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

function fakePrivateKey(label, trailingNewline = false) {
  return `-----BEGIN PRIVATE${" KEY"}-----\n${label}\n`
    + `-----END PRIVATE${" KEY"}-----${trailingNewline ? "\n" : ""}`;
}

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
  // Prefer migrations that stay index/column-only (no DO $$ blocks).
  assert.equal(migrationSqlIsIdempotentAdditive("20260713070000_add_product_quality_analytics_indexes", MIGRATIONS_DIR), true);
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
  assert.match(
    wrapperSource,
    /function runMigrations\(options = \{\}\) \{[\s\S]{0,240}if \(env === process\.env\) loadDotenv\(\)/,
  );
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
    maybePreflightAndLockImpl: async (options) => {
      assert.equal(options.strict, true);
      calls.push("lock");
      return async () => calls.push("release");
    },
    runMigrationsImpl: async (options) => {
      assert.equal(options.strict, true);
      calls.push("migrate");
      return 0;
    },
    phaseFn: () => {},
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, ["dotenv", "generate", "lock", "migrate", "release"]);
  assert.equal(wrapperSource.includes("--migrate-only"), true);
});

test("migration-only mode returns nonzero when strict preflight or lock acquisition fails", async () => {
  let migrationsRan = false;
  const status = await runMigrationOnly({
    installSignalHandlers: false,
    loadEnvFn: () => {},
    runGenerateImpl: async () => 0,
    maybePreflightAndLockImpl: async (options) => {
      assert.equal(options.strict, true);
      throw Object.assign(new Error("transient lock failure"), {
        code: "MIGRATION_LOCK_CONNECT_FAILED",
        exitStatus: 75,
      });
    },
    runMigrationsImpl: async () => {
      migrationsRan = true;
      return 0;
    },
    phaseFn: () => {},
  });

  assert.equal(status, 75);
  assert.equal(migrationsRan, false);
});

test("migration-only mode returns nonzero when strict lock release fails", async () => {
  const status = await runMigrationOnly({
    installSignalHandlers: false,
    loadEnvFn: () => {},
    runGenerateImpl: async () => 0,
    maybePreflightAndLockImpl: async () => async () => {
      throw Object.assign(new Error("unlock failed"), {
        code: "MIGRATION_LOCK_RELEASE_FAILED",
        exitStatus: 75,
      });
    },
    runMigrationsImpl: async () => 0,
    phaseFn: () => {},
  });

  assert.equal(status, 75);
});

test("migration-only mode rejects SKIP_MIGRATIONS=1 before generate, preflight, or migrate", async () => {
  const calls = [];
  const status = await runMigrationOnly({
    env: { SKIP_MIGRATIONS: "1" },
    installSignalHandlers: false,
    loadEnvFn: () => calls.push("dotenv"),
    runGenerateImpl: async () => {
      calls.push("generate");
      return 0;
    },
    maybePreflightAndLockImpl: async () => {
      calls.push("preflight");
      return async () => calls.push("release");
    },
    runMigrationsImpl: async () => {
      calls.push("migrate");
      return 0;
    },
    phaseFn: () => {},
  });

  assert.equal(status, 78);
  assert.deepEqual(calls, ["dotenv"]);
});

test("normal boot migration path may still skip migrations explicitly", async () => {
  const status = await runMigrations({
    env: { SKIP_MIGRATIONS: "1" },
    runPrismaImpl: async () => assert.fail("normal skip must not invoke Prisma"),
  });

  assert.equal(status, 0);
});

test("strict migrations return the transient Prisma failure after retries are exhausted", async () => {
  let attempts = 0;

  const status = await runMigrations({
    strict: true,
    env: {
      DIRECT_DATABASE_URL: "postgres://migration.invalid/app",
      MIGRATION_TRANSIENT_RETRIES: "2",
      MIGRATION_RETRY_DELAY_MS: "1",
    },
    runPrismaImpl: async () => {
      attempts += 1;
      return { status: 1, stdout: "", stderr: "ETIMEDOUT" };
    },
    sleepFn: async () => {},
  });

  assert.equal(attempts, 2);
  assert.equal(status, 1);
});

test("P3005 fails closed after U0 cutover even if legacy equivalent env is set", async () => {
  const calls = [];
  const logs = [];
  const status = await runMigrations({
    strict: true,
    env: {
      DIRECT_DATABASE_URL: "postgres://migration.invalid/app",
      MIGRATION_TRANSIENT_RETRIES: "1",
      MIGRATION_ALLOW_EQUIVALENT_UNBASELINED: "1",
    },
    logFn: (msg, extra = {}) => logs.push({ msg, ...extra }),
    runPrismaImpl: async (args, options) => {
      calls.push({ args, options });
      return { status: 1, stdout: "", stderr: "Error: P3005" };
    },
  });

  assert.notEqual(status, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["migrate", "deploy"]);
  assert.equal(
    logs.some((entry) => entry.code === "MIGRATION_HISTORY_BASELINE_REQUIRED"),
    true,
  );
  assert.equal(calls.some((call) => call.args.includes("diff")), false);
  assert.equal(calls.some((call) => call.args.includes("resolve")), false);
});

test("legacy equivalent-unbaselined mode is removed from the migration wrapper", async () => {
  const calls = [];
  const status = await runMigrations({
    strict: true,
    env: {
      DIRECT_DATABASE_URL: "postgres://migration.invalid/app",
      MIGRATION_TRANSIENT_RETRIES: "1",
      MIGRATION_ALLOW_EQUIVALENT_UNBASELINED: "1",
      MIGRATION_COMMAND_TIMEOUT_MS: "4321",
    },
    runPrismaImpl: async (args) => {
      calls.push(args);
      return { status: 1, stdout: "", stderr: "Error: P3005" };
    },
  });

  assert.notEqual(status, 0);
  assert.deepEqual(calls, [["migrate", "deploy"]]);
});

test("P3005 never falls through to schema-diff compatibility", async () => {
  const calls = [];
  const status = await runMigrations({
    strict: true,
    env: {
      DIRECT_DATABASE_URL: "postgres://migration.invalid/app",
      MIGRATION_TRANSIENT_RETRIES: "1",
      MIGRATION_ALLOW_EQUIVALENT_UNBASELINED: "1",
    },
    runPrismaImpl: async (args) => {
      calls.push(args);
      return { status: 1, stdout: "", stderr: "Error: P3005" };
    },
  });

  assert.notEqual(status, 0);
  assert.deepEqual(calls, [["migrate", "deploy"]]);
});

test("migration wrapper contains no automatic migrate resolve path or legacy baseline env", () => {
  const startAll = fs.readFileSync(path.join(__dirname, "..", "..", "scripts", "start-all.cjs"), "utf8");
  const deployScript = fs.readFileSync(
    path.join(__dirname, "..", "..", "scripts", "deploy-production.sh"),
    "utf8",
  );
  const deployWorkflow = fs.readFileSync(
    path.join(__dirname, "..", "..", ".github", "workflows", "deploy.yml"),
    "utf8",
  );

  for (const source of [wrapperSource, startAll, deployScript, deployWorkflow]) {
    assert.doesNotMatch(source, /PRISMA_BASELINE_(?:ON_P3005|MIGRATION)/);
    assert.doesNotMatch(source, /MIGRATION_ALLOW_EQUIVALENT_UNBASELINED/);
  }
  assert.doesNotMatch(wrapperSource, /["']migrate["']\s*,\s*["']resolve["']/);
  assert.match(deployWorkflow, /-e\s+SKIP_MIGRATIONS=0/);
  assert.match(deployWorkflow, /baseline-migration-history\.js/);
  assert.match(deployWorkflow, /deploy-production-baseline-/);

  const standardCompose = fs.readFileSync(
    path.join(__dirname, "..", "..", "docker-compose.yml"),
    "utf8",
  );
  const productionCompose = fs.readFileSync(
    path.join(__dirname, "..", "..", "docker-compose.prod.yml"),
    "utf8",
  );
  assert.match(standardCompose, /\bSKIP_MIGRATIONS:\s*["']\$\{SKIP_MIGRATIONS:-0\}["']/);
  assert.match(productionCompose, /\bSKIP_MIGRATIONS:\s*["']0["']/);
});

test("rollout docs reserve reviewed one-off migration-history baselining for U0", () => {
  const sources = [
    path.join(__dirname, "..", "..", "docs", "operations", "ENVIRONMENT.md"),
    path.join(
      __dirname,
      "..",
      "..",
      "docs",
      "plans",
      "2026-07-10-001-feat-platform-improvements-program-plan.md",
    ),
  ].map((file) => fs.readFileSync(file, "utf8"));

  for (const source of sources) {
    assert.match(source, /U0/i);
    assert.match(source, /reviewed one-off/i);
    assert.match(source, /before schema-bearing units/i);
  }
});

test("pg Client receives authoritative verified TLS after URL SSL options are removed", () => {
  const options = makePgClientOptions(
    "postgres://user:pass@ep-example.neon.tech/neondb",
    {
      MIGRATION_DB_CONNECT_TIMEOUT_MS: "321",
      MIGRATION_DB_QUERY_TIMEOUT_MS: "654",
      MIGRATION_DB_STATEMENT_TIMEOUT_MS: "987",
    },
  );
  const client = new Client(options);

  assert.deepEqual(options, {
    connectionString: "postgres://user:pass@ep-example.neon.tech/neondb",
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 321,
    query_timeout: 654,
    statement_timeout: 987,
  });
  assert.deepEqual(client.connectionParameters.ssl, { rejectUnauthorized: true });
});

test("pg Client preserves URL custom CA and client-auth files in explicit TLS", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "siragpt-db-mtls-"));
  const caPath = path.join(directory, "database-ca.pem");
  const certPath = path.join(directory, "database-client.pem");
  const keyPath = path.join(directory, "database-client.key");
  const ca = "-----BEGIN CERTIFICATE-----\nurl-ca\n-----END CERTIFICATE-----\n";
  const cert = "-----BEGIN CERTIFICATE-----\nurl-client\n-----END CERTIFICATE-----\n";
  const key = fakePrivateKey("url-key", true);
  fs.writeFileSync(caPath, ca, { mode: 0o600 });
  fs.writeFileSync(certPath, cert, { mode: 0o600 });
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const url = new URL("postgres://user:pass@db.example/app?schema=tenant_a");
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.set("sslrootcert", caPath);
  url.searchParams.set("sslcert", certPath);
  url.searchParams.set("sslkey", keyPath);
  url.searchParams.set("uselibpqcompat", "true");
  const options = makePgClientOptions(url.toString(), {});
  const sanitized = new URL(options.connectionString);
  const client = new Client(options);

  assert.equal(sanitized.searchParams.get("schema"), "tenant_a");
  for (const key of [
    "ssl",
    "sslmode",
    "sslrootcert",
    "sslcert",
    "sslkey",
    "uselibpqcompat",
  ]) {
    assert.equal(sanitized.searchParams.has(key), false, `${key} must be removed`);
  }
  assert.deepEqual(client.connectionParameters.ssl, {
    rejectUnauthorized: true,
    ca,
    cert,
  });
  assert.equal(client.connectionParameters.ssl.key, key);
});

test("pg Client accepts URL-encoded inline PEM mTLS material", () => {
  const ca = "-----BEGIN CERTIFICATE-----\ninline-url-ca\n-----END CERTIFICATE-----";
  const cert = "-----BEGIN CERTIFICATE-----\ninline-url-cert\n-----END CERTIFICATE-----";
  const key = fakePrivateKey("inline-url-key");
  const url = new URL("postgres://user:pass@db.example/app");
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.set("sslrootcert", ca);
  url.searchParams.set("sslcert", cert);
  url.searchParams.set("sslkey", key);

  const client = new Client(makePgClientOptions(url.toString(), {}));

  assert.deepEqual(client.connectionParameters.ssl, {
    rejectUnauthorized: true,
    ca,
    cert,
  });
  assert.equal(client.connectionParameters.ssl.key, key);
});

test("environment mTLS material overrides URL TLS material", () => {
  const urlCa = "-----BEGIN CERTIFICATE-----\nurl-ca\n-----END CERTIFICATE-----";
  const urlCert = "-----BEGIN CERTIFICATE-----\nurl-cert\n-----END CERTIFICATE-----";
  const urlKey = fakePrivateKey("url-key");
  const envCa = "-----BEGIN CERTIFICATE-----\nenv-ca\n-----END CERTIFICATE-----";
  const envCert = "-----BEGIN CERTIFICATE-----\nenv-cert\n-----END CERTIFICATE-----";
  const envKey = fakePrivateKey("env-key");
  const url = new URL("postgres://user:pass@db.example/app");
  url.searchParams.set("sslrootcert", urlCa);
  url.searchParams.set("sslcert", urlCert);
  url.searchParams.set("sslkey", urlKey);

  const options = makePgClientOptions(url.toString(), {
    DATABASE_SSL_CA: envCa,
    DATABASE_SSL_CERT: envCert,
    DATABASE_SSL_KEY: envKey,
  });

  const client = new Client(options);
  assert.deepEqual(client.connectionParameters.ssl, {
    rejectUnauthorized: true,
    ca: envCa,
    cert: envCert,
  });
  assert.equal(client.connectionParameters.ssl.key, envKey);
  const sanitized = new URL(options.connectionString);
  assert.equal(sanitized.searchParams.has("sslrootcert"), false);
  assert.equal(sanitized.searchParams.has("sslcert"), false);
  assert.equal(sanitized.searchParams.has("sslkey"), false);
});

test("unusable URL TLS material fails with a stable value-free code", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "siragpt-db-mtls-invalid-"));
  const missingKey = path.join(directory, "private-client-name.key");
  const oversizedCa = path.join(directory, "private-ca-name.pem");
  fs.writeFileSync(oversizedCa, Buffer.alloc((1024 * 1024) + 1, 0x61), { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  for (const [parameter, configured, expectedCode] of [
    ["sslrootcert", oversizedCa, "DATABASE_SSL_URL_CA_UNUSABLE"],
    ["sslcert", "", "DATABASE_SSL_URL_CERT_UNUSABLE"],
    ["sslkey", missingKey, "DATABASE_SSL_URL_KEY_UNUSABLE"],
  ]) {
    const url = new URL("postgres://secret-user:secret-pass@secret-db.internal/app");
    url.searchParams.set(parameter, configured);
    assert.throws(
      () => makePgClientOptions(url.toString(), {}),
      (error) => {
        assert.equal(error.code, expectedCode);
        assert.equal(error.exitStatus, 78);
        assert.doesNotMatch(
          `${error.message}\n${error.stack}`,
          /secret-user|secret-pass|secret-db|private-client-name|private-ca-name/,
        );
        return true;
      },
    );
  }
});

test("migration preflight fails before dialing on unusable URL TLS material", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "siragpt-db-preflight-tls-"));
  const missingCa = path.join(directory, "private-preflight-ca.pem");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const url = new URL("postgres://secret-user:secret-pass@secret-db.internal/app");
  url.searchParams.set("sslrootcert", missingCa);
  const events = [];

  await assert.rejects(
    () => maybePreflightAndLock({
      env: { DIRECT_DATABASE_URL: url.toString() },
      strict: true,
      phaseFn: (event, payload) => events.push({ event, payload }),
      preflightDatabaseImpl: async () => assert.fail("invalid TLS must fail before dialing"),
      acquireMigrationLockImpl: async () => assert.fail("invalid TLS must fail before locking"),
    }),
    (error) => {
      assert.equal(error.code, "DATABASE_SSL_URL_CA_UNUSABLE");
      assert.equal(error.exitStatus, 78);
      return true;
    },
  );
  assert.deepEqual(events, [{
    event: "migration_tls_configuration_rejected",
    payload: { code: "DATABASE_SSL_URL_CA_UNUSABLE" },
  }]);
  assert.doesNotMatch(
    JSON.stringify(events),
    /secret-user|secret-pass|secret-db|private-preflight-ca/,
  );
});

test("insecure or conflicting URL sslmode fails closed without explicit verification opt-out", () => {
  for (const query of [
    "sslmode=disable",
    "sslmode=no-verify",
    "sslmode=verify-full&sslmode=disable",
  ]) {
    assert.throws(
      () => makePgClientOptions(
        `postgres://secret-user:secret-pass@secret-db.internal/app?${query}`,
        {},
      ),
      (error) => {
        assert.equal(error.code, "DATABASE_SSL_MODE_INSECURE");
        assert.doesNotMatch(
          `${error.message}\n${error.stack}`,
          /secret-user|secret-pass|secret-db\.internal/,
        );
        return true;
      },
    );
  }
});

test("explicit verification opt-out is authoritative after insecure URL modes are removed", () => {
  const options = makePgClientOptions(
    "postgres://user:pass@db.example/app?sslmode=disable&ssl=no-verify",
    { DATABASE_SSL_REJECT_UNAUTHORIZED: "false" },
  );
  const client = new Client(options);

  assert.equal(new URL(options.connectionString).searchParams.has("sslmode"), false);
  assert.equal(new URL(options.connectionString).searchParams.has("ssl"), false);
  assert.deepEqual(client.connectionParameters.ssl, { rejectUnauthorized: false });

  const stillVerified = new Client(makePgClientOptions(
    "postgres://user:pass@db.example/app?sslmode=require",
    { DATABASE_SSL_REJECT_UNAUTHORIZED: "0" },
  ));
  assert.deepEqual(stillVerified.connectionParameters.ssl, { rejectUnauthorized: true });
});

test("database TLS accepts an inline CA or a CA file without exposing its path in errors", (t) => {
  const inlineCa = "-----BEGIN CERTIFICATE-----\ninline-ca\n-----END CERTIFICATE-----";
  const inlineOptions = makePgClientOptions("postgres://db.example/app?sslmode=require", {
    DATABASE_SSL_CA: inlineCa,
  });
  assert.deepEqual(
    new Client(inlineOptions).connectionParameters.ssl,
    { rejectUnauthorized: true, ca: inlineCa },
  );

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "siragpt-db-ca-"));
  const caPath = path.join(directory, "database-ca.pem");
  const fileCa = "-----BEGIN CERTIFICATE-----\nfile-ca\n-----END CERTIFICATE-----\n";
  fs.writeFileSync(caPath, fileCa, { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fileOptions = makePgClientOptions("postgres://db.example/app?sslmode=require", {
    DATABASE_SSL_CA: caPath,
  });
  assert.deepEqual(
    new Client(fileOptions).connectionParameters.ssl,
    { rejectUnauthorized: true, ca: fileCa },
  );

  const missingPath = path.join(directory, "sensitive-ca-name.pem");
  assert.throws(
    () => makePgClientOptions("postgres://db.example/app?sslmode=require", {
      DATABASE_SSL_CA: missingPath,
    }),
    (error) => {
      assert.equal(error.code, "DATABASE_SSL_CA_READ_FAILED");
      assert.doesNotMatch(`${error.message}\n${error.stack}`, /sensitive-ca-name/);
      return true;
    },
  );
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
  assert.match(backendIndexSource, /process\.exit\(finalExitCode\)/);
  assert.ok(
    backendIndexSource.indexOf("process.on('message'") < backendIndexSource.indexOf("initAgentSystem();"),
    "backend must buffer IPC shutdown before heavy startup begins",
  );
});

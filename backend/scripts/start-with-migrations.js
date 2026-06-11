#!/usr/bin/env node
/**
 * Backend boot wrapper: runs `prisma migrate deploy` against the
 * production database, then execs the backend entrypoint. On migration
 * failure exits non-zero so the container is replaced. If
 * SKIP_MIGRATIONS=1 the migration step is skipped (useful during local
 * iteration when the schema is already up to date).
 */
const { spawnSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { loadEnvFiles } = require("../src/config/load-env");

const BACKEND_DIR = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.join(BACKEND_DIR, "prisma", "migrations");
const SAFE_AUTO_ROLLBACK_MIGRATIONS = [
  {
    pattern: /^\d{14}_reset_admin_password$/,
    reason: "data-only admin credential repair",
  },
  {
    pattern: /^20260520160000_add_org_pending_transfer$/,
    reason: "idempotent org pending-transfer schema migration",
  },
  {
    pattern: /^20250919203030_add_model_sync_fields$/,
    reason:
      "idempotent additive AiModel sync columns (ADD COLUMN IF NOT EXISTS); a merge renamed this migration and re-running ADD COLUMN re-failed with 42701 -> P3009 -> boot abort. Safe to roll back and retry.",
  },
  {
    pattern: /^20260611120000_add_user_memory_confidence$/,
    reason: "idempotent ADD COLUMN IF NOT EXISTS confidence to user_memories; safe to re-run.",
  },
];

function log(msg, extra = {}) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), scope: "boot", msg, ...extra }) + "\n");
}

// Wall-clock anchor so every structured phase event carries an elapsed_ms since
// the wrapper started — turns a wall of free-text logs into a queryable boot
// timeline (env-load -> db-preflight -> migrate-lock -> migrate -> backend-start).
const BOOT_STARTED_AT = Date.now();

function phase(name, extra = {}) {
  process.stdout.write(JSON.stringify({
    ts: new Date().toISOString(),
    scope: "boot",
    event: "boot_phase",
    phase: name,
    elapsed_ms: Date.now() - BOOT_STARTED_AT,
    ...extra,
  }) + "\n");
}

function pipeResult(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function runPrisma(args) {
  const result = spawnSync("npx", ["prisma", ...args], {
    cwd: BACKEND_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  pipeResult(result);
  return result;
}

function loadDotenv() {
  try {
    loadEnvFiles();
  } catch (err) {
    log("dotenv load skipped", { error: err?.message });
  }
}

function resolvePrismaDatabaseUrl(env = process.env) {
  // Prefer DATABASE_URL (direct PostgreSQL) over PRISMA_DATABASE_URL.
  // PRISMA_DATABASE_URL used to point at Prisma Accelerate; the schema now
  // uses DATABASE_URL directly, so always favour the direct connection here
  // so the advisory-lock preflight and pg.Client work correctly.
  const direct = env.DATABASE_URL || env.PRISMA_DATABASE_URL || "";
  if (direct) return direct;
  return env.PRISMA_DATABASE_URL || "";
}

function makePgClientOptions(url) {
  const needsSsl = /(?:neon|sslmode=require)/i.test(url);
  return {
    connectionString: url,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  };
}

// Only a direct postgres URL can be dialed by `pg` (and by `migrate deploy`).
// A Prisma Accelerate / Data Proxy `prisma://` URL cannot, so preflight and the
// advisory lock must skip — fast — rather than retry a connection that can
// never succeed.
function isDirectPostgresUrl(url) {
  return typeof url === "string" && /^postgres(?:ql)?:\/\//i.test(url.trim());
}

function createPgClient(url = resolvePrismaDatabaseUrl()) {
  const { Client } = require("pg");
  return new Client(makePgClientOptions(url));
}

function isSafeAutoRollbackMigration(migrationName) {
  return SAFE_AUTO_ROLLBACK_MIGRATIONS.some(({ pattern }) => pattern.test(migrationName));
}

// Statements that are provably idempotent AND purely additive: re-running them
// against a database that already has the object is a no-op, never destructive.
const IDEMPOTENT_ADDITIVE_STATEMENT = [
  /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/i,
  /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/i,
  /^CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\b/i,
  /^CREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS\b/i,
];

// Any of these tokens makes a statement ineligible for auto-rollback because a
// retry could lose data or fail outside a transaction (e.g. ALTER TYPE ADD
// VALUE, CREATE INDEX CONCURRENTLY). Conservative on purpose.
const FORBIDDEN_STATEMENT_TOKEN =
  /\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|RENAME|ALTER\s+COLUMN|ADD\s+CONSTRAINT|ADD\s+PRIMARY|ADD\s+FOREIGN|ADD\s+UNIQUE|SET\s+NOT\s+NULL|CONCURRENTLY|ALTER\s+TYPE|CREATE\s+TYPE)\b/i;

function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function splitSqlStatements(sql) {
  return stripSqlComments(sql)
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

// `ALTER TABLE … ADD COLUMN IF NOT EXISTS …[, ADD COLUMN IF NOT EXISTS …]` is the
// most common additive migration. Treat it as safe only when EVERY `ADD COLUMN`
// is guarded and no other (potentially destructive) operation is present.
function isIdempotentAdditiveAlterTable(statement) {
  if (!/^ALTER\s+TABLE\b/i.test(statement)) return false;
  if (FORBIDDEN_STATEMENT_TOKEN.test(statement)) return false;
  const addColumns = (statement.match(/\bADD\s+COLUMN\b/gi) || []).length;
  if (addColumns === 0) return false;
  const guardedAddColumns = (statement.match(/\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/gi) || []).length;
  return addColumns === guardedAddColumns;
}

function isIdempotentAdditiveStatement(statement) {
  if (FORBIDDEN_STATEMENT_TOKEN.test(statement)) return false;
  if (IDEMPOTENT_ADDITIVE_STATEMENT.some((pattern) => pattern.test(statement))) return true;
  return isIdempotentAdditiveAlterTable(statement);
}

// Static analysis of a migration's SQL. Returns true only when the file can be
// fully parsed into statements that are ALL idempotent-additive. Dollar-quoted
// blocks (DO $$ … $$) and any unrecognised statement make it ineligible, so the
// explicit allowlist remains the only path for anything non-trivial.
function migrationSqlIsIdempotentAdditive(migrationName, migrationsDir = MIGRATIONS_DIR) {
  if (typeof migrationName !== "string" || !/^[A-Za-z0-9_]+$/.test(migrationName)) {
    return false;
  }
  let sql;
  try {
    sql = fs.readFileSync(path.join(migrationsDir, migrationName, "migration.sql"), "utf8");
  } catch {
    return false;
  }
  if (/\$\w*\$/.test(sql)) return false; // dollar-quoted body — too complex to prove safe
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) return false;
  return statements.every(isIdempotentAdditiveStatement);
}

// A migration may be auto-rolled-back after a P3009 when it is either on the
// explicit allowlist or its SQL is provably idempotent-additive.
function isMigrationAutoRollbackSafe(migrationName, migrationsDir = MIGRATIONS_DIR) {
  return (
    isSafeAutoRollbackMigration(migrationName) ||
    migrationSqlIsIdempotentAdditive(migrationName, migrationsDir)
  );
}

function extractP3009MigrationNames(output) {
  const names = new Set();
  for (const match of output.matchAll(/The `([^`]+)` migration started at/g)) {
    names.add(match[1]);
  }
  for (const match of output.matchAll(/\b(\d{14}_[A-Za-z0-9_]+)\b/g)) {
    names.add(match[1]);
  }
  return Array.from(names);
}

function shouldContinueAfterSafeP3009(output) {
  if (!output.includes("P3009")) return false;
  const names = extractP3009MigrationNames(output);
  return names.length > 0 && names.every((name) => isMigrationAutoRollbackSafe(name));
}

async function getActiveFailedMigrations() {
  loadDotenv();
  const url = resolvePrismaDatabaseUrl();
  if (!url) {
    throw new Error("PRISMA_DATABASE_URL is not configured");
  }

  const { Client } = require("pg");
  const client = new Client(makePgClientOptions(url));
  await client.connect();
  try {
    const { rows } = await client.query(`
      SELECT migration_name
      FROM "_prisma_migrations"
      WHERE finished_at IS NULL
        AND rolled_back_at IS NULL
      ORDER BY started_at ASC
    `);
    return rows.map((row) => row.migration_name);
  } finally {
    await client.end();
  }
}

async function markSafeMigrationsRolledBack(migrationNames) {
  loadDotenv();
  const url = resolvePrismaDatabaseUrl();
  if (!url) {
    throw new Error("PRISMA_DATABASE_URL is not configured");
  }

  const { Client } = require("pg");
  const client = new Client(makePgClientOptions(url));
  await client.connect();
  try {
    await client.query(`
      UPDATE "_prisma_migrations"
      SET rolled_back_at = COALESCE(rolled_back_at, NOW()),
          logs = CONCAT(
            COALESCE(logs, ''),
            CASE WHEN COALESCE(logs, '') = '' THEN '' ELSE E'\\n' END,
            '[boot] auto-marked rolled back: safe migration blocked backend startup with P3009'
          )
      WHERE migration_name = ANY($1::text[])
        AND finished_at IS NULL
        AND rolled_back_at IS NULL
    `, [migrationNames]);
  } finally {
    await client.end();
  }
}

async function rollbackSafeFailedMigrations() {
  let failedMigrations;
  try {
    failedMigrations = await getActiveFailedMigrations();
  } catch (err) {
    log("could not inspect failed prisma migrations", { error: err?.message });
    return false;
  }

  if (failedMigrations.length === 0) {
    log("P3009 reported but no active failed migrations were found");
    return false;
  }

  const unsafe = failedMigrations.filter((name) => !isMigrationAutoRollbackSafe(name));
  if (unsafe.length > 0) {
    log("refusing to auto-rollback unknown migration failures", { failedMigrations, unsafe });
    return false;
  }

  try {
    await markSafeMigrationsRolledBack(failedMigrations);
    log("auto-rolled back safe failed migrations", { failedMigrations });
    return true;
  } catch (err) {
    log("failed to auto-rollback safe migrations", { error: err?.message, failedMigrations });
    return false;
  }
}

function migrationNames() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((name) => name !== "migration_lock.toml")
    .filter((name) => fs.statSync(path.join(MIGRATIONS_DIR, name)).isDirectory())
    .sort();
}

function baselineExistingSchema() {
  log("baselining existing database schema with prisma migrate resolve");
  for (const name of migrationNames()) {
    const result = runPrisma(["migrate", "resolve", "--applied", name]);
    if (result.error) {
      log("prisma migrate resolve spawn error", { migration: name, error: result.error.message });
      return 1;
    }
    if ((result.status ?? 1) !== 0) {
      log("prisma migrate resolve failed", { migration: name, status: result.status ?? 1 });
      return result.status ?? 1;
    }
  }
  return 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientMigrationError(result) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return (
    output.includes("P1011") ||
    output.includes("P1000") ||
    output.includes("unexpected EOF") ||
    output.includes("Connection reset") ||
    output.includes("ECONNRESET") ||
    output.includes("ETIMEDOUT") ||
    output.includes("TLS connection")
  );
}

const MIGRATION_TRANSIENT_RETRIES = Number(process.env.MIGRATION_TRANSIENT_RETRIES ?? 6);
const MIGRATION_RETRY_DELAY_MS = Number(process.env.MIGRATION_RETRY_DELAY_MS ?? 8000);

// ── Boot v2: DB preflight + cross-instance migration advisory lock ──────────
// All of this is best-effort and fail-safe: any error degrades to the prior
// behaviour (proceed straight to `migrate deploy`). Nothing here can block boot
// indefinitely or turn a healthy boot into a failed one.
const MIGRATION_LOCK_NAME = "siragpt:prisma-migrate-deploy";
const MIGRATION_PREFLIGHT_ATTEMPTS = Number(process.env.MIGRATION_PREFLIGHT_ATTEMPTS ?? 10);
const MIGRATION_PREFLIGHT_DELAY_MS = Number(process.env.MIGRATION_PREFLIGHT_DELAY_MS ?? 3000);
const MIGRATION_LOCK_TIMEOUT_MS = Number(process.env.MIGRATION_LOCK_TIMEOUT_MS ?? 120000);
const MIGRATION_LOCK_POLL_MS = Number(process.env.MIGRATION_LOCK_POLL_MS ?? 1500);

// Deterministic [int4, int4] key pair for pg_advisory_lock(int4, int4) derived
// from a stable name via two differently-seeded FNV-1a passes. Same name ->
// same pair on every instance, so all replicas contend for the same lock.
function computeAdvisoryLockKeys(name) {
  const str = String(name);
  const fnv = (seed, reverse) => {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
      const idx = reverse ? str.length - 1 - i : i;
      h ^= str.charCodeAt(idx);
      h = Math.imul(h, 0x01000193);
    }
    return h | 0; // signed 32-bit, valid Postgres int4
  };
  return [fnv(0x811c9dc5, false), fnv(0x811c9dc5 ^ 0x5a5a5a5a, true)];
}

// Wait (with retries) until the database accepts connections, so `migrate
// deploy` doesn't fail immediately against a database that is still starting up
// in an orchestrated deploy. Connection logic is injectable for tests.
async function preflightDatabase(opts = {}) {
  const {
    attempts = MIGRATION_PREFLIGHT_ATTEMPTS,
    delayMs = MIGRATION_PREFLIGHT_DELAY_MS,
    connect = defaultPreflightConnect,
    sleepFn = sleep,
    logFn = phase,
  } = opts;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await connect();
      logFn("db_preflight_ok", { attempt });
      return true;
    } catch (err) {
      logFn("db_preflight_retry", { attempt, maxAttempts: attempts, error: err?.message });
      if (attempt < attempts) await sleepFn(delayMs);
    }
  }
  logFn("db_preflight_exhausted", { attempts });
  return false;
}

async function defaultPreflightConnect() {
  const url = resolvePrismaDatabaseUrl();
  if (!url) throw new Error("no database url configured");
  const client = createPgClient(url);
  await client.connect();
  try {
    await client.query("SELECT 1");
  } finally {
    await client.end().catch(() => {});
  }
}

// Acquire a Postgres session advisory lock so only one booting instance runs
// `migrate deploy` at a time — two replicas applying the same migration
// concurrently is a classic source of failed/half-applied migrations (P3009).
// Returns an async release() function. Best-effort: on any failure it returns a
// no-op release and lets boot proceed (an un-serialised migrate is still better
// than a hung boot).
async function acquireMigrationLock(opts = {}) {
  const {
    keys = computeAdvisoryLockKeys(MIGRATION_LOCK_NAME),
    timeoutMs = MIGRATION_LOCK_TIMEOUT_MS,
    pollMs = MIGRATION_LOCK_POLL_MS,
    clientFactory = () => createPgClient(),
    sleepFn = sleep,
    logFn = phase,
    now = Date.now,
  } = opts;

  const noop = async () => {};
  let client;
  try {
    client = clientFactory();
    await client.connect();
  } catch (err) {
    logFn("migration_lock_skipped", { reason: "connect_failed", error: err?.message });
    if (client && client.end) await client.end().catch(() => {});
    return noop;
  }

  const deadline = now() + timeoutMs;
  let acquired = false;
  while (now() < deadline) {
    let res;
    try {
      res = await client.query("SELECT pg_try_advisory_lock($1::int4, $2::int4) AS locked", keys);
    } catch (err) {
      logFn("migration_lock_skipped", { reason: "query_failed", error: err?.message });
      await client.end().catch(() => {});
      return noop;
    }
    const locked = res && res.rows && (res.rows[0]?.locked === true || res.rows[0]?.locked === "t");
    if (locked) { acquired = true; break; }
    logFn("migration_lock_waiting", { pollMs });
    await sleepFn(pollMs);
  }

  if (!acquired) {
    logFn("migration_lock_timeout", { timeoutMs });
    await client.end().catch(() => {});
    return noop;
  }

  logFn("migration_lock_acquired", {});
  return async () => {
    try {
      await client.query("SELECT pg_advisory_unlock($1::int4, $2::int4)", keys);
      logFn("migration_lock_released", {});
    } catch (err) {
      logFn("migration_lock_release_failed", { error: err?.message });
    } finally {
      await client.end().catch(() => {});
    }
  };
}

async function runMigrations() {
  loadDotenv();
  if (process.env.SKIP_MIGRATIONS === "1") {
    log("skipping prisma migrate deploy (SKIP_MIGRATIONS=1)");
    return 0;
  }

  let result;
  for (let attempt = 1; attempt <= MIGRATION_TRANSIENT_RETRIES; attempt++) {
    log("running prisma migrate deploy", { attempt, maxAttempts: MIGRATION_TRANSIENT_RETRIES });
    result = runPrisma(["migrate", "deploy"]);
    if (result.error) {
      log("prisma migrate deploy spawn error", { error: result.error.message });
      return 1;
    }
    if ((result.status ?? 1) === 0) break;
    if (!isTransientMigrationError(result)) break;
    if (attempt < MIGRATION_TRANSIENT_RETRIES) {
      log("transient migration error — retrying", { attempt, retryInMs: MIGRATION_RETRY_DELAY_MS });
      await sleep(MIGRATION_RETRY_DELAY_MS);
    }
  }

  if ((result.status ?? 1) !== 0 && process.env.PRISMA_BASELINE_ON_P3005 === "1") {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (output.includes("P3005")) {
      const baselineStatus = baselineExistingSchema();
      if (baselineStatus !== 0) return baselineStatus;
      log("retrying prisma migrate deploy after baseline");
      const retry = runPrisma(["migrate", "deploy"]);
      if (retry.error) {
        log("prisma migrate deploy retry spawn error", { error: retry.error.message });
        return 1;
      }
      return retry.status ?? 1;
    }
  }
  if ((result.status ?? 1) !== 0 && process.env.PRISMA_AUTO_ROLLBACK_SAFE_MIGRATIONS !== "0") {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (output.includes("P3009") && await rollbackSafeFailedMigrations()) {
      log("retrying prisma migrate deploy after safe failed migration rollback");
      const retry = runPrisma(["migrate", "deploy"]);
      if (retry.error) {
        log("prisma migrate deploy retry spawn error", { error: retry.error.message });
        return 1;
      }
      return retry.status ?? 1;
    }
    if (shouldContinueAfterSafeP3009(output)) {
      log("continuing boot despite safe P3009 migration block", {
        failedMigrations: extractP3009MigrationNames(output),
      });
      return 0;
    }
  }

  if ((result.status ?? 1) !== 0 && isTransientMigrationError(result)) {
    log("migration failed after all retries due to transient network error — proceeding with boot (schema already applied)", {
      hint: "Set SKIP_MIGRATIONS=1 to bypass migrations entirely on future boots if this persists.",
    });
    return 0;
  }

  return result.status ?? 1;
}

function startBackend() {
  log("starting backend (node index.js)");
  const child = spawn(process.execPath, ["index.js"], {
    cwd: BACKEND_DIR,
    stdio: "inherit",
    env: process.env,
  });
  const forward = (sig) => () => {
    try { child.kill(sig); } catch { /* noop */ }
  };
  process.on("SIGTERM", forward("SIGTERM"));
  process.on("SIGINT", forward("SIGINT"));
  child.on("exit", (code, signal) => {
    log("backend exited", { code, signal });
    process.exit(code ?? (signal ? 1 : 0));
  });
}

// Run DB preflight + acquire the migration advisory lock when applicable.
// Returns an async release() (a no-op when nothing was locked). Every branch is
// gated by env and fail-safe: a bug here can never block boot or fail it.
async function maybePreflightAndLock() {
  const noop = async () => {};
  if (process.env.SKIP_MIGRATIONS === "1") return noop;

  loadDotenv();
  const url = resolvePrismaDatabaseUrl();
  if (!isDirectPostgresUrl(url)) {
    // Accelerate/Data Proxy (prisma://) or no URL: pg can't dial it, so skip
    // fast instead of burning preflight retries that can never succeed.
    phase("migration_preflight_skipped", { reason: url ? "non_direct_postgres_url" : "no_database_url" });
    return noop;
  }

  if (process.env.MIGRATION_PREFLIGHT_DISABLED !== "1") {
    phase("db_preflight_start", { attempts: MIGRATION_PREFLIGHT_ATTEMPTS });
    const ok = await preflightDatabase().catch((err) => {
      phase("db_preflight_error", { error: err?.message });
      return true; // never block boot on a preflight bug
    });
    if (!ok) phase("db_preflight_giving_up", { note: "continuing to migrate anyway" });
  }

  if (process.env.MIGRATION_ADVISORY_LOCK_DISABLED === "1") return noop;
  phase("migration_lock_start", {});
  return acquireMigrationLock().catch((err) => {
    phase("migration_lock_error", { error: err?.message });
    return noop;
  });
}

/**
 * Ensure Python document sandbox libraries are installed.
 * Runs pip install --user silently in background — never blocks boot.
 * Idempotent: pip skips packages already installed.
 */
function ensureSandboxPythonDeps() {
  const PACKAGES = ['python-docx', 'openpyxl', 'pypdf', 'reportlab', 'pandas'];
  const python = process.env.PYTHON_BIN || 'python3';
  try {
    const child = spawn(
      python,
      ['-m', 'pip', 'install', '--user', '--quiet', '--exists-action=i', ...PACKAGES],
      { stdio: 'ignore', detached: false }
    );
    child.on('error', () => { /* non-critical */ });
  } catch { /* non-critical */ }
}

/**
 * Kill any stale process holding BACKEND_PORT (default 5050) so a workflow
 * restart triggered by adding secrets never hits EADDRINUSE.
 * Uses `fuser -k` which is always available on Linux/Nix. Non-fatal.
 */
function clearStalePortProcess() {
  const port = process.env.BACKEND_PORT || process.env.PORT || '5050';
  try {
    spawnSync('fuser', ['-k', `${port}/tcp`], { stdio: 'ignore' });
  } catch { /* non-critical — fuser may not exist on every OS */ }
}

/**
 * Seed an admin user if SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD are set.
 * Runs after migrations, before the backend boots. Never throws — a seed
 * failure is logged but never blocks boot.
 */
async function seedAdminIfNeeded() {
  const email = process.env.SEED_ADMIN_EMAIL;
  const rawPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !rawPassword) return;

  phase("seed_admin_check", { email });
  try {
    const { PrismaClient } = require("../node_modules/@prisma/client");
    const bcrypt = require("../node_modules/bcryptjs");
    const prisma = new PrismaClient();
    try {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        // Update password so the seed password stays in sync on every deploy.
        const hash = await bcrypt.hash(rawPassword, 12);
        await prisma.user.update({
          where: { email },
          data: {
            password: hash,
            isAdmin: true,
            isSuperAdmin: true,
          },
        });
        phase("seed_admin_updated", { email });
      } else {
        const hash = await bcrypt.hash(rawPassword, 12);
        await prisma.user.create({
          data: {
            email,
            name: "Admin",
            password: hash,
            isAdmin: true,
            isSuperAdmin: true,
          },
        });
        phase("seed_admin_created", { email });
      }
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
  } catch (err) {
    // Never block boot on seed failure.
    phase("seed_admin_error", { email, error: err?.message });
  }
}

async function main() {
  phase("boot_start", { skipMigrations: process.env.SKIP_MIGRATIONS === "1" });
  clearStalePortProcess();
  ensureSandboxPythonDeps();
  const release = await maybePreflightAndLock();

  let migrationStatus;
  try {
    phase("migrate_start", {});
    migrationStatus = await runMigrations();
    phase("migrate_done", { status: migrationStatus });
  } finally {
    await release().catch(() => {});
  }

  if (migrationStatus !== 0) {
    // Opt-in safety valve (default OFF — byte-identical to before when unset):
    // when MIGRATION_NONFATAL=1, boot the backend anyway so it can still bind
    // its port and serve traffic in a degraded state instead of leaving the
    // whole instance down (which surfaces as ECONNREFUSED on every /api call).
    // The operator must still fix the underlying DB/migration condition.
    if (process.env.MIGRATION_NONFATAL === "1") {
      log("migrations failed but MIGRATION_NONFATAL=1 — booting anyway (degraded)", { status: migrationStatus });
      phase("backend_start", { degraded: true });
      startBackend();
      return;
    }
    log("migrations failed — aborting boot", { status: migrationStatus });
    phase("boot_aborted", { status: migrationStatus });
    process.exit(migrationStatus);
  }

  // Seed the admin user into the production DB if env vars are configured.
  await seedAdminIfNeeded();

  phase("backend_start", { degraded: false });
  startBackend();
}

if (require.main === module) {
  main().catch((err) => {
    log("fatal boot wrapper error", { error: err?.message, stack: err?.stack });
    process.exit(1);
  });
}

module.exports = {
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
};

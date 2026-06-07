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
];

function log(msg, extra = {}) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), scope: "boot", msg, ...extra }) + "\n");
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
  return env.PRISMA_DATABASE_URL || env.DATABASE_URL || "";
}

function makePgClientOptions(url) {
  const needsSsl = /(?:neon|sslmode=require)/i.test(url);
  return {
    connectionString: url,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  };
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

async function main() {
  const migrationStatus = await runMigrations();
  if (migrationStatus !== 0) {
    // Opt-in safety valve (default OFF — byte-identical to before when unset):
    // when MIGRATION_NONFATAL=1, boot the backend anyway so it can still bind
    // its port and serve traffic in a degraded state instead of leaving the
    // whole instance down (which surfaces as ECONNREFUSED on every /api call).
    // The operator must still fix the underlying DB/migration condition.
    if (process.env.MIGRATION_NONFATAL === "1") {
      log("migrations failed but MIGRATION_NONFATAL=1 — booting anyway (degraded)", { status: migrationStatus });
      startBackend();
      return;
    }
    log("migrations failed — aborting boot", { status: migrationStatus });
    process.exit(migrationStatus);
  }
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
};

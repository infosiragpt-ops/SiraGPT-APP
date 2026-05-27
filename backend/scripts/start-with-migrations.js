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

const BACKEND_DIR = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.join(BACKEND_DIR, "prisma", "migrations");
const DATA_ONLY_AUTO_ROLLBACK_MIGRATIONS = [
  /^\d{14}_reset_admin_password$/,
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
    require("dotenv").config({ path: path.join(BACKEND_DIR, ".env") });
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

function isSafeDataOnlyRollbackMigration(migrationName) {
  return DATA_ONLY_AUTO_ROLLBACK_MIGRATIONS.some((pattern) => pattern.test(migrationName));
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

async function markDataOnlyMigrationsRolledBack(migrationNames) {
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
            '[boot] auto-marked rolled back: data-only migration blocked backend startup with P3009'
          )
      WHERE migration_name = ANY($1::text[])
        AND finished_at IS NULL
        AND rolled_back_at IS NULL
    `, [migrationNames]);
  } finally {
    await client.end();
  }
}

async function rollbackSafeFailedDataMigrations() {
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

  const unsafe = failedMigrations.filter((name) => !isSafeDataOnlyRollbackMigration(name));
  if (unsafe.length > 0) {
    log("refusing to auto-rollback schema migration failures", { failedMigrations });
    return false;
  }

  try {
    await markDataOnlyMigrationsRolledBack(failedMigrations);
    log("auto-rolled back data-only failed migrations", { failedMigrations });
    return true;
  } catch (err) {
    log("failed to auto-rollback data-only migrations", { error: err?.message, failedMigrations });
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

async function runMigrations() {
  if (process.env.SKIP_MIGRATIONS === "1") {
    log("skipping prisma migrate deploy (SKIP_MIGRATIONS=1)");
    return 0;
  }
  log("running prisma migrate deploy");
  const result = runPrisma(["migrate", "deploy"]);
  if (result.error) {
    log("prisma migrate deploy spawn error", { error: result.error.message });
    return 1;
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
  if ((result.status ?? 1) !== 0 && process.env.PRISMA_AUTO_ROLLBACK_DATA_MIGRATIONS !== "0") {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (output.includes("P3009") && await rollbackSafeFailedDataMigrations()) {
      log("retrying prisma migrate deploy after data-only failed migration rollback");
      const retry = runPrisma(["migrate", "deploy"]);
      if (retry.error) {
        log("prisma migrate deploy retry spawn error", { error: retry.error.message });
        return 1;
      }
      return retry.status ?? 1;
    }
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
  isSafeDataOnlyRollbackMigration,
  makePgClientOptions,
  resolvePrismaDatabaseUrl,
};

#!/usr/bin/env node
/**
 * Backend boot wrapper: runs `prisma migrate deploy` against the
 * production database, then execs the backend entrypoint. On migration
 * failure exits non-zero so the container is replaced. If
 * SKIP_MIGRATIONS=1 the migration step is skipped (useful during local
 * iteration when the schema is already up to date).
 *
 * When the database already has tables (P3005), we baseline it via a
 * single bulk SQL INSERT into _prisma_migrations — much faster than
 * running 73 individual `prisma migrate resolve` CLI calls (4 min → <1s).
 */
const { spawnSync, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const BACKEND_DIR = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.join(BACKEND_DIR, "prisma", "migrations");

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

function migrationNames() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((name) => name !== "migration_lock.toml")
    .filter((name) => fs.statSync(path.join(MIGRATIONS_DIR, name)).isDirectory())
    .sort();
}

/**
 * Fast SQL-based baseline: inserts all migration names into
 * _prisma_migrations in a single DB session. Avoids spawning 73
 * individual Prisma CLI processes which would take ~4 minutes.
 */
async function fastBaselineSQL(dbUrl) {
  log("baselining via direct SQL INSERT into _prisma_migrations");
  let Client;
  try {
    ({ Client } = require("pg"));
  } catch (e) {
    log("pg module not found — falling back to CLI baseline", { error: e.message });
    return cliBaseline();
  }

  const client = new Client({ connectionString: dbUrl });
  try {
    await client.connect();

    const names = migrationNames();
    let inserted = 0;

    for (const name of names) {
      const sqlPath = path.join(MIGRATIONS_DIR, name, "migration.sql");
      let checksum = "";
      if (fs.existsSync(sqlPath)) {
        const content = fs.readFileSync(sqlPath, "utf8");
        checksum = crypto.createHash("sha256").update(content).digest("hex");
      }

      const res = await client.query(
        `INSERT INTO "_prisma_migrations"
           (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
         SELECT gen_random_uuid(), $1, NOW(), $2, NULL, NULL, NOW(), 1
         WHERE NOT EXISTS (
           SELECT 1 FROM "_prisma_migrations" WHERE migration_name = $2
         )`,
        [checksum, name]
      );
      if (res.rowCount > 0) inserted++;
    }

    log("SQL baseline complete", { inserted, total: names.length });
    return 0;
  } catch (err) {
    log("SQL baseline error — falling back to CLI baseline", { error: err.message });
    return cliBaseline();
  } finally {
    try { await client.end(); } catch { /* noop */ }
  }
}

function cliBaseline() {
  log("CLI baseline: marking all migrations as applied via prisma migrate resolve");
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

  if ((result.status ?? 1) !== 0) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (output.includes("P3005")) {
      log("detected P3005 (non-empty schema) — baselining existing database");
      const dbUrl = process.env.DATABASE_URL || process.env.PRISMA_DATABASE_URL;
      const baselineStatus = await fastBaselineSQL(dbUrl);
      if (baselineStatus !== 0) return baselineStatus;
      log("retrying prisma migrate deploy after baseline");
      const retry = runPrisma(["migrate", "deploy"]);
      if (retry.error) {
        log("prisma migrate deploy retry spawn error", { error: retry.error.message });
        return 1;
      }
      return retry.status ?? 1;
    }
    return result.status ?? 1;
  }

  return 0;
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

main().catch((err) => {
  log("fatal error in boot", { error: err?.message, stack: err?.stack });
  process.exit(1);
});

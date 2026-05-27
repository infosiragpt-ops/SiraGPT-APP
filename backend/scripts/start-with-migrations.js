#!/usr/bin/env node
/**
 * Backend boot wrapper: runs `prisma migrate deploy` against the
 * production database, then starts the backend. Handles three cases:
 *
 *  P3005 — schema not empty (existing DB): fast SQL baseline via pg,
 *           then retry migrate deploy.
 *  P3009 — failed migration stuck in _prisma_migrations: mark it as
 *           rolled-back via pg, then retry migrate deploy.
 *  SKIP_MIGRATIONS=1 — skip migrate entirely (useful in local dev).
 */
const { spawnSync, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const BACKEND_DIR = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.join(BACKEND_DIR, "prisma", "migrations");

function log(msg, extra = {}) {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), scope: "boot", msg, ...extra }) + "\n"
  );
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
    timeout: 120_000,
  });
  pipeResult(result);
  return result;
}

function migrationNames() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((n) => n !== "migration_lock.toml")
    .filter((n) => fs.statSync(path.join(MIGRATIONS_DIR, n)).isDirectory())
    .sort();
}

function getDbUrl() {
  // start-all.cjs sets DATABASE_URL to the production Neon URL.
  return process.env.DATABASE_URL || process.env.PRISMA_DATABASE_URL || "";
}

function makePgClientOptions(url) {
  const needsSsl = /neon|sslmode=require/i.test(url);
  return {
    connectionString: url,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  };
}

/**
 * Fast SQL-based baseline: mark all migrations as applied in a single
 * pg session (~50ms) instead of spawning 73 CLI processes (~4 minutes).
 */
async function fastBaselineSQL() {
  const url = getDbUrl();
  if (!url || url.includes("helium")) {
    log("fastBaselineSQL: no valid production DATABASE_URL — skipping");
    return 1;
  }

  log("baselining via direct SQL INSERT into _prisma_migrations");
  let Client;
  try { ({ Client } = require("pg")); }
  catch (e) { log("pg not available for fast baseline", { error: e.message }); return 1; }

  const client = new Client(makePgClientOptions(url));
  try {
    await client.connect();
    const names = migrationNames();
    let inserted = 0;
    for (const name of names) {
      const sqlPath = path.join(MIGRATIONS_DIR, name, "migration.sql");
      let checksum = "";
      if (fs.existsSync(sqlPath)) {
        checksum = crypto.createHash("sha256")
          .update(fs.readFileSync(sqlPath, "utf8"))
          .digest("hex");
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
    log("SQL baseline error", { error: err.message });
    return 1;
  } finally {
    try { await client.end(); } catch { /* noop */ }
  }
}

/**
 * P3009 fix: mark any failed (stuck) migrations as rolled-back so
 * migrate deploy can retry them cleanly.
 */
async function clearFailedMigrations(output) {
  const url = getDbUrl();
  if (!url || url.includes("helium")) {
    log("clearFailedMigrations: no valid production DATABASE_URL — skipping");
    return false;
  }

  let Client;
  try { ({ Client } = require("pg")); }
  catch (e) { log("pg not available for P3009 fix", { error: e.message }); return false; }

  const client = new Client(makePgClientOptions(url));
  try {
    await client.connect();

    // Find all stuck migrations (started but not finished or rolled back).
    const { rows } = await client.query(`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE finished_at IS NULL AND rolled_back_at IS NULL
      ORDER BY started_at ASC
    `);

    if (rows.length === 0) {
      log("P3009: no stuck migrations found in DB");
      return false;
    }

    const stuckNames = rows.map((r) => r.migration_name);
    log("P3009: marking stuck migrations as rolled-back", { stuckNames });

    await client.query(`
      UPDATE "_prisma_migrations"
      SET rolled_back_at = NOW(),
          logs = CONCAT(COALESCE(logs, ''), '[boot] auto-cleared stuck migration')
      WHERE migration_name = ANY($1::text[])
        AND finished_at IS NULL
        AND rolled_back_at IS NULL
    `, [stuckNames]);

    log("P3009: stuck migrations cleared", { count: stuckNames.length });
    return true;
  } catch (err) {
    log("P3009: failed to clear stuck migrations", { error: err.message });
    return false;
  } finally {
    try { await client.end(); } catch { /* noop */ }
  }
}

async function runMigrations() {
  if (process.env.SKIP_MIGRATIONS === "1") {
    log("skipping prisma migrate deploy (SKIP_MIGRATIONS=1)");
    return 0;
  }

  log("running prisma migrate deploy");
  let result = runPrisma(["migrate", "deploy"]);
  if (result.error) {
    log("prisma migrate deploy spawn error", { error: result.error.message });
    return 1;
  }

  const output = () => `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

  // ── P3005: schema not empty ───────────────────────────────────────────────
  if ((result.status ?? 1) !== 0 && output().includes("P3005")) {
    log("detected P3005 — running fast SQL baseline");
    const baselineStatus = await fastBaselineSQL();
    if (baselineStatus !== 0) {
      log("SQL baseline failed — cannot recover from P3005");
      return 1;
    }
    log("retrying prisma migrate deploy after baseline");
    result = runPrisma(["migrate", "deploy"]);
    if (result.error) { log("retry spawn error", { error: result.error.message }); return 1; }
  }

  // ── P3009: stuck failed migration ─────────────────────────────────────────
  if ((result.status ?? 1) !== 0 && output().includes("P3009")) {
    log("detected P3009 — clearing stuck failed migrations");
    const cleared = await clearFailedMigrations(output());
    if (cleared) {
      log("retrying prisma migrate deploy after P3009 clear");
      result = runPrisma(["migrate", "deploy"]);
      if (result.error) { log("retry spawn error", { error: result.error.message }); return 1; }
    } else {
      log("could not clear P3009 — proceeding anyway (migrations may be partially applied)");
      return 0;
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
  log("boot wrapper starting", { dbUrlSet: !!getDbUrl(), dbIsNeon: /neon/.test(getDbUrl()) });
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

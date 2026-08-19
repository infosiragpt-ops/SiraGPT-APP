#!/usr/bin/env node
/**
 * Backend boot wrapper: runs `prisma migrate deploy` against the
 * production database, then execs the backend entrypoint. On migration
 * failure exits non-zero so the container is replaced. If
 * SKIP_MIGRATIONS=1 the migration step is skipped (useful during local
 * iteration when the schema is already up to date).
 */
const { spawnSync, spawn } = require("node:child_process");
const path = require("node:path");

const BACKEND_DIR = path.resolve(__dirname, "..");

function log(msg, extra = {}) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), scope: "boot", msg, ...extra }) + "\n");
}

function runMigrations() {
  if (process.env.SKIP_MIGRATIONS === "1") {
    log("skipping prisma migrate deploy (SKIP_MIGRATIONS=1)");
    return 0;
  }
  log("running prisma migrate deploy");
  const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: BACKEND_DIR,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    log("prisma migrate deploy spawn error", { error: result.error.message });
    return 1;
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

const migrationStatus = runMigrations();
if (migrationStatus !== 0) {
  log("migrations failed — aborting boot", { status: migrationStatus });
  process.exit(migrationStatus);
}
startBackend();

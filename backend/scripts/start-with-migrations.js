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

function runMigrations() {
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

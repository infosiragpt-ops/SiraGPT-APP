#!/usr/bin/env node
/**
 * Single-container start script for the Replit Autoscale deployment.
 *
 * Spawns the Express backend on localhost:5050 (with `prisma migrate deploy`
 * baked into its own wrapper) and the Next.js frontend on port 3000
 * simultaneously. The frontend starts immediately so Autoscale's port-3000
 * health check passes within seconds — even while the backend is still
 * running migrations.
 *
 * Both processes share the container lifecycle: SIGTERM/SIGINT is forwarded
 * to both children, and if either child exits unexpectedly the whole
 * container is torn down so Replit replaces it.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const BACKEND_DIR = path.join(ROOT, "backend");
const BACKEND_PORT = Number(process.env.BACKEND_PORT || 5050);
const BACKEND_HOST = process.env.BACKEND_HOST || "127.0.0.1";
const FRONTEND_PORT = Number(process.env.FRONTEND_PORT || 3000);
const BACKEND_READY_TIMEOUT_MS = Number(process.env.BACKEND_READY_TIMEOUT_MS || 120_000);

let backend = null;
let frontend = null;
let shuttingDown = false;

function log(scope, msg, extra = {}) {
  const line = { ts: new Date().toISOString(), scope, msg, ...extra };
  process.stdout.write(JSON.stringify(line) + "\n");
}

function pipePrefixed(child, prefix) {
  const writeChunk = (stream) => (chunk) => {
    const text = chunk.toString("utf8");
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      stream.write(`${prefix} ${line}\n`);
    }
  };
  child.stdout?.on("data", writeChunk(process.stdout));
  child.stderr?.on("data", writeChunk(process.stderr));
}

/**
 * Reconstruct the production DATABASE_URL from individual PG* secrets when
 * the DATABASE_URL still points to the dev-only 'helium' host that doesn't
 * exist in production containers.
 */
function buildDbUrl() {
  const raw = process.env.DATABASE_URL || "";
  if (raw && !raw.includes("helium") && !raw.includes("localhost")) {
    return raw;
  }
  const host = process.env.PGHOST;
  const port = process.env.PGPORT || "5432";
  const user = process.env.PGUSER;
  const pass = process.env.PGPASSWORD;
  const db = process.env.PGDATABASE || "neondb";
  if (!host || !user || !pass) {
    log("start-all", "WARNING: PGHOST/PGUSER/PGPASSWORD not found — using raw DATABASE_URL as-is");
    return raw;
  }
  const url = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${db}?sslmode=require`;
  log("start-all", "built production DATABASE_URL from PG* secrets", { host, port, db });
  return url;
}

function spawnBackend() {
  log("start-all", "spawning backend", { cwd: BACKEND_DIR, port: BACKEND_PORT });
  const dbUrl = buildDbUrl();
  const env = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || "production",
    PORT: String(BACKEND_PORT),
    HOST: BACKEND_HOST,
    BIND_ADDRESS: BACKEND_HOST,
    // Pass the correct production DB URL so both Prisma and the backend ORM use it.
    DATABASE_URL: dbUrl,
    PRISMA_DATABASE_URL: dbUrl,
    // Always attempt baseline when schema is non-empty (P3005).
    PRISMA_BASELINE_ON_P3005: "1",
  };
  const child = spawn(process.execPath, ["scripts/start-with-migrations.js"], {
    cwd: BACKEND_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  pipePrefixed(child, "[backend]");
  child.on("exit", (code, signal) => onChildExit("backend", code, signal));
  return child;
}

function spawnFrontend() {
  const standaloneServer = path.join(ROOT, ".next/standalone/server.js");
  const useStandalone = fs.existsSync(standaloneServer);
  log("start-all", "spawning next.js", { port: FRONTEND_PORT, standalone: useStandalone });

  const env = {
    ...process.env,
    PORT: String(FRONTEND_PORT),
    HOSTNAME: "0.0.0.0",
    BACKEND_INTERNAL_URL: `http://${BACKEND_HOST}:${BACKEND_PORT}`,
  };

  const child = useStandalone
    ? spawn(process.execPath, [standaloneServer], {
        cwd: ROOT,
        env,
        stdio: ["ignore", "inherit", "inherit"],
      })
    : spawn("npx", ["next", "start", "-p", String(FRONTEND_PORT), "-H", "0.0.0.0"], {
        cwd: ROOT,
        env,
        stdio: ["ignore", "inherit", "inherit"],
      });

  child.on("exit", (code, signal) => onChildExit("frontend", code, signal));
  return child;
}

function onChildExit(name, code, signal) {
  if (shuttingDown) {
    log("start-all", `${name} exited during shutdown`, { code, signal });
    return;
  }
  log("start-all", `${name} exited unexpectedly — tearing down container`, { code, signal });
  shuttingDown = true;
  for (const c of [backend, frontend]) {
    if (c && !c.killed && c.exitCode === null) {
      try { c.kill("SIGTERM"); } catch { /* noop */ }
    }
  }
  setTimeout(() => process.exit(code === 0 ? 1 : (code ?? 1)), 2000).unref();
}

function forwardSignal(sig) {
  return () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("start-all", "received signal — forwarding to children", { signal: sig });
    for (const c of [backend, frontend]) {
      if (c && !c.killed && c.exitCode === null) {
        try { c.kill(sig); } catch { /* noop */ }
      }
    }
    setTimeout(() => process.exit(0), 5000).unref();
  };
}

function waitForPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect({ host, port });
      let settled = false;
      const cleanup = () => {
        if (!settled) {
          settled = true;
          sock.removeAllListeners();
          sock.destroy();
        }
      };
      sock.once("connect", () => { cleanup(); resolve(); });
      sock.once("error", () => {
        cleanup();
        if (Date.now() > deadline) return reject(new Error(`Backend did not open ${host}:${port} within ${timeoutMs}ms`));
        setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

async function main() {
  process.on("SIGTERM", forwardSignal("SIGTERM"));
  process.on("SIGINT", forwardSignal("SIGINT"));

  // Start both immediately so port 3000 opens within seconds.
  // Autoscale's health check only needs port 3000 — the backend coming up
  // later is fine; API calls will return 502 briefly during migration.
  backend = spawnBackend();
  frontend = spawnFrontend();

  // Log when backend becomes ready (informational only — does not block startup).
  waitForPort(BACKEND_HOST, BACKEND_PORT, BACKEND_READY_TIMEOUT_MS)
    .then(() => log("start-all", "backend is accepting connections", { host: BACKEND_HOST, port: BACKEND_PORT }))
    .catch((err) => log("start-all", "backend did not become ready within timeout", { error: err?.message }));
}

main().catch((err) => {
  log("start-all", "fatal error", { error: err?.message, stack: err?.stack });
  process.exit(1);
});

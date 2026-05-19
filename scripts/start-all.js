#!/usr/bin/env node
/**
 * Single-container start script for the Replit Autoscale deployment.
 *
 * Spawns the Express backend on localhost:5000 (with `prisma migrate deploy`
 * baked into its own wrapper), waits for it to accept connections, then
 * spawns Next.js on the public port. Both processes share the container
 * lifecycle: SIGTERM/SIGINT is forwarded to both children, and if either
 * child exits unexpectedly the whole container is torn down so Replit
 * replaces it.
 *
 * For Next.js we prefer the standalone build output at
 * `.next/standalone/server.js` (self-contained, ~250 MB of node_modules)
 * and fall back to `npx next start` for local development where the build
 * may not have been produced with NEXT_OUTPUT=standalone.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const BACKEND_DIR = path.join(ROOT, "backend");
const BACKEND_PORT = Number(process.env.BACKEND_PORT || 5000);
const BACKEND_HOST = process.env.BACKEND_HOST || "127.0.0.1";
const FRONTEND_PORT = Number(process.env.PORT || 3000);
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

function spawnBackend() {
  log("start-all", "spawning backend", { cwd: BACKEND_DIR, port: BACKEND_PORT });
  const env = {
    ...process.env,
    // Force NODE_ENV=production for the backend child unless the operator
    // explicitly overrode it. Without this the backend's global
    // unhandledRejection handler exits the process on transient Redis
    // errors (Upstash quota, connection blips), which then tears down
    // the whole single-container deployment.
    NODE_ENV: process.env.NODE_ENV || "production",
    PORT: String(BACKEND_PORT),
    HOST: BACKEND_HOST,
    BIND_ADDRESS: BACKEND_HOST,
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

  backend = spawnBackend();
  try {
    await waitForPort(BACKEND_HOST, BACKEND_PORT, BACKEND_READY_TIMEOUT_MS);
    log("start-all", "backend is accepting connections", { host: BACKEND_HOST, port: BACKEND_PORT });
  } catch (err) {
    log("start-all", "backend failed to become ready", { error: err?.message });
    shuttingDown = true;
    try { backend?.kill("SIGTERM"); } catch { /* noop */ }
    process.exit(1);
  }

  frontend = spawnFrontend();
}

main().catch((err) => {
  log("start-all", "fatal error", { error: err?.message, stack: err?.stack });
  process.exit(1);
});

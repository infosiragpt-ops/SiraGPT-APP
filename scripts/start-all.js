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
const {
  resolveDatabaseUrls,
} = require("../backend/src/config/database-url");
const {
  createShutdownCoordinator,
  resolveParentShutdownTimeoutMs,
} = require("./parent-shutdown");

const ROOT = path.resolve(__dirname, "..");
const BACKEND_DIR = path.join(ROOT, "backend");
// Backend listens on a high internal-only port so it never collides
// with the public port Replit injects via PORT (autoscale sets PORT=5000,
// which would clobber the backend if it also defaulted to 5000).
const BACKEND_PORT = Number(process.env.BACKEND_PORT || 5050);
const BACKEND_HOST = process.env.BACKEND_HOST || "127.0.0.1";
// Frontend must bind to the port declared in .replit's deploy config
// (localPort=3000 → externalPort=80). Replit Autoscale also injects
// PORT=5000 into the container, which we deliberately ignore — using
// it here would leave port 3000 closed and Autoscale would mark the
// deployment as failed ("required port was never opened, expected port 3000").
// FRONTEND_PORT is overridable for local dev only.
const FRONTEND_PORT = Number(process.env.FRONTEND_PORT || 3000);
const BACKEND_READY_TIMEOUT_MS = Number(process.env.BACKEND_READY_TIMEOUT_MS || 120_000);
const PARENT_SHUTDOWN_TIMEOUT_MS = resolveParentShutdownTimeoutMs(
  process.env.SIRAGPT_PARENT_SHUTDOWN_TIMEOUT_MS,
);

let backend = null;
let frontend = null;
const shutdownController = new AbortController();

function log(scope, msg, extra = {}) {
  const line = { ts: new Date().toISOString(), scope, msg, ...extra };
  process.stdout.write(JSON.stringify(line) + "\n");
}

const coordinator = createShutdownCoordinator({
  timeoutMs: PARENT_SHUTDOWN_TIMEOUT_MS,
  onShutdownStart: ({ reason, signal, desiredExitCode }) => {
    log("start-all", "shutdown started", { reason, signal, desiredExitCode });
    shutdownController.abort();
  },
  onSettled: ({ reason, exitCode, timedOut }) => {
    log("start-all", "shutdown settled", { reason, exitCode, timedOut });
    process.exitCode = exitCode;
  },
});

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

function buildDirectDbUrl(env = process.env) {
  // Production containers cannot reach the dev-only 'helium' host.
  // If the direct migration URL still points to helium, reconstruct it from
  // standard Replit Postgres secrets without replacing a remote runtime URL.
  const { directMigrationUrl } = resolveDatabaseUrls(env);
  const raw = directMigrationUrl || "";
  if (raw && !raw.includes("helium")) return raw;
  const host = env.PGHOST;
  const port = env.PGPORT || "5432";
  const user = env.PGUSER;
  const pass = env.PGPASSWORD;
  const db = env.PGDATABASE || "siragpt";
  if (!host || !user || !pass) {
    log("start-all", "WARNING: cannot build direct migration URL — missing PGHOST/PGUSER/PGPASSWORD");
    return raw;
  }
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${db}`;
}

function spawnBackend() {
  log("start-all", "spawning backend", { cwd: BACKEND_DIR, port: BACKEND_PORT });
  const { runtimeUrl } = resolveDatabaseUrls(process.env);
  const directMigrationUrl = buildDirectDbUrl(process.env);
  const effectiveRuntimeUrl = runtimeUrl && !runtimeUrl.includes("helium")
    ? runtimeUrl
    : directMigrationUrl || runtimeUrl;
  const databaseOverrides = {};
  if (effectiveRuntimeUrl) databaseOverrides.PRISMA_DATABASE_URL = effectiveRuntimeUrl;
  if (directMigrationUrl) databaseOverrides.DIRECT_DATABASE_URL = directMigrationUrl;
  if (
    directMigrationUrl
    && process.env.DATABASE_URL?.includes("helium")
    && runtimeUrl === process.env.DATABASE_URL.trim()
  ) {
    databaseOverrides.DATABASE_URL = directMigrationUrl;
  }
  const env = {
    ...process.env,
    ...databaseOverrides,
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
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    detached: process.platform !== "win32",
  });
  pipePrefixed(child, "[backend]");
  coordinator.registerChild("backend", child, {
    ipc: true,
    processGroup: process.platform !== "win32",
  });
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
        detached: process.platform !== "win32",
      })
    : spawn("npx", ["next", "start", "-p", String(FRONTEND_PORT), "-H", "0.0.0.0"], {
        cwd: ROOT,
        env,
        stdio: ["ignore", "inherit", "inherit"],
        detached: process.platform !== "win32",
      });

  coordinator.registerChild("frontend", child, {
    processGroup: process.platform !== "win32",
  });
  return child;
}

function handleSignal(sig) {
  return () => {
    void coordinator.shutdown({
      reason: `host:${sig}`,
      signal: sig,
      desiredExitCode: 0,
    });
  };
}

function waitForPort(host, port, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let activeSocket = null;
    let retryTimer = null;
    let finished = false;

    const finish = (settle, value) => {
      if (finished) return;
      finished = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (activeSocket) {
        activeSocket.removeAllListeners();
        activeSocket.destroy();
        activeSocket = null;
      }
      signal?.removeEventListener("abort", onAbort);
      settle(value);
    };
    const onAbort = () => {
      const error = new Error("Port readiness wait aborted during parent shutdown");
      error.code = "ABORT_ERR";
      finish(reject, error);
    };
    const attempt = () => {
      if (finished) return;
      if (signal?.aborted) {
        onAbort();
        return;
      }
      const sock = net.connect({ host, port });
      activeSocket = sock;
      let socketSettled = false;
      const cleanup = () => {
        if (!socketSettled) {
          socketSettled = true;
          sock.removeAllListeners();
          sock.destroy();
          if (activeSocket === sock) activeSocket = null;
        }
      };
      sock.once("connect", () => { cleanup(); finish(resolve); });
      sock.once("error", () => {
        cleanup();
        if (Date.now() > deadline) {
          finish(reject, new Error(`Backend did not open ${host}:${port} within ${timeoutMs}ms`));
          return;
        }
        retryTimer = setTimeout(() => {
          retryTimer = null;
          attempt();
        }, 500);
      });
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    attempt();
  });
}

async function main() {
  process.on("SIGTERM", handleSignal("SIGTERM"));
  process.on("SIGINT", handleSignal("SIGINT"));

  backend = spawnBackend();
  try {
    await waitForPort(
      BACKEND_HOST,
      BACKEND_PORT,
      BACKEND_READY_TIMEOUT_MS,
      shutdownController.signal,
    );
    log("start-all", "backend is accepting connections", { host: BACKEND_HOST, port: BACKEND_PORT });
  } catch (err) {
    if (coordinator.isShuttingDown()) return;
    log("start-all", "backend failed to become ready", { error: err?.message });
    await coordinator.shutdown({
      reason: "backend:readiness-timeout",
      signal: "SIGTERM",
      desiredExitCode: 1,
    });
    return;
  }

  if (coordinator.isShuttingDown()) return;
  frontend = spawnFrontend();
}

main().catch((err) => {
  log("start-all", "fatal error", { error: err?.message, stack: err?.stack });
  void coordinator.shutdown({
    reason: "parent:fatal",
    signal: "SIGTERM",
    desiredExitCode: 1,
  });
});

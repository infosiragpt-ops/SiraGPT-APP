#!/usr/bin/env node
/**
 * Single-container start script for the Replit Autoscale deployment.
 *
 * Spawns Next.js on the public port immediately. By default it also starts the
 * Express backend on an internal port with `prisma migrate deploy` baked into
 * its own wrapper. Replit Autoscale decides deploy health from the public port;
 * if the backend needs extra time for migrations, keeping Next.js up prevents a
 * false "port never opened" deployment failure. When REPLIT_BACKEND_MODE is
 * "external", Next.js proxies /api/* to BACKEND_INTERNAL_URL instead and skips
 * the internal backend sidecar.
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
const LOCAL_BACKEND_URL = `http://${BACKEND_HOST}:${BACKEND_PORT}`;
const EXTERNAL_BACKEND_URL = normalizeBackendUrl(
  process.env.BACKEND_PROXY_URL || process.env.BACKEND_INTERNAL_URL || "",
);
const USE_EXTERNAL_BACKEND =
  process.env.REPLIT_BACKEND_MODE === "external" ||
  (isHttpBackendUrl(EXTERNAL_BACKEND_URL) &&
    !isLoopbackBackendUrl(EXTERNAL_BACKEND_URL) &&
    process.env.REPLIT_BACKEND_MODE !== "sidecar");
const BACKEND_PROXY_URL = USE_EXTERNAL_BACKEND ? EXTERNAL_BACKEND_URL : LOCAL_BACKEND_URL;
// Replit's deploy health-check probes the localPort declared in .replit's
// [[ports]] entry that maps to externalPort=80 (currently 3000), and the run
// command sets FRONTEND_PORT=3000 to match. We honor FRONTEND_PORT so the
// frontend opens exactly the port Replit probes.
// NOTE: Replit also injects PORT=5000 as a container default, but that value
// does NOT match the [[ports]] mapping (3000 → 80), so we must NOT use it for
// the frontend — doing so makes the health-check fail with
// "required port was never opened, expected port 3000".
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

function normalizeBackendUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (/\/api$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/api$/i, "") || "/";
    }
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return raw;
  }
}

function isLoopbackBackendUrl(value) {
  try {
    const url = new URL(value);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return /(^|\/\/)(localhost|127\.0\.0\.1|\[?::1\]?)(:|\/|$)/i.test(String(value || ""));
  }
}

function isHttpBackendUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
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

function resolveBackendDatabaseEnvironment(env = process.env) {
  const { runtimeUrl, directMigrationUrl } = resolveDatabaseUrls(env);
  const resolved = {};
  if (runtimeUrl) resolved.PRISMA_DATABASE_URL = runtimeUrl;
  if (directMigrationUrl) resolved.DIRECT_DATABASE_URL = directMigrationUrl;
  return resolved;
}

function spawnBackend() {
  log("start-all", "spawning backend", { cwd: BACKEND_DIR, port: BACKEND_PORT });
  const env = {
    ...process.env,
    ...resolveBackendDatabaseEnvironment(process.env),
    // Force NODE_ENV=production for the backend in deployments, or when
    // the operator hasn't explicitly set it. This ensures OAuth callback
    // URLs and other production-only paths are used in the deployed
    // container even if Replit injects NODE_ENV=development by default.
    NODE_ENV: process.env.REPLIT_DEPLOYMENT === "1" ? "production" : (process.env.NODE_ENV || "production"),
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
    BACKEND_INTERNAL_URL: BACKEND_PROXY_URL,
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "/api",
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

  frontend = spawnFrontend();
  if (USE_EXTERNAL_BACKEND) {
    log("start-all", "using external backend proxy; skipping sidecar backend", {
      backend: BACKEND_PROXY_URL,
    });
    return;
  }

  // On a constrained single-vCPU deploy VM, the backend's heavy boot (DB
  // migrations, ~20 cron jobs, BullMQ workers, model/catalog loading) competes
  // with the frontend for CPU during the exact window when Replit's startup
  // probe is hitting GET / on FRONTEND_PORT. If the probe is starved it times
  // out and the whole promote fails even though the build was fine. Let the
  // frontend open its port (the probe target) before starting the CPU-heavy
  // backend so the health-check is not contended. Non-fatal: if the port never
  // opens in time, start the backend anyway so we never deadlock the boot.
  // Guard against a non-numeric override (e.g. "90s") producing NaN, which
  // would make waitForPort's deadline NaN and loop forever — deadlocking boot
  // since this wait is awaited before the backend spawns.
  const parsedFrontendTimeout = Number(process.env.FRONTEND_READY_TIMEOUT_MS);
  const frontendReadyTimeoutMs =
    Number.isFinite(parsedFrontendTimeout) && parsedFrontendTimeout > 0
      ? parsedFrontendTimeout
      : 90_000;
  await waitForPort("127.0.0.1", FRONTEND_PORT, frontendReadyTimeoutMs, shutdownController.signal)
    .then(() => log("start-all", "frontend port open; starting backend", { port: FRONTEND_PORT }))
    .catch((err) => log("start-all", "frontend readiness wait timed out; starting backend anyway", { error: err?.message }));
  if (coordinator.isShuttingDown()) return;

  backend = spawnBackend();
  const timeoutMs = Number(process.env.BACKEND_READY_TIMEOUT_MS || 300_000);
  waitForPort(BACKEND_HOST, BACKEND_PORT, timeoutMs, shutdownController.signal)
    .then(() => {
      log("start-all", "backend is accepting connections", { host: BACKEND_HOST, port: BACKEND_PORT });
    })
    .catch((err) => {
      log("start-all", "backend readiness timeout; keeping frontend online for diagnostics", {
        error: err?.message,
      });
    });
}

main().catch((err) => {
  log("start-all", "fatal error", { error: err?.message, stack: err?.stack });
  void coordinator.shutdown({
    reason: "parent:fatal",
    signal: "SIGTERM",
    desiredExitCode: 1,
  });
});

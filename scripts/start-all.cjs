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

let backend = null;
let frontend = null;
let shuttingDown = false;

function log(scope, msg, extra = {}) {
  const line = { ts: new Date().toISOString(), scope, msg, ...extra };
  process.stdout.write(JSON.stringify(line) + "\n");
}

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

function spawnBackend() {
  log("start-all", "spawning backend", { cwd: BACKEND_DIR, port: BACKEND_PORT });
  const env = {
    ...process.env,
    // Force NODE_ENV=production for the backend in deployments, or when
    // the operator hasn't explicitly set it. This ensures OAuth callback
    // URLs and other production-only paths are used in the deployed
    // container even if Replit injects NODE_ENV=development by default.
    NODE_ENV: process.env.REPLIT_DEPLOYMENT === "1" ? "production" : (process.env.NODE_ENV || "production"),
    PORT: String(BACKEND_PORT),
    HOST: BACKEND_HOST,
    BIND_ADDRESS: BACKEND_HOST,
    PRISMA_DATABASE_URL: process.env.PRISMA_DATABASE_URL || process.env.DATABASE_URL,
    PRISMA_BASELINE_ON_P3005: process.env.PRISMA_BASELINE_ON_P3005 || "1",
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
    BACKEND_INTERNAL_URL: BACKEND_PROXY_URL,
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "/api",
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
  // In a Replit deployment the health-check probes the FRONTEND (local port
  // 3000 → external 80). Only the frontend dying means there is nothing left
  // to serve, so that is the one case that should tear the whole container
  // down. If the BACKEND exits (e.g. a transient boot/migration hiccup), keep
  // the frontend online: the health-check still passes, the deployment can go
  // live, and the backend failure becomes visible in production runtime logs
  // instead of failing the entire promote with zero diagnostics. This mirrors
  // the intent of the waitForPort() timeout path below. Outside deployments
  // (a plain local `npm start`) we keep the strict teardown so a developer
  // notices immediately when the backend dies.
  if (name === "backend" && process.env.REPLIT_DEPLOYMENT === "1") {
    log("start-all", "backend exited — keeping frontend online so the deploy health-check can still pass", { code, signal });
    backend = null;
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

  frontend = spawnFrontend();
  if (USE_EXTERNAL_BACKEND) {
    log("start-all", "using external backend proxy; skipping sidecar backend", {
      backend: BACKEND_PROXY_URL,
    });
    return;
  }

  backend = spawnBackend();
  const timeoutMs = Number(process.env.BACKEND_READY_TIMEOUT_MS || 300_000);
  waitForPort(BACKEND_HOST, BACKEND_PORT, timeoutMs)
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
  process.exit(1);
});

'use strict';

/**
 * workspace-runner.service — Replit-style "▶ Run" for a cloned workspace.
 *
 * Spawns the project's dev server directly inside the cloned repo path (the
 * same dir git operates on), one process per workspace, on a free port, and
 * exposes start / stop / status + a rolling log tail and a preview URL.
 *
 * Cross-platform:
 *   - command run through a shell (`npm install && <dev>`) so npm.cmd resolves
 *     on Windows and `&&` chaining works (cmd.exe + /bin/sh both support it)
 *   - process-tree kill: `taskkill /T /F` on win32, process-group kill on POSIX
 *
 * Security: this runs untrusted repo code (same trust model as Replit). The
 * route layer already ownership-checks the workspace. Disable entirely with
 * SIRAGPT_WORKSPACE_RUN_DISABLED=1.
 */

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const DEFAULT_READY_TIMEOUT_MS = 180_000; // 3 min — covers a cold `npm install` + boot
const READY_POLL_MS = 1500;
const LOG_MAX_LINES = 200;
const PORT_RANGE = [4300, 4999];

// connectionId → run state
const runs = new Map();

function flagEnabled(value, fallback = false) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(raw)) return true;
  if (['0', 'false', 'off', 'no'].includes(raw)) return false;
  return fallback;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function readyTimeoutMs() {
  return positiveInt(process.env.SIRAGPT_WORKSPACE_RUN_READY_TIMEOUT_MS, DEFAULT_READY_TIMEOUT_MS);
}

function workspaceNodeOptions() {
  const configured = String(process.env.SIRAGPT_WORKSPACE_RUN_NODE_OPTIONS || '--max-old-space-size=4096').trim();
  const existing = String(process.env.NODE_OPTIONS || '').trim();
  return [existing, configured].filter(Boolean).join(' ');
}

function shouldUseProxyUrls() {
  return flagEnabled(process.env.SIRAGPT_WORKSPACE_RUN_PROXY_URLS, process.env.NODE_ENV === 'production');
}

function proxyUrlsEnabled() {
  return shouldUseProxyUrls();
}

function publicBasePath(connectionId) {
  return `/api/github/connected/${encodeURIComponent(String(connectionId))}/proxy/`;
}

function publicPreviewUrl(connectionId, port) {
  if (shouldUseProxyUrls()) return publicBasePath(connectionId);
  return `http://localhost:${port}`;
}

function isDisabled() {
  return /^(1|true|on)$/i.test(String(process.env.SIRAGPT_WORKSPACE_RUN_DISABLED || ''));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Find a free TCP port in PORT_RANGE. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const [lo, hi] = PORT_RANGE;
    const tryPort = (port) => {
      if (port > hi) return reject(new Error('No free port available'));
      const srv = net.createServer();
      srv.once('error', () => tryPort(port + 1));
      srv.once('listening', () => {
        srv.close(() => resolve(port));
      });
      srv.listen(port, '127.0.0.1');
    };
    tryPort(lo);
  });
}

/**
 * Decide how to run the project from package.json (or static fallback).
 * Returns { framework, command, kind } where kind is 'node' | 'static' | 'none'.
 */
function detectRunPlan(localPath, port, connectionId = null) {
  const pkg = readJson(path.join(localPath, 'package.json'));
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const scripts = pkg.scripts || {};
    let dev;
    let framework;
    if (deps.next) {
      framework = 'next';
      dev = `npm exec -- next dev -p ${port} -H 127.0.0.1`;
    } else if (deps.vite || /vite/.test(scripts.dev || '')) {
      framework = 'vite';
      const base = proxyUrlsEnabled() && connectionId ? ` --base ${JSON.stringify(publicBasePath(connectionId))}` : '';
      dev = `npm exec -- vite --port ${port} --host 127.0.0.1 --strictPort${base}`;
    } else if (scripts.dev) {
      framework = 'custom-dev';
      dev = 'npm run dev';
    } else if (scripts.start) {
      framework = 'custom-start';
      dev = 'npm start';
    } else {
      framework = 'node';
      dev = pkg.main ? `node ${JSON.stringify(pkg.main)}` : null;
    }
    if (!dev) return { kind: 'none', framework, command: null };
    const install = fs.existsSync(path.join(localPath, 'node_modules'))
      ? null
      : 'npm install';
    const command = install ? `${install} && ${dev}` : dev;
    return { kind: 'node', framework, command };
  }
  // No package.json — static site?
  const hasIndex = fs.existsSync(path.join(localPath, 'index.html'));
  if (hasIndex) return { kind: 'static', framework: 'static', command: null };
  return { kind: 'none', framework: 'unknown', command: null };
}

/** Minimal, dependency-free static file server for plain HTML sites. */
function startStaticServer(localPath, port, pushLog) {
  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      let rel = urlPath.replace(/^\/+/, '');
      if (rel === '' || rel.endsWith('/')) rel += 'index.html';
      const abs = path.join(localPath, rel);
      // Containment: never serve outside the workspace.
      if (!path.resolve(abs).startsWith(path.resolve(localPath))) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      fs.readFile(abs, (err, data) => {
        if (err) {
          res.writeHead(404).end('Not found');
          return;
        }
        const ext = path.extname(abs).toLowerCase();
        const types = {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.mjs': 'text/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.ico': 'image/x-icon',
        };
        res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
        res.end(data);
      });
    } catch (e) {
      res.writeHead(500).end('Server error');
    }
  });
  server.listen(port, '127.0.0.1', () => pushLog(`[static] serving on :${port}`));
  return server;
}

/** Poll the dev server until it answers (any HTTP response = ready). */
function pollReady(port, onReady, onTimeout) {
  const deadline = Date.now() + readyTimeoutMs();
  const tick = () => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
      res.resume();
      onReady();
    });
    req.on('error', () => {
      if (Date.now() > deadline) return onTimeout();
      setTimeout(tick, READY_POLL_MS);
    });
    req.on('timeout', () => {
      req.destroy();
      if (Date.now() > deadline) return onTimeout();
      setTimeout(tick, READY_POLL_MS);
    });
  };
  setTimeout(tick, READY_POLL_MS);
}

function pushLog(state, line) {
  for (const part of String(line).split('\n')) {
    const t = part.replace(/\s+$/, '');
    if (!t) continue;
    state.log.push(t.slice(0, 500));
  }
  if (state.log.length > LOG_MAX_LINES) state.log.splice(0, state.log.length - LOG_MAX_LINES);
}

function killTree(state) {
  if (state.server) {
    try {
      state.server.close();
    } catch {
      /* ignore */
    }
    state.server = null;
  }
  if (state.proc && state.proc.pid && !state.proc.killed) {
    const pid = state.proc.pid;
    try {
      if (IS_WIN) {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        process.kill(-pid, 'SIGTERM'); // negative pid → process group
      }
    } catch {
      try {
        state.proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
  state.proc = null;
}

/** Start (or restart) the dev server for a workspace. */
async function start(connectionId, localPath) {
  if (isDisabled()) {
    const e = new Error('Workspace run is disabled on this server');
    e.status = 503;
    e.code = 'run_disabled';
    throw e;
  }
  // Restart if already running.
  if (runs.has(connectionId)) stop(connectionId);

  const port = await findFreePort();
  const plan = detectRunPlan(localPath, port, connectionId);
  if (plan.kind === 'none') {
    const e = new Error('No runnable entrypoint found (no dev/start script, vite/next dep, or index.html)');
    e.status = 422;
    e.code = 'not_runnable';
    throw e;
  }

  const state = {
    connectionId,
    localPath,
    port,
    framework: plan.framework,
    kind: plan.kind,
    status: 'starting',
    ready: false,
    error: null,
    startedAt: Date.now(),
    proc: null,
    server: null,
    log: [],
    previewUrl: publicPreviewUrl(connectionId, port),
  };
  runs.set(connectionId, state);

  if (plan.kind === 'static') {
    state.server = startStaticServer(localPath, port, (l) => pushLog(state, l));
    state.status = 'ready';
    state.ready = true;
    return snapshot(state);
  }

  pushLog(state, `[run] ${plan.command}`);
  const proc = spawn(plan.command, {
    cwd: localPath,
    shell: true,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      BROWSER: 'none',
      FORCE_COLOR: '0',
      CI: '1',
      NODE_OPTIONS: workspaceNodeOptions(),
    },
    detached: !IS_WIN, // POSIX: own process group so we can kill the tree
    windowsHide: true,
  });
  state.proc = proc;

  proc.stdout?.on('data', (d) => pushLog(state, d.toString()));
  proc.stderr?.on('data', (d) => pushLog(state, d.toString()));
  proc.on('error', (err) => {
    state.status = 'error';
    state.error = err.message;
    pushLog(state, `[error] ${err.message}`);
  });
  proc.on('exit', (code) => {
    pushLog(state, `[exit] code ${code}`);
    if (state.status !== 'stopped') {
      state.status = state.ready ? 'stopped' : 'error';
      if (!state.ready && !state.error) state.error = `Process exited with code ${code}`;
    }
    state.ready = false;
  });

  pollReady(
    port,
    () => {
      if (state.status === 'stopped') return;
      state.status = 'ready';
      state.ready = true;
      pushLog(state, `[ready] preview at ${state.previewUrl}`);
    },
    () => {
      if (state.status === 'stopped' || state.ready) return;
      state.status = 'error';
      state.error = 'Timed out waiting for the dev server to respond';
    },
  );

  return snapshot(state);
}

function stop(connectionId) {
  const state = runs.get(connectionId);
  if (!state) return { stopped: false };
  state.status = 'stopped';
  state.ready = false;
  killTree(state);
  runs.delete(connectionId);
  return { stopped: true };
}

function snapshot(state) {
  if (!state) return { running: false, status: 'idle' };
  return {
    running: state.status === 'starting' || state.status === 'ready',
    status: state.status,
    ready: state.ready,
    port: state.port,
    previewUrl: state.previewUrl,
    framework: state.framework,
    kind: state.kind,
    error: state.error,
    tail: state.log.slice(-40),
    uptimeMs: Date.now() - state.startedAt,
  };
}

function status(connectionId) {
  return snapshot(runs.get(connectionId));
}

function getProxyTarget(connectionId) {
  const state = runs.get(connectionId);
  if (!state) return { error: 'not_found' };
  if (!state.port || !['starting', 'ready'].includes(state.status)) {
    return { error: 'not_ready', status: state.status, message: state.error || 'dev server not ready' };
  }
  return { port: state.port, status: state.status, framework: state.framework };
}

// Best-effort cleanup of all child processes on shutdown.
function stopAll() {
  for (const id of Array.from(runs.keys())) stop(id);
}
process.once('exit', stopAll);
process.once('SIGINT', () => {
  stopAll();
  process.exit(0);
});
process.once('SIGTERM', () => {
  stopAll();
  process.exit(0);
});

module.exports = {
  start,
  stop,
  status,
  getProxyTarget,
  publicBasePath,
  publicPreviewUrl,
  useProxyUrls: shouldUseProxyUrls,
  proxyUrlsEnabled,
  stopAll,
  detectRunPlan,
  findFreePort,
  isDisabled,
  _runs: runs,
};

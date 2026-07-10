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

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { buildUntrustedChildEnv } = require('../../utils/untrusted-child-env');
const {
  WINDOWS_COMMAND_TIMEOUT_MS,
  readWindowsProcessList,
  collectWindowsDescendants,
} = require('../../utils/windows-process-tree');

const IS_WIN = process.platform === 'win32';
const DEFAULT_READY_TIMEOUT_MS = 180_000; // 3 min — covers a cold `npm install` + boot
const READY_POLL_MS = 1500;
const LOG_MAX_LINES = 200;
const PORT_RANGE = [4300, 4999];
const MAX_ENV_KEYS = 120;
const MAX_ENV_VALUE_BYTES = 32 * 1024;
const DEFAULT_STOP_GRACE_MS = 3000;
const DEFAULT_FORCE_WAIT_MS = 250;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RUNTIME_ENV_FILE_RE = /(^|\/)\.env(?:\.(?!example$|sample$|template$|defaults$)[A-Za-z0-9_-]+)*$/i;
const BLOCKED_ENV_KEYS = new Set([
  'NODE_OPTIONS',
  'PATH',
  'HOME',
  'PWD',
  'SHELL',
  'INIT_CWD',
  'NPM_CONFIG_USERCONFIG',
  'NPM_CONFIG_PREFIX',
]);

// connectionId → run state
const runs = new Map();
const pendingStarts = new Set();
const pendingStops = new Set();
let stopping = false;
let stopAllPromise = null;

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

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function stopGraceMs() {
  return boundedInt(
    process.env.SIRAGPT_WORKSPACE_RUN_STOP_GRACE_MS,
    DEFAULT_STOP_GRACE_MS,
    100,
    30_000,
  );
}

function forceWaitMs() {
  return boundedInt(
    process.env.SIRAGPT_WORKSPACE_RUN_FORCE_WAIT_MS,
    DEFAULT_FORCE_WAIT_MS,
    10,
    5000,
  );
}

function runnerStoppingError() {
  const error = new Error('Workspace runner is shutting down');
  error.status = 503;
  error.code = 'runner_stopping';
  return error;
}

function assertAcceptingStarts() {
  if (stopping) throw runnerStoppingError();
}

function workspaceNodeOptions() {
  const configured = String(process.env.SIRAGPT_WORKSPACE_RUN_NODE_OPTIONS || '--max-old-space-size=4096').trim();
  const existing = String(process.env.NODE_OPTIONS || '').trim();
  return [existing, configured].filter(Boolean).join(' ');
}

function normaliseRuntimeEnv(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [rawKey, rawValue] of Object.entries(input).slice(0, MAX_ENV_KEYS)) {
    const key = String(rawKey || '').trim().toUpperCase();
    if (!ENV_KEY_RE.test(key) || BLOCKED_ENV_KEYS.has(key)) continue;
    const value = rawValue == null ? '' : String(rawValue);
    if (Buffer.byteLength(value) > MAX_ENV_VALUE_BYTES) continue;
    out[key] = value;
  }
  return out;
}

function isRuntimeEnvFile(p) {
  return RUNTIME_ENV_FILE_RE.test(String(p || '').replace(/\\/g, '/'));
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
  let cancelled = false;
  let timer = null;
  let request = null;

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (request) request.destroy();
    request = null;
  };
  const schedule = () => {
    if (cancelled) return;
    timer = setTimeout(tick, READY_POLL_MS);
  };
  const tick = () => {
    if (cancelled) return;
    let failed = false;
    request = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
      res.resume();
      cancel();
      onReady();
    });
    request.once('error', () => {
      if (cancelled || failed) return;
      failed = true;
      request = null;
      if (Date.now() > deadline) {
        cancel();
        onTimeout();
        return;
      }
      schedule();
    });
    request.once('timeout', () => {
      if (failed) return;
      request.destroy();
    });
  };
  schedule();
  return cancel;
}

function redactRuntimeEnv(text, runtimeEnv = {}) {
  let out = String(text);
  for (const value of Object.values(runtimeEnv || {})) {
    const secret = String(value || '');
    if (secret.length < 4) continue;
    out = out.split(secret).join('[secret]');
  }
  return out;
}

function pushLog(state, line) {
  for (const part of redactRuntimeEnv(String(line), state && state.runtimeEnv).split('\n')) {
    const t = part.replace(/\s+$/, '');
    if (!t) continue;
    state.log.push(t.slice(0, 500));
  }
  if (state.log.length > LOG_MAX_LINES) state.log.splice(0, state.log.length - LOG_MAX_LINES);
}

function processSettled(proc) {
  return !proc || proc.exitCode !== null || proc.signalCode != null;
}

function createWindowsProcessTreeTracker(proc, {
  processListImpl = readWindowsProcessList,
} = {}) {
  const knownPids = new Set();
  let initialSnapshotUncertain = false;
  const readProcessList = () => {
    try {
      const result = processListImpl();
      return Array.isArray(result) ? result : null;
    } catch {
      return null;
    }
  };
  const rememberDescendants = (processList) => {
    const roots = [proc?.pid, ...knownPids];
    for (const rootPid of roots) {
      for (const pid of collectWindowsDescendants(rootPid, processList)) knownPids.add(pid);
    }
  };
  const initialProcessList = readProcessList();
  if (initialProcessList) rememberDescendants(initialProcessList);
  else initialSnapshotUncertain = true;

  return {
    knownPids,
    isAlive() {
      const processList = readProcessList();
      if (!processList) return true;
      rememberDescendants(processList);
      if (!processSettled(proc)) return true;
      if (initialSnapshotUncertain) return true;
      const livePids = new Set(processList.map((processInfo) => Number(processInfo?.pid)));
      return Array.from(knownPids).some((pid) => livePids.has(pid));
    },
  };
}

function sendGracefulTermination(proc) {
  if (processSettled(proc)) return;
  try {
    proc.kill?.('SIGTERM');
  } catch {
    try { proc.kill?.('SIGTERM'); } catch { /* already gone */ }
  }
}

function forceKillProcessTree(proc, knownTreePids = []) {
  if (!proc) return;
  try {
    if (IS_WIN && proc.pid) {
      const pids = new Set([proc.pid, ...knownTreePids]);
      for (const pid of pids) {
        const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: WINDOWS_COMMAND_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        });
        if (result?.error || (Number.isInteger(result?.status) && result.status !== 0)) {
          try { proc.kill?.('SIGKILL'); } catch { /* already gone */ }
        }
      }
      return;
    }
    if (!IS_WIN && proc.pid) {
      process.kill(-proc.pid, 'SIGKILL');
      return;
    }
    proc.kill?.('SIGKILL');
  } catch {
    try { proc.kill?.('SIGKILL'); } catch { /* already gone */ }
  }
}

function defaultProcessTreeLiveness(proc) {
  if (!proc) return false;
  if (!processSettled(proc)) return true;
  if (!IS_WIN && proc.pid) {
    try {
      process.kill(-proc.pid, 0);
      return true;
    } catch (error) {
      return error?.code !== 'ESRCH';
    }
  }
  return false;
}

function waitForPoll(timeoutMs, signal, setTimeoutFn, clearTimeoutFn) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let timer = null;
    const finish = () => {
      if (timer) clearTimeoutFn(timer);
      timer = null;
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeoutFn(finish, timeoutMs);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

async function waitForProcessTreeQuiescence(proc, {
  isProcessTreeAlive = defaultProcessTreeLiveness,
  pollIntervalMs = 50,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  signal,
} = {}) {
  if (!proc) return;
  while (!signal?.aborted && await isProcessTreeAlive(proc)) {
    await waitForPoll(
      Math.max(10, Number(pollIntervalMs) || 50),
      signal,
      setTimeoutFn,
      clearTimeoutFn,
    );
  }
}

function beginServerClose(server) {
  if (!server) return { done: Promise.resolve(), force: () => {} };
  let finish;
  let settled = false;
  const done = new Promise((resolve) => {
    finish = () => {
      if (settled) return;
      settled = true;
      server.removeListener?.('close', finish);
      resolve();
    };
    server.once?.('close', finish);
  });
  try {
    server.close(finish);
  } catch {
    finish();
  }
  return {
    done,
    force: () => {
      try { server.closeAllConnections?.(); } catch { /* best effort */ }
      try { server.closeIdleConnections?.(); } catch { /* best effort */ }
      try { server.close(finish); } catch { finish(); }
    },
  };
}

function waitForTimeout(promise, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(true);
    }, timeoutMs);
    Promise.resolve(promise).then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(false);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

async function stopRunState(state) {
  try { state.cancelReadyPoll?.(); } catch { /* best effort */ }
  state.cancelReadyPoll = null;

  const proc = state.proc;
  const server = state.server;
  state.proc = null;
  state.server = null;

  const windowsTreeTracker = IS_WIN && proc
    ? createWindowsProcessTreeTracker(proc)
    : null;
  const treeWaitController = new AbortController();
  const processDone = waitForProcessTreeQuiescence(proc, {
    isProcessTreeAlive: windowsTreeTracker?.isAlive || defaultProcessTreeLiveness,
    signal: treeWaitController.signal,
  });
  const serverClose = beginServerClose(server);
  const allDone = Promise.all([processDone, serverClose.done]);

  sendGracefulTermination(proc);

  const graceExpired = await waitForTimeout(allDone, stopGraceMs());
  if (!graceExpired) return;

  forceKillProcessTree(proc, windowsTreeTracker?.knownPids);
  serverClose.force();
  await waitForTimeout(allDone, forceWaitMs());
  treeWaitController.abort();
}

function initiateStop(connectionId, state) {
  if (!state) return null;
  if (state.stopPromise) return state.stopPromise;
  state.status = 'stopped';
  state.ready = false;
  if (runs.get(connectionId) === state) runs.delete(connectionId);
  const operation = stopRunState(state);
  state.stopPromise = operation;
  pendingStops.add(operation);
  const remove = () => pendingStops.delete(operation);
  operation.then(remove, remove);
  return operation;
}

function listRuntimeEnvFiles(root) {
  const found = [];
  const visit = (dir, depth = 0) => {
    if (depth > 4 || found.length > 40) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === '.next') continue;
      const abs = path.join(dir, ent.name);
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (ent.isDirectory()) visit(abs, depth + 1);
      else if (ent.isFile() && isRuntimeEnvFile(rel)) found.push(abs);
    }
  };
  visit(root);
  return found;
}

function hideRuntimeEnvFilesForInstall(root) {
  const moved = [];
  for (const abs of listRuntimeEnvFiles(root)) {
    const hidden = `${abs}.sira-hidden-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      fs.renameSync(abs, hidden);
      moved.push({ abs, hidden });
    } catch {
      /* best effort */
    }
  }
  return () => {
    for (const item of moved.reverse()) {
      try {
        if (fs.existsSync(item.hidden)) fs.renameSync(item.hidden, item.abs);
      } catch {
        /* best effort */
      }
    }
  };
}

/** Start (or restart) the dev server for a workspace. */
async function startInternal(connectionId, localPath, opts = {}) {
  assertAcceptingStarts();
  if (isDisabled()) {
    const e = new Error('Workspace run is disabled on this server');
    e.status = 503;
    e.code = 'run_disabled';
    throw e;
  }
  // Restart if already running.
  if (runs.has(connectionId)) {
    await initiateStop(connectionId, runs.get(connectionId));
    assertAcceptingStarts();
  }

  const port = await findFreePort();
  assertAcceptingStarts();
  const plan = detectRunPlan(localPath, port, connectionId);
  if (plan.kind === 'none') {
    const e = new Error('No runnable entrypoint found (no dev/start script, vite/next dep, or index.html)');
    e.status = 422;
    e.code = 'not_runnable';
    throw e;
  }
  assertAcceptingStarts();

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
    runtimeEnv: normaliseRuntimeEnv(opts.env),
    previewUrl: publicPreviewUrl(connectionId, port),
    cancelReadyPoll: null,
    stopPromise: null,
  };
  runs.set(connectionId, state);

  if (plan.kind === 'static') {
    assertAcceptingStarts();
    state.server = startStaticServer(localPath, port, (l) => pushLog(state, l));
    state.status = 'ready';
    state.ready = true;
    return snapshot(state);
  }

  const attachDevProcess = (proc) => {
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

    state.cancelReadyPoll = pollReady(
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
  };

  const spawnDev = (command) => {
    if (stopping || state.status === 'stopped') return;
    pushLog(state, `[run] ${command}`);
    attachDevProcess(spawn(command, {
      cwd: localPath,
      shell: true,
      // SECURITY: untrusted repo code must not inherit SiraGPT process.env.
      env: buildUntrustedChildEnv({
        ...state.runtimeEnv,
        PORT: String(port),
        HOST: '127.0.0.1',
        BROWSER: 'none',
        FORCE_COLOR: '0',
        CI: '1',
        NODE_OPTIONS: workspaceNodeOptions(),
      }),
      detached: !IS_WIN, // POSIX: own process group so we can kill the tree
      windowsHide: true,
    }));
  };

  if (plan.command.startsWith('npm install && ')) {
    const devCommand = plan.command.slice('npm install && '.length);
    const restoreEnvFiles = hideRuntimeEnvFilesForInstall(localPath);
    pushLog(state, '[run] npm install');
    const installProc = spawn('npm install', {
      cwd: localPath,
      shell: true,
      env: buildUntrustedChildEnv({
        BROWSER: 'none',
        FORCE_COLOR: '0',
        CI: '1',
        NODE_OPTIONS: workspaceNodeOptions(),
      }),
      detached: !IS_WIN,
      windowsHide: true,
    });
    state.proc = installProc;
    installProc.stdout?.on('data', (d) => pushLog(state, d.toString()));
    installProc.stderr?.on('data', (d) => pushLog(state, d.toString()));
    installProc.on('error', (err) => {
      restoreEnvFiles();
      state.status = 'error';
      state.error = err.message;
      pushLog(state, `[error] ${err.message}`);
    });
    installProc.on('exit', (code) => {
      restoreEnvFiles();
      state.proc = null;
      if (stopping || state.status === 'stopped') return;
      if (code !== 0) {
        state.status = 'error';
        state.error = `npm install exited with code ${code}`;
        pushLog(state, `[exit] code ${code}`);
        return;
      }
      spawnDev(devCommand);
    });
  } else {
    spawnDev(plan.command);
  }

  return snapshot(state);
}

function start(connectionId, localPath, opts = {}) {
  if (stopping) return Promise.reject(runnerStoppingError());
  const operation = startInternal(connectionId, localPath, opts);
  pendingStarts.add(operation);
  const remove = () => pendingStarts.delete(operation);
  operation.then(remove, remove);
  return operation;
}

function stop(connectionId) {
  const state = runs.get(connectionId);
  if (!state) return { stopped: false };
  initiateStop(connectionId, state);
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

function stopAll() {
  if (stopAllPromise) return stopAllPromise;
  stopping = true;
  stopAllPromise = (async () => {
    for (const [id, state] of Array.from(runs.entries())) initiateStop(id, state);
    await Promise.allSettled(Array.from(pendingStarts));
    for (const [id, state] of Array.from(runs.entries())) initiateStop(id, state);
    await Promise.allSettled(Array.from(pendingStops));
  })();
  return stopAllPromise;
}

function bestEffortExitCleanup() {
  stopping = true;
  for (const state of runs.values()) {
    try { state.cancelReadyPoll?.(); } catch { /* best effort */ }
    try { state.server?.close(); } catch { /* best effort */ }
    sendGracefulTermination(state.proc);
  }
}
process.once('exit', bestEffortExitCleanup);

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
  normaliseRuntimeEnv,
  isRuntimeEnvFile,
  _runs: runs,
  _pendingStarts: pendingStarts,
  _pendingStops: pendingStops,
  _isStopping: () => stopping,
  _waitForProcessTreeQuiescence: waitForProcessTreeQuiescence,
  _createWindowsProcessTreeTracker: createWindowsProcessTreeTracker,
};

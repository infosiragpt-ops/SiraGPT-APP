'use strict';

/**
 * host-runner — a no-Docker, in-process dev-server runner for the /code module.
 *
 * Runs a generated project (Vite/Next/Node) as a REAL dev server on a free
 * localhost port by spawning `npm install` + `vite`/`next dev` as child
 * processes on the host. The /code preview then iframes `http://localhost:<port>`
 * directly, so HMR works natively (the dev server's websocket is same-origin
 * with the iframe — no proxy needed). This is the "Replit-like" path for
 * environments WITHOUT Docker (e.g. local dev).
 *
 * Safety: disabled in production by default (set CODE_HOST_RUNNER=1 to force on)
 * so the web server never installs/runs untrusted code. Locally you run your own
 * generated code, which is acceptable. Paths are sanitised against traversal,
 * files are capped, runs are concurrency-capped and idle-reaped, and every child
 * is spawned in its own process group so stop kills the whole tree.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const ROOT = path.join(os.tmpdir(), 'siragpt-coderun');

const MAX_FILES = Number(process.env.CODE_RUNNER_MAX_FILES) || 300;
const MAX_FILE_BYTES = Number(process.env.CODE_RUNNER_MAX_FILE_BYTES) || 3 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = Number(process.env.CODE_RUNNER_INSTALL_TIMEOUT_MS) || 180_000;
const READY_TIMEOUT_MS = Number(process.env.CODE_RUNNER_READY_TIMEOUT_MS) || 120_000;
const MAX_CONCURRENT = Number(process.env.CODE_RUNNER_MAX_CONCURRENT) || 2;
const IDLE_TTL_MS = Number(process.env.CODE_RUNNER_IDLE_TTL_MS) || 30 * 60_000;
const LOG_TAIL = 200;

/** runId -> run state */
const runs = new Map();

function flagEnabled(value, fallback = false) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(raw)) return true;
  if (['0', 'false', 'off', 'no'].includes(raw)) return false;
  return fallback;
}

function enabled() {
  const flag = String(process.env.CODE_HOST_RUNNER || '').toLowerCase();
  if (flag === '1' || flag === 'true' || flag === 'on') return true;
  if (flag === '0' || flag === 'false' || flag === 'off') return false;
  // Default: on for dev, off in production (don't run untrusted installs on the web server).
  return process.env.NODE_ENV !== 'production';
}

/**
 * Optional per-user gate. When CODE_HOST_RUNNER_ALLOWED_USER_IDS is set (comma
 * list), only those user ids may start a run; otherwise any authenticated user
 * may (CODE_HOST_RUNNER is the primary gate). Lets a multi-user deploy restrict
 * code execution to the owner without flipping the enable flag.
 */
function startAllowed(user) {
  const ids = String(process.env.CODE_HOST_RUNNER_ALLOWED_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return true;
  return !!(user && ids.includes(String(user.id)));
}

function useProxyUrls() {
  return flagEnabled(process.env.CODE_RUNNER_PROXY_URLS, process.env.NODE_ENV === 'production');
}

function publicBasePath(runId) {
  return `/api/code-runner/${encodeURIComponent(safeId(runId))}/proxy/`;
}

function publicDevUrl(runId, port) {
  if (useProxyUrls()) return publicBasePath(runId);
  return `http://localhost:${port}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeId(runId) {
  const s = String(runId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return s || crypto.randomBytes(8).toString('hex');
}

/** Normalise a project-relative path, rejecting traversal / absolute / nul. */
function safeRel(p) {
  if (typeof p !== 'string' || !p) return null;
  const norm = path.posix.normalize(p.replace(/\\/g, '/')).replace(/^\/+/, '');
  if (!norm || norm === '.' || norm.startsWith('..') || norm.includes('/../') || norm.includes('\0')) return null;
  if (path.isAbsolute(norm)) return null;
  return norm;
}

/** Accept the workspace shape (object path->content) OR an array of {path,content}. */
function normaliseFiles(input) {
  const out = [];
  const push = (p, c) => {
    const rel = safeRel(p);
    if (!rel) return;
    const content = typeof c === 'string' ? c : '';
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) return;
    out.push({ path: rel, content });
  };
  if (Array.isArray(input)) {
    for (const f of input) if (f && typeof f === 'object') push(f.path, f.content);
  } else if (input && typeof input === 'object') {
    for (const [p, c] of Object.entries(input)) push(p, c);
  }
  return out.slice(0, MAX_FILES);
}

function pushLog(run, chunk) {
  const text = String(chunk).replace(/\[[0-9;]*m/g, ''); // strip ANSI
  for (const line of text.split(/\r?\n/)) {
    const t = line.trimEnd();
    if (!t) continue;
    run.logs.push(t);
  }
  if (run.logs.length > LOG_TAIL) run.logs = run.logs.slice(-LOG_TAIL);
}

function envFor(extra = {}) {
  return {
    ...process.env,
    NODE_ENV: 'development', // force: install must include devDeps (vite), dev servers must run dev
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    BROWSER: 'none',
    npm_config_loglevel: 'error',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    ...extra,
  };
}

function killGroup(child) {
  if (!child || child.killed) return;
  try {
    process.kill(-child.pid, 'SIGTERM'); // detached → kill the whole group
  } catch {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function detectFramework(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const hasDevScript = pkg.scripts && typeof pkg.scripts.dev === 'string';
    if (deps.next) return { name: 'next', hasDevScript };
    if (deps.vite || deps['@vitejs/plugin-react']) return { name: 'vite', hasDevScript };
    return { name: hasDevScript ? 'node' : 'vite', hasDevScript };
  } catch {
    return { name: 'vite', hasDevScript: false };
  }
}

function pkgHash(dir) {
  try {
    const pkg = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
    let lock = '';
    try { lock = fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'); } catch { /* none */ }
    return crypto.createHash('sha1').update(pkg + lock).digest('hex');
  } catch {
    return '';
  }
}

function needInstall(dir) {
  const hasModules = fs.existsSync(path.join(dir, 'node_modules'));
  if (!hasModules) return true;
  try {
    const prev = fs.readFileSync(path.join(dir, '.sira-pkg-hash'), 'utf8').trim();
    return prev !== pkgHash(dir);
  } catch {
    return true;
  }
}

async function writeFiles(dir, files) {
  await fsp.mkdir(dir, { recursive: true });
  for (const f of files) {
    const full = path.join(dir, f.path);
    if (!full.startsWith(dir + path.sep)) continue; // defence in depth
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, f.content, 'utf8');
  }
}

function installDeps(dir, run) {
  return new Promise((resolve, reject) => {
    pushLog(run, '$ npm install');
    const child = spawn('npm', ['install', '--no-audit', '--no-fund', '--include=dev', '--loglevel=error'], {
      cwd: dir,
      detached: true,
      env: envFor(),
    });
    run.installChild = child;
    const to = setTimeout(() => {
      killGroup(child);
      reject(new Error('npm install excedió el tiempo límite'));
    }, INSTALL_TIMEOUT_MS);
    child.stdout.on('data', (d) => pushLog(run, d));
    child.stderr.on('data', (d) => pushLog(run, d));
    child.on('error', (e) => { clearTimeout(to); run.installChild = null; reject(e); });
    child.on('close', (code) => {
      clearTimeout(to);
      run.installChild = null;
      if (run.stopped) return resolve();
      if (code === 0) {
        try { fs.writeFileSync(path.join(dir, '.sira-pkg-hash'), pkgHash(dir)); } catch { /* best effort */ }
        resolve();
      } else {
        reject(new Error(`npm install falló (código ${code})`));
      }
    });
  });
}

function startDev(dir, fw, port, run) {
  let cmd;
  let args;
  if (fw.name === 'next') {
    cmd = 'npx';
    args = ['--no-install', 'next', 'dev', '-p', String(port), '-H', '127.0.0.1'];
  } else if (fw.name === 'vite') {
    cmd = 'npx';
    args = ['--no-install', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'];
    // --base makes vite emit asset/module URLs under the public reverse-proxy
    // prefix (which includes the run token) so they resolve when the preview
    // iframes /api/code-runner/<id>/<token>/app/.
    if (useProxyUrls()) args.push('--base', run.basePath);
  } else {
    cmd = 'npm';
    args = ['run', 'dev'];
  }
  pushLog(run, `$ ${cmd} ${args.join(' ')}`);
  const child = spawn(cmd, args, {
    cwd: dir,
    detached: true,
    env: envFor({ PORT: String(port), HOST: '127.0.0.1' }),
  });
  run.child = child;
  child.stdout.on('data', (d) => pushLog(run, d));
  child.stderr.on('data', (d) => pushLog(run, d));
  child.on('error', (e) => { run.error = e.message; run.phase = 'error'; });
  child.on('close', (code) => {
    run.child = null;
    if (run.phase !== 'ready' && !run.stopped) {
      run.phase = 'error';
      run.error = run.error || `el dev server terminó (código ${code})`;
    }
  });
}

async function probeReady(port, basePath, deadline, run) {
  const probeUrl = `http://127.0.0.1:${port}${basePath || '/'}`;
  while (Date.now() < deadline && !run.stopped) {
    if (run.phase === 'error') throw new Error(run.error || 'error del dev server');
    try {
      await fetch(probeUrl, { signal: AbortSignal.timeout(3000) });
      return; // any HTTP response means the server is listening
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  if (run.stopped) return;
  throw new Error('el dev server no respondió a tiempo');
}

async function pipeline(run) {
  const fw = detectFramework(run.dir);
  run.framework = fw.name;
  if (needInstall(run.dir)) {
    run.phase = 'installing';
    await installDeps(run.dir, run);
  } else {
    pushLog(run, 'dependencias en caché — omito npm install');
  }
  if (run.stopped) return;
  run.phase = 'starting';
  const port = await findFreePort();
  run.port = port;
  run.internalUrl = `http://127.0.0.1:${port}`;
  // Public, same-origin URL the browser reaches through the Next.js → Express
  // proxy. The real dev server stays private on 127.0.0.1:<port>.
  run.devUrl = useProxyUrls() ? run.basePath : publicDevUrl(run.runId, port);
  pushLog(run, `dev server en ${run.devUrl}`);
  startDev(run.dir, fw, port, run);
  await probeReady(port, useProxyUrls() ? run.basePath : '/', Date.now() + READY_TIMEOUT_MS, run);
  if (run.stopped) return;
  run.phase = 'ready';
  pushLog(run, 'listo ✓');
}

function evictIfNeeded() {
  const active = [...runs.values()];
  if (active.length < MAX_CONCURRENT) return;
  // stop the least-recently-touched run to make room
  active.sort((a, b) => a.lastTouch - b.lastTouch);
  stopRun(active[0].runId);
}

/** Start (or restart) a run. Returns immediately; the install/boot runs async. */
async function startRun({ runId, userId, files }) {
  if (!enabled()) {
    const e = new Error('host_runner_disabled');
    e.code = 'disabled';
    throw e;
  }
  const id = safeId(runId);
  const norm = normaliseFiles(files);
  if (!norm.some((f) => f.path === 'package.json')) {
    const e = new Error('el proyecto no tiene package.json — no es ejecutable');
    e.code = 'no_package';
    throw e;
  }
  if (runs.has(id)) stopRun(id); // restart cleanly, but keep the dir (node_modules cache)
  evictIfNeeded();

  const dir = path.join(ROOT, id);
  // The preview token rides in the URL PATH (not a cookie). The preview iframe is
  // sandboxed → opaque ("null") origin, and Vite's <script type="module"> fetches
  // use a credentials mode that won't send a cross-origin cookie, so a cookie
  // gate would 403 every asset. A path-embedded token is carried automatically by
  // every asset/module/dynamic-import request regardless of credentials or CORS.
  const previewToken = crypto.randomBytes(24).toString('hex');
  const basePath = `/api/code-runner/${id}/${previewToken}/app/`;
  const run = {
    runId: id,
    userId: userId || null,
    dir,
    basePath,
    previewToken,
    phase: 'installing',
    framework: null,
    port: null,
    devUrl: '',
    internalUrl: '',
    logs: [],
    error: null,
    child: null,
    installChild: null,
    stopped: false,
    createdAt: Date.now(),
    lastTouch: Date.now(),
  };
  runs.set(id, run);
  await writeFiles(dir, norm);
  pipeline(run).catch((err) => {
    if (run.stopped) return;
    run.phase = 'error';
    run.error = String((err && err.message) || err);
    killGroup(run.child);
    killGroup(run.installChild);
  });
  return { runId: id, phase: run.phase, devUrl: run.devUrl, framework: run.framework };
}

function stopRun(runId) {
  const id = safeId(runId);
  const run = runs.get(id);
  if (!run) return;
  run.stopped = true;
  run.phase = 'stopped';
  killGroup(run.installChild);
  killGroup(run.child);
  run.installChild = null;
  run.child = null;
  runs.delete(id);
  // The dir (incl. node_modules) is intentionally kept for fast re-runs; the
  // idle reaper / OS tmp cleanup handles disk over time.
}

function getStatus(runId, userId) {
  const id = safeId(runId);
  const run = runs.get(id);
  if (!run) {
    return { running: false, ready: false, phase: 'idle', framework: null, error: null, tail: [], devUrl: '' };
  }
  if (userId && run.userId && run.userId !== userId) return null; // ownership mismatch
  run.lastTouch = Date.now();
  return {
    running: ['installing', 'starting', 'ready'].includes(run.phase),
    ready: run.phase === 'ready',
    phase: run.phase,
    framework: run.framework,
    error: run.error,
    tail: run.logs.slice(-14),
    devUrl: run.devUrl,
    port: run.port,
  };
}

/**
 * Resolve the private dev-server port for a run, gated by its run-scoped preview
 * token (carried in the reverse-proxy URL path). Returns null when the run is
 * unknown, not yet bound to a port, or the token doesn't match.
 */
function getRunForProxy(runId, previewToken) {
  const id = safeId(runId);
  const run = runs.get(id);
  if (!run || !run.previewToken || !previewToken) return null;
  if (run.previewToken !== previewToken) return null;
  if (!run.port) return null;
  run.lastTouch = Date.now();
  return { port: run.port };
}

/** The run-scoped preview token (also embedded in devUrl; kept for tests). */
function getPreviewToken(runId) {
  const run = runs.get(safeId(runId));
  return run ? run.previewToken : null;
}

function getProxyTarget(runId, userId) {
  const id = safeId(runId);
  const run = runs.get(id);
  if (!run) return { error: 'not_found' };
  if (userId && run.userId && run.userId !== userId) return { error: 'forbidden' };
  run.lastTouch = Date.now();
  if (!run.port || !['starting', 'ready'].includes(run.phase)) {
    return { error: 'not_ready', phase: run.phase, message: run.error || 'dev server not ready' };
  }
  return { port: run.port, phase: run.phase, framework: run.framework };
}

// Idle reaper — stop dev servers nobody is watching.
const reaper = setInterval(() => {
  const now = Date.now();
  for (const [id, run] of runs) {
    if (now - run.lastTouch > IDLE_TTL_MS) stopRun(id);
  }
}, 60_000);
if (typeof reaper.unref === 'function') reaper.unref();

// Best-effort kill of every child on process exit (sync only).
process.on('exit', () => {
  for (const id of [...runs.keys()]) {
    const run = runs.get(id);
    killGroup(run && run.installChild);
    killGroup(run && run.child);
  }
});

module.exports = {
  enabled,
  startAllowed,
  startRun,
  stopRun,
  getStatus,
  getRunForProxy,
  getPreviewToken,
  getProxyTarget,
  publicBasePath,
  publicDevUrl,
  useProxyUrls,
};

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
const { buildUntrustedChildEnv } = require('../../utils/untrusted-child-env');
const { verifyRenderedApp } = require('./verify-agent');

const ROOT = path.join(os.tmpdir(), 'siragpt-coderun');

const MAX_FILES = Number(process.env.CODE_RUNNER_MAX_FILES) || 300;
const MAX_FILE_BYTES = Number(process.env.CODE_RUNNER_MAX_FILE_BYTES) || 3 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = Number(process.env.CODE_RUNNER_INSTALL_TIMEOUT_MS) || 180_000;
const READY_TIMEOUT_MS = Number(process.env.CODE_RUNNER_READY_TIMEOUT_MS) || 120_000;
const MAX_CONCURRENT = Number(process.env.CODE_RUNNER_MAX_CONCURRENT) || 2;
const IDLE_TTL_MS = Number(process.env.CODE_RUNNER_IDLE_TTL_MS) || 30 * 60_000;
const RUNTIME_VERIFY_TIMEOUT_MS = Number(process.env.CODE_RUNNER_VERIFY_TIMEOUT_MS) || 20_000;
const LOG_TAIL = 200;
const MAX_ENV_KEYS = 120;
const MAX_ENV_VALUE_BYTES = 32 * 1024;
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

/** runId -> run state */
const runs = new Map();

function isRuntimeEnvFile(p) {
  return RUNTIME_ENV_FILE_RE.test(String(p || '').replace(/\\/g, '/'));
}

function flagEnabled(value, fallback = false) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(raw)) return true;
  if (['0', 'false', 'off', 'no'].includes(raw)) return false;
  return fallback;
}

function enabled() {
  const flag = String(process.env.CODE_HOST_RUNNER || '').toLowerCase();
  if (flag === '1' || flag === 'true' || flag === 'on') {
    // This runner executes npm lifecycle scripts and `/bin/sh -c` in the same
    // container/process namespace as the API. An allowlist limits WHO can reach
    // it; it does not isolate WHAT their generated code can access. Production
    // therefore needs an intentionally loud second key and remains off by
    // default even when an old deployment still carries CODE_HOST_RUNNER=1.
    if (process.env.NODE_ENV === 'production') {
      return String(process.env.CODE_HOST_RUNNER_UNSAFE_PRODUCTION_ACK || '').trim()
        === 'I_UNDERSTAND_THIS_EXECUTES_UNTRUSTED_CODE_ON_THE_API_HOST';
    }
    return true;
  }
  if (flag === '0' || flag === 'false' || flag === 'off') return false;
  // Default: on for dev, off in production (don't run untrusted installs on the web server).
  return process.env.NODE_ENV !== 'production';
}

/**
 * Per-user gate. When CODE_HOST_RUNNER_ALLOWED_USER_IDS is set (comma list),
 * only those user ids may start a run.
 *
 * FAIL-CLOSED: when the runner is EXPLICITLY forced on (CODE_HOST_RUNNER=1)
 * and the allowlist is empty, every start is DENIED — /exec is a real
 * `/bin/sh -c` on the host, so "flag on + no allowlist" would hand arbitrary
 * shell execution to ANY authenticated user. The historical open behaviour is
 * kept only for the implicit dev default (flag unset, NODE_ENV!==production),
 * where the runner serves a single local developer.
 */
let warnedEmptyAllowlist = false;
function explicitlyEnabled() {
  return ['1', 'true', 'on', 'yes'].includes(String(process.env.CODE_HOST_RUNNER || '').trim().toLowerCase());
}
function startAllowed(user) {
  const ids = String(process.env.CODE_HOST_RUNNER_ALLOWED_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    if (explicitlyEnabled()) {
      if (!warnedEmptyAllowlist) {
        warnedEmptyAllowlist = true;
        console.warn(
          '[host-runner] CODE_HOST_RUNNER está activado pero CODE_HOST_RUNNER_ALLOWED_USER_IDS está vacío. ' +
          'Denegando TODOS los arranques (fail-closed): sin allowlist, cualquier usuario autenticado podría ' +
          'ejecutar comandos de shell en el host. Configura CODE_HOST_RUNNER_ALLOWED_USER_IDS con la lista ' +
          'de ids de usuario permitidos (separados por comas).',
        );
      }
      return false;
    }
    // Implicit dev default (flag unset): single-developer local machine.
    return true;
  }
  return !!(user && ids.includes(String(user.id)));
}

function shouldUseProxyUrls() {
  return flagEnabled(process.env.CODE_RUNNER_PROXY_URLS, process.env.NODE_ENV === 'production');
}

function proxyUrlsEnabled() {
  return shouldUseProxyUrls();
}

function publicBasePath(runId) {
  return `/api/code-runner/${encodeURIComponent(safeId(runId))}/proxy/`;
}

function publicDevUrl(runId, port) {
  if (shouldUseProxyUrls()) return publicBasePath(runId);
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

function redactRuntimeEnv(text, runtimeEnv = {}) {
  let out = String(text);
  for (const value of Object.values(runtimeEnv || {})) {
    const secret = String(value || '');
    if (secret.length < 4) continue;
    out = out.split(secret).join('[secret]');
  }
  return out;
}

function pushLog(run, chunk) {
  const text = redactRuntimeEnv(String(chunk).replace(/\[[0-9;]*m/g, ''), run && run.runtimeEnv); // strip ANSI
  for (const line of text.split(/\r?\n/)) {
    const t = line.trimEnd();
    if (!t) continue;
    run.logs.push(t);
  }
  if (run.logs.length > LOG_TAIL) run.logs = run.logs.slice(-LOG_TAIL);
}

function envFor(extra = {}) {
  // SECURITY: this spawns untrusted generated/user code — never inherit
  // SiraGPT secrets via ...process.env. Forward only an allowlisted toolchain
  // env plus our explicit, non-secret overrides.
  return buildUntrustedChildEnv({
    NODE_ENV: 'development', // force: install must include devDeps (vite), dev servers must run dev
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    BROWSER: 'none',
    npm_config_loglevel: 'error',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    ...extra,
  });
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

function killGroup(child) {
  if (!child || child.killed) return;
  try {
    process.kill(-child.pid, 'SIGTERM'); // detached ? kill the whole group
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

function previewBasePath(run) {
  return String((run && run.basePath) || '').replace(/\/+$/, '');
}

function ensureNextPreviewConfig(dir, run) {
  if (!shouldUseProxyUrls()) return;
  const basePath = previewBasePath(run);
  if (!basePath) return;

  const configPath = path.join(dir, 'next.config.mjs');
  const config = [
    '/** @type {import("next").NextConfig} */',
    "const previewBasePath = process.env.SIRA_PREVIEW_BASE_PATH || '';",
    '',
    'const nextConfig = {',
    '  reactStrictMode: true,',
    '  ...(previewBasePath ? {',
    '    basePath: previewBasePath,',
    '    assetPrefix: previewBasePath,',
    '  } : {}),',
    '};',
    '',
    'export default nextConfig;',
    '',
  ].join('\n');

  fs.writeFileSync(configPath, config, 'utf8');
  pushLog(run, `Next preview basePath: ${basePath}`);
}

async function writeFiles(dir, files) {
  await fsp.mkdir(dir, { recursive: true });
  for (const f of files) {
    // Secrets are injected into the dev server env. Do not write raw .env
    // files into the runner directory where install scripts could read them.
    if (isRuntimeEnvFile(f.path)) continue;
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
    if (fw.hasDevScript) {
      cmd = 'npm';
      args = ['run', 'dev', '--', '-p', String(port), '-H', '127.0.0.1'];
    } else {
      cmd = 'npx';
      args = ['--no-install', 'next', 'dev', '-p', String(port), '-H', '127.0.0.1'];
    }
  } else if (fw.name === 'vite') {
    cmd = 'npx';
    args = ['--no-install', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'];
    // --base makes vite emit asset/module URLs under the public reverse-proxy
    // prefix (which includes the run token) so they resolve when the preview
    // iframes /api/code-runner/<id>/<token>/app/.
    if (shouldUseProxyUrls()) args.push('--base', run.basePath);
  } else {
    cmd = 'npm';
    args = ['run', 'dev'];
  }
  pushLog(run, `$ ${cmd} ${args.join(' ')}`);
  const nextPreviewBasePath = fw.name === 'next' && shouldUseProxyUrls() ? previewBasePath(run) : '';
  const child = spawn(cmd, args, {
    cwd: dir,
    detached: true,
    env: envFor({
      ...run.runtimeEnv,
      PORT: String(port),
      HOST: '127.0.0.1',
      ...(nextPreviewBasePath ? {
        SIRA_PREVIEW_BASE_PATH: nextPreviewBasePath,
        NEXT_PUBLIC_SIRA_PREVIEW_BASE_PATH: nextPreviewBasePath,
      } : {}),
    }),
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

// A dev server can be "listening" yet serving a compile/runtime error page,
// so a bare fetch is not proof of readiness. These markers identify Next.js
// and Vite dev error overlays / build-error responses.
const ERROR_OVERLAY_RE =
  /nextjs__container_errors|__NEXT_ERROR|nextjs-portal|Failed to compile|Unhandled Runtime Error|Module not found|vite-error-overlay|<vite-error-overlay|plugin:vite/i;

function hasErrorOverlay(body) {
  if (!body) return false;
  return ERROR_OVERLAY_RE.test(String(body));
}

function strictReadyEnabled() {
  // Strict readiness (reject 5xx / error overlays) is ON by default; the kill
  // switch CODE_RUNNER_STRICT_READY=0 restores "any response = ready".
  return !['0', 'false', 'no', 'off'].includes(
    String(process.env.CODE_RUNNER_STRICT_READY || '').toLowerCase(),
  );
}

async function probeReady(port, basePath, deadline, run) {
  const probeUrl = `http://127.0.0.1:${port}${basePath || '/'}`;
  const strict = strictReadyEnabled();
  let lastBad = null;
  while (Date.now() < deadline && !run.stopped) {
    if (run.phase === 'error') throw new Error(run.error || 'error del dev server');
    try {
      const res = await fetch(probeUrl, { signal: AbortSignal.timeout(3000) });
      if (!strict) return; // legacy: any HTTP response means it's listening
      // Read a bounded prefix to spot a compile/runtime error overlay.
      let body = '';
      try { body = (await res.text()).slice(0, 8000); } catch { body = ''; }
      if (res.status >= 500) {
        lastBad = `HTTP ${res.status}`; // up but erroring — keep waiting
      } else if (hasErrorOverlay(body)) {
        lastBad = 'error de compilación en la app'; // overlay may clear on recompile
      } else {
        return; // 2xx/3xx/4xx without an error overlay → serving for real
      }
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  if (run.stopped) return;
  throw new Error(
    lastBad
      ? `el dev server arrancó pero con errores (${lastBad})`
      : 'el dev server no respondió a tiempo',
  );
}

async function pipeline(run) {
  const fw = detectFramework(run.dir);
  run.framework = fw.name;
  if (fw.name === 'next') ensureNextPreviewConfig(run.dir, run);
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
  // Public, same-origin URL the browser reaches through the Next.js ? Express
  // proxy. The real dev server stays private on 127.0.0.1:<port>.
  run.devUrl = shouldUseProxyUrls() ? run.basePath : publicDevUrl(run.runId, port);
  pushLog(run, `dev server en ${run.devUrl}`);
  startDev(run.dir, fw, port, run);
  await probeReady(port, shouldUseProxyUrls() ? run.basePath : '/', Date.now() + READY_TIMEOUT_MS, run);
  if (run.stopped) return;
  run.phase = 'ready';
  pushLog(run, 'listo ?');
}

function evictIfNeeded(userId) {
  // Only LIVE runs (a real dev server installing/booting/serving) count toward
  // the global cap. Errored/dead runs linger in the map with no live child and
  // must not deny capacity to other users.
  const active = [...runs.values()].filter((r) => ['installing', 'starting', 'ready'].includes(r.phase));
  if (active.length < MAX_CONCURRENT) return;
  // Only ever evict the CALLER's OWN least-recently-touched run — never kill
  // another user's live dev server to make room (cross-user eviction DoS).
  const mine = active
    .filter((r) => (r.userId || null) === (userId || null))
    .sort((a, b) => a.lastTouch - b.lastTouch);
  if (mine.length) {
    stopRun(mine[0].runId);
    return;
  }
  // At the global cap and the caller owns none of the active runs → refuse
  // rather than evicting someone else's run.
  const e = new Error('capacidad de ejecución llena — vuelve a intentar en un momento');
  e.code = 'capacity_full';
  throw e;
}

/** Start (or restart) a run. Returns immediately; the install/boot runs async. */
async function startRun({ runId, userId, files, env }) {
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
  // Restart cleanly, but reject if the same runId is already owned by ANOTHER
  // user (client-supplied runId collision / cross-user takeover).
  const existing = runs.get(id);
  if (existing && existing.userId && userId && existing.userId !== userId) {
    const e = new Error('forbidden');
    e.code = 'forbidden';
    throw e;
  }
  if (existing) stopRun(id); // same owner / unowned → restart, keep the dir (node_modules cache)
  evictIfNeeded(userId);

  const dir = path.join(ROOT, id);
  // The preview token rides in the URL PATH (not a cookie). The preview iframe is
  // sandboxed ? opaque ("null") origin, and Vite's <script type="module"> fetches
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
    runtimeEnv: normaliseRuntimeEnv(env),
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
    run.port = null; // a failed run's port is dead — never let the proxy reach it
    run.error = String((err && err.message) || err);
    killGroup(run.child);
    killGroup(run.installChild);
  });
  return { runId: id, phase: run.phase, devUrl: run.devUrl, framework: run.framework };
}

function stopRun(runId, userId) {
  const id = safeId(runId);
  const run = runs.get(id);
  if (!run) return false;
  // Ownership gate: an authenticated caller (userId given) may only stop their
  // OWN run. Internal callers (evict, restart, idle reaper) pass no userId and
  // bypass the check by design.
  if (userId && run.userId && run.userId !== userId) return false;
  run.stopped = true;
  run.phase = 'stopped';
  run.port = null; // never proxy to a (possibly OS-recycled) port after stop
  killGroup(run.installChild);
  killGroup(run.child);
  run.installChild = null;
  run.child = null;
  runs.delete(id);
  // The dir (incl. node_modules) is intentionally kept for fast re-runs; the
  // idle reaper / OS tmp cleanup handles disk over time.
  return true;
}

function getStatus(runId, userId) {
  const id = safeId(runId);
  const run = runs.get(id);
  if (!run) {
    return { running: false, ready: false, phase: 'idle', framework: null, error: null, tail: [], devUrl: '' };
  }
  if (userId && run.userId && run.userId !== userId) return null; // ownership mismatch
  // Only refresh liveness for non-terminal runs. A client polling a FAILED run
  // must not keep it alive past the idle reaper (dead runs should be collectable).
  if (run.phase !== 'error') run.lastTouch = Date.now();
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

// ── Type verification (tsc --noEmit) ────────────────────────────────
// The readiness probe proves the dev server responds; it cannot prove the
// TypeScript in the project compiles. verifyRun runs `npx tsc --noEmit`
// inside the run's workspace (typescript is a devDependency of generated
// projects and npm install runs --include=dev) and parses the diagnostics
// into [{file, line, col, code, message}] the auto-repair loop can consume.

const VERIFY_TIMEOUT_MS = Math.max(30_000, Number(process.env.CODE_RUNNER_VERIFY_TIMEOUT_MS) || 90_000);
// tsc --pretty false diagnostics: "path/file.ts(12,5): error TS2322: message"
const TSC_DIAG_RE = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/;

function parseTscOutput(stdout) {
  const errors = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = TSC_DIAG_RE.exec(line.trim());
    if (!m) continue;
    errors.push({ file: m[1], line: Number(m[2]), col: Number(m[3]), code: m[4], message: m[5] });
    if (errors.length >= 50) break; // bounded payload
  }
  return errors;
}

async function verifyRun(runId, userId) {
  const id = safeId(runId);
  const run = runs.get(id);
  if (!run) return { ok: false, status: 404, error: 'run desconocido' };
  if (userId && run.userId && run.userId !== userId) return { ok: false, status: 403, error: 'forbidden' };
  run.lastTouch = Date.now();
  // Only meaningful for TypeScript projects; a JS-only project passes trivially.
  if (!fs.existsSync(path.join(run.dir, 'tsconfig.json'))) {
    return { ok: true, skipped: true, reason: 'no_tsconfig', errors: [] };
  }
  if (run.verifyPromise) return run.verifyPromise; // dedupe concurrent verifies

  run.verifyPromise = new Promise((resolve) => {
    pushLog(run, '$ npx tsc --noEmit (verificación de tipos)');
    let out = '';
    const child = spawn('npx', ['tsc', '--noEmit', '--pretty', 'false'], {
      cwd: run.dir,
      detached: true,
      env: envFor(),
    });
    const to = setTimeout(() => {
      killGroup(child);
      resolve({ ok: false, timedOut: true, errors: [], error: 'tsc excedió el tiempo límite' });
    }, VERIFY_TIMEOUT_MS);
    const collect = (d) => { if (out.length < 400_000) out += String(d); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (e) => {
      clearTimeout(to);
      // Fail-open: a broken verifier must not block the preview flow.
      resolve({ ok: true, skipped: true, reason: `tsc no disponible: ${e.message}`, errors: [] });
    });
    child.on('close', (code) => {
      clearTimeout(to);
      const errors = parseTscOutput(out);
      const ok = code === 0;
      pushLog(run, ok ? 'tipos OK (tsc --noEmit limpio)' : `tsc encontró ${errors.length} error(es) de tipos`);
      resolve({ ok, exitCode: code, errors, errorCount: errors.length });
    });
  }).finally(() => { run.verifyPromise = null; });
  return run.verifyPromise;
}

const EXEC_TIMEOUT_MS = Math.max(1000, Number(process.env.CODE_RUNNER_EXEC_TIMEOUT_MS) || 30_000);
const EXEC_MAX_OUTPUT = Math.max(1024, Number(process.env.CODE_RUNNER_EXEC_MAX_OUTPUT) || 200_000);
const EXEC_MAX_CMD_LEN = 4000;
// A real, one-shot terminal command in the run's own workspace dir. This is
// NOT a new trust boundary: the run already installs + executes untrusted
// generated code in this dir, and it is owner-gated + host-runner-gated. It is
// bounded — non-interactive, single shell invocation, hard timeout, output
// capped — so it can't be used for a long-lived reverse shell or to exhaust
// memory. Secrets are never inherited (envFor → buildUntrustedChildEnv).
//
// OPERATIONAL NOTE: `cwd = run.dir` is a starting directory, NOT a filesystem
// sandbox — the command runs as the server's OS user and absolute paths reach
// anything that user can read (including other runs' dirs). The per-user 403
// gate does NOT imply per-user file isolation. Like the runner in general, this
// is safe only on a SINGLE-TENANT / owner-gated deploy (CODE_HOST_RUNNER +
// CODE_HOST_RUNNER_ALLOWED_USER_IDS). Do NOT enable on a shared multi-tenant host.
async function execInRun(runId, userId, command, opts = {}) {
  const id = safeId(runId);
  const run = runs.get(id);
  if (!run) return { ok: false, status: 404, error: 'run desconocido' };
  if (userId && run.userId && run.userId !== userId) return { ok: false, status: 403, error: 'forbidden' };
  const cmd = String(command || '').trim();
  if (!cmd) return { ok: false, status: 400, error: 'comando vacío' };
  if (cmd.length > EXEC_MAX_CMD_LEN) return { ok: false, status: 400, error: 'comando demasiado largo' };
  if (cmd.includes('\0')) return { ok: false, status: 400, error: 'comando inválido' };
  run.lastTouch = Date.now();

  const timeoutMs = Math.min(EXEC_TIMEOUT_MS, Math.max(1000, Number(opts.timeoutMs) || EXEC_TIMEOUT_MS));
  return new Promise((resolve) => {
    let out = '';
    let truncated = false;
    let settled = false;
    // Non-login, non-interactive shell in the run dir. `sh -c` so full command
    // lines (pipes, args, &&) work like a normal terminal.
    const child = spawn('/bin/sh', ['-c', cmd], {
      cwd: run.dir,
      detached: true,
      env: envFor(),
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(to);
      resolve(result);
    };
    const cleanOutput = (raw) => redactRuntimeEnv(String(raw).replace(/\x1b\[[0-9;]*m/g, ''), run.runtimeEnv);
    const to = setTimeout(() => {
      killGroup(child);
      finish({ ok: false, timedOut: true, output: cleanOutput(out), error: `el comando excedió ${Math.round(timeoutMs / 1000)}s`, truncated });
    }, timeoutMs);
    const collect = (d) => {
      if (truncated) return;
      const s = String(d);
      if (out.length + s.length > EXEC_MAX_OUTPUT) {
        out += s.slice(0, Math.max(0, EXEC_MAX_OUTPUT - out.length));
        out += '\n… (salida truncada)';
        truncated = true;
        // Stop the command once its output is useless — an unbounded emitter
        // (e.g. `yes`) would otherwise pin a core until the timeout fires.
        killGroup(child);
        return;
      }
      out += s;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (e) => finish({ ok: false, status: 500, output: cleanOutput(out), error: e.message, truncated }));
    child.on('close', (code) => {
      // Strip ANSI + redact any runtime-env secret values that leaked to stdout.
      finish({ ok: code === 0, exitCode: code, output: cleanOutput(out), truncated });
    });
  });
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
  // Gate on phase like getProxyTarget: a crashed/errored/stopped run can still
  // hold a stale port whose number the OS may have recycled to another process.
  if (!run.port || !['starting', 'ready'].includes(run.phase)) return null;
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

/**
 * Best-effort derivation of the required render markers for a run by scanning a
 * few of its source files on disk. Today it looks for the mandatory landing
 * component «Invitar al proyecto» — if that copy is present in the project we
 * assert it must actually render. Kept generic + optional: a project without the
 * marker simply yields an empty list (verify still checks blank/overlay/errors).
 */
function deriveRequiredMarkers(run) {
  const markers = [];
  try {
    const dir = run && run.dir;
    if (!dir) return markers;
    // Only the small, likely-source files — never a recursive node_modules walk.
    const candidates = ['src/App.tsx', 'src/App.jsx', 'src/App.js', 'index.html'];
    for (const rel of candidates) {
      const full = path.join(dir, rel);
      let text = '';
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      if (text.includes('Invitar al proyecto') && !markers.includes('Invitar al proyecto')) {
        markers.push('Invitar al proyecto');
      }
    }
  } catch { /* best effort — never block verify on marker derivation */ }
  return markers;
}

/**
 * verifyRuntime — the "does the app actually render?" functional check. Runs the
 * generated project's live dev server through headless chromium (via
 * verify-agent) and reports a verdict. Companion to verifyRun (tsc --noEmit):
 * type-checking proves the code compiles; this proves it actually boots to a
 * working screen (not blank, no error overlay, no JS crash).
 *
 * Ownership-checked + phase-gated like getProxyTarget: only the run's owner may
 * verify it, and only once the dev server is `ready`. NOT auto-run inside
 * pipeline() — the frontend triggers it after `ready`, same as verifyRun.
 *
 * Degrades gracefully: when chromium is unavailable the verdict is
 * { skipped:true, ok:true } — a missing browser never blocks the app.
 */
async function verifyRuntime(runId, userId) {
  const id = safeId(runId);
  const run = runs.get(id);
  if (!run) return { ok: false, skipped: false, error: 'not_found', findings: [] };
  if (userId && run.userId && run.userId !== userId) {
    return { ok: false, skipped: false, error: 'forbidden', findings: [] };
  }
  run.lastTouch = Date.now();
  if (run.phase !== 'ready' || !run.port) {
    return {
      ok: false,
      skipped: true,
      reason: 'not_ready',
      phase: run.phase,
      findings: [],
      summary: 'La app aún no está lista para verificar (el dev server no está en «ready»).',
    };
  }

  // Verify against the PRIVATE dev server directly (127.0.0.1:port + basePath),
  // never through the public reverse-proxy — the check runs server-side.
  const url = `http://127.0.0.1:${run.port}${run.basePath || '/'}`;
  const requiredMarkers = deriveRequiredMarkers(run);

  let verdict;
  try {
    verdict = await verifyRenderedApp({ url, requiredMarkers, timeoutMs: RUNTIME_VERIFY_TIMEOUT_MS });
  } catch (err) {
    // verify-agent is defensive and shouldn't throw, but never let a verify crash
    // the run — degrade to a skipped verdict.
    verdict = {
      ok: true, skipped: true, reason: 'verify_error',
      findings: [], summary: `Verificación omitida: ${(err && err.message) || err}`,
    };
  }

  // Concise log line of the verdict (redacted like every other pushLog line).
  if (verdict.skipped) {
    pushLog(run, `Verificación de runtime omitida (${verdict.reason || 'chromium_unavailable'}).`);
  } else if (verdict.ok) {
    pushLog(run, `Verificación de runtime OK — ${verdict.summary || 'la app renderiza correctamente.'}`);
  } else {
    pushLog(run, `Verificación de runtime FALLÓ — ${verdict.summary || `${(verdict.errors || []).length} problema(s).`}`);
  }

  return verdict;
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
  verifyRuntime,
  publicBasePath,
  publicDevUrl,
  normaliseRuntimeEnv,
  isRuntimeEnvFile,
  useProxyUrls: shouldUseProxyUrls,
  proxyUrlsEnabled,
  hasErrorOverlay,
  strictReadyEnabled,
  probeReady,
  verifyRun,
  execInRun,
  parseTscOutput,
  // Test-only hooks: seed/clear the in-memory run registry WITHOUT spawning a
  // child process, so the ownership / phase-gate logic can be unit-tested.
  // No behavioural impact on the production paths.
  _seedRunForTest: (run) => { runs.set(safeId(run.runId), { port: null, phase: 'ready', previewToken: null, ...run, runId: safeId(run.runId) }); },
  _peekRunForTest: (runId) => runs.get(safeId(runId)) || null,
  _resetRunsForTest: () => { runs.clear(); },
};

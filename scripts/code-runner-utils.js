'use strict';

/**
 * code-runner-utils — pure helpers shared by the runner sidecar and its
 * backend tests. No Bun/Node APIs here: keep it requireable from both.
 */

const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;

// Only boring, non-secret process settings may cross the control-plane ->
// generated-code boundary. Project-specific HOME/cache/tmp and runtime values
// (PORT, HOST, etc.) are supplied explicitly by code-runner.js.
const RUNNER_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'BUN_INSTALL',
]);

// Defense in depth: even an accidental future addition to the allowlist (or
// an unsafe override at a call site) must not leak control-plane credentials.
const SENSITIVE_ENV_KEY_RE = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|(?:^|[_-])KEY(?:$|[_-])|CREDENTIAL|AUTHORIZATION|OAUTH|COOKIE|SESSION|DATABASE[_-]?URL|REDIS[_-]?URL|SSH[_-]?)/i;

// Sandbox-internal allowlist: the agent's terminal goes through the runner,
// but only via these binaries (extended deliberately, per phase).
const ALLOWED_BINS = new Set(['git', 'bun', 'bunx', 'node', 'npm', 'ls', 'cat', 'wc']);
const INTERACTIVE_SCAFFOLD_RE = /^(?:create-next-app|create-vite|create-react-app|create-remix)(?:@.*)?$/i;
const PREVIEW_ERROR_RE = /(?:<vite-error-overlay\b|<nextjs-portal\b|__NEXT_ERROR|failed to compile|internal server error|pre-transform error|error when starting dev server)/i;

function commandRejectionReason(cmd) {
  if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((c) => typeof c === 'string')) return 'invalid_command';
  if (!ALLOWED_BINS.has(cmd[0])) return 'invalid_command';
  if (cmd[0] === 'bunx' && INTERACTIVE_SCAFFOLD_RE.test(cmd[1] || '')) {
    return 'interactive_scaffold_disallowed: usa write_file/edit_file sobre el starter existente en lugar de create-next-app/create-vite.';
  }
  if (cmd[0] === 'bun' && cmd[1] === 'create') {
    return 'interactive_scaffold_disallowed: usa write_file/edit_file sobre el starter existente en lugar de bun create.';
  }
  return null;
}

function sanitizeProjectId(raw) {
  const id = String(raw || '').trim();
  return PROJECT_ID_RE.test(id) ? id : null;
}

function sanitizeRunId(raw) {
  const id = String(raw || '').trim();
  return RUN_ID_RE.test(id) ? id : null;
}

function resolveProjectRelPath(relPath) {
  const p = String(relPath || '').replaceAll('\\', '/').trim();
  if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') return null;
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

/**
 * Upgrade the exact Vite config emitted by SiraGPT's full-stack starter.
 * Besides narrowing the legacy API regex, remove the short-lived HMR-disable
 * line from managed configs now that the backend proxies authenticated Vite
 * WebSocket upgrades to the owning project's runner port.
 *
 * Refuse partial/custom matches to avoid rewriting user configs.
 */
function migrateLegacyViteProxyConfig(content) {
  const source = String(content || '');
  const portLine = 'const apiPort = Number(process.env.API_PORT) || port + 1000';
  const baseLine = "  base: process.env.VITE_BASE || '/',";
  const proxyLine = "      '^.*/api/': {";
  const rewriteLine = "        rewrite: (p) => p.replace(/^.*?\\/api\\//, '/api/'),";
  const managedBaseLine = "const base = process.env.VITE_BASE || '/'";
  const managedApiBaseLine = 'const apiBase = `${base}api`';
  const managedProxyLine = '      [apiBase]: {';
  const managedRewriteLine = "        rewrite: (p) => p.startsWith(apiBase) ? `/api${p.slice(apiBase.length)}` : p,";
  const serverLine = '  server: {';
  const hmrLine = "    hmr: process.env.VITE_HMR === 'false' ? false : undefined,";

  let upgraded = source;
  const isLegacy = source.includes(portLine)
    && source.includes(baseLine)
    && source.includes(proxyLine)
    && source.includes(rewriteLine);
  if (isLegacy) {
    upgraded = upgraded
      .replace(
        portLine,
        `${portLine}\n${managedBaseLine}\n${managedApiBaseLine}`,
      )
      .replace(baseLine, '  base,')
      .replace(proxyLine, managedProxyLine)
      .replace(rewriteLine, managedRewriteLine);
  }

  const isManaged = upgraded.includes(portLine)
    && upgraded.includes(managedBaseLine)
    && upgraded.includes(managedApiBaseLine)
    && upgraded.includes('  base,')
    && upgraded.includes(managedProxyLine)
    && upgraded.includes(managedRewriteLine)
    && upgraded.includes(serverLine);
  if (isManaged && upgraded.includes(hmrLine)) {
    upgraded = upgraded.replace(`${hmrLine}\n`, '');
  }

  return { changed: upgraded !== source, content: upgraded };
}

function previewConfigMigrationMode({ status, headContent, migratedContent } = {}) {
  if (typeof status !== 'string') return 'skip';
  if (!status.trim()) return 'commit';
  if (typeof headContent === 'string' && migratedContent === headContent) return 'restore';
  return 'skip';
}

function isAllowedCommand(cmd) {
  return commandRejectionReason(cmd) === null;
}

function buildPreflightEnabled(env = {}) {
  const configured = String(env.CODE_RUNNER_BUILD_PREFLIGHT ?? '').trim();
  if (configured) return configured !== '0';
  return String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

/**
 * An open TCP port is not a usable preview. For HTML responses, reject blank
 * documents and known Vite/Next error overlays before reporting readiness.
 * Non-HTML custom dev servers remain compatible as long as they return 2xx.
 */
function previewDocumentReady({ status, contentType = '', body = '' } = {}) {
  const code = Number(status);
  if (!Number.isInteger(code) || code < 200 || code >= 300) return false;
  if (!/text\/html|application\/xhtml\+xml/i.test(String(contentType))) return true;
  const html = String(body || '').trim();
  if (!html || PREVIEW_ERROR_RE.test(html)) return false;
  return /<(?:html|body|main|div|script)\b/i.test(html);
}

function isSensitiveEnvKey(key) {
  return SENSITIVE_ENV_KEY_RE.test(String(key || ''));
}

/**
 * Build the complete environment visible to generated code.
 *
 * This intentionally starts from an empty object instead of cloning the
 * runner's process.env. `overrides` is still filtered so a refactor cannot
 * accidentally pass CODE_RUNNER_CONTROL_TOKEN (or another secret) through.
 */
function buildRunnerEnv(source = {}, overrides = {}) {
  const result = {};
  for (const key of RUNNER_ENV_ALLOWLIST) {
    if (isSensitiveEnvKey(key)) continue;
    const value = source && source[key];
    if (typeof value === 'string' && value.length > 0) result[key] = value;
  }
  for (const [key, value] of Object.entries(overrides || {})) {
    if (isSensitiveEnvKey(key) || value == null) continue;
    result[key] = String(value);
  }
  return result;
}

/** Constant-work comparison for the short bearer tokens used by the API. */
function constantTimeEqual(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  const length = Math.max(a.length, b.length, 1);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i++) {
    diff |= (a.charCodeAt(i % Math.max(a.length, 1)) || 0)
      ^ (b.charCodeAt(i % Math.max(b.length, 1)) || 0);
  }
  return diff === 0;
}

/**
 * /health is deliberately unauthenticated for container health checks. In
 * development an absent token preserves the old local workflow; production
 * rejects an absent token at boot in code-runner.js.
 */
function isControlRequestAuthorized({ pathname, authorization, token } = {}) {
  if (pathname === '/health') return true;
  const expected = String(token || '').trim();
  if (!expected) return true;
  const match = String(authorization || '').match(/^Bearer[ \t]+(.+)$/i);
  return Boolean(match && constantTimeEqual(match[1], expected));
}

function controlTokenForEnv(env = {}) {
  const token = String(env.CODE_RUNNER_CONTROL_TOKEN || '').trim();
  if (String(env.NODE_ENV || '').toLowerCase() === 'production' && !token) {
    throw new Error('CODE_RUNNER_CONTROL_TOKEN is required when NODE_ENV=production');
  }
  return token;
}

/** FNV-1a: stable across Bun/Node restarts and cheap for short project ids. */
function stableProjectHash(value) {
  let hash = 0x811c9dc5;
  for (const char of String(value || '')) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Give each project a stable, unprivileged Linux identity. The large default
 * span makes collisions vanishingly unlikely while keeping ids below 2^31.
 */
function projectIdentity(projectId, {
  uidBase = 100_000,
  uidSpan = 1_000_000,
  gidBase = uidBase,
  gidSpan = uidSpan,
} = {}) {
  const id = String(projectId || '__legacy__');
  const hash = stableProjectHash(id);
  const cleanUidBase = Math.max(1, Math.trunc(Number(uidBase) || 100_000));
  const cleanUidSpan = Math.max(1, Math.trunc(Number(uidSpan) || 1_000_000));
  const cleanGidBase = Math.max(1, Math.trunc(Number(gidBase) || cleanUidBase));
  const cleanGidSpan = Math.max(1, Math.trunc(Number(gidSpan) || cleanUidSpan));
  return {
    uid: cleanUidBase + (hash % cleanUidSpan),
    gid: cleanGidBase + (hash % cleanGidSpan),
  };
}

function positiveLimit(value, fallback) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Wrap a generated-code command in a new session, resource limits, and an
 * irreversible uid/gid + capability drop. The returned argv is passed to
 * Bun.spawn directly (never through a shell).
 */
function sandboxCommand(cmd, identity, limits = {}) {
  if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((part) => typeof part === 'string')) {
    throw new TypeError('sandbox command must be a non-empty string array');
  }
  const uid = Math.trunc(Number(identity && identity.uid));
  const gid = Math.trunc(Number(identity && identity.gid));
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid <= 0) {
    throw new TypeError('sandbox identity must use non-root integer uid/gid values');
  }
  // Node/V8 reserves substantially more virtual address space than its RSS;
  // the container memory cgroup remains the real physical-memory boundary.
  const addressSpaceBytes = positiveLimit(limits.addressSpaceBytes, 64 * 1024 * 1024 * 1024);
  const maxProcesses = positiveLimit(limits.maxProcesses, 128);
  const maxOpenFiles = positiveLimit(limits.maxOpenFiles, 256);
  const maxFileBytes = positiveLimit(limits.maxFileBytes, 512 * 1024 * 1024);
  const cpuSeconds = positiveLimit(limits.cpuSeconds, 7200);

  return [
    'setsid',
    'prlimit',
    `--as=${addressSpaceBytes}:${addressSpaceBytes}`,
    `--nproc=${maxProcesses}:${maxProcesses}`,
    `--nofile=${maxOpenFiles}:${maxOpenFiles}`,
    `--fsize=${maxFileBytes}:${maxFileBytes}`,
    `--cpu=${cpuSeconds}:${cpuSeconds}`,
    '--core=0:0',
    'setpriv',
    `--reuid=${uid}`,
    `--regid=${gid}`,
    '--clear-groups',
    '--no-new-privs',
    '--',
    ...cmd,
  ];
}

// Dirs never mirrored to the user's disk on export: generated/heavy trees the
// user re-creates locally with `npm install`/`npm run build`. Keeping them out
// makes the export a clean, small source copy and dodges the slow/fragile
// node_modules-over-a-Windows-bind-mount path entirely.
const IGNORED_EXPORT_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.cache', '.turbo',
  'coverage', '.vite', '.output', '.parcel-cache', '.svelte-kit',
]);

/** True when a project-relative path lives under an ignored dir (any segment). */
function shouldIgnoreExportPath(relPath) {
  const p = String(relPath || '').replaceAll('\\', '/').trim();
  if (!p) return true;
  const segments = p.split('/');
  for (const seg of segments) {
    if (seg && IGNORED_EXPORT_DIRS.has(seg)) return true;
  }
  // Excluir archivos de entorno con secretos (.env, .env.local…) del export.
  const leaf = segments[segments.length - 1];
  if (leaf === '.env' || /^\.env\.[A-Za-z0-9_-]+$/.test(leaf)) return true;
  return false;
}

// ── Multi-project dev-server pool (audit B1) ────────────────────────────────
// Pure port-pool + registry logic so the Bun sidecar stays a thin shell and
// this part is testable with node --test.

const DEFAULT_DEV_POOL_SIZE = 10;

/**
 * Parse a dev-port pool spec into a sorted array of unique ports.
 * Accepted specs: "5173-5182" (range) or "5173,5175,5180" (list).
 * Invalid/empty spec → default pool [basePort .. basePort + size - 1].
 */
function parseDevPortPool(spec, basePort = 5173, size = DEFAULT_DEV_POOL_SIZE) {
  const fallback = Array.from({ length: size }, (_, i) => basePort + i);
  const raw = String(spec || '').trim();
  if (!raw) return fallback;
  const valid = (p) => Number.isInteger(p) && p > 0 && p < 65536;
  const range = raw.match(/^(\d+)\s*-\s*(\d+)$/);
  if (range) {
    let a = Number(range[1]);
    let b = Number(range[2]);
    if (!valid(a) || !valid(b)) return fallback;
    if (a > b) [a, b] = [b, a];
    if (b - a + 1 > 100) b = a + 99; // sanity cap
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }
  const list = [...new Set(raw.split(',').map((s) => Number(s.trim())).filter(valid))].sort((x, y) => x - y);
  return list.length ? list : fallback;
}

// States a server can be evicted in: it finished its lifecycle (serving or
// crashed). Servers still installing/starting are never evicted — killing a
// half-born server would surface as a phantom failure to its owner.
const EVICTABLE_STATES = new Set(['ready', 'error']);

/**
 * createDevPool — registry of per-project dev-server slots over a fixed port
 * pool. Pure bookkeeping: the caller owns processes; entries carry whatever
 * extra fields the caller attaches (proc, framework, ...).
 *
 * Eviction policy (documented choice): when the pool is exhausted, `allocate`
 * evicts the OLDEST entry (by startedAt) whose state is 'ready' or 'error'
 * and hands its port to the new project. If nothing is evictable (every slot
 * is installing/starting), allocate returns null and the caller should answer
 * 429. Rationale: previews are ephemeral; the oldest finished server is the
 * least likely to still have a viewer, and blocking new users behind a full
 * pool is worse than recycling a stale preview.
 */
function createDevPool({ ports, now = () => Date.now() } = {}) {
  const pool = Array.isArray(ports) && ports.length ? [...ports] : parseDevPortPool(null);
  const entries = new Map(); // key -> entry

  const usedPorts = () => new Set([...entries.values()].map((e) => e.port));

  function freePort() {
    const used = usedPorts();
    for (const p of pool) if (!used.has(p)) return p;
    return null;
  }

  function entryForPort(port) {
    for (const e of entries.values()) if (e.port === port) return e;
    return null;
  }

  function evictionCandidate() {
    let oldest = null;
    for (const e of entries.values()) {
      if (!EVICTABLE_STATES.has(e.state)) continue;
      if (!oldest || e.startedAt < oldest.startedAt) oldest = e;
    }
    return oldest;
  }

  function makeEntry(key, port) {
    const entry = {
      key,
      port,
      state: 'starting',
      startedAt: now(),
      lastUsedAt: now(),
    };
    entries.set(key, entry);
    return entry;
  }

  return {
    get: (key) => entries.get(key) || null,
    list: () => [...entries.values()],
    size: () => entries.size,
    poolPorts: () => [...pool],

    /**
     * Allocate a slot for `key`. Returns { entry, evicted } or null when the
     * pool is exhausted and nothing is evictable.
     * - Existing key → same entry (same port) is returned; caller resets it.
     * - opts.pinnedPort → that exact port is required (legacy root run pins
     *   DEV_PORT); its current holder, if any, is evicted regardless of pool.
     */
    allocate(key, opts = {}) {
      const existing = entries.get(key);
      if (existing) {
        existing.lastUsedAt = now();
        return { entry: existing, evicted: null };
      }
      if (opts.pinnedPort != null) {
        const holder = entryForPort(opts.pinnedPort);
        if (holder) entries.delete(holder.key);
        return { entry: makeEntry(key, opts.pinnedPort), evicted: holder };
      }
      let port = freePort();
      let evicted = null;
      if (port == null) {
        evicted = evictionCandidate();
        if (!evicted) return null; // exhausted, nothing evictable → 429
        entries.delete(evicted.key);
        port = evicted.port;
      }
      return { entry: makeEntry(key, port), evicted };
    },

    /** Remove the entry (frees its port). Returns the removed entry or null. */
    release(key) {
      const entry = entries.get(key) || null;
      if (entry) entries.delete(key);
      return entry;
    },

    touch(key) {
      const entry = entries.get(key);
      if (entry) entry.lastUsedAt = now();
      return entry || null;
    },

    /** Entries idle (no control-API activity) for more than maxIdleMs. */
    idleEntries(maxIdleMs) {
      const cutoff = now() - maxIdleMs;
      return [...entries.values()].filter((e) => EVICTABLE_STATES.has(e.state) && e.lastUsedAt < cutoff);
    },
  };
}


// ── Next.js preview under a tokenized basePath ─────────────────────────────
// Vite takes `--base`; Next only reads basePath from next.config.* and its dev
// bundler re-reads that file (a `conf` object passed to `next()` is ignored
// for routing). So the runner writes a `next.config.js` wrapper that imports
// the project's own config and adds basePath/assetPrefix/allowedDevOrigins.
// `next.config.js` wins Next's precedence (js > mjs > ts), so a user config
// with that exact name is moved aside to NEXT_PREVIEW_USER_BACKUP first.
const NEXT_PREVIEW_MARKER = "SIRAGPT_NEXT_PREVIEW_WRAPPER";
const NEXT_PREVIEW_WRAPPER = "next.config.js";
const NEXT_PREVIEW_USER_BACKUP = "next.config.siragpt-user.js";
const NEXT_CONFIG_CANDIDATES = ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.mts", "next.config.cjs"];

function normalizeNextBasePath(basePath) {
  const raw = String(basePath || "").trim();
  if (!raw || raw === "/") return "";
  if (!raw.startsWith("/") || raw.includes("..") || /[\s'"`\\]/.test(raw)) return "";
  return raw.replace(/\/+$/, "");
}

/**
 * Decide which files to move/write. `existing` = config filenames present in
 * the project dir, `wrapperIsOurs` = the current next.config.js carries the
 * marker. Returns { userConfig, rename } where `rename` is
 * [from, to] | null.
 */
function planNextPreviewConfig({ existing = [], wrapperIsOurs = false, backupExists = false } = {}) {
  const present = NEXT_CONFIG_CANDIDATES.filter((f) => existing.includes(f));
  let userConfig = null;
  let rename = null;
  if (present[0] === NEXT_PREVIEW_WRAPPER) {
    if (wrapperIsOurs) {
      userConfig = backupExists ? NEXT_PREVIEW_USER_BACKUP : (present[1] || null);
    } else {
      rename = [NEXT_PREVIEW_WRAPPER, NEXT_PREVIEW_USER_BACKUP];
      userConfig = NEXT_PREVIEW_USER_BACKUP;
    }
  } else {
    userConfig = backupExists ? NEXT_PREVIEW_USER_BACKUP : (present[0] || null);
  }
  return { userConfig, rename };
}

function parseAllowedOriginsEnv(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter((s) => /^[A-Za-z0-9.-]+$/.test(s));
}

function buildNextPreviewWrapper({ basePath, userConfig = null, allowedOrigins = [] } = {}) {
  const base = normalizeNextBasePath(basePath);
  if (!base) throw new Error("next preview wrapper needs a basePath");
  const origins = Array.from(new Set(["runner", "127.0.0.1", "localhost", ...parseAllowedOriginsEnv(allowedOrigins.join(","))]));
  const safeUser = userConfig && NEXT_CONFIG_CANDIDATES.concat(NEXT_PREVIEW_USER_BACKUP).includes(userConfig) ? userConfig : null;
  return [
    `// ${NEXT_PREVIEW_MARKER} — generado por el runner de SiraGPT para servir el preview`,
    "// bajo un basePath tokenizado. No forma parte de tu proyecto; se ignora en git.",
    "'use strict';",
    "const path = require('path');",
    `const BASE = ${JSON.stringify(base)};`,
    `const USER_CONFIG = ${JSON.stringify(safeUser)};`,
    `const ORIGINS = ${JSON.stringify(origins)};`,
    "module.exports = async (phase, ctx) => {",
    "  let user = {};",
    "  if (USER_CONFIG) {",
    "    const p = path.join(__dirname, USER_CONFIG);",
    "    if (/\\.(ts|mts)$/.test(USER_CONFIG)) {",
    "      const { transpileConfig } = require('next/dist/build/next-config-ts/transpile-config');",
    "      const out = await transpileConfig({ nextConfigPath: p, dir: __dirname });",
    "      user = out && out.default ? out.default : out;",
    "    } else if (/\\.mjs$/.test(USER_CONFIG)) {",
    "      const mod = await import(p);",
    "      user = mod && mod.default ? mod.default : mod;",
    "    } else {",
    "      const mod = require(p);",
    "      user = mod && mod.default ? mod.default : mod;",
    "    }",
    "    if (typeof user === 'function') user = await user(phase, ctx);",
    "    user = user && typeof user === 'object' ? user : {};",
    "  }",
    "  const allowedDevOrigins = Array.from(new Set([...(user.allowedDevOrigins || []), ...ORIGINS]));",
    "  return { ...user, basePath: BASE, assetPrefix: BASE, allowedDevOrigins };",
    "};",
    "",
  ].join("\n");
}


// ── Install plan / dev env / pinned port (chat "dame la web en local") ──────
// The lockfile decides the installer: bun choked on npm lockfiles with nested
// "overrides" and on native life-cycle scripts (SiraGPT-APP). npm ci is tried
// with scripts first, then without them so a failing optional native build
// (canvas, sharp) does not block a plain dev server.
function pickInstallPlan({ hasPackageLock = false, hasBunLock = false, hasPnpmLock = false, hasYarnLock = false } = {}) {
  const npmFlags = ["--no-audit", "--no-fund", "--loglevel=error"];
  if (hasPackageLock && !hasBunLock) {
    return [
      { label: "npm ci", cmd: ["npm", "ci", ...npmFlags] },
      { label: "npm ci --ignore-scripts", cmd: ["npm", "ci", "--ignore-scripts", ...npmFlags] },
      { label: "npm install", cmd: ["npm", "install", "--ignore-scripts", ...npmFlags] },
    ];
  }
  if (hasPnpmLock && !hasBunLock) {
    return [
      { label: "bun install (pnpm lock)", cmd: ["bun", "install"] },
      { label: "npm install", cmd: ["npm", "install", "--ignore-scripts", ...npmFlags] },
    ];
  }
  if (hasYarnLock && !hasBunLock) {
    return [
      { label: "bun install (yarn lock)", cmd: ["bun", "install"] },
      { label: "npm install", cmd: ["npm", "install", "--ignore-scripts", ...npmFlags] },
    ];
  }
  return [
    { label: "bun install", cmd: ["bun", "install"] },
    { label: "bun install --ignore-scripts", cmd: ["bun", "install", "--ignore-scripts"] },
  ];
}

const DEV_ENV_KEY_RE = /^(NEXT_PUBLIC_|VITE_|PUBLIC_|REACT_APP_|EXPO_PUBLIC_)[A-Z0-9_]{1,60}$/;
const DEV_ENV_MAX_KEYS = 20;
const DEV_ENV_MAX_VALUE = 2000;

/** Only public build-time variables may reach the dev server from the chat. */
function sanitizeDevEnv(input) {
  const out = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [key, value] of Object.entries(input)) {
    if (Object.keys(out).length >= DEV_ENV_MAX_KEYS) break;
    if (!DEV_ENV_KEY_RE.test(key) || isSensitiveEnvKey(key)) continue;
    if (value == null) continue;
    const str = String(value);
    if (str.length > DEV_ENV_MAX_VALUE || /[\r\n\0]/.test(str)) continue;
    out[key] = str;
  }
  return out;
}

/** A port the user asked for ("dame la web en el 5000"); null when unusable. */
function sanitizePinnedPort(value, { reserved = [] } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) return null;
  if (reserved.map(Number).includes(n)) return null;
  return n;
}

module.exports = {
  pickInstallPlan,
  sanitizeDevEnv,
  sanitizePinnedPort,
  DEV_ENV_KEY_RE,
  NEXT_PREVIEW_MARKER,
  NEXT_PREVIEW_WRAPPER,
  NEXT_PREVIEW_USER_BACKUP,
  NEXT_CONFIG_CANDIDATES,
  normalizeNextBasePath,
  planNextPreviewConfig,
  parseAllowedOriginsEnv,
  buildNextPreviewWrapper,
  sanitizeProjectId,
  sanitizeRunId,
  resolveProjectRelPath,
  migrateLegacyViteProxyConfig,
  previewConfigMigrationMode,
  isAllowedCommand,
  commandRejectionReason,
  buildPreflightEnabled,
  previewDocumentReady,
  ALLOWED_BINS,
  IGNORED_EXPORT_DIRS,
  shouldIgnoreExportPath,
  parseDevPortPool,
  createDevPool,
  EVICTABLE_STATES,
  DEFAULT_DEV_POOL_SIZE,
  RUNNER_ENV_ALLOWLIST,
  isSensitiveEnvKey,
  buildRunnerEnv,
  constantTimeEqual,
  isControlRequestAuthorized,
  controlTokenForEnv,
  stableProjectHash,
  projectIdentity,
  sandboxCommand,
};

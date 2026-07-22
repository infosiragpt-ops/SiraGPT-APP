'use strict';

/**
 * code-runner-utils — pure helpers shared by the runner sidecar and its
 * backend tests. No Bun/Node APIs here: keep it requireable from both.
 */

const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

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
const ALLOWED_BINS = new Set(['git', 'bun', 'bunx', 'node', 'ls', 'cat', 'wc']);
const INTERACTIVE_SCAFFOLD_RE = /^(?:create-next-app|create-vite|create-react-app|create-remix)(?:@.*)?$/i;

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

function isAllowedCommand(cmd) {
  return commandRejectionReason(cmd) === null;
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
  const addressSpaceBytes = positiveLimit(limits.addressSpaceBytes, 4 * 1024 * 1024 * 1024);
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
  for (const seg of p.split('/')) {
    if (seg && IGNORED_EXPORT_DIRS.has(seg)) return true;
  }
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

module.exports = {
  sanitizeProjectId,
  resolveProjectRelPath,
  isAllowedCommand,
  commandRejectionReason,
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

'use strict';

// ──────────────────────────────────────────────────────────────
// siraGPT — Slow query observer (Admin → Logs)
// ──────────────────────────────────────────────────────────────
// pool-instrumentation already times every Prisma operation of the shared
// client; this observer receives that timing (`onQuery({ model, action, ms,
// error })`) and prints ONE WARN line for operations slower than
// SIRAGPT_SLOW_QUERY_MS (default 500 ms):
//
//   [slow-query] Chat.findMany 2310ms threshold=500ms site=src/routes/chats.js:212 suppressed=4 maxMs=3120
//
// - Never prints args, SQL, parameters or error messages (Prisma messages
//   embed the invocation's values): only model, action, duration, the Prisma
//   error code and the calling file:line.
// - One line per model.action every SIRAGPT_SLOW_QUERY_LOG_COOLDOWN_MS
//   (60 s); repeats in the window are counted and reported with their max.
// - live-logs attaches reqId / user / route from AsyncLocalStorage (the
//   callback runs in the caller's async context), so no context is threaded.
// - The duration includes waiting for a pool connection: a burst of lines
//   across many fingerprints usually means pool saturation, not slow SQL.
// - Fast queries cost one comparison. SIRAGPT_SLOW_QUERY_MS=0 disables it.
// ──────────────────────────────────────────────────────────────

const DEFAULT_SLOW_QUERY_MS = 500;
const DEFAULT_RAW_MAINTENANCE_SLOW_QUERY_MS = 5_000;
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_FINGERPRINTS = 1_000;
const MODEL_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ACTION_RE = /^\$?[A-Za-z][A-Za-z0-9_]{0,39}$/;
const PRISMA_CODE_RE = /^P\d{4}$/;

function readInt(value, fallback, min, max) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return fallback;
  const n = Number(text);
  if (!Number.isSafeInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function fingerprintOf(model, action) {
  const m = typeof model === 'string' && MODEL_RE.test(model) ? model : 'raw';
  const a = typeof action === 'string' && ACTION_RE.test(action) ? action : 'unknown';
  return `${m}.${a}`;
}

/**
 * First application frame of a stack, as `src/…:line` or `dist/…:line`. The
 * path is anchored on the LAST `/backend/src/` or `/backend/dist/` (any
 * checkout, even one under a `src/` folder) or on the production image's
 * `/app/src/` or `/app/dist/`; frames in node_modules, the DB layer, the
 * shared client and transaction span wrappers are skipped.
 */
function callerSite(stack) {
  for (const line of String(stack || '').split('\n').slice(1)) {
    const m = /\(?([^\s()]+?):(\d+):\d+\)?\s*$/.exec(line);
    if (!m) continue;
    const file = m[1].replace(/\\/g, '/');
    if (file.includes('/node_modules/')) continue;
    const srcAnchor = file.lastIndexOf('/backend/src/');
    const distAnchor = file.lastIndexOf('/backend/dist/');
    let rel = null;
    if (srcAnchor >= 0) rel = file.slice(srcAnchor + '/backend/'.length);
    else if (distAnchor >= 0) rel = file.slice(distAnchor + '/backend/'.length);
    else if (file.startsWith('/app/src/') || file.startsWith('/app/dist/')) rel = file.slice('/app/'.length);
    if (!rel) continue;
    if (
      rel.startsWith('src/db/')
      || rel === 'src/config/database.js'
      || rel === 'src/utils/otel-spans.js'
      || rel === 'src/services/db/database-guard.js'
    ) continue;
    return `${rel}:${m[2]}`.slice(0, 120);
  }
  return null;
}

function isBackgroundMaintenanceRawPoll(key, site) {
  if (key !== 'raw.$queryRaw' && key !== 'raw.$executeRaw') return false;
  if (!site) return true;
  return (
    site.startsWith('dist/doc-sandbox/')
    || site.startsWith('src/modules/doc-sandbox/')
    || site.startsWith('src/health/')
    || site.startsWith('src/services/observability/health-check.js')
    || site.startsWith('src/services/stripe-webhook-recovery.js')
  );
}

function createSlowQueryObserver({
  env = process.env,
  sink = console,
  now = Date.now,
  captureSite = true,
} = {}) {
  const thresholdMs = readInt(env.SIRAGPT_SLOW_QUERY_MS, DEFAULT_SLOW_QUERY_MS, 0, 600_000);
  const hasExplicitThreshold = env.SIRAGPT_SLOW_QUERY_MS !== undefined && env.SIRAGPT_SLOW_QUERY_MS !== null && String(env.SIRAGPT_SLOW_QUERY_MS).trim() !== '';
  const cooldownMs = readInt(env.SIRAGPT_SLOW_QUERY_LOG_COOLDOWN_MS, DEFAULT_COOLDOWN_MS, 1_000, 3_600_000);
  const buckets = new Map();
  const stats = { slow: 0, logged: 0, suppressed: 0 };

  function observe(event) {
    if (thresholdMs <= 0 || !event) return;
    const ms = Number(event.ms);
    if (!(ms >= thresholdMs)) return;
    const key = fingerprintOf(event.model, event.action);
    const site = captureSite ? callerSite(event.stack || new Error().stack) : null;
    const effectiveThresholdMs = (
      !hasExplicitThreshold
      && !event.error
      && isBackgroundMaintenanceRawPoll(key, site)
    )
      ? Math.max(thresholdMs, DEFAULT_RAW_MAINTENANCE_SLOW_QUERY_MS)
      : thresholdMs;
    if (!(ms >= effectiveThresholdMs)) return;
    stats.slow += 1;
    const t = now();
    const bucket = buckets.get(key);
    if (bucket && t - bucket.at < cooldownMs) {
      bucket.suppressed += 1;
      if (ms > bucket.maxMs) bucket.maxMs = ms;
      stats.suppressed += 1;
      return;
    }
    const suppressed = bucket ? bucket.suppressed : 0;
    const maxMs = bucket ? bucket.maxMs : 0;
    buckets.delete(key); // re-insert: Map order doubles as LRU
    buckets.set(key, { at: t, suppressed: 0, maxMs: 0 });
    if (buckets.size > MAX_FINGERPRINTS) buckets.delete(buckets.keys().next().value);
    stats.logged += 1;
    try {
      const err = event.error;
      const code = err && PRISMA_CODE_RE.test(String(err.code || '')) ? err.code : null;
      // «Errores del sistema» turns a warn line carrying a P1xxx/P2xxx code and
      // «fail» into a stored issue. A P2034 write conflict is retried by its
      // caller and deliberately demoted in config/database.js, so it is named
      // without its code to keep it out of that inbox.
      const failure = code === 'P2034' ? ' failed write_conflict' : ` failed${code ? ` code=${code}` : ''}`;
      sink.warn(
        `[slow-query] ${key} ${Math.round(ms)}ms threshold=${effectiveThresholdMs}ms`
        + (site ? ` site=${site}` : '')
        + (err ? failure : '')
        + (suppressed ? ` suppressed=${suppressed} maxMs=${Math.round(maxMs)}` : ''),
      );
    } catch (_) { /* logging must never break a query */ }
  }

  function getStats() {
    return { ...stats, thresholdMs, cooldownMs, fingerprints: buckets.size };
  }

  return { observe, stats: getStats, thresholdMs, cooldownMs };
}

module.exports = {
  createSlowQueryObserver,
  fingerprintOf,
  callerSite,
  DEFAULT_SLOW_QUERY_MS,
  DEFAULT_COOLDOWN_MS,
};

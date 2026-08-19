// Maintenance-mode middleware (task 1, ratchet 45)
//
// When the `maintenance_mode` row in the `SystemSettings` table has
// `enabled: true`, every incoming request returns HTTP 503 with the
// shape `{ error: 'maintenance', message, since }` — EXCEPT requests
// under `/health/*` (so liveness/readiness probes keep working) and
// `/api/admin/*` (so super-admins can still toggle the flag back off
// even while maintenance is engaged).
//
// State is cached in-process for `CACHE_TTL_MS` so we don't hammer
// Postgres on every request. The cache is busted explicitly via
// `invalidateMaintenanceCache()` (called from the admin route after a
// write) so updates propagate immediately on the writing replica;
// other replicas pick up the new state within the TTL window.

const KEY = 'maintenance_mode';
const CACHE_TTL_MS = 5_000;

let _cache = null; // { value: { enabled, message, since } | null, fetchedAt: number }
let _prismaRef = null;

function setPrisma(prisma) {
  _prismaRef = prisma;
}

function invalidateMaintenanceCache() {
  _cache = null;
}

async function readMaintenanceState(prisma) {
  if (!prisma || !prisma.systemSettings || typeof prisma.systemSettings.findUnique !== 'function') {
    return null;
  }
  try {
    const row = await prisma.systemSettings.findUnique({ where: { key: KEY } });
    if (!row || !row.value) return null;
    try {
      const parsed = JSON.parse(row.value);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_err) {
      return null;
    }
    return null;
  } catch (err) {
    // Failing open — never let a DB hiccup take the whole API down.
    console.warn('[maintenance-mode] state read failed:', err?.message || err);
    return null;
  }
}

async function writeMaintenanceState(prisma, { enabled, message }) {
  if (!prisma || !prisma.systemSettings) {
    throw new Error('SystemSettings model unavailable');
  }
  const next = {
    enabled: Boolean(enabled),
    message: typeof message === 'string' && message ? message : null,
    since: new Date().toISOString(),
  };
  const value = JSON.stringify(next);
  await prisma.systemSettings.upsert({
    where: { key: KEY },
    create: { key: KEY, value },
    update: { value },
  });
  invalidateMaintenanceCache();
  return next;
}

async function getMaintenanceState(prisma) {
  const now = Date.now();
  if (_cache && now - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.value;
  }
  const value = await readMaintenanceState(prisma);
  _cache = { value, fetchedAt: now };
  return value;
}

function isBypassedPath(urlPath) {
  if (typeof urlPath !== 'string') return false;
  if (urlPath === '/health' || urlPath.startsWith('/health/')) return true;
  if (urlPath.startsWith('/api/admin/')) return true;
  if (urlPath === '/api/admin') return true;
  return false;
}

function maintenanceMiddleware(opts = {}) {
  const prisma = opts.prisma || _prismaRef;
  return async function maintenanceModeMiddleware(req, res, next) {
    try {
      // Cheap bypass for the paths we never want to gate.
      const reqPath = req.path || req.url || '';
      if (isBypassedPath(reqPath)) return next();

      const state = await getMaintenanceState(prisma);
      if (!state || !state.enabled) return next();

      // Best-effort metric: count blocked requests per route. Never let
      // instrumentation throw inside the middleware.
      try {
        // eslint-disable-next-line global-require
        const metrics = require('../utils/metrics');
        // Bucket to the first path segments so the metric label has bounded
        // cardinality — req.path here is the raw, pre-route concrete URL
        // (e.g. /api/chats/<uuid>), which would otherwise mint a new
        // time-series per request during an outage under retry storms.
        const routeLabel = reqPath.split('/').slice(0, 3).join('/') || 'unknown';
        metrics.counter('siragpt_maintenance_blocked_total', { route: routeLabel }, 1);
      } catch {
        /* never throw from instrumentation */
      }

      res.set('Retry-After', '60');
      return res.status(503).json({
        error: 'maintenance',
        message: state.message || 'The service is temporarily under maintenance.',
        since: state.since || null,
      });
    } catch (err) {
      // Never block a request on middleware failure.
      console.warn('[maintenance-mode] middleware error:', err?.message || err);
      return next();
    }
  };
}

module.exports = {
  KEY,
  setPrisma,
  maintenanceMiddleware,
  getMaintenanceState,
  writeMaintenanceState,
  invalidateMaintenanceCache,
  // Exposed for tests
  _internal: { isBypassedPath, readMaintenanceState },
};

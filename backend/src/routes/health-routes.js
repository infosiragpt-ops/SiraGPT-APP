'use strict';

/**
 * health-routes — registers the three operational health endpoints and owns
 * the small amount of request-time state they need (result cache, lazy Redis
 * probe client, and the boot-time OAuth/startup-env snapshots).
 *
 * Why this is its own module
 * --------------------------
 * The composite `/health` report must thread the boot-time Google OAuth
 * configuration result through to `runFullHealthCheck` so a stale
 * misconfiguration is visible at runtime (and drives the report to
 * `degraded`). That wiring used to live inline in `backend/index.js`, where it
 * could only be exercised by booting the entire server — too heavyweight to
 * cover with a focused test. A refactor could quietly stop passing the OAuth
 * result through and nothing would catch it.
 *
 * Extracting the registration into a dependency-injected factory lets a test
 * mount the *real* route handlers on a bare Express app with fake
 * prisma/redis, set a degraded OAuth boot result, and assert the live
 * `/health` JSON surfaces it — without standing up the whole process.
 *
 * `backend/index.js` mounts exactly this factory, so the route under test is
 * the route that runs in production.
 */

const {
  runLivenessCheck,
  runReadinessCheck,
  runFullHealthCheck,
  reportToHttpStatus,
} = require('../services/observability/health-check');

const noopStatus = () => ({});

/**
 * Build the health routes with their dependencies injected.
 *
 * @param {object} deps
 * @param {object} [deps.prisma]            Prisma client for the DB probe.
 * @param {object} [deps.coworkHealth]      Cowork subsystem health module.
 * @param {Function} [deps.getOpenTelemetryStatus]
 * @param {Function} [deps.getSentryStatus]
 * @param {Function} [deps.getLangfuseStatus]
 * @param {Function} [deps.getPostHogStatus]
 * @param {{checked: boolean, issues: Array}} [deps.startupEnv]
 *        Boot-time startup-environment validation snapshot.
 * @param {number} [deps.cacheTtlMs]        Health-result cache TTL (ms).
 *        Pass 0 to disable caching (used by tests so consecutive requests
 *        observe freshly-set boot snapshots).
 * @param {object} [deps.env]               Environment object (default process.env).
 */
function createHealthRoutes(deps = {}) {
  const {
    prisma = null,
    coworkHealth = null,
    getOpenTelemetryStatus = noopStatus,
    getSentryStatus = noopStatus,
    getLangfuseStatus = noopStatus,
    getPostHogStatus = noopStatus,
    startupEnv = { checked: false, issues: [] },
    env = process.env,
  } = deps;

  const cacheTtlMs = typeof deps.cacheTtlMs === 'number'
    ? deps.cacheTtlMs
    : parseInt(env.HEALTH_CACHE_TTL_MS || '5000', 10); // 5s default

  // ── OAuth boot-config snapshot ─────────────────────────────
  // Populated once at startup by validateOAuthCallbackUrl (see startServer in
  // index.js, which calls setOAuthBootResult). Surfaced in the full /health
  // report so monitoring probes and the ops dashboard can re-detect OAuth
  // misconfigurations without reading startup logs or restarting the process.
  // Defaults to "not yet checked" so a probe that hits /health before
  // startServer runs gets a sane shape.
  let oauthBootResult = { checked: false, mismatch: false, issues: [] };

  function setOAuthBootResult(result) {
    oauthBootResult = {
      checked: Boolean(result && result.checked),
      mismatch: Boolean(result && result.mismatch),
      issues: Array.isArray(result && result.issues) ? result.issues : [],
    };
    return oauthBootResult;
  }

  function getOAuthBootResult() {
    return oauthBootResult;
  }

  // ── Health-check result cache ──────────────────────────────
  // Prevents /health and /health/ready from hammering the DB on every request
  // when monitoring systems poll aggressively. Cache is TTL-based: stale
  // entries trigger a fresh probe. Liveness (/health/live) is NEVER cached —
  // it must always reflect the current process state.
  const healthCache = new Map();

  async function getCachedOrFresh(cacheKey, fetcher) {
    if (cacheTtlMs > 0) {
      const cached = healthCache.get(cacheKey);
      if (cached && (Date.now() - cached.at) < cacheTtlMs) {
        return cached.report;
      }
    }
    const report = await fetcher();
    if (cacheTtlMs > 0) {
      healthCache.set(cacheKey, { at: Date.now(), report });
      // Prevent unbounded growth (should never exceed 2-3 entries in practice)
      if (healthCache.size > 10) {
        const now = Date.now();
        for (const [key, entry] of healthCache) {
          if ((now - entry.at) > cacheTtlMs * 2) healthCache.delete(key);
        }
      }
    }
    return report;
  }

  // A dedicated, lazy IORedis client is used only for the health probe so a
  // flaky Redis can't poison the live BullMQ queue connection.
  let _healthRedisClient = null;
  function getHealthRedisClient() {
    if (!env.REDIS_URL) return null;
    if (_healthRedisClient) return _healthRedisClient;
    try {
      const IORedis = require('ioredis');
      _healthRedisClient = new IORedis(env.REDIS_URL, {
        lazyConnect: true,
        // Health check ping should not retry — a stuck Redis IS the signal we
        // want to surface. One attempt, fail fast.
        maxRetriesPerRequest: 1,
        enableReadyCheck: false,
        connectTimeout: 2000,
      });
      // Swallow background errors. The health probe will still observe the
      // connection state on the next ping().
      _healthRedisClient.on('error', () => {});
      return _healthRedisClient;
    } catch (_e) {
      return null;
    }
  }

  function sendHealthReport(res, report) {
    res.status(reportToHttpStatus(report)).json(report);
  }

  /**
   * Register the three health endpoints on an Express app/router.
   *
   *   /health        → composite (all checks + ops info). 503 when any
   *                    critical check is unhealthy.
   *   /health/live   → liveness (process up). Always 200 unless the process is
   *                    past the point of being able to serve.
   *   /health/ready  → readiness (DB + Redis + queue + process). Used by the
   *                    load balancer / k8s readiness probe.
   */
  function register(app) {
    app.get(['/health/live', '/api/health/live'], (_req, res) => {
      const report = runLivenessCheck();
      sendHealthReport(res, report);
    });

    app.get(['/health/ready', '/api/health/ready'], async (_req, res) => {
      const report = await getCachedOrFresh('ready', () => runReadinessCheck({
        prisma,
        redis: getHealthRedisClient(),
        queue: null,
      }));
      sendHealthReport(res, report);
    });

    app.get(['/health', '/api/health'], async (_req, res) => {
      const report = await getCachedOrFresh('full', () => runFullHealthCheck({
        prisma,
        redis: getHealthRedisClient(),
        queue: null,
        telemetry: getOpenTelemetryStatus(),
        sentry: getSentryStatus(),
        langfuse: getLangfuseStatus(),
        posthog: getPostHogStatus(),
        coworkHealth,
        googleOAuth: oauthBootResult,
        startupEnv,
      }));
      sendHealthReport(res, report);
    });

    return app;
  }

  return {
    register,
    setOAuthBootResult,
    getOAuthBootResult,
    getHealthRedisClient,
    sendHealthReport,
    getCachedOrFresh,
  };
}

module.exports = { createHealthRoutes };

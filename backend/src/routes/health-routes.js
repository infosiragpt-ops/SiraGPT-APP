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
  resolveHealthRedisTimeoutMs,
} = require('../services/observability/health-check');
const { probeQueueRegistry } = require('../services/queues/queue-registry');

const noopStatus = () => ({});

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function healthRedisConnectionOptions(env = process.env) {
  const timeoutMs = resolveHealthRedisTimeoutMs(env);
  return {
    lazyConnect: true,
    // Health check ping should not retry — a stuck Redis IS the signal we
    // want to surface. One attempt, fail fast.
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    connectTimeout: timeoutMs,
    commandTimeout: timeoutMs,
  };
}

/**
 * Build the health routes with their dependencies injected.
 *
 * @param {object} deps
 * @param {object} [deps.prisma]            Prisma client for the DB probe.
 * @param {object|null} [deps.redis]         Optional injected Redis probe client.
 * @param {object} [deps.queueRegistry]      Lazy shared queue registry.
 * @param {object} [deps.queueHealthProbe]   Dedicated queue health runtime.
 * @param {Function} [deps.queueProbe]       Optional queue probe override.
 * @param {object} [deps.coworkHealth]      Cowork subsystem health module.
 * @param {object} [deps.authSecurity]      OAuth-state + impersonation runtime.
 * @param {Function} [deps.getOpenTelemetryStatus]
 * @param {Function} [deps.getSentryStatus]
 * @param {Function} [deps.getLangfuseStatus]
 * @param {Function} [deps.getPostHogStatus]
 * @param {object} [deps.poolMetrics]       Shared Prisma pool instrumentation.
 * @param {Function} [deps.getPoolAutoscalerState]
 * @param {Function} [deps.getRbacBootstrapStatus]
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
    redis: injectedRedis = null,
    queueRegistry = null,
    queueHealthProbe = null,
    coworkHealth = null,
    authSecurity = null,
    getOpenTelemetryStatus = noopStatus,
    getSentryStatus = noopStatus,
    getLangfuseStatus = noopStatus,
    getPostHogStatus = noopStatus,
    poolMetrics = null,
    getPoolAutoscalerState = null,
    getRbacBootstrapStatus = null,
    startupEnv = { checked: false, issues: [] },
    env = process.env,
  } = deps;
  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now;
  const hasInjectedRedis = Object.prototype.hasOwnProperty.call(deps, 'redis');
  const queueProbe = typeof deps.queueProbe === 'function'
    ? deps.queueProbe
    : typeof queueHealthProbe?.probe === 'function'
      ? () => queueHealthProbe.probe()
      : queueRegistry
        ? () => probeQueueRegistry({ registry: queueRegistry, env })
        : null;

  const cacheTtlMs = typeof deps.cacheTtlMs === 'number'
    ? deps.cacheTtlMs
    : parseInt(env.HEALTH_CACHE_TTL_MS || '5000', 10); // 5s default

  const authReadyRetryBaseMs = boundedInteger(
    env.AUTH_SECURITY_READY_RETRY_BASE_MS,
    250,
    10,
    60_000,
  );
  const authReadyRetryMaxMs = Math.max(
    authReadyRetryBaseMs,
    boundedInteger(
      env.AUTH_SECURITY_READY_RETRY_MAX_MS,
      5_000,
      10,
      60_000,
    ),
  );
  let authReadyAttempt = 0;
  let authReadyDelayMs = 0;
  let authReadyNextAt = 0;
  let authReadyLastErrorCode = null;
  let authReadyRefresh = null;

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
  const healthRefreshes = new Map();

  async function getCachedOrFresh(cacheKey, fetcher) {
    if (cacheTtlMs > 0) {
      const cached = healthCache.get(cacheKey);
      if (cached && (Date.now() - cached.at) < cacheTtlMs) {
        return cached.report;
      }
    }
    const existingRefresh = healthRefreshes.get(cacheKey);
    if (existingRefresh) return existingRefresh;

    let fetchPromise;
    try {
      fetchPromise = Promise.resolve(fetcher());
    } catch (error) {
      fetchPromise = Promise.reject(error);
    }
    const refresh = fetchPromise
      .then((report) => {
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
      })
      .finally(() => {
        if (healthRefreshes.get(cacheKey) === refresh) {
          healthRefreshes.delete(cacheKey);
        }
      });
    healthRefreshes.set(cacheKey, refresh);
    return refresh;
  }

  // A dedicated, lazy IORedis client is used only for the health probe so a
  // flaky Redis can't poison the live BullMQ queue connection.
  let _healthRedisClient = null;
  function getHealthRedisClient() {
    if (hasInjectedRedis) return injectedRedis;
    if (!env.REDIS_URL) return null;
    if (_healthRedisClient) return _healthRedisClient;
    try {
      const IORedis = require('ioredis');
      _healthRedisClient = new IORedis(
        env.REDIS_URL,
        healthRedisConnectionOptions(env),
      );
      // Swallow background errors. The health probe will still observe the
      // connection state on the next ping().
      _healthRedisClient.on('error', () => {});
      return _healthRedisClient;
    } catch (_e) {
      return null;
    }
  }

  let queueHealthClosePromise = null;
  function closeQueueHealthProbe() {
    if (queueHealthClosePromise) return queueHealthClosePromise;
    queueHealthClosePromise = typeof queueHealthProbe?.close === 'function'
      ? Promise.resolve().then(() => queueHealthProbe.close())
      : Promise.resolve();
    return queueHealthClosePromise;
  }

  let healthRedisClosePromise = null;
  function closeHealthRedisClient() {
    if (healthRedisClosePromise) return healthRedisClosePromise;
    const client = _healthRedisClient;
    _healthRedisClient = null;
    healthRedisClosePromise = (async () => {
      if (!client) return;
      try {
        if (typeof client.quit === 'function') await client.quit();
        else if (typeof client.disconnect === 'function') client.disconnect();
      } catch (_) {
        try { client.disconnect?.(); } catch (_disconnectError) { /* noop */ }
      }
    })();
    return healthRedisClosePromise;
  }

  let closePromise = null;
  function close() {
    if (!closePromise) {
      healthCache.clear();
      closePromise = Promise.allSettled([
        closeQueueHealthProbe(),
        closeHealthRedisClient(),
      ]).then(() => undefined);
    }
    return closePromise;
  }

  function sendHealthReport(res, report) {
    res.status(reportToHttpStatus(report)).json(report);
  }

  function readRbacBootstrapStatus() {
    if (typeof getRbacBootstrapStatus !== 'function') return undefined;
    try {
      return getRbacBootstrapStatus();
    } catch {
      return {
        state: 'failed',
        ready: false,
        mode: env.NODE_ENV === 'production' ? 'enforce' : 'shadow',
        errorCode: 'RBAC_STATUS_UNAVAILABLE',
      };
    }
  }

  function readAuthSecurityStatus() {
    if (!authSecurity || typeof authSecurity.health !== 'function') {
      return { status: 'skipped', reason: 'no_auth_security_runtime' };
    }
    try {
      const status = authSecurity.health();
      let config;
      if (typeof authSecurity.config === 'function') {
        try {
          config = authSecurity.config();
        } catch (_error) {
          config = { status: 'unavailable' };
        }
      }
      return {
        ...status,
        ...(config ? { config } : {}),
        readinessRetry: {
          attempt: authReadyAttempt,
          delayMs: authReadyDelayMs,
          nextAt: authReadyNextAt || null,
          lastErrorCode: authReadyLastErrorCode,
        },
      };
    } catch (_error) {
      return { status: 'unavailable', ok: false };
    }
  }

  function rejectedReadiness(results) {
    if (!Array.isArray(results)) return [];
    return results
      .filter((result) => result?.status === 'rejected')
      .map((result) => result.reason);
  }

  async function refreshAuthSecurityReadiness() {
    if (!authSecurity || typeof authSecurity.ready !== 'function') return;
    const now = clock();
    if (authReadyRefresh) return authReadyRefresh;
    if (authReadyNextAt > now) return;

    authReadyRefresh = (async () => {
      try {
        const results = await authSecurity.ready();
        const failures = rejectedReadiness(results);
        if (failures.length) {
          throw new AggregateError(failures, 'auth-security readiness failed');
        }
        const status = typeof authSecurity.health === 'function'
          ? authSecurity.health()
          : { ok: true };
        if (status?.ok === false) {
          const error = new Error('AUTH_SECURITY_NOT_READY');
          error.code = 'AUTH_SECURITY_NOT_READY';
          throw error;
        }
        authReadyAttempt = 0;
        authReadyDelayMs = 0;
        authReadyNextAt = 0;
        authReadyLastErrorCode = null;
      } catch (error) {
        authReadyAttempt = Math.min(31, authReadyAttempt + 1);
        authReadyDelayMs = Math.min(
          authReadyRetryMaxMs,
          authReadyRetryBaseMs * (2 ** (authReadyAttempt - 1)),
        );
        authReadyNextAt = clock() + authReadyDelayMs;
        const cause = error instanceof AggregateError ? error.errors?.[0] : error;
        authReadyLastErrorCode = cause?.code || error?.code || 'AUTH_SECURITY_READY_FAILED';
      } finally {
        authReadyRefresh = null;
      }
    })();
    return authReadyRefresh;
  }

  function attachAuthSecurityStatus(report) {
    const authSecurityStatus = readAuthSecurityStatus();
    const next = {
      ...report,
      authSecurity: authSecurityStatus,
    };
    if (authSecurityStatus.ok === false) {
      next.status = env.NODE_ENV === 'production'
        ? 'unhealthy'
        : (next.status === 'unhealthy' ? 'unhealthy' : 'degraded');
    }
    return next;
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
    // `/healthz` and `/livez` are the de-facto k8s/orchestrator liveness
    // conventions; alias them to the same liveness handler so external probes
    // work without bespoke config. `/readyz` mirrors readiness.
    app.get(['/health/live', '/api/health/live', '/healthz', '/livez', '/api/healthz', '/api/livez'], (_req, res) => {
      const report = runLivenessCheck();
      sendHealthReport(res, report);
    });

    app.get(['/health/ready', '/api/health/ready', '/api/ready', '/readyz', '/api/readyz'], async (_req, res) => {
      await refreshAuthSecurityReadiness();
      const report = await getCachedOrFresh('ready', () => runReadinessCheck({
        prisma,
        redis: getHealthRedisClient(),
        queue: queueProbe,
        rbac: readRbacBootstrapStatus(),
        env,
      }));
      sendHealthReport(res, attachAuthSecurityStatus(report));
    });

    app.get(['/health', '/api/health'], async (_req, res) => {
      const report = await getCachedOrFresh('full', () => runFullHealthCheck({
        prisma,
        redis: getHealthRedisClient(),
        queue: queueProbe,
        telemetry: getOpenTelemetryStatus(),
        sentry: getSentryStatus(),
        langfuse: getLangfuseStatus(),
        posthog: getPostHogStatus(),
        coworkHealth,
        googleOAuth: oauthBootResult,
        startupEnv,
        rbac: readRbacBootstrapStatus(),
        poolMetrics,
        getPoolAutoscalerState,
        env,
      }));
      sendHealthReport(res, attachAuthSecurityStatus(report));
    });

    return app;
  }

  return {
    register,
    setOAuthBootResult,
    getOAuthBootResult,
    getHealthRedisClient,
    close,
    closeHealthRedisClient,
    closeQueueHealthProbe,
    sendHealthReport,
    getCachedOrFresh,
  };
}

module.exports = {
  createHealthRoutes,
  healthRedisConnectionOptions,
};

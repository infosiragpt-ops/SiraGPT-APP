/**
 * health-check — deep readiness/liveness probes for the backend.
 *
 * Why this exists
 * ---------------
 * The previous `/health` returned `{status:"OK"}` whenever the Node
 * process was alive. That tells you nothing about whether the server
 * can actually serve traffic — Postgres could be down, Redis could be
 * unreachable, the queue could be saturated. Closes gap §14.3 in
 * docs/architecture/PIPELINE.md.
 *
 * Three probes, three different audiences:
 *   - `runLivenessCheck()`     — process up. K8s liveness uses this.
 *                                Always cheap, never blocks on I/O.
 *   - `runReadinessCheck(deps)` — DB + Redis + queue + process.
 *                                K8s readiness uses this. Returns
 *                                `unhealthy` if any *critical* check
 *                                fails; `degraded` if non-critical
 *                                checks fail; `healthy` otherwise.
 *   - `runFullHealthCheck(deps)` — readiness + extra informational
 *                                probes (model adapter env vars,
 *                                build info). Suited for ops dashboards.
 *
 * Each check returns a uniform shape:
 *   { name, status: "healthy"|"unhealthy"|"degraded"|"skipped",
 *     critical: boolean, latency_ms, details?: object, error?: string }
 *
 * Caller injects dependencies (`prisma`, `redis`, `queue`) so tests can
 * substitute fakes; the module never imports a Prisma client or
 * IORedis instance directly. This keeps the module pure and avoids
 * starting a second connection pool just for health checks.
 */

const PROCESS_BOOT_AT = Date.now();
const {
  MIGRATIONS_OPERATION,
  coalescePrismaHealthOperation,
  runCoalescedDatabasePing,
} = require('../../health/db-operation-coalescer');
const DEFAULT_HEALTH_DB_TIMEOUT_MS = 1500;
const MIN_HEALTH_DB_TIMEOUT_MS = 100;
const MAX_HEALTH_DB_TIMEOUT_MS = 10_000;

function resolveHealthDbTimeoutMs(env = process.env) {
  const parsed = Number.parseInt(env?.HEALTH_DB_TIMEOUT_MS, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_HEALTH_DB_TIMEOUT_MS;
  return Math.min(MAX_HEALTH_DB_TIMEOUT_MS, Math.max(MIN_HEALTH_DB_TIMEOUT_MS, parsed));
}

function runDbOperationWithTimeout(operation, { timeoutMs, label }) {
  let timer;
  const operationPromise = Promise.resolve().then(operation);
  const timeoutPromise = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} probe timed out after ${timeoutMs}ms`);
      error.code = "HEALTH_DB_TIMEOUT";
      reject(error);
    }, timeoutMs);
  });

  // Promise.race installs a rejection handler on operationPromise immediately,
  // so a Prisma call that rejects after the timeout cannot become unhandled.
  return Promise.race([operationPromise, timeoutPromise])
    .finally(() => clearTimeout(timer));
}

// ── Individual probes ──────────────────────────────────────────────

async function checkDatabase(prisma, env = process.env) {
  if (!prisma || typeof prisma.$queryRawUnsafe !== "function") {
    return { name: "database", status: "skipped", critical: false, latency_ms: 0, details: { reason: "no_prisma_client_provided" } };
  }
  const start = Date.now();
  try {
    // `SELECT 1` is the cheapest possible round-trip; covers TCP +
    // auth + a real query path. Bound the operation independently of
    // Prisma's pool timeout so readiness itself always responds.
    const timeoutMs = resolveHealthDbTimeoutMs(env);
    await runDbOperationWithTimeout(
      () => runCoalescedDatabasePing(prisma),
      { timeoutMs, label: "database" },
    );
    return { name: "database", status: "healthy", critical: true, latency_ms: Date.now() - start };
  } catch (err) {
    return {
      name: "database", status: "unhealthy", critical: true,
      latency_ms: Date.now() - start,
      error: err && err.message ? String(err.message).slice(0, 200) : "unknown",
    };
  }
}

async function checkMigrations(prisma, env = process.env) {
  if (!prisma || typeof prisma.$queryRawUnsafe !== "function") {
    return { name: "migrations", status: "skipped", critical: false, latency_ms: 0, details: { reason: "no_prisma_client_provided" } };
  }
  const start = Date.now();
  try {
    // A row that started but never finished and was never rolled back is a
    // FAILED migration (P3009) — the exact condition that took the backend down
    // in the production incident. Because `migrate deploy` runs to completion
    // before the HTTP server starts, any such row at serving time is genuinely
    // stuck, not an in-flight migration. Surfacing it as a critical readiness
    // failure lets the load balancer drain a broken instance instead of routing
    // traffic into 500s.
    const timeoutMs = resolveHealthDbTimeoutMs(env);
    const rows = await runDbOperationWithTimeout(
      () => coalescePrismaHealthOperation(
        prisma,
        MIGRATIONS_OPERATION,
        () => prisma.$queryRawUnsafe(
          'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL'
        ),
      ),
      { timeoutMs, label: "migrations" },
    );
    const failed = Array.isArray(rows) ? rows.map((r) => r && r.migration_name).filter(Boolean) : [];
    if (failed.length > 0) {
      return {
        name: "migrations", status: "unhealthy", critical: true,
        latency_ms: Date.now() - start,
        details: { failed_count: failed.length, failed: failed.slice(0, 20) },
        error: "failed migration(s) present (P3009)",
      };
    }
    return { name: "migrations", status: "healthy", critical: true, latency_ms: Date.now() - start, details: { failed_count: 0 } };
  } catch (err) {
    // Table missing (fresh DB before first migrate), restricted permissions, or
    // a non-Prisma datasource: never penalise readiness for an unreadable
    // bookkeeping table — that would be a self-inflicted outage.
    return {
      name: "migrations", status: "skipped", critical: false,
      latency_ms: Date.now() - start,
      details: { reason: "migrations_table_unreadable" },
      error: err && err.message ? String(err.message).slice(0, 200) : "unknown",
    };
  }
}

async function checkRedis(redis) {
  if (!redis || typeof redis.ping !== "function") {
    return { name: "redis", status: "skipped", critical: false, latency_ms: 0, details: { reason: "no_redis_client_provided" } };
  }
  const start = Date.now();
  try {
    const reply = await redis.ping();
    const ok = reply === "PONG" || reply === true;
    return {
      name: "redis",
      status: ok ? "healthy" : "unhealthy",
      // Redis is critical for BullMQ + agent-task queue; if it's down
      // the long-running task surface is broken.
      critical: true,
      latency_ms: Date.now() - start,
      details: { reply: String(reply).slice(0, 32) },
    };
  } catch (err) {
    return {
      name: "redis", status: "unhealthy", critical: true,
      latency_ms: Date.now() - start,
      error: err && err.message ? String(err.message).slice(0, 200) : "unknown",
    };
  }
}

async function checkQueue(queue) {
  if (!queue) {
    // A degraded queue is still serviceable for synchronous chat;
    // mark non-critical so a stalled queue doesn't 503 the whole API.
    return { name: "queue", status: "skipped", critical: false, latency_ms: 0, details: { reason: "no_queue_provided" } };
  }

  const registryProbe = typeof queue === "function"
    ? queue
    : (typeof queue.probe === "function" ? () => queue.probe() : null);
  if (registryProbe) {
    const start = Date.now();
    try {
      const snapshot = await registryProbe();
      const queues = Array.isArray(snapshot?.queues) ? snapshot.queues : [];
      const statusBySnapshot = {
        ready: "healthy",
        disabled: "skipped",
        skipped: "skipped",
        degraded: "degraded",
        unhealthy: "unhealthy",
      };
      const criticalFailures = queues.filter(
        (item) => item?.critical && item?.status === "unhealthy"
      ).length;
      let status = statusBySnapshot[snapshot?.status] || "degraded";
      if (status === "unhealthy" && criticalFailures === 0) status = "degraded";
      const details = {
        status: snapshot?.status || "degraded",
        total: queues.length,
        ready: queues.filter((item) => item?.status === "ready").length,
        degraded: queues.filter((item) => item?.status === "degraded").length,
        unhealthy: queues.filter((item) => item?.status === "unhealthy").length,
        skipped: queues.filter((item) => item?.status === "skipped").length,
        criticalFailures,
      };
      return {
        name: "queue",
        status,
        critical: criticalFailures > 0,
        latency_ms: Date.now() - start,
        details,
      };
    } catch {
      // The shared registry catches individual queue errors. Reaching this
      // branch means the aggregate probe itself failed, so criticality is
      // unknown and must not drain an otherwise-serving instance.
      return {
        name: "queue", status: "degraded", critical: false,
        latency_ms: Date.now() - start,
        details: {
          status: "degraded",
          total: 0,
          ready: 0,
          degraded: 0,
          unhealthy: 0,
          skipped: 0,
          criticalFailures: 0,
        },
      };
    }
  }

  if (typeof queue.getJobCounts !== "function") {
    return { name: "queue", status: "skipped", critical: false, latency_ms: 0, details: { reason: "no_queue_provided" } };
  }

  const start = Date.now();
  try {
    const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed", "completed");
    return {
      name: "queue", status: "healthy", critical: false,
      latency_ms: Date.now() - start,
      details: counts,
    };
  } catch (err) {
    return {
      name: "queue", status: "degraded", critical: false,
      latency_ms: Date.now() - start,
      error: err && err.message ? String(err.message).slice(0, 200) : "unknown",
    };
  }
}

function checkProcess() {
  // Pure introspection — no I/O. Safe to call from liveness probe.
  const mem = process.memoryUsage();
  return {
    name: "process",
    status: "healthy",
    critical: true,
    latency_ms: 0,
    details: {
      uptime_s: Math.round((Date.now() - PROCESS_BOOT_AT) / 1000),
      pid: process.pid,
      node: process.version,
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
    },
  };
}

function finiteNonNegative(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readPoolAutoscalerState(source) {
  try {
    if (typeof source === "function") return source() || null;
    if (source && typeof source.getState === "function") return source.getState() || null;
    return source && typeof source === "object" ? source : null;
  } catch {
    return null;
  }
}

/**
 * Non-critical operational view of the shared Prisma pool. The instrumentation
 * snapshot remains the source of truth for the live limit; autoscaler state is
 * selected down to safe advisory fields so history and arbitrary errors do not
 * leak through the public health response.
 */
function checkDatabasePool(poolMetrics, getPoolAutoscalerState) {
  if (!poolMetrics || typeof poolMetrics.snapshot !== "function") {
    return {
      name: "database_pool",
      status: "skipped",
      critical: false,
      latency_ms: 0,
      details: { reason: "no_pool_instrumentation" },
    };
  }

  const startedAt = Date.now();
  try {
    const snapshot = poolMetrics.snapshot();
    if (snapshot?.capacity?.observable === false) {
      return {
        name: "database_pool",
        status: "skipped",
        critical: false,
        latency_ms: Date.now() - startedAt,
        details: {
          capacity: {
            observable: false,
            reason: snapshot.capacity.reason || "pool_capacity_unobservable",
          },
          reason: "pool_capacity_unobservable",
        },
      };
    }
    const state = readPoolAutoscalerState(getPoolAutoscalerState);
    const actualLimit = finiteNonNegative(snapshot?.pool?.max, 0);
    const stats = state?.stats || {};
    const recommendation = {
      enabled: Boolean(state),
      running: Boolean(state?.running),
      mode: "advisory",
      currentLimit: actualLimit,
      recommendedLimit: finiteNonNegative(state?.recommendedLimit, actualLimit),
      lastRecommendation: typeof state?.lastRecommendation === "string"
        ? state.lastRecommendation
        : "hold",
      lastRecommendationAt: state?.lastRecommendationAt ?? null,
      stats: {
        ticks: finiteNonNegative(stats.ticks, 0),
        recommendations: finiteNonNegative(stats.recommendations, 0),
        applyErrors: finiteNonNegative(stats.applyErrors, 0),
      },
    };

    let status = "healthy";
    // These are configured-limit estimates, not native Prisma pool counters.
    // Both warning and critical estimates degrade the composite monotonically;
    // estimated pressure alone must never trigger a readiness 503.
    if (
      snapshot?.estimated_saturation === "critical"
      || snapshot?.estimated_saturation === "warn"
    ) {
      status = "degraded";
    }
    return {
      name: "database_pool",
      status,
      critical: false,
      latency_ms: Date.now() - startedAt,
      details: { snapshot, recommendation },
    };
  } catch {
    return {
      name: "database_pool",
      status: "degraded",
      critical: false,
      latency_ms: Date.now() - startedAt,
      details: { reason: "pool_snapshot_unavailable" },
    };
  }
}

function checkModelProvidersConfigured(env = process.env) {
  // Informational only — environment configuration is an ops concern,
  // not a runtime invariant. Surfaces *which* providers are reachable
  // so dashboards can flag missing keys without 503'ing the API.
  const providers = {
    openai: Boolean(env.OPENAI_API_KEY),
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    groq: Boolean(env.GROQ_API_KEY),
    gemini: Boolean(env.GEMINI_API_KEY),
    openrouter: Boolean(env.OPENROUTER_API_KEY),
  };
  const configured = Object.values(providers).filter(Boolean).length;
  return {
    name: "model_providers",
    status: configured > 0 ? "healthy" : "degraded",
    critical: false,
    latency_ms: 0,
    details: { providers, configured_count: configured },
  };
}

function resolveOptionalIntegrationHealth(details) {
  const configured = Boolean(details.configured);
  const enabled = Boolean(details.enabled);
  const started = Boolean(details.started);
  const requested = details.requested === undefined
    ? (details.enabled === undefined ? configured : enabled)
    : Boolean(details.requested);

  let status = "skipped";
  if (requested && started && details.enabled !== false) status = "healthy";
  else if (requested) status = "degraded";

  const reason = details.reason || (requested ? "not_started" : (configured ? "disabled" : "not_configured"));

  return { configured, requested, enabled, started, status, reason };
}

function checkOpenTelemetry(telemetry) {
  const details = typeof telemetry === "function" ? telemetry() : (telemetry || {});
  const state = resolveOptionalIntegrationHealth(details);

  return {
    name: "opentelemetry",
    status: state.status,
    critical: false,
    latency_ms: 0,
    details: {
      configured: state.configured,
      requested: state.requested,
      enabled: state.enabled,
      started: state.started,
      service_name: details.service_name || details.serviceName || "siragpt-backend",
      exporter: details.exporter || "none",
      reason: state.reason,
    },
  };
}

function checkSentry(sentry) {
  const details = typeof sentry === "function" ? sentry() : (sentry || {});
  const state = resolveOptionalIntegrationHealth(details);

  return {
    name: "sentry",
    status: state.status,
    critical: false,
    latency_ms: 0,
    details: {
      configured: state.configured,
      requested: state.requested,
      enabled: state.enabled,
      started: state.started,
      environment: details.environment || process.env.NODE_ENV || "development",
      reason: state.reason,
      traces_sample_rate: Number(details.traces_sample_rate || 0),
    },
  };
}

function checkLangfuse(langfuse) {
  const details = typeof langfuse === "function" ? langfuse() : (langfuse || {});
  const state = resolveOptionalIntegrationHealth(details);

  return {
    name: "langfuse",
    status: state.status,
    critical: false,
    latency_ms: 0,
    details: {
      configured: state.configured,
      requested: state.requested,
      enabled: state.enabled,
      started: state.started,
      reason: state.reason,
    },
  };
}

function checkPostHog(posthog) {
  const details = typeof posthog === "function" ? posthog() : (posthog || {});
  const state = resolveOptionalIntegrationHealth(details);

  return {
    name: "posthog",
    status: state.status,
    critical: false,
    latency_ms: 0,
    details: {
      configured: state.configured,
      requested: state.requested,
      enabled: state.enabled,
      started: state.started,
      reason: state.reason,
    },
  };
}

/**
 * Check circuit breaker health for one or more named breakers.
 *
 * Accepts an object keyed by breaker label → CircuitBreaker instance.
 * Reports healthy if all breakers are CLOSED, degraded if any are
 * HALF_OPEN (recovering), and unhealthy if any are OPEN (downstream
 * dependency is confirmed broken).
 *
 * Non-critical — a broken circuit means degraded experience for some
 * features (agent task scheduling, external API calls), but the core
 * API (auth, chat, file serving) still works.
 */
function checkCircuitBreakers(breakers = {}) {
  const names = Object.keys(breakers);
  if (names.length === 0) {
    return { name: "circuit_breakers", status: "skipped", critical: false, latency_ms: 0, details: { count: 0 } };
  }

  const states = {};
  let anyOpen = false;
  let anyHalfOpen = false;

  for (const name of names) {
    const cb = breakers[name];
    if (typeof cb?.toJSON !== "function") {
      states[name] = "invalid";
      continue;
    }
    const json = cb.toJSON();
    states[name] = json.state;
    if (json.state === "OPEN") anyOpen = true;
    if (json.state === "HALF_OPEN") anyHalfOpen = true;
  }

  let status = "healthy";
  if (anyOpen) status = "unhealthy";
  else if (anyHalfOpen) status = "degraded";

  return {
    name: "circuit_breakers",
    status,
    critical: false,
    latency_ms: 0,
    details: { count: names.length, states },
  };
}

function checkR2Storage(env = process.env) {
  const start = Date.now();
  try {
    const { enabled } = require('../../orchestration/r2-storage');
    const ok = enabled(env);
    const required = env.NODE_ENV === 'production' || env.SIRAGPT_REQUIRE_R2_ARTIFACTS === '1';
    let status = ok ? 'healthy' : 'skipped';
    if (required && !ok) status = 'degraded';
    return {
      name: 'r2_artifacts',
      status,
      critical: false,
      latency_ms: Date.now() - start,
      details: { configured: ok, required },
    };
  } catch (err) {
    return {
      name: 'r2_artifacts',
      status: 'degraded',
      critical: false,
      latency_ms: Date.now() - start,
      error: err?.message || String(err),
    };
  }
}

function checkPlaywright() {
  const start = Date.now();
  try {
    require.resolve('playwright');
    return {
      name: 'playwright',
      status: 'healthy',
      critical: false,
      latency_ms: Date.now() - start,
      details: { installed: true },
    };
  } catch {
    return {
      name: 'playwright',
      status: 'skipped',
      critical: false,
      latency_ms: Date.now() - start,
      details: { installed: false, reason: 'research_agent_text_only_mode' },
    };
  }
}

/**
 * Surface the result of the boot-time Google OAuth configuration check
 * (`validateOAuthCallbackUrl`) so monitoring probes and the ops dashboard
 * can re-detect OAuth misconfigurations without reading startup logs or
 * restarting the process.
 *
 * The boot validator already logs and (in production) can block startup on
 * critical issues. Anything that survives boot but still has issues — host
 * mismatches, missing paired credentials, malformed URLs in non-prod — is
 * reported here as `degraded` so the app stays reachable but the problem is
 * visible. Non-critical: a stale OAuth config should never 503 the API.
 *
 * @param {{checked: boolean, mismatch: boolean, issues: string[]}} [oauthResult]
 */
function checkGoogleOAuth(oauthResult) {
  if (!oauthResult || typeof oauthResult !== "object") {
    return {
      name: "google_oauth",
      status: "skipped",
      critical: false,
      latency_ms: 0,
      details: { reason: "no_oauth_boot_result" },
    };
  }

  const checked = Boolean(oauthResult.checked);
  const mismatch = Boolean(oauthResult.mismatch);
  const issues = Array.isArray(oauthResult.issues) ? oauthResult.issues : [];

  let status;
  if (!checked) status = "skipped";
  else if (issues.length > 0) status = "degraded";
  else status = "healthy";

  return {
    name: "google_oauth",
    status,
    critical: false,
    latency_ms: 0,
    details: { checked, mismatch, issues },
  };
}

/**
 * Surface the result of the boot-time startup environment validator
 * (`validateStartupEnvironment`) so monitoring probes and the ops dashboard
 * can re-detect config problems (missing/placeholder secrets, malformed URLs,
 * out-of-range numeric settings) without reading startup logs or restarting
 * the process.
 *
 * The boot validator already logs and (in production) blocks startup on
 * blocking issues. Anything that survives boot but still has issues —
 * warnings everywhere, or blocking issues in non-production where the server
 * is allowed to keep running — is reported here as `degraded` so the app
 * stays reachable but the problem is visible. Non-critical: a stale config
 * issue should never 503 the API.
 *
 * @param {{checked: boolean, issues: Array<{key, label, severity, message, hint?}>}} [startupEnvResult]
 */
function checkStartupEnvironment(startupEnvResult) {
  if (!startupEnvResult || typeof startupEnvResult !== "object") {
    return {
      name: "startup_env",
      status: "skipped",
      critical: false,
      latency_ms: 0,
      details: { reason: "no_startup_env_result" },
    };
  }

  const checked = Boolean(startupEnvResult.checked);
  const issues = Array.isArray(startupEnvResult.issues) ? startupEnvResult.issues : [];
  const blocking = issues.filter((i) => i && i.severity === "BLOCKING").length;
  const warnings = issues.filter((i) => i && i.severity === "WARNING").length;

  let status;
  if (!checked) status = "skipped";
  else if (issues.length > 0) status = "degraded";
  else status = "healthy";

  return {
    name: "startup_env",
    status,
    critical: false,
    latency_ms: 0,
    details: { checked, issue_count: issues.length, blocking, warnings, issues },
  };
}

function checkCoworkSubsystem(coworkHealth) {
  if (!coworkHealth || typeof coworkHealth.runLivenessCheck !== "function") {
    return { name: "cowork", status: "skipped", critical: false, latency_ms: 0, details: { reason: "no_cowork_health_module" } };
  }
  const start = Date.now();
  try {
    const liveness = coworkHealth.runLivenessCheck();
    return {
      name: "cowork",
      status: liveness.ok ? "healthy" : "degraded",
      critical: false,
      latency_ms: Date.now() - start,
      details: { ok: liveness.ok, subsystems: liveness.checks ? liveness.checks.length : 0 },
    };
  } catch (err) {
    return {
      name: "cowork", status: "degraded", critical: false,
      latency_ms: Date.now() - start,
      error: err && err.message ? String(err.message).slice(0, 200) : "unknown",
    };
  }
}

// ── Composite probes ───────────────────────────────────────────────

function runLivenessCheck() {
  return {
    status: "healthy",
    timestamp: new Date().toISOString(),
    checks: [checkProcess()],
  };
}

async function runReadinessCheck({ prisma, redis, queue, env = process.env } = {}) {
  const checks = await Promise.all([
    checkDatabase(prisma, env),
    checkMigrations(prisma, env),
    checkRedis(redis),
    checkQueue(queue),
  ]);
  checks.push(checkProcess());
  return composeStatus(checks);
}

async function runFullHealthCheck({
  prisma,
  redis,
  queue,
  telemetry,
  sentry,
  langfuse,
  posthog,
  circuitBreakers,
  coworkHealth,
  googleOAuth,
  startupEnv,
  poolMetrics,
  getPoolAutoscalerState,
  env = process.env,
} = {}) {
  const checks = await Promise.all([
    checkDatabase(prisma, env),
    checkMigrations(prisma, env),
    checkRedis(redis),
    checkQueue(queue),
  ]);
  checks.push(checkProcess());
  checks.push(checkModelProvidersConfigured(env));
  checks.push(checkOpenTelemetry(telemetry));
  checks.push(checkSentry(sentry));
  checks.push(checkLangfuse(langfuse));
  checks.push(checkPostHog(posthog));
  checks.push(checkCircuitBreakers(circuitBreakers));
  if (coworkHealth) {
    checks.push(checkCoworkSubsystem(coworkHealth));
  }
  checks.push(checkR2Storage(env));
  checks.push(checkPlaywright());

  let databasePoolCheck = null;
  if (poolMetrics) {
    databasePoolCheck = checkDatabasePool(poolMetrics, getPoolAutoscalerState);
    checks.push(databasePoolCheck);
  }

  // OAuth boot-config health: pushed into the checks array so a stale
  // misconfiguration drives the composite status to `degraded`, and also
  // mirrored under a top-level `googleOAuth` key so monitoring probes can
  // read `{ checked, mismatch, issues }` directly without scanning checks.
  const googleOAuthCheck = checkGoogleOAuth(googleOAuth);
  checks.push(googleOAuthCheck);

  // Startup environment health: pushed into the checks array so lingering
  // config issues drive the composite status to `degraded`, and also mirrored
  // under a top-level `startupEnv` key so monitoring probes can read the issue
  // list directly without scanning checks. Same pattern as googleOAuth above.
  const startupEnvCheck = checkStartupEnvironment(startupEnv);
  checks.push(startupEnvCheck);

  const report = composeStatus(checks);
  report.googleOAuth = googleOAuthCheck.details;
  report.startupEnv = startupEnvCheck.details;
  if (databasePoolCheck) report.databasePool = databasePoolCheck.details;
  return report;
}

function composeStatus(checks) {
  const critical = checks.filter((c) => c.critical);
  const anyCriticalUnhealthy = critical.some((c) => c.status === "unhealthy");
  const anyDegraded = checks.some((c) => c.status === "degraded");
  let status;
  if (anyCriticalUnhealthy) status = "unhealthy";
  else if (anyDegraded) status = "degraded";
  else status = "healthy";
  return {
    status,
    timestamp: new Date().toISOString(),
    checks,
  };
}

/**
 * Decide an HTTP status from a composite report.
 *   healthy   → 200
 *   degraded  → 200 (still serving; just informational)
 *   unhealthy → 503 (load balancer should drain)
 */
function reportToHttpStatus(report) {
  if (!report || typeof report !== "object") return 500;
  if (report.status === "unhealthy") return 503;
  return 200;
}

module.exports = {
  PROCESS_BOOT_AT,
  DEFAULT_HEALTH_DB_TIMEOUT_MS,
  MIN_HEALTH_DB_TIMEOUT_MS,
  MAX_HEALTH_DB_TIMEOUT_MS,
  resolveHealthDbTimeoutMs,
  checkDatabase,
  checkMigrations,
  checkRedis,
  checkQueue,
  checkProcess,
  checkDatabasePool,
  checkModelProvidersConfigured,
  checkOpenTelemetry,
  checkSentry,
  checkLangfuse,
  checkPostHog,
  checkCircuitBreakers,
  checkGoogleOAuth,
  checkStartupEnvironment,
  checkCoworkSubsystem,
  checkR2Storage,
  checkPlaywright,
  runLivenessCheck,
  runReadinessCheck,
  runFullHealthCheck,
  composeStatus,
  reportToHttpStatus,
};

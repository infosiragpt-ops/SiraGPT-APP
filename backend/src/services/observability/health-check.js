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

// ── Individual probes ──────────────────────────────────────────────

async function checkDatabase(prisma) {
  if (!prisma || typeof prisma.$queryRawUnsafe !== "function") {
    return { name: "database", status: "skipped", critical: false, latency_ms: 0, details: { reason: "no_prisma_client_provided" } };
  }
  const start = Date.now();
  try {
    // `SELECT 1` is the cheapest possible round-trip; covers TCP +
    // auth + a real query path. Timeout is enforced by the deps' own
    // pool config — health-check itself doesn't race a timer because
    // a slow DB IS the signal we want surfaced.
    await prisma.$queryRawUnsafe("SELECT 1");
    return { name: "database", status: "healthy", critical: true, latency_ms: Date.now() - start };
  } catch (err) {
    return {
      name: "database", status: "unhealthy", critical: true,
      latency_ms: Date.now() - start,
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
  if (!queue || typeof queue.getJobCounts !== "function") {
    // A degraded queue is still serviceable for synchronous chat;
    // mark non-critical so a stalled queue doesn't 503 the whole API.
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

function checkModelProvidersConfigured() {
  // Informational only — environment configuration is an ops concern,
  // not a runtime invariant. Surfaces *which* providers are reachable
  // so dashboards can flag missing keys without 503'ing the API.
  const providers = {
    openai: Boolean(process.env.OPENAI_API_KEY),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    groq: Boolean(process.env.GROQ_API_KEY),
    gemini: Boolean(process.env.GEMINI_API_KEY),
    openrouter: Boolean(process.env.OPENROUTER_API_KEY),
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
      status: 'degraded',
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

async function runReadinessCheck({ prisma, redis, queue } = {}) {
  const checks = await Promise.all([
    checkDatabase(prisma),
    checkRedis(redis),
    checkQueue(queue),
  ]);
  checks.push(checkProcess());
  return composeStatus(checks);
}

async function runFullHealthCheck({ prisma, redis, queue, telemetry, sentry, langfuse, posthog, circuitBreakers, coworkHealth, googleOAuth } = {}) {
  const checks = await Promise.all([
    checkDatabase(prisma),
    checkRedis(redis),
    checkQueue(queue),
  ]);
  checks.push(checkProcess());
  checks.push(checkModelProvidersConfigured());
  checks.push(checkOpenTelemetry(telemetry));
  checks.push(checkSentry(sentry));
  checks.push(checkLangfuse(langfuse));
  checks.push(checkPostHog(posthog));
  checks.push(checkCircuitBreakers(circuitBreakers));
  if (coworkHealth) {
    checks.push(checkCoworkSubsystem(coworkHealth));
  }
  checks.push(checkR2Storage());
  checks.push(checkPlaywright());

  // OAuth boot-config health: pushed into the checks array so a stale
  // misconfiguration drives the composite status to `degraded`, and also
  // mirrored under a top-level `googleOAuth` key so monitoring probes can
  // read `{ checked, mismatch, issues }` directly without scanning checks.
  const googleOAuthCheck = checkGoogleOAuth(googleOAuth);
  checks.push(googleOAuthCheck);

  const report = composeStatus(checks);
  report.googleOAuth = googleOAuthCheck.details;
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
  checkDatabase,
  checkRedis,
  checkQueue,
  checkProcess,
  checkModelProvidersConfigured,
  checkOpenTelemetry,
  checkSentry,
  checkLangfuse,
  checkPostHog,
  checkCircuitBreakers,
  checkGoogleOAuth,
  checkCoworkSubsystem,
  checkR2Storage,
  checkPlaywright,
  runLivenessCheck,
  runReadinessCheck,
  runFullHealthCheck,
  composeStatus,
  reportToHttpStatus,
};

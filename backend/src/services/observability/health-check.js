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

async function runFullHealthCheck({ prisma, redis, queue } = {}) {
  const checks = await Promise.all([
    checkDatabase(prisma),
    checkRedis(redis),
    checkQueue(queue),
  ]);
  checks.push(checkProcess());
  checks.push(checkModelProvidersConfigured());
  return composeStatus(checks);
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
  runLivenessCheck,
  runReadinessCheck,
  runFullHealthCheck,
  composeStatus,
  reportToHttpStatus,
};

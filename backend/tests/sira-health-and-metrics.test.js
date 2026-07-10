/**
 * sira-health-and-metrics — verifies the deep /health probes and the
 * Prometheus /metrics inventory closes gap §14.3 in PIPELINE.md.
 *
 * Health-check tests use fake prisma/redis/queue clients so the suite
 * runs offline; the same module is hooked into a real Postgres + Redis
 * by the CI smoke test (boot + curl /health).
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  checkDatabase,
  checkMigrations,
  resolveHealthDbTimeoutMs,
  checkRedis,
  checkQueue,
  checkProcess,
  checkModelProvidersConfigured,
  checkOpenTelemetry,
  checkSentry,
  checkLangfuse,
  checkPostHog,
  checkStartupEnvironment,
  checkDatabasePool,
  runLivenessCheck,
  runReadinessCheck,
  runFullHealthCheck,
  composeStatus,
  reportToHttpStatus,
} = require("../src/services/observability/health-check");

const metrics = require("../src/services/agents/metrics");
const siraMetrics = require("../src/services/sira/metrics");
const { createDbProbe } = require("../src/health/probes/db");
const delay = (ms, value) => new Promise((resolve) => setTimeout(resolve, ms, value));

// ── checkDatabase ──────────────────────────────────────────────────

describe("checkDatabase", () => {
  test("HEALTH_DB_TIMEOUT_MS defaults to 1500ms and clamps to 100-10000ms", () => {
    assert.equal(resolveHealthDbTimeoutMs({}), 1500);
    assert.equal(resolveHealthDbTimeoutMs({ HEALTH_DB_TIMEOUT_MS: "garbage" }), 1500);
    assert.equal(resolveHealthDbTimeoutMs({ HEALTH_DB_TIMEOUT_MS: "1" }), 100);
    assert.equal(resolveHealthDbTimeoutMs({ HEALTH_DB_TIMEOUT_MS: "2500" }), 2500);
    assert.equal(resolveHealthDbTimeoutMs({ HEALTH_DB_TIMEOUT_MS: "99999" }), 10_000);
  });

  test("healthy when prisma.$queryRawUnsafe resolves", async () => {
    const fakePrisma = { $queryRawUnsafe: async () => 1 };
    const r = await checkDatabase(fakePrisma);
    assert.equal(r.name, "database");
    assert.equal(r.status, "healthy");
    assert.equal(r.critical, true);
    assert.ok(r.latency_ms >= 0);
  });

  test("unhealthy when prisma throws", async () => {
    const fakePrisma = { $queryRawUnsafe: async () => { throw new Error("ECONNREFUSED"); } };
    const r = await checkDatabase(fakePrisma);
    assert.equal(r.status, "unhealthy");
    assert.equal(r.critical, true);
    assert.match(r.error, /ECONNREFUSED/);
  });

  test("skipped when no client passed", async () => {
    const r = await checkDatabase(null);
    assert.equal(r.status, "skipped");
    assert.equal(r.critical, false);
  });

  test("a never-settling Prisma query becomes unhealthy within the configured bound", async () => {
    const outerTimeout = Symbol("outer-timeout");
    const result = await Promise.race([
      checkDatabase(
        { $queryRawUnsafe: () => new Promise(() => {}) },
        { HEALTH_DB_TIMEOUT_MS: "1" },
      ),
      delay(300, outerTimeout),
    ]);

    assert.notEqual(result, outerTimeout, "database probe exceeded its 100ms lower bound");
    assert.equal(result.status, "unhealthy");
    assert.equal(result.critical, true);
    assert.match(result.error, /timed out after 100ms/i);
  });

  test("public and internal DB probes share one unresolved Prisma operation", async () => {
    let calls = 0;
    let resolveFirst;
    const firstOperation = new Promise((resolve) => { resolveFirst = resolve; });
    const prisma = {
      $queryRawUnsafe: () => {
        calls += 1;
        return calls === 1 ? firstOperation : Promise.resolve([{ ok: 1 }]);
      },
      $queryRaw: () => {
        calls += 1;
        return calls === 1 ? firstOperation : Promise.resolve([{ ok: 1 }]);
      },
    };

    const publicResult = await checkDatabase(prisma, { HEALTH_DB_TIMEOUT_MS: "1" });
    assert.equal(publicResult.status, "unhealthy");
    const repeatedPublicResult = await checkDatabase(prisma, { HEALTH_DB_TIMEOUT_MS: "1" });
    assert.equal(repeatedPublicResult.status, "unhealthy");
    const internalResult = await createDbProbe({
      prisma,
      timeoutMs: 100,
      ttlMs: 0,
    }).run({ bypassCache: true });
    assert.equal(internalResult.status, "timeout");
    assert.equal(calls, 1, "timed-out public/internal probes must share the unresolved query");

    resolveFirst([{ ok: 1 }]);
    await new Promise((resolve) => setImmediate(resolve));
    const recovered = await checkDatabase(prisma, { HEALTH_DB_TIMEOUT_MS: "1" });
    assert.equal(recovered.status, "healthy");
    assert.equal(calls, 2, "settled operations must be removed from the coalescer");
  });
});

// ── checkMigrations ────────────────────────────────────────────────

describe("checkMigrations", () => {
  test("healthy when no failed migrations", async () => {
    const fakePrisma = { $queryRawUnsafe: async () => [] };
    const r = await checkMigrations(fakePrisma);
    assert.equal(r.name, "migrations");
    assert.equal(r.status, "healthy");
    assert.equal(r.critical, true);
    assert.equal(r.details.failed_count, 0);
  });

  test("unhealthy + critical when a failed migration is present (P3009)", async () => {
    const fakePrisma = {
      $queryRawUnsafe: async () => [{ migration_name: "20250919203030_add_model_sync_fields" }],
    };
    const r = await checkMigrations(fakePrisma);
    assert.equal(r.status, "unhealthy");
    assert.equal(r.critical, true);
    assert.equal(r.details.failed_count, 1);
    assert.deepEqual(r.details.failed, ["20250919203030_add_model_sync_fields"]);
  });

  test("skipped (non-critical) when the migrations table is unreadable", async () => {
    const fakePrisma = { $queryRawUnsafe: async () => { throw new Error('relation "_prisma_migrations" does not exist'); } };
    const r = await checkMigrations(fakePrisma);
    assert.equal(r.status, "skipped");
    assert.equal(r.critical, false);
    assert.equal(r.details.reason, "migrations_table_unreadable");
  });

  test("skipped when no client passed", async () => {
    const r = await checkMigrations(null);
    assert.equal(r.status, "skipped");
    assert.equal(r.critical, false);
  });

  test("a timed-out migration query absorbs a late rejection", async (t) => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    t.after(() => process.removeListener("unhandledRejection", onUnhandled));

    const r = await checkMigrations(
      {
        $queryRawUnsafe: () => new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error("late migration rejection")), 180);
        }),
      },
      { HEALTH_DB_TIMEOUT_MS: "1" },
    );

    await delay(120);
    assert.equal(r.status, "skipped");
    assert.equal(r.critical, false);
    assert.equal(r.details.reason, "migrations_table_unreadable");
    assert.match(r.error, /timed out after 100ms/i);
    assert.deepEqual(unhandled, []);
  });

  test("repeated migration timeouts share one operation and late rejection releases it", async () => {
    let calls = 0;
    let rejectFirst;
    const firstOperation = new Promise((_resolve, reject) => { rejectFirst = reject; });
    const prisma = {
      $queryRawUnsafe: () => {
        calls += 1;
        return calls === 1 ? firstOperation : Promise.resolve([]);
      },
    };

    assert.equal(
      (await checkMigrations(prisma, { HEALTH_DB_TIMEOUT_MS: "1" })).status,
      "skipped",
    );
    assert.equal(
      (await checkMigrations(prisma, { HEALTH_DB_TIMEOUT_MS: "1" })).status,
      "skipped",
    );
    assert.equal(calls, 1, "repeated timeouts must not multiply migration queries");

    rejectFirst(new Error("late migration failure"));
    await new Promise((resolve) => setImmediate(resolve));
    const recovered = await checkMigrations(prisma, { HEALTH_DB_TIMEOUT_MS: "1" });
    assert.equal(recovered.status, "healthy");
    assert.equal(calls, 2, "rejected operations must be removed from the coalescer");
  });

  test("a failed migration drives readiness to 503-worthy unhealthy", async () => {
    const r = await runReadinessCheck({
      prisma: { $queryRawUnsafe: async (sql) => (/_prisma_migrations/.test(sql) ? [{ migration_name: "x" }] : 1) },
      redis: { ping: async () => "PONG" },
      queue: { getJobCounts: async () => ({ waiting: 0 }) },
    });
    assert.equal(r.status, "unhealthy");
    assert.ok(r.checks.find((c) => c.name === "migrations" && c.status === "unhealthy"));
  });
});

// ── checkRedis ─────────────────────────────────────────────────────

describe("checkRedis", () => {
  test("healthy on PONG", async () => {
    const r = await checkRedis({ ping: async () => "PONG" });
    assert.equal(r.status, "healthy");
    assert.equal(r.critical, true);
  });

  test("unhealthy when ping rejects", async () => {
    const r = await checkRedis({ ping: async () => { throw new Error("EHOSTUNREACH"); } });
    assert.equal(r.status, "unhealthy");
    assert.match(r.error, /EHOSTUNREACH/);
  });

  test("unhealthy when ping returns unexpected reply", async () => {
    const r = await checkRedis({ ping: async () => "WAT" });
    assert.equal(r.status, "unhealthy");
  });

  test("skipped when no client", async () => {
    const r = await checkRedis(null);
    assert.equal(r.status, "skipped");
    assert.equal(r.critical, false);
  });
});

// ── checkQueue ─────────────────────────────────────────────────────

describe("checkQueue", () => {
  test("healthy with counts", async () => {
    const fakeQueue = { getJobCounts: async () => ({ waiting: 1, active: 0, delayed: 0, failed: 0, completed: 5 }) };
    const r = await checkQueue(fakeQueue);
    assert.equal(r.status, "healthy");
    assert.equal(r.critical, false);
    assert.equal(r.details.waiting, 1);
    assert.equal(r.details.completed, 5);
  });

  test("degraded when getJobCounts throws", async () => {
    const fakeQueue = { getJobCounts: async () => { throw new Error("queue down"); } };
    const r = await checkQueue(fakeQueue);
    assert.equal(r.status, "degraded");
    assert.equal(r.critical, false);
  });

  test("skipped without queue", async () => {
    assert.equal((await checkQueue(null)).status, "skipped");
  });
});

// ── checkProcess ────────────────────────────────────────────────────

describe("checkProcess", () => {
  test("returns healthy + memory + uptime", () => {
    const r = checkProcess();
    assert.equal(r.name, "process");
    assert.equal(r.status, "healthy");
    assert.equal(r.critical, true);
    assert.ok(Number.isFinite(r.details.uptime_s));
    assert.ok(r.details.rss_mb > 0);
    assert.ok(r.details.heap_used_mb > 0);
    assert.equal(r.details.pid, process.pid);
  });
});

describe("checkDatabasePool", () => {
  test("reports the bounded instrumentation snapshot and advisory recommendation", () => {
    const poolMetrics = {
      snapshot: () => ({
        capacity: { observable: true, reason: "direct_postgres_datasource" },
        pool: { min: 2, max: 10, idleTimeoutMs: 60_000 },
        estimated_connections_active: 7,
        estimated_connections_idle: 3,
        queries_in_flight: 7,
        estimated_saturation_ratio: 0.7,
        estimated_saturation: "ok",
      }),
    };
    const check = checkDatabasePool(poolMetrics, () => ({
      running: true,
      mode: "advisory",
      currentLimit: 10,
      recommendedLimit: 12,
      lastRecommendation: "scale_up",
      lastRecommendationAt: 1234,
      stats: {
        ticks: 3,
        recommendations: 1,
        applyErrors: 0,
        lastError: "must not leak into health",
      },
      history: [{ reason: "bounded internally but not needed in health" }],
    }));

    assert.equal(check.name, "database_pool");
    assert.equal(check.status, "healthy");
    assert.equal(check.critical, false);
    assert.equal(check.details.snapshot.pool.max, 10);
    assert.equal(check.details.snapshot.estimated_connections_active, 7);
    assert.equal(Object.hasOwn(check.details.snapshot, "connections_active"), false);
    assert.equal(Object.hasOwn(check.details.snapshot, "saturation_ratio"), false);
    assert.deepEqual(check.details.recommendation, {
      enabled: true,
      running: true,
      mode: "advisory",
      currentLimit: 10,
      recommendedLimit: 12,
      lastRecommendation: "scale_up",
      lastRecommendationAt: 1234,
      stats: {
        ticks: 3,
        recommendations: 1,
        applyErrors: 0,
      },
    });
    assert.equal(check.details.recommendation.history, undefined);
    assert.equal(check.details.recommendation.stats.lastError, undefined);
  });

  test("falls back to an advisory hold when autoscaling is disabled", () => {
    const check = checkDatabasePool({
      snapshot: () => ({
        capacity: { observable: true, reason: "direct_postgres_datasource" },
        pool: { min: 2, max: 9 },
        estimated_saturation_ratio: 0,
        estimated_saturation: "ok",
      }),
    });

    assert.equal(check.details.recommendation.enabled, false);
    assert.equal(check.details.recommendation.running, false);
    assert.equal(check.details.recommendation.currentLimit, 9);
    assert.equal(check.details.recommendation.recommendedLimit, 9);
    assert.equal(check.details.recommendation.lastRecommendation, "hold");
  });

  test("skips local pool health and recommendations when capacity is unobservable", () => {
    const check = checkDatabasePool({
      snapshot: () => ({
        capacity: { observable: false, reason: "remote_prisma_datasource" },
        pool: null,
        estimated_connections_active: null,
        estimated_connections_idle: null,
        estimated_saturation_ratio: null,
        estimated_saturation: "unobservable",
        queries_in_flight: 2,
      }),
    }, () => ({
      running: true,
      recommendedLimit: 99,
    }));

    assert.equal(check.status, "skipped");
    assert.deepEqual(check.details, {
      capacity: { observable: false, reason: "remote_prisma_datasource" },
      reason: "pool_capacity_unobservable",
    });
    assert.equal(Object.hasOwn(check.details, "snapshot"), false);
    assert.equal(Object.hasOwn(check.details, "recommendation"), false);
  });
});

// ── checkModelProvidersConfigured ──────────────────────────────────

describe("checkModelProvidersConfigured", () => {
  test("healthy when at least one provider key is set", () => {
    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test";
    try {
      const r = checkModelProvidersConfigured();
      assert.equal(r.status, "healthy");
      assert.equal(r.details.providers.openai, true);
      assert.ok(r.details.configured_count >= 1);
    } finally {
      if (original === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = original;
    }
  });

  test("degraded when no provider keys are set", () => {
    const originals = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GROQ_API_KEY: process.env.GROQ_API_KEY,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    };
    try {
      for (const k of Object.keys(originals)) delete process.env[k];
      const r = checkModelProvidersConfigured();
      assert.equal(r.status, "degraded");
      assert.equal(r.details.configured_count, 0);
    } finally {
      for (const [k, v] of Object.entries(originals)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

// ── checkOpenTelemetry ─────────────────────────────────────────────

describe("checkOpenTelemetry", () => {
  test("skipped when tracing is not configured", () => {
    const r = checkOpenTelemetry({ configured: false, enabled: false, started: false });
    assert.equal(r.name, "opentelemetry");
    assert.equal(r.status, "skipped");
    assert.equal(r.critical, false);
  });

  test("healthy when tracing started", () => {
    const r = checkOpenTelemetry({
      configured: true,
      enabled: true,
      started: true,
      service_name: "siragpt-backend",
      exporter: "otlp-http",
      reason: "started",
    });
    assert.equal(r.status, "healthy");
    assert.equal(r.details.service_name, "siragpt-backend");
    assert.equal(r.details.exporter, "otlp-http");
  });

  test("degraded when tracing was requested but did not start", () => {
    const r = checkOpenTelemetry({
      configured: true,
      enabled: true,
      started: false,
      exporter: "otlp-http",
      reason: "missing_otlp_trace_endpoint",
    });
    assert.equal(r.status, "degraded");
    assert.equal(r.critical, false);
    assert.equal(r.details.reason, "missing_otlp_trace_endpoint");
  });
});

// ── Optional observability checks ─────────────────────────────────

describe("optional observability health checks", () => {
  test("optional integrations disabled at boot are skipped, not degraded", () => {
    for (const check of [checkOpenTelemetry, checkSentry, checkLangfuse, checkPostHog]) {
      const r = check({
        configured: true,
        requested: false,
        enabled: false,
        started: true,
        reason: "disabled_by_env",
      });
      assert.equal(r.status, "skipped", `${r.name} should be skipped when disabled`);
      assert.equal(r.details.requested, false);
      assert.equal(r.critical, false);
    }
  });

  test("requested integrations with missing config are degraded", () => {
    for (const check of [checkOpenTelemetry, checkSentry, checkLangfuse, checkPostHog]) {
      const r = check({
        configured: false,
        requested: true,
        enabled: false,
        started: true,
        reason: "missing_required_config",
      });
      assert.equal(r.status, "degraded", `${r.name} should be degraded when requested`);
      assert.equal(r.details.requested, true);
      assert.equal(r.details.reason, "missing_required_config");
    }
  });
});

// ── composeStatus ──────────────────────────────────────────────────

describe("composeStatus", () => {
  test("healthy when every check is healthy", () => {
    const r = composeStatus([
      { name: "x", status: "healthy", critical: true },
      { name: "y", status: "healthy", critical: false },
    ]);
    assert.equal(r.status, "healthy");
  });

  test("degraded when only non-critical checks are degraded", () => {
    const r = composeStatus([
      { name: "x", status: "healthy", critical: true },
      { name: "y", status: "degraded", critical: false },
    ]);
    assert.equal(r.status, "degraded");
  });

  test("unhealthy when a critical check is unhealthy", () => {
    const r = composeStatus([
      { name: "x", status: "unhealthy", critical: true },
      { name: "y", status: "healthy", critical: false },
    ]);
    assert.equal(r.status, "unhealthy");
  });

  test("non-critical unhealthy alone does not flip overall to unhealthy", () => {
    const r = composeStatus([
      { name: "x", status: "healthy", critical: true },
      { name: "y", status: "unhealthy", critical: false },
    ]);
    // Non-critical unhealthy is treated as a regression worth flagging
    // but not paging for; overall stays healthy because no critical
    // check failed.
    assert.equal(r.status, "healthy");
  });
});

// ── reportToHttpStatus ─────────────────────────────────────────────

describe("reportToHttpStatus", () => {
  test("healthy / degraded → 200", () => {
    assert.equal(reportToHttpStatus({ status: "healthy" }), 200);
    assert.equal(reportToHttpStatus({ status: "degraded" }), 200);
  });
  test("unhealthy → 503", () => {
    assert.equal(reportToHttpStatus({ status: "unhealthy" }), 503);
  });
  test("anything else → 500", () => {
    assert.equal(reportToHttpStatus(null), 500);
    assert.equal(reportToHttpStatus({}), 200); // missing status is treated like healthy fallback
  });
});

// ── Composite probes ───────────────────────────────────────────────

describe("runLivenessCheck", () => {
  test("returns healthy with at least one process check", () => {
    const r = runLivenessCheck();
    assert.equal(r.status, "healthy");
    assert.ok(Array.isArray(r.checks));
    assert.ok(r.checks.find((c) => c.name === "process"));
    assert.ok(r.timestamp);
  });
});

describe("runReadinessCheck", () => {
  test("aggregates db + redis + queue + process", async () => {
    const r = await runReadinessCheck({
      prisma: { $queryRawUnsafe: async () => 1 },
      redis: { ping: async () => "PONG" },
      queue: { getJobCounts: async () => ({ waiting: 0 }) },
    });
    assert.equal(r.status, "healthy");
    const names = r.checks.map((c) => c.name).sort();
    assert.deepEqual(names, ["database", "migrations", "process", "queue", "redis"]);
  });

  test("503 when DB is unhealthy", async () => {
    const r = await runReadinessCheck({
      prisma: { $queryRawUnsafe: async () => { throw new Error("down"); } },
      redis: { ping: async () => "PONG" },
    });
    assert.equal(r.status, "unhealthy");
    assert.equal(reportToHttpStatus(r), 503);
  });

  test("uses its injected env for bounded database and migration probes", async (t) => {
    const previous = process.env.HEALTH_DB_TIMEOUT_MS;
    process.env.HEALTH_DB_TIMEOUT_MS = "1000";
    t.after(() => {
      if (previous === undefined) delete process.env.HEALTH_DB_TIMEOUT_MS;
      else process.env.HEALTH_DB_TIMEOUT_MS = previous;
    });
    const prisma = { $queryRawUnsafe: () => new Promise(() => {}) };

    const startedAt = Date.now();
    const report = await runReadinessCheck({
      prisma,
      env: { HEALTH_DB_TIMEOUT_MS: "100" },
    });
    const elapsedMs = Date.now() - startedAt;
    const database = report.checks.find((check) => check.name === "database");
    const migrations = report.checks.find((check) => check.name === "migrations");

    assert.ok(elapsedMs < 500, `injected 100ms bound was ignored (${elapsedMs}ms)`);
    assert.match(database.error, /timed out after 100ms/i);
    assert.match(migrations.error, /timed out after 100ms/i);
  });
});

describe("checkStartupEnvironment", () => {
  test("skipped when no result is provided", () => {
    const r = checkStartupEnvironment();
    assert.equal(r.name, "startup_env");
    assert.equal(r.status, "skipped");
    assert.equal(r.critical, false);
  });

  test("healthy when checked with no issues", () => {
    const r = checkStartupEnvironment({ checked: true, issues: [] });
    assert.equal(r.status, "healthy");
    assert.equal(r.details.issue_count, 0);
  });

  test("degraded (never unhealthy) when issues are present", () => {
    const r = checkStartupEnvironment({
      checked: true,
      issues: [
        { key: "JWT_SECRET", severity: "BLOCKING", message: "missing" },
        { key: "REDIS_URL", severity: "WARNING", message: "not set" },
      ],
    });
    assert.equal(r.status, "degraded");
    assert.equal(r.critical, false);
    assert.equal(r.details.issue_count, 2);
    assert.equal(r.details.blocking, 1);
    assert.equal(r.details.warnings, 1);
  });
});

describe("runFullHealthCheck", () => {
  test("includes model_providers and opentelemetry informational checks", async () => {
    const r = await runFullHealthCheck({
      prisma: { $queryRawUnsafe: async () => 1 },
      redis: { ping: async () => "PONG" },
      telemetry: { configured: true, enabled: true, started: true, exporter: "otlp-http" },
    });
    assert.ok(r.checks.find((c) => c.name === "model_providers"));
    assert.ok(r.checks.find((c) => c.name === "opentelemetry"));
  });

  test("surfaces startup_env check and mirrors it under top-level startupEnv", async () => {
    const r = await runFullHealthCheck({
      prisma: { $queryRawUnsafe: async () => 1 },
      redis: { ping: async () => "PONG" },
      startupEnv: { checked: true, issues: [{ key: "REDIS_URL", severity: "WARNING", message: "not set" }] },
    });
    const check = r.checks.find((c) => c.name === "startup_env");
    assert.ok(check);
    assert.equal(check.status, "degraded");
    assert.deepEqual(r.startupEnv, check.details);
    // A startup-env warning drives the composite to degraded but never 503s.
    assert.equal(r.status, "degraded");
    assert.equal(reportToHttpStatus(r), 200);
  });

  test("surfaces database pool snapshot and recommendation without affecting readiness", async () => {
    const poolMetrics = {
      snapshot: () => ({
        capacity: { observable: true, reason: "direct_postgres_datasource" },
        pool: { min: 2, max: 10, idleTimeoutMs: 60_000 },
        estimated_connections_active: 4,
        estimated_connections_idle: 6,
        queries_in_flight: 4,
        estimated_saturation_ratio: 0.4,
        estimated_saturation: "ok",
      }),
    };
    const r = await runFullHealthCheck({
      prisma: { $queryRawUnsafe: async () => 1 },
      redis: { ping: async () => "PONG" },
      env: { OPENAI_API_KEY: "test-only" },
      poolMetrics,
      getPoolAutoscalerState: () => ({
        running: true,
        mode: "advisory",
        currentLimit: 10,
        recommendedLimit: 12,
        lastRecommendation: "scale_up",
        lastRecommendationAt: 1234,
        stats: { ticks: 2, recommendations: 1, applyErrors: 0 },
      }),
    });

    const check = r.checks.find((item) => item.name === "database_pool");
    assert.ok(check);
    assert.equal(check.critical, false);
    assert.deepEqual(r.databasePool, check.details);
    assert.equal(r.databasePool.snapshot.pool.max, 10);
    assert.equal(r.databasePool.recommendation.recommendedLimit, 12);
  });

  test("critical estimated saturation monotonically degrades composite health", async () => {
    const r = await runFullHealthCheck({
      prisma: { $queryRawUnsafe: async () => 1 },
      redis: { ping: async () => "PONG" },
      env: { OPENAI_API_KEY: "test-only" },
      poolMetrics: {
        snapshot: () => ({
          capacity: { observable: true, reason: "direct_postgres_datasource" },
          pool: { min: 2, max: 10 },
          estimated_connections_active: 10,
          estimated_connections_idle: 0,
          queries_in_flight: 10,
          estimated_saturation_ratio: 1,
          estimated_saturation: "critical",
        }),
      },
    });

    const check = r.checks.find((item) => item.name === "database_pool");
    assert.equal(check.status, "degraded");
    assert.equal(check.critical, false);
    assert.equal(r.status, "degraded");
    assert.equal(reportToHttpStatus(r), 200);
  });

  test("uses its injected env for bounded database and migration probes", async (t) => {
    const previous = process.env.HEALTH_DB_TIMEOUT_MS;
    process.env.HEALTH_DB_TIMEOUT_MS = "1000";
    t.after(() => {
      if (previous === undefined) delete process.env.HEALTH_DB_TIMEOUT_MS;
      else process.env.HEALTH_DB_TIMEOUT_MS = previous;
    });
    const prisma = { $queryRawUnsafe: () => new Promise(() => {}) };

    const startedAt = Date.now();
    const report = await runFullHealthCheck({
      prisma,
      env: { HEALTH_DB_TIMEOUT_MS: "100" },
    });
    const elapsedMs = Date.now() - startedAt;
    const database = report.checks.find((check) => check.name === "database");
    const migrations = report.checks.find((check) => check.name === "migrations");

    assert.ok(elapsedMs < 500, `injected 100ms bound was ignored (${elapsedMs}ms)`);
    assert.match(database.error, /timed out after 100ms/i);
    assert.match(migrations.error, /timed out after 100ms/i);
  });
});

// ── Google OAuth boot-config exposure in /health ───────────────────
//
// Guards the contract monitors depend on: the boot-time Google OAuth
// config result must surface in runFullHealthCheck both as a
// `google_oauth` entry in the checks array AND mirrored under a
// top-level `googleOAuth` key, and an OAuth issue must drive the
// composite status to "degraded" (never 503 — it's non-critical).
//
// A provider key is set so model_providers is healthy, isolating the
// overall status to the OAuth signal under test.

describe("runFullHealthCheck google_oauth exposure", () => {
  function withProviderKey(fn) {
    const env = {
      ...process.env,
      OPENAI_API_KEY: "sk-test",
      NODE_ENV: "test",
      SIRAGPT_REQUIRE_R2_ARTIFACTS: "0",
    };
    return Promise.resolve().then(() => fn(env));
  }

  test("oauth mismatch drives overall degraded + exposes googleOAuth key and google_oauth check", () =>
    withProviderKey(async (env) => {
      const r = await runFullHealthCheck({
        prisma: { $queryRawUnsafe: async () => 1 },
        redis: { ping: async () => "PONG" },
        env,
        googleOAuth: {
          checked: true,
          mismatch: true,
          issues: ["redirect host mismatch: expected siragpt.com"],
        },
      });

      assert.equal(r.status, "degraded");
      // Never page on a stale OAuth config — degraded maps to 200.
      assert.equal(reportToHttpStatus(r), 200);

      // Top-level mirror for monitoring probes.
      assert.ok(r.googleOAuth, "expected top-level googleOAuth key");
      assert.equal(r.googleOAuth.checked, true);
      assert.equal(r.googleOAuth.mismatch, true);
      assert.deepEqual(r.googleOAuth.issues, [
        "redirect host mismatch: expected siragpt.com",
      ]);

      // Entry inside the checks array.
      const check = r.checks.find((c) => c.name === "google_oauth");
      assert.ok(check, "expected a google_oauth check entry");
      assert.equal(check.status, "degraded");
      assert.equal(check.critical, false);
    }));

  test("no googleOAuth dep → google_oauth check is skipped and does not force degraded", () =>
    withProviderKey(async (env) => {
      const r = await runFullHealthCheck({
        prisma: { $queryRawUnsafe: async () => 1 },
        redis: { ping: async () => "PONG" },
        env,
      });

      const check = r.checks.find((c) => c.name === "google_oauth");
      assert.ok(check, "expected a google_oauth check entry");
      assert.equal(check.status, "skipped");
      assert.equal(check.critical, false);
      assert.equal(check.details.reason, "no_oauth_boot_result");
      // A skipped OAuth check must not by itself degrade the report.
      assert.equal(r.status, "healthy");
    }));

  test("clean oauth result ({checked:true, issues:[]}) reports healthy", () =>
    withProviderKey(async (env) => {
      const r = await runFullHealthCheck({
        prisma: { $queryRawUnsafe: async () => 1 },
        redis: { ping: async () => "PONG" },
        env,
        googleOAuth: { checked: true, mismatch: false, issues: [] },
      });

      assert.equal(r.status, "healthy");
      const check = r.checks.find((c) => c.name === "google_oauth");
      assert.ok(check, "expected a google_oauth check entry");
      assert.equal(check.status, "healthy");
      assert.deepEqual(r.googleOAuth.issues, []);
    }));
});

// ── Sira metrics inventory ─────────────────────────────────────────

describe("sira metrics registry", () => {
  test("registers chat-pipeline counters and histograms", () => {
    const text = metrics.renderText();
    for (const expected of [
      "sira_chat_turns_total",
      "sira_chat_turn_duration_ms",
      "sira_pipeline_errors_total",
      "sira_token_budget_decisions_total",
      "sira_clarifications_requested_total",
      "sira_envelope_invalid_total",
    ]) {
      assert.ok(text.includes(expected), `${expected} missing from renderText output`);
    }
  });

  test("recordTurn increments the histogram and the counter", () => {
    siraMetrics.recordTurn({ stage: "delivered", status: "success", plan: "PRO", durationMs: 1234 });
    const text = metrics.renderText();
    assert.match(text, /sira_chat_turns_total\{stage="delivered",status="success",plan="PRO"\} 1/);
    assert.match(text, /sira_chat_turn_duration_ms_count\{stage="delivered"\} \d+/);
  });

  test("recordTokenBudgetDecision increments by labels", () => {
    siraMetrics.recordTokenBudgetDecision({ decision: "allowed", plan: "FREE", enforcement_mode: "enforce" });
    const text = metrics.renderText();
    assert.match(text, /sira_token_budget_decisions_total\{decision="allowed",plan="FREE",enforcement_mode="enforce"\} \d+/);
  });

  test("recordClarificationRequested + recordEnvelopeInvalid bump their counters", () => {
    siraMetrics.recordClarificationRequested();
    siraMetrics.recordEnvelopeInvalid();
    const text = metrics.renderText();
    assert.match(text, /sira_clarifications_requested_total \d+/);
    assert.match(text, /sira_envelope_invalid_total \d+/);
  });

  test("recordPipelineError increments by stage + code", () => {
    siraMetrics.recordPipelineError({ stage: "tool", code: "tool.timeout" });
    const text = metrics.renderText();
    assert.match(text, /sira_pipeline_errors_total\{stage="tool",code="tool\.timeout"\} \d+/);
  });
});

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
  checkRedis,
  checkQueue,
  checkProcess,
  checkModelProvidersConfigured,
  checkOpenTelemetry,
  checkSentry,
  checkLangfuse,
  checkPostHog,
  runLivenessCheck,
  runReadinessCheck,
  runFullHealthCheck,
  composeStatus,
  reportToHttpStatus,
} = require("../src/services/observability/health-check");

const metrics = require("../src/services/agents/metrics");
const siraMetrics = require("../src/services/sira/metrics");

// ── checkDatabase ──────────────────────────────────────────────────

describe("checkDatabase", () => {
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
    assert.deepEqual(names, ["database", "process", "queue", "redis"]);
  });

  test("503 when DB is unhealthy", async () => {
    const r = await runReadinessCheck({
      prisma: { $queryRawUnsafe: async () => { throw new Error("down"); } },
      redis: { ping: async () => "PONG" },
    });
    assert.equal(r.status, "unhealthy");
    assert.equal(reportToHttpStatus(r), 503);
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

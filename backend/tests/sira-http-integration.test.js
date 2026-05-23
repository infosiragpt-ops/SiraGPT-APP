/**
 * sira-http-integration — boots a minimal Express app in-process, fires
 * real HTTP requests, and asserts the contract the chat pipeline gives
 * to clients.
 *
 * This is the "vertical" coverage layer that complements the per-module
 * unit tests: it catches things only Express's actual request lifecycle
 * exposes — middleware ordering, error-handler activation, header
 * propagation, status code mapping, JSON shape after serialization.
 *
 * Closes part of gap §14.4 in docs/architecture/PIPELINE.md (the HTTP-
 * level slice). Browser-level Playwright coverage of the full chat →
 * upload → RAG → stream → citation flow is a separate, larger effort.
 *
 * No external deps (no supertest, no nock). Uses only `http` from the
 * Node stdlib so the test inherits the same dependency surface as CI.
 */

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const pinoHttp = require("pino-http");
const pino = require("pino");

const { requestIdMiddleware, HEADER: REQUEST_ID_HEADER } = require("../src/middleware/request-id");
const {
  IngressError,
  ToolError,
  siraErrorHandler,
  toAuditPayload,
} = require("../src/services/sira/pipeline-errors");
const {
  runLivenessCheck,
  runReadinessCheck,
  runFullHealthCheck,
  reportToHttpStatus,
} = require("../src/services/observability/health-check");
const metrics = require("../src/services/agents/metrics");
require("../src/services/sira/metrics"); // side-effect: register sira families
const { handleChatTurn } = require("../src/services/sira/chat-controller");
const { createSiraStorage, createInMemoryStorage } = require("../src/services/sira/storage-schema");
const { createDefaultRegistry } = require("../src/services/sira/tool-registry");

// ── Test harness: mount only what we need for the assertions ──────

function buildTestApp({ storage }) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Mirror the production middleware/logger.js config: silent logger
  // (clean test output) but the SAME genReqId so an upstream-supplied
  // `x-request-id` is honored exactly as it is in prod. Without this
  // pino-http defaults to an auto-incrementing counter and the
  // request-id propagation tests would race.
  const silent = pino({ level: "silent" });
  const { randomUUID } = require("node:crypto");
  app.use(pinoHttp({
    logger: silent,
    genReqId: (req) => req.headers["x-request-id"] || randomUUID(),
  }));
  app.use(requestIdMiddleware);

  // Healthy probe routes (uses fakes so the test is offline-safe).
  app.get("/health/live", (_req, res) => {
    const r = runLivenessCheck();
    res.status(reportToHttpStatus(r)).json(r);
  });
  app.get("/health/ready", async (_req, res) => {
    const r = await runReadinessCheck({
      prisma: { $queryRawUnsafe: async () => 1 },
      redis: { ping: async () => "PONG" },
    });
    res.status(reportToHttpStatus(r)).json(r);
  });
  app.get("/health", async (_req, res) => {
    const r = await runFullHealthCheck({
      prisma: { $queryRawUnsafe: async () => 1 },
      redis: { ping: async () => "PONG" },
    });
    res.status(reportToHttpStatus(r)).json(r);
  });

  app.get("/metrics", (_req, res) => {
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(metrics.renderText());
  });

  // Live chat route — exercises the controller with a real request.
  app.post("/api/test/chat", async (req, res, next) => {
    try {
      const r = await handleChatTurn({
        conversationId: req.body.conversationId,
        userId: req.body.userId,
        userMessage: req.body.userMessage,
        selectedModel: req.body.selectedModel,
        userPlan: req.body.userPlan,
        requestId: req.requestId,
        bypassSessionQueue: true,
      }, { storage, registry: createDefaultRegistry() });
      res.json(r);
    } catch (err) {
      next(err);
    }
  });

  // Demo route that throws a tagged error so we can assert the
  // siraErrorHandler contract.
  app.get("/api/test/throw-tagged", (req, _res) => {
    throw new ToolError({
      code: "tool.timeout",
      message: "tool x exceeded timeout",
      details: { tool: "docx_generator", api_key: "sk-leak" },
      requestId: req.requestId,
    });
  });

  // Demo route that throws a plain Error (the handler should still
  // wrap it into a 500 SiraPipelineError).
  app.get("/api/test/throw-plain", (_req, _res) => {
    throw new Error("kaboom from third-party lib");
  });

  app.use(siraErrorHandler);
  return app;
}

function startServer(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function fetchJson(baseUrl, path, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        method, hostname: url.hostname, port: url.port, path: url.pathname + url.search,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Suite ──────────────────────────────────────────────────────────

describe("HTTP integration: middleware + error handler + health + metrics", () => {
  let server, baseUrl, storage;

  before(async () => {
    storage = createSiraStorage({ adapter: createInMemoryStorage() });
    const app = buildTestApp({ storage });
    ({ server, baseUrl } = await startServer(app));
  });
  after(async () => { await closeServer(server); });

  test("X-Request-Id header is set on every response", async () => {
    const r = await fetchJson(baseUrl, "/health/live");
    assert.equal(r.status, 200);
    assert.ok(r.headers["x-request-id"], "X-Request-Id should be present");
  });

  test("X-Request-Id is echoed verbatim when client supplies it", async () => {
    const r = await fetchJson(baseUrl, "/health/live", { headers: { "x-request-id": "custom-trace-001" } });
    assert.equal(r.headers["x-request-id"], "custom-trace-001");
  });

  test("/health/live always returns 200 with a process check", async () => {
    const r = await fetchJson(baseUrl, "/health/live");
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "healthy");
    assert.ok(r.body.checks.find((c) => c.name === "process"));
  });

  test("/health/ready aggregates db + redis + queue + process and returns 200", async () => {
    const r = await fetchJson(baseUrl, "/health/ready");
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "healthy");
    const names = r.body.checks.map((c) => c.name).sort();
    assert.deepEqual(names, ["database", "process", "queue", "redis"]);
  });

  test("/health includes informational model_providers check", async () => {
    const r = await fetchJson(baseUrl, "/health");
    assert.equal(r.status, 200);
    assert.ok(r.body.checks.find((c) => c.name === "model_providers"));
  });

  test("/metrics renders Prometheus text with sira_chat_turns_total inventory", async () => {
    const r = await fetchJson(baseUrl, "/metrics");
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"], /text\/plain/);
    assert.match(String(r.raw), /# TYPE sira_chat_turns_total counter/);
    assert.match(String(r.raw), /# TYPE sira_chat_turn_duration_ms histogram/);
  });
});

describe("HTTP integration: tagged error handler", () => {
  let server, baseUrl;

  before(async () => {
    const app = buildTestApp({ storage: createSiraStorage({ adapter: createInMemoryStorage() }) });
    ({ server, baseUrl } = await startServer(app));
  });
  after(async () => { await closeServer(server); });

  test("ToolError → 502 with code/stage/request_id and redacted details", async () => {
    const r = await fetchJson(baseUrl, "/api/test/throw-tagged", { headers: { "x-request-id": "req-error-001" } });
    assert.equal(r.status, 502);
    assert.equal(r.body.error.code, "tool.timeout");
    assert.equal(r.body.error.stage, "tool");
    assert.equal(r.body.error.request_id, "req-error-001");
    assert.equal(r.body.error.details.tool, "docx_generator");
    // PII redaction kicked in: api_key never reaches the wire.
    assert.equal(r.body.error.details.api_key, "[redacted]");
    assert.equal(r.headers["x-request-id"], "req-error-001");
  });

  test("plain Error → 500 wrapped in pipeline-error contract", async () => {
    const r = await fetchJson(baseUrl, "/api/test/throw-plain");
    assert.equal(r.status, 500);
    assert.equal(r.body.error.stage, "pre_pipeline");
    assert.ok(r.body.error.request_id, "request_id should still be attached");
  });
});

describe("HTTP integration: chat-controller end-to-end", () => {
  let server, baseUrl, storage, audits;

  before(async () => {
    storage = createSiraStorage({ adapter: createInMemoryStorage() });
    audits = [];
    const realAudit = storage.audit.bind(storage);
    storage.audit = async (event, payload, meta) => {
      audits.push({ event, meta });
      return realAudit(event, payload, meta);
    };
    const app = buildTestApp({ storage });
    ({ server, baseUrl } = await startServer(app));
  });
  after(async () => { await closeServer(server); });

  test("POST chat returns frames + request_id + the same id appears in audits", async () => {
    const r = await fetchJson(baseUrl, "/api/test/chat", {
      method: "POST",
      headers: { "x-request-id": "trace-chat-end-to-end" },
      body: {
        conversationId: "conv-int-1",
        userId: "user-int-1",
        userMessage: "Necesito un resumen breve.",
        selectedModel: { provider: "openai", modelId: "gpt-4o-mini" },
        userPlan: "FREE",
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers["x-request-id"], "trace-chat-end-to-end");
    assert.equal(r.body.request_id, "trace-chat-end-to-end");
    // Pre- and post-envelope audits all carry the same id.
    const turnStarted = audits.find((a) => a.event === "turn_started");
    assert.equal(turnStarted.meta.requestId, "trace-chat-end-to-end");
  });

  test("POST chat with missing field → IngressError contract on the wire", async () => {
    const r = await fetchJson(baseUrl, "/api/test/chat", {
      method: "POST",
      body: {
        conversationId: "conv-int-2",
        // userId missing
        userMessage: "x",
        selectedModel: { provider: "openai", modelId: "gpt-4o-mini" },
      },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "ingress.missing_identity");
    assert.equal(r.body.error.stage, "ingress");
  });

  test("toAuditPayload is consumable by audit log without raw prompt leak", () => {
    const err = new IngressError({
      code: "ingress.invalid_request",
      message: "missing field",
      requestId: "req-aud-1",
      details: { user_message: "actual user words", field: "x" },
    });
    const payload = toAuditPayload(err);
    assert.equal(payload.code, "ingress.invalid_request");
    assert.equal(payload.stage, "ingress");
    assert.equal(payload.request_id, "req-aud-1");
    // user_message is sensitive — must be redacted in audit too.
    assert.equal(payload.details.user_message, "[redacted]");
    assert.equal(payload.details.field, "x");
    // The human message is intentionally absent from audit payloads.
    assert.equal(payload.message, undefined);
  });
});

/**
 * sira-sse-route — verifies the SSE detection + streaming path that
 * mirrors the production handler in routes/enterprise.js. We build a
 * focused in-process Express app so the test runs offline (no auth
 * middleware, no Prisma) but exercises the same route logic.
 *
 * Closes task 26.
 */

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const pinoHttp = require("pino-http");
const pino = require("pino");
const { randomUUID } = require("node:crypto");

const { requestIdMiddleware } = require("../src/middleware/request-id");
const turnEvents = require("../src/services/sira/turn-events");
const { handleChatTurn } = require("../src/services/sira/chat-controller");
const { createSiraStorage, createInMemoryStorage } = require("../src/services/sira/storage-schema");
const { createDefaultRegistry } = require("../src/services/sira/tool-registry");

// ── In-process app that mirrors the production /sira/chat route ───

function buildTestApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const silent = pino({ level: "silent" });
  app.use(pinoHttp({
    logger: silent,
    genReqId: (req) => req.headers["x-request-id"] || randomUUID(),
  }));
  app.use(requestIdMiddleware);

  app.post("/sira/chat", async (req, res) => {
    const acceptsSSE =
      typeof req.headers.accept === "string" &&
      req.headers.accept.toLowerCase().includes("text/event-stream");
    const events = acceptsSSE
      ? turnEvents.createSSEEvents(res, { requestId: req.requestId })
      : turnEvents.createNoOpEvents();

    const storage = createSiraStorage({ adapter: createInMemoryStorage() });
    try {
      const r = await handleChatTurn({
        conversationId: req.body.conversation_id,
        userId: req.body.user_id || "anonymous",
        userMessage: req.body.user_message,
        selectedModel: req.body.selected_model,
        userPlan: req.body.user_plan || "FREE",
        requestId: req.requestId,
        mode: req.body.mode || null,
        bypassSessionQueue: true,
      }, { storage, registry: createDefaultRegistry(), events });
      if (!acceptsSSE) res.json(r);
    } catch (err) {
      if (acceptsSSE) {
        try {
          events.emit("error", { code: err.code || "fail", message: String(err.message).slice(0, 200) });
          events.end();
        } catch {}
      } else {
        res.status(500).json({ error: { message: err.message } });
      }
    }
  });

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
function closeServer(server) { return new Promise((r) => server.close(() => r())); }

function fetchRaw(baseUrl, path, { method = "GET", headers = {}, body = null, drain = true } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        method, hostname: url.hostname, port: url.port, path: url.pathname,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        if (!drain) return resolve({ res });
        const chunks = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => resolve({
          status: res.statusCode,
          headers: res.headers,
          raw: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const baseBody = {
  conversation_id: "conv-sse",
  user_id: "user-sse",
  user_message: "Resúmeme algo breve.",
  selected_model: { provider: "openai", modelId: "gpt-4o-mini" },
};

// ── Suite ──────────────────────────────────────────────────────────

describe("/sira/chat SSE route", () => {
  let server, baseUrl;
  before(async () => { ({ server, baseUrl } = await startServer(buildTestApp())); });
  after(async () => { await closeServer(server); });

  test("Accept: text/event-stream → SSE response with the right headers", async () => {
    const r = await fetchRaw(baseUrl, "/sira/chat", {
      method: "POST",
      headers: { "Accept": "text/event-stream", "x-request-id": "req-sse-route-1" },
      body: baseBody,
    });
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"], /text\/event-stream/);
    assert.equal(r.headers["cache-control"], "no-cache");
    assert.equal(r.headers["connection"], "keep-alive");
    // Body is the SSE event stream.
    assert.match(r.raw, /event: turn_started/);
    assert.match(r.raw, /event: token_budget_checked/);
    assert.match(r.raw, /event: envelope_built/);
    assert.match(r.raw, /event: chat_mode_resolved/);
    assert.match(r.raw, /"request_id":"req-sse-route-1"/);
    // Stream terminates with the synthetic _end marker.
    assert.match(r.raw, /event: _end/);
  });

  test("Accept: application/json → traditional JSON response (no SSE)", async () => {
    const r = await fetchRaw(baseUrl, "/sira/chat", {
      method: "POST",
      headers: { "Accept": "application/json", "x-request-id": "req-json-1" },
      body: baseBody,
    });
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"], /application\/json/);
    let body;
    try { body = JSON.parse(r.raw); } catch { throw new Error("expected JSON body"); }
    assert.ok(body.stage, "JSON body should carry the controller stage");
    assert.equal(body.request_id, "req-json-1");
  });

  test("missing Accept header → JSON response (default)", async () => {
    // Many existing clients don't set Accept. Default behaviour must
    // be the legacy JSON path so backwards compatibility is preserved.
    const r = await fetchRaw(baseUrl, "/sira/chat", {
      method: "POST",
      headers: { "x-request-id": "req-default-1" },
      body: baseBody,
    });
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"], /application\/json/);
  });

  test("Accept lists multiple types including text/event-stream → SSE wins", async () => {
    const r = await fetchRaw(baseUrl, "/sira/chat", {
      method: "POST",
      headers: { "Accept": "application/json, text/event-stream;q=0.9", "x-request-id": "req-mixed-1" },
      body: baseBody,
    });
    assert.match(r.headers["content-type"], /text\/event-stream/);
    assert.match(r.raw, /event: turn_started/);
    assert.match(r.raw, /event: _end/);
  });

  test("X-Request-Id is echoed on both SSE and JSON paths", async () => {
    const sse = await fetchRaw(baseUrl, "/sira/chat", {
      method: "POST",
      headers: { "Accept": "text/event-stream", "x-request-id": "req-corr-sse" },
      body: baseBody,
    });
    const json = await fetchRaw(baseUrl, "/sira/chat", {
      method: "POST",
      headers: { "x-request-id": "req-corr-json" },
      body: baseBody,
    });
    assert.equal(sse.headers["x-request-id"], "req-corr-sse");
    assert.equal(json.headers["x-request-id"], "req-corr-json");
  });
});

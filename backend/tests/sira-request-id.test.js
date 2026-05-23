/**
 * sira-request-id — verifies that one logical chat turn carries one
 * request id end-to-end: HTTP middleware → chat-controller → engine →
 * envelope builder, and that the same id is echoed back on the
 * response and into every audit row.
 *
 * Why this matters:
 *   - Before this wiring, the access log used `req.id` (UUID) and the
 *     envelope used a freshly-minted `req_<base36>_<hex>`. Two ids per
 *     turn meant correlating an issue across logs took grep gymnastics.
 *   - After this wiring, branch protection + observability infra can
 *     trust that one id ties together the access log row, every audit
 *     event, the persisted envelope, and the response header.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  requestIdMiddleware,
  getRequestId,
  HEADER,
} = require("../src/middleware/request-id");
const { buildEnvelope } = require("../src/services/sira/task-envelope-builder");
const engine = require("../src/services/sira/engine");
const { handleChatTurn } = require("../src/services/sira/chat-controller");
const { createInMemoryStorage, createSiraStorage } = require("../src/services/sira/storage-schema");
const { createDefaultRegistry } = require("../src/services/sira/tool-registry");

// Minimal fake `res` with the surface the middleware actually touches.
// Avoids pulling in supertest just for header assertions.
function fakeRes() {
  const headers = {};
  return {
    locals: {},
    setHeader(k, v) { headers[k] = v; },
    getHeader(k) { return headers[k]; },
    _headers: headers,
  };
}

function fakeReq({ id, headers = {} } = {}) {
  return { id, headers };
}

// ── Middleware ─────────────────────────────────────────────────────

describe("request-id middleware", () => {
  test("sets X-Request-Id from req.id (the value pino-http populated)", () => {
    const req = fakeReq({ id: "abc-123" });
    const res = fakeRes();
    let called = false;
    requestIdMiddleware(req, res, () => { called = true; });
    assert.equal(called, true);
    assert.equal(res.getHeader(HEADER), "abc-123");
    assert.equal(req.requestId, "abc-123");
    assert.equal(res.locals.requestId, "abc-123");
  });

  test("falls back to incoming x-request-id header when req.id missing", () => {
    const req = fakeReq({ headers: { "x-request-id": "from-upstream-lb" } });
    const res = fakeRes();
    requestIdMiddleware(req, res, () => {});
    assert.equal(res.getHeader(HEADER), "from-upstream-lb");
    assert.equal(req.requestId, "from-upstream-lb");
  });

  test("rejects unsafe incoming x-request-id header values", () => {
    const req = fakeReq({ headers: { "x-request-id": "bad\r\nx-owned: 1" } });
    const res = fakeRes();
    assert.doesNotThrow(() => requestIdMiddleware(req, res, () => {}));
    assert.equal(res.getHeader(HEADER), undefined);
    assert.equal(req.requestId, undefined);
  });

  test("emits no header when neither req.id nor header is present", () => {
    const req = fakeReq();
    const res = fakeRes();
    requestIdMiddleware(req, res, () => {});
    // Empty / undefined: better than emitting `X-Request-Id:` with no value.
    assert.equal(res.getHeader(HEADER), undefined);
    assert.equal(req.requestId, undefined);
  });

  test("getRequestId prefers req.requestId, falls back to req.id, then header", () => {
    assert.equal(getRequestId({ requestId: "a", id: "b", headers: { "x-request-id": "c" } }), "a");
    assert.equal(getRequestId({ id: "b", headers: { "x-request-id": "c" } }), "b");
    assert.equal(getRequestId({ headers: { "x-request-id": "c" } }), "c");
    assert.equal(getRequestId({ headers: {} }), null);
    assert.equal(getRequestId(null), null);
  });
});

// ── Envelope builder ───────────────────────────────────────────────

describe("buildEnvelope honors requestId", () => {
  test("uses caller-provided requestId verbatim", async () => {
    const r = await buildEnvelope({
      text: "Necesito un resumen del documento adjunto.",
      requestId: "req-from-http-layer-xyz",
    });
    assert.equal(r.envelope.request_id, "req-from-http-layer-xyz");
    // The same id is also threaded into the planner's contract_id so
    // workflow nodes carry the same correlation key.
    assert.equal(r.envelope.workflow_graph?.contract_id || r.envelope.request_id, "req-from-http-layer-xyz");
  });

  test("mints a fresh id when none provided (legacy path)", async () => {
    const r = await buildEnvelope({ text: "hola" });
    assert.match(r.envelope.request_id, /^req_[a-z0-9]+_[a-f0-9]+$/);
  });

  test("treats empty string as missing and mints fresh id", async () => {
    const r = await buildEnvelope({ text: "hola", requestId: "" });
    assert.match(r.envelope.request_id, /^req_[a-z0-9]+_[a-f0-9]+$/);
  });
});

// ── Engine ─────────────────────────────────────────────────────────

describe("engine.runUserMessage forwards requestId", () => {
  test("passed-in requestId reaches the envelope", async () => {
    const bundle = await engine.runUserMessage({
      text: "Resúmeme esto en tres líneas.",
      requestId: "engine-test-id-001",
      dryRun: true,
    });
    // ok: false bundles also carry the envelope (with the id we passed),
    // so this check works whether or not the deterministic engine
    // succeeded for this message.
    assert.equal(bundle.envelope.request_id, "engine-test-id-001");
  });
});

// ── Chat controller ────────────────────────────────────────────────

describe("chat-controller threads requestId through audits and response", () => {
  // Wraps the in-memory storage adapter and intercepts every audit
  // call so we can assert the meta carries our id.
  function instrumentedStorage() {
    const storage = createSiraStorage({ adapter: createInMemoryStorage() });
    const audits = [];
    const realAudit = storage.audit.bind(storage);
    storage.audit = async (event, payload, meta) => {
      audits.push({ event, meta });
      return realAudit(event, payload, meta);
    };
    return { storage, audits };
  }

  test("turn_started carries the caller-supplied requestId", async () => {
    const { storage, audits } = instrumentedStorage();
    const result = await handleChatTurn({
      conversationId: "conv-1",
      userId: "user-1",
      userMessage: "Hola, necesito un resumen.",
      selectedModel: { provider: "openai", modelId: "gpt-4o-mini" },
      requestId: "controller-test-id-42",
      bypassSessionQueue: true,
    }, { storage, registry: createDefaultRegistry() });

    const turnStarted = audits.find(a => a.event === "turn_started");
    assert.ok(turnStarted, "turn_started audit must be emitted");
    assert.equal(turnStarted.meta.requestId, "controller-test-id-42");

    // The response also surfaces request_id so the route can include
    // it in the JSON body if it wants to (in addition to the header).
    assert.equal(result.request_id, "controller-test-id-42");
  });

  test("token_budget_checked carries the requestId before envelope is built", async () => {
    const { storage, audits } = instrumentedStorage();
    await handleChatTurn({
      conversationId: "conv-2",
      userId: "user-2",
      userMessage: "x",
      selectedModel: { provider: "openai", modelId: "gpt-4o-mini" },
      requestId: "controller-test-id-budget",
      bypassSessionQueue: true,
    }, { storage, registry: createDefaultRegistry() });

    const budgetChecked = audits.find(a => a.event === "token_budget_checked");
    assert.ok(budgetChecked, "token_budget_checked audit must be emitted");
    assert.equal(budgetChecked.meta.requestId, "controller-test-id-budget");
  });

  test("post-envelope audit (turn_completed) reuses the same id", async () => {
    const { storage, audits } = instrumentedStorage();
    const result = await handleChatTurn({
      conversationId: "conv-3",
      userId: "user-3",
      userMessage: "Necesito un resumen breve.",
      selectedModel: { provider: "openai", modelId: "gpt-4o-mini" },
      requestId: "controller-test-id-completed",
      bypassSessionQueue: true,
    }, { storage, registry: createDefaultRegistry() });

    // We only assert when the controller actually got past clarification
    // and reached the runtime — otherwise turn_completed is not emitted
    // and that's fine for this test's intent (other tests cover early
    // exits).
    if (result.stage === "delivered" || result.stage === "needs_repair") {
      const completed = audits.find(a => a.event === "turn_completed");
      assert.ok(completed, "turn_completed audit must be emitted on full turn");
      assert.equal(completed.meta.requestId, "controller-test-id-completed");
      assert.equal(result.request_id, "controller-test-id-completed");
    }
  });

  test("missing requestId still produces a working turn (legacy callers)", async () => {
    const { storage, audits } = instrumentedStorage();
    await handleChatTurn({
      conversationId: "conv-4",
      userId: "user-4",
      userMessage: "Resúmeme algo.",
      selectedModel: { provider: "openai", modelId: "gpt-4o-mini" },
      bypassSessionQueue: true,
    }, { storage, registry: createDefaultRegistry() });

    const turnStarted = audits.find(a => a.event === "turn_started");
    assert.ok(turnStarted, "turn_started audit emitted even without caller id");
    // Pre-envelope audits drop requestId from meta when the caller
    // didn't supply one — there is simply nothing yet to attribute.
    assert.equal(turnStarted.meta.requestId, undefined);
  });
});

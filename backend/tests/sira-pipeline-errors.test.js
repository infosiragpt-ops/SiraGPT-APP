/**
 * sira-pipeline-errors — verifies the stage-aware error taxonomy:
 * subclass shape, wrapping idempotency, HTTP/audit serialization,
 * PII redaction, and the Express handler integration.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  STAGES,
  SiraPipelineError,
  IngressError,
  BudgetError,
  EnvelopeError,
  PolicyError,
  ContextError,
  RAGError,
  ToolError,
  ValidatorError,
  StreamError,
  StorageError,
  STAGE_TO_CLASS,
  wrapAsSiraError,
  redactDetails,
  toHttpResponse,
  toAuditPayload,
  siraErrorHandler,
} = require("../src/services/sira/pipeline-errors");

// ── Stages constant ────────────────────────────────────────────────

describe("STAGES list", () => {
  test("matches PIPELINE.md §3 stages and pre_pipeline fallback", () => {
    assert.deepEqual(STAGES, [
      "ingress", "token_budget", "envelope", "policy",
      "context", "rag", "tool", "validator", "stream", "storage",
      "pre_pipeline",
    ]);
  });

  test("STAGE_TO_CLASS covers every named pipeline stage", () => {
    for (const stage of STAGES.filter((s) => s !== "pre_pipeline")) {
      assert.ok(STAGE_TO_CLASS[stage], `missing class for stage ${stage}`);
      assert.equal(STAGE_TO_CLASS[stage].STAGE, stage);
    }
  });
});

// ── Subclass shape ─────────────────────────────────────────────────

describe("SiraPipelineError base class", () => {
  test("captures code, stage, message, requestId, http status, retryable", () => {
    const err = new IngressError({
      code: "ingress.invalid_request",
      message: "missing user_message",
      requestId: "req-001",
      details: { field: "user_message" },
      retryable: false,
    });
    assert.equal(err.name, "IngressError");
    assert.equal(err.code, "ingress.invalid_request");
    assert.equal(err.stage, "ingress");
    assert.equal(err.message, "missing user_message");
    assert.equal(err.requestId, "req-001");
    assert.equal(err.httpStatus, 400);
    assert.equal(err.retryable, false);
    assert.deepEqual(err.details, { field: "user_message" });
    assert.ok(err instanceof SiraPipelineError);
    assert.ok(err instanceof Error);
  });

  test("each subclass has its own stage and default HTTP status", () => {
    const cases = [
      [IngressError, "ingress", 400],
      [BudgetError, "token_budget", 429],
      [EnvelopeError, "envelope", 422],
      [PolicyError, "policy", 451],
      [ContextError, "context", 500],
      [RAGError, "rag", 502],
      [ToolError, "tool", 502],
      [ValidatorError, "validator", 422],
      [StreamError, "stream", 500],
      [StorageError, "storage", 500],
    ];
    for (const [Cls, stage, status] of cases) {
      const e = new Cls({ code: `${stage}.test`, message: "x" });
      assert.equal(e.stage, stage, `${Cls.name}.stage`);
      assert.equal(e.httpStatus, status, `${Cls.name}.httpStatus`);
    }
  });

  test("constructor allows httpStatus override", () => {
    const e = new ToolError({ code: "tool.unauthorized", message: "x", httpStatus: 403 });
    assert.equal(e.httpStatus, 403);
    assert.equal(e.stage, "tool");
  });

  test("toJSON returns plain object safe to stringify", () => {
    const cause = new Error("boom from underlying lib");
    const err = new ToolError({
      code: "tool.timeout", message: "tool x exceeded timeout",
      requestId: "req-99", details: { tool: "docx_generator" }, cause, retryable: true,
    });
    const json = err.toJSON();
    assert.equal(json.name, "ToolError");
    assert.equal(json.code, "tool.timeout");
    assert.equal(json.stage, "tool");
    assert.equal(json.request_id, "req-99");
    assert.equal(json.retryable, true);
    assert.equal(json.cause.message, "boom from underlying lib");
    // toJSON stays JSON-serializable end to end.
    assert.doesNotThrow(() => JSON.stringify(json));
  });
});

// ── wrapAsSiraError ────────────────────────────────────────────────

describe("wrapAsSiraError", () => {
  test("returns SiraPipelineError instances untouched", () => {
    const original = new EnvelopeError({ code: "envelope.invalid", message: "x" });
    const wrapped = wrapAsSiraError(original);
    assert.equal(wrapped, original, "should be the same instance");
  });

  test("attaches a missing requestId to a tagged error", () => {
    const original = new EnvelopeError({ code: "envelope.invalid", message: "x" });
    const wrapped = wrapAsSiraError(original, { requestId: "req-late-bind" });
    assert.equal(wrapped.requestId, "req-late-bind");
  });

  test("does not overwrite an already-set requestId", () => {
    const original = new EnvelopeError({ code: "envelope.invalid", message: "x", requestId: "req-original" });
    const wrapped = wrapAsSiraError(original, { requestId: "req-other" });
    assert.equal(wrapped.requestId, "req-original");
  });

  test("wraps a plain Error at the requested stage", () => {
    const inner = new Error("DB connection refused");
    const wrapped = wrapAsSiraError(inner, { stage: "storage", code: "storage.db_unreachable", requestId: "req-x" });
    assert.ok(wrapped instanceof StorageError);
    assert.equal(wrapped.code, "storage.db_unreachable");
    assert.equal(wrapped.cause, inner);
    assert.equal(wrapped.requestId, "req-x");
  });

  test("falls back to base SiraPipelineError when stage is unknown", () => {
    const wrapped = wrapAsSiraError("not even an Error", { stage: "weird_stage" });
    assert.ok(wrapped instanceof SiraPipelineError);
    assert.equal(wrapped.stage, "pre_pipeline");
  });
});

// ── PII redaction ──────────────────────────────────────────────────

describe("redactDetails", () => {
  test("redacts top-level sensitive keys", () => {
    const out = redactDetails({
      tool: "docx_generator",
      prompt: "Generate a contract for ACME",
      api_key: "sk-secret",
      message: "user content",
    });
    assert.equal(out.tool, "docx_generator");
    assert.equal(out.prompt, "[redacted]");
    assert.equal(out.api_key, "[redacted]");
    assert.equal(out.message, "[redacted]");
  });

  test("recurses into nested objects and arrays", () => {
    const out = redactDetails({
      ok: { fine: 1, history: [{ message: "hi", role: "user" }] },
      authorization: "Bearer xyz",
    });
    assert.equal(out.ok.fine, 1);
    assert.equal(out.ok.history, "[redacted]"); // history matched as a key
    assert.equal(out.authorization, "[redacted]");
  });

  test("redacts caller-extended keys", () => {
    const out = redactDetails({ tool: "x", custom_secret: "abc" }, { extraKeys: ["custom_secret"] });
    assert.equal(out.tool, "x");
    assert.equal(out.custom_secret, "[redacted]");
  });

  test("returns null untouched", () => {
    assert.equal(redactDetails(null), null);
  });
});

// ── HTTP / audit serialization ─────────────────────────────────────

describe("toHttpResponse / toAuditPayload", () => {
  test("toHttpResponse emits {status, body.error.{code,stage,...}}", () => {
    const err = new IngressError({
      code: "ingress.invalid_request", message: "missing field",
      requestId: "req-http", details: { field: "x", api_key: "should-be-hidden" },
    });
    const r = toHttpResponse(err);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "ingress.invalid_request");
    assert.equal(r.body.error.stage, "ingress");
    assert.equal(r.body.error.message, "missing field");
    assert.equal(r.body.error.request_id, "req-http");
    assert.equal(r.body.error.details.field, "x");
    assert.equal(r.body.error.details.api_key, "[redacted]");
  });

  test("toAuditPayload omits the human message and includes request_id", () => {
    const err = new BudgetError({
      code: "token_budget.exceeded", message: "user exceeded daily cap",
      requestId: "req-audit",
      details: { plan: "FREE", projected_tokens: 999999, prompt: "user message text" },
    });
    const p = toAuditPayload(err);
    assert.equal(p.code, "token_budget.exceeded");
    assert.equal(p.stage, "token_budget");
    assert.equal(p.request_id, "req-audit");
    assert.equal(p.http_status, 429);
    // Audit payload deliberately drops `message`.
    assert.equal(p.message, undefined);
    // PII keys are redacted even though the rest of the structure stays.
    assert.equal(p.details.plan, "FREE");
    assert.equal(p.details.prompt, "[redacted]");
  });
});

// ── Express handler ────────────────────────────────────────────────

describe("siraErrorHandler middleware", () => {
  function fakeRes() {
    const headers = {};
    let body = null;
    let status = null;
    return {
      _result: () => ({ status, body, headers }),
      setHeader(k, v) { headers[k] = v; },
      getHeader(k) { return headers[k]; },
      status(s) { status = s; return this; },
      json(b) { body = b; return this; },
    };
  }

  test("writes the pipeline-error contract and sets X-Request-Id", () => {
    const req = { requestId: "req-handler", log: { error() {} } };
    const res = fakeRes();
    const err = new IngressError({ code: "ingress.invalid_request", message: "bad input" });
    siraErrorHandler(err, req, res, () => {});
    const r = res._result();
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "ingress.invalid_request");
    assert.equal(r.body.error.request_id, "req-handler");
    assert.equal(r.headers["X-Request-Id"], "req-handler");
  });

  test("wraps non-Sira errors into a 500 SiraPipelineError shape", () => {
    const req = { id: "req-fallback", log: { error() {} } };
    const res = fakeRes();
    siraErrorHandler(new Error("kaboom"), req, res, () => {});
    const r = res._result();
    assert.equal(r.status, 500);
    assert.equal(r.body.error.stage, "pre_pipeline");
    assert.equal(r.body.error.request_id, "req-fallback");
  });

  test("does not overwrite an already-set X-Request-Id", () => {
    const req = { requestId: "req-set-after", log: { error() {} } };
    const res = fakeRes();
    res.setHeader("X-Request-Id", "set-by-middleware");
    siraErrorHandler(new IngressError({ code: "x.y", message: "z" }), req, res, () => {});
    assert.equal(res._result().headers["X-Request-Id"], "set-by-middleware");
  });
});

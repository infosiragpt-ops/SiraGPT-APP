/**
 * sira-turn-events — verifies the three event sinks and their
 * boundaries: no-op, buffered (test fixture), SSE (HTTP response).
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");

const {
  EVENT_NAMES,
  createNoOpEvents,
  createBufferedEvents,
  createSSEEvents,
} = require("../src/services/sira/turn-events");

// ── EVENT_NAMES ───────────────────────────────────────────────────

describe("EVENT_NAMES", () => {
  test("includes the canonical events the chat-controller emits", () => {
    for (const expected of [
      "turn_started", "token_budget_checked", "turn_blocked_token_budget",
      "project_context_loaded", "project_access_denied",
      "envelope_built", "envelope_invalid",
      "chat_mode_resolved", "context_compacted",
      "clarification_requested",
      "brain_pipeline_started", "brain_pipeline_completed", "brain_pipeline_error",
      "runtime_completed",
      "citation_frame_built", "turn_completed",
    ]) {
      assert.ok(EVENT_NAMES.includes(expected), `${expected} missing`);
    }
  });
});

// ── No-op sink ────────────────────────────────────────────────────

describe("createNoOpEvents", () => {
  test("emit and end are silent and never throw", () => {
    const e = createNoOpEvents();
    e.emit("anything", { x: 1 });
    e.end();
    assert.equal(e.isLive(), false);
  });
});

// ── Buffered sink ─────────────────────────────────────────────────

describe("createBufferedEvents", () => {
  test("captures every emit with timestamps", () => {
    const e = createBufferedEvents();
    e.emit("turn_started", { request_id: "req-1" });
    e.emit("envelope_built", { request_id: "req-1", intent: "summary" });
    assert.equal(e.events.length, 2);
    assert.equal(e.events[0].name, "turn_started");
    assert.equal(e.events[0].data.request_id, "req-1");
    assert.ok(Number.isFinite(e.events[0].ts));
  });

  test("end() appends _end marker and freezes the stream", () => {
    const e = createBufferedEvents();
    e.emit("turn_started", {});
    e.end();
    e.emit("after_end", {}); // should be ignored
    assert.equal(e.events.find((x) => x.name === "after_end"), undefined);
    assert.equal(e.events.find((x) => x.name === "_end").name, "_end");
    assert.equal(e.isLive(), false);
  });

  test(".by(name) filters by event name", () => {
    const e = createBufferedEvents();
    e.emit("turn_started", { i: 1 });
    e.emit("envelope_built", { i: 2 });
    e.emit("turn_started", { i: 3 });
    assert.equal(e.by("turn_started").length, 2);
    assert.equal(e.by("envelope_built").length, 1);
  });

  test("captures safe brain pipeline events", () => {
    const e = createBufferedEvents();
    e.emit("brain_pipeline_started", { request_id: "req-brain", plan_step_count: 2 });
    e.emit("brain_pipeline_completed", {
      request_id: "req-brain",
      decision: "repair",
      blocking_flags: 1,
      warning_flags: 0,
      reason_count: 1,
      repair_hint_count: 1,
      latency_ms: 3,
    });
    e.emit("brain_pipeline_error", {
      request_id: "req-brain",
      decision: "ship",
      error_code: "brain_pipeline_error",
    });

    assert.equal(e.by("brain_pipeline_started").length, 1);
    assert.equal(e.by("brain_pipeline_completed")[0].data.decision, "repair");
    assert.equal(e.by("brain_pipeline_error")[0].data.error_code, "brain_pipeline_error");
  });

  test("survives null/undefined data (no crash)", () => {
    const e = createBufferedEvents();
    e.emit("turn_started");
    e.emit("envelope_built", null);
    assert.equal(e.events.length, 2);
    assert.equal(e.events[0].data, null);
  });
});

// ── SSE sink ──────────────────────────────────────────────────────

describe("createSSEEvents", () => {
  function makeFakeRes() {
    const stream = new PassThrough();
    const headers = {};
    let ended = false;
    return {
      stream, headers,
      headersSent: false,
      setHeader(k, v) { headers[k] = v; },
      flushHeaders() {},
      write(chunk) { stream.write(chunk); },
      end() { ended = true; stream.end(); },
      _ended: () => ended,
    };
  }

  function readAll(stream) {
    return new Promise((resolve) => {
      const chunks = [];
      stream.on("data", (c) => chunks.push(Buffer.from(c)));
      stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
  }

  test("writes SSE-shaped event + data lines and the right headers", async () => {
    const res = makeFakeRes();
    const reader = readAll(res.stream);
    const e = createSSEEvents(res, { requestId: "req-sse" });
    e.emit("turn_started", { conversation_id: "c1" });
    e.emit("envelope_built", { intent: "summary" });
    e.end();
    const text = await reader;

    assert.equal(res.headers["Content-Type"], "text/event-stream");
    assert.equal(res.headers["Cache-Control"], "no-cache");
    assert.equal(res.headers["Connection"], "keep-alive");
    assert.equal(res.headers["X-Accel-Buffering"], "no");

    assert.match(text, /event: turn_started/);
    assert.match(text, /event: envelope_built/);
    assert.match(text, /"request_id":"req-sse"/);
    assert.match(text, /"intent":"summary"/);
    assert.match(text, /event: _end/);
    assert.equal(res._ended(), true);
  });

  test("end() is idempotent — second call is a no-op", async () => {
    const res = makeFakeRes();
    const e = createSSEEvents(res);
    e.end();
    e.end();
    assert.equal(e.isLive(), false);
  });

  test("emit after end is dropped", async () => {
    const res = makeFakeRes();
    const reader = readAll(res.stream);
    const e = createSSEEvents(res);
    e.end();
    e.emit("late", { ignored: true });
    const text = await reader;
    assert.doesNotMatch(text, /event: late/);
  });

  test("explicit request_id on data wins over the constructor default", async () => {
    const res = makeFakeRes();
    const reader = readAll(res.stream);
    const e = createSSEEvents(res, { requestId: "default-id" });
    e.emit("envelope_built", { request_id: "explicit-id", x: 1 });
    e.end();
    const text = await reader;
    assert.match(text, /"request_id":"explicit-id"/);
    assert.doesNotMatch(text, /"request_id":"default-id".*"x":1/);
  });

  test("non-serializable payload is replaced with an error envelope, not dropped silently", async () => {
    const res = makeFakeRes();
    const reader = readAll(res.stream);
    const e = createSSEEvents(res);
    const circular = {};
    circular.self = circular;
    e.emit("turn_started", circular);
    e.end();
    const text = await reader;
    assert.match(text, /unserializable_payload/);
  });

  test("rejects a non-writable response", () => {
    assert.throws(() => createSSEEvents(null), /writable Node response/);
    assert.throws(() => createSSEEvents({}), /writable Node response/);
  });

  test("onEnd callback fires once after end()", () => {
    const res = makeFakeRes();
    let called = 0;
    const e = createSSEEvents(res, { onEnd: () => { called++; } });
    e.emit("turn_started", {});
    e.end();
    e.end();
    assert.equal(called, 1);
  });
});

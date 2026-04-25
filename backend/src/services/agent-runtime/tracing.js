"use strict";

const crypto = require("crypto");

const DEFAULT_REDACT_KEYS = new Set([
  "apiKey",
  "api_key",
  "authorization",
  "Authorization",
  "password",
  "token",
  "secret",
]);

function createTrace({ runId = null, correlationId = null, metadata = {} } = {}) {
  const trace = {
    run_id: runId || `run_${crypto.randomUUID()}`,
    correlation_id: correlationId || `corr_${crypto.randomUUID()}`,
    started_at: new Date().toISOString(),
    events: [],
    metadata: redact(metadata),
  };

  function emit(type, payload = {}) {
    const event = Object.freeze({
      id: `evt_${trace.events.length + 1}`,
      ts: new Date().toISOString(),
      type,
      run_id: trace.run_id,
      correlation_id: trace.correlation_id,
      payload: redact(payload),
    });
    trace.events.push(event);
    return event;
  }

  function snapshot() {
    return Object.freeze({
      ...trace,
      events: trace.events.slice(),
      ended_at: trace.ended_at || null,
      status: trace.status || "running",
    });
  }

  function finish(status = "completed", payload = {}) {
    trace.status = status;
    trace.ended_at = new Date().toISOString();
    emit(`run.${status}`, payload);
    return snapshot();
  }

  return Object.freeze({ trace, emit, snapshot, finish });
}

function redact(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (DEFAULT_REDACT_KEYS.has(key) || /secret|password|token|api[_-]?key/i.test(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    out[key] = redact(item, seen);
  }
  return out;
}

module.exports = {
  createTrace,
  redact,
};

"use strict";

/**
 * llm-observability — Langfuse / Phoenix / Helicone-shaped tracing
 * vocabulary for Sira.
 *
 * The MASTER_SPEC §28 + recommended stack list both require tracing
 * for every LLM-touching path. Industry tools (Langfuse, Arize Phoenix,
 * Helicone, OpenLLMetry) converge on the same vocabulary:
 *
 *   session  →  one user-visible conversation
 *   trace    →  one orchestrator turn (e.g. one /sira/chat call)
 *   span     →  any unit of work (tool call, retrieval, generation)
 *   generation → a span subtype that carries LLM-specific fields
 *                (model, prompt, completion, tokens, cost)
 *   event    →  a one-shot point in time (clarification asked, etc.)
 *   score    →  evaluation result attached to a trace/span
 *
 * This module defines that vocabulary as plain factory functions,
 * plus an ObservabilityHub that wires events to multiple sinks
 * (console, in-memory, Langfuse, Phoenix, OTel, Helicone) without
 * forcing the caller to learn each vendor's API.
 *
 * Pure JS, deterministic ids when seeded, zero deps.
 */

const SCHEMA_VERSION = "sira.observability.v1";

const SPAN_KINDS = Object.freeze([
  "tool_call", "retrieval", "rerank", "generation",
  "validation", "artifact_render", "policy_check",
  "router_decision", "memory_op", "external_api",
  "internal", "user_clarification", "human_approval",
]);

const SCORE_RANGES = Object.freeze({
  binary: { min: 0, max: 1 },
  unit: { min: 0, max: 1 },
  percent: { min: 0, max: 100 },
  scale_5: { min: 1, max: 5 },
  scale_10: { min: 1, max: 10 },
});

// ── Factories ───────────────────────────────────────────────────────

function createSession({ user_id, conversation_id = null, metadata = {}, ts = new Date().toISOString() } = {}) {
  if (!user_id) throw mkErr("missing_user_id", "session.user_id required");
  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    kind: "session",
    id: makeId("sess"),
    user_id,
    conversation_id,
    metadata,
    started_at: ts,
  });
}

function createTrace({ session_id, name, request_id = null, metadata = {}, ts = new Date().toISOString() } = {}) {
  if (!session_id) throw mkErr("missing_session_id", "trace.session_id required");
  if (!name) throw mkErr("missing_name", "trace.name required");
  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    kind: "trace",
    id: makeId("trc"),
    session_id,
    request_id,
    name,
    metadata,
    started_at: ts,
  });
}

function createSpan({ trace_id, parent_span_id = null, name, kind = "internal", input = null, metadata = {}, ts = new Date().toISOString() } = {}) {
  if (!trace_id) throw mkErr("missing_trace_id", "span.trace_id required");
  if (!name) throw mkErr("missing_name", "span.name required");
  if (!SPAN_KINDS.includes(kind)) throw mkErr("invalid_kind", `unknown kind "${kind}"`);
  return {
    schema_version: SCHEMA_VERSION,
    kind: "span",
    span_kind: kind,
    id: makeId("spn"),
    trace_id,
    parent_span_id,
    name,
    input,
    output: null,
    error: null,
    metadata,
    started_at: ts,
    ended_at: null,
    status: "running",
    duration_ms: null,
  };
}

function endSpan(span, { output = null, error = null, status = null, ts = new Date().toISOString(), metadata = {} } = {}) {
  if (!span || span.kind !== "span") throw mkErr("invalid_span", "span required");
  span.ended_at = ts;
  span.duration_ms = Math.max(0, new Date(ts).getTime() - new Date(span.started_at).getTime());
  span.output = output;
  span.error = error;
  span.metadata = { ...span.metadata, ...metadata };
  span.status = status || (error ? "error" : "ok");
  return Object.freeze(span);
}

/**
 * Generation = a span that carries LLM-specific fields. Same Langfuse
 * shape: model, prompt, completion, usage, cost.
 */
function createGeneration({
  trace_id, parent_span_id = null, name = "generation",
  model, provider, modality = "text",
  prompt = null, messages = null,
  metadata = {}, ts = new Date().toISOString(),
} = {}) {
  if (!trace_id) throw mkErr("missing_trace_id", "generation.trace_id required");
  if (!model || !provider) throw mkErr("missing_model_provider", "generation.model + provider required");
  return {
    schema_version: SCHEMA_VERSION,
    kind: "span",
    span_kind: "generation",
    id: makeId("gen"),
    trace_id,
    parent_span_id,
    name,
    model: { provider, model_id: model, modality },
    prompt,
    messages,
    completion: null,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    cost_usd: null,
    error: null,
    metadata,
    started_at: ts,
    ended_at: null,
    status: "running",
    duration_ms: null,
  };
}

function endGeneration(gen, { completion = null, usage = null, cost_usd = null, error = null, ts = new Date().toISOString(), metadata = {} } = {}) {
  if (!gen || gen.span_kind !== "generation") throw mkErr("invalid_generation", "generation required");
  gen.ended_at = ts;
  gen.duration_ms = Math.max(0, new Date(ts).getTime() - new Date(gen.started_at).getTime());
  gen.completion = completion;
  if (usage && typeof usage === "object") {
    gen.usage = {
      input_tokens: Number(usage.input_tokens) || 0,
      output_tokens: Number(usage.output_tokens) || 0,
      total_tokens: Number(usage.total_tokens) || (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0),
    };
  }
  if (cost_usd != null) gen.cost_usd = Number(cost_usd);
  gen.error = error;
  gen.metadata = { ...gen.metadata, ...metadata };
  gen.status = error ? "error" : "ok";
  return Object.freeze(gen);
}

function createScore({ trace_id = null, span_id = null, name, value, type = "unit", reason = null, ts = new Date().toISOString() } = {}) {
  if (!name) throw mkErr("missing_name", "score.name required");
  if (typeof value !== "number" || !Number.isFinite(value)) throw mkErr("invalid_value", "score.value must be finite number");
  const range = SCORE_RANGES[type];
  if (!range) throw mkErr("invalid_type", `unknown score type "${type}"`);
  if (value < range.min || value > range.max) throw mkErr("out_of_range", `value ${value} not in [${range.min},${range.max}] for type "${type}"`);
  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    kind: "score",
    id: makeId("scr"),
    trace_id,
    span_id,
    name,
    value,
    type,
    reason,
    ts,
  });
}

function createEvent({ trace_id, span_id = null, name, payload = null, ts = new Date().toISOString() } = {}) {
  if (!trace_id) throw mkErr("missing_trace_id", "event.trace_id required");
  if (!name) throw mkErr("missing_name", "event.name required");
  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    kind: "event",
    id: makeId("evt"),
    trace_id,
    span_id,
    name,
    payload,
    ts,
  });
}

// ── Hub ─────────────────────────────────────────────────────────────

function createObservabilityHub({ sinks = [createInMemorySink()], redact = defaultRedact } = {}) {
  if (!Array.isArray(sinks)) throw mkErr("invalid_sinks", "sinks must be array");

  async function emit(record) {
    const safe = redact(record);
    await Promise.all(sinks.map(async (s) => {
      try { await s.write(safe); } catch (_e) { /* sink failures must not break the run */ }
    }));
    return safe;
  }

  return {
    sinks,
    emit,
    flush: async () => Promise.all(sinks.map(s => (typeof s.flush === "function" ? s.flush() : null))),
  };
}

function createInMemorySink({ capacity = 5000 } = {}) {
  const buf = [];
  return {
    name: "in-memory",
    async write(record) {
      buf.push(record);
      if (buf.length > capacity) buf.shift();
    },
    snapshot: () => [...buf],
    countByKind: () => buf.reduce((m, r) => { m[r.kind] = (m[r.kind] || 0) + 1; return m; }, {}),
    clear: () => { buf.length = 0; },
  };
}

function createConsoleSink({ logger = console, redact = defaultRedact } = {}) {
  return {
    name: "console",
    async write(record) {
      const r = redact(record);
      const tag = `[${r.kind}${r.span_kind ? `:${r.span_kind}` : ""}]`;
      logger.log(tag, JSON.stringify(r).slice(0, 800));
    },
  };
}

/**
 * langfuse-style sink — caller passes a real Langfuse client; we map
 * our records to its API shape. Defaults to a no-op for tests.
 */
function createLangfuseSink({ client = null } = {}) {
  return {
    name: "langfuse",
    async write(record) {
      if (!client) return;
      switch (record.kind) {
        case "session":     return client.session?.(record);
        case "trace":       return client.trace?.(record);
        case "span":        return record.span_kind === "generation" ? client.generation?.(record) : client.span?.(record);
        case "event":       return client.event?.(record);
        case "score":       return client.score?.(record);
        default:            return;
      }
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

const REDACT_KEYS = new Set([
  "api_key", "apikey", "authorization", "auth", "token",
  "secret", "password", "ssn", "credit_card", "cvv",
]);

function defaultRedact(record) {
  return JSON.parse(JSON.stringify(record), (k, v) => {
    if (typeof k === "string" && REDACT_KEYS.has(k.toLowerCase())) return "[REDACTED]";
    if (typeof v === "string" && /sk-[A-Za-z0-9]{16,}/.test(v)) return v.replace(/sk-[A-Za-z0-9]{16,}/g, "sk-[REDACTED]");
    return v;
  });
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
}

// Codes preserved verbatim — callers + tests index on err.code as the
// primary discriminator. Only the class changes (Error → IngressError)
// so toHttpResponse / audit consumers get a structured payload.
function mkErr(code, message) {
  const { IngressError } = require("./pipeline-errors");
  return new IngressError({ code, message: `${code}: ${message}` });
}

module.exports = {
  SCHEMA_VERSION,
  SPAN_KINDS,
  SCORE_RANGES,
  createSession,
  createTrace,
  createSpan,
  endSpan,
  createGeneration,
  endGeneration,
  createScore,
  createEvent,
  createObservabilityHub,
  createInMemorySink,
  createConsoleSink,
  createLangfuseSink,
  defaultRedact,
};

/**
 * spans — OpenTelemetry-compatible span factory the Observability
 * Plane uses to record every agent step, tool invocation, and
 * critic review.
 *
 * We intentionally do NOT depend on the OTel SDK in this file —
 * the whole module is plain JS + crypto. The shape it produces
 * matches the OTel wire protocol closely enough that an exporter
 * (added in a later commit) can forward spans to any collector
 * (Tempo, Jaeger, Honeycomb, Datadog) without retrofitting call
 * sites.
 *
 * Why DIY when OTel is one npm install away: the platform must
 * work in CI and in sandboxes that can't reach a collector; we
 * want trace continuity in tests where the exporter is a stub.
 * When the operational PR lands, this file's `onSpanEnd` hook
 * becomes the OTel BatchSpanProcessor input.
 */

const crypto = require("crypto");

const KIND = Object.freeze({
  INTERNAL: "internal",
  SERVER: "server",
  CLIENT: "client",
  PRODUCER: "producer",
  CONSUMER: "consumer",
});

const STATUS = Object.freeze({
  UNSET: "UNSET",
  OK: "OK",
  ERROR: "ERROR",
});

function newTraceId() {
  return crypto.randomBytes(16).toString("hex");
}

function newSpanId() {
  return crypto.randomBytes(8).toString("hex");
}

/**
 * Create a Tracer bound to a service name. Produce spans with
 * `tracer.startSpan()`. A span is a mutable object; call `end()`
 * when the work is done.
 */
function createTracer({ serviceName = "siragpt-backend", exporter } = {}) {
  const onSpanEnd = typeof exporter === "function" ? exporter : () => {};

  function startSpan({ name, kind = KIND.INTERNAL, parent = null, attributes = {} } = {}) {
    if (!name || typeof name !== "string") throw new Error("spans: startSpan requires a name");
    const trace_id = parent?.trace_id || newTraceId();
    const span_id = newSpanId();
    const parent_span_id = parent?.span_id || null;
    const startTimeUnixNano = timeNanos();
    const span = {
      trace_id,
      span_id,
      parent_span_id,
      name,
      kind,
      service: serviceName,
      startTimeUnixNano,
      endTimeUnixNano: null,
      status: { code: STATUS.UNSET, message: null },
      attributes: { ...attributes },
      events: [],
      links: [],
      finished: false,
      end(opts = {}) {
        if (span.finished) return span;
        span.endTimeUnixNano = timeNanos();
        if (opts.status) {
          span.status = {
            code: opts.status === "error" ? STATUS.ERROR : (opts.status === "ok" ? STATUS.OK : span.status.code),
            message: opts.message || span.status.message,
          };
        }
        if (opts.attributes) Object.assign(span.attributes, opts.attributes);
        span.finished = true;
        try { onSpanEnd(toOtlpSpan(span)); } catch { /* never break on export */ }
        return span;
      },
      setStatus(code, message) {
        span.status = {
          code: code === "error" ? STATUS.ERROR : (code === "ok" ? STATUS.OK : span.status.code),
          message: message || null,
        };
        return span;
      },
      setAttribute(key, value) {
        span.attributes[String(key)] = value;
        return span;
      },
      addEvent(name, attrs = {}) {
        span.events.push({ name, timeUnixNano: timeNanos(), attributes: attrs });
        return span;
      },
      addLink(linkedSpan, attrs = {}) {
        if (linkedSpan?.trace_id && linkedSpan?.span_id) {
          span.links.push({ trace_id: linkedSpan.trace_id, span_id: linkedSpan.span_id, attributes: attrs });
        }
        return span;
      },
      toJSON() { return toOtlpSpan(span); },
    };
    return span;
  }

  /**
   * Run `fn` within a new span and end it with OK/ERROR based on
   * whether the callable throws. Re-throws so the caller still sees
   * the error.
   */
  async function withSpan(options, fn) {
    const span = startSpan(options);
    try {
      const r = await Promise.resolve(fn(span));
      span.end({ status: "ok" });
      return r;
    } catch (err) {
      span.addEvent("exception", { "exception.type": err?.name, "exception.message": err?.message });
      span.end({ status: "error", message: err?.message });
      throw err;
    }
  }

  return { startSpan, withSpan, serviceName };
}

function timeNanos() {
  const hr = typeof process !== "undefined" && typeof process.hrtime === "function" ? process.hrtime.bigint?.() : null;
  if (typeof hr === "bigint") return hr.toString();
  return String(Date.now() * 1e6);
}

/**
 * Convert an internal span into the OTLP JSON shape. Callers that
 * plug in an OTel exporter can forward this directly.
 */
function toOtlpSpan(span) {
  return {
    traceId: span.trace_id,
    spanId: span.span_id,
    parentSpanId: span.parent_span_id || undefined,
    name: span.name,
    kind: span.kind,
    startTimeUnixNano: span.startTimeUnixNano,
    endTimeUnixNano: span.endTimeUnixNano || undefined,
    status: span.status,
    attributes: attributesToKeyValues(span.attributes),
    events: (span.events || []).map(e => ({
      name: e.name,
      timeUnixNano: e.timeUnixNano,
      attributes: attributesToKeyValues(e.attributes || {}),
    })),
    links: (span.links || []).map(l => ({
      traceId: l.trace_id,
      spanId: l.span_id,
      attributes: attributesToKeyValues(l.attributes || {}),
    })),
    resource: { "service.name": span.service },
  };
}

function attributesToKeyValues(attrs) {
  const out = [];
  for (const [k, v] of Object.entries(attrs || {})) {
    out.push({ key: k, value: coerceAnyValue(v) });
  }
  return out;
}

function coerceAnyValue(v) {
  if (v === null || v === undefined) return { stringValue: "" };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "number" && Number.isInteger(v)) return { intValue: v };
  if (typeof v === "number") return { doubleValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(coerceAnyValue) } };
  try { return { stringValue: JSON.stringify(v) }; }
  catch { return { stringValue: String(v) }; }
}

module.exports = {
  createTracer,
  toOtlpSpan,
  KIND,
  STATUS,
  newTraceId,
  newSpanId,
  INTERNAL: { attributesToKeyValues, coerceAnyValue, timeNanos },
};

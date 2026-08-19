/**
 * event-envelope — canonical envelope for every event that flows
 * through the AI Product OS.
 *
 * Shape (stable, versioned):
 *
 *   {
 *     id,                // unique envelope id (ULID-like, time-sortable)
 *     type,              // "product-os.<domain>.<verb>"
 *     schema_version,    // envelope schema version (not payload's)
 *     ts,                // ISO 8601 timestamp (UTC)
 *
 *     correlation_id,    // shared across all events in a conversation
 *     causation_id,      // the envelope id that caused this event
 *     trace_id,          // OTel 128-bit trace id (32 hex chars)
 *     span_id,           // OTel 64-bit span id (16 hex chars)
 *     parent_span_id,    // OTel parent span (optional)
 *
 *     producer,          // agent / service / tool name
 *     tenant,            // optional tenant isolation key
 *     payload,           // domain data (arbitrary JSON)
 *     payload_schema,    // "ExecutionGraph@1.0", "ToolCallResult@1.0"…
 *   }
 *
 * Pure JS, zero deps. The envelope is meant to be stable enough to
 * serialize, index, and replay.
 */

const SCHEMA_VERSION = "1.0";
const ENVELOPE_ID_BYTES = 16; // 128-bit id
const TRACE_ID_HEX = 32;
const SPAN_ID_HEX = 16;

/**
 * @param {object} args
 * @param {string} args.type
 * @param {object} [args.payload]
 * @param {string} [args.payload_schema]
 * @param {object} [args.trace] — existing trace (correlation_id, trace_id, span_id, parent_span_id)
 * @param {string} [args.producer]
 * @param {string} [args.tenant]
 * @param {string} [args.causation_id]
 */
function createEnvelope({
  type,
  payload = {},
  payload_schema = null,
  trace = {},
  producer = "ai-product-os",
  tenant = null,
  causation_id = null,
} = {}) {
  if (typeof type !== "string" || type.trim().length === 0) {
    throw new Error("event-envelope: type (non-empty string) required");
  }
  const now = new Date();
  const id = generateId();
  const correlation_id = trace.correlation_id || id;
  const trace_id = trace.trace_id || generateHex(TRACE_ID_HEX);
  const span_id = trace.span_id || generateHex(SPAN_ID_HEX);
  const parent_span_id = trace.parent_span_id || null;

  return {
    id,
    type,
    schema_version: SCHEMA_VERSION,
    ts: now.toISOString(),
    correlation_id,
    causation_id,
    trace_id,
    span_id,
    parent_span_id,
    producer,
    tenant,
    payload,
    payload_schema,
  };
}

/**
 * Validate the minimal shape of an envelope. Returns { ok, errors }.
 */
function validateEnvelope(e) {
  const errors = [];
  if (!e || typeof e !== "object") return { ok: false, errors: ["not_an_object"] };
  for (const key of ["id", "type", "schema_version", "ts", "correlation_id", "trace_id", "span_id", "producer"]) {
    if (typeof e[key] !== "string" || e[key].length === 0) errors.push(`missing_or_empty.${key}`);
  }
  if (e.trace_id && !/^[0-9a-f]{32}$/i.test(String(e.trace_id))) errors.push("invalid.trace_id");
  if (e.span_id && !/^[0-9a-f]{16}$/i.test(String(e.span_id))) errors.push("invalid.span_id");
  if (e.parent_span_id && !/^[0-9a-f]{16}$/i.test(String(e.parent_span_id))) errors.push("invalid.parent_span_id");
  if (typeof e.ts === "string" && Number.isNaN(Date.parse(e.ts))) errors.push("invalid.ts");
  return { ok: errors.length === 0, errors };
}

/**
 * Chain a child envelope from a parent. Preserves correlation_id and
 * trace_id; generates new span_id; links causation_id to the parent's
 * envelope id; sets parent_span_id to the parent's span_id.
 */
function chainEnvelope(parent, { type, payload, payload_schema, producer, tenant } = {}) {
  if (!parent || typeof parent !== "object") throw new Error("event-envelope: parent envelope required to chain");
  return createEnvelope({
    type,
    payload,
    payload_schema,
    producer: producer || parent.producer,
    tenant: tenant ?? parent.tenant,
    causation_id: parent.id,
    trace: {
      correlation_id: parent.correlation_id,
      trace_id: parent.trace_id,
      span_id: generateHex(SPAN_ID_HEX),
      parent_span_id: parent.span_id,
    },
  });
}

/**
 * Serialize to a flat JSON string suitable for Kafka / NATS / file.
 */
function serializeEnvelope(e) {
  return JSON.stringify(e);
}

function deserializeEnvelope(str) {
  const e = typeof str === "string" ? JSON.parse(str) : str;
  const v = validateEnvelope(e);
  if (!v.ok) throw new Error(`event-envelope: deserialize failed — ${v.errors.join(",")}`);
  return e;
}

function generateId() {
  const ts = Date.now();
  const rand = generateHex(ENVELOPE_ID_BYTES * 2 - 12);
  return `${ts.toString(16).padStart(12, "0")}${rand}`;
}

function generateHex(len) {
  const bytes = Math.ceil(len / 2);
  const buf = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256);
  let s = "";
  for (const b of buf) s += b.toString(16).padStart(2, "0");
  return s.slice(0, len);
}

module.exports = {
  createEnvelope,
  validateEnvelope,
  chainEnvelope,
  serializeEnvelope,
  deserializeEnvelope,
  SCHEMA_VERSION,
};

'use strict';

/**
 * trace-context — W3C Trace Context (traceparent + tracestate)
 * propagation primitives. Lets us hand a stable trace identifier to
 * every outbound call (provider, MCP, internal HTTP) so a single
 * agent turn shows up as one tree in Tempo / Jaeger / Honeycomb
 * regardless of which subsystem made each span.
 *
 * Spec: https://www.w3.org/TR/trace-context/
 *
 * Public API:
 *   parseTraceparent(header)            → { version, traceId, spanId, flags } | null
 *   formatTraceparent(ctx)              → 'XX-XX..-XX..-XX'
 *   parseTracestate(header)             → Map<vendor, value>
 *   formatTracestate(map)               → 'vendor=value,vendor=value'
 *   newTraceContext({ sampled? })       → fresh ctx (random ids)
 *   childOf(ctx)                        → same trace, new span
 *   withContext(ctx, fn)                → run fn() with ALS-bound ctx
 *   currentContext()                    → ctx | null
 *   injectHeaders(headers, ctx?)        → mutated headers
 *   extractFromHeaders(headers)         → ctx | null
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const { randomBytes } = require('node:crypto');

const ALS = new AsyncLocalStorage();

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const VERSION = '00';
const FLAG_SAMPLED = 0x01;

const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

function isHex(str, len) {
  return typeof str === 'string' && str.length === len && /^[0-9a-f]+$/i.test(str);
}

function newTraceId() { return randomBytes(16).toString('hex'); }
function newSpanId() { return randomBytes(8).toString('hex'); }

function parseTraceparent(header) {
  if (typeof header !== 'string') return null;
  const m = TRACEPARENT_RE.exec(header.trim());
  if (!m) return null;
  const [, version, traceId, spanId, flagsHex] = m;
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return null;
  return {
    version: version.toLowerCase(),
    traceId: traceId.toLowerCase(),
    spanId: spanId.toLowerCase(),
    flags: parseInt(flagsHex, 16),
  };
}

function formatTraceparent(ctx) {
  if (!ctx) throw new TypeError('formatTraceparent: ctx required');
  if (!isHex(ctx.traceId, 32)) throw new TypeError('formatTraceparent: bad traceId');
  if (!isHex(ctx.spanId, 16)) throw new TypeError('formatTraceparent: bad spanId');
  const flags = (Number(ctx.flags) || 0) & 0xff;
  return `${VERSION}-${ctx.traceId.toLowerCase()}-${ctx.spanId.toLowerCase()}-${flags.toString(16).padStart(2, '0')}`;
}

function parseTracestate(header) {
  const out = new Map();
  if (typeof header !== 'string' || !header) return out;
  // Spec: comma-separated list, max 32 members, key=value.
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k || !v) continue;
    out.set(k, v);
    if (out.size >= 32) break;
  }
  return out;
}

function formatTracestate(map) {
  if (!map || map.size === 0) return '';
  const parts = [];
  for (const [k, v] of map) {
    if (typeof k !== 'string' || !k) continue;
    parts.push(`${k}=${v}`);
    if (parts.length >= 32) break;
  }
  return parts.join(',');
}

function newTraceContext({ sampled = true } = {}) {
  return {
    version: VERSION,
    traceId: newTraceId(),
    spanId: newSpanId(),
    flags: sampled ? FLAG_SAMPLED : 0,
    state: new Map(),
  };
}

function childOf(ctx) {
  if (!ctx) throw new TypeError('childOf: ctx required');
  return {
    version: ctx.version || VERSION,
    traceId: ctx.traceId,
    spanId: newSpanId(),
    flags: ctx.flags,
    state: new Map(ctx.state || []),
  };
}

function withContext(ctx, fn) {
  if (typeof fn !== 'function') throw new TypeError('withContext: fn required');
  return ALS.run(ctx, fn);
}

function currentContext() {
  return ALS.getStore() || null;
}

function injectHeaders(headers, ctx) {
  if (!headers || typeof headers !== 'object') throw new TypeError('injectHeaders: headers object required');
  const c = ctx || currentContext();
  if (!c) return headers;
  headers['traceparent'] = formatTraceparent(c);
  if (c.state && c.state.size > 0) headers['tracestate'] = formatTracestate(c.state);
  return headers;
}

function extractFromHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const tp = parseTraceparent(headers['traceparent'] || headers['Traceparent']);
  if (!tp) return null;
  const ts = parseTracestate(headers['tracestate'] || headers['Tracestate']);
  return { ...tp, state: ts };
}

module.exports = {
  parseTraceparent,
  formatTraceparent,
  parseTracestate,
  formatTracestate,
  newTraceContext,
  childOf,
  withContext,
  currentContext,
  injectHeaders,
  extractFromHeaders,
  FLAG_SAMPLED,
};

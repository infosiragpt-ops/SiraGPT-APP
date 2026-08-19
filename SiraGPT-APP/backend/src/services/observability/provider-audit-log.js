'use strict';

/**
 * provider-audit-log — append-only ring buffer of provider call events
 * (model, tenant, latency, status, error class) with automatic
 * redaction of PII-shaped fields and a tunable retention window.
 * Pairs with prompt-cache-metrics (#12) which is aggregate-only;
 * this is the per-event trail an operator needs when a tenant calls
 * support and asks "why did my call fail at 14:32".
 *
 * Design constraints:
 *   - Append O(1), fixed memory (ring buffer of `capacity` rows).
 *   - Redact common PII shapes (email, phone, credit-card-like,
 *     bearer tokens, API keys) from any string field BEFORE storing.
 *   - Time-bounded retention window: events older than maxAgeMs are
 *     pruned on append (cheap O(events-to-evict) walk from the head).
 *   - Query by model / tenantId / status / since / until.
 *
 * Public API:
 *   const log = createProviderAuditLog({
 *     capacity,                         // default 5000
 *     maxAgeMs,                         // default 24h
 *     redactor,                         // (str) => str (replace, not throw)
 *     now,                              // clock injector
 *   })
 *   log.append({ model, tenantId, status, latencyMs, errorCode?,
 *                requestId?, meta? })
 *   log.query({ model?, tenantId?, status?, since?, until?, limit? })
 *   log.size() / log.snapshot() / log.clear()
 *
 * `meta` is shallow-cloned and string fields run through the redactor.
 * Nested objects are JSON-stringified, redacted, and parsed back, so
 * even deeply-nested PII gets scrubbed.
 */

const DEFAULT_CAPACITY = 5000;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60_000;

const PII_PATTERNS = [
  // Order matters: more specific first. Emails before generic words.
  // Bearer + apikey BEFORE phone/cc so a token's digit run isn't
  // mis-matched as a phone number.
  { name: 'email',     re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,        token: '[REDACTED:email]' },
  { name: 'bearer',    re: /Bearer\s+[A-Za-z0-9._\-]+/g,                     token: 'Bearer [REDACTED]' },
  { name: 'apikey',    re: /\b(?:sk|ak|pk|rk)[-_][A-Za-z0-9_-]{8,}/g,        token: '[REDACTED:key]' },
  { name: 'cc',        re: /\b(?:\d[ -]?){13,16}\b/g,                        token: '[REDACTED:cc]' },
  { name: 'phone',     re: /\+?\d[\d\s().-]{8,}\d/g,                         token: '[REDACTED:phone]' },
];

function defaultRedactor(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = s;
  for (const p of PII_PATTERNS) out = out.replace(p.re, p.token);
  return out;
}

function deepRedact(value, redactor) {
  if (value == null) return value;
  if (typeof value === 'string') return redactor(value);
  if (typeof value !== 'object') return value;
  try {
    const json = JSON.stringify(value);
    return JSON.parse(redactor(json));
  } catch {
    return value;
  }
}

function createProviderAuditLog(opts = {}) {
  const capacity = Number.isFinite(opts.capacity) && opts.capacity > 0
    ? Math.floor(opts.capacity)
    : DEFAULT_CAPACITY;
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) && opts.maxAgeMs > 0
    ? Math.floor(opts.maxAgeMs)
    : DEFAULT_MAX_AGE_MS;
  const redactor = typeof opts.redactor === 'function' ? opts.redactor : defaultRedactor;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  /** @type {Array<object>} chronological order; oldest at index 0. */
  const events = [];
  let totalAppended = 0;
  let totalDroppedAge = 0;
  let totalDroppedCapacity = 0;

  function pruneAge(t) {
    const cutoff = t - maxAgeMs;
    let i = 0;
    while (i < events.length && events[i].ts < cutoff) i += 1;
    if (i > 0) {
      events.splice(0, i);
      totalDroppedAge += i;
    }
  }

  function pruneCapacity() {
    const overflow = events.length - capacity;
    if (overflow > 0) {
      events.splice(0, overflow);
      totalDroppedCapacity += overflow;
    }
  }

  function append({ model, tenantId = null, status = 'unknown', latencyMs = 0, errorCode = null, requestId = null, meta = null } = {}) {
    if (typeof model !== 'string' || !model) return null;
    const t = now();
    pruneAge(t);
    const row = {
      ts: t,
      model: redactor(String(model)),
      tenantId: tenantId == null ? null : redactor(String(tenantId)),
      status: typeof status === 'string' ? status : 'unknown',
      latencyMs: Number.isFinite(Number(latencyMs)) ? Math.max(0, Math.floor(Number(latencyMs))) : 0,
      errorCode: errorCode == null ? null : redactor(String(errorCode)),
      requestId: requestId == null ? null : redactor(String(requestId)),
      meta: meta == null ? null : deepRedact(meta, redactor),
    };
    events.push(row);
    totalAppended += 1;
    pruneCapacity();
    return row;
  }

  function query({ model, tenantId, status, since, until, limit } = {}) {
    pruneAge(now());
    const out = [];
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : Infinity;
    for (let i = events.length - 1; i >= 0 && out.length < cap; i--) {
      const e = events[i];
      if (model && e.model !== model) continue;
      if (tenantId && e.tenantId !== tenantId) continue;
      if (status && e.status !== status) continue;
      if (Number.isFinite(since) && e.ts < since) continue;
      if (Number.isFinite(until) && e.ts > until) continue;
      out.push(e);
    }
    // Newest-first ordering.
    return out;
  }

  function size() { pruneAge(now()); return events.length; }

  function snapshot() {
    return {
      size: size(),
      capacity,
      maxAgeMs,
      totalAppended,
      totalDroppedAge,
      totalDroppedCapacity,
    };
  }

  function clear() {
    events.length = 0;
  }

  return { append, query, size, snapshot, clear };
}

module.exports = {
  createProviderAuditLog,
  defaultRedactor,
  deepRedact,
  PII_PATTERNS,
  DEFAULT_CAPACITY,
  DEFAULT_MAX_AGE_MS,
};

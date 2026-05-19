'use strict';

/**
 * webhook-dispatcher — outbound webhook delivery service with HMAC-signed
 * payloads, retry-with-backoff, and an in-memory delivery log.
 *
 * The repo does not yet have a `WebhookDelivery` Prisma model — adding one
 * requires a migration, which we deliberately avoid in this improvement
 * cycle. Until the migration ships, the delivery log lives in a bounded
 * in-memory ring buffer (the most recent N attempts, default 2048). The
 * public API is identical to the eventual Prisma-backed implementation so
 * the admin dashboard route does not change when we cut over.
 *
 * Public API
 *   - dispatch({ url, event, payload, secret, ... })           → delivery id
 *   - retry(deliveryId, opts)                                  → new attempt
 *   - listDeliveries({ limit, status, event })                 → array
 *   - getDelivery(id)                                          → entry | null
 *   - retryFailed({ limit, since })                            → counts
 *   - signPayload(secret, payload, timestamp)                  → header value
 *   - verifySignature(secret, payload, header, opts)           → boolean
 *   - resetStore()                                             → testing
 */

const crypto = require('crypto');
const { withRetry } = require('../utils/retry-with-backoff');
// Optional OTel span helper — falls back to a direct call if the
// module / SDK aren't present.
let _otelSpans = null;
try { _otelSpans = require('../utils/otel-spans'); } catch (_e) { _otelSpans = null; }
const withWebhookDeliverySpan = (_otelSpans && _otelSpans.withWebhookDeliverySpan)
  ? _otelSpans.withWebhookDeliverySpan
  : (_attrs, fn) => fn();

const SIGNATURE_HEADER = 'X-SiraGPT-Signature';
const DEFAULT_BUFFER_SIZE = 2048;
const DEFAULT_TIMESTAMP_TOLERANCE_S = 5 * 60; // 5 minutes
const DEFAULT_TIMEOUT_MS = 10_000;

let deliveries = []; // ring buffer of attempt records
let bufferSize = DEFAULT_BUFFER_SIZE;
let nextId = 1;

function resetStore({ size = DEFAULT_BUFFER_SIZE } = {}) {
  deliveries = [];
  bufferSize = size;
  nextId = 1;
}

function recordAttempt(entry) {
  deliveries.push(entry);
  if (deliveries.length > bufferSize) {
    deliveries.splice(0, deliveries.length - bufferSize);
  }
  return entry;
}

function canonicalPayload(payload) {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload;
  if (Buffer.isBuffer(payload)) return payload.toString('utf8');
  return JSON.stringify(payload);
}

function signPayload(secret, payload, timestamp = Math.floor(Date.now() / 1000)) {
  if (!secret) throw new Error('webhook secret required');
  const body = canonicalPayload(payload);
  const base = `${timestamp}.${body}`;
  const sig = crypto.createHmac('sha256', secret).update(base).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

function parseHeader(header) {
  const out = { t: null, v1: null };
  if (!header || typeof header !== 'string') return out;
  for (const segment of header.split(',')) {
    const [k, v] = segment.trim().split('=');
    if (k === 't') out.t = Number(v);
    else if (k === 'v1') out.v1 = v;
  }
  return out;
}

function timingSafeEqualHex(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function verifySignature(secret, payload, header, opts = {}) {
  if (!secret) return false;
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TIMESTAMP_TOLERANCE_S;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const parsed = parseHeader(header);
  if (!parsed.t || !parsed.v1) return false;
  if (Math.abs(now - parsed.t) > tolerance) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parsed.t}.${canonicalPayload(payload)}`)
    .digest('hex');
  return timingSafeEqualHex(expected, parsed.v1);
}

async function defaultDeliver({ url, body, headers, timeoutMs }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      body,
      headers,
      signal: ac.signal,
    });
    return { status: res.status, ok: res.ok };
  } finally {
    clearTimeout(timer);
  }
}

async function dispatch({
  url,
  event,
  payload,
  secret,
  headers = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRetries = 3,
  baseDelayMs = 250,
  maxDelayMs = 5_000,
  deliverFn = defaultDeliver,
  now = Date.now,
} = {}) {
  if (!url || typeof url !== 'string') throw new Error('webhook url required');
  if (!event || typeof event !== 'string') throw new Error('webhook event required');
  const id = String(nextId++);
  const createdAt = new Date(now());
  const body = canonicalPayload(payload);
  const ts = Math.floor(now() / 1000);
  const signature = secret ? signPayload(secret, body, ts) : null;
  const finalHeaders = {
    'Content-Type': 'application/json',
    'User-Agent': 'SiraGPT-Webhooks/1.0',
    'X-SiraGPT-Event': event,
    'X-SiraGPT-Delivery': id,
    ...(signature ? { [SIGNATURE_HEADER]: signature } : {}),
    ...headers,
  };

  const entry = {
    id,
    url,
    event,
    createdAt: createdAt.toISOString(),
    attempts: 0,
    status: 'pending',
    httpStatus: null,
    lastError: null,
    lastAttemptAt: null,
    payload: body,
    signature,
    signed: Boolean(signature),
  };
  recordAttempt(entry);

  try {
    const result = await withRetry(
      async () => {
        entry.attempts += 1;
        entry.lastAttemptAt = new Date().toISOString();
        const res = await withWebhookDeliverySpan(
          { url, event, attempt: entry.attempts, deliveryId: id },
          async (span) => {
            const r = await deliverFn({ url, body, headers: finalHeaders, timeoutMs });
            try {
              if (span && typeof span.setAttributes === 'function') {
                span.setAttributes({ httpStatus: r.status, ok: !!r.ok });
              }
            } catch (_e) { /* swallow */ }
            return r;
          },
        );
        entry.httpStatus = res.status;
        if (!res.ok) {
          const err = new Error(`webhook_http_${res.status}`);
          err.retryable = res.status >= 500 || res.status === 429;
          throw err;
        }
        return res;
      },
      {
        maxRetries,
        baseDelayMs,
        maxDelayMs,
        classifyError: (err) => ({ retryable: err && err.retryable !== false }),
      }
    );
    entry.status = 'delivered';
    return { id, status: entry.status, httpStatus: result.status, attempts: entry.attempts };
  } catch (err) {
    entry.status = 'failed';
    entry.lastError = err && err.message ? err.message : String(err);
    return { id, status: entry.status, attempts: entry.attempts, error: entry.lastError };
  }
}

async function retry(id, opts = {}) {
  const entry = deliveries.find((d) => d.id === String(id));
  if (!entry) return { ok: false, reason: 'not_found' };
  return dispatch({
    url: entry.url,
    event: entry.event,
    payload: entry.payload,
    secret: opts.secret,
    timeoutMs: opts.timeoutMs,
    maxRetries: opts.maxRetries ?? 0,
    deliverFn: opts.deliverFn,
  });
}

async function retryFailed({ limit = 100, since = null, deliverFn, secretResolver } = {}) {
  const candidates = deliveries
    .filter((d) => d.status === 'failed')
    .filter((d) => (since ? new Date(d.createdAt).getTime() >= new Date(since).getTime() : true))
    .slice(-limit);
  let retried = 0;
  let recovered = 0;
  for (const c of candidates) {
    const secret = secretResolver ? secretResolver(c) : undefined;
    const result = await dispatch({
      url: c.url,
      event: c.event,
      payload: c.payload,
      secret,
      deliverFn,
      maxRetries: 0,
    });
    retried += 1;
    if (result.status === 'delivered') recovered += 1;
  }
  return { retried, recovered, candidates: candidates.length };
}

function listDeliveries({ limit = 100, status = null, event = null } = {}) {
  let out = deliveries.slice();
  if (status) out = out.filter((d) => d.status === status);
  if (event) out = out.filter((d) => d.event === event);
  out.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return out.slice(0, limit);
}

function getDelivery(id) {
  return deliveries.find((d) => d.id === String(id)) || null;
}

function stats() {
  const counts = { pending: 0, delivered: 0, failed: 0 };
  for (const d of deliveries) {
    counts[d.status] = (counts[d.status] || 0) + 1;
  }
  return { total: deliveries.length, counts, bufferSize };
}

module.exports = {
  SIGNATURE_HEADER,
  dispatch,
  retry,
  retryFailed,
  listDeliveries,
  getDelivery,
  stats,
  signPayload,
  verifySignature,
  resetStore,
};

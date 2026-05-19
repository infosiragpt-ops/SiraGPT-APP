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

// ── Dead-letter queue (cycle 21 retries → DLQ on exhaustion) ──────
// Failed deliveries (after `maxRetries` exhausted) are pushed here so
// operators can inspect payload + error + attempts and re-dispatch.
// Backed by an in-memory ring buffer; if a Redis client is registered
// via `setDLQRedisBackend` (cycle 31 pattern) entries are also mirrored
// there so they survive process restarts. Redis writes are best-effort
// and never block dispatch.
const DEFAULT_DLQ_SIZE = 1024;
const DLQ_REDIS_KEY = 'siragpt:webhooks:dlq';
let dlq = [];
let dlqSize = DEFAULT_DLQ_SIZE;
let dlqRedis = null; // optional ioredis-like client { lpush, lrange, ltrim, lrem, del }

function setDLQRedisBackend(client) {
  dlqRedis = client || null;
}

function resetStore({ size = DEFAULT_BUFFER_SIZE, dlqRingSize = DEFAULT_DLQ_SIZE } = {}) {
  deliveries = [];
  bufferSize = size;
  nextId = 1;
  dlq = [];
  dlqSize = dlqRingSize;
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

async function dispatch(opts = {}) {
  const {
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
  } = opts;
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

  const startedAtMs = now();
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
    // durationMs is the wall-clock time from first dispatch attempt
    // until terminal status (delivered OR failed). It includes retry
    // backoff so it reflects what the caller actually observes; the
    // health endpoint uses this for p95 latency.
    durationMs: null,
    startedAtMs,
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
    entry.durationMs = Math.max(0, now() - startedAtMs);
    return { id, status: entry.status, httpStatus: result.status, attempts: entry.attempts };
  } catch (err) {
    entry.status = 'failed';
    entry.lastError = err && err.message ? err.message : String(err);
    entry.durationMs = Math.max(0, now() - startedAtMs);
    // Push to DLQ — retries are exhausted at this point. Skip when the
    // caller passed `maxRetries: 0` AND this is itself a DLQ replay
    // (we detect that via `opts._fromDLQ`) to avoid loops on manual
    // re-dispatch.
    if (!opts._fromDLQ) {
      pushToDLQ({
        id,
        url,
        event,
        payload: body,
        attempts: entry.attempts,
        error: entry.lastError,
        httpStatus: entry.httpStatus,
        createdAt: entry.createdAt,
        failedAt: new Date(now()).toISOString(),
      });
    }
    return { id, status: entry.status, attempts: entry.attempts, error: entry.lastError };
  }
}

function pushToDLQ(item) {
  dlq.push(item);
  if (dlq.length > dlqSize) dlq.splice(0, dlq.length - dlqSize);
  // Best-effort Redis mirror — never let a backend failure break dispatch.
  if (dlqRedis && typeof dlqRedis.lpush === 'function') {
    try {
      const p = dlqRedis.lpush(DLQ_REDIS_KEY, JSON.stringify(item));
      if (p && typeof p.then === 'function') {
        p.then(() => {
          if (typeof dlqRedis.ltrim === 'function') {
            return dlqRedis.ltrim(DLQ_REDIS_KEY, 0, dlqSize - 1);
          }
          return null;
        }).catch(() => { /* swallow */ });
      }
    } catch { /* swallow */ }
  }
  return item;
}

function listDLQ({ limit = 100, event = null } = {}) {
  let out = dlq.slice();
  if (event) out = out.filter((d) => d.event === event);
  out.sort((a, b) => new Date(b.failedAt) - new Date(a.failedAt));
  return out.slice(0, limit);
}

function getDLQItem(id) {
  return dlq.find((d) => String(d.id) === String(id)) || null;
}

function removeDLQItem(id) {
  const idx = dlq.findIndex((d) => String(d.id) === String(id));
  if (idx === -1) return false;
  const [removed] = dlq.splice(idx, 1);
  if (dlqRedis && typeof dlqRedis.lrem === 'function' && removed) {
    try {
      const p = dlqRedis.lrem(DLQ_REDIS_KEY, 0, JSON.stringify(removed));
      if (p && typeof p.then === 'function') p.then(() => null).catch(() => null);
    } catch { /* swallow */ }
  }
  return true;
}

function dlqStats() {
  return { total: dlq.length, bufferSize: dlqSize, redisBacked: Boolean(dlqRedis) };
}

async function retryDLQItem(id, opts = {}) {
  const item = getDLQItem(id);
  if (!item) return { ok: false, reason: 'not_found' };
  const result = await dispatch({
    url: item.url,
    event: item.event,
    payload: item.payload,
    secret: opts.secret,
    timeoutMs: opts.timeoutMs,
    maxRetries: opts.maxRetries ?? 0,
    deliverFn: opts.deliverFn,
    _fromDLQ: true,
  });
  if (result.status === 'delivered') removeDLQItem(id);
  return { ok: true, result };
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

// ── Percentile helper ───────────────────────────────────────────────
// Nearest-rank percentile over an unsorted numeric array. Returns 0
// for an empty input so the health JSON stays well-formed when no
// deliveries have been recorded yet. We sort a copy (cheap given the
// ring buffer is bounded at ~2k entries) instead of using an online
// estimator — exact values are more useful for a small-N admin view.
function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  if (!Number.isFinite(p) || p <= 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

// ── Health snapshot (ratchet 45) ────────────────────────────────────
// Aggregates the in-memory ring buffer into the four signals the admin
// dashboard wants:
//   - delivered24h   : count of delivered entries in the last 24h
//   - failed24h      : count of failed entries in the last 24h
//   - failureRate    : failed / (delivered + failed) in [0, 1]
//   - p95DurationMs  : 95th percentile of `durationMs` over the same
//                      window (delivered + failed only — `pending` and
//                      `retrying` haven't produced a final latency yet)
//   - retryingNow    : entries currently in flight that have already
//                      made ≥ 2 attempts (i.e. observed at least one
//                      failure and are still being retried)
//
// `windowMs` defaults to 24h but can be overridden by the route layer
// (`?windowHours=`) to make this useful for ad-hoc investigations.
function health({ windowMs = 24 * 60 * 60 * 1000, now = Date.now } = {}) {
  const cutoff = now() - windowMs;
  let delivered = 0;
  let failed = 0;
  let retrying = 0;
  const durations = [];

  for (const d of deliveries) {
    const tsRaw = d.createdAt ? new Date(d.createdAt).getTime() : NaN;
    const inWindow = Number.isFinite(tsRaw) && tsRaw >= cutoff;
    // Count "currently retrying" across the whole buffer — these are
    // by definition still in progress and might be older than the
    // window but we still want operators to see them.
    if (d.status === 'pending' && (d.attempts || 0) >= 2) retrying += 1;
    if (!inWindow) continue;
    if (d.status === 'delivered') {
      delivered += 1;
      if (typeof d.durationMs === 'number') durations.push(d.durationMs);
    } else if (d.status === 'failed') {
      failed += 1;
      if (typeof d.durationMs === 'number') durations.push(d.durationMs);
    }
  }

  const total = delivered + failed;
  return {
    windowMs,
    delivered24h: delivered,
    failed24h: failed,
    totalTerminal24h: total,
    failureRate: total === 0 ? 0 : Number((failed / total).toFixed(4)),
    p95DurationMs: percentile(durations, 95),
    retryingNow: retrying,
    bufferSize,
    bufferUsed: deliveries.length,
    generatedAt: new Date(now()).toISOString(),
  };
}

module.exports = {
  SIGNATURE_HEADER,
  dispatch,
  retry,
  retryFailed,
  listDeliveries,
  getDelivery,
  stats,
  health,
  signPayload,
  verifySignature,
  resetStore,
  // DLQ surface
  listDLQ,
  getDLQItem,
  removeDLQItem,
  retryDLQItem,
  dlqStats,
  setDLQRedisBackend,
  DLQ_REDIS_KEY,
};

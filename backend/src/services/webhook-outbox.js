'use strict';

// Delivery outbox: enqueue is durable before returning; delivery is at-least-
// once. Passing a Prisma transaction client to enqueue couples the row to the
// producer transaction. HTTP acknowledgement cannot be made exactly-once.
const crypto = require('node:crypto');
const MAX_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_CONCURRENCY = 4;

function createWebhookOutbox({ prisma, dispatcher, concurrency = DEFAULT_CONCURRENCY, now = Date.now,
  pollMs = 1000, leaseMs = 30_000, onError = () => {} } = {}) {
  const slots = Math.max(1, Math.min(8, Number(concurrency) || DEFAULT_CONCURRENCY));
  let timer = null;
  let active = null;
  let stopped = true;

  async function enqueue({ endpoint, event, payload, idempotencyKey, publisherUserId = null }, client = prisma) {
    if (!client?.webhookDelivery) throw Object.assign(new Error('Webhook outbox schema is unavailable'), { code: 'WEBHOOK_OUTBOX_UNAVAILABLE' });
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_PAYLOAD_BYTES) throw Object.assign(new Error('Webhook payload exceeds byte limit'), { code: 'WEBHOOK_PAYLOAD_TOO_LARGE' });
    if (!endpoint?.id || !idempotencyKey) throw Object.assign(new Error('Delivery identity is required'), { code: 'WEBHOOK_IDENTITY_REQUIRED' });
    const key = crypto.createHash('sha256').update(JSON.stringify([endpoint.id, idempotencyKey])).digest('hex');
    const data = { id: crypto.randomUUID(), endpointId: endpoint.id, endpointUserId: endpoint.userId,
      publisherUserId, organizationId: endpoint.organizationId || null, url: endpoint.url, event,
      payload: body, idempotencyKey: key, status: 'pending', attempts: 0,
      maxAttempts: Math.max(1, Math.min(11, (Number.isInteger(endpoint.maxRetries) ? endpoint.maxRetries : 3) + 1)),
      nextAttemptAt: new Date(now()), createdAt: new Date(now()), updatedAt: new Date(now()) };
    await client.webhookDelivery.createMany({ data: [data], skipDuplicates: true });
    return client.webhookDelivery.findUnique({ where: { idempotencyKey: key }, select: { id: true, status: true } });
  }

  async function claim() {
    const token = crypto.randomUUID();
    // Postgres clock is authoritative. SKIP LOCKED distributes batches without
    // a process mutex; the lease token fences a worker returning after expiry.
    return prisma.$queryRawUnsafe(`WITH candidates AS (
      SELECT id FROM webhook_deliveries
      WHERE (status='pending' AND next_attempt_at<=timezone('UTC',clock_timestamp()))
         OR (status='processing' AND lease_until<timezone('UTC',clock_timestamp()))
      ORDER BY next_attempt_at, created_at LIMIT $1 FOR UPDATE SKIP LOCKED
    ) UPDATE webhook_deliveries d SET status='processing', lease_token=$2,
      lease_until=timezone('UTC',clock_timestamp())+$3*interval '1 millisecond', attempts=attempts+1,
      updated_at=timezone('UTC',clock_timestamp())
      FROM candidates c WHERE d.id=c.id
      RETURNING d.id, d.endpoint_id AS "endpointId", d.endpoint_user_id AS "endpointUserId",
        d.organization_id AS "organizationId", d.url, d.event, d.payload, d.attempts,
        d.max_attempts AS "maxAttempts", d.lease_token AS "leaseToken", d.created_at AS "createdAt"`, slots, token, leaseMs);
  }

  async function deliver(row) {
    let result;
    let retryable = true;
    try {
      if (row.attempts > row.maxAttempts) {
        result = { status: 'failed', error: 'delivery_lease_exhausted' }; retryable = false;
      } else {
        const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: row.endpointId } });
        const allowed = endpoint?.isActive && endpoint.userId === row.endpointUserId
          && (endpoint.organizationId || null) === (row.organizationId || null) && endpoint.url === row.url;
        if (!allowed) {
          result = { status: 'failed', error: 'endpoint_unavailable_or_changed' }; retryable = false;
        } else {
          result = await dispatcher.dispatch({ url: endpoint.url, event: row.event, payload: row.payload,
            secret: endpoint.secret, maxRetries: 0, _fromDLQ: true,
            headers: { 'X-SiraGPT-Delivery': row.id }, timeoutMs: 10_000 });
          if (result.httpStatus && result.httpStatus < 500 && result.httpStatus !== 429) retryable = false;
        }
      }
    } catch (err) {
      // Store only a bounded classified code. Transport messages can contain
      // target URL/query credentials and are not an admin-safe error payload.
      result = { status: 'failed', error: err?.code === 'WEBHOOK_PAYLOAD_TOO_LARGE' ? err.code : 'webhook_transport_failed' };
    }
    const ok = result?.status === 'delivered';
    const terminal = ok || !retryable || row.attempts >= row.maxAttempts;
    const data = { status: ok ? 'delivered' : terminal ? 'failed' : 'pending',
      leaseToken: null, leaseUntil: null, lastHttpStatus: result?.httpStatus || null,
      lastError: ok ? null : (['delivery_lease_exhausted', 'endpoint_unavailable_or_changed'].includes(result?.error)
        ? result.error : retryable ? 'webhook_delivery_failed' : 'webhook_nonretryable'),
      durationMs: Math.max(0, now() - new Date(row.createdAt).getTime()),
      ...(ok ? { deliveredAt: new Date(now()) } : {}),
      ...(!terminal ? { nextAttemptAt: new Date(now() + Math.min(60_000, 250 * (2 ** Math.min(row.attempts, 8)))) } : {}) };
    const updated = await prisma.webhookDelivery.updateMany({ where: { id: row.id, status: 'processing', leaseToken: row.leaseToken }, data });
    if (ok && updated.count) await prisma.webhookEndpoint.updateMany({ where: { id: row.endpointId }, data: { lastDeliveryAt: new Date(now()) } });
    return { id: row.id, updated: updated.count, status: data.status };
  }

  async function tick() {
    if (active) return active;
    active = (async () => {
      const rows = await claim();
      const results = await Promise.allSettled(rows.map(deliver));
      for (const result of results) if (result.status === 'rejected') onError(result.reason);
      return results;
    })();
    try { return await active; } finally { active = null; }
  }
  function start() {
    if (timer) return;
    stopped = false;
    const poll = () => { if (!stopped) tick().catch(onError); };
    timer = setInterval(poll, pollMs); timer.unref?.(); poll();
  }
  async function stop() { stopped = true; clearInterval(timer); timer = null; await active; }
  async function list({ limit = 100, status, event, endpointIds } = {}) {
    return prisma.webhookDelivery.findMany({ where: { ...(status ? { status } : {}), ...(event ? { event } : {}),
      ...(endpointIds ? { endpointId: { in: endpointIds } } : {}) },
      orderBy: { createdAt: 'desc' }, take: Math.max(1, Math.min(500, limit)),
      select: { id: true, endpointId: true, url: true, event: true, status: true, attempts: true,
        createdAt: true, durationMs: true, lastError: true, lastHttpStatus: true } });
  }
  async function count({ status, event, endpointIds } = {}) {
    return prisma.webhookDelivery.count({ where: { ...(status ? { status } : {}), ...(event ? { event } : {}),
      ...(endpointIds ? { endpointId: { in: endpointIds } } : {}) } });
  }
  async function get(id, endpointIds) {
    return prisma.webhookDelivery.findFirst({ where: { id, ...(endpointIds ? { endpointId: { in: endpointIds } } : {}) },
      select: { id: true, endpointId: true, event: true, status: true, url: true } });
  }
  async function endpointStats(endpointIds, windowMs = 86_400_000) {
    if (!endpointIds.length) return [];
    const rows = await prisma.$queryRawUnsafe(`SELECT endpoint_id AS "endpointId",
      COUNT(*) FILTER (WHERE status='delivered') AS delivered,
      COUNT(*) FILTER (WHERE status='failed') AS failed,
      COALESCE(percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)
        FILTER (WHERE status IN ('delivered','failed')),0) AS "p95Ms"
      FROM webhook_deliveries WHERE endpoint_id=ANY($1::text[])
        AND created_at>timezone('UTC',clock_timestamp())-$2*interval '1 millisecond' GROUP BY endpoint_id`, endpointIds, windowMs);
    return rows.map(row => ({ endpointId: row.endpointId, delivered: Number(row.delivered), failed: Number(row.failed), p95Ms: Number(row.p95Ms) }));
  }
  async function health(windowMs = 86_400_000) {
    const [row] = await prisma.$queryRawUnsafe(`SELECT
      COUNT(*) FILTER (WHERE status='delivered') AS delivered,
      COUNT(*) FILTER (WHERE status='failed') AS failed,
      COUNT(*) FILTER (WHERE status='processing' AND attempts>1) AS retrying,
      COALESCE(percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)
        FILTER (WHERE status IN ('delivered','failed')),0) AS p95
      FROM webhook_deliveries WHERE created_at>timezone('UTC',clock_timestamp())-$1*interval '1 millisecond'`, windowMs);
    const delivered24h = Number(row?.delivered || 0); const failed24h = Number(row?.failed || 0);
    return { delivered24h, failed24h, failureRate: failed24h / (delivered24h + failed24h || 1),
      p95DurationMs: Number(row?.p95 || 0), retryingNow: Number(row?.retrying || 0), windowMs, durable: true };
  }
  async function retry(id, endpointIds) {
    const result = await prisma.webhookDelivery.updateMany({ where: { id, status: 'failed',
      ...(endpointIds ? { endpointId: { in: endpointIds } } : {}) },
      data: { status: 'pending', attempts: 0, nextAttemptAt: new Date(now()), leaseToken: null, leaseUntil: null, lastError: null } });
    return result.count ? { ok: true, result: { id, status: 'pending' } } : { ok: false, reason: 'not_found' };
  }
  return { enqueue, tick, start, stop, list, count, get, endpointStats, health, retry, deliver };
}
let runtime = null;
function getWebhookOutbox(prisma, dispatcher) {
  if (!runtime) runtime = createWebhookOutbox({ prisma, dispatcher, onError: err => console.warn('[webhook-outbox]', err?.code || 'DELIVERY_FAILED') });
  return runtime;
}
function resetRuntimeForTests() { runtime = null; }
module.exports = { createWebhookOutbox, getWebhookOutbox, resetRuntimeForTests, MAX_PAYLOAD_BYTES, DEFAULT_CONCURRENCY };

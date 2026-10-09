'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createWebhookOutbox, MAX_PAYLOAD_BYTES } = require('../src/services/webhook-outbox');
const url = process.env.DOC_SANDBOX_TEST_DATABASE_URL || (process.env.CI === 'true' ? process.env.DATABASE_URL : null);
const skip = !url && 'Requires an explicitly isolated test PostgreSQL';

async function fixture(fn) {
  const target = new URL(url);
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname), 'Only isolated loopback test database');
  assert.match(target.pathname, /^\/(?:openwebui|sira20_[a-z0-9_]+|sira_upgrade_[a-z0-9_]+)$/);
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const owner = `outbox-${crypto.randomUUID()}`;
  try {
    await prisma.$executeRawUnsafe('INSERT INTO users(id,email,name,password,"updatedAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP)',
      owner, `${owner}@example.invalid`, 'Outbox synthetic fixture', 'not-a-login-password');
    const endpoint = await prisma.webhookEndpoint.create({ data: { id: `${owner}-ep`, userId: owner,
      url: 'https://receiver.example.invalid/hook', secret: 'synthetic-not-a-real-secret', events: ['test.*'], maxRetries: 2 } });
    await fn({ prisma, endpoint });
  } finally {
    await prisma.$executeRawUnsafe('DELETE FROM users WHERE id=$1', owner).catch(() => {});
    await prisma.$disconnect();
  }
}
function enqueue(box, endpoint, key, payload = { synthetic: true }) {
  return box.enqueue({ endpoint, event: 'test.completed', payload, idempotencyKey: key, publisherUserId: endpoint.userId });
}

test('durable rows survive worker replacement; duplicate publication keeps a stable delivery ID', { skip }, async () => fixture(async ({ prisma, endpoint }) => {
  const first = createWebhookOutbox({ prisma, dispatcher: { dispatch: async () => { throw new Error('old worker must not run'); } } });
  const row = await enqueue(first, endpoint, 'restart');
  const duplicate = await enqueue(first, endpoint, 'restart');
  assert.equal(duplicate.id, row.id);
  assert.equal(await prisma.webhookDelivery.count({ where: { endpointId: endpoint.id } }), 1);
  let delivery;
  const restarted = createWebhookOutbox({ prisma, dispatcher: { async dispatch(opts) { delivery = opts; return { status: 'delivered', httpStatus: 200 }; } } });
  await restarted.tick();
  const committed = await prisma.webhookDelivery.findUnique({ where: { id: row.id } });
  assert.equal(committed.status, 'delivered');
  assert.equal(committed.attempts, 1);
  assert.equal(delivery.headers['X-SiraGPT-Delivery'], row.id);
  assert.equal(delivery.maxRetries, 0);
  assert.equal(delivery.secret, endpoint.secret);
  assert.equal((await restarted.health()).delivered24h >= 1, true);
}));

test('overlapping ticks and multiple workers claim disjoint batches with bounded HTTP concurrency', { skip }, async () => fixture(async ({ prisma, endpoint }) => {
  let inFlight = 0; let peak = 0; const ids = []; const releases = [];
  const dispatcher = { dispatch(opts) {
    inFlight++; peak = Math.max(peak, inFlight); ids.push(opts.headers['X-SiraGPT-Delivery']);
    return new Promise(resolve => releases.push(() => { inFlight--; resolve({ status: 'delivered', httpStatus: 200 }); }));
  } };
  const a = createWebhookOutbox({ prisma, dispatcher, concurrency: 4 });
  const b = createWebhookOutbox({ prisma, dispatcher, concurrency: 4 });
  for (let i = 0; i < 8; i++) await enqueue(a, endpoint, `bounded-${i}`);
  const runs = [a.tick(), a.tick(), b.tick()];
  for (let i = 0; i < 100 && releases.length < 8; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(releases.length, 8);
  assert.equal(new Set(ids).size, 8);
  assert.equal(peak, 8); //4per worker, not one unbounded Promise per endpoint.
  releases.forEach(release => release());
  await Promise.all(runs);
  assert.equal(await prisma.webhookDelivery.count({ where: { endpointId: endpoint.id, status: 'delivered' } }), 8);
}));

test('an expired lease is reclaimed and late completion is fenced by lease token', { skip }, async () => fixture(async ({ prisma, endpoint }) => {
  let release; let started;
  const didStart = new Promise(resolve => { started = resolve; });
  const box = createWebhookOutbox({ prisma, dispatcher: { dispatch() { started(); return new Promise(resolve => { release = resolve; }); } } });
  const row = await enqueue(box, endpoint, 'fence');
  await prisma.webhookDelivery.update({ where: { id: row.id }, data: { status: 'processing', leaseToken: 'dead-worker', leaseUntil: new Date(0) } });
  const run = box.tick(); await didStart;
  const claimed = await prisma.webhookDelivery.findUnique({ where: { id: row.id } });
  assert.notEqual(claimed.leaseToken, 'dead-worker');
  await prisma.webhookDelivery.update({ where: { id: row.id }, data: { leaseToken: 'replacement-worker' } });
  release({ status: 'delivered', httpStatus: 200 }); await run;
  const after = await prisma.webhookDelivery.findUnique({ where: { id: row.id } });
  assert.equal(after.status, 'processing');
  assert.equal(after.leaseToken, 'replacement-worker');
}));

test('nonretryable failures are durable and sanitized; retries reuse the delivery identity', { skip }, async () => fixture(async ({ prisma, endpoint }) => {
  const box = createWebhookOutbox({ prisma, dispatcher: { dispatch: async () => ({ status: 'failed', httpStatus: 403, error: 'https://target/?secret=private' }) } });
  const row = await enqueue(box, endpoint, 'denied'); await box.tick();
  const failed = await prisma.webhookDelivery.findUnique({ where: { id: row.id } });
  assert.equal(failed.status, 'failed'); assert.equal(failed.lastError, 'webhook_nonretryable');
  assert.equal((await box.retry(row.id, ['foreign-endpoint'])).ok, false);
  assert.equal((await box.retry(row.id, [endpoint.id])).ok, true);
  assert.equal((await prisma.webhookDelivery.findUnique({ where: { id: row.id } })).status, 'pending');
}));

test('changed endpoints and exhausted leases never send the old payload to a new target', { skip }, async () => fixture(async ({ prisma, endpoint }) => {
  let calls = 0;
  const box = createWebhookOutbox({ prisma, dispatcher: { dispatch: async () => { calls++; return { status: 'delivered' }; } } });
  const changed = await enqueue(box, endpoint, 'changed');
  await prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { url: 'https://different.example.invalid/hook' } });
  await box.tick(); assert.equal(calls, 0);
  assert.equal((await prisma.webhookDelivery.findUnique({ where: { id: changed.id } })).lastError, 'endpoint_unavailable_or_changed');
  await prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { url: endpoint.url } });
  const exhausted = await enqueue(box, endpoint, 'exhausted');
  await prisma.webhookDelivery.update({ where: { id: exhausted.id }, data: { status: 'processing', leaseUntil: new Date(0), attempts: 3 } });
  await box.tick(); assert.equal(calls, 0);
  assert.equal((await prisma.webhookDelivery.findUnique({ where: { id: exhausted.id } })).lastError, 'delivery_lease_exhausted');
  await assert.rejects(enqueue(box, endpoint, 'too-big', { text: 'é'.repeat(MAX_PAYLOAD_BYTES / 2) }), { code: 'WEBHOOK_PAYLOAD_TOO_LARGE' });
  assert.equal(await box.count({ status: 'failed', endpointIds: [endpoint.id] }), 2);
}));

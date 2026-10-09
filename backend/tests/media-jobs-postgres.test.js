'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient, Prisma } = require('@prisma/client');
const { createMediaJobStore } = require('../src/services/media/job-store');

const connection = process.env.MEDIA_TEST_DATABASE_URL;
if (connection) {
  const url = new URL(connection);
  const testName = /test/i.test(url.pathname) || (process.env.CI === 'true' && url.pathname === '/openwebui');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !testName) throw new Error('Media integration tests require an explicit loopback test database');
}
const client = connection ? new PrismaClient({ datasources: { db: { url: connection } } }) : null;
const ownerIds = [];
after(async () => {
  if (!client) return;
  for (const id of ownerIds) await client.$executeRaw(Prisma.sql`DELETE FROM users WHERE id=${id}`);
  await client.$disconnect();
});
async function owner(limit = 1000) {
  const id = `media-test-${randomUUID()}`; ownerIds.push(id);
  await client.$executeRaw(Prisma.sql`INSERT INTO users(id,email,name,password,"updatedAt",plan,"monthlyLimit","apiUsage") VALUES(${id},${`${id}@invalid.test`},'Media test','not-a-login',clock_timestamp(),'PRO',${BigInt(limit)},0)`);
  return id;
}
const usage = async id => BigInt((await client.$queryRaw(Prisma.sql`SELECT "apiUsage" FROM users WHERE id=${id}`))[0].apiUsage);
const spec = (userId, key, extra = {}) => ({ userId, key, lane: 'video', kind: 'test.video', payload: { model: 'selected', prompt: 'same input' }, quotaUnits: 1000, ...extra });

test('Postgres concurrent admissions cannot overspend monthly media quota', { skip: !connection }, async () => {
  const userId = await owner(); const store = createMediaJobStore(client);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => store.admit(spec(userId, `q-${i}`))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  for (const item of results.filter(r => r.status === 'rejected')) assert.equal(item.reason.code, 'E_QUOTA');
  assert.equal(await usage(userId), 1000n);
});
test('Postgres concurrent idempotency replays reserve once; different payload conflicts', { skip: !connection }, async () => {
  const userId = await owner(3000); const store = createMediaJobStore(client);
  const results = await Promise.all(Array.from({ length: 10 }, () => store.admit(spec(userId, 'one-key'))));
  assert.equal(new Set(results.map(r => r.job.id)).size, 1);
  assert.equal(results.filter(r => r.created).length, 1);
  assert.equal(await usage(userId), 1000n);
  await assert.rejects(store.admit(spec(userId, 'one-key', { payload: { prompt: 'different' } })), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(await usage(userId), 1000n);
});
test('Postgres expired lease resumes checkpoints and fences stale completion; settlement is once', { skip: !connection }, async () => {
  const userId = await owner(); const store = createMediaJobStore(client);
  const kind = `test.${randomUUID()}`;
  await store.admit(spec(userId, 'recovery', { kind }));
  const old = await store.claim([kind], 200);
  await store.checkpoint(old, { providerRequestId: 'upstream-once', dispatchState: 'submitted' });
  await client.$executeRaw(Prisma.sql`UPDATE media_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${old.id}`);
  const fresh = await store.claim([kind]);
  assert.equal(fresh.checkpoint.providerRequestId, 'upstream-once');
  assert.notEqual(fresh.lease_token, old.lease_token);
  await assert.rejects(store.settle(old, { status: 'completed' }), { code: 'LEASE_LOST' });
  await store.settle(fresh, { status: 'completed', result: { video_url: 'persisted' }, providerCalled: true });
  await assert.rejects(store.settle(fresh, { status: 'failed' }), { code: 'LEASE_LOST' });
  assert.equal(await usage(userId), 1000n);
  const rows = await client.$queryRaw(Prisma.sql`SELECT cost,tokens FROM api_usage WHERE id=${`media-usage-${fresh.id}`}`);
  assert.equal(rows.length, 1); assert.equal(rows[0].cost, null); assert.equal(BigInt(rows[0].tokens), 0n);
  assert.equal((await store.owned(fresh.id, userId)).quota_used_units, 1000n);
});
test('Postgres cancellation refunds once and old quota epochs cannot refund a new month', { skip: !connection }, async () => {
  const userId = await owner(3000); const store = createMediaJobStore(client);
  const kind = `test.${randomUUID()}`;
  const admitted = await store.admit(spec(userId, 'cancel', { kind }));
  const job = await store.claim([kind]);
  await store.cancel(userId, admitted.job.id);
  let published = false;
  const result = await store.settle(job, { status: 'completed', result: { shouldNotAppear: true }, onCompleted: async () => { published = true; } });
  assert.equal(published, false, 'cancelled jobs cannot publish a chat result');
  assert.equal(result.status, 'cancelled'); assert.equal(result.result, null); assert.equal(await usage(userId), 0n);
  await store.admit(spec(userId, 'epoch', { kind })); const previousMonth = await store.claim([kind]);
  await client.$executeRaw(Prisma.sql`UPDATE users SET "docQuotaEpoch"="docQuotaEpoch"+1,"apiUsage"=700 WHERE id=${userId}`);
  await store.settle(previousMonth, { status: 'failed' });
  assert.equal(await usage(userId), 700n);
});
test('Postgres UTC leases stay UTC with a Lima DB session; FREE paid media is blocked; separate identical turns are not collapsed', { skip: !connection }, async () => {
  const userId = await owner(5000); const store = createMediaJobStore(client);
  const kind = `test.${randomUUID()}`;
  const [first, replay] = await Promise.all([store.admit(spec(userId, 'auto:one', { kind })), store.admit(spec(userId, 'auto:two', { kind }))]);
  assert.notEqual(first.job.id, replay.job.id); assert.equal(await usage(userId), 2000n);
  const job = await store.claim([kind]);
  assert.ok(Math.abs(Date.now() - new Date(job.created_at).getTime()) < 60000, 'stored timestamp is UTC regardless of DB timezone');
  assert.ok(new Date(job.lease_until).getTime() > Date.now(), 'Prisma lease is not five hours behind');
  await store.settle(job, { status: 'failed' });
  await store.settle(await store.claim([kind]), { status: 'failed' });
  await client.$executeRaw(Prisma.sql`UPDATE users SET plan='FREE' WHERE id=${userId}`);
  await assert.rejects(store.admit(spec(userId, 'free-blocked', { kind })), { code: 'UPGRADE_REQUIRED', status: 402 });
  assert.equal(await usage(userId), 0n);
});
test('Postgres voice admission is atomic per user and CPU claims serialize across workers', { skip: !connection }, async () => {
  const users = await Promise.all([owner(), owner()]); const store = createMediaJobStore(client);
  const kind = `test.${randomUUID()}`;
  const voice = id => spec(id, randomUUID(), { kind, lane: 'voice', quotaUnits: 0 });
  const same = await Promise.allSettled([store.admit(voice(users[0])), store.admit(voice(users[0]))]);
  assert.equal(same.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(same.find(r => r.status === 'rejected').reason.code, 'job_limit');
  await store.admit(voice(users[1]));
  const claims = await Promise.all([store.claim([kind]), store.claim([kind])]);
  assert.equal(claims.filter(Boolean).length, 1);
  await store.settle(claims.find(Boolean), { status: 'completed', result: {} });
  assert.ok(await store.claim([kind]));
});
test('Postgres partial image result releases unused commercial units without inventing provider tokens', { skip: !connection }, async () => {
  const userId = await owner(5000), store = createMediaJobStore(client), kind = `test.${randomUUID()}`;
  await store.admit(spec(userId, 'five-images', { kind, lane: 'image', quotaUnits: 5000, payload: { model: 'selected-image', count: 5 } }));
  const job = await store.claim([kind]);
  await store.settle(job, { status: 'completed', result: { imageCount: 3 }, quotaUsedUnits: 3000, providerCalled: true });
  assert.equal(await usage(userId), 3000n);
  assert.equal((await store.owned(job.id, userId)).quota_used_units, 3000n);
  assert.equal(BigInt((await client.$queryRaw(Prisma.sql`SELECT tokens FROM api_usage WHERE id=${`media-usage-${job.id}`}`))[0].tokens), 0n);
});

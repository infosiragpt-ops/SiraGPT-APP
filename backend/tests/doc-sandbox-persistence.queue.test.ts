import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { Worker, QueueEvents } from 'bullmq';
import { DocSandboxRepository } from '../src/modules/doc-sandbox/queue/repository';
import { DocSandboxQueue, DOC_QUEUE_NAME, type DocQueuePayload } from '../src/modules/doc-sandbox/queue/queue';

const pgUrl = process.env.DOC_SANDBOX_TEST_DATABASE_URL;
const redisUrl = process.env.DOC_SANDBOX_TEST_REDIS_URL;
assert.ok(pgUrl && redisUrl, 'Real isolated Postgres and Redis are required; queue integration never skips missing services');
assert.ok(['127.0.0.1', 'localhost', '[::1]', 'doc-sandbox-test-postgres'].includes(new URL(pgUrl).hostname));
assert.ok(['127.0.0.1', 'localhost', '[::1]', 'doc-sandbox-test-redis'].includes(new URL(redisUrl).hostname));
const schema = `doc_queue_test_${randomUUID().replaceAll('-', '')}`;
const scopedUrl = new URL(pgUrl);
scopedUrl.searchParams.set('schema', schema);
const admin = new PrismaClient({ datasources: { db: { url: pgUrl } } });
const db = new PrismaClient({ datasources: { db: { url: scopedUrl.toString() } } });
const repository = new DocSandboxRepository(db);
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const eventConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const workerConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const queueNotices: string[] = [];
const queue = new DocSandboxQueue(notice => queueNotices.push(notice.code), connection);
const events = new QueueEvents(DOC_QUEUE_NAME, { connection: eventConnection });
let worker: Worker<DocQueuePayload> | undefined;
let initialized = false;
const owner = 'doc-queue-fixture-owner';
const hash = 'a'.repeat(64);
async function create(ready = true) {
  const prefix = randomUUID();
  return repository.createJob({ userId: owner, idempotencyKey: prefix, payloadHash: hash, instructionsKey: `private-queue-fixture/${prefix}/instructions`, inputs: [{ kind: 'input', storageKey: `private-queue-fixture/${prefix}/input`, filename: 'fixture.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 50, sha256: hash }], modelTier: 'mechanical', promptVersion: 'test-v1', expiresAt: new Date(Date.now() + 3600_000), ready });
}
before(async () => {
  assert.match(schema, /^doc_queue_test_[a-f0-9]{32}$/);
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  initialized = true;
  await db.$executeRaw(Prisma.sql`CREATE TABLE users(id TEXT PRIMARY KEY)`);
  const migration = readFileSync(resolve(__dirname, '../prisma/migrations/20260905000000_doc_sandbox_core/migration.sql'), 'utf8');
  for (const statement of migration.replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
  await db.$executeRaw(Prisma.sql`INSERT INTO users(id) VALUES(${owner})`);
  await queue.queue.waitUntilReady();
  await events.waitUntilReady();
});
after(async () => {
  if (worker) await worker.close();
  await events.close();
  await queue.close();
  connection.disconnect();
  eventConnection.disconnect();
  workerConnection.disconnect();
  await db.$disconnect();
  if (initialized) await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.$disconnect();
});

test('real Redis payload contains only jobId and duplicate outbox dispatch creates one BullMQ job', async () => {
  const { job } = await create();
  const [pending] = await repository.pendingOutbox(1, 'enqueue');
  assert.ok(pending);
  await Promise.all([queue.enqueue(pending), queue.enqueue(pending)]);
  const delivered = await queue.queue.getJob(`doc-${pending.id}`);
  assert.ok(delivered);
  assert.deepEqual(delivered.data, { jobId: job.id });
  const payload = await connection.hget(`${queue.queue.toKey(`doc-${pending.id}`)}`, 'data');
  assert.equal(payload, JSON.stringify({ jobId: job.id }));
  assert.ok(!payload.includes('private-queue-fixture'));
  assert.ok(!payload.includes('instructions'));
  assert.equal((await repository.pendingOutbox(100, 'enqueue')).some(e => e.id === pending.id), true, 'direct enqueue has not acknowledged DB yet');
  assert.equal(await queue.dispatchOutbox(repository), 1);
  assert.equal((await repository.pendingOutbox(100, 'enqueue')).some(e => e.id === pending.id), false);
});

test('real BullMQ worker claims a durable DB lease with two duplicate deliveries but executes once', async () => {
  const { job } = await create();
  const pending = (await repository.pendingOutbox(100, 'enqueue')).find(e => e.jobId === job.id)!;
  await queue.enqueue(pending);
  const duplicateId = `doc-test-duplicate-${randomUUID()}`;
  await queue.queue.add('edit', { jobId: job.id }, { jobId: duplicateId });
  let claims = 0;
  worker = new Worker<DocQueuePayload>(DOC_QUEUE_NAME, async incoming => {
    const lease = await repository.claimAttempt(incoming.data.jobId, 60_000);
    if (lease) {
      if (incoming.data.jobId === job.id) claims += 1;
      // This suite tests delivery control only, not document validation or a paid model.
      await repository.failAttempt(lease, 'DOC_FIXTURE_CONTROL_COMPLETE', false);
    }
  }, { connection: workerConnection, concurrency: 4 });
  worker.on('error', () => queueNotices.push('DOC_WORKER_TEST_ERROR'));
  const delivered = await queue.queue.getJob(`doc-${pending.id}`);
  const duplicate = await queue.queue.getJob(duplicateId);
  assert.ok(delivered && duplicate);
  await Promise.all([delivered.waitUntilFinished(events, 10_000), duplicate.waitUntilFinished(events, 10_000)]);
  assert.equal(claims, 1);
  assert.equal((await repository.getInternal(job.id)).attempts, 1);
  await worker.close();
  worker = undefined;
});

test('unready uploads never enter Redis and queue errors do not replace DB authority', async () => {
  const { job } = await create(false);
  await queue.dispatchOutbox(repository);
  const jobs = await queue.queue.getJobs(['waiting', 'active', 'completed', 'failed']);
  assert.ok(jobs.every(queued => queued.data.jobId !== job.id));
  const { job: ready } = await create();
  const pending = (await repository.pendingOutbox(100, 'enqueue')).find(e => e.jobId === ready.id)!;
  await queue.close();
  await assert.rejects(queue.dispatchOutbox(repository));
  assert.ok((await repository.pendingOutbox(100, 'enqueue')).some(e => e.id === pending.id));
  assert.equal((await repository.getInternal(ready.id)).status, 'queued');
  assert.deepEqual(queueNotices, []);
});

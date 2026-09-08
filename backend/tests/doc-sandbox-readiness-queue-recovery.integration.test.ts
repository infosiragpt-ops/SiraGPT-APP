import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { Prisma, PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { DocSandboxRepository, DocumentRepositoryError, type AttemptLease } from '../src/modules/doc-sandbox/queue/repository';
import { DocSandboxQueue } from '../src/modules/doc-sandbox/queue/queue';
import { DocumentSandboxProcessor } from '../src/modules/doc-sandbox/queue/processor';
import { reconcileDocumentCleanup } from '../src/modules/doc-sandbox/queue/cleanup';
import { createPrivateDocumentS3Client, PrivateDocumentStorage } from '../src/modules/doc-sandbox/storage/private-storage';
import { IndependentDocumentValidator } from '../src/modules/doc-sandbox/validation';
import { AnthropicDocumentProviderClient } from '../src/modules/doc-sandbox/engine/provider-client';

// REAL INTEGRATION, deliberately separate from the unit-coverage gate.
// Requires isolated Postgres and starts its OWN loopback Redis process/database.
// No provider request, document engine, validator, DB or S3 result is mocked.
const raw = process.env.DOC_SANDBOX_TEST_DATABASE_URL;
assert.ok(raw, 'DOC_SANDBOX_TEST_DATABASE_URL must point to real isolated Postgres; missing services never skip');
const pgUrl = new URL(raw);
assert.ok(['127.0.0.1', 'localhost', '[::1]', 'doc-sandbox-test-postgres'].includes(pgUrl.hostname), 'Only isolated Postgres is allowed');
const schema = `doc_queue_recovery_${randomUUID().replaceAll('-', '')}`;
pgUrl.searchParams.set('schema', schema);
pgUrl.searchParams.set('connection_limit', '15');
const admin = new PrismaClient({ datasources: { db: { url: raw } } });
const db = new PrismaClient({ datasources: { db: { url: pgUrl.toString() } } });
const repository = new DocSandboxRepository(db);
const owner = 'synthetic-queue-recovery-owner', hash = 'a'.repeat(64);
const notices: string[] = [];
let directory: string | undefined, redisProcess: ChildProcess | undefined;
let connection: Redis | undefined, queue: DocSandboxQueue;
let schemaCreated = false;
const openedQueues: DocSandboxQueue[] = [];
const s3 = createPrivateDocumentS3Client({ endpoint: 'http://127.0.0.1:1', region: 'us-east-1', forcePathStyle: true,
  credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' } });
const storage = new PrivateDocumentStorage(s3, { bucket: 'synthetic-private', key: Buffer.alloc(32, 7), keyId: 'v1', maxBytes: 1024 });
const validator = new IndependentDocumentValidator({ image: `sha256:${'a'.repeat(64)}` });
const processor = new DocumentSandboxProcessor({ repository, storage, validator,
  engineFactory: () => { assert.fail('Cancelled/already claimed deliveries must not construct an engine'); },
}, { maxTurns: 2, maxTokens: 1000, timeoutMs: 10_000 });

async function create() {
  const prefix = randomUUID();
  return repository.createJob({ userId: owner, idempotencyKey: prefix, payloadHash: hash,
    instructionsKey: `synthetic-private/${prefix}/instructions`,
    inputs: [{ kind: 'input', storageKey: `synthetic-private/${prefix}/input`, filename: 'synthetic.txt',
      mime: 'text/plain', size: 16, sha256: hash }], modelTier: 'mechanical', requestedModel: 'synthetic-model',
    maxTokens: 1000, promptVersion: 'queue-recovery-test-v1', maxCostUsd: '0', ready: true,
    expiresAt: new Date(Date.now() + 3600_000) });
}
function newQueue(): DocSandboxQueue {
  assert.ok(connection);
  const result = new DocSandboxQueue(notice => notices.push(notice.code), connection);
  openedQueues.push(result);
  return result;
}
async function pending(jobId: string) {
  const event = (await repository.pendingOutbox(500, 'enqueue')).find(item => item.jobId === jobId);
  assert.ok(event, 'A durable unacknowledged enqueue event is required');
  return event;
}
async function stopRedis(): Promise<void> {
  const child = redisProcess;
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('DOC_FIXTURE_REDIS_STOP_TIMEOUT')); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

before(async () => {
  assert.match(schema, /^doc_queue_recovery_[a-f0-9]{32}$/);
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  await db.$executeRaw(Prisma.sql`CREATE TABLE users(id TEXT PRIMARY KEY,"deletedAt" TIMESTAMPTZ,
    plan TEXT NOT NULL DEFAULT 'PRO',"isSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
    "apiUsage" BIGINT NOT NULL DEFAULT 0,"monthlyLimit" BIGINT NOT NULL DEFAULT 10000000)`);
  const migration = readFileSync(path.resolve(__dirname, '../prisma/migrations/20260905000000_doc_sandbox_core/migration.sql'), 'utf8');
  for (const statement of migration.replace(/^--.*$/gm, '').split(';').map(value => value.trim()).filter(Boolean)) {
    await db.$executeRawUnsafe(statement);
  }
  await db.$executeRaw(Prisma.sql`INSERT INTO users(id) VALUES(${owner})`);
  directory = await mkdtemp(path.join(tmpdir(), 'doc-sandbox-queue-recovery-'));
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const address = listener.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const binary = process.env.DOC_SANDBOX_TEST_REDIS_BINARY || 'redis-server';
  redisProcess = spawn(binary, ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no',
    '--protected-mode', 'yes', '--dir', directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  const child = redisProcess;
  child.stderr?.on('data', () => undefined);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('DOC_FIXTURE_REDIS_START_TIMEOUT')); }, 5000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('DOC_FIXTURE_REDIS_UNAVAILABLE')); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`DOC_FIXTURE_REDIS_START_EXIT_${code}`)); });
    child.stdout?.on('data', data => {
      if (data.toString().includes('Ready to accept connections')) { clearTimeout(timer); resolve(); }
    });
  });
  connection = new Redis({ host: '127.0.0.1', port, maxRetriesPerRequest: null });
  queue = newQueue();
  await queue.queue.waitUntilReady();
});

after(async () => {
  try {
    for (const opened of openedQueues) await opened.close();
  } finally {
    connection?.disconnect(); s3.destroy();
    try { await stopRedis(); }
    finally {
      await db.$disconnect();
      try {
        if (schemaCreated) { assert.match(schema, /^doc_queue_recovery_[a-f0-9]{32}$/); await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); }
      } finally {
        await admin.$disconnect();
        // Only this test's freshly created private directory, after its own Redis exits.
        if (directory && (!redisProcess?.pid || redisProcess.exitCode !== null || redisProcess.signalCode !== null)) {
          await rm(directory, { recursive: true, force: true });
        }
      }
    }
  }
});

test('real Redis loss after durable acknowledgement is repaired with a new outbox delivery', async () => {
  const { job } = await create(), initial = await pending(job.id);
  await queue.dispatchOutbox(repository);
  const delivered = await queue.queue.getJob(`doc-${initial.id}`); assert.ok(delivered);
  assert.equal((await repository.pendingOutbox(500, 'enqueue')).some(event => event.id === initial.id), false);
  await delivered.remove(); // Only this fixture's exact BullMQ job, not the queue/database.
  assert.equal(await queue.queue.getJob(`doc-${initial.id}`), undefined);
  await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET updated_at=clock_timestamp()-interval '2 minutes' WHERE id=${job.id}`);
  assert.equal(await repository.recoverUndeliveredJobs(1000), 1);
  const recovered = await pending(job.id);
  assert.notEqual(recovered.id, initial.id);
  assert.equal(recovered.type, 'delivery_recovered');
  assert.equal(await queue.dispatchOutbox(repository), 1);
  const replacement = await queue.queue.getJob(`doc-${recovered.id}`); assert.ok(replacement);
  assert.deepEqual(replacement.data, { jobId: job.id });
  const leases = await Promise.all(Array.from({ length: 10 }, () => repository.claimAttempt(replacement.data.jobId, 60_000)));
  assert.equal(leases.filter(Boolean).length, 1);
  await repository.cancelOwned(job.id, owner);
});

test('deduplicated Redis entry with wrong payload cannot acknowledge the authoritative outbox', async () => {
  const { job } = await create(), event = await pending(job.id), deliveryId = `doc-${event.id}`;
  const wrong = await queue.queue.add('edit', { jobId: 'synthetic-wrong-job' }, { jobId: deliveryId });
  await assert.rejects(queue.dispatchOutbox(repository), /DOC_QUEUE_DELIVERY_UNCONFIRMED/);
  assert.equal((await pending(job.id)).id, event.id);
  assert.equal((await repository.getInternal(job.id)).status, 'queued');
  await wrong.remove();
  assert.equal(await queue.dispatchOutbox(repository), 1);
  assert.deepEqual((await queue.queue.getJob(deliveryId))?.data, { jobId: job.id });
  await repository.cancelOwned(job.id, owner);
});

test('cancelled durable delivery reaches processor but cannot claim work, inspect bytes or construct an engine', async () => {
  const { job } = await create(), event = await pending(job.id);
  await repository.cancelOwned(job.id, owner);
  const before = await repository.getInternal(job.id);
  await queue.dispatchOutbox(repository);
  const delivery = await queue.queue.getJob(`doc-${event.id}`); assert.ok(delivery);
  await processor.process(delivery.data.jobId);
  const after = await repository.getInternal(job.id);
  assert.equal(after.status, 'cancelled');
  assert.equal(after.attempts, 0);
  assert.equal(after.fence, before.fence);
  assert.equal(after.leaseToken, null);
  assert.deepEqual(after.outputKeys, []);
  assert.deepEqual(after.costReservations, []);
  assert.equal(after.costUsd, '0');
  assert.equal(after.eventSeq, before.eventSeq);
  assert.equal((await repository.artifactsOwned(job.id, owner)).length, 0);
});

test('duplicate processor deliveries cannot disturb an existing live lease or create a second session', async () => {
  const { job } = await create(), lease = await repository.claimAttempt(job.id, 60_000); assert.ok(lease);
  const before = await repository.getInternal(job.id);
  await Promise.all(Array.from({ length: 10 }, () => processor.process(job.id)));
  const after = await repository.getInternal(job.id);
  assert.equal(after.attempts, 1);
  assert.equal(after.fence, lease.fence);
  assert.equal(after.leaseToken, lease.token);
  assert.equal(after.sessionRef, null);
  assert.equal(after.eventSeq, before.eventSeq);
  assert.deepEqual(after.costReservations, []);
  await repository.cancelOwned(job.id, owner);
});

test('concurrent real queue delivery and cancellation always leave a fenced terminal DB authority', async () => {
  const { job } = await create(), event = await pending(job.id);
  const leases = await Promise.all([
    ...Array.from({ length: 10 }, () => repository.claimAttempt(job.id, 60_000)),
    queue.enqueue(event).then(() => null), repository.cancelOwned(job.id, owner).then(() => null),
  ]);
  const claimed = leases.filter((value): value is AttemptLease => value !== null);
  assert.ok(claimed.length <= 1, 'Only two valid linearizations: cancel before claim, or one claim before cancel');
  const terminal = await repository.getInternal(job.id);
  assert.equal(terminal.status, 'cancelled');
  assert.equal(terminal.leaseToken, null);
  assert.equal(terminal.attempts, claimed.length);
  for (const lease of claimed) {
    await assert.rejects(repository.heartbeat(lease, 60_000), (error: unknown) =>
      error instanceof DocumentRepositoryError && error.code === 'DOC_STALE_LEASE');
  }
  await processor.process(job.id);
  assert.equal((await repository.getInternal(job.id)).status, 'cancelled');
  assert.equal((await repository.artifactsOwned(job.id, owner)).length, 0);
});

test('cleanup events cannot be enqueued as edit deliveries', async () => {
  const { job } = await create();
  await repository.cancelOwned(job.id, owner);
  const event = (await repository.pendingOutbox(500, 'cleanup')).find(item => item.jobId === job.id); assert.ok(event);
  assert.equal(await queue.queue.getJob(`doc-${event.id}`), undefined);
  await assert.rejects(queue.enqueue(event), /DOC_INVALID_OUTBOX_EVENT/);
  assert.equal(await queue.queue.getJob(`doc-${event.id}`), undefined);
  assert.ok((await repository.pendingOutbox(500, 'cleanup')).some(item => item.id === event.id));
});

test('cancelled cleanup without remote obligations acknowledges only cleanup and retains original metadata', async () => {
  // Every fixture job is cancelled and has no provider Files/containers or paid
  // reservations. Cancellation retains inputs; only DELETE would purge S3.
  const { job } = await create(); await repository.cancelOwned(job.id, owner);
  const before = await repository.getInternal(job.id);
  const artifactsBefore = await repository.artifactsInternal(job.id);
  await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET cleanup_not_before=clock_timestamp()-interval '1 second' WHERE status='cancelled'`);
  const pendingCleanup = await repository.jobsNeedingCleanup(500);
  assert.ok(pendingCleanup.length > 0 && pendingCleanup.length <= 10);
  for (const candidate of pendingCleanup) {
    assert.equal(candidate.deletedAt, null); assert.deepEqual(candidate.providerFiles, []);
    assert.deepEqual(candidate.providerContainers, []); assert.deepEqual(candidate.costReservations, []);
  }
  const cleanupNotices: string[] = [];
  await reconcileDocumentCleanup(repository, storage, new AnthropicDocumentProviderClient('synthetic-not-a-provider-credential'),
    AbortSignal.timeout(10_000), notice => cleanupNotices.push(notice));
  assert.deepEqual(cleanupNotices, []);
  const after = await repository.getInternal(job.id);
  assert.equal(after.status, 'cancelled'); assert.equal(after.cleanupPending, false);
  assert.deepEqual(after.inputKeys, before.inputKeys);
  assert.deepEqual(after.storageKeys, before.storageKeys);
  assert.deepEqual(await repository.artifactsInternal(job.id), artifactsBefore);
  assert.equal((await repository.pendingOutbox(500, 'cleanup')).some(item => item.jobId === job.id), false);
  assert.ok((await repository.pendingOutbox(500, 'enqueue')).some(item => item.jobId === job.id), 'Cleanup must not acknowledge edit-delivery outbox rows');
});

test('closed producer leaves DB outbox pending and a fresh real queue can dispatch it', async () => {
  await queue.dispatchOutbox(repository); // Drain fixture delivery obligations left by preceding cancellation tests.
  const { job } = await create(), event = await pending(job.id);
  await queue.close();
  await assert.rejects(queue.dispatchOutbox(repository), /DOC_QUEUE_CLOSED/);
  assert.equal((await pending(job.id)).id, event.id);
  queue = newQueue(); await queue.queue.waitUntilReady();
  assert.equal(await queue.dispatchOutbox(repository), 1);
  assert.deepEqual((await queue.queue.getJob(`doc-${event.id}`))?.data, { jobId: job.id });
  assert.equal((await repository.pendingOutbox(500, 'enqueue')).some(item => item.id === event.id), false);
  assert.deepEqual(notices, []);
  await repository.cancelOwned(job.id, owner);
});

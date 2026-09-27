import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { DocumentProviderClient } from '../src/modules/doc-sandbox/engine/provider-client';
import { CLEANUP_RETRY_BASE_MS, CLEANUP_RETRY_MAX_MS, DocumentCleanupBackoff, cleanupRetryDelayMs,
  documentFailureReason, reconcileDocumentCleanup, type DocumentNoticeDetail } from '../src/modules/doc-sandbox/queue/cleanup';
import { DocumentRepositoryError, type DocSandboxRepository } from '../src/modules/doc-sandbox/queue/repository';
import { createPrivateDocumentS3Client, PrivateDocumentStorage } from '../src/modules/doc-sandbox/storage/private-storage';
import { DocSandboxError } from '../src/modules/doc-sandbox/types/errors';
const { documentNoticeFields } = require('../src/services/doc-sandbox-module');

// Production 2026-09-27: one deleted job was retried every 30 s for days and
// every pass logged a bare `DOC_CLEANUP_PENDING`; the real cause (ENOTFOUND on a
// virtual-hosted MinIO bucket) was swallowed. These pin the retry schedule and
// the log-safe reason classes. The durable deferral itself runs against real
// PostgreSQL/MinIO in doc-sandbox-cleanup-pagination.integration.test.ts.

test('cleanup retries double from 30 s and cap at 1 h', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 50].map(cleanupRetryDelayMs),
    [30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000, 3_600_000]);
  for (const odd of [0, -3, Number.NaN]) assert.equal(cleanupRetryDelayMs(odd), CLEANUP_RETRY_BASE_MS);
  assert.equal(cleanupRetryDelayMs(Number.MAX_SAFE_INTEGER), CLEANUP_RETRY_MAX_MS);
});

test('backoff counts consecutive failures per job, restarts after a success and stays bounded', () => {
  const backoff = new DocumentCleanupBackoff(2);
  assert.equal(backoff.failed('job-a'), 30_000);
  assert.equal(backoff.failed('job-a'), 60_000);
  assert.equal(backoff.failed('job-b'), 30_000);
  assert.equal(backoff.count('job-a'), 2);
  backoff.succeeded('job-a');
  assert.equal(backoff.count('job-a'), 0);
  assert.equal(backoff.failed('job-a'), 30_000, 'a completed cleanup restarts the schedule');
  backoff.failed('job-c'); // over the bound: the least recently failed job is forgotten
  assert.equal(backoff.count('job-b'), 0);
  assert.equal(backoff.count('job-a'), 1);
  assert.equal(backoff.count('job-c'), 1);
});

test('network failures are reported by code, never with the bucket host from the message', async () => {
  const refused = createPrivateDocumentS3Client({ region: 'us-east-1', endpoint: 'http://127.0.0.1:1', forcePathStyle: true,
    credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' } });
  try {
    const error = await refused.send(new ListObjectsV2Command({ Bucket: 'synthetic-bucket', Prefix: 'owner/job/' }))
      .then(() => undefined, (failure: unknown) => failure);
    assert.equal(documentFailureReason(error), 'ECONNREFUSED');
  } finally { refused.destroy(); }
  // The exact production shape: the host in the message names the private bucket.
  const lookup = Object.assign(new Error('getaddrinfo ENOTFOUND siragpt-doc-sandbox.siragpt-doc-minio'),
    { code: 'ENOTFOUND', $metadata: { attempts: 1, totalRetryDelay: 0 } });
  assert.equal(documentFailureReason(lookup), 'ENOTFOUND');
});

test('S3 error responses are reported by status and error code, never by their body', async (t) => {
  const server = createServer((req, res) => {
    const denied = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('prefix') === 'owner/denied/';
    res.writeHead(denied ? 403 : 503, { 'Content-Type': 'application/xml', Connection: 'close' });
    res.end(denied
      ? '<Error><Code>AccessDenied</Code><Message>owner/denied/v1/private-name.sealed</Message></Error>'
      : 'upstream unavailable for owner/busy/v1/private-name.sealed');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = createPrivateDocumentS3Client({ region: 'us-east-1', endpoint: `http://127.0.0.1:${address.port}`,
    forcePathStyle: true, credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' } });
  try {
    const list = (prefix: string) => client.send(new ListObjectsV2Command({ Bucket: 'synthetic-bucket', Prefix: prefix }))
      .then(() => undefined, (failure: unknown) => failure);
    assert.equal(documentFailureReason(await list('owner/denied/')), 's3_403:AccessDenied');
    assert.match(documentFailureReason(await list('owner/busy/')), /^s3_503(?::[A-Za-z][A-Za-z0-9_.-]*)?$/);
  } finally { client.destroy(); }
});

test('deadlines, cancellation and domain errors keep their own class; anything else is unknown', async () => {
  const deadline = AbortSignal.timeout(1);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(documentFailureReason(deadline.reason), 'timeout');
  const controller = new AbortController();
  controller.abort();
  assert.equal(documentFailureReason(controller.signal.reason), 'aborted');
  assert.equal(documentFailureReason(new DocumentRepositoryError('DOC_CLEANUP_PENDING')), 'DOC_CLEANUP_PENDING');
  assert.equal(documentFailureReason(new DocSandboxError('E_NOT_READY', 503)), 'E_NOT_READY');
  assert.equal(documentFailureReason(new Error('owner/job/v1/private-name.sealed')), 'unknown');
  assert.equal(documentFailureReason(Object.assign(new Error('x'), { code: 'not a code/with path' })), 'unknown');
  for (const value of [undefined, null, 'ENOTFOUND', 42]) assert.equal(documentFailureReason(value), 'unknown');
});

test('module notices log only allow-listed, well-formed detail fields', () => {
  assert.deepEqual(documentNoticeFields('DOC_CLEANUP_PENDING', { jobId: '25b7a21e-497f-4595-b95b-c44a5596db3f',
    stage: 'storage_delete', reason: 'ENOTFOUND', retryInMs: 30_000 }), { code: 'DOC_CLEANUP_PENDING',
    jobId: '25b7a21e-497f-4595-b95b-c44a5596db3f', stage: 'storage_delete', reason: 'ENOTFOUND', retryInMs: 30_000 });
  assert.deepEqual(documentNoticeFields('DOC_CLEANUP_PENDING', { stage: 'scan', reason: 's3_403:AccessDenied' }),
    { code: 'DOC_CLEANUP_PENDING', stage: 'scan', reason: 's3_403:AccessDenied' });
  assert.deepEqual(documentNoticeFields('not a code', { jobId: '../etc/passwd', stage: 'Storage Delete',
    reason: 'getaddrinfo ENOTFOUND bucket.host', retryInMs: 1.5, message: 'free text' }), { code: 'DOC_MODULE_ERROR' });
  assert.deepEqual(documentNoticeFields('DOC_WORKER_ERROR'), { code: 'DOC_WORKER_ERROR' });
});

// Control flow of one cleanup pass: which stage failed, what is reported and
// what is deferred. The repository double only records calls; the durable
// deferral and deletion semantics run against real PostgreSQL/MinIO in
// doc-sandbox-cleanup-pagination.integration.test.ts. Storage is the real
// private store pointed at a closed port, so its failure is a real ECONNREFUSED.
const unreachable = createPrivateDocumentS3Client({ region: 'us-east-1', endpoint: 'http://127.0.0.1:1', forcePathStyle: true,
  credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' } });
after(() => unreachable.destroy());
const storage = new PrivateDocumentStorage(unreachable, { bucket: 'synthetic-bucket', key: Buffer.alloc(32, 7), keyId: 'v1', maxBytes: 1024 });
const idleProvider = { delete: async () => undefined } as unknown as DocumentProviderClient;
const deletedJob = { id: 'job-1', userId: 'owner-1', deletedAt: new Date(0), cleanupNotBefore: null,
  storageKeys: ['doc-sandbox/owner-1/job-1/v1/original.sealed'], purgedKeys: [] as string[] };
const retainedJob = { id: 'job-2', userId: 'owner-2', deletedAt: null, cleanupNotBefore: null, storageKeys: [] as string[], purgedKeys: [] as string[] };

function cleanupPass(jobs: object[], overrides: Record<string, unknown> = {}) {
  const calls = { deferred: [] as Array<[string, number]>, finished: [] as string[], acknowledged: [] as string[] };
  const repository = {
    jobsNeedingCleanup: async () => jobs,
    providerFilesForCleanup: async () => [],
    markProviderFileDeleted: async () => undefined,
    markStorageKeysPurged: async () => undefined,
    artifactsInternal: async () => [],
    finishCleanup: async (id: string) => { calls.finished.push(id); return true; },
    deferCleanup: async (id: string, delayMs: number) => { calls.deferred.push([id, delayMs]); },
    pendingOutbox: async () => [],
    getInternal: async (id: string) => ({ id, cleanupPending: false }),
    acknowledgeOutbox: async (id: string) => { calls.acknowledged.push(id); },
    ...overrides,
  } as unknown as DocSandboxRepository;
  const notices: Array<{ code: string; detail?: DocumentNoticeDetail }> = [];
  const notice = (code: string, detail?: DocumentNoticeDetail): void => { notices.push({ code, detail }); };
  return { repository, calls, notices, notice };
}

test('a failing job is reported with its stage and reason and deferred on the doubling schedule', async () => {
  const pass = cleanupPass([deletedJob]);
  const backoff = new DocumentCleanupBackoff();
  for (let round = 0; round < 2; round += 1) {
    await reconcileDocumentCleanup(pass.repository, storage, idleProvider, new AbortController().signal, pass.notice, backoff);
  }
  assert.deepEqual(pass.notices, [30_000, 60_000].map(retryInMs => ({ code: 'DOC_CLEANUP_PENDING',
    detail: { jobId: 'job-1', stage: 'storage_delete', reason: 'ECONNREFUSED', retryInMs } })));
  assert.deepEqual(pass.calls.deferred, [['job-1', 30_000], ['job-1', 60_000]]);
  assert.deepEqual(pass.calls.finished, []);
});

test('a completed cleanup restarts the schedule; provider leftovers and the outbox keep their contracts', async () => {
  const marked: Array<[string, string, boolean]> = [];
  const pass = cleanupPass([retainedJob], {
    providerFilesForCleanup: async () => [{ fileId: 'file-ok' }, { fileId: 'file-stuck' }],
    markProviderFileDeleted: async (jobId: string, fileId: string, deleted: boolean) => { marked.push([jobId, fileId, deleted]); },
    pendingOutbox: async () => [{ id: 'event-1', jobId: 'job-2' }],
  });
  const provider = { delete: async (fileId: string) => { if (fileId === 'file-stuck') throw new Error('provider refused'); } } as unknown as DocumentProviderClient;
  const backoff = new DocumentCleanupBackoff();
  backoff.failed('job-2'); backoff.failed('job-2');
  await reconcileDocumentCleanup(pass.repository, storage, provider, new AbortController().signal, pass.notice, backoff);
  assert.equal(backoff.count('job-2'), 0);
  assert.deepEqual(pass.calls.finished, ['job-2']);
  assert.deepEqual(marked, [['job-2', 'file-ok', true], ['job-2', 'file-stuck', false]]);
  assert.deepEqual(pass.notices, [{ code: 'DOC_PROVIDER_CLEANUP_PENDING', detail: undefined }]);
  assert.deepEqual(pass.calls.acknowledged, ['event-1']);
  assert.deepEqual(pass.calls.deferred, []);
});

test('callers without a backoff keep retrying every pass but still learn the reason', async () => {
  const pass = cleanupPass([deletedJob]);
  await reconcileDocumentCleanup(pass.repository, storage, idleProvider, new AbortController().signal, pass.notice);
  assert.deepEqual(pass.notices, [{ code: 'DOC_CLEANUP_PENDING',
    detail: { jobId: 'job-1', stage: 'storage_delete', reason: 'ECONNREFUSED' } }]);
  assert.deepEqual(pass.calls.deferred, []);
});

test('a failed deferral still reports the job, and shutting down is not a cleanup failure', async () => {
  const pass = cleanupPass([deletedJob], { deferCleanup: async () => { throw new Error('database unavailable'); } });
  await reconcileDocumentCleanup(pass.repository, storage, idleProvider, new AbortController().signal, pass.notice, new DocumentCleanupBackoff());
  assert.equal(pass.notices.length, 1);
  assert.equal(pass.notices[0]!.detail?.retryInMs, 30_000);

  const shutdown = new AbortController();
  const stopping = cleanupPass([retainedJob], {
    providerFilesForCleanup: async () => { shutdown.abort(); throw new Error('interrupted by shutdown'); },
  });
  const backoff = new DocumentCleanupBackoff();
  await reconcileDocumentCleanup(stopping.repository, storage, idleProvider, shutdown.signal, stopping.notice, backoff);
  assert.deepEqual(stopping.notices, []);
  assert.deepEqual(stopping.calls.deferred, []);
  assert.equal(backoff.count('job-2'), 0);
});


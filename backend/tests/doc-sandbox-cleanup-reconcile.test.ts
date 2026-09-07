import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileDocumentCleanup } from '../src/modules/doc-sandbox/queue/cleanup';
import type { DocSandboxRepository, StoredArtifact, StoredDocumentJob } from '../src/modules/doc-sandbox/queue/repository';
import type { PrivateDocumentStorage } from '../src/modules/doc-sandbox/storage/private-storage';
import type { DocumentProviderClient } from '../src/modules/doc-sandbox/engine/provider-client';

// Mocked repository/storage/provider only. This does not open MinIO, Redis,
// PostgreSQL or a remote Files API; those remain in the isolated suites.
function job(overrides: Partial<StoredDocumentJob> = {}): StoredDocumentJob {
  return {
    id: 'cleanup-job', userId: 'owner-1', status: 'cancelled', admissionReady: true,
    mode: 'preserve', engine: 'anthropic', modelTier: 'mechanical', requestedModel: 'synthetic',
    tokenBudget: 1000, instructionsKey: 'doc-sandbox/owner-1/cleanup-job/v1/ins.sealed',
    inputKeys: ['doc-sandbox/owner-1/cleanup-job/v1/in.sealed'], outputKeys: [],
    editPlanKey: null, editPlanHash: null, validationReportKey: null, errorCode: null,
    usage: {}, costUsd: '0', maxCostUsd: '1', costReservations: [], purgedKeys: [],
    storageKeys: ['doc-sandbox/owner-1/cleanup-job/v1/ins.sealed', 'doc-sandbox/owner-1/cleanup-job/v1/in.sealed'],
    outcome: null, attempts: 1, fence: 1, leaseToken: null, leaseExpiresAt: null, eventSeq: 1,
    sessionRef: null, providerFiles: [{ fileId: 'file_one', attempt: 1, deleted: false, failures: 0 }],
    providerContainers: [], cleanupPending: true, cleanupNotBefore: null, parentJobId: null,
    promptVersion: 'v1', createdAt: new Date(0), startedAt: new Date(0), finishedAt: new Date(1),
    expiresAt: new Date(Date.now() + 60_000), deletedAt: new Date(0), ...overrides,
  };
}

function artifact(overrides: Partial<StoredArtifact> = {}): StoredArtifact {
  return {
    id: 'art-1', jobId: 'cleanup-job', attempt: 1, kind: 'input',
    storageKey: 'doc-sandbox/owner-1/cleanup-job/v1/in.sealed', filename: 'in.txt',
    mime: 'text/plain', size: 4, sha256: 'a'.repeat(64), published: false, purgedAt: null, ...overrides,
  };
}

test('cleanup is a no-op when no jobs or leftover cleanup outbox remain', async () => {
  const notices: string[] = [];
  const repository = {
    jobsNeedingCleanup: async () => [],
    pendingOutbox: async () => [],
  } as unknown as DocSandboxRepository;
  await reconcileDocumentCleanup(repository, {} as PrivateDocumentStorage, {} as DocumentProviderClient,
    new AbortController().signal, code => notices.push(code));
  assert.deepEqual(notices, []);
});

test('provider delete success and failure are journaled without treating storage as finished', async () => {
  const notices: string[] = [];
  const marked: Array<[string, string, boolean]> = [];
  const current = job({ deletedAt: null, storageKeys: [] });
  const repository = {
    jobsNeedingCleanup: async () => [current],
    providerFilesForCleanup: async () => current.providerFiles,
    markProviderFileDeleted: async (jobId: string, fileId: string, succeeded: boolean) => {
      marked.push([jobId, fileId, succeeded]);
    },
    finishCleanup: async () => true,
    pendingOutbox: async () => [],
  } as unknown as DocSandboxRepository;
  const provider = {
    delete: async (id: string) => { if (id === 'file_bad') throw new Error('remote'); },
  } as unknown as DocumentProviderClient;
  current.providerFiles = [
    { fileId: 'file_ok', attempt: 1, deleted: false, failures: 0 },
    { fileId: 'file_bad', attempt: 1, deleted: false, failures: 0 },
  ];
  await reconcileDocumentCleanup(repository, {} as PrivateDocumentStorage, provider,
    new AbortController().signal, code => notices.push(code));
  assert.deepEqual(marked, [['cleanup-job', 'file_ok', true], ['cleanup-job', 'file_bad', false]]);
  assert.deepEqual(notices, ['DOC_PROVIDER_CLEANUP_PENDING']);
});

test('deleted jobs purge known keys in batches, then LIST pages, then leftover artifacts', async () => {
  const removed: string[] = [];
  const reserved: string[][] = [];
  const purged: string[][] = [];
  const artifactIds: string[] = [];
  const known = Array.from({ length: 101 }, (_, index) => `doc-sandbox/owner-1/cleanup-job/v1/k${index}.sealed`);
  const listed = ['doc-sandbox/owner-1/cleanup-job/v1/late.sealed'];
  const current = job({ storageKeys: known, purgedKeys: [known[0]!] });
  let pages = 0;
  const repository = {
    jobsNeedingCleanup: async () => [current],
    providerFilesForCleanup: async () => [],
    markStorageKeysPurged: async (_id: string, keys: string[]) => { purged.push([...keys]); },
    reserveCleanupStorageKeys: async (_id: string, keys: string[]) => { reserved.push([...keys]); },
    artifactsInternal: async () => [artifact(), artifact({ id: 'art-2', purgedAt: new Date(1) })],
    markArtifactPurged: async (_id: string, artifactId: string) => { artifactIds.push(artifactId); },
    finishCleanup: async () => true,
    pendingOutbox: async () => [],
  } as unknown as DocSandboxRepository;
  const storage = {
    remove: async (_scope: unknown, key: string) => { removed.push(key); },
    iterPages: async function* () {
      pages += 1;
      if (pages === 1) yield listed;
      else yield [];
    },
  } as unknown as PrivateDocumentStorage;
  await reconcileDocumentCleanup(repository, storage, { delete: async () => undefined } as unknown as DocumentProviderClient,
    new AbortController().signal, () => assert.fail('unexpected notice'));
  assert.equal(removed.length, 101);
  assert.ok(purged.some(batch => batch.length === 100));
  assert.deepEqual(reserved, [listed]);
  assert.deepEqual(artifactIds, ['art-1']);
});

test('a write behind the LIST cursor is reported as pending cleanup, not success', async () => {
  const notices: string[] = [];
  const current = job({ storageKeys: [], providerFiles: [] });
  let pass = 0;
  const repository = {
    jobsNeedingCleanup: async () => [current],
    providerFilesForCleanup: async () => [],
    reserveCleanupStorageKeys: async () => undefined,
    finishCleanup: async () => assert.fail('must not finish after a late object'),
    pendingOutbox: async () => [],
  } as unknown as DocSandboxRepository;
  const storage = {
    remove: async () => undefined,
    iterPages: async function* () {
      pass += 1;
      if (pass === 1) yield [];
      else yield ['doc-sandbox/owner-1/cleanup-job/v1/late.sealed'];
    },
  } as unknown as PrivateDocumentStorage;
  await reconcileDocumentCleanup(repository, storage, { delete: async () => undefined } as unknown as DocumentProviderClient,
    new AbortController().signal, code => notices.push(code));
  assert.deepEqual(notices, ['DOC_CLEANUP_PENDING']);
});

test('grace-gated tombstones skip object deletion but still attempt finishCleanup', async () => {
  let finished = 0;
  const current = job({
    deletedAt: new Date(),
    cleanupNotBefore: new Date(Date.now() + 60_000),
    storageKeys: ['doc-sandbox/owner-1/cleanup-job/v1/in.sealed'],
    providerFiles: [],
  });
  const repository = {
    jobsNeedingCleanup: async () => [current],
    providerFilesForCleanup: async () => [],
    finishCleanup: async () => { finished += 1; return false; },
    pendingOutbox: async () => [],
  } as unknown as DocSandboxRepository;
  await reconcileDocumentCleanup(repository, {
    remove: async () => assert.fail('grace window must skip storage'),
    iterPages: async function* () { yield []; },
  } as unknown as PrivateDocumentStorage, { delete: async () => undefined } as unknown as DocumentProviderClient,
    new AbortController().signal, () => assert.fail('unexpected notice'));
  assert.equal(finished, 1);
});

test('already-acked cleanup outbox stays queued; idle jobs are acknowledged', async () => {
  const acked: string[] = [];
  const repository = {
    jobsNeedingCleanup: async () => [],
    pendingOutbox: async () => [
      { id: 'evt-pending', jobId: 'job-a', seq: 1, type: 'cleanup_pending', payload: {}, createdAt: new Date(), outbox: 'cleanup' },
      { id: 'evt-idle', jobId: 'job-b', seq: 1, type: 'cleanup_pending', payload: {}, createdAt: new Date(), outbox: 'cleanup' },
    ],
    getInternal: async (id: string) => job({ id, cleanupPending: id === 'job-a' }),
    acknowledgeOutbox: async (id: string) => { acked.push(id); },
  } as unknown as DocSandboxRepository;
  await reconcileDocumentCleanup(repository, {} as PrivateDocumentStorage, {} as DocumentProviderClient,
    new AbortController().signal, () => assert.fail('unexpected notice'));
  assert.deepEqual(acked, ['evt-idle']);
});

test('an aborted signal during a deleted-job pass is reported as pending, not thrown', async () => {
  const notices: string[] = [];
  const controller = new AbortController();
  const current = job({ providerFiles: [], storageKeys: ['doc-sandbox/owner-1/cleanup-job/v1/in.sealed'] });
  const repository = {
    jobsNeedingCleanup: async () => [current],
    providerFilesForCleanup: async () => { controller.abort(); return []; },
    finishCleanup: async () => true,
    pendingOutbox: async () => [],
  } as unknown as DocSandboxRepository;
  await reconcileDocumentCleanup(repository, {
    remove: async () => undefined,
    iterPages: async function* () { yield []; },
  } as unknown as PrivateDocumentStorage, { delete: async () => undefined } as unknown as DocumentProviderClient,
    controller.signal, code => notices.push(code));
  assert.deepEqual(notices, ['DOC_CLEANUP_PENDING']);
});

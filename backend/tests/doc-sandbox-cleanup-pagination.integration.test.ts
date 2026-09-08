import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { Prisma } from '@prisma/client';
import { AnthropicDocumentProviderClient } from '../src/modules/doc-sandbox/engine/provider-client';
import { reconcileDocumentCleanup } from '../src/modules/doc-sandbox/queue/cleanup';
import { DocumentRepositoryError } from '../src/modules/doc-sandbox/queue/repository';
import { createPrivateDocumentS3Client, PrivateDocumentStorage, type PrivateObject, type StorageScope } from '../src/modules/doc-sandbox/storage/private-storage';
import { DocSandboxError } from '../src/modules/doc-sandbox/types/errors';
import { createDocumentIntegrationFixture, type DocumentIntegrationFixture } from './doc-sandbox-integration-fixture';

// PostgreSQL and S3 are real isolated services. No engine, validator, provider,
// Redis, Docker substitute, or unit-coverage instrumentation is involved here.
// The real provider client is unused: every job has zero provider references.
const ORPHANS = 10_001;
const CONCURRENCY = 32;

async function seedJob(fixture: DocumentIntegrationFixture, signal: AbortSignal) {
  const id = randomUUID();
  const scope = { userId: fixture.owner, jobId: id };
  const originalBytes = Buffer.from('Synthetic original retained until confirmed deletion.');
  const instructionBytes = Buffer.from('Synthetic cleanup test; no model request.');
  const original = fixture.storage.prepare(scope, originalBytes);
  const instructions = fixture.storage.prepare(scope, instructionBytes);
  await fixture.repository.createJob({ id, userId: fixture.owner, idempotencyKey: randomUUID(),
    payloadHash: original.sha256, instructionsKey: instructions.key, requestedModel: 'fixture-mechanical',
    modelTier: 'mechanical', maxTokens: 1000, maxCostUsd: '0', promptVersion: 'fixture-cleanup-pagination',
    expiresAt: new Date(Date.now() + 86_400_000), ready: false,
    inputs: [{ kind: 'input', storageKey: original.key, filename: 'original.txt', mime: 'text/plain',
      size: originalBytes.length, sha256: original.sha256 }] });
  await fixture.storage.putPrepared(scope, original, originalBytes, signal);
  await fixture.storage.putPrepared(scope, instructions, instructionBytes, signal);
  assert.deepEqual(await fixture.storage.get(scope, original.key, original.sha256, signal), originalBytes);
  assert.deepEqual(await fixture.storage.get(scope, instructions.key, instructions.sha256, signal), instructionBytes);
  const neighborScope = { userId: fixture.other, jobId: randomUUID() };
  const neighborBytes = Buffer.from('Other owner: this object must never be deleted by the tested cleanup.');
  const neighbor = fixture.storage.prepare(neighborScope, neighborBytes);
  await fixture.storage.putPrepared(neighborScope, neighbor, neighborBytes, signal);
  return { id, scope, original, originalBytes, instructions, neighborScope, neighborBytes, neighbor };
}

async function expireOnlyThisTombstone(fixture: DocumentIntegrationFixture, id: string) {
  await fixture.repository.deleteOwned(id, fixture.owner);
  // Advance the durable grace of this synthetic job only, never a service clock.
  await fixture.db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET cleanup_not_before=clock_timestamp()-interval '1 second' WHERE id=${id}`);
  const job = await fixture.repository.getInternal(id);
  assert.ok(job.deletedAt);
  assert.equal(job.cleanupPending, true);
  assert.deepEqual(job.providerFiles, []);
  assert.ok((await fixture.repository.pendingOutbox(100, 'cleanup')).some(event => event.jobId === id));
}

/** Independent S3 observation, not the bounded aggregate storage.list under test. */
async function remoteKeys(fixture: DocumentIntegrationFixture, scope: StorageScope, signal: AbortSignal): Promise<Set<string>> {
  const prefix = fixture.storage.prefix(scope);
  const keys = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 16; page += 1) {
    const result = await fixture.s3.send(new ListObjectsV2Command({ Bucket: fixture.bucket,
      Prefix: prefix, MaxKeys: 1000, ContinuationToken: cursor }), { abortSignal: signal });
    for (const item of result.Contents ?? []) {
      const key = item.Key;
      assert.ok(typeof key === 'string' && key.startsWith(prefix), 'real LIST must stay inside this job');
      assert.ok(!keys.has(key), 'real LIST cannot repeat an object');
      keys.add(key);
    }
    assert.ok(keys.size <= ORPHANS + 2, 'fixture observation cannot grow beyond its explicit bound');
    if (!result.IsTruncated) return keys;
    cursor = result.NextContinuationToken;
    assert.ok(cursor && !cursors.has(cursor), 'real LIST must advance its continuation token');
    cursors.add(cursor);
  }
  assert.fail('real LIST exceeded the fixture page bound');
}

test('real cleanup advances and finishes beyond 10000 encrypted objects without deleting another owner', { timeout: 180_000 }, async t => {
  const fixture = await createDocumentIntegrationFixture();
  try {
    const signal = AbortSignal.any([t.signal, AbortSignal.timeout(175_000)]);
    const job = await seedJob(fixture, signal);
    const bytes = Buffer.from('Synthetic unregistered encrypted evidence.');
    const objects = Array.from({ length: ORPHANS }, () => fixture.storage.prepare(job.scope, bytes));
    const uploadAbort = new AbortController();
    const uploadSignal = AbortSignal.any([signal, uploadAbort.signal]);
    let index = 0;
    const uploads = await Promise.allSettled(Array.from({ length: CONCURRENCY }, async () => {
      try {
        for (;;) {
          uploadSignal.throwIfAborted();
          const next = index++;
          if (next >= objects.length) return;
          // Simulates orphan bytes left by a crash after the actual PUT. They are
          // deliberately absent from the PostgreSQL storage-key journal.
          await fixture.storage.putPrepared(job.scope, objects[next]!, bytes, uploadSignal);
        }
      } catch { uploadAbort.abort(); throw new Error('Synthetic encrypted upload did not complete'); }
    }));
    assert.ok(uploads.every(result => result.status === 'fulfilled'), 'all bounded upload workers must settle successfully');
    const raw = await fixture.s3.send(new GetObjectCommand({ Bucket: fixture.bucket, Key: objects[0]!.key }), { abortSignal: signal });
    assert.ok(raw.Body);
    const sealed = Buffer.from(await raw.Body.transformToByteArray());
    assert.equal(sealed.subarray(0, 8).toString(), 'SIRADOC1');
    assert.equal(sealed.length, bytes.length + 36);
    assert.equal(sealed.includes(bytes), false);
    assert.deepEqual(await fixture.storage.get(job.scope, objects[0]!.key, objects[0]!.sha256, signal), bytes);
    const expected = new Set([job.original.key, job.instructions.key, ...objects.map(object => object.key)]);
    let remaining = await remoteKeys(fixture, job.scope, signal);
    assert.equal(remaining.size, ORPHANS + 2);
    assert.ok([...expected].every(key => remaining.has(key)), 'all expected objects must actually exist in S3');
    // Preserve the existing aggregate API's memory guard. Cleanup must bypass
    // aggregate accumulation, not weaken this contract to make the test pass.
    await assert.rejects(fixture.storage.list(job.scope, signal),
      (error: unknown) => error instanceof DocSandboxError && error.code === 'E_CONFLICT');
    await expireOnlyThisTombstone(fixture, job.id);
    const provider = new AnthropicDocumentProviderClient('fixture-unused-no-provider');
    const notices: string[] = [];
    let purgedCount = 0;
    let cleanupPending = true;
    for (let round = 1; round <= 4 && (remaining.size > 0 || cleanupPending); round += 1) {
      signal.throwIfAborted();
      const previousCount = remaining.size;
      await reconcileDocumentCleanup(fixture.repository, fixture.storage, provider,
        AbortSignal.any([signal, AbortSignal.timeout(30_000)]), code => notices.push(code));
      remaining = await remoteKeys(fixture, job.scope, signal);
      const state = await fixture.repository.getInternal(job.id);
      t.diagnostic(`cleanup round=${round} remaining=${remaining.size} recordedPurged=${state.purgedKeys.length}`);
      if (previousCount > 0) {
        assert.ok(remaining.size < previousCount && state.purgedKeys.length > purgedCount,
          `cleanup must make real progress after the aggregate E_CONFLICT control (round=${round}, removed=${previousCount - remaining.size}, recordedPurged=${state.purgedKeys.length})`);
      } else {
        // A deadline can land after the last DELETE but before its durable
        // acknowledgement/finishCleanup. Permit that final pass, not a stall.
        assert.equal(remaining.size, 0);
        assert.ok(state.purgedKeys.length > purgedCount || !state.cleanupPending,
          'an empty-prefix pass must still advance durable acknowledgement or finish cleanup');
      }
      assert.ok(state.purgedKeys.every(key => expected.has(key) && !remaining.has(key)),
        'a recorded purge must belong to this job and already be absent remotely');
      purgedCount = state.purgedKeys.length;
      cleanupPending = state.cleanupPending;
      if (remaining.size || cleanupPending) {
        assert.equal(state.cleanupPending, true, 'partial cleanup must remain pending');
        assert.ok((await fixture.repository.pendingOutbox(100, 'cleanup')).some(event => event.jobId === job.id),
          'a partial pass must not acknowledge cleanup');
      }
    }
    assert.equal(remaining.size, 0, 'four bounded passes must finish the exact synthetic prefix');
    const state = await fixture.repository.getInternal(job.id);
    assert.equal(state.purgedKeys.length, expected.size);
    assert.equal(new Set(state.purgedKeys).size, expected.size);
    assert.equal(state.cleanupPending, false);
    assert.deepEqual(state.outputKeys, []);
    assert.deepEqual(state.providerFiles, []);
    assert.ok((await fixture.repository.artifactsInternal(job.id)).every(artifact => artifact.purgedAt && !artifact.published));
    assert.equal((await fixture.repository.pendingOutbox(100, 'cleanup')).some(event => event.jobId === job.id), false);
    assert.deepEqual(await fixture.storage.get(job.neighborScope, job.neighbor.key, job.neighbor.sha256, signal), job.neighborBytes);
    assert.ok(notices.every(code => code === 'DOC_CLEANUP_PENDING'), 'no unexpected provider cleanup path may run');
  } finally { await fixture.close(); }
});

async function journalSnapshot(fixture: DocumentIntegrationFixture, id: string) {
  return { job: await fixture.repository.getInternal(id), artifacts: await fixture.repository.artifactsInternal(id),
    rowClock: await fixture.db.$queryRaw<Array<{ updatedAt: Date }>>(Prisma.sql`SELECT updated_at AS "updatedAt" FROM doc_jobs WHERE id=${id}`),
    events: await fixture.db.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`SELECT id,seq,type,payload,outbox,dispatched_at FROM doc_job_events WHERE job_id=${id} ORDER BY seq`) };
}

function withoutJournalFields(snapshot: Awaited<ReturnType<typeof journalSnapshot>>) {
  const { storageKeys: _storage, purgedKeys: _purged, cleanupPending: _pending, ...job } = snapshot.job;
  return { ...snapshot, job };
}

test('real cleanup journal rejects unsafe admission atomically and accepts the exact 1000-key boundary', { timeout: 45_000 }, async t => {
  const fixture = await createDocumentIntegrationFixture();
  try {
    const signal = AbortSignal.any([t.signal, AbortSignal.timeout(40_000)]);
    const job = await seedJob(fixture, signal);
    const bytes = Buffer.from('Synthetic prospective key: journal records intention before PUT.');
    const keys = Array.from({ length: 1001 }, () => fixture.storage.prepare(job.scope, bytes).key);
    async function rejectsWithoutMutation(batch: string[], code: 'DOC_INVALID_INPUT' | 'DOC_CLEANUP_PENDING') {
      const before = await journalSnapshot(fixture, job.id);
      await assert.rejects(fixture.repository.reserveCleanupStorageKeys(job.id, batch),
        (error: unknown) => error instanceof DocumentRepositoryError && error.code === code);
      assert.deepEqual(await journalSnapshot(fixture, job.id), before,
        'rejected journal admission must not mutate keys, purge acknowledgements, state, clocks, artifacts or events');
    }
    await rejectsWithoutMutation([keys[0]!], 'DOC_CLEANUP_PENDING');
    await fixture.repository.deleteOwned(job.id, fixture.owner);
    await rejectsWithoutMutation([keys[0]!], 'DOC_CLEANUP_PENDING');
    await fixture.db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET cleanup_not_before=clock_timestamp()-interval '1 second' WHERE id=${job.id}`);
    const prefix = fixture.storage.prefix(job.scope);
    const malformed = [
      '', `${prefix}test-v1/../escape.sealed`, `${prefix}test-v1/nested/object.sealed`,
      `${prefix}test-v1/object.txt`, `${prefix}test-v1/object%2Fescape.sealed`,
      `${prefix}/object.sealed`, `${prefix}${'a'.repeat(41)}/object.sealed`,
      fixture.storage.prepare({ userId: fixture.other, jobId: job.id }, bytes).key,
      fixture.storage.prepare({ userId: fixture.owner, jobId: randomUUID() }, bytes).key,
      job.neighbor.key,
    ];
    // Deliberately cross the TypeScript boundary to test the runtime no-array
    // contract. No dependency or persistence result is replaced.
    for (const invalid of [null, {}, keys[0]]) {
      await rejectsWithoutMutation(invalid as unknown as string[], 'DOC_INVALID_INPUT');
    }
    await rejectsWithoutMutation([], 'DOC_INVALID_INPUT');
    await rejectsWithoutMutation([keys[0]!, keys[0]!], 'DOC_INVALID_INPUT');
    await rejectsWithoutMutation(keys, 'DOC_INVALID_INPUT');
    for (const key of malformed) await rejectsWithoutMutation([keys[0]!, key], 'DOC_INVALID_INPUT');
    const before = await journalSnapshot(fixture, job.id);
    await fixture.repository.reserveCleanupStorageKeys(job.id, keys.slice(0, 1000));
    const after = await journalSnapshot(fixture, job.id);
    assert.equal(after.job.storageKeys.length, before.job.storageKeys.length + 1000);
    assert.equal(new Set(after.job.storageKeys).size, after.job.storageKeys.length);
    assert.ok(keys.slice(0, 1000).every(key => after.job.storageKeys.includes(key)));
    assert.deepEqual(after.job.purgedKeys, before.job.purgedKeys);
    assert.equal(after.job.cleanupPending, true);
    assert.deepEqual(withoutJournalFields(after), withoutJournalFields(before),
      'accepted journal writes must not change attempt/fence/lease, timestamps, events, artifacts or output visibility');
    await fixture.repository.reserveCleanupStorageKeys(job.id, keys.slice(0, 1000));
    assert.deepEqual(await journalSnapshot(fixture, job.id), after, 'repeated reservation is idempotent');
    // These 1000 reservations are intentions, not fabricated uploaded objects.
    assert.equal((await remoteKeys(fixture, job.scope, signal)).size, 2);
    assert.deepEqual(await fixture.storage.get(job.neighborScope, job.neighbor.key, job.neighbor.sha256, signal), job.neighborBytes);
  } finally { await fixture.close(); }
});

test('real late PUT rediscovery revokes an old purge acknowledgement before cleanup deletes it again', { timeout: 45_000 }, async t => {
  const fixture = await createDocumentIntegrationFixture();
  try {
    const signal = AbortSignal.any([t.signal, AbortSignal.timeout(40_000)]);
    const job = await seedJob(fixture, signal);
    await expireOnlyThisTombstone(fixture, job.id);
    const provider = new AnthropicDocumentProviderClient('fixture-unused-no-provider');
    const notices: string[] = [];
    await reconcileDocumentCleanup(fixture.repository, fixture.storage, provider,
      AbortSignal.any([signal, AbortSignal.timeout(15_000)]), code => notices.push(code));
    assert.equal((await remoteKeys(fixture, job.scope, signal)).size, 0);
    const completed = await journalSnapshot(fixture, job.id);
    assert.equal(completed.job.cleanupPending, false);
    assert.equal(completed.job.purgedKeys.length, 2);
    assert.ok(completed.job.purgedKeys.includes(job.original.key));
    assert.equal((await fixture.repository.pendingOutbox(100, 'cleanup')).some(event => event.jobId === job.id), false);
    // Actual conditional S3 PUT to the same identity succeeds only because its
    // previous object was really deleted. This is not a fabricated LIST result.
    await fixture.storage.putPrepared(job.scope, job.original, job.originalBytes, signal);
    assert.deepEqual(await fixture.storage.get(job.scope, job.original.key, job.original.sha256, signal), job.originalBytes);
    const rediscovered = [...await remoteKeys(fixture, job.scope, signal)];
    assert.deepEqual(rediscovered, [job.original.key]);
    // Exercise explicit rediscovery's durable contract; this does not assert
    // that the scheduler automatically scans already-completed tombstones.
    await fixture.repository.reserveCleanupStorageKeys(job.id, rediscovered);
    const reopened = await journalSnapshot(fixture, job.id);
    assert.equal(reopened.job.cleanupPending, true);
    assert.deepEqual(reopened.job.storageKeys, completed.job.storageKeys);
    assert.equal(reopened.job.purgedKeys.includes(job.original.key), false);
    assert.deepEqual(reopened.job.purgedKeys, [job.instructions.key]);
    assert.deepEqual(withoutJournalFields(reopened), withoutJournalFields(completed));
    assert.ok((await fixture.repository.jobsNeedingCleanup(10)).some(candidate => candidate.id === job.id));
    await reconcileDocumentCleanup(fixture.repository, fixture.storage, provider,
      AbortSignal.any([signal, AbortSignal.timeout(15_000)]), code => notices.push(code));
    assert.equal((await remoteKeys(fixture, job.scope, signal)).size, 0);
    const final = await fixture.repository.getInternal(job.id);
    assert.equal(final.cleanupPending, false);
    assert.equal(final.purgedKeys.length, 2);
    assert.equal(new Set(final.purgedKeys).size, 2);
    assert.ok(final.purgedKeys.includes(job.original.key));
    assert.deepEqual(final.outputKeys, []);
    assert.deepEqual(final.providerFiles, []);
    assert.ok((await fixture.repository.artifactsInternal(job.id)).every(artifact => artifact.purgedAt && !artifact.published));
    assert.equal((await fixture.repository.pendingOutbox(100, 'cleanup')).some(event => event.jobId === job.id), false);
    assert.deepEqual(await fixture.storage.get(job.neighborScope, job.neighbor.key, job.neighbor.sha256, signal), job.neighborBytes);
    assert.deepEqual(notices, []);
  } finally { await fixture.close(); }
});

/** Real HTTP denial of LIST only; successful DELETE requests reach actual MinIO. */
async function denyListProxy(fixture: DocumentIntegrationFixture) {
  const upstream = new URL(fixture.config.r2Endpoint!);
  assert.equal(upstream.protocol, 'http:', 'only the isolated HTTP MinIO fixture is supported');
  const active = new Set<ClientRequest>();
  let denied = 0;
  let deleted = 0;
  let client: S3Client | undefined;
  const server = createServer((req, res) => {
    if (req.method === 'GET' && new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.has('list-type')) {
      denied += 1;
      res.writeHead(403, { 'Content-Type': 'application/xml', Connection: 'close' });
      res.end('<Error><Code>AccessDenied</Code></Error>');
      return;
    }
    // Retain the signed Host header; only the connection target is forwarded.
    const forwarded = httpRequest({ hostname: upstream.hostname, port: upstream.port || '80',
      path: req.url, method: req.method, headers: req.headers }, response => {
      if (req.method === 'DELETE' && response.statusCode === 204) deleted += 1;
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.on('error', () => res.destroy()); response.pipe(res);
    });
    active.add(forwarded);
    forwarded.once('close', () => active.delete(forwarded));
    forwarded.on('error', () => res.destroy());
    req.on('error', () => forwarded.destroy());
    res.on('close', () => { if (!res.writableFinished) forwarded.destroy(); });
    req.pipe(forwarded);
  });
  async function close() {
    client?.destroy();
    const closing = server.listening ? new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve())) : Promise.resolve();
    server.closeAllConnections();
    for (const request of active) request.destroy();
    await closing;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    client = createPrivateDocumentS3Client({ endpoint: `http://127.0.0.1:${address.port}`, region: 'us-east-1', forcePathStyle: true,
      credentials: { accessKeyId: fixture.config.r2AccessKeyId, secretAccessKey: fixture.config.r2SecretAccessKey } });
    return { storage: new PrivateDocumentStorage(client, { bucket: fixture.bucket, key: fixture.key, keyId: 'test-v1', maxBytes: 1024 * 1024 }),
      counts: () => ({ denied, deleted }), close };
  } catch (error) { await close(); throw error; }
}

test('real LIST failure still purges known keys and a fresh pass removes only the remaining orphan', { timeout: 45_000 }, async t => {
  const fixture = await createDocumentIntegrationFixture();
  try {
    const signal = AbortSignal.any([t.signal, AbortSignal.timeout(40_000)]);
    const job = await seedJob(fixture, signal);
    const bytes = Buffer.from('Synthetic orphan remains discoverable after LIST recovers.');
    const orphan = fixture.storage.prepare(job.scope, bytes);
    await fixture.storage.putPrepared(job.scope, orphan, bytes, signal);
    await expireOnlyThisTombstone(fixture, job.id);
    const provider = new AnthropicDocumentProviderClient('fixture-unused-no-provider');
    const notices: string[] = [];
    const proxy = await denyListProxy(fixture);
    try {
      await reconcileDocumentCleanup(fixture.repository, proxy.storage, provider,
        AbortSignal.any([signal, AbortSignal.timeout(15_000)]), code => notices.push(code));
      assert.deepEqual(proxy.counts(), { denied: 1, deleted: 2 }, 'known DELETEs must reach S3 even when LIST is denied');
    } finally { await proxy.close(); }
    const partial = await fixture.repository.getInternal(job.id);
    assert.equal(partial.cleanupPending, true);
    assert.equal(partial.purgedKeys.length, 2);
    assert.ok(partial.purgedKeys.includes(job.original.key) && partial.purgedKeys.includes(job.instructions.key));
    assert.deepEqual([...await remoteKeys(fixture, job.scope, signal)], [orphan.key]);
    assert.deepEqual(await fixture.storage.get(job.scope, orphan.key, orphan.sha256, signal), bytes);
    assert.ok(notices.includes('DOC_CLEANUP_PENDING'));
    assert.ok((await fixture.repository.pendingOutbox(100, 'cleanup')).some(event => event.jobId === job.id));
    await reconcileDocumentCleanup(fixture.repository, fixture.storage, provider,
      AbortSignal.any([signal, AbortSignal.timeout(15_000)]), code => notices.push(code));
    assert.equal((await remoteKeys(fixture, job.scope, signal)).size, 0);
    const complete = await fixture.repository.getInternal(job.id);
    assert.equal(complete.cleanupPending, false);
    assert.equal(complete.purgedKeys.length, 3);
    assert.ok((await fixture.repository.artifactsInternal(job.id)).every(artifact => artifact.purgedAt && !artifact.published));
    assert.equal((await fixture.repository.pendingOutbox(100, 'cleanup')).some(event => event.jobId === job.id), false);
    assert.deepEqual(await fixture.storage.get(job.neighborScope, job.neighbor.key, job.neighbor.sha256, signal), job.neighborBytes);
    assert.deepEqual(complete.providerFiles, []);
    assert.deepEqual(complete.outputKeys, []);
  } finally { await fixture.close(); }
});

type CleanupResponseFault = { kind: 'lose-delete-ack'; key: string } | {
  kind: 'write-behind-list'; expectedKey: string; scope: StorageScope; late: PrivateObject; bytes: Buffer;
};

/** Every response comes from actual MinIO. Only transport delivery is faulted;
 * LIST XML is never rewritten and no SDK/storage/repository method is replaced. */
async function responseFaultProxy(fixture: DocumentIntegrationFixture, fault: CleanupResponseFault, parentSignal: AbortSignal) {
  const upstream = new URL(fixture.config.r2Endpoint!);
  assert.equal(upstream.protocol, 'http:');
  const controller = new AbortController();
  const signal = AbortSignal.any([parentSignal, controller.signal]);
  const requests = new Set<ClientRequest>();
  const responses = new Set<IncomingMessage>();
  const handlers = new Set<Promise<void>>();
  const deletedKeys: string[] = [];
  let droppedReplies = 0;
  let injectedWrites = 0;
  let listedResponses = 0;
  let failures = 0;
  let capturedList: Buffer | undefined;
  let client: S3Client | undefined;
  async function readSmallBody(response: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      signal.throwIfAborted();
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      assert.ok(size <= 64 * 1024, 'fault observation must remain a small synthetic response');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  }
  const server = createServer((req, res) => {
    if (signal.aborted) { res.destroy(); return; }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const isList = req.method === 'GET' && url.searchParams.has('list-type');
    // The fixture keys contain only safe ASCII, but real S3 URLs encode slashes.
    const objectPath = decodeURIComponent(url.pathname);
    const forwarded = httpRequest({ hostname: upstream.hostname, port: upstream.port || '80',
      path: req.url, method: req.method, headers: req.headers }, response => {
      responses.add(response);
      response.once('close', () => responses.delete(response));
      const handling = (async () => {
        signal.throwIfAborted();
        if (req.method === 'DELETE' && response.statusCode === 204) {
          assert.ok(deletedKeys.length < 16, 'fault fixture DELETE trace must stay bounded');
          deletedKeys.push(objectPath);
          if (fault.kind === 'lose-delete-ack' && objectPath === `/${fixture.bucket}/${fault.key}`) {
            // Wait for the REAL successful response to finish, then lose it
            // before emitting even headers to the SDK. Repeat for every retry.
            assert.equal((await readSmallBody(response)).length, 0);
            droppedReplies += 1;
            res.destroy();
            return;
          }
        }
        if (isList && response.statusCode === 200) {
          listedResponses += 1;
          const body = await readSmallBody(response);
          if (fault.kind === 'write-behind-list' && injectedWrites === 0 && body.includes(Buffer.from('<Contents>'))) {
            assert.ok(body.includes(Buffer.from(`<Key>${fault.expectedKey}</Key>`)), 'first actual LIST must contain the seeded orphan');
            assert.equal(body.includes(Buffer.from(`<Key>${fault.late.key}</Key>`)), false,
              'late object must not be present in the captured MinIO response');
            capturedList = Buffer.from(body);
            await fixture.storage.putPrepared(fault.scope, fault.late, fault.bytes, signal);
            injectedWrites += 1;
          }
          signal.throwIfAborted();
          res.writeHead(response.statusCode, response.headers);
          res.end(body); // Identical XML bytes from MinIO, including its real cursor.
          return;
        }
        response.on('error', () => res.destroy());
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      })().catch(() => { failures += 1; response.destroy(); res.destroy(); });
      handlers.add(handling);
      void handling.finally(() => handlers.delete(handling));
    });
    requests.add(forwarded);
    forwarded.once('close', () => requests.delete(forwarded));
    forwarded.on('error', () => res.destroy());
    req.on('error', () => forwarded.destroy());
    res.on('close', () => { if (!res.writableFinished) forwarded.destroy(); });
    req.pipe(forwarded);
  });
  function abortTransport() {
    server.closeAllConnections();
    for (const request of requests) request.destroy();
    for (const response of responses) response.destroy();
  }
  signal.addEventListener('abort', abortTransport, { once: true });
  async function close() {
    controller.abort();
    client?.destroy();
    const closing = server.listening ? new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve())) : Promise.resolve();
    abortTransport();
    // Await even an aborted injected PUT before fixture.close may delete its bucket.
    const results = await Promise.allSettled([closing, ...handlers]);
    signal.removeEventListener('abort', abortTransport);
    assert.ok(results.every(result => result.status === 'fulfilled'), 'fault proxy must close every owned resource');
  }
  try {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    client = createPrivateDocumentS3Client({ endpoint: `http://127.0.0.1:${address.port}`, region: 'us-east-1', forcePathStyle: true,
      credentials: { accessKeyId: fixture.config.r2AccessKeyId, secretAccessKey: fixture.config.r2SecretAccessKey } });
    return { storage: new PrivateDocumentStorage(client, { bucket: fixture.bucket, key: fixture.key, keyId: 'test-v1', maxBytes: 1024 * 1024 }),
      observation: () => ({ droppedReplies, injectedWrites, listedResponses, failures, deletedKeys: [...deletedKeys], capturedList }), close };
  } catch (error) { await close(); throw error; }
}

test('real orphan DELETE with every 204 reply lost remains journaled and unacknowledged until a fresh pass', { timeout: 45_000 }, async t => {
  const fixture = await createDocumentIntegrationFixture();
  try {
    const signal = AbortSignal.any([t.signal, AbortSignal.timeout(40_000)]);
    const job = await seedJob(fixture, signal);
    const bytes = Buffer.from('Synthetic orphan whose DELETE acknowledgement will be lost.');
    const orphan = fixture.storage.prepare(job.scope, bytes);
    await fixture.storage.putPrepared(job.scope, orphan, bytes, signal);
    await expireOnlyThisTombstone(fixture, job.id);
    const provider = new AnthropicDocumentProviderClient('fixture-unused-no-provider');
    const notices: string[] = [];
    const proxy = await responseFaultProxy(fixture, { kind: 'lose-delete-ack', key: orphan.key }, signal);
    try {
      await reconcileDocumentCleanup(fixture.repository, proxy.storage, provider,
        AbortSignal.any([signal, AbortSignal.timeout(15_000)]), code => notices.push(code));
      const observation = proxy.observation();
      assert.equal(observation.failures, 0, 'fault injection itself must complete without hidden errors');
      assert.equal(observation.droppedReplies, 3, 'all three idempotent DELETE attempts must reach real MinIO and lose their successful replies');
      assert.equal(observation.deletedKeys.filter(key => key === `/${fixture.bucket}/${orphan.key}`).length, 3);
      assert.equal(observation.deletedKeys.length, 5, 'input and instructions DELETE replies must pass normally');
    } finally { await proxy.close(); }
    assert.equal((await remoteKeys(fixture, job.scope, signal)).size, 0, 'uncertain DELETE really removed the orphan remotely');
    const uncertain = await fixture.repository.getInternal(job.id);
    assert.equal(uncertain.cleanupPending, true);
    assert.ok(uncertain.storageKeys.includes(orphan.key), 'the orphan obligation must be durable before an uncertain DELETE');
    assert.equal(uncertain.purgedKeys.includes(orphan.key), false, 'a lost success response is not proof of deletion');
    assert.equal(uncertain.purgedKeys.length, 2);
    assert.ok(notices.includes('DOC_CLEANUP_PENDING'));
    assert.ok((await fixture.repository.pendingOutbox(100, 'cleanup')).some(event => event.jobId === job.id));
    await reconcileDocumentCleanup(fixture.repository, fixture.storage, provider,
      AbortSignal.any([signal, AbortSignal.timeout(15_000)]), code => notices.push(code));
    const complete = await fixture.repository.getInternal(job.id);
    assert.equal((await remoteKeys(fixture, job.scope, signal)).size, 0);
    assert.equal(complete.cleanupPending, false);
    assert.equal(complete.purgedKeys.length, 3);
    assert.ok(complete.purgedKeys.includes(orphan.key));
    assert.deepEqual(complete.providerFiles, []);
    assert.deepEqual(complete.outputKeys, []);
    assert.ok((await fixture.repository.artifactsInternal(job.id)).every(artifact => artifact.purgedAt && !artifact.published));
    assert.equal((await fixture.repository.pendingOutbox(100, 'cleanup')).some(event => event.jobId === job.id), false);
    assert.deepEqual(await fixture.storage.get(job.neighborScope, job.neighbor.key, job.neighbor.sha256, signal), job.neighborBytes);
  } finally { await fixture.close(); }
});

test('real write behind the captured LIST cursor is journaled by final verification and cannot falsely finish cleanup', { timeout: 45_000 }, async t => {
  const fixture = await createDocumentIntegrationFixture();
  try {
    const signal = AbortSignal.any([t.signal, AbortSignal.timeout(40_000)]);
    const job = await seedJob(fixture, signal);
    const bytes = Buffer.from('Synthetic evidence created while the cleanup LIST response is in flight.');
    const candidates = [fixture.storage.prepare(job.scope, bytes), fixture.storage.prepare(job.scope, bytes)]
      .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const late = candidates[0]!;
    const orphan = candidates[1]!;
    assert.ok(late.key < orphan.key, 'late key must sort behind the already captured traversal position');
    await fixture.storage.putPrepared(job.scope, orphan, bytes, signal);
    await expireOnlyThisTombstone(fixture, job.id);
    const provider = new AnthropicDocumentProviderClient('fixture-unused-no-provider');
    const notices: string[] = [];
    const proxy = await responseFaultProxy(fixture, { kind: 'write-behind-list', expectedKey: orphan.key,
      scope: job.scope, late, bytes }, signal);
    try {
      await reconcileDocumentCleanup(fixture.repository, proxy.storage, provider,
        AbortSignal.any([signal, AbortSignal.timeout(15_000)]), code => notices.push(code));
      const observation = proxy.observation();
      assert.equal(observation.failures, 0, 'actual response capture and injected S3 PUT must both complete');
      assert.equal(observation.injectedWrites, 1);
      assert.equal(observation.listedResponses, 2, 'final verification must issue a fresh LIST after the original scan');
      assert.ok(observation.capturedList?.includes(Buffer.from(`<Key>${orphan.key}</Key>`)));
      assert.equal(observation.capturedList?.includes(Buffer.from(`<Key>${late.key}</Key>`)), false);
      assert.equal(observation.deletedKeys.length, 3);
      assert.equal(observation.deletedKeys.includes(`/${fixture.bucket}/${late.key}`), false,
        'the late object must remain for the next bounded cleanup pass');
    } finally { await proxy.close(); }
    assert.deepEqual([...await remoteKeys(fixture, job.scope, signal)], [late.key]);
    assert.deepEqual(await fixture.storage.get(job.scope, late.key, late.sha256, signal), bytes);
    const pending = await fixture.repository.getInternal(job.id);
    assert.equal(pending.cleanupPending, true);
    assert.equal(pending.storageKeys.length, 4);
    assert.ok(pending.storageKeys.includes(late.key), 'fresh verification must journal the behind-cursor write before returning');
    assert.equal(pending.purgedKeys.length, 3);
    assert.equal(pending.purgedKeys.includes(late.key), false);
    assert.ok(notices.includes('DOC_CLEANUP_PENDING'));
    assert.ok((await fixture.repository.pendingOutbox(100, 'cleanup')).some(event => event.jobId === job.id));
    await reconcileDocumentCleanup(fixture.repository, fixture.storage, provider,
      AbortSignal.any([signal, AbortSignal.timeout(15_000)]), code => notices.push(code));
    assert.equal((await remoteKeys(fixture, job.scope, signal)).size, 0);
    const complete = await fixture.repository.getInternal(job.id);
    assert.equal(complete.cleanupPending, false);
    assert.equal(complete.purgedKeys.length, 4);
    assert.ok(complete.purgedKeys.includes(late.key));
    assert.deepEqual(complete.providerFiles, []);
    assert.deepEqual(complete.outputKeys, []);
    assert.ok((await fixture.repository.artifactsInternal(job.id)).every(artifact => artifact.purgedAt && !artifact.published));
    assert.equal((await fixture.repository.pendingOutbox(100, 'cleanup')).some(event => event.jobId === job.id), false);
    assert.deepEqual(await fixture.storage.get(job.neighborScope, job.neighbor.key, job.neighbor.sha256, signal), job.neighborBytes);
  } finally { await fixture.close(); }
});

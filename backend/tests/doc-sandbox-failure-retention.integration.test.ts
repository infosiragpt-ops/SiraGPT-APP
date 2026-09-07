import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { Prisma } from '@prisma/client';
import { AnthropicSandboxEngine } from '../src/modules/doc-sandbox/engine/anthropic-engine';
import { AnthropicDocumentProviderClient } from '../src/modules/doc-sandbox/engine/provider-client';
import { sha256 } from '../src/modules/doc-sandbox/engine/artifacts';
import { DocumentSandboxProcessor } from '../src/modules/doc-sandbox/queue/processor';
import { reconcileDocumentCleanup } from '../src/modules/doc-sandbox/queue/cleanup';
import { DocumentRepositoryError, type ArtifactInput, type AttemptLease } from '../src/modules/doc-sandbox/queue/repository';
import { createPrivateDocumentS3Client, PrivateDocumentStorage } from '../src/modules/doc-sandbox/storage/private-storage';
import { DocSandboxError } from '../src/modules/doc-sandbox/types/errors';
import { hasCompleteValidation, type InputFile, type ValidationReport } from '../src/modules/doc-sandbox/types/contracts';
import { IndependentDocumentValidator } from '../src/modules/doc-sandbox/validation';
import { createDocumentIntegrationFixture, type DocumentIntegrationFixture } from './doc-sandbox-integration-fixture';
import { readVerifiedFailureEvidenceBundle } from './helpers/doc-sandbox-failure-evidence-bundle';

// Integration of the actual private failure handler, NOT process(), runsc,
// provider execution or a replacement validator. Reports were emitted by real
// Python offline and are transported as independently hash-pinned input data.
// These TEST-ONLY settings have no production counterpart or generated fallback.
const bundlePath = process.env.DOC_SANDBOX_TEST_FAILURE_BUNDLE_PATH;
const bundleHash = process.env.DOC_SANDBOX_TEST_FAILURE_BUNDLE_SHA256;
assert.ok(bundlePath && bundleHash, 'A real Python evidence path and independently recorded SHA256 are required before service access');
const evidence = readVerifiedFailureEvidenceBundle(bundlePath, bundleHash);

interface PrivateFailureHandler {
  handleFailure(lease: AttemptLease, error: unknown, context: {
    timedOut: boolean; phase: 'inspecting' | 'planning' | 'editing' | 'validating';
    latestReport?: ValidationReport; originalInputs: InputFile[];
  }): Promise<void>;
}

async function prepareAttempt(fixture: DocumentIntegrationFixture, handlerStorage: PrivateDocumentStorage = fixture.storage) {
  const id = randomUUID();
  const scope = { userId: fixture.owner, jobId: id };
  const original = evidence.original;
  const input = fixture.storage.prepare(scope, original.data);
  const instructionBytes = Buffer.from('Change exactly 2026 to 2027. Synthetic private retention test.');
  const instructions = fixture.storage.prepare(scope, instructionBytes);
  await fixture.repository.createJob({ id, userId: fixture.owner, idempotencyKey: randomUUID(),
    payloadHash: input.sha256, instructionsKey: instructions.key, requestedModel: 'fixture-mechanical', modelTier: 'mechanical',
    maxTokens: 1000, maxCostUsd: '0', promptVersion: 'fixture-failure-retention', ready: false,
    expiresAt: new Date(Date.now() + 86_400_000), inputs: [{ id: original.id, kind: 'input', storageKey: input.key,
      filename: original.name, mime: original.mime, size: original.data.length, sha256: original.sha256 }] });
  await fixture.storage.putPrepared(scope, input, original.data);
  await fixture.storage.putPrepared(scope, instructions, instructionBytes);
  await fixture.repository.markInputsReadyOwned(id, fixture.owner);
  const lease = await fixture.repository.claimAttempt(id, 60_000);
  assert.ok(lease);
  await fixture.repository.transition(lease, 'planning');
  const planBytes = Buffer.from(JSON.stringify(evidence.plan), 'utf8');
  const plan = fixture.storage.prepare(scope, planBytes);
  await fixture.repository.reserveStorageKeys(lease, [plan.key]);
  await fixture.storage.putPrepared(scope, plan, planBytes);
  await fixture.repository.freezePlan(lease, plan.key, plan.sha256);
  await fixture.repository.transition(lease, 'editing');
  await fixture.repository.transition(lease, 'validating');
  const inputRecord = (await fixture.repository.artifactsInternal(id)).find(artifact => artifact.kind === 'input');
  assert.ok(inputRecord);
  const actualInput: InputFile = { id: inputRecord.id, name: inputRecord.filename, format: 'txt', mime: inputRecord.mime,
    data: await fixture.storage.get(scope, inputRecord.storageKey, inputRecord.sha256), sha256: inputRecord.sha256 };
  assert.deepEqual(actualInput, original, 'the handler receives the pristine bytes read from real private storage');
  const otherScope = { userId: fixture.other, jobId: randomUUID() };
  const otherBytes = Buffer.from('Other owner remains byte-identical.');
  const other = fixture.storage.prepare(otherScope, otherBytes);
  await fixture.storage.putPrepared(otherScope, other, otherBytes);
  let engineConstructions = 0;
  const notices: string[] = [];
  const provider = new AnthropicDocumentProviderClient('fixture-unused-no-provider');
  const processor = new DocumentSandboxProcessor({ repository: fixture.repository, storage: handlerStorage,
    validator: new IndependentDocumentValidator({ image: fixture.config.validatorImage }),
    // This is the genuine factory, not a stubbed engine. The private handler
    // must not call it; the count is observational, with no altered behavior.
    engineFactory: persistence => { engineConstructions += 1; return new AnthropicSandboxEngine(provider, fixture.config.engine, persistence); },
    onNotice: notice => notices.push(notice.code),
  }, { maxTurns: 2, maxTokens: 1000, timeoutMs: 60_000, leaseMs: 60_000 });
  // Deliberate typed access to the existing private seam; no runtime export,
  // public endpoint, dynamic replacement or `any` is introduced for this test.
  const handler = processor as unknown as PrivateFailureHandler;
  assert.equal(typeof handler.handleFailure, 'function', 'the reviewed private extraction must exist before this regression is run');
  const context = { timedOut: false, phase: 'validating' as const,
    latestReport: evidence.negative.report, originalInputs: [actualInput] };
  return { id, scope, input, lease, handler, context, otherScope, otherBytes, other, notices,
    engineConstructions: () => engineConstructions };
}

test('transported positive and negative controls preserve the exact real Python oracle evidence', () => {
  assert.equal(evidence.negative.report.passed, false);
  assert.equal(evidence.positive.report.passed, true);
  assert.equal(hasCompleteValidation(evidence.negative.report, 'txt'), false);
  assert.equal(hasCompleteValidation(evidence.positive.report, 'txt'), true);
  assert.deepEqual(evidence.original.data, Buffer.from('2026'));
  assert.deepEqual(evidence.negative.candidate, Buffer.from('2028'));
  assert.deepEqual(evidence.positive.candidate, Buffer.from('2027'));
  assert.equal(evidence.negative.report.levels[3]!.details.code, 'TEXT_DIFF_UNPLANNED');
  assert.equal(evidence.bundleSha256, bundleHash);
});

test('real failure handler preserves the rejected Python diff in private GCM storage without publishing an output', { timeout: 30_000 }, async () => {
  const fixture = await createDocumentIntegrationFixture();
  try {
    const prepared = await prepareAttempt(fixture);
    const reportBefore = JSON.stringify(evidence.negative.report);
    await prepared.handler.handleFailure(prepared.lease, new DocSandboxError('E_VALIDATION', 422), prepared.context);
    const state = await fixture.repository.getInternal(prepared.id);
    assert.equal(state.status, 'queued'); assert.equal(state.errorCode, 'E_VALIDATION');
    assert.equal(state.attempts, 1); assert.equal(state.fence, prepared.lease.fence + 1); assert.equal(state.leaseToken, null);
    assert.ok(state.validationReportKey, 'the failed report must be saved before asserting diff retention');
    const artifacts = await fixture.repository.artifactsInternal(prepared.id);
    const reports = artifacts.filter(artifact => artifact.kind === 'validation_report');
    assert.equal(reports.length, 1); assert.equal(reports[0]!.storageKey, state.validationReportKey);
    const savedReport: unknown = JSON.parse((await fixture.storage.get(prepared.scope, state.validationReportKey, reports[0]!.sha256)).toString('utf8'));
    assert.ok(savedReport && typeof savedReport === 'object' && 'passed' in savedReport && savedReport.passed === false);
    assert.deepEqual(state.outputKeys, []);
    assert.equal(artifacts.some(artifact => artifact.kind === 'output'), false);
    assert.deepEqual(await fixture.storage.get(prepared.scope, prepared.input.key, prepared.input.sha256), evidence.original.data);
    assert.deepEqual(await fixture.storage.get(prepared.otherScope, prepared.other.key, prepared.other.sha256), prepared.otherBytes);
    assert.deepEqual(state.providerFiles, []); assert.deepEqual(state.providerContainers, []); assert.deepEqual(state.costReservations, []);
    assert.equal(prepared.engineConstructions(), 0);
    assert.equal(JSON.stringify(evidence.negative.report), reportBefore);
    const diffs = artifacts.filter(artifact => artifact.kind === 'text_diff');
    // Expected baseline failure: the report above was really committed, but
    // the current catch discarded its real Python artifact bytes.
    assert.equal(diffs.length, 1, 'DOC_TEST_FAILED_DIFF_MISSING_AFTER_REPORT_SAVED');
    const diff = diffs[0]!;
    const expected = evidence.negative.report.artifacts![0]!;
    assert.equal(diff.published, false); assert.equal(diff.purgedAt, null);
    assert.equal(diff.sha256, expected.sha256); assert.equal(diff.size, expected.data.length);
    assert.deepEqual(await fixture.storage.get(prepared.scope, diff.storageKey, diff.sha256), expected.data);
    const raw = await fixture.s3.send(new GetObjectCommand({ Bucket: fixture.bucket, Key: diff.storageKey }));
    assert.ok(raw.Body);
    const encrypted = Buffer.from(await raw.Body.transformToByteArray());
    assert.equal(encrypted.subarray(0, 8).toString(), 'SIRADOC1');
    assert.equal(encrypted.length, expected.data.length + 36); assert.equal(encrypted.includes(expected.data), false);
    assert.equal((await fixture.repository.artifactsOwned(prepared.id, fixture.owner)).some(artifact => artifact.kind === 'text_diff'), false);
    const rows = await fixture.db.$queryRaw<Array<{ attempt: number }>>(Prisma.sql`SELECT attempt FROM doc_job_artifacts WHERE id=${diff.id} AND job_id=${prepared.id}`);
    assert.deepEqual(rows, [{ attempt: prepared.lease.attempt }]);
    assert.ok((await fixture.repository.pendingOutbox(100, 'enqueue')).some(event => event.jobId === prepared.id
      && event.payload.attempt === 1 && event.payload.status === 'queued'));
    assert.equal(sha256(expected.data), diff.sha256);
  } finally { await fixture.close(); }
});

for (const action of ['cancel', 'delete'] as const) {
  test(`real failure handler cannot resurrect ${action === 'cancel' ? 'cancelled' : 'deleted'} work or save late evidence`, { timeout: 30_000 }, async () => {
    const fixture = await createDocumentIntegrationFixture();
    try {
      const prepared = await prepareAttempt(fixture);
      if (action === 'cancel') await fixture.repository.cancelOwned(prepared.id, fixture.owner);
      else await fixture.repository.deleteOwned(prepared.id, fixture.owner);
      const before = { job: await fixture.repository.getInternal(prepared.id), artifacts: await fixture.repository.artifactsInternal(prepared.id),
        keys: await fixture.storage.list(prepared.scope),
        events: await fixture.db.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`SELECT id,seq,type,payload,outbox,dispatched_at FROM doc_job_events WHERE job_id=${prepared.id} ORDER BY seq`) };
      await prepared.handler.handleFailure(prepared.lease, new DocSandboxError('E_VALIDATION', 422), prepared.context);
      assert.deepEqual({ job: await fixture.repository.getInternal(prepared.id), artifacts: await fixture.repository.artifactsInternal(prepared.id),
        keys: await fixture.storage.list(prepared.scope),
        events: await fixture.db.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`SELECT id,seq,type,payload,outbox,dispatched_at FROM doc_job_events WHERE job_id=${prepared.id} ORDER BY seq`) }, before);
      assert.equal(prepared.engineConstructions(), 0);
      assert.deepEqual(await fixture.storage.get(prepared.scope, prepared.input.key, prepared.input.sha256), evidence.original.data);
      assert.deepEqual(await fixture.storage.get(prepared.otherScope, prepared.other.key, prepared.other.sha256), prepared.otherBytes);
    } finally { await fixture.close(); }
  });
}

type PreparedAttempt = Awaited<ReturnType<typeof prepareAttempt>>;

async function failureSnapshot(fixture: DocumentIntegrationFixture, prepared: PreparedAttempt) {
  return {
    job: await fixture.db.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`SELECT * FROM doc_jobs WHERE id=${prepared.id}`),
    artifacts: await fixture.db.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`SELECT * FROM doc_job_artifacts WHERE job_id=${prepared.id} ORDER BY id`),
    events: await fixture.db.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`SELECT * FROM doc_job_events WHERE job_id=${prepared.id} ORDER BY seq`),
    keys: await fixture.storage.list(prepared.scope),
    otherKeys: await fixture.storage.list(prepared.otherScope),
  };
}

async function prepareFailureRecords(fixture: DocumentIntegrationFixture, prepared: PreparedAttempt) {
  const { artifacts: _artifacts, ...reportWithoutBytes } = evidence.negative.report;
  const reportData = Buffer.from(JSON.stringify(reportWithoutBytes), 'utf8');
  const diffData = evidence.negative.report.artifacts![0]!.data;
  async function persist(data: Buffer, kind: 'validation_report' | 'text_diff', filename: string): Promise<ArtifactInput> {
    const object = fixture.storage.prepare(prepared.scope, data);
    await fixture.repository.reserveStorageKeys(prepared.lease, [object.key]);
    await fixture.storage.putPrepared(prepared.scope, object, data);
    assert.deepEqual(await fixture.storage.get(prepared.scope, object.key, object.sha256), data);
    return { id: randomUUID(), kind, storageKey: object.key, filename, mime: 'application/json', size: object.size, sha256: object.sha256 };
  }
  return {
    report: await persist(reportData, 'validation_report', `validation-report-attempt-${prepared.lease.attempt}.json`),
    diff: await persist(diffData, 'text_diff', 'text-diff.json'),
    reportData, diffData,
  };
}

test('real failure handler rejects altered diff bytes before reserving or storing any failed report or evidence', { timeout: 30_000 }, async () => {
  const fixture = await createDocumentIntegrationFixture();
  try {
    const prepared = await prepareAttempt(fixture);
    const originalDiff = evidence.negative.report.artifacts![0]!;
    const changedBytes = Buffer.from(originalDiff.data);
    changedBytes[0] = changedBytes[0]! ^ 1;
    assert.notEqual(sha256(changedBytes), originalDiff.sha256);
    const latestReport: ValidationReport = { ...evidence.negative.report,
      artifacts: [{ ...originalDiff, data: changedBytes }] };
    const before = await failureSnapshot(fixture, prepared);
    await assert.rejects(prepared.handler.handleFailure(prepared.lease, new DocSandboxError('E_VALIDATION', 422),
      { ...prepared.context, latestReport }), error => error instanceof DocSandboxError && error.code === 'E_VALIDATION');
    assert.deepEqual(await failureSnapshot(fixture, prepared), before);
    assert.equal((await fixture.repository.getInternal(prepared.id)).status, 'validating');
    assert.deepEqual(await fixture.storage.get(prepared.scope, prepared.input.key, prepared.input.sha256), evidence.original.data);
    assert.deepEqual(await fixture.storage.get(prepared.otherScope, prepared.other.key, prepared.other.sha256), prepared.otherBytes);
    assert.equal(sha256(originalDiff.data), originalDiff.sha256, 'the trusted oracle bytes remain unchanged');
    assert.equal(prepared.engineConstructions(), 0);
  } finally { await fixture.close(); }
});

test('real failure transaction rejects unauthorized evidence keys without committing its valid report or changing the lease', { timeout: 30_000 }, async () => {
  const fixture = await createDocumentIntegrationFixture();
  try {
    const prepared = await prepareAttempt(fixture);
    const records = await prepareFailureRecords(fixture, prepared);
    // Every byte below comes from the real oracle or the pristine input. These
    // are intentionally invalid identity/reservation requests, not new claims
    // that the validator accepted a different document or artifact format.
    const unreserved = fixture.storage.prepare(prepared.scope, records.diffData);
    await fixture.storage.putPrepared(prepared.scope, unreserved, records.diffData);
    assert.equal((await fixture.repository.getInternal(prepared.id)).storageKeys.includes(unreserved.key), false);
    const foreign = fixture.storage.prepare(prepared.otherScope, records.diffData);
    await fixture.storage.putPrepared(prepared.otherScope, foreign, records.diffData);
    // A journal entry cannot grant ownership of another scope's encrypted object.
    await fixture.repository.reserveStorageKeys(prepared.lease, [foreign.key]);
    const purged = fixture.storage.prepare(prepared.scope, records.diffData);
    await fixture.repository.reserveStorageKeys(prepared.lease, [purged.key]);
    await fixture.storage.putPrepared(prepared.scope, purged, records.diffData);
    await fixture.storage.remove(prepared.scope, purged.key);
    await fixture.repository.markStorageKeysPurged(prepared.id, [purged.key]);
    assert.equal((await fixture.repository.getInternal(prepared.id)).purgedKeys.includes(purged.key), true);
    const input = (await fixture.repository.artifactsInternal(prepared.id)).find(artifact => artifact.kind === 'input')!;
    const invalid = [
      { name: 'unreserved object', artifact: { ...records.diff, id: randomUUID(), storageKey: unreserved.key } },
      { name: 'reserved foreign scope', artifact: { ...records.diff, id: randomUUID(), storageKey: foreign.key } },
      { name: 'confirmed purged object', artifact: { ...records.diff, id: randomUUID(), storageKey: purged.key } },
      { name: 'input storage alias', artifact: { ...records.diff, id: randomUUID(), storageKey: input.storageKey, size: input.size, sha256: input.sha256 } },
      { name: 'existing input artifact id', artifact: { ...records.diff, id: input.id } },
    ];
    for (const item of invalid) {
      const before = await failureSnapshot(fixture, prepared);
      await assert.rejects(fixture.repository.failAttempt(prepared.lease, 'E_VALIDATION', true, records.report,
        { artifacts: [item.artifact], mode: { kind: 'single' } }),
      error => error instanceof DocumentRepositoryError && error.code === 'DOC_INVALID_INPUT', item.name);
      assert.deepEqual(await failureSnapshot(fixture, prepared), before, `${item.name}: no partial report, evidence, event or fence mutation`);
      assert.deepEqual(await fixture.storage.get(prepared.scope, records.report.storageKey, records.report.sha256), records.reportData);
      assert.deepEqual(await fixture.storage.get(prepared.scope, records.diff.storageKey, records.diff.sha256), records.diffData);
    }
    assert.deepEqual(await fixture.storage.get(prepared.scope, prepared.input.key, prepared.input.sha256), evidence.original.data);
    assert.deepEqual(await fixture.storage.get(prepared.otherScope, prepared.other.key, prepared.other.sha256), prepared.otherBytes);
    assert.deepEqual(await fixture.storage.get(prepared.otherScope, foreign.key, foreign.sha256), records.diffData);
  } finally { await fixture.close(); }
});

test('real failure evidence transaction rejects expired and fenced-out attempts without registering a report or retry', { timeout: 30_000 }, async () => {
  for (const cause of ['expired', 'fenced-out'] as const) {
    // The transported original keeps its exact logical id, so each attempt
    // needs its own real schema rather than colliding with the artifact PK.
    const fixture = await createDocumentIntegrationFixture();
    try {
      const prepared = await prepareAttempt(fixture);
      const records = await prepareFailureRecords(fixture, prepared);
      if (cause === 'expired') {
        // Real DB time and persisted expiration; no fake clock or sleep race.
        await fixture.db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${prepared.id}`);
      } else {
        await fixture.db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET fence=fence+1,lease_token=${randomUUID()} WHERE id=${prepared.id}`);
      }
      const before = await failureSnapshot(fixture, prepared);
      await assert.rejects(fixture.repository.failAttempt(prepared.lease, 'E_VALIDATION', true, records.report,
        { artifacts: [records.diff], mode: { kind: 'single' } }),
      error => error instanceof DocumentRepositoryError && error.code === 'DOC_STALE_LEASE', cause);
      assert.deepEqual(await failureSnapshot(fixture, prepared), before, cause);
      assert.deepEqual(await fixture.storage.get(prepared.scope, records.report.storageKey, records.report.sha256), records.reportData);
      assert.deepEqual(await fixture.storage.get(prepared.scope, records.diff.storageKey, records.diff.sha256), records.diffData);
      assert.deepEqual(await fixture.storage.get(prepared.scope, prepared.input.key, prepared.input.sha256), evidence.original.data);
      assert.deepEqual(await fixture.storage.get(prepared.otherScope, prepared.other.key, prepared.other.sha256), prepared.otherBytes);
      assert.equal((await fixture.repository.artifactsInternal(prepared.id)).some(artifact => artifact.kind === 'validation_report' || artifact.kind === 'text_diff'), false);
    } finally { await fixture.close(); }
  }
});

/** Fault only delivery of a genuine MinIO PUT response. The SDK, encrypted
 * storage and repository remain real; original uploads bypass this proxy. */
async function heldEvidencePutProxy(fixture: DocumentIntegrationFixture, parentSignal: AbortSignal) {
  const upstream = new URL(fixture.config.r2Endpoint!);
  assert.equal(upstream.protocol, 'http:');
  assert.ok(['127.0.0.1', 'localhost', '[::1]', 'doc-sandbox-test-minio'].includes(upstream.hostname));
  const controller = new AbortController();
  const signal = AbortSignal.any([parentSignal, controller.signal]);
  const requests = new Set<ClientRequest>();
  const responses = new Set<IncomingMessage>();
  const handlers = new Set<Promise<void>>();
  let client: S3Client | undefined;
  let resolveAccepted!: (key: string) => void;
  const accepted = new Promise<string>(resolve => { resolveAccepted = resolve; });
  let releaseResponse!: () => void;
  const released = new Promise<void>(resolve => { releaseResponse = resolve; });
  let acceptedPuts = 0;
  let deliveredPuts = 0;
  let disconnectedPuts = 0;
  let failures = 0;
  const methods: string[] = [];
  const deletedKeys: string[] = [];
  const server = createServer((req, res) => {
    if (signal.aborted) { res.destroy(); return; }
    methods.push(req.method ?? '');
    if (methods.length > 8 || !['PUT', 'DELETE'].includes(req.method ?? '')) { failures += 1; res.destroy(); return; }
    const forwarded = httpRequest({ hostname: upstream.hostname, port: upstream.port || '80',
      path: req.url, method: req.method, headers: req.headers }, response => {
      responses.add(response);
      response.once('close', () => responses.delete(response));
      const handling = (async () => {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of response) {
          signal.throwIfAborted();
          const bytes = Buffer.from(chunk); size += bytes.length;
          assert.ok(size <= 64 * 1024, 'only a bounded real S3 acknowledgement is buffered');
          chunks.push(bytes);
        }
        const body = Buffer.concat(chunks);
        const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
        assert.ok(pathname.startsWith(`/${fixture.bucket}/`));
        const key = pathname.slice(fixture.bucket.length + 2);
        if (req.method === 'PUT') {
          assert.equal(response.statusCode, 200, 'MinIO must really accept the evidence before the injected race');
          acceptedPuts += 1;
          assert.equal(acceptedPuts, 1, 'the failing evidence must prevent a later report PUT');
          resolveAccepted(key);
          await new Promise<void>(resolve => {
            const finish = () => { signal.removeEventListener('abort', finish); res.removeListener('close', finish); resolve(); };
            signal.addEventListener('abort', finish, { once: true });
            res.once('close', finish);
            void released.then(finish);
            if (signal.aborted || res.destroyed) finish();
          });
          if (res.destroyed) { disconnectedPuts += 1; return; }
          signal.throwIfAborted();
          deliveredPuts += 1;
        } else {
          assert.equal(response.statusCode, 204, 'compensation must receive a real MinIO DELETE acknowledgement');
          deletedKeys.push(key);
        }
        res.writeHead(response.statusCode!, response.headers);
        res.end(body); // Exact successful S3 headers/body, never a fabricated response.
      })().catch(() => { if (!signal.aborted) failures += 1; response.destroy(); res.destroy(); });
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
    controller.abort(); releaseResponse(); client?.destroy();
    const closing = server.listening ? new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : Promise.resolve();
    abortTransport();
    const results = await Promise.allSettled([closing, ...handlers]);
    signal.removeEventListener('abort', abortTransport);
    assert.ok(results.every(result => result.status === 'fulfilled'), 'close all proxy transports before fixture cleanup');
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
    return {
      storage: new PrivateDocumentStorage(client, { bucket: fixture.bucket, key: fixture.key, keyId: 'test-v1', maxBytes: 1024 * 1024 }),
      release: releaseResponse,
      async waitAccepted() {
        signal.throwIfAborted();
        let onAbort!: () => void;
        const aborted = new Promise<never>((_resolve, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }); });
        try { return await Promise.race([accepted, aborted]); }
        finally { signal.removeEventListener('abort', onAbort); }
      },
      observation: () => ({ acceptedPuts, deliveredPuts, disconnectedPuts, failures, methods: [...methods], deletedKeys: [...deletedKeys] }),
      close,
    };
  } catch (error) { await close(); throw error; }
}

for (const action of ['cancel', 'delete'] as const) {
  test(`real ${action} during an accepted evidence PUT fences the worker and compensates without persisting a report`, { timeout: 35_000 }, async t => {
    const fixture = await createDocumentIntegrationFixture();
    let proxy: Awaited<ReturnType<typeof heldEvidencePutProxy>> | undefined;
    let handling: Promise<unknown> | undefined;
    try {
      proxy = await heldEvidencePutProxy(fixture, AbortSignal.any([t.signal, AbortSignal.timeout(30_000)]));
      const prepared = await prepareAttempt(fixture, proxy.storage);
      const before = await failureSnapshot(fixture, prepared);
      handling = prepared.handler.handleFailure(prepared.lease, new DocSandboxError('E_VALIDATION', 422), prepared.context)
        .then(() => undefined, (error: unknown) => error);
      const key = await proxy.waitAccepted();
      const expected = evidence.negative.report.artifacts![0]!;
      assert.ok((await fixture.repository.getInternal(prepared.id)).storageKeys.includes(key), 'reservation precedes the actual PUT');
      assert.deepEqual(await fixture.storage.get(prepared.scope, key, expected.sha256), expected.data, 'the held PUT already exists and decrypts correctly');
      assert.equal(proxy.observation().deliveredPuts, 0);
      if (action === 'cancel') await fixture.repository.cancelOwned(prepared.id, fixture.owner);
      else await fixture.repository.deleteOwned(prepared.id, fixture.owner);
      const revoked = await failureSnapshot(fixture, prepared);
      proxy.release();
      const error = await handling;
      assert.ok(error instanceof DocumentRepositoryError && error.code === 'DOC_STALE_LEASE');
      await proxy.close();
      const observed = proxy.observation();
      assert.equal(observed.failures, 0); assert.equal(observed.acceptedPuts, 1); assert.equal(observed.deliveredPuts, 1);
      assert.deepEqual(observed.methods, ['PUT', 'DELETE']); assert.deepEqual(observed.deletedKeys, [key]);
      const after = await failureSnapshot(fixture, prepared);
      assert.deepEqual(after.job, revoked.job); assert.deepEqual(after.artifacts, revoked.artifacts); assert.deepEqual(after.events, revoked.events);
      assert.deepEqual(after.keys, before.keys, 'only the newly accepted evidence was really compensated');
      assert.deepEqual(after.otherKeys, before.otherKeys);
      const state = await fixture.repository.getInternal(prepared.id);
      assert.equal(state.status, 'cancelled'); assert.equal(Boolean(state.deletedAt), action === 'delete');
      assert.equal(state.validationReportKey, null); assert.deepEqual(state.outputKeys, []);
      assert.equal(state.cleanupPending, true); assert.ok(state.storageKeys.includes(key));
      assert.equal(state.purgedKeys.includes(key), false, 'the tombstone grace forbids falsely acknowledging cleanup immediately');
      assert.ok(prepared.notices.includes('DOC_STORAGE_CLEANUP_PENDING'));
      assert.equal((await fixture.repository.artifactsInternal(prepared.id)).some(artifact => ['text_diff', 'validation_report', 'output'].includes(artifact.kind)), false);
      assert.deepEqual(await fixture.storage.get(prepared.scope, prepared.input.key, prepared.input.sha256), evidence.original.data);
      assert.deepEqual(await fixture.storage.get(prepared.otherScope, prepared.other.key, prepared.other.sha256), prepared.otherBytes);
      assert.equal(prepared.engineConstructions(), 0);
    } finally {
      try {
        const closed = await Promise.allSettled([proxy?.close(), handling]);
        assert.ok(closed.every(result => result.status === 'fulfilled'), 'settle the worker and proxy before deleting their fixture');
      }
      finally { await fixture.close(); }
    }
  });
}

test('real fifteen-second failure storage deadline leaves an accepted PUT journaled for explicit cleanup, not acknowledged as deleted', { timeout: 45_000 }, async t => {
  const fixture = await createDocumentIntegrationFixture();
  let proxy: Awaited<ReturnType<typeof heldEvidencePutProxy>> | undefined;
  let handling: Promise<unknown> | undefined;
  try {
    proxy = await heldEvidencePutProxy(fixture, AbortSignal.any([t.signal, AbortSignal.timeout(40_000)]));
    const prepared = await prepareAttempt(fixture, proxy.storage);
    const before = await failureSnapshot(fixture, prepared);
    const beforeState = await fixture.repository.getInternal(prepared.id);
    const startedAt = performance.now();
    handling = prepared.handler.handleFailure(prepared.lease, new DocSandboxError('E_VALIDATION', 422), prepared.context)
      .then(() => undefined, (error: unknown) => error);
    const key = await proxy.waitAccepted();
    const expected = evidence.negative.report.artifacts![0]!;
    assert.deepEqual(await fixture.storage.get(prepared.scope, key, expected.sha256), expected.data);
    assert.ok((await fixture.repository.getInternal(prepared.id)).storageKeys.includes(key));
    // No early release or fake timer: the handler's actual shared 15s signal
    // must expire while its genuine successful PUT acknowledgement is held.
    const error = await handling;
    assert.ok(error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name));
    const elapsed = performance.now() - startedAt;
    assert.ok(elapsed >= 14_000 && elapsed < 25_000, 'observe the real 15s deadline with scheduling tolerance, not an early fault or a fresh compensation window');
    await proxy.close();
    const observed = proxy.observation();
    assert.equal(observed.failures, 0); assert.equal(observed.acceptedPuts, 1); assert.equal(observed.deliveredPuts, 0);
    assert.deepEqual(observed.methods, ['PUT']); assert.deepEqual(observed.deletedKeys, []);
    const after = await failureSnapshot(fixture, prepared);
    assert.deepEqual(after.artifacts, before.artifacts); assert.deepEqual(after.events, before.events);
    const pending = await fixture.repository.getInternal(prepared.id);
    assert.deepEqual(pending, { ...beforeState, storageKeys: [...beforeState.storageKeys, key] }, 'only the durable reservation may change before recovery');
    assert.equal(pending.status, 'validating'); assert.equal(pending.fence, prepared.lease.fence);
    assert.equal(pending.leaseToken, prepared.lease.token); assert.equal(pending.validationReportKey, null);
    assert.deepEqual(pending.outputKeys, []); assert.ok(pending.storageKeys.includes(key)); assert.equal(pending.purgedKeys.includes(key), false);
    assert.ok(prepared.notices.includes('DOC_STORAGE_CLEANUP_PENDING'));
    assert.deepEqual(await fixture.storage.get(prepared.scope, key, expected.sha256), expected.data, 'expired compensation cannot silently delete the accepted bytes');
    assert.deepEqual(await fixture.storage.get(prepared.scope, prepared.input.key, prepared.input.sha256), evidence.original.data);
    assert.deepEqual(await fixture.storage.get(prepared.otherScope, prepared.other.key, prepared.other.sha256), prepared.otherBytes);
    // Explicit recovery of this one synthetic job, not a scheduler assertion.
    await fixture.repository.deleteOwned(prepared.id, fixture.owner);
    await fixture.db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET cleanup_not_before=clock_timestamp()-interval '1 second' WHERE id=${prepared.id}`);
    const provider = new AnthropicDocumentProviderClient('fixture-unused-no-provider');
    const cleanupNotices: string[] = [];
    await reconcileDocumentCleanup(fixture.repository, fixture.storage, provider,
      AbortSignal.any([t.signal, AbortSignal.timeout(10_000)]), code => cleanupNotices.push(code));
    assert.deepEqual(cleanupNotices, []);
    assert.deepEqual(await fixture.storage.list(prepared.scope), []);
    const cleaned = await fixture.repository.getInternal(prepared.id);
    assert.equal(cleaned.cleanupPending, false); assert.ok(cleaned.purgedKeys.includes(key));
    assert.deepEqual(cleaned.providerFiles, []); assert.deepEqual(cleaned.providerContainers, []);
    assert.deepEqual(await fixture.storage.get(prepared.otherScope, prepared.other.key, prepared.other.sha256), prepared.otherBytes);
    assert.equal(prepared.engineConstructions(), 0);
  } finally {
    try {
      const closed = await Promise.allSettled([proxy?.close(), handling]);
      assert.ok(closed.every(result => result.status === 'fulfilled'), 'settle the worker and proxy before deleting their fixture');
    }
    finally { await fixture.close(); }
  }
});

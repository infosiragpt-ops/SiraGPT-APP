import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Prisma } from '@prisma/client';
import { reconcileDocumentCleanup } from '../src/modules/doc-sandbox/queue/cleanup';
import { AnthropicDocumentProviderClient } from '../src/modules/doc-sandbox/engine/provider-client';
import { createPrivateDocumentS3Client, PrivateDocumentStorage } from '../src/modules/doc-sandbox/storage/private-storage';
import { createDocumentIntegrationFixture, type DocumentIntegrationFixture } from './doc-sandbox-integration-fixture';

let fixture: DocumentIntegrationFixture;
before(async () => { fixture = await createDocumentIntegrationFixture(); });
after(async () => { if (fixture) await fixture.close(); });

test('real cleanup preserves grace and failed deletions, then purges scoped orphan bytes before acknowledging completion', async t => {
  const id = randomUUID();
  const scope = { userId: fixture.owner, jobId: id };
  const inputBytes = Buffer.from('Original retained until confirmed cleanup.');
  const instructionsBytes = Buffer.from('No provider call was admitted.');
  const input = fixture.storage.prepare(scope, inputBytes);
  const instructions = fixture.storage.prepare(scope, instructionsBytes);
  await fixture.repository.createJob({ id, userId: fixture.owner, idempotencyKey: randomUUID(),
    payloadHash: input.sha256, instructionsKey: instructions.key, requestedModel: 'fixture-mechanical',
    modelTier: 'mechanical', maxTokens: 1000, maxCostUsd: '0', promptVersion: 'fixture-cleanup',
    expiresAt: new Date(Date.now() + 86_400_000), ready: false,
    inputs: [{ kind: 'input', storageKey: input.key, filename: 'original.txt', mime: 'text/plain',
      size: inputBytes.length, sha256: input.sha256 }] });
  await fixture.storage.putPrepared(scope, input, inputBytes);
  await fixture.storage.putPrepared(scope, instructions, instructionsBytes);
  // A crash after PUT and before recording its key leaves only LIST as evidence.
  const orphanBytes = Buffer.from('Unregistered synthetic private artifact');
  const orphan = fixture.storage.prepare(scope, orphanBytes);
  await fixture.storage.putPrepared(scope, orphan, orphanBytes);
  const otherScope = { userId: fixture.other, jobId: randomUUID() };
  const untouchedBytes = Buffer.from('Another owner must remain untouched.');
  const untouched = fixture.storage.prepare(otherScope, untouchedBytes);
  await fixture.storage.putPrepared(otherScope, untouched, untouchedBytes);
  await fixture.repository.deleteOwned(id, fixture.owner);
  const provider = new AnthropicDocumentProviderClient('fixture-unused-no-provider');
  const notices: string[] = [];
  await reconcileDocumentCleanup(fixture.repository, fixture.storage, provider,
    new AbortController().signal, code => notices.push(code));
  assert.deepEqual(await fixture.storage.get(scope, input.key, input.sha256), inputBytes,
    'late-writer grace must preserve original bytes');
  assert.equal((await fixture.repository.getInternal(id)).cleanupPending, true);
  // Advance only this synthetic job's durable deadline, never clocks or services.
  await fixture.db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET cleanup_not_before=clock_timestamp()-interval '1 second' WHERE id=${id}`);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(reconcileDocumentCleanup(fixture.repository, fixture.storage, provider,
    cancelled.signal, code => notices.push(code)));
  assert.deepEqual(await fixture.storage.get(scope, input.key, input.sha256), inputBytes);
  const denied = await faultProxy(request => request.method === 'DELETE' ? 403 : 'pass');
  t.after(() => denied.close());
  await reconcileDocumentCleanup(fixture.repository, denied.storage, provider,
    new AbortController().signal, code => notices.push(code));
  assert.ok(notices.includes('DOC_CLEANUP_PENDING'));
  assert.equal((await fixture.repository.getInternal(id)).cleanupPending, true);
  assert.ok((await fixture.repository.pendingOutbox(100, 'cleanup')).some(event => event.jobId === id),
    'storage failure cannot acknowledge deletion');
  assert.deepEqual(await fixture.storage.get(scope, orphan.key, orphan.sha256), orphanBytes);
  // A fresh pass with working S3 must also discover and delete the unregistered key.
  await reconcileDocumentCleanup(fixture.repository, fixture.storage, provider,
    new AbortController().signal, code => notices.push(code));
  assert.deepEqual(await fixture.storage.list(scope), []);
  assert.equal((await fixture.repository.getInternal(id)).cleanupPending, false);
  assert.ok((await fixture.repository.artifactsInternal(id)).every(artifact => artifact.purgedAt));
  assert.equal((await fixture.repository.pendingOutbox(100, 'cleanup')).some(event => event.jobId === id), false);
  assert.deepEqual(await fixture.storage.get(otherScope, untouched.key, untouched.sha256), untouchedBytes);
  // There was no provider upload/call, and no remote deletion was substituted.
  assert.deepEqual((await fixture.repository.getInternal(id)).providerFiles, []);
});

/** A real HTTP fault proxy in front of the actual isolated S3 service, not a storage mock. */
async function faultProxy(fault: (request: IncomingMessage, attempt: number) => 'pass' | 'partial' | 403 | 412 | 503) {
  const upstream = new URL(fixture.config.r2Endpoint!);
  assert.equal(upstream.protocol, 'http:', 'fault proxy requires the isolated HTTP MinIO fixture');
  const attempts: Record<string, number> = {};
  const trace: string[] = [];
  const server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    const attempt = attempts[method] = (attempts[method] ?? 0) + 1;
    const action = fault(req, attempt);
    trace.push(`${method}:${attempt}:${action}`);
    if (typeof action === 'number') {
      res.writeHead(action, { 'Content-Type': 'application/xml', Connection: 'close' });
      res.end(`<Error><Code>${action === 503 ? 'SlowDown' : action === 412 ? 'PreconditionFailed' : 'AccessDenied'}</Code></Error>`);
      return;
    }
    // Preserve the signed Host header. Only the TCP target changes to the isolated service.
    const request = httpRequest({ hostname: upstream.hostname, port: upstream.port || '80',
      path: req.url, method, headers: req.headers }, response => {
      trace.push(`upstream:${response.statusCode}`);
      res.writeHead(response.statusCode ?? 502, response.headers);
      if (action === 'partial') {
        response.once('data', (chunk: Buffer) => {
          res.flushHeaders(); res.write(chunk.subarray(0, Math.min(32, chunk.length)));
          trace.push('partial-written');
          setTimeout(() => { trace.push('socket-destroyed'); res.destroy(); }, 30).unref();
        });
        response.resume();
      } else response.pipe(res);
      response.on('error', () => res.destroy());
    });
    request.on('error', () => res.destroy()); req.on('error', () => request.destroy()); req.pipe(request);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = createPrivateDocumentS3Client({ endpoint: `http://127.0.0.1:${address.port}`, region: 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: fixture.config.r2AccessKeyId, secretAccessKey: fixture.config.r2SecretAccessKey } });
  return { attempts, trace, storage: new PrivateDocumentStorage(client, { bucket: fixture.bucket, key: fixture.key, keyId: 'test-v1', maxBytes: 1024 * 1024 }),
    async close() { client.destroy(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

test('real S3 stores ciphertext only and round-trips exact bytes with scoped authenticated encryption', async () => {
  assert.equal(await fixture.s3.config.maxAttempts(), 1);
  assert.equal(await fixture.s3.config.responseChecksumValidation(), 'WHEN_REQUIRED');
  assert.equal(await fixture.s3.config.requestChecksumCalculation(), 'WHEN_SUPPORTED');
  const scope = { userId: fixture.owner, jobId: randomUUID() };
  const bytes = Buffer.from('Private fixture text — no model call\r\nPreserve ñ and line endings.\r\n');
  const object = fixture.storage.prepare(scope, bytes);
  await fixture.storage.putPrepared(scope, object, bytes);
  const raw = await fixture.s3.send(new GetObjectCommand({ Bucket: fixture.bucket, Key: object.key }));
  assert.ok(raw.Body);
  const stored = Buffer.from(await raw.Body.transformToByteArray());
  assert.equal(stored.subarray(0, 8).toString(), 'SIRADOC1');
  assert.equal(stored.length, bytes.length + 36);
  assert.ok(!stored.includes(bytes));
  assert.deepEqual(await fixture.storage.get(scope, object.key, object.sha256), bytes);
  await assert.rejects(fixture.storage.get({ userId: fixture.other, jobId: scope.jobId }, object.key, object.sha256));
  await assert.rejects(fixture.storage.get({ ...scope, jobId: randomUUID() }, object.key, object.sha256));
});

test('real S3 conditional put prevents overwriting an immutable original', async () => {
  const scope = { userId: fixture.owner, jobId: randomUUID() };
  const bytes = Buffer.from('immutable input');
  const object = fixture.storage.prepare(scope, bytes);
  await fixture.storage.putPrepared(scope, object, bytes);
  await assert.rejects(fixture.storage.putPrepared(scope, object, bytes), (error: unknown) => {
    assert.ok(error && typeof error === 'object' && '$metadata' in error);
    const metadata = error.$metadata;
    assert.ok(metadata && typeof metadata === 'object' && 'httpStatusCode' in metadata);
    return metadata.httpStatusCode === 412;
  });
  assert.deepEqual(await fixture.storage.get(scope, object.key, object.sha256), bytes);
});

test('a ciphertext tampered in the real fixture bucket fails authenticated decryption', async () => {
  const scope = { userId: fixture.owner, jobId: randomUUID() };
  const bytes = Buffer.from('tamper target fixture only');
  const object = fixture.storage.prepare(scope, bytes);
  await fixture.storage.putPrepared(scope, object, bytes);
  const original = await fixture.s3.send(new GetObjectCommand({ Bucket: fixture.bucket, Key: object.key }));
  assert.ok(original.Body);
  const modified = Buffer.from(await original.Body.transformToByteArray());
  modified[modified.length - 1] = modified[modified.length - 1]! ^ 1;
  await fixture.s3.send(new PutObjectCommand({ Bucket: fixture.bucket, Key: object.key, Body: modified }));
  await assert.rejects(fixture.storage.get(scope, object.key, object.sha256));
});

test('key rotation reads existing real objects only when the previous key is retained', async () => {
  const scope = { userId: fixture.owner, jobId: randomUUID() };
  const bytes = Buffer.from('rotation fixture');
  const object = fixture.storage.prepare(scope, bytes);
  await fixture.storage.putPrepared(scope, object, bytes);
  const nextKey = randomBytes(32);
  const rotated = new PrivateDocumentStorage(fixture.s3, { bucket: fixture.bucket, key: nextKey, keyId: 'test-v2', maxBytes: 1024 * 1024, previousKeys: { 'test-v1': fixture.key } });
  assert.deepEqual(await rotated.get(scope, object.key, object.sha256), bytes);
  const missingOld = new PrivateDocumentStorage(fixture.s3, { bucket: fixture.bucket, key: nextKey, keyId: 'test-v2', maxBytes: 1024 * 1024 });
  await assert.rejects(missingOld.get(scope, object.key, object.sha256));
});

test('real S3 listing and removal are restricted to the exact owner and job prefix', async () => {
  const first = { userId: fixture.owner, jobId: randomUUID() };
  const second = { userId: fixture.other, jobId: randomUUID() };
  const bytes = Buffer.from('scope fixture');
  const a = fixture.storage.prepare(first, bytes);
  const b = fixture.storage.prepare(second, bytes);
  await fixture.storage.putPrepared(first, a, bytes);
  await fixture.storage.putPrepared(second, b, bytes);
  assert.deepEqual(await fixture.storage.list(first), [a.key]);
  assert.deepEqual(await fixture.storage.list(second), [b.key]);
  await assert.rejects(fixture.storage.remove(first, b.key));
  await fixture.storage.remove(first, a.key);
  assert.deepEqual(await fixture.storage.list(first), []);
  await assert.rejects(fixture.storage.get(first, a.key));
  assert.deepEqual(await fixture.storage.get(second, b.key, b.sha256), bytes);
});

test('real HTTP partial GET failures discard ciphertext, retry twice and verify exact bytes from real S3', async () => {
  const scope = { userId: fixture.owner, jobId: randomUUID() };
  const bytes = randomBytes(64 * 1024);
  const object = fixture.storage.prepare(scope, bytes);
  await fixture.storage.putPrepared(scope, object, bytes);
  const proxy = await faultProxy((_req, attempt) => attempt < 3 ? 'partial' : 'pass');
  try {
    let downloaded: Buffer;
    try { downloaded = await proxy.storage.get(scope, object.key, object.sha256, AbortSignal.timeout(10_000)); }
    catch (cause) { throw new Error(`Partial GET fault trace: ${JSON.stringify(proxy.trace)}`, { cause }); }
    assert.deepEqual(downloaded, bytes);
    assert.equal(proxy.attempts.GET, 3);
  } finally { await proxy.close(); }
});

test('real HTTP retry ceiling is three attempts; 403 and 412 never retry', async () => {
  const scope = { userId: fixture.owner, jobId: randomUUID() };
  const object = fixture.storage.prepare(scope, Buffer.from('fixture'));
  for (const status of [503, 403, 412] as const) {
    const proxy = await faultProxy(() => status);
    try {
      await assert.rejects(proxy.storage.get(scope, object.key), (error: unknown) => {
        assert.ok(error && typeof error === 'object' && '$metadata' in error);
        const metadata = error.$metadata;
        assert.ok(metadata && typeof metadata === 'object' && 'httpStatusCode' in metadata);
        return metadata.httpStatusCode === status;
      });
      assert.equal(proxy.attempts.GET, status === 503 ? 3 : 1);
    } finally { await proxy.close(); }
  }
});

test('caller abort interrupts real HTTP backoff, and conditional PUT never retries', async () => {
  const scope = { userId: fixture.owner, jobId: randomUUID() };
  const bytes = Buffer.from('fixture');
  const object = fixture.storage.prepare(scope, bytes);
  const cancelled = new AbortController();
  const proxy = await faultProxy(req => { if (req.method === 'GET') setTimeout(() => cancelled.abort(), 10).unref(); return 503; });
  try {
    await assert.rejects(proxy.storage.get(scope, object.key, undefined, cancelled.signal));
    assert.equal(proxy.attempts.GET, 1);
    await assert.rejects(proxy.storage.putPrepared(scope, object, bytes));
    assert.equal(proxy.attempts.PUT, 1);
  } finally { await proxy.close(); }
});

test('real HTTP LIST and DELETE retry a transient response; final hash mismatch never retries', async () => {
  const scope = { userId: fixture.owner, jobId: randomUUID() };
  const bytes = Buffer.from('fixture');
  const object = fixture.storage.prepare(scope, bytes);
  await fixture.storage.putPrepared(scope, object, bytes);
  const proxy = await faultProxy((_req, attempt) => attempt === 1 ? 503 : 'pass');
  try {
    assert.deepEqual(await proxy.storage.list(scope), [object.key]);
    assert.equal(proxy.attempts.GET, 2);
    await proxy.storage.remove(scope, object.key);
    assert.equal(proxy.attempts.DELETE, 2);
    assert.deepEqual(await fixture.storage.list(scope), []);
  } finally { await proxy.close(); }
  const next = fixture.storage.prepare(scope, bytes);
  await fixture.storage.putPrepared(scope, next, bytes);
  const pass = await faultProxy(() => 'pass');
  try {
    await assert.rejects(pass.storage.get(scope, next.key, '0'.repeat(64)), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'E_VALIDATION');
    assert.equal(pass.attempts.GET, 1);
  } finally { await pass.close(); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { createPrivateDocumentS3Client, PrivateDocumentStorage, sealDocument } from '../src/modules/doc-sandbox/storage/private-storage';
import { DocSandboxError } from '../src/modules/doc-sandbox/types/errors';

// Local SDK command recording. No MinIO/R2 socket is opened.
const key = Buffer.alloc(32, 9);
const scope = { userId: 'owner-1', jobId: 'job-1' };
const valid = (name: string) => `doc-sandbox/owner-1/job-1/v1/${name}.sealed`;

function storage(send: (command: unknown) => Promise<unknown>) {
  const client = createPrivateDocumentS3Client({
    region: 'us-east-1', endpoint: 'http://127.0.0.1:1',
    credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, forcePathStyle: true,
  });
  client.send = send as typeof client.send;
  return new PrivateDocumentStorage(client, { bucket: 'unit', key, keyId: 'v1', maxBytes: 1024 });
}

test('iterPages yields validated keys and stops on a complete listing', async () => {
  const pages: string[][] = [];
  const instance = storage(async command => {
    assert.ok(command instanceof ListObjectsV2Command);
    return { IsTruncated: false, Contents: [{ Key: valid('a') }, { Key: valid('b') }] };
  });
  for await (const keys of instance.iterPages(scope)) pages.push([...keys]);
  assert.deepEqual(pages, [[valid('a'), valid('b')]]);
});

test('iterPages follows a single continuation token and rejects a repeating cursor', async () => {
  let calls = 0;
  const instance = storage(async () => {
    calls += 1;
    if (calls === 1) return { IsTruncated: true, NextContinuationToken: 'tok-1', Contents: [{ Key: valid('a') }] };
    return { IsTruncated: true, NextContinuationToken: 'tok-1', Contents: [{ Key: valid('b') }] };
  });
  await assert.rejects(async () => {
    for await (const _keys of instance.iterPages(scope)) { /* consume */ }
  }, (error: unknown) => error instanceof DocSandboxError && error.code === 'E_PROVIDER');
});

test('iterPages rejects missing truncation boolean, empty keys and foreign prefixes', async () => {
  await assert.rejects(async () => {
    for await (const _keys of storage(async () => ({ Contents: [] })).iterPages(scope)) { /* */ }
  }, (error: unknown) => error instanceof DocSandboxError && error.code === 'E_PROVIDER');
  await assert.rejects(async () => {
    for await (const _keys of storage(async () => ({ IsTruncated: false, Contents: [{ Key: '' }] })).iterPages(scope)) { /* */ }
  }, (error: unknown) => error instanceof DocSandboxError && error.code === 'E_PROVIDER');
  await assert.rejects(async () => {
    for await (const _keys of storage(async () => ({
      IsTruncated: false, Contents: [{ Key: 'doc-sandbox/other/job-1/v1/a.sealed' }],
    })).iterPages(scope)) { /* */ }
  }, (error: unknown) => error instanceof DocSandboxError && error.code === 'E_FORBIDDEN');
});

test('list accumulates pages and rejects an unbounded or looping cursor', async () => {
  let calls = 0;
  const instance = storage(async () => {
    calls += 1;
    if (calls === 1) return { IsTruncated: true, NextContinuationToken: 'n1', Contents: [{ Key: valid('a') }] };
    return { IsTruncated: false, Contents: [{ Key: valid('b') }] };
  });
  assert.deepEqual(await instance.list(scope), [valid('a'), valid('b')]);
  const looping = storage(async () => ({ IsTruncated: true, NextContinuationToken: 'same', Contents: [{ Key: valid('a') }] }));
  await assert.rejects(looping.list(scope), (error: unknown) => error instanceof DocSandboxError && error.code === 'E_PROVIDER');
  const truncated = storage(async () => ({ IsTruncated: true, Contents: [{ Key: valid('a') }] }));
  await assert.rejects(truncated.list(scope), (error: unknown) => error instanceof DocSandboxError && error.code === 'E_PROVIDER');
});

test('putPrepared, get and remove exercise sealed object send/receive without a remote bucket', async () => {
  const plaintext = Buffer.from('El informe dice 2026.\n');
  const digest = createHash('sha256').update(plaintext).digest('hex');
  let stored: Buffer | undefined;
  let putKey = '';
  let removed = '';
  let gets = 0;
  const instance = storage(async command => {
    if (command instanceof PutObjectCommand) {
      putKey = command.input.Key ?? '';
      stored = Buffer.from(command.input.Body as Buffer);
      return {};
    }
    if (command instanceof GetObjectCommand) {
      gets += 1;
      if (gets === 1) {
        const error = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
        throw error;
      }
      const body = Readable.from([stored ?? Buffer.alloc(0)]);
      return { Body: body, ContentLength: stored?.length ?? 0 };
    }
    if (command instanceof DeleteObjectCommand) {
      removed = command.input.Key ?? '';
      return {};
    }
    throw new Error('unexpected command');
  });
  const object = instance.prepare(scope, plaintext);
  await instance.putPrepared(scope, object, plaintext);
  assert.equal(putKey, object.key);
  const recovered = await instance.get(scope, object.key, digest);
  assert.deepEqual(recovered, plaintext);
  assert.equal(gets, 2);
  await instance.remove(scope, object.key);
  assert.equal(removed, object.key);
});

test('get rejects a missing body, oversized envelope and a hash mismatch', async () => {
  const plaintext = Buffer.from('ok');
  const objectKey = valid('obj');
  const sealed = sealDocument(plaintext, key, objectKey);
  await assert.rejects(storage(async () => ({ Body: undefined, ContentLength: 4 })).get(scope, objectKey),
    (error: unknown) => error instanceof DocSandboxError && error.code === 'E_VALIDATION');
  await assert.rejects(storage(async () => ({
    Body: Readable.from([sealed]), ContentLength: 10_000,
  })).get(scope, objectKey), (error: unknown) => error instanceof DocSandboxError && error.code === 'E_VALIDATION');
  const instance = storage(async () => ({ Body: Readable.from([sealed]), ContentLength: sealed.length }));
  await assert.rejects(instance.get(scope, objectKey, '0'.repeat(64)),
    (error: unknown) => error instanceof DocSandboxError && error.code === 'E_VALIDATION');
});

test('transientStorageError stays closed for abort and 4xx SDK metadata', async () => {
  const objectKey = valid('obj');
  await assert.rejects(storage(async () => {
    throw Object.assign(new Error('gone'), { name: 'AbortError' });
  }).get(scope, objectKey), (error: unknown) => error instanceof Error && error.name === 'AbortError');
  await assert.rejects(storage(async () => {
    throw Object.assign(new Error('denied'), { $metadata: { httpStatusCode: 403 } });
  }).get(scope, objectKey), (error: unknown) => error instanceof Error && String(error).includes('denied'));
  await assert.rejects(storage(async () => {
    throw Object.assign(new Error('busy'), { $metadata: { httpStatusCode: 503 } });
  }).get(scope, objectKey), () => true);
});

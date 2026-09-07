import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createPrivateDocumentS3Client, PrivateDocumentStorage } from '../src/modules/doc-sandbox/storage/private-storage';
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

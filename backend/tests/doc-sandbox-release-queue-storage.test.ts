import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { createPrivateDocumentS3Client, DocumentDownloadTickets, openDocument, PrivateDocumentStorage,
  sealDocument, type PrivateObject } from '../src/modules/doc-sandbox/storage/private-storage';
import { DocSandboxError, publicError } from '../src/modules/doc-sandbox/types/errors';

// Genuine crypto and genuine SDK construction; no S3/validator mocks or IO.
// Every storage call below must reject before a request is sent. Real streaming,
// retry, pagination, persistence and deletion need the separate MinIO suite.
const client = createPrivateDocumentS3Client({ region: 'us-east-1', endpoint: 'http://127.0.0.1:1',
  credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, forcePathStyle: true });
after(() => client.destroy());
const master = Buffer.alloc(32, 17);
const scope = { userId: 'unit-owner', jobId: 'unit-job' };
const current = new PrivateDocumentStorage(client, { bucket: 'synthetic-private', key: master, keyId: 'v2',
  previousKeys: { v1: Buffer.alloc(32, 19) }, maxBytes: 128 });
const data = Buffer.from('Private synthetic text: título 2026.');
const hash = (value: Buffer): string => createHash('sha256').update(value).digest('hex');
const code = (expected: string) => (error: unknown): boolean => error instanceof DocSandboxError && error.code === expected;

test('private S3 configuration fixes single SDK attempt and required-only response checksums', async () => {
  assert.equal(await client.config.maxAttempts(), 1);
  assert.equal(await client.config.responseChecksumValidation(), 'WHEN_REQUIRED');
  assert.equal(client.config.forcePathStyle, true);
  assert.equal(await client.config.region(), 'us-east-1');
});

test('all private object operations reject foreign tenant/job and path-confusion keys before IO', async () => {
  const good = current.prepare(scope, data);
  const keys = [
    good.key.replace('unit-owner/', 'different-owner/'), good.key.replace('unit-job/', 'different-job/'),
    good.key.replace('unit-job/', 'unit-job-suffix/'), `${good.key}/extra`,
    good.key.replace('/v2/', '/../'), good.key.replace('/v2/', '/v2/nested/'),
    good.key.replace('.sealed', '.txt'), good.key.replace('.sealed', '.sealed?public=true'),
    good.key.replace('/v2/', '/%2e%2e/'), good.key.replace('/v2/', '/v2\\other/'),
    '/absolute/file.sealed', 'doc-sandbox/unit-owner/unit-job/v2/.sealed',
  ];
  for (const key of keys) {
    await assert.rejects(current.get(scope, key), code('E_FORBIDDEN'));
    await assert.rejects(current.remove(scope, key), code('E_FORBIDDEN'));
    await assert.rejects(current.putPrepared(scope, { ...good, key }, data), code('E_FORBIDDEN'));
  }
});

test('prepared upload rejects old key version, altered digest, altered size and oversized plaintext', async () => {
  const good = current.prepare(scope, data);
  const invalid: PrivateObject[] = [
    { ...good, key: good.key.replace('/v2/', '/v1/') },
    { ...good, sha256: '0'.repeat(64) }, { ...good, size: data.length - 1 },
    { ...good, size: NaN }, { ...good, sha256: good.sha256.toUpperCase() },
  ];
  for (const object of invalid) await assert.rejects(current.putPrepared(scope, object, data), code('E_VALIDATION'));
  const large = Buffer.alloc(129, 1);
  await assert.rejects(current.putPrepared(scope, { ...good, size: large.length, sha256: hash(large) }, large), code('E_VALIDATION'));
  assert.deepEqual(data, Buffer.from('Private synthetic text: título 2026.'), 'Rejected uploads do not modify caller bytes');
});

test('prepare accepts exact maximum and zero-byte plaintext and keeps current key version', () => {
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(128, 0xff)]) {
    const object = current.prepare(scope, bytes);
    assert.equal(object.size, bytes.length);
    assert.equal(object.sha256, hash(bytes));
    assert.match(object.key, /^doc-sandbox\/unit-owner\/unit-job\/v2\/[a-f0-9-]{36}\.sealed$/);
    assert.deepEqual(openDocument(sealDocument(bytes, master, object.key), master, object.key), bytes);
  }
});

test('private identifiers reject empty, separators, controls and excessive lengths before preparation/listing', async () => {
  for (const id of ['', '.', '..', 'a/b', 'a\\b', 'a\0b', 'a\nb', 'a'.repeat(129), 'á']) {
    for (const badScope of [{ ...scope, userId: id }, { ...scope, jobId: id }]) {
      assert.throws(() => current.prefix(badScope));
      assert.throws(() => current.prepare(badScope, data));
      await assert.rejects(current.list(badScope));
    }
  }
});

test('binary AES-GCM round trip preserves all byte values and neither aliases nor mutates buffers', () => {
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  const before = Buffer.from(bytes), keyBefore = Buffer.from(master);
  const path = 'doc-sandbox/unit-owner/unit-job/v2/binary.sealed';
  const sealed = sealDocument(bytes, master, path), sealedBefore = Buffer.from(sealed);
  const clear = openDocument(sealed, master, path);
  assert.deepEqual(clear, before);
  assert.notEqual(clear, bytes);
  assert.deepEqual(bytes, before);
  assert.deepEqual(master, keyBefore);
  assert.deepEqual(sealed, sealedBefore);
  clear.fill(0);
  assert.deepEqual(bytes, before);
  assert.deepEqual(openDocument(sealed, master, path), before);
});

test('decrypt rejects invalid key lengths with stable public validation errors', () => {
  const path = current.prepare(scope, data).key;
  const sealed = sealDocument(data, master, path);
  for (const length of [0, 16, 31, 33, 64]) {
    assert.throws(() => openDocument(sealed, Buffer.alloc(length), path), code('E_VALIDATION'));
  }
});

test('ticket master and issued identities must satisfy crypto/schema contracts', () => {
  for (const length of [0, 16, 31, 33]) assert.throws(() => new DocumentDownloadTickets(Buffer.alloc(length)), code('E_NOT_READY'));
  const tickets = new DocumentDownloadTickets(master);
  for (const id of ['', 'other/user', 'id\0', 'a'.repeat(129)]) {
    assert.throws(() => tickets.issue(id, scope.jobId, 'artifact'));
    assert.throws(() => tickets.issue(scope.userId, id, 'artifact'));
    assert.throws(() => tickets.issue(scope.userId, scope.jobId, id));
  }
});

test('even correctly signed malformed JSON and wrong claim types cannot produce a download ticket', () => {
  const tickets = new DocumentDownloadTickets(master);
  const identity = { ...scope, artifactId: 'artifact' };
  const now = Date.UTC(2026, 8, 5, 12, 0, 0), iat = Math.floor(now / 1000);
  const signing = Buffer.from(hkdfSync('sha256', master, Buffer.from('siragpt-doc-sandbox-v1'), Buffer.from('download-ticket'), 32));
  const base = { v: 1, ...identity, iat, exp: iat + 60, nonce: 'synthetic-nonce' };
  const payloads = ['{broken json', 'null', '[]', JSON.stringify({ ...base, v: 2 }),
    JSON.stringify({ ...base, exp: String(iat + 60) }), JSON.stringify({ ...base, iat: iat + 0.5 }),
    JSON.stringify({ ...base, nonce: '' }), JSON.stringify({ ...base, artifactId: '../other' }),
    JSON.stringify({ ...base, userId: null }), JSON.stringify({ ...base, additional: 'private' })];
  for (const json of payloads) {
    const payload = Buffer.from(json).toString('base64url');
    const token = `${payload}.${createHmac('sha256', signing).update(payload).digest('base64url')}`;
    assert.throws(() => tickets.verify(token, identity, now), code('E_FORBIDDEN'));
  }
});

test('download ticket TTL boundaries use whole seconds without exposing crypto causes', () => {
  const tickets = new DocumentDownloadTickets(master), identity = { ...scope, artifactId: 'artifact' };
  const now = Date.UTC(2026, 8, 5, 12, 0, 0);
  const token = tickets.issue(identity.userId, identity.jobId, identity.artifactId, 1, now + 999);
  assert.equal(tickets.verify(token, identity, now + 999).exp, Math.floor(now / 1000) + 1);
  assert.throws(() => tickets.verify(token, identity, now + 1000), code('E_FORBIDDEN'));
  try { tickets.verify(`${token}x`, identity, now); assert.fail('Invalid signature accepted'); }
  catch (error) { assert.deepEqual(publicError(error), { code: 'E_FORBIDDEN', status: 403, message: 'No tienes acceso a este trabajo.' }); }
});

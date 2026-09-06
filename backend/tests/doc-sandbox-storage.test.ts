import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { sealDocument, openDocument, decodeStorageKey, DocumentDownloadTickets, PrivateDocumentStorage } from '../src/modules/doc-sandbox/storage/private-storage';
import { DocSandboxError, publicError } from '../src/modules/doc-sandbox/types/errors';

// Synthetic fixtures only. No provider calls or mocked validation/storage IO.
const key = Buffer.alloc(32, 7);
const previousKey = Buffer.alloc(32, 9);
const objectKey = 'doc-sandbox/user-a/job-a/v1/artifact.sealed';
const sample = Buffer.from('Private anonymous fixture\n2026 → 2027\n');
const code = (expected: string) => (error: unknown): boolean => error instanceof DocSandboxError && error.code === expected;
const identity = { userId: 'user-a', jobId: 'job-a', artifactId: 'artifact-a' };
const now = Date.UTC(2026, 8, 4, 12, 0, 0);

test('AES-GCM round trip retains exact bytes including Unicode', () => {
  const sealed = sealDocument(sample, key, objectKey);
  assert.equal(sealed.subarray(0, 8).toString(), 'SIRADOC1');
  assert.equal(sealed.length, sample.length + 36);
  assert.deepEqual(openDocument(sealed, key, objectKey), sample);
  assert.equal(sealed.includes(sample), false);
});
test('equal plaintext gets distinct random IVs/ciphertexts', () => {
  const first = sealDocument(sample, key, objectKey);
  const second = sealDocument(sample, key, objectKey);
  assert.notDeepEqual(first.subarray(8, 20), second.subarray(8, 20));
  assert.notDeepEqual(first, second);
});
test('empty bytes have an authenticated envelope, not a format error', () => {
  const sealed = sealDocument(Buffer.alloc(0), key, objectKey);
  assert.equal(sealed.length, 36);
  assert.equal(openDocument(sealed, key, objectKey).length, 0);
});
test('AAD binds document to tenant, job, key version and exact object path', () => {
  const sealed = sealDocument(sample, key, objectKey);
  for (const changed of [objectKey.replace('user-a', 'user-b'), objectKey.replace('job-a', 'job-b'),
    objectKey.replace('/v1/', '/v2/'), objectKey.replace('artifact.', 'other.')]) {
    assert.throws(() => openDocument(sealed, key, changed), code('E_VALIDATION'));
  }
});
test('wrong encryption key cannot decrypt ciphertext', () => {
  assert.throws(() => openDocument(sealDocument(sample, key, objectKey), previousKey, objectKey), code('E_VALIDATION'));
});
test('tampering with header, IV, authentication tag or ciphertext is rejected', () => {
  const sealed = sealDocument(sample, key, objectKey);
  for (const offset of [0, 7, 8, 19, 20, 35, 36, sealed.length - 1]) {
    const altered = Buffer.from(sealed); altered[offset] = altered[offset]! ^ 1;
    assert.throws(() => openDocument(altered, key, objectKey), code('E_VALIDATION'));
  }
});
test('truncated and unrelated envelopes are rejected', () => {
  const sealed = sealDocument(sample, key, objectKey);
  for (const length of [0, 8, 20, 35, sealed.length - 1]) {
    assert.throws(() => openDocument(sealed.subarray(0, length), key, objectKey), code('E_VALIDATION'));
  }
});
test('encryption accepts only 256-bit keys', () => {
  for (const length of [0, 16, 31, 33, 64]) assert.throws(() => sealDocument(sample, Buffer.alloc(length), objectKey), code('E_NOT_READY'));
});
test('base64 key decoding is exact and canonical', () => {
  assert.deepEqual(decodeStorageKey(key.toString('base64')), key);
  const zero = Buffer.alloc(32).toString('base64');
  for (const value of ['', zero.replace(/=$/, ''), ` ${zero}`, `${zero}\n`, zero.slice(0, -2) + 'B=',
    Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64'), 'not a key']) {
    assert.throws(() => decodeStorageKey(value), code('E_NOT_READY'));
  }
});

const storage = (overrides: Partial<ConstructorParameters<typeof PrivateDocumentStorage>[1]> = {}): PrivateDocumentStorage => {
  // Constructing this genuine client does not perform IO. Only pure prepare/prefix
  // and constructor validation are exercised; S3 IO needs a real MinIO test.
  const client = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'synthetic-test', secretAccessKey: 'synthetic-test' } });
  return new PrivateDocumentStorage(client, { bucket: 'unit-fixtures', key, keyId: 'v2', maxBytes: 1024,
    previousKeys: { v1: previousKey }, ...overrides });
};
test('key rotation retains stable job prefix while newly prepared keys use current version', () => {
  const current = storage();
  assert.equal(current.prefix(identity), 'doc-sandbox/user-a/job-a/');
  const prepared = current.prepare(identity, sample);
  assert.match(prepared.key, /^doc-sandbox\/user-a\/job-a\/v2\/[a-f0-9-]+\.sealed$/);
  assert.equal(prepared.sha256, createHash('sha256').update(sample).digest('hex'));
  assert.equal(prepared.size, sample.length);
});
test('keyring rejects invalid or colliding key IDs/lengths', () => {
  assert.throws(() => storage({ previousKeys: { v2: previousKey } }), code('E_NOT_READY'));
  assert.throws(() => storage({ previousKeys: { v1: Buffer.alloc(16) } }), code('E_NOT_READY'));
  assert.throws(() => storage({ keyId: '../unsafe' }));
  assert.throws(() => storage({ previousKeys: { '../unsafe': previousKey } }));
});
test('storage preparation validates scope, size and returns collision-resistant identities', () => {
  const current = storage();
  assert.throws(() => current.prefix({ userId: '../other-user', jobId: 'job-a' }));
  assert.throws(() => current.prefix({ userId: 'user-a', jobId: 'job-a/other' }));
  assert.throws(() => current.prepare(identity, Buffer.alloc(1025)), code('E_PARAMS'));
  assert.notEqual(current.prepare(identity, sample).key, current.prepare(identity, sample).key);
});
test('storage constructor rejects invalid limits and absent encryption material', () => {
  for (const maxBytes of [0, -1, 1.5, Infinity, NaN]) assert.throws(() => storage({ maxBytes }), code('E_NOT_READY'));
  assert.throws(() => storage({ bucket: '' }), code('E_NOT_READY'));
  assert.throws(() => storage({ key: Buffer.alloc(31) }), code('E_NOT_READY'));
});

test('download ticket is bound to authenticated identity, job and artifact', () => {
  const tickets = new DocumentDownloadTickets(key);
  const token = tickets.issue(identity.userId, identity.jobId, identity.artifactId, 600, now);
  const claims = tickets.verify(token, identity, now + 599_000);
  assert.equal(claims.exp - claims.iat, 600);
  for (const changed of [{ ...identity, userId: 'user-b' }, { ...identity, jobId: 'job-b' }, { ...identity, artifactId: 'artifact-b' }]) {
    assert.throws(() => tickets.verify(token, changed, now), code('E_FORBIDDEN'));
  }
});
test('download ticket expires exactly at its deadline and rejects future-issued tokens', () => {
  const tickets = new DocumentDownloadTickets(key);
  const token = tickets.issue(identity.userId, identity.jobId, identity.artifactId, 600, now);
  assert.throws(() => tickets.verify(token, identity, now + 600_000), code('E_FORBIDDEN'));
  assert.throws(() => tickets.verify(token, identity, now - 1000), code('E_FORBIDDEN'));
});
test('download TTL accepts only one to 600 whole seconds', () => {
  const tickets = new DocumentDownloadTickets(key);
  for (const ttl of [0, -1, 601, 1.5, NaN, Infinity]) {
    assert.throws(() => tickets.issue(identity.userId, identity.jobId, identity.artifactId, ttl, now), code('E_PARAMS'));
  }
  const one = tickets.issue(identity.userId, identity.jobId, identity.artifactId, 1, now);
  assert.equal(tickets.verify(one, identity, now).exp - tickets.verify(one, identity, now).iat, 1);
});
test('download ticket tampering, wrong signing master and malformed inputs fail closed', () => {
  const tickets = new DocumentDownloadTickets(key);
  const token = tickets.issue(identity.userId, identity.jobId, identity.artifactId, 60, now);
  const [payload, signature] = token.split('.') as [string, string];
  for (const altered of ['', 'abc', `${payload}.`, `${payload}.${signature.slice(0, -1)}`, `${token}x`, 'x'.repeat(2001),
    `${payload}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`]) {
    assert.throws(() => tickets.verify(altered, identity, now), code('E_FORBIDDEN'));
  }
  assert.throws(() => new DocumentDownloadTickets(previousKey).verify(token, identity, now), code('E_FORBIDDEN'));
});
test('signed adversarial ticket claims cannot exceed TTL or bypass schema', () => {
  const tickets = new DocumentDownloadTickets(key);
  const signing = Buffer.from(hkdfSync('sha256', key, Buffer.from('siragpt-doc-sandbox-v1'), Buffer.from('download-ticket'), 32));
  const iat = Math.floor(now / 1000);
  for (const claims of [{ v: 1, ...identity, nonce: 'nonce', iat, exp: iat + 601 },
    { v: 1, ...identity, nonce: 'nonce', iat, exp: iat },
    { v: 1, ...identity, nonce: 'nonce', iat, exp: iat + 60, unexpected: true }]) {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const token = `${payload}.${createHmac('sha256', signing).update(payload).digest('base64url')}`;
    assert.throws(() => tickets.verify(token, identity, now), code('E_FORBIDDEN'));
  }
});
test('each ticket issuance has independent nonce; replay remains subject to route ownership/tombstone', () => {
  const tickets = new DocumentDownloadTickets(key);
  const first = tickets.issue(identity.userId, identity.jobId, identity.artifactId, 60, now);
  const second = tickets.issue(identity.userId, identity.jobId, identity.artifactId, 60, now);
  assert.notEqual(tickets.verify(first, identity, now).nonce, tickets.verify(second, identity, now).nonce);
});
test('public errors never reveal crypto causes or plaintext', () => {
  const failure = new DocSandboxError('E_VALIDATION', 422, { cause: new Error(sample.toString()) });
  assert.deepEqual(Object.keys(publicError(failure)).sort(), ['code', 'message', 'status']);
  assert.equal(JSON.stringify(publicError(failure)).includes(sample.toString()), false);
  assert.equal(JSON.stringify(publicError(new Error('synthetic-private-secret'))).includes('synthetic-private-secret'), false);
});

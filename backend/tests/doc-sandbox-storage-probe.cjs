'use strict';

// Infrastructure proof for synthetic campaigns, never an application endpoint.
// HEAD alone does not establish write/delete permissions, encryption or privacy.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { GetObjectCommand } = require('@aws-sdk/client-s3');

function isolatedProbeTarget(endpoint, bucket) {
  const url = new URL(endpoint);
  assert.ok(['http:', 'https:'].includes(url.protocol));
  assert.ok(['localhost', '127.0.0.1', '[::1]', 'doc-sandbox-test-minio'].includes(url.hostname),
    'Storage probe requires an isolated test endpoint');
  assert.ok(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/',
    'Storage endpoint must not contain credentials, a path, query or fragment');
  assert.match(bucket, /^doc-sandbox-(?:test-[a-f0-9]{32}|phase1-real(?:-[a-z0-9-]+)?)$/);
  return url;
}

async function privateRecord(filename, value) {
  const handle = await fs.open(filename, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  const directory = await fs.open(path.dirname(filename), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function verifyIsolatedDocumentStorage({ storage, s3, endpoint, bucket, signal, evidenceDirectory }) {
  const target = isolatedProbeTarget(endpoint, bucket);
  const bounded = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
  bounded.throwIfAborted();
  assert.ok(typeof evidenceDirectory === 'string' && path.isAbsolute(evidenceDirectory));
  const directory = await fs.lstat(evidenceDirectory);
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink() && (directory.mode & 0o077) === 0,
    'Storage probe evidence must be a private real directory');
  assert.equal(directory.uid, process.getuid());
  assert.equal(await fs.realpath(evidenceDirectory), evidenceDirectory);
  const scope = { userId: `storage-probe-${randomUUID()}`, jobId: randomUUID() };
  const plaintext = Buffer.from(`Synthetic storage preflight ${randomUUID()}\r\nSin documentos de usuarios.\r\n`);
  const object = storage.prepare(scope, plaintext);
  const journal = `storage-probe-${scope.jobId}.json`;
  // Persist the exact target BEFORE PUT so a crash or failed DELETE can be
  // reconciled without listing any other job/bucket. No credentials or document.
  await privateRecord(path.join(evidenceDirectory, journal), { version: 1, syntheticOnly: true,
    scope, bucket, key: object.key, createdAt: new Date().toISOString() });
  let attempted = false;
  let putConfirmed = false;
  let proof;
  try {
    attempted = true; // An interrupted PUT can still have committed on the server.
    await storage.putPrepared(scope, object, plaintext, bounded);
    putConfirmed = true;
    const raw = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: object.key }), { abortSignal: bounded });
    assert.ok(raw.Body && Symbol.asyncIterator in raw.Body, 'Ciphertext must be readable');
    const body = raw.Body;
    const close = () => { if (typeof body.destroy === 'function') body.destroy(); };
    bounded.addEventListener('abort', close, { once: true });
    let ciphertext;
    try {
      bounded.throwIfAborted();
      const chunks = []; let size = 0;
      for await (const piece of body) {
        bounded.throwIfAborted(); size += piece.byteLength;
        assert.ok(size <= plaintext.length + 36, 'Unexpected ciphertext length');
        chunks.push(Buffer.from(piece));
      }
      ciphertext = Buffer.concat(chunks);
    } finally { bounded.removeEventListener('abort', close); close(); }
    assert.equal(ciphertext.length, plaintext.length + 36, 'Authenticated encryption envelope is required');
    assert.equal(ciphertext.subarray(0, 8).toString(), 'SIRADOC1');
    assert.ok(!ciphertext.includes(plaintext), 'Storage must not contain plaintext');
    assert.equal(raw.ContentType, 'application/octet-stream');
    assert.equal(raw.CacheControl, 'private, no-store');
    assert.equal(raw.Metadata?.format, 'siradoc-aes256gcm-v1');
    assert.ok((await storage.get(scope, object.key, object.sha256, bounded)).equals(plaintext),
      'Authenticated decryption must restore the exact bytes');
    assert.deepEqual(await storage.list(scope, bounded), [object.key]);

    // No SDK signing, cookies, auth headers, redirect following or guessed URL.
    // The signed GET above proves this exact object exists before the denial test.
    target.pathname = `/${bucket}/${object.key.split('/').map(encodeURIComponent).join('/')}`;
    const anonymous = await fetch(target, { method: 'GET', credentials: 'omit', redirect: 'error', signal: bounded });
    try {
      assert.ok([401, 403].includes(anonymous.status), 'An existing private object must explicitly deny anonymous GET');
    } finally { await anonymous.body?.cancel(); }
    proof = { version: 1, kind: 'isolated-s3-crud-encryption-proof', syntheticOnly: true,
      create: true, list: true, readExact: true, authenticatedEncryption: true,
      anonymousGetStatus: anonymous.status, testedEndpointOnly: true,
      productionR2PrivacyVerified: false, providerRequests: 0, journal };
  } finally {
    if (attempted) {
      // Separate bounded cleanup also runs after caller cancellation. Delete only
      // this probe's random object, never a bucket, another job or a broad prefix.
      try {
        const cleanup = AbortSignal.timeout(10_000);
        await storage.remove(scope, object.key, cleanup);
        assert.deepEqual(await storage.list(scope, cleanup), [], 'Probe deletion must be verified');
        await privateRecord(path.join(evidenceDirectory, `${journal}.cleanup.json`), {
          version: 1, deleteVerified: putConfirmed, pendingLateWrite: !putConfirmed,
          verifiedAt: new Date().toISOString() });
        // A failed/aborted PUT may commit after DELETE. Retain the journal and
        // refuse a cleanup certificate until an operator reconciles that write.
        assert.ok(putConfirmed, 'Uncertain PUT requires later exact-key reconciliation');
      } catch {
        throw Object.assign(new Error('Synthetic storage probe cleanup needs review.'), { code: 'DOC_STORAGE_PROBE_CLEANUP_PENDING' });
      }
    }
  }
  return { ...proof, deleteVerified: true };
}

module.exports = { isolatedProbeTarget, verifyIsolatedDocumentStorage };

'use strict';

const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { PutBucketPolicyCommand, DeleteBucketPolicyCommand } = require('@aws-sdk/client-s3');
const { createDocumentIntegrationFixture } = require('./doc-sandbox-integration-fixture.ts');
const { verifyIsolatedDocumentStorage } = require('./doc-sandbox-storage-probe.cjs');

let fixture, evidenceDirectory;
before(async () => {
  evidenceDirectory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'doc-storage-proof-'));
  fixture = await createDocumentIntegrationFixture();
});
after(async () => {
  // Retain the exact-key journals if MinIO cleanup fails. They must not be lost
  // in a finally block precisely when an operator needs to reconcile a write.
  if (fixture) await fixture.close();
  if (evidenceDirectory) await fs.rm(evidenceDirectory, { recursive: true, force: true });
});
function probe() {
  return verifyIsolatedDocumentStorage({ storage: fixture.storage, s3: fixture.s3,
    bucket: fixture.bucket, endpoint: fixture.config.r2Endpoint, evidenceDirectory });
}

test('real isolated storage proves encrypted CRUD and anonymous denial, without claiming production R2', async () => {
  const { journal, ...proof } = await probe();
  assert.deepEqual(proof, {
    version: 1, kind: 'isolated-s3-crud-encryption-proof', syntheticOnly: true,
    create: true, list: true, readExact: true, authenticatedEncryption: true,
    anonymousGetStatus: 403, testedEndpointOnly: true, productionR2PrivacyVerified: false,
    providerRequests: 0, deleteVerified: true,
  });
  assert.match(journal, /^storage-probe-[a-f0-9-]+\.json$/);
  const record = path.join(evidenceDirectory, journal);
  assert.equal((await fs.stat(record)).mode & 0o077, 0);
  const target = JSON.parse(await fs.readFile(record, 'utf8'));
  assert.equal(target.bucket, fixture.bucket);
  assert.equal(target.syntheticOnly, true);
  assert.deepEqual(await fixture.storage.list(target.scope), []);
  assert.equal(JSON.parse(await fs.readFile(`${record}.cleanup.json`, 'utf8')).deleteVerified, true);
});

test('a genuinely public synthetic bucket fails the probe despite working authenticated HEAD/GET', async () => {
  // This newly generated test bucket contains synthetic objects only. The actual
  // MinIO policy changes; no storage, HTTP response or validator is mocked.
  assert.match(fixture.bucket, /^doc-sandbox-test-[a-f0-9]{32}$/);
  await fixture.s3.send(new PutBucketPolicyCommand({ Bucket: fixture.bucket,
    Policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*',
      Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${fixture.bucket}/*`] }] }) }));
  try { await assert.rejects(probe(), /must explicitly deny anonymous GET/); }
  finally { await fixture.s3.send(new DeleteBucketPolicyCommand({ Bucket: fixture.bucket })); }
  assert.equal((await probe()).deleteVerified, true, 'Restored private policy must be tested again');
});

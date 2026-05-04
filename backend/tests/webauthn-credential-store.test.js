/**
 * webauthn-credential-store — pins the in-memory store contract.
 * The Prisma-backed store is a future commit; this test verifies
 * the interface that any backend implementation must honor.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createInMemoryCredentialStore,
} = require("../src/services/webauthn/credential-store");

const sampleCredential = {
  id: 'cred-abc',
  userId: 'u-1',
  publicKey: 'aaaaaaaa==',
  counter: 0,
  transports: ['internal'],
  label: 'iPhone Touch ID',
};

describe("createInMemoryCredentialStore — basic CRUD", () => {
  test("save then findById round-trip", async () => {
    const store = createInMemoryCredentialStore();
    await store.save(sampleCredential);
    const got = await store.findById('cred-abc');
    assert.equal(got.id, 'cred-abc');
    assert.equal(got.userId, 'u-1');
    assert.equal(got.label, 'iPhone Touch ID');
  });

  test("listForUser returns all credentials for a user", async () => {
    const store = createInMemoryCredentialStore();
    await store.save({ ...sampleCredential, id: 'cred-1' });
    await store.save({ ...sampleCredential, id: 'cred-2' });
    await store.save({ ...sampleCredential, id: 'cred-3', userId: 'u-2' });
    const u1 = await store.listForUser('u-1');
    assert.equal(u1.length, 2);
    assert.deepEqual(u1.map(c => c.id).sort(), ['cred-1', 'cred-2']);
    const u2 = await store.listForUser('u-2');
    assert.equal(u2.length, 1);
  });

  test("listForUser returns empty array for unknown user", async () => {
    const store = createInMemoryCredentialStore();
    assert.deepEqual(await store.listForUser('nobody'), []);
  });

  test("findById returns null for unknown id", async () => {
    const store = createInMemoryCredentialStore();
    assert.equal(await store.findById('nope'), null);
  });

  test("save without id or userId throws", async () => {
    const store = createInMemoryCredentialStore();
    await assert.rejects(() => store.save({ id: 'x' }), /must have id and userId/);
    await assert.rejects(() => store.save({ userId: 'u-1' }), /must have id and userId/);
  });
});

describe("updateCounter — monotonic guard", () => {
  test("accepts strictly-increasing counter", async () => {
    const store = createInMemoryCredentialStore();
    await store.save({ ...sampleCredential, counter: 5 });
    await store.updateCounter('cred-abc', 6);
    const after = await store.findById('cred-abc');
    assert.equal(after.counter, 6);
  });

  test("rejects regression — possible cloned authenticator", async () => {
    const store = createInMemoryCredentialStore();
    await store.save({ ...sampleCredential, counter: 5 });
    await assert.rejects(
      () => store.updateCounter('cred-abc', 4),
      /counter regressed/,
    );
  });

  test("rejects equal counter (also regression-equivalent)", async () => {
    const store = createInMemoryCredentialStore();
    await store.save({ ...sampleCredential, counter: 5 });
    await assert.rejects(
      () => store.updateCounter('cred-abc', 5),
      /counter regressed/,
    );
  });

  test("counter:0 → counter:0 is allowed (authenticator without counter support)", async () => {
    const store = createInMemoryCredentialStore();
    await store.save({ ...sampleCredential, counter: 0 });
    // Some authenticators report counter=0 indefinitely. The guard
    // only triggers once a non-zero counter has been observed.
    await store.updateCounter('cred-abc', 0);
    const after = await store.findById('cred-abc');
    assert.equal(after.counter, 0);
  });

  test("non-existent credential is silently ignored", async () => {
    const store = createInMemoryCredentialStore();
    await assert.doesNotReject(() => store.updateCounter('nope', 99));
  });
});

describe("delete — tenant scoping", () => {
  test("user can delete their own credential", async () => {
    const store = createInMemoryCredentialStore();
    await store.save(sampleCredential);
    const ok = await store.delete('cred-abc', 'u-1');
    assert.equal(ok, true);
    assert.equal(await store.findById('cred-abc'), null);
  });

  test("user CANNOT delete another user's credential", async () => {
    const store = createInMemoryCredentialStore();
    await store.save(sampleCredential);
    const ok = await store.delete('cred-abc', 'u-different');
    assert.equal(ok, false);
    // Original is untouched.
    assert.notEqual(await store.findById('cred-abc'), null);
  });

  test("delete with no userId acts as admin (clears regardless of owner)", async () => {
    const store = createInMemoryCredentialStore();
    await store.save(sampleCredential);
    const ok = await store.delete('cred-abc');
    assert.equal(ok, true);
  });

  test("delete of unknown id returns false", async () => {
    const store = createInMemoryCredentialStore();
    assert.equal(await store.delete('nope', 'u-1'), false);
  });

  test("listForUser reflects deletes", async () => {
    const store = createInMemoryCredentialStore();
    await store.save({ ...sampleCredential, id: 'cred-1' });
    await store.save({ ...sampleCredential, id: 'cred-2' });
    await store.delete('cred-1', 'u-1');
    const remaining = await store.listForUser('u-1');
    assert.deepEqual(remaining.map(c => c.id), ['cred-2']);
  });

  test("user with all credentials deleted disappears from the index", async () => {
    const store = createInMemoryCredentialStore();
    await store.save(sampleCredential);
    await store.delete('cred-abc', 'u-1');
    assert.deepEqual(await store.listForUser('u-1'), []);
  });
});

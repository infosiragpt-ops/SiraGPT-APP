'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDbProbe } = require('../src/health/probes/db');

test('exports createDbProbe', () => {
  assert.equal(typeof createDbProbe, 'function');
});

test('throws TypeError when prisma is missing or lacks $queryRaw', () => {
  assert.throws(() => createDbProbe({ prisma: null }), TypeError);
  assert.throws(() => createDbProbe({ prisma: {} }), TypeError);
  assert.throws(() => createDbProbe({ prisma: { $queryRaw: 'not-a-function' } }), TypeError);
  assert.throws(() => createDbProbe({}), TypeError);
});

test('returns "pass" when SELECT 1 returns { ok: 1 }', async () => {
  const prisma = { $queryRaw: async () => [{ ok: 1 }] };
  const probe = createDbProbe({ prisma });
  const result = await probe.run();
  assert.equal(result.status, 'pass');
  assert.equal(result.details.sampleRows, 1);
  assert.equal(typeof result.details.driverElapsedMs, 'number');
  assert.ok(result.details.driverElapsedMs >= 0);
});

test('returns "pass" when SELECT 1 returns { ok: "1" } (string variant)', async () => {
  const prisma = { $queryRaw: async () => [{ ok: '1' }] };
  const probe = createDbProbe({ prisma });
  const result = await probe.run();
  assert.equal(result.status, 'pass');
});

test('returns "pass" when SELECT 1 returns { ok: true } (boolean variant)', async () => {
  const prisma = { $queryRaw: async () => [{ ok: true }] };
  const probe = createDbProbe({ prisma });
  const result = await probe.run();
  assert.equal(result.status, 'pass');
});

test('returns "pass" when the column comes back uppercase as OK (some drivers)', async () => {
  const prisma = { $queryRaw: async () => [{ OK: 1 }] };
  const probe = createDbProbe({ prisma });
  const result = await probe.run();
  assert.equal(result.status, 'pass');
});

test('returns "warn" when SELECT 1 returns an unexpected value', async () => {
  const prisma = { $queryRaw: async () => [{ ok: 42 }] };
  const probe = createDbProbe({ prisma });
  const result = await probe.run();
  assert.equal(result.status, 'warn');
});

test('returns "warn" when SELECT 1 returns an empty array', async () => {
  const prisma = { $queryRaw: async () => [] };
  const probe = createDbProbe({ prisma });
  const result = await probe.run();
  assert.equal(result.status, 'warn');
  assert.equal(result.details.sampleRows, 0);
});

test('returns "warn" when SELECT 1 returns a non-array', async () => {
  const prisma = { $queryRaw: async () => null };
  const probe = createDbProbe({ prisma });
  const result = await probe.run();
  assert.equal(result.status, 'warn');
  assert.equal(result.details.sampleRows, 0);
});

test('fails when $queryRaw rejects', async () => {
  const prisma = { $queryRaw: async () => { throw new Error('connection refused'); } };
  const probe = createDbProbe({ prisma });
  const result = await probe.run();
  assert.equal(result.status, 'fail');
});

test('probe.name defaults to "database" and can be overridden', () => {
  const prisma = { $queryRaw: async () => [{ ok: 1 }] };
  const a = createDbProbe({ prisma });
  const b = createDbProbe({ prisma, name: 'db-replica' });
  assert.equal(a.name, 'database');
  assert.equal(b.name, 'db-replica');
});

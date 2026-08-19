'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRedisProbe } = require('../src/health/probes/redis');

test('exports createRedisProbe', () => {
  assert.equal(typeof createRedisProbe, 'function');
});

test('throws TypeError when client lacks .ping()', () => {
  assert.throws(() => createRedisProbe({ client: null }), TypeError);
  assert.throws(() => createRedisProbe({ client: {} }), TypeError);
  assert.throws(() => createRedisProbe({}), TypeError);
});

test('returns "pass" when ping resolves with "PONG"', async () => {
  const client = { ping: async () => 'PONG' };
  const probe = createRedisProbe({ client });
  const result = await probe.run();
  assert.equal(result.status, 'pass');
  assert.equal(result.details.reply, 'PONG');
});

test('returns "pass" when ping resolves with lowercase "pong"', async () => {
  const client = { ping: async () => 'pong' };
  const probe = createRedisProbe({ client });
  const result = await probe.run();
  assert.equal(result.status, 'pass');
});

test('returns "pass" when ping resolves with boolean true', async () => {
  const client = { ping: async () => true };
  const probe = createRedisProbe({ client });
  const result = await probe.run();
  assert.equal(result.status, 'pass');
});

test('returns "warn" when ping resolves with an unexpected reply', async () => {
  const client = { ping: async () => 'SOMETHING_ELSE' };
  const probe = createRedisProbe({ client });
  const result = await probe.run();
  assert.equal(result.status, 'warn');
  assert.equal(result.details.reply, 'SOMETHING_ELSE');
});

test('fails when ping rejects', async () => {
  const client = { ping: async () => { throw new Error('ETIMEDOUT'); } };
  const probe = createRedisProbe({ client });
  const result = await probe.run();
  assert.equal(result.status, 'fail');
});

test('details include driverElapsedMs as a non-negative number', async () => {
  const client = { ping: async () => 'PONG' };
  const probe = createRedisProbe({ client });
  const result = await probe.run();
  assert.equal(typeof result.details.driverElapsedMs, 'number');
  assert.ok(result.details.driverElapsedMs >= 0);
});

test('reply field is truncated to 32 chars', async () => {
  const longReply = 'x'.repeat(100);
  const client = { ping: async () => longReply };
  const probe = createRedisProbe({ client });
  const result = await probe.run();
  assert.ok(result.details.reply.length <= 32);
});

test('probe.name defaults to "redis" and can be overridden', () => {
  const client = { ping: async () => 'PONG' };
  const a = createRedisProbe({ client });
  const b = createRedisProbe({ client, name: 'redis-cache' });
  assert.equal(a.name, 'redis');
  assert.equal(b.name, 'redis-cache');
});

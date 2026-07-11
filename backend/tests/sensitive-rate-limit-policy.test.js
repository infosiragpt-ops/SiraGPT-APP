'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../src/middleware/rate-limit-policy');

test('sensitive policy defaults to distributed fail-closed behavior in production', () => {
  assert.equal(typeof policy.resolveSensitiveRateLimitPolicy, 'function');
  assert.deepEqual(
    policy.resolveSensitiveRateLimitPolicy({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://redis.internal:6379',
    }),
    {
      configuredMode: 'distributed',
      mode: 'distributed',
      valid: true,
      explicit: false,
      requireDistributed: true,
      failClosed: true,
      retryAfterSeconds: 5,
    },
  );
});

test('sensitive policy permits explicit memory and fail-open modes only outside production', () => {
  const memory = policy.resolveSensitiveRateLimitPolicy({
    NODE_ENV: 'test',
    RATE_LIMIT_SENSITIVE_POLICY: 'memory',
    RATE_LIMIT_STORE: 'memory',
  });
  assert.equal(memory.mode, 'memory');
  assert.equal(memory.requireDistributed, false);
  assert.equal(memory.failClosed, false);
  assert.equal(memory.explicit, true);

  const failOpen = policy.resolveSensitiveRateLimitPolicy({
    NODE_ENV: 'development',
    RATE_LIMIT_SENSITIVE_POLICY: 'fail-open',
    REDIS_URL: 'redis://localhost:6379',
  });
  assert.equal(failOpen.mode, 'fail-open');
  assert.equal(failOpen.requireDistributed, false);
  assert.equal(failOpen.failClosed, false);
});

test('sensitive policy overrides unsafe production configuration to distributed at runtime', () => {
  for (const configuredMode of ['memory', 'fail-open']) {
    const resolved = policy.resolveSensitiveRateLimitPolicy({
      NODE_ENV: 'production',
      RATE_LIMIT_SENSITIVE_POLICY: configuredMode,
      RATE_LIMIT_STORE: configuredMode === 'memory' ? 'memory' : 'redis',
      REDIS_URL: 'redis://redis.internal:6379',
      RATE_LIMIT_STORE_RETRY_AFTER_SECONDS: '12',
    });
    assert.equal(resolved.configuredMode, configuredMode);
    assert.equal(resolved.mode, 'distributed');
    assert.equal(resolved.valid, true);
    assert.equal(resolved.requireDistributed, true);
    assert.equal(resolved.failClosed, true);
    assert.equal(resolved.retryAfterSeconds, 12);
  }
});

test('sensitive policy marks unknown values invalid without reflecting them', () => {
  const resolved = policy.resolveSensitiveRateLimitPolicy({
    NODE_ENV: 'production',
    RATE_LIMIT_SENSITIVE_POLICY: 'redis://user:secret@host',
  });
  assert.equal(resolved.valid, false);
  assert.equal(resolved.configuredMode, 'invalid');
  assert.equal(resolved.mode, 'distributed');
  assert.doesNotMatch(JSON.stringify(resolved), /user|secret|host/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REDACTION_CENSOR,
  SENSITIVE_KEYS,
  isSensitiveKey,
  redactPayloadDeep,
} = require('../src/utils/log-redaction');

test('exports the documented surface', () => {
  assert.equal(REDACTION_CENSOR, '[REDACTED]');
  assert.ok(SENSITIVE_KEYS instanceof Set);
  assert.equal(typeof isSensitiveKey, 'function');
  assert.equal(typeof redactPayloadDeep, 'function');
});

test('SENSITIVE_KEYS covers common credential names', () => {
  for (const expected of ['password', 'token', 'apikey', 'authorization', 'cookie', 'private_key', 'secret_access_key']) {
    assert.ok(SENSITIVE_KEYS.has(expected), `expected SENSITIVE_KEYS to include "${expected}"`);
  }
});

test('isSensitiveKey detects exact matches case-insensitively', () => {
  assert.equal(isSensitiveKey('password'), true);
  assert.equal(isSensitiveKey('PASSWORD'), true);
  assert.equal(isSensitiveKey('Password'), true);
  assert.equal(isSensitiveKey('token'), true);
  assert.equal(isSensitiveKey('Authorization'), true);
});

test('isSensitiveKey detects normalised variants (dashes, underscores, dots)', () => {
  assert.equal(isSensitiveKey('api-key'), true);
  assert.equal(isSensitiveKey('api_key'), true);
  assert.equal(isSensitiveKey('Api.Key'), true);
  assert.equal(isSensitiveKey('refresh-token'), true);
  assert.equal(isSensitiveKey('refresh_token'), true);
  assert.equal(isSensitiveKey('x-api-key'), true);
  assert.equal(isSensitiveKey('client_secret'), true);
  assert.equal(isSensitiveKey('client-secret'), true);
});

test('isSensitiveKey ignores benign keys', () => {
  assert.equal(isSensitiveKey('userId'), false);
  assert.equal(isSensitiveKey('email'), false);
  assert.equal(isSensitiveKey('createdAt'), false);
  assert.equal(isSensitiveKey('description'), false);
  assert.equal(isSensitiveKey(''), false);
  assert.equal(isSensitiveKey(null), false);
  assert.equal(isSensitiveKey(undefined), false);
});

test('redactPayloadDeep censors sensitive top-level keys', () => {
  const input = { userId: 'u1', apiKey: 'sk-secret-key', email: 'a@b.com' };
  const out = redactPayloadDeep(input);
  assert.equal(out.userId, 'u1');
  assert.equal(out.email, 'a@b.com');
  assert.equal(out.apiKey, '[REDACTED]');
});

test('redactPayloadDeep recurses into nested objects', () => {
  const input = {
    user: { id: 1, name: 'alice' },
    auth: { token: 'jwt-secret', expiresAt: 1234567 },
    request: { headers: { authorization: 'Bearer abc', 'content-type': 'json' } },
  };
  const out = redactPayloadDeep(input);
  assert.equal(out.user.name, 'alice');
  assert.equal(out.auth.token, '[REDACTED]');
  assert.equal(out.auth.expiresAt, 1234567);
  assert.equal(out.request.headers.authorization, '[REDACTED]');
  assert.equal(out.request.headers['content-type'], 'json');
});

test('redactPayloadDeep censors sensitive values inside arrays', () => {
  const input = {
    history: [
      { event: 'login', token: 'one' },
      { event: 'refresh', token: 'two' },
    ],
  };
  const out = redactPayloadDeep(input);
  assert.equal(out.history.length, 2);
  assert.equal(out.history[0].token, '[REDACTED]');
  assert.equal(out.history[1].token, '[REDACTED]');
  assert.equal(out.history[0].event, 'login');
});

test('redactPayloadDeep truncates beyond maxDepth', () => {
  // Each recursion increments depth by 1; the check `depth >= maxDepth`
  // fires on the *value* being recursed into, so with maxDepth=3 the
  // truncation lands on l3's value (which is l2's child, reached at
  // depth=3). The two outer levels traverse normally.
  const deep = { l1: { l2: { l3: { l4: 'too deep' } } } };
  const out = redactPayloadDeep(deep, { maxDepth: 3 });
  assert.equal(typeof out.l1, 'object');
  assert.equal(typeof out.l1.l2, 'object');
  assert.equal(out.l1.l2.l3, '[truncated]');
});

test('redactPayloadDeep guards against circular references', () => {
  const obj = { name: 'cyclic' };
  obj.self = obj;
  const out = redactPayloadDeep(obj);
  assert.equal(out.name, 'cyclic');
  assert.equal(out.self, '[circular]');
});

test('redactPayloadDeep passes through Date / Error / Buffer instances unchanged', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const err = new Error('boom');
  const buf = Buffer.from('binary');
  const input = { ts: now, error: err, payload: buf, password: 'secret' };
  const out = redactPayloadDeep(input);
  assert.equal(out.ts, now, 'Date instance preserved');
  assert.equal(out.error, err, 'Error instance preserved');
  assert.equal(out.payload, buf, 'Buffer instance preserved');
  assert.equal(out.password, '[REDACTED]');
});

test('redactPayloadDeep returns primitives unchanged', () => {
  assert.equal(redactPayloadDeep(null), null);
  assert.equal(redactPayloadDeep(undefined), undefined);
  assert.equal(redactPayloadDeep('hello'), 'hello');
  assert.equal(redactPayloadDeep(42), 42);
  assert.equal(redactPayloadDeep(true), true);
});

test('redactPayloadDeep caps arrays at maxArrayItems', () => {
  const long = Array.from({ length: 100 }, (_, i) => ({ idx: i, secret: 'leak' }));
  const out = redactPayloadDeep(long, { maxArrayItems: 5 });
  assert.equal(out.length, 5);
  for (const item of out) {
    assert.equal(item.secret, '[REDACTED]');
  }
});

test('redactPayloadDeep accepts a custom censor string', () => {
  const out = redactPayloadDeep({ token: 'abc', email: 'x@y.com' }, { censor: '***' });
  assert.equal(out.token, '***');
  assert.equal(out.email, 'x@y.com');
});

test('redactPayloadDeep produces stable JSON for safe logging', () => {
  const input = {
    requestId: 'req-1',
    headers: { authorization: 'Bearer xyz', 'x-api-key': 'leak', 'user-agent': 'mocha' },
    body: { username: 'alice', password: 'hunter2', tokens: ['t1', 't2'] },
  };
  const out = redactPayloadDeep(input);
  const serialised = JSON.stringify(out);
  assert.ok(!serialised.includes('hunter2'), 'password value must not appear in serialised output');
  assert.ok(!serialised.includes('Bearer xyz'), 'authorization value must not leak');
  assert.ok(!serialised.includes('leak'), 'x-api-key value must not leak');
  assert.match(serialised, /\[REDACTED\]/);
});

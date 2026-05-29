const test = require('node:test');
const assert = require('node:assert/strict');

const {
  attachRedisListeners,
  createThrottledLogger,
  isTransientRedisError,
  reconnectDelay,
} = require('../src/services/agents/redis-resilience');

const { EventEmitter } = require('node:events');

test('isTransientRedisError detects ioredis "Connection is closed"', () => {
  const err = new Error('Connection is closed.');
  assert.equal(isTransientRedisError(err), true);
});

test('isTransientRedisError detects connection-reset family', () => {
  for (const message of [
    'Connection lost',
    'read ECONNRESET',
    'write ECONNRESET',
    'getaddrinfo ENOTFOUND redis-host',
    'connect ETIMEDOUT 10.0.0.1:6379',
    'connect ECONNREFUSED 127.0.0.1:6379',
    'Stream isn\'t writeable and enableOfflineQueue options is false',
    'Reached the max retries per request limit (which is 1). Refer to "maxRetriesPerRequest" option for details.',
    'READONLY You can\'t write against a read only replica.',
  ]) {
    assert.equal(isTransientRedisError(new Error(message)), true, `expected match for: ${message}`);
  }
});

test('isTransientRedisError uses err.code when message is opaque', () => {
  const err = Object.assign(new Error('opaque'), { code: 'ECONNRESET' });
  assert.equal(isTransientRedisError(err), true);
});

test('isTransientRedisError returns false for application errors', () => {
  assert.equal(isTransientRedisError(new Error('User not found')), false);
  assert.equal(isTransientRedisError(new TypeError('cannot read property of undefined')), false);
  assert.equal(isTransientRedisError(null), false);
  assert.equal(isTransientRedisError(undefined), false);
});

test('reconnectDelay grows with attempts but caps at 30s', () => {
  const d1 = reconnectDelay(1);
  const d3 = reconnectDelay(3);
  const d20 = reconnectDelay(20);
  assert.ok(d1 >= 1500 && d1 <= 2500, `attempt 1 delay ${d1} out of bounds`);
  assert.ok(d3 > d1, 'delay should grow with attempts');
  assert.equal(d20, 30000, 'should cap at 30s');
});

test('createThrottledLogger emits at most once per window', () => {
  let calls = 0;
  const log = createThrottledLogger(50);
  log(() => calls++);
  log(() => calls++);
  log(() => calls++);
  assert.equal(calls, 1, 'only first call should fire within window');
});

test('attachRedisListeners is idempotent and routes transient errors to warn', () => {
  const conn = new EventEmitter();
  const captured = { warn: [], error: [] };
  const fakeLogger = {
    warn: (...args) => captured.warn.push(args.join(' ')),
    error: (...args) => captured.error.push(args.join(' ')),
  };
  attachRedisListeners(conn, { label: 'test', logger: fakeLogger });
  attachRedisListeners(conn, { label: 'test', logger: fakeLogger }); // 2nd call must no-op
  conn.emit('error', new Error('Connection is closed.'));
  conn.emit('error', new Error('Real bug: cannot read property of undefined'));
  conn.emit('reconnecting', 2000);

  assert.ok(captured.warn.some((m) => m.includes('transient connection error')), 'transient errors must warn');
  assert.ok(captured.error.some((m) => m.includes('Real bug')), 'real errors must surface to error');
});

test('attachRedisListeners handles missing connection gracefully', () => {
  // No throw, returns falsy.
  attachRedisListeners(null);
  attachRedisListeners(undefined);
});

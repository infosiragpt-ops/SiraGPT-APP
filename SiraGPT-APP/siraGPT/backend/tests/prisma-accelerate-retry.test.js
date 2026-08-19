'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withAccelerateRetry, isAccelerateTransientError } = require('../src/utils/prisma-accelerate-retry');

const silentLogger = { warn: () => {}, error: () => {} };

test('isAccelerateTransientError: matches P6008 by code', () => {
  assert.equal(isAccelerateTransientError({ code: 'P6008', message: 'x' }), true);
});

test('isAccelerateTransientError: matches by Accelerate text in message', () => {
  assert.equal(
    isAccelerateTransientError({ message: 'Accelerate was not able to connect to your database' }),
    true
  );
});

test('isAccelerateTransientError: matches "error requesting Query Engine from pool"', () => {
  assert.equal(
    isAccelerateTransientError({ message: 'error requesting Query Engine from pool' }),
    true
  );
});

test('isAccelerateTransientError: matches network drops', () => {
  assert.equal(isAccelerateTransientError({ message: 'ECONNRESET while reading' }), true);
});

test('isAccelerateTransientError: does not match real Prisma validation errors', () => {
  assert.equal(
    isAccelerateTransientError({ code: 'P2002', message: 'Unique constraint failed' }),
    false
  );
  assert.equal(isAccelerateTransientError(null), false);
  assert.equal(isAccelerateTransientError({}), false);
});

test('withAccelerateRetry: returns the value on first success', async () => {
  let calls = 0;
  const result = await withAccelerateRetry(async () => {
    calls += 1;
    return { id: 'u1' };
  }, { logger: silentLogger });
  assert.deepEqual(result, { id: 'u1' });
  assert.equal(calls, 1);
});

test('withAccelerateRetry: retries on transient errors and succeeds', async () => {
  let calls = 0;
  const result = await withAccelerateRetry(async () => {
    calls += 1;
    if (calls < 3) {
      const err = new Error('P6008 boom');
      err.code = 'P6008';
      throw err;
    }
    return 'ok';
  }, { maxAttempts: 3, baseDelayMs: 1, logger: silentLogger });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withAccelerateRetry: stops retrying after maxAttempts and tags error', async () => {
  let calls = 0;
  await assert.rejects(
    () => withAccelerateRetry(async () => {
      calls += 1;
      const err = new Error('P6008 still bad');
      err.code = 'P6008';
      throw err;
    }, { maxAttempts: 2, baseDelayMs: 1, logger: silentLogger }),
    (err) => {
      assert.equal(err.code, 'P6008');
      assert.equal(err.databaseUnavailable, true);
      return true;
    }
  );
  assert.equal(calls, 2);
});

test('withAccelerateRetry: does not retry non-transient errors', async () => {
  let calls = 0;
  await assert.rejects(
    () => withAccelerateRetry(async () => {
      calls += 1;
      const err = new Error('Unique constraint failed');
      err.code = 'P2002';
      throw err;
    }, { maxAttempts: 3, baseDelayMs: 1, logger: silentLogger }),
    /Unique constraint failed/
  );
  assert.equal(calls, 1);
});

test('withAccelerateRetry: does NOT set databaseUnavailable on non-transient errors', async () => {
  await assert.rejects(
    () => withAccelerateRetry(async () => {
      const err = new Error('validation error');
      err.code = 'P2002';
      throw err;
    }, { logger: silentLogger }),
    (err) => {
      assert.notEqual(err.databaseUnavailable, true);
      return true;
    }
  );
});

test('withAccelerateRetry: validates fn argument', async () => {
  await assert.rejects(
    () => withAccelerateRetry(null),
    /fn must be a function/
  );
});

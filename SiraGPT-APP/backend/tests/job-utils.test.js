'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { wrapWithRetry, isTransientError, computeDelay } = require('../src/jobs/job-utils');

describe('job-utils', () => {
  test('wrapWithRetry — runs once on success, no retries', async () => {
    let calls = 0;
    const wrapped = wrapWithRetry(async () => { calls += 1; return 'ok'; }, {
      sleep: () => Promise.resolve(),
    });
    const result = await wrapped();
    assert.equal(result, 'ok');
    assert.equal(calls, 1);
  });

  test('wrapWithRetry — retries up to maxAttempts on transient errors', async () => {
    let calls = 0;
    const wrapped = wrapWithRetry(async () => {
      calls += 1;
      const err = new Error('connection reset');
      err.code = 'ECONNRESET';
      throw err;
    }, {
      maxAttempts: 3,
      sleep: () => Promise.resolve(),
    });
    await assert.rejects(wrapped(), /ECONNRESET|connection reset/);
    assert.equal(calls, 3, 'should attempt exactly maxAttempts times');
  });

  test('wrapWithRetry — succeeds after a transient failure', async () => {
    let calls = 0;
    const wrapped = wrapWithRetry(async () => {
      calls += 1;
      if (calls < 2) {
        const err = new Error('db timeout');
        err.code = 'ETIMEDOUT';
        throw err;
      }
      return 'recovered';
    }, {
      sleep: () => Promise.resolve(),
    });
    const result = await wrapped();
    assert.equal(result, 'recovered');
    assert.equal(calls, 2);
  });

  test('wrapWithRetry — does NOT retry on non-transient errors', async () => {
    let calls = 0;
    const wrapped = wrapWithRetry(async () => {
      calls += 1;
      throw new TypeError('programmer error');
    }, {
      sleep: () => Promise.resolve(),
    });
    await assert.rejects(wrapped(), /programmer error/);
    assert.equal(calls, 1, 'non-transient errors must bubble immediately');
  });

  test('wrapWithRetry — invokes onRetry callback with attempt info', async () => {
    const retries = [];
    const wrapped = wrapWithRetry(async () => {
      const err = new Error('boom');
      err.code = 'ECONNREFUSED';
      throw err;
    }, {
      maxAttempts: 3,
      sleep: () => Promise.resolve(),
      onRetry: (info) => retries.push(info),
    });
    await assert.rejects(wrapped());
    assert.equal(retries.length, 2, 'two retries before final failure');
    assert.equal(retries[0].attempt, 1);
    assert.equal(retries[0].reason, 'ECONNREFUSED');
  });

  test('isTransientError — classifies common network/DB codes', () => {
    assert.equal(isTransientError(Object.assign(new Error('x'), { code: 'ECONNRESET' })), true);
    assert.equal(isTransientError(Object.assign(new Error('x'), { code: 'P1001' })), true);
    assert.equal(isTransientError(new Error('socket hang up')), true);
    assert.equal(isTransientError(new TypeError('bad arg')), false);
    assert.equal(isTransientError(null), false);
  });

  test('computeDelay — caps at maxDelayMs and respects base growth', () => {
    // With Math.random() between 0..1, the result is always <= cap.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const d = computeDelay(attempt, 100, 1000);
      assert.ok(d >= 0 && d <= 1000, `delay ${d} out of bounds for attempt ${attempt}`);
    }
  });

  test('wrapWithRetry — throws TypeError when fn is not a function', () => {
    assert.throws(() => wrapWithRetry(null), TypeError);
  });
});

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { asyncHandler } = require('../src/utils/async-handler');

describe('asyncHandler', () => {
  test('passes req, res, and next to the wrapped handler', async () => {
    const req = { id: 'req-1' };
    const res = { statusCode: 200 };
    const next = () => {};
    const seen = [];
    const wrapped = asyncHandler(async (...args) => {
      seen.push(args);
    });

    wrapped(req, res, next);
    await Promise.resolve();

    assert.deepEqual(seen, [[req, res, next]]);
  });

  test('forwards rejected async handlers to next', async () => {
    const failure = new Error('boom');
    const calls = [];
    const wrapped = asyncHandler(async () => {
      throw failure;
    });

    wrapped({}, {}, (err) => {
      calls.push(err);
    });
    await Promise.resolve();

    assert.deepEqual(calls, [failure]);
  });

  test('lets synchronous throws surface before promise rejection handling', async () => {
    const failure = new Error('sync boom');
    const calls = [];
    const wrapped = asyncHandler(() => {
      throw failure;
    });

    assert.throws(() => wrapped({}, {}, (err) => calls.push(err)), /sync boom/);
    await Promise.resolve();
    assert.deepEqual(calls, []);
  });
});

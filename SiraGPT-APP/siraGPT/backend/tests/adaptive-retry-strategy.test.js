'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { executeAdaptive } = require('../src/services/sira/adaptive-retry-strategy');

// Use a fake sleep that resolves immediately to keep tests fast
const fastSleep = () => Promise.resolve();

test('executeAdaptive: returns success on first attempt', async () => {
  const invoke = async () => 'ok';
  const out = await executeAdaptive(invoke, { sleep: fastSleep });
  assert.equal(out.success, true);
  assert.equal(out.result, 'ok');
  assert.equal(out.attempts, 1);
});

test('executeAdaptive: retries on transient errors and eventually succeeds', async () => {
  let calls = 0;
  const invoke = async () => {
    calls++;
    if (calls < 3) {
      const err = new Error('timed out');
      throw err;
    }
    return 'finally';
  };
  const out = await executeAdaptive(invoke, { sleep: fastSleep, maxAttempts: 5 });
  assert.equal(out.success, true);
  assert.equal(out.result, 'finally');
  assert.equal(out.attempts, 3);
});

test('executeAdaptive: respects maxAttempts cap', async () => {
  const invoke = async () => { throw new Error('rate limit exceeded'); };
  const out = await executeAdaptive(invoke, { sleep: fastSleep, maxAttempts: 2 });
  assert.equal(out.success, false);
  assert.equal(out.attempts, 2);
});

test('executeAdaptive: 401 auth → ask_user_for_input strategy', async () => {
  const invoke = async () => { const e = new Error('Unauthorized'); e.status = 401; throw e; };
  const out = await executeAdaptive(invoke, { sleep: fastSleep });
  assert.equal(out.success, false);
  assert.equal(out.finalReason, 'ask_user_for_input');
  assert.equal(out.errorClassification.category, 'permission_denied');
});

test('executeAdaptive: 401 with askUserCaller pauses for user input', async () => {
  const invoke = async () => { const e = new Error('Unauthorized'); e.status = 401; throw e; };
  const ask = async () => ({ reauthed: true });
  const out = await executeAdaptive(invoke, { sleep: fastSleep, askUserCaller: ask });
  assert.equal(out.success, false);
  assert.equal(out.finalReason, 'paused_for_user');
  assert.deepEqual(out.userPayload, { reauthed: true });
});

test('executeAdaptive: falls back to fallback_model when offered', async () => {
  const invoke = async () => { const e = new Error('rate limit exceeded'); e.status = 429; throw e; };
  const fallback = async () => 'via_fallback';
  // attempts=2 + hasFallbackModel triggers retry_with_fallback_model after first miss
  const out = await executeAdaptive(invoke, {
    sleep: fastSleep,
    maxAttempts: 3,
    fallbackModelCaller: fallback,
  });
  assert.equal(out.success, true);
  assert.equal(out.result, 'via_fallback');
  assert.ok(out.history.some(h => h.via === 'fallback_model'));
});

test('executeAdaptive: falls back to fallback_tool on validation errors', async () => {
  const invoke = async () => { const e = new Error('invalid payload'); e.status = 422; throw e; };
  const fallbackTool = async () => 'tool_b_result';
  const out = await executeAdaptive(invoke, {
    sleep: fastSleep,
    fallbackToolCaller: fallbackTool,
  });
  assert.equal(out.success, true);
  assert.equal(out.result, 'tool_b_result');
});

test('executeAdaptive: 5xx with Retry-After header uses the suggested delay', async () => {
  const seen = [];
  const invoke = async () => {
    const e = new Error('upstream broke');
    e.status = 503;
    e.headers = { 'retry-after': '1' };
    throw e;
  };
  const sleep = (ms) => { seen.push(ms); return Promise.resolve(); };
  await executeAdaptive(invoke, { sleep, maxAttempts: 3 });
  assert.ok(seen[0] >= 1000 && seen[0] <= 2000, `expected ~1000ms, got ${seen[0]}`);
});

test('executeAdaptive: emits per-attempt callback', async () => {
  const invoke = async () => { throw new Error('rate limit'); };
  const attempts = [];
  await executeAdaptive(invoke, {
    sleep: fastSleep,
    maxAttempts: 3,
    onAttempt: (info) => attempts.push(info.attempt),
  });
  assert.deepEqual(attempts, [1, 2, 3]);
});

test('executeAdaptive: rejects non-function invoke', async () => {
  await assert.rejects(() => executeAdaptive('not a function'), TypeError);
});

test('executeAdaptive: classifies network error and retries', async () => {
  let calls = 0;
  const invoke = async () => {
    calls++;
    if (calls < 2) {
      const e = new Error('socket hang up');
      e.code = 'ECONNRESET';
      throw e;
    }
    return 'recovered';
  };
  const out = await executeAdaptive(invoke, { sleep: fastSleep });
  assert.equal(out.success, true);
  assert.equal(out.result, 'recovered');
});

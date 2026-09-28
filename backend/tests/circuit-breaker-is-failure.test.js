'use strict';

/**
 * circuit-breaker execute(fn, { isFailure }): an error the predicate calls
 * «not a failure» (false) proves the provider answered — it never trips the
 * breaker and a HALF_OPEN probe that ends with it closes the breaker; a
 * neutral one ('ignore', the user's Stop) changes nothing and releases the
 * probe slot. The real predicate ai-service passes is exercised end to end in
 * ai-service-provider-failure.test.js (pinned 402/401/429 turns leave the
 * breaker CLOSED).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { CircuitBreaker, CircuitBreakerError, STATES } = require('../src/services/circuit-breaker');

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Test predicate: 4xx answered (false), aborts neutral, the rest counts.
const isFailure = (e) => {
  if (e && e.name === 'AbortError') return 'ignore';
  const status = Number(e && e.status) || 0;
  return !(status >= 400 && status < 500);
};

const quiet = { onStateChange: () => {} };
const abortError = () => Object.assign(new Error('stop'), { name: 'AbortError' });

test('errors the predicate calls answered never open the breaker; provider faults still count', async () => {
  const b = new CircuitBreaker('is-failure-4xx', { failureThreshold: 2, ...quiet });
  for (const status of [400, 401, 402, 403, 404, 429]) {
    await assert.rejects(() => b.execute(async () => { throw httpError(status, `e${status}`); }, { isFailure }), new RegExp(`e${status}`));
  }
  assert.equal(b.state, STATES.CLOSED);
  assert.equal(b.failureCount, 0);

  await assert.rejects(() => b.execute(async () => { throw httpError(503, 'down'); }, { isFailure }));
  await assert.rejects(() => b.execute(async () => { throw httpError(500, 'down'); }, { isFailure }));
  assert.equal(b.state, STATES.OPEN, '5xx are provider faults');
  await assert.rejects(() => b.execute(async () => 'never', { isFailure }), CircuitBreakerError);
});

test('a HALF_OPEN probe that throws an answered error closes the breaker instead of wedging it', async () => {
  const b = new CircuitBreaker('is-failure-half-open', { failureThreshold: 1, resetTimeoutMs: 20, ...quiet });
  await assert.rejects(() => b.execute(async () => { throw httpError(500, 'boom'); }, { isFailure }));
  assert.equal(b.state, STATES.OPEN);
  await new Promise((r) => setTimeout(r, 30));

  // The probe reaches the provider, which answers 402: it is alive.
  await assert.rejects(() => b.execute(async () => { throw httpError(402, 'Insufficient Balance'); }, { isFailure }), /Insufficient Balance/);
  assert.equal(b.state, STATES.CLOSED);
  assert.equal(await b.execute(async () => 'ok', { isFailure }), 'ok', 'next call passes, the probe budget was not left consumed');
});

test("'ignore' (a user Stop): no state change, no failure drain, the HALF_OPEN probe slot is released", async () => {
  // CLOSED: a Stop neither counts nor drains earlier failures.
  const b = new CircuitBreaker('is-failure-neutral', { failureThreshold: 3, resetTimeoutMs: 20, ...quiet });
  await assert.rejects(() => b.execute(async () => { throw httpError(500, 'boom'); }, { isFailure }));
  await assert.rejects(() => b.execute(async () => { throw httpError(500, 'boom'); }, { isFailure }));
  assert.equal(b.failureCount, 2);
  for (let i = 0; i < 4; i++) await assert.rejects(() => b.execute(async () => { throw abortError(); }, { isFailure }));
  assert.equal(b.failureCount, 2, 'Stops neither add failures nor drain them');
  assert.equal(b.state, STATES.CLOSED);

  // HALF_OPEN: a cancelled probe proves nothing — the breaker stays
  // HALF_OPEN and the next call can probe.
  await assert.rejects(() => b.execute(async () => { throw httpError(500, 'boom'); }, { isFailure }));
  assert.equal(b.state, STATES.OPEN);
  await new Promise((r) => setTimeout(r, 30));
  await assert.rejects(() => b.execute(async () => { throw abortError(); }, { isFailure }), /stop/);
  assert.equal(b.state, STATES.HALF_OPEN, 'a cancelled probe does not close the breaker');
  assert.equal(b.halfOpenCallCount, 0, 'the probe slot is released');
  assert.equal(await b.execute(async () => 'ok', { isFailure }), 'ok');
  assert.equal(b.state, STATES.CLOSED);
});

test('without the option behaviour is identical: every error counts', async () => {
  const b = new CircuitBreaker('is-failure-default', { failureThreshold: 2, ...quiet });
  await assert.rejects(() => b.execute(async () => { throw httpError(402, 'no credit'); }));
  assert.equal(b.failureCount, 1);
  await assert.rejects(() => b.execute(async () => { throw httpError(400, 'bad'); }));
  assert.equal(b.state, STATES.OPEN);

  // A predicate that throws is ignored (the error counts).
  const c = new CircuitBreaker('is-failure-throwing', { failureThreshold: 1, ...quiet });
  await assert.rejects(() => c.execute(async () => { throw httpError(400, 'bad'); }, { isFailure: () => { throw new Error('predicate bug'); } }), /bad/);
  assert.equal(c.state, STATES.OPEN);

  // Success path untouched.
  const d = new CircuitBreaker('is-failure-success', { failureThreshold: 1, ...quiet });
  assert.equal(await d.execute(async () => 42, { isFailure }), 42);
  assert.equal(d.state, STATES.CLOSED);
});

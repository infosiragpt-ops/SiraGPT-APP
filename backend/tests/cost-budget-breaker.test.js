'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createCostBudgetBreaker,
  STATE_CLOSED,
  STATE_OPEN,
  STATE_HALF_OPEN,
} = require('../src/services/ai-product-os/cost-budget-breaker');

function mk(overrides = {}) {
  let t = 0;
  const cb = createCostBudgetBreaker({
    tenantId: 't1',
    windowMs: 60 * 60_000,
    budgetUsd: 10,
    halfOpenAfterMs: 60_000,
    now: () => t,
    ...overrides,
  });
  return { cb, advance: (ms) => { t += ms; }, getT: () => t, setT: (v) => { t = v; } };
}

describe('createCostBudgetBreaker — construction', () => {
  test('rejects missing tenantId', () => {
    assert.throws(() => createCostBudgetBreaker({}), TypeError);
  });
  test('rejects bad windowMs / budgetUsd', () => {
    assert.throws(() => createCostBudgetBreaker({ tenantId: 'x', budgetUsd: 1 }), TypeError);
    assert.throws(() => createCostBudgetBreaker({ tenantId: 'x', windowMs: 0, budgetUsd: 1 }), TypeError);
    assert.throws(() => createCostBudgetBreaker({ tenantId: 'x', windowMs: 1, budgetUsd: 0 }), TypeError);
  });
});

describe('cost-budget-breaker — CLOSED behavior', () => {
  test('initial state is CLOSED with full remaining', () => {
    const { cb } = mk();
    const r = cb.allow();
    assert.equal(r.state, STATE_CLOSED);
    assert.equal(r.ok, true);
    assert.equal(r.remaining, 10);
  });

  test('record accumulates spend; remaining decreases', () => {
    const { cb } = mk();
    cb.record({ usd: 3, tokens: 100 });
    cb.record({ usd: 2, tokens: 50 });
    const s = cb.snapshot();
    assert.equal(s.spent.usd, 5);
    assert.equal(s.spent.tokens, 150);
    assert.equal(s.remaining, 5);
  });
});

describe('cost-budget-breaker — OPEN trigger', () => {
  test('crossing budget snaps state → OPEN', () => {
    const { cb } = mk();
    cb.record({ usd: 9 });
    assert.equal(cb.snapshot().state, STATE_CLOSED);
    cb.record({ usd: 2 });
    const s = cb.snapshot();
    assert.equal(s.state, STATE_OPEN);
    assert.equal(s.remaining, 0);
  });

  test('allow() returns ok:false while OPEN', () => {
    const { cb } = mk();
    cb.record({ usd: 11 });
    const r = cb.allow();
    assert.equal(r.ok, false);
    assert.equal(r.state, STATE_OPEN);
  });
});

describe('cost-budget-breaker — HALF_OPEN recovery', () => {
  test('after halfOpenAfterMs elapses, allow() probes once', () => {
    const { cb, advance } = mk({ halfOpenAfterMs: 1000 });
    cb.record({ usd: 11 });
    const r0 = cb.allow();
    assert.equal(r0.ok, false);
    advance(1500);
    const r1 = cb.allow();
    assert.equal(r1.ok, true);
    assert.equal(r1.state, STATE_HALF_OPEN);
    const r2 = cb.allow(); // second probe denied (allowance=1)
    assert.equal(r2.ok, false);
  });

  test('a probe that records under budget returns to CLOSED', () => {
    // Use a short window so the old over-budget spend ages out before
    // the probe, leaving room for the probe's cost to stay under budget.
    const { cb, advance } = mk({ halfOpenAfterMs: 100, windowMs: 1000 });
    cb.record({ usd: 11 });
    advance(2000); // past windowMs → old bucket aged out
    cb.allow();    // HALF_OPEN
    cb.record({ usd: 0 }); // probe spent nothing, window empty → recover
    assert.equal(cb.snapshot().state, STATE_CLOSED);
  });

  test('a probe that pushes over budget snaps back to OPEN', () => {
    const { cb, advance } = mk({ halfOpenAfterMs: 100, budgetUsd: 5, windowMs: 60_000 });
    cb.record({ usd: 6 });
    advance(200);
    cb.allow(); // HALF_OPEN
    cb.record({ usd: 1 }); // still over budget (6+1 > 5)
    assert.equal(cb.snapshot().state, STATE_OPEN);
  });
});

describe('cost-budget-breaker — sliding window GC', () => {
  test('expired buckets stop counting toward spend', () => {
    const { cb, advance } = mk({ windowMs: 60_000 });
    cb.record({ usd: 7 });
    advance(70_000); // beyond window
    const s = cb.snapshot();
    assert.equal(s.spent.usd, 0);
    assert.equal(s.remaining, 10);
  });

  test('buckets within the window are kept', () => {
    const { cb, advance } = mk({ windowMs: 60_000 });
    cb.record({ usd: 4 });
    advance(30_000);
    cb.record({ usd: 4 });
    const s = cb.snapshot();
    assert.equal(s.spent.usd, 8);
  });
});

describe('cost-budget-breaker — record sanitation', () => {
  test('negative / NaN values floor to 0', () => {
    const { cb } = mk();
    cb.record({ usd: -5 });
    cb.record({ usd: NaN });
    cb.record({ usd: 'oops' });
    assert.equal(cb.snapshot().spent.usd, 0);
  });

  test('record without usd defaults to 0 (count++)', () => {
    const { cb } = mk();
    cb.record({});
    cb.record({});
    assert.equal(cb.snapshot().spent.count, 2);
    assert.equal(cb.snapshot().spent.usd, 0);
  });
});

describe('cost-budget-breaker — reset', () => {
  test('reset() wipes counters and returns to CLOSED', () => {
    const { cb } = mk();
    cb.record({ usd: 11 });
    assert.equal(cb.snapshot().state, STATE_OPEN);
    cb.reset();
    const s = cb.snapshot();
    assert.equal(s.state, STATE_CLOSED);
    assert.equal(s.spent.usd, 0);
    assert.equal(s.remaining, 10);
  });
});

describe('cost-budget-breaker — snapshot shape', () => {
  test('exposes tenantId/budgetUsd/windowMs/buckets fields', () => {
    const { cb } = mk();
    cb.record({ usd: 1 });
    const s = cb.snapshot();
    assert.equal(s.tenantId, 't1');
    assert.equal(s.budgetUsd, 10);
    assert.equal(s.windowMs, 60 * 60_000);
    assert.ok(s.buckets >= 1);
  });
});

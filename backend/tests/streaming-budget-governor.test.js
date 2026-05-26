'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createStreamingBudgetGovernor,
  defaultEstimateTokens,
  DEFAULT_SOFT_STOP_RATIO,
} = require('../src/services/ai-product-os/streaming-budget-governor');

describe('defaultEstimateTokens', () => {
  test('strings: ceil(chars/4)', () => {
    assert.equal(defaultEstimateTokens(''), 0);
    assert.equal(defaultEstimateTokens('abcd'), 1);
    assert.equal(defaultEstimateTokens('a'.repeat(10)), 3);
  });
  test('numbers passthrough', () => {
    assert.equal(defaultEstimateTokens(7), 7);
    assert.equal(defaultEstimateTokens(0), 0);
  });
  test('chunk objects: text/content/tokens fields', () => {
    assert.equal(defaultEstimateTokens({ text: 'abcd' }), 1);
    assert.equal(defaultEstimateTokens({ content: 'abcdefgh' }), 2);
    assert.equal(defaultEstimateTokens({ tokens: 12 }), 12);
  });
  test('arrays sum recursively', () => {
    assert.equal(defaultEstimateTokens(['abcd', 'abcd']), 2);
  });
  test('null/undefined → 0', () => {
    assert.equal(defaultEstimateTokens(null), 0);
    assert.equal(defaultEstimateTokens(undefined), 0);
  });
});

describe('createStreamingBudgetGovernor — construction', () => {
  test('rejects missing/zero/negative maxOutputTokens', () => {
    assert.throws(() => createStreamingBudgetGovernor({}), TypeError);
    assert.throws(() => createStreamingBudgetGovernor({ maxOutputTokens: 0 }), TypeError);
    assert.throws(() => createStreamingBudgetGovernor({ maxOutputTokens: -1 }), TypeError);
  });

  test('default soft stop ratio is 0.95', () => {
    const g = createStreamingBudgetGovernor({ maxOutputTokens: 100 });
    assert.equal(g.snapshot().softCap, 95);
    assert.equal(DEFAULT_SOFT_STOP_RATIO, 0.95);
  });
});

describe('createStreamingBudgetGovernor — observe verdicts', () => {
  test('returns continue while well under cap', () => {
    const g = createStreamingBudgetGovernor({ maxOutputTokens: 100 });
    assert.equal(g.observe(10), 'continue');
    assert.equal(g.observe(20), 'continue');
    assert.equal(g.spent(), 30);
    assert.equal(g.remaining(), 70);
  });

  test('returns soft once spent >= softCap', () => {
    const g = createStreamingBudgetGovernor({ maxOutputTokens: 100, softStopRatio: 0.5 });
    assert.equal(g.observe(40), 'continue');
    assert.equal(g.observe(15), 'soft');
    assert.equal(g.observe(5), 'soft');
  });

  test('fires onSoftStop only once', () => {
    let fired = 0;
    const g = createStreamingBudgetGovernor({
      maxOutputTokens: 100,
      softStopRatio: 0.5,
      onSoftStop: () => { fired += 1; },
    });
    g.observe(60);
    g.observe(5);
    g.observe(5);
    assert.equal(fired, 1);
  });

  test('returns hard when spent >= max and stays hard', () => {
    const g = createStreamingBudgetGovernor({ maxOutputTokens: 100 });
    g.observe(50);
    assert.equal(g.observe(60), 'hard');
    assert.equal(g.shouldStop(), true);
    assert.equal(g.observe(1), 'hard');
  });

  test('fires onHardStop exactly once', () => {
    let fired = 0;
    const g = createStreamingBudgetGovernor({
      maxOutputTokens: 100,
      onHardStop: () => { fired += 1; },
    });
    g.observe(150);
    g.observe(10);
    assert.equal(fired, 1);
  });

  test('aborts the wired AbortController on hard stop', () => {
    const ctrl = new AbortController();
    const g = createStreamingBudgetGovernor({ maxOutputTokens: 10, abortController: ctrl });
    assert.equal(ctrl.signal.aborted, false);
    g.observe(20);
    assert.equal(ctrl.signal.aborted, true);
  });

  test('does not double-abort if already aborted', () => {
    const ctrl = new AbortController();
    ctrl.abort('elsewhere');
    const g = createStreamingBudgetGovernor({ maxOutputTokens: 10, abortController: ctrl });
    g.observe(20); // must not throw
  });

  test('handles negative / NaN deltas as zero', () => {
    const g = createStreamingBudgetGovernor({ maxOutputTokens: 100 });
    g.observe(-5);
    g.observe(NaN);
    assert.equal(g.spent(), 0);
  });

  test('throwing estimator falls back to delta=0 (no crash)', () => {
    const g = createStreamingBudgetGovernor({
      maxOutputTokens: 100,
      estimateTokens: () => { throw new Error('bad'); },
    });
    assert.equal(g.observe('anything'), 'continue');
    assert.equal(g.spent(), 0);
  });

  test('throwing onSoftStop / onHardStop is swallowed', () => {
    const g = createStreamingBudgetGovernor({
      maxOutputTokens: 100,
      softStopRatio: 0.5,
      onSoftStop: () => { throw new Error('s'); },
      onHardStop: () => { throw new Error('h'); },
    });
    g.observe(60);  // soft
    g.observe(60);  // hard
    assert.equal(g.shouldStop(), true);
  });

  test('snapshot reflects state and chunk count', () => {
    const g = createStreamingBudgetGovernor({ maxOutputTokens: 100, softStopRatio: 0.5 });
    g.observe('a'.repeat(40));   // 10 tokens
    g.observe('b'.repeat(160));  // 40 tokens → spent 50 → soft
    const s = g.snapshot();
    assert.equal(s.chunks, 2);
    assert.equal(s.state, 'soft');
    assert.equal(s.max, 100);
    assert.equal(s.softCap, 50);
    assert.equal(s.spent, 50);
  });
});

'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createPromptCacheMetrics,
} = require('../src/services/observability/prompt-cache-metrics');

function mk(overrides = {}) {
  let t = 0;
  const m = createPromptCacheMetrics({
    windowMs: 10 * 60_000,
    pricing: {
      'claude-opus-4-7': { uncachedPerMTok: 15, cachedPerMTok: 1.5 }, // 90% off
    },
    now: () => t,
    ...overrides,
  });
  return { m, advance: (ms) => { t += ms; }, setT: (v) => { t = v; } };
}

describe('createPromptCacheMetrics — report + snapshot', () => {
  test('report accumulates totals', () => {
    const { m } = mk();
    m.report({ model: 'claude-opus-4-7', tenantId: 'a', hits: 5, misses: 1, cacheRead: 2000, cacheCreation: 500, promptTokens: 3000, completionTokens: 800 });
    m.report({ model: 'claude-opus-4-7', tenantId: 'a', hits: 3, misses: 2 });
    const s = m.snapshot({ model: 'claude-opus-4-7', tenantId: 'a' });
    assert.equal(s.hits, 8);
    assert.equal(s.misses, 3);
    assert.equal(s.cacheRead, 2000);
    assert.equal(s.cacheCreation, 500);
    assert.equal(s.calls, 2);
  });

  test('hit rate is hits / (hits + misses)', () => {
    const { m } = mk();
    m.report({ model: 'x', hits: 7, misses: 3 });
    assert.equal(m.hitRate({ model: 'x' }), 0.7);
  });

  test('hit rate is 0 when no observations', () => {
    const { m } = mk();
    assert.equal(m.hitRate({ model: 'never' }), 0);
  });

  test('reports without model are ignored', () => {
    const { m } = mk();
    m.report({ hits: 1, misses: 1 });
    assert.equal(m.snapshot().calls, 0);
  });

  test('negative / NaN values floor to 0', () => {
    const { m } = mk();
    m.report({ model: 'x', hits: -5, misses: NaN, cacheRead: 'oops' });
    const s = m.snapshot({ model: 'x' });
    assert.equal(s.hits, 0);
    assert.equal(s.misses, 0);
    assert.equal(s.cacheRead, 0);
  });
});

describe('createPromptCacheMetrics — sliding window', () => {
  test('expired buckets stop counting', () => {
    const { m, advance } = mk({ windowMs: 60_000 });
    m.report({ model: 'x', hits: 10 });
    advance(120_000);
    m.report({ model: 'x', hits: 1 });
    const s = m.snapshot({ model: 'x' });
    assert.equal(s.hits, 1);
  });

  test('buckets within the window aggregate', () => {
    const { m, advance } = mk({ windowMs: 60_000 });
    m.report({ model: 'x', hits: 4 });
    advance(30_000);
    m.report({ model: 'x', hits: 5 });
    const s = m.snapshot({ model: 'x' });
    assert.equal(s.hits, 9);
  });
});

describe('createPromptCacheMetrics — filtering', () => {
  test('filter by model isolates totals', () => {
    const { m } = mk();
    m.report({ model: 'a', tenantId: 't', hits: 1 });
    m.report({ model: 'b', tenantId: 't', hits: 10 });
    assert.equal(m.snapshot({ model: 'a' }).hits, 1);
    assert.equal(m.snapshot({ model: 'b' }).hits, 10);
  });

  test('filter by tenantId isolates totals', () => {
    const { m } = mk();
    m.report({ model: 'a', tenantId: 't1', hits: 4 });
    m.report({ model: 'a', tenantId: 't2', hits: 5 });
    assert.equal(m.snapshot({ tenantId: 't1' }).hits, 4);
    assert.equal(m.snapshot({ tenantId: 't2' }).hits, 5);
  });

  test('no filter aggregates everything', () => {
    const { m } = mk();
    m.report({ model: 'a', hits: 2 });
    m.report({ model: 'b', hits: 3 });
    assert.equal(m.snapshot().hits, 5);
  });
});

describe('createPromptCacheMetrics — savings estimate', () => {
  test('savings = cacheRead * (uncached - cached) per million', () => {
    const { m } = mk();
    m.report({ model: 'claude-opus-4-7', cacheRead: 1_000_000 });
    const s = m.snapshot({ model: 'claude-opus-4-7' });
    // 1M tokens * (15 - 1.5) = 13.5
    assert.equal(s.estimatedSavingsUsd, 13.5);
  });

  test('returns 0 when no pricing entry exists for the model', () => {
    const { m } = mk();
    m.report({ model: 'unknown-model', cacheRead: 1_000_000 });
    assert.equal(m.snapshot({ model: 'unknown-model' }).estimatedSavingsUsd, 0);
  });

  test('savings without filter returns 0 (no model hint = no price)', () => {
    const { m } = mk();
    m.report({ model: 'claude-opus-4-7', cacheRead: 1_000_000 });
    assert.equal(m.snapshot().estimatedSavingsUsd, 0);
  });
});

describe('createPromptCacheMetrics — reset', () => {
  test('reset() empties everything', () => {
    const { m } = mk();
    m.report({ model: 'a', hits: 5 });
    m.reset();
    assert.equal(m.snapshot().calls, 0);
    assert.equal(m.snapshot().hits, 0);
  });
});

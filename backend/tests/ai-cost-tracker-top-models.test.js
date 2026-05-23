'use strict';

/**
 * Cycle 45 — cost-tracker.topModels() per-model leaderboard tests.
 */

const { test, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');

const ct = require('../src/services/ai/cost-tracker');

describe('cost-tracker · topModels (cycle 45)', () => {
  beforeEach(() => ct._reset());

  test('aggregates per (model, provider) and sorts by requests desc', () => {
    ct.track({ userId: 'u1', model: 'gpt-4o-mini', provider: 'OpenAI', inputTokens: 100, outputTokens: 50, latencyMs: 200 });
    ct.track({ userId: 'u2', model: 'gpt-4o-mini', provider: 'OpenAI', inputTokens: 200, outputTokens: 80, latencyMs: 400 });
    ct.track({ userId: 'u1', model: 'claude-haiku', provider: 'Anthropic', inputTokens: 50, outputTokens: 20, latencyMs: 100 });

    const rows = ct.topModels({ limit: 10 });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].model, 'gpt-4o-mini');
    assert.equal(rows[0].requests, 2);
    assert.equal(rows[0].totalTokens, 100 + 50 + 200 + 80);
    assert.equal(rows[0].avgLatencyMs, 300);
    assert.equal(rows[0].errorRate, 0);
    assert.equal(rows[1].model, 'claude-haiku');
    assert.equal(rows[1].requests, 1);
  });

  test('separates rows for same model under different providers', () => {
    ct.track({ model: 'mistral-7b', provider: 'OpenAI', inputTokens: 10, outputTokens: 10 });
    ct.track({ model: 'mistral-7b', provider: 'DeepSeek', inputTokens: 10, outputTokens: 10 });
    const rows = ct.topModels({ limit: 10 });
    assert.equal(rows.length, 2);
  });

  test('errorRate reflects error=true records', () => {
    ct.track({ model: 'gpt-4o-mini', provider: 'OpenAI', inputTokens: 10, outputTokens: 10 });
    ct.track({ model: 'gpt-4o-mini', provider: 'OpenAI', inputTokens: 10, outputTokens: 10, error: true });
    ct.track({ model: 'gpt-4o-mini', provider: 'OpenAI', inputTokens: 10, outputTokens: 10, error: true });
    ct.track({ model: 'gpt-4o-mini', provider: 'OpenAI', inputTokens: 10, outputTokens: 10 });
    const rows = ct.topModels({ limit: 10 });
    assert.equal(rows[0].requests, 4);
    assert.equal(rows[0].errorRate, 0.5);
  });

  test('respects from/to date filtering', () => {
    const t0 = Date.now() - 10_000;
    const t1 = Date.now();
    ct.track({ model: 'a', provider: 'p', ts: new Date(t0 - 60_000), inputTokens: 10, outputTokens: 10 });
    ct.track({ model: 'b', provider: 'p', ts: new Date(t1), inputTokens: 10, outputTokens: 10 });
    const rows = ct.topModels({ from: new Date(t0), to: new Date(t1 + 1000) });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model, 'b');
  });

  test('respects limit and returns rows ordered by requests desc', () => {
    for (let i = 0; i < 3; i++) ct.track({ model: 'a', provider: 'p', inputTokens: 1, outputTokens: 1 });
    for (let i = 0; i < 5; i++) ct.track({ model: 'b', provider: 'p', inputTokens: 1, outputTokens: 1 });
    for (let i = 0; i < 1; i++) ct.track({ model: 'c', provider: 'p', inputTokens: 1, outputTokens: 1 });
    const rows = ct.topModels({ limit: 2 });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.model), ['b', 'a']);
  });

  test('returns empty array when no records', () => {
    const rows = ct.topModels({ limit: 10 });
    assert.deepEqual(rows, []);
  });

  test('caps limit at 1000 and floors at 1', () => {
    ct.track({ model: 'a', provider: 'p', inputTokens: 1, outputTokens: 1 });
    assert.equal(ct.topModels({ limit: 0 }).length, 1);
    assert.equal(ct.topModels({ limit: 999_999 }).length, 1);
  });
});

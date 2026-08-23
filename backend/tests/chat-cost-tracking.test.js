'use strict';

/**
 * Unit tests for services/ai/turn-cost.js — the per-turn chat cost
 * funnel wired into routes/ai.js saveChatAndTrackUsage.
 *
 * Contract under test:
 *   1. Real per-model pricing (Opus ≠ flash) — no flat-rate estimate.
 *   2. Provider is propagated into the tracker record (Cerebras → $0).
 *   3. Unknown model degrades to the fallback estimate, never null cost
 *      when tokens are present.
 *   4. Fire-and-forget: a broken cost-tracker must not throw out of
 *      trackTurnCost (the save path depends on it).
 *   5. No userId or no model → clean no-op (null), nothing tracked.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const costTracker = require('../src/services/ai/cost-tracker');
const { trackTurnCost } = require('../src/services/ai/turn-cost');

beforeEach(() => costTracker._reset());

test('uses real per-model pricing: Opus output ≠ deepseek-flash output', () => {
  const opus = trackTurnCost({
    userId: 'u1', model: 'claude-opus-4.7', provider: 'Anthropic',
    inputTokens: 0, outputTokens: 1_000_000,
  });
  const flash = trackTurnCost({
    userId: 'u1', model: 'deepseek-v4-flash', provider: 'DeepSeek',
    inputTokens: 0, outputTokens: 1_000_000,
  });
  // $75/M vs $0.28/M output — the legacy flat rate ($1/M blended) was
  // wrong by ~75x in one direction and ~3.5x in the other.
  assert.equal(opus.cost_usd, 75);
  assert.equal(flash.cost_usd, 0.28);
});

test('tracks into the cost-tracker with model + provider + canonical cost', () => {
  trackTurnCost({
    userId: 'u1', model: 'gpt-4o-mini', provider: 'OpenAI',
    inputTokens: 2_000_000, outputTokens: 1_000_000,
  });
  const rec = costTracker.report({ userId: 'u1' });
  assert.equal(rec.totals.records, 1);
  // 2M input @ $0.15/M + 1M output @ $0.60/M = $0.90.
  assert.equal(rec.totals.costUSD, 0.9);
  assert.equal(rec.perModel[0].model, 'gpt-4o-mini');
});

test('Cerebras free-tier turns cost zero and still count as requests', () => {
  const info = trackTurnCost({
    userId: 'u1', model: 'gpt-oss-120b', provider: 'Cerebras',
    inputTokens: 10_000, outputTokens: 5_000,
  });
  assert.equal(info.cost_usd, 0);
  const rec = costTracker.report({ userId: 'u1' });
  assert.equal(rec.totals.records, 1);
  assert.equal(rec.totals.costUSD, 0);
});

test('unknown model falls back to per-million estimate instead of failing', () => {
  const info = trackTurnCost({
    userId: 'u1', model: 'brand-new-model-9000', provider: null,
    inputTokens: 1_000_000, outputTokens: 0,
  });
  assert.equal(info.source, 'fallback');
  assert.ok(info.cost_usd > 0);
  assert.equal(costTracker.report({ userId: 'u1' }).totals.records, 1);
});

test('fire-and-forget: broken tracker does not throw and still returns cost', () => {
  const original = costTracker.track;
  costTracker.track = () => { throw new Error('tracker exploded'); };
  try {
    let info = null;
    assert.doesNotThrow(() => {
      info = trackTurnCost({
        userId: 'u1', model: 'claude-haiku-4', provider: 'Anthropic',
        inputTokens: 1000, outputTokens: 500,
      });
    });
    assert.ok(info && info.cost_usd >= 0);
  } finally {
    costTracker.track = original;
  }
});

test('no-op without userId or model', () => {
  assert.equal(trackTurnCost({ userId: null, model: 'gpt-4o', inputTokens: 10, outputTokens: 10 }), null);
  assert.equal(trackTurnCost({ userId: 'u1', model: null, inputTokens: 10, outputTokens: 10 }), null);
  assert.equal(trackTurnCost(), null);
  assert.equal(trackTurnCost({ userId: 'u1', model: undefined }), null);
  assert.equal(costTracker.report({}).totals.records, 0);
});

test('negative / non-numeric token counts are clamped, never negative cost', () => {
  const info = trackTurnCost({
    userId: 'u1', model: 'gpt-4o-mini', provider: 'OpenAI',
    inputTokens: -50, outputTokens: 'abc',
  });
  assert.equal(info.cost_usd, 0);
  const rec = costTracker.report({ userId: 'u1' });
  assert.equal(rec.totals.inputTokens, 0);
  assert.equal(rec.totals.outputTokens, 0);
});

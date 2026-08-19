/**
 * ai-stream-metrics — verifies the Prometheus wiring for the /generate
 * streaming `usage` event added in cycle 28 / wired in cycle 46.
 *
 * Covers:
 *   1. Counter increments per (model, provider, kind=input|output).
 *   2. Cost counter increments per (model, provider).
 *   3. Duration histogram observation lands in the right bucket.
 *   4. Defensive defaults: zero / NaN / missing values are no-ops.
 *   5. Renders cleanly in the Prometheus text exposition.
 */

'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const metrics = require('../src/utils/metrics');

beforeEach(() => metrics._reset());

describe('ai stream metrics — recordAIStreamUsage', () => {
  test('increments input + output token counters with model/provider labels', () => {
    metrics.recordAIStreamUsage({
      model: 'gpt-4o-mini',
      provider: 'OpenAI',
      inputTokens: 120,
      outputTokens: 340,
      costUSD: 0.0021,
      durationSeconds: 1.5,
    });
    const txt = metrics.renderText();
    assert.match(
      txt,
      /siragpt_ai_tokens_total\{model="gpt-4o-mini",provider="OpenAI",kind="input"\} 120/,
    );
    assert.match(
      txt,
      /siragpt_ai_tokens_total\{model="gpt-4o-mini",provider="OpenAI",kind="output"\} 340/,
    );
  });

  test('increments cost counter per (model, provider)', () => {
    metrics.recordAIStreamUsage({
      model: 'claude-opus',
      provider: 'Anthropic',
      inputTokens: 10,
      outputTokens: 20,
      costUSD: 0.5,
      durationSeconds: 0.4,
    });
    metrics.recordAIStreamUsage({
      model: 'claude-opus',
      provider: 'Anthropic',
      inputTokens: 5,
      outputTokens: 10,
      costUSD: 0.25,
      durationSeconds: 0.3,
    });
    const txt = metrics.renderText();
    assert.match(
      txt,
      /siragpt_ai_request_cost_usd_total\{model="claude-opus",provider="Anthropic"\} 0\.75/,
    );
  });

  test('observes streaming duration in the histogram', () => {
    metrics.recordAIStreamUsage({
      model: 'm1',
      provider: 'p1',
      inputTokens: 1,
      outputTokens: 1,
      costUSD: 0.0001,
      durationSeconds: 1.2,
    });
    const txt = metrics.renderText();
    // 1.2s falls into the le="2" bucket but not le="1".
    assert.match(
      txt,
      /siragpt_ai_request_duration_seconds_bucket\{model="m1",provider="p1",le="1"\} 0/,
    );
    assert.match(
      txt,
      /siragpt_ai_request_duration_seconds_bucket\{model="m1",provider="p1",le="2"\} 1/,
    );
    assert.match(
      txt,
      /siragpt_ai_request_duration_seconds_count\{model="m1",provider="p1"\} 1/,
    );
  });

  test('non-finite or zero values are silently ignored', () => {
    metrics.recordAIStreamUsage({
      model: 'm2',
      provider: 'p2',
      inputTokens: NaN,
      outputTokens: 0,
      costUSD: -1,
      durationSeconds: Infinity,
    });
    const txt = metrics.renderText();
    // No series should have been created for m2/p2.
    assert.doesNotMatch(txt, /siragpt_ai_tokens_total\{model="m2"/);
    assert.doesNotMatch(txt, /siragpt_ai_request_cost_usd_total\{model="m2"/);
    assert.doesNotMatch(txt, /siragpt_ai_request_duration_seconds_count\{model="m2"/);
  });

  test('defaults to "unknown" when model/provider missing', () => {
    metrics.recordAIStreamUsage({
      inputTokens: 7,
      outputTokens: 11,
      costUSD: 0.01,
      durationSeconds: 0.2,
    });
    const txt = metrics.renderText();
    assert.match(
      txt,
      /siragpt_ai_tokens_total\{model="unknown",provider="unknown",kind="input"\} 7/,
    );
    assert.match(
      txt,
      /siragpt_ai_tokens_total\{model="unknown",provider="unknown",kind="output"\} 11/,
    );
  });

  test('never throws when called with completely invalid input', () => {
    assert.doesNotThrow(() => metrics.recordAIStreamUsage(null));
    assert.doesNotThrow(() => metrics.recordAIStreamUsage(undefined));
    assert.doesNotThrow(() => metrics.recordAIStreamUsage({}));
  });

  test('registers the three new metric families in the registry', () => {
    assert.ok(metrics.registry.has('siragpt_ai_tokens_total'));
    assert.ok(metrics.registry.has('siragpt_ai_request_cost_usd_total'));
    assert.ok(metrics.registry.has('siragpt_ai_request_duration_seconds'));
    assert.equal(metrics.registry.get('siragpt_ai_tokens_total').type, 'counter');
    assert.equal(metrics.registry.get('siragpt_ai_request_cost_usd_total').type, 'counter');
    assert.equal(metrics.registry.get('siragpt_ai_request_duration_seconds').type, 'histogram');
  });
});

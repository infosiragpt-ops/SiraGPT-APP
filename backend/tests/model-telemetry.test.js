'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const metricsRegistry = require('../src/utils/metrics');

const mt = require('../src/services/codex/model-telemetry');

function seriesOf(name) {
  const m = metricsRegistry.registry.get(name);
  return m ? m.series : new Map();
}

test('model buckets: deepseek tiers, sonnet, and closed vocabulary', () => {
  assert.equal(mt.modelToken('deepseek-v4-flash'), 'deepseek_flash');
  assert.equal(mt.modelToken('deepseek-v4-pro'), 'deepseek_pro');
  assert.equal(mt.modelToken('DeepSeek-Reasoner'), 'deepseek_pro');
  assert.equal(mt.modelToken('openrouter/deepseek/deepseek-chat'), 'deepseek_flash');
  assert.equal(mt.modelToken('claude-sonnet-4-20250514'), 'sonnet');
  assert.equal(mt.modelToken('CLAUDE-SONNET-4.6'), 'sonnet');
  assert.equal(mt.modelToken('claude-opus-4'), 'opus');
  assert.equal(mt.modelToken('gpt-4o'), 'gpt');
  assert.equal(mt.modelToken('o1-mini'), 'gpt');
  assert.equal(mt.modelToken('gemini-2.5-flash'), 'gemini');
  assert.equal(mt.modelToken('qwen-3-coder'), 'other_oss');
  assert.equal(mt.modelToken('totally-new-model-x'), 'other');
  assert.equal(mt.modelToken(null), 'unknown');
  assert.equal(mt.modelToken(undefined), 'unknown');
  assert.equal(mt.modelToken(''), 'unknown');
});

test('provider tokens fold unknowns into a bounded set', () => {
  assert.equal(mt.providerToken('Anthropic'), 'anthropic');
  assert.equal(mt.providerToken('deepseek'), 'deepseek');
  assert.equal(mt.providerToken('OpenRouter'), 'openrouter');
  assert.equal(mt.providerToken('Cerebras'), 'cerebras');
  assert.equal(mt.providerToken('weird-provider-9'), 'other');
  assert.equal(mt.providerToken(null), 'other');
});

test('agent tokens are bounded', () => {
  assert.equal(mt.agentToken('codex_build'), 'codex_build');
  assert.equal(mt.agentToken('code_review'), 'se_agent');
  assert.equal(mt.agentToken('some-future-agent'), 'other');
  assert.equal(mt.agentToken(null), 'unknown');
});

test('classifyLlmError maps transport classes to bounded error_class values', () => {
  assert.equal(mt.classifyLlmError({ status: 402, message: 'payment required' }), 'payment_required');
  assert.equal(mt.classifyLlmError({ status: 429 }), 'rate_limit');
  assert.equal(mt.classifyLlmError({ status: 503 }), 'provider_error');
  assert.equal(mt.classifyLlmError({ code: 'loop_stall' }), 'stall');
  assert.equal(mt.classifyLlmError({ code: 'stream_stall_retryable' }), 'stall');
  assert.equal(mt.classifyLlmError(new Error('ETIMEDOUT after 60000ms')), 'timeout');
  assert.equal(mt.classifyLlmError({ aborted: true }), 'aborted');
  assert.equal(mt.classifyLlmError(new Error('mystery')), 'internal');
  assert.equal(mt.classifyLlmError(null), 'internal');
});

test('recordLlmTurn ok path increments calls, tokens, duration; ttft only when streamed', () => {
  metricsRegistry._reset();
  mt.registerAll(metricsRegistry);
  mt.recordLlmTurn({
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    agent: 'codex_build',
    outcome: 'ok',
    durationMs: 1200,
    ttftMs: 300,
    tokensIn: 100,
    tokensOut: 40,
  });
  const callsKey = [...seriesOf(mt.CALLS).keys()].find((k) => k.includes('deepseek_flash'));
  assert.ok(callsKey, 'calls series exists for deepseek_flash');
  assert.equal(seriesOf(mt.CALLS).get(callsKey), 1);
  // ttft recorded
  const ttftSeries = seriesOf(mt.TTFT);
  const ttftKey = [...ttftSeries.keys()].find((k) => k.includes('deepseek_flash'));
  assert.ok(ttftKey);
  const rec = ttftSeries.get(ttftKey);
  assert.equal(rec.count, 1);
  assert.equal(rec.sum, 300);
  // tokens
  const tokens = seriesOf(mt.TOKENS);
  const inKey = [...tokens.keys()].find((k) => k.includes('direction=in'));
  const outKey = [...tokens.keys()].find((k) => k.includes('direction=out'));
  assert.equal(tokens.get(inKey), 100);
  assert.equal(tokens.get(outKey), 40);
  // agent segmentation
  const byAgent = seriesOf(mt.AGENT_CALLS);
  const agentKey = [...byAgent.keys()].find((k) => k.includes('agent=codex_build') && k.includes('model=deepseek_flash'));
  assert.ok(agentKey, 'model×agent series exists');
  assert.equal(byAgent.get(agentKey), 1);
});

test('recordLlmTurn error path counts errors with bounded class and no token inflation', () => {
  metricsRegistry._reset();
  mt.registerAll(metricsRegistry);
  mt.recordLlmTurn({
    model: 'claude-sonnet-4',
    provider: 'anthropic',
    outcome: 'error',
    error: { status: 429, message: 'rate limited' },
    durationMs: 900,
  });
  const errs = seriesOf(mt.ERRORS);
  const key = [...errs.keys()].find((k) => k.includes('error_class=rate_limit') && k.includes('model=sonnet'));
  assert.ok(key, 'error series exists with bounded rate_limit class');
  assert.equal(errs.get(key), 1);
  // no tokens recorded
  assert.equal(seriesOf(mt.TOKENS).size, 0);
});

test('recordLlmTurn never throws on garbage input (telemetry cannot break a turn)', () => {
  metricsRegistry._reset();
  mt.registerAll(metricsRegistry);
  assert.doesNotThrow(() => mt.recordLlmTurn({}));
  assert.doesNotThrow(() => mt.recordLlmTurn(null));
  assert.doesNotThrow(() => mt.recordLlmTurn({ model: 12345, provider: {}, outcome: 'bogus', ttftMs: 'x' }));
});

test('run-completion registers terminal-by-model family and buckets ids', () => {
  const runCompletion = require('../src/services/codex/run-completion');
  assert.ok(runCompletion.MODEL_TERMINAL_COUNTER === 'siragpt_codex_runs_terminal_by_model_total');
});

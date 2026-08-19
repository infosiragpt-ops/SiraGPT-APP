'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveCost, aggregateSource } = require('../src/services/codex/cost-resolver');

test('a direct costUsd on the response is provider_exact, split by token ratio', async () => {
  const r = await resolveCost({ provider: 'openai', tokensIn: 10, tokensOut: 5, costUsd: 0.01 });
  assert.equal(r.costUsd, 0.01);
  assert.equal(r.costSource, 'provider_exact');
  // 10:5 token ratio → 2/3 input, 1/3 output; parts sum back to the total.
  assert.ok(Math.abs(r.costInputUsd - 0.01 * (10 / 15)) < 1e-9);
  assert.ok(Math.abs(r.costOutputUsd - 0.01 * (5 / 15)) < 1e-9);
  assert.ok(Math.abs(r.costInputUsd + r.costOutputUsd - r.costUsd) < 1e-9);
});

test('explicit per-direction cost on the response wins over the token split', async () => {
  const r = await resolveCost({ provider: 'openai', tokensIn: 10, tokensOut: 5, costUsd: 0.01, costInputUsd: 0.008, costOutputUsd: 0.002 });
  assert.equal(r.costInputUsd, 0.008);
  assert.equal(r.costOutputUsd, 0.002);
});

test('Cerebras / FlashGPT is exactly $0 (provider_exact), zero split', async () => {
  const a = await resolveCost({ provider: 'Cerebras', tokensIn: 1000, tokensOut: 2000 });
  assert.deepEqual(a, { costUsd: 0, costInputUsd: 0, costOutputUsd: 0, costSource: 'provider_exact' });
  const b = await resolveCost({ provider: 'FlashGPT', tokensIn: 1, tokensOut: 1 });
  assert.equal(b.costUsd, 0);
  assert.equal(b.costInputUsd, 0);
  assert.equal(b.costOutputUsd, 0);
  assert.equal(b.costSource, 'provider_exact');
});

test('OpenRouter + generationId + key + good fetch → openrouter_generation native cost', async () => {
  const fetchImpl = async (url, opts) => {
    assert.match(url, /generation\?id=gen-1/);
    assert.match(opts.headers.Authorization, /Bearer k/);
    return { ok: true, json: async () => ({ data: { total_cost: 0.0042 } }) };
  };
  const r = await resolveCost(
    { provider: 'OpenRouter', generationId: 'gen-1', tokensIn: 100, tokensOut: 50 },
    { env: { OPENROUTER_API_KEY: 'k' }, fetchImpl },
  );
  assert.equal(r.costSource, 'openrouter_generation');
  assert.equal(r.costUsd, 0.0042);
});

test('OpenRouter generation fetch failure degrades to estimated (never throws)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const r = await resolveCost(
    { provider: 'OpenRouter', generationId: 'gen-1', tokensIn: 100, tokensOut: 50 },
    { env: { OPENROUTER_API_KEY: 'k' }, fetchImpl },
  );
  assert.equal(r.costSource, 'estimated');
  assert.ok(r.costUsd >= 0);
});

test('OpenRouter without an API key skips the generation call → estimated', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const r = await resolveCost({ provider: 'OpenRouter', generationId: 'g', tokensIn: 1, tokensOut: 1 }, { env: {}, fetchImpl });
  assert.equal(called, false);
  assert.equal(r.costSource, 'estimated');
});

test('unknown provider with no usage → estimated (cost 0 when no rate)', async () => {
  const r = await resolveCost({ provider: 'some-random-provider', tokensIn: 100, tokensOut: 100 }, { env: {} });
  assert.equal(r.costSource, 'estimated');
  assert.ok(Number.isFinite(r.costUsd));
});

test('aggregateSource picks the least precise across calls', () => {
  assert.equal(aggregateSource(['provider_exact', 'estimated']), 'estimated');
  assert.equal(aggregateSource(['provider_exact', 'openrouter_generation']), 'openrouter_generation');
  assert.equal(aggregateSource(['provider_exact', 'provider_exact']), 'provider_exact');
  assert.equal(aggregateSource([]), 'provider_exact');
});

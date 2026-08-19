'use strict';

// Low-credit resilience for OpenRouter + embedding billing cooldown.
//
// Prod failure modes these pin (seen live 2026-06-09):
//   1. 402 "You requested up to 65536 tokens, but can only afford 4863" on
//      EVERY chat turn — no caller set max_tokens, so OpenRouter reserved the
//      model's full 65k completion limit. Fixes: (a) the gateway now defaults
//      max_tokens for OpenRouter payloads, (b) the afford-guard retries a
//      402 once with the budget the error itself reports.
//   2. Jina embeddings 403 "Insufficient account balance" re-hit on every
//      turn — postJson now trips a billing cooldown and fails fast.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { wrapOpenRouterClient, parseAffordableTokens } = require('../src/services/ai/openrouter-afford-guard');
const gateway = require('../src/services/ai-product-os/litellm-gateway');
const memoryStore = require('../src/services/user-memory-store');

const ENV_KEYS = ['SIRAGPT_OPENROUTER_DEFAULT_MAX_TOKENS', 'SIRAGPT_EMBED_BILLING_COOLDOWN_MS'];
let savedEnv;
beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  memoryStore.resetEmbedBillingCooldown();
});

// ── parseAffordableTokens ─────────────────────────────────────────────────

describe('parseAffordableTokens', () => {
  const MSG = '402 This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 4863.';

  test('extracts ~85% of the affordable budget from a 402', () => {
    assert.equal(parseAffordableTokens({ status: 402, message: MSG }), Math.floor(4863 * 0.85));
    // Status can also live in the message only (SDK error shapes vary).
    assert.equal(parseAffordableTokens(new Error(MSG)), Math.floor(4863 * 0.85));
  });

  test('null for non-402s, unrelated 402s, and budgets too small to retry', () => {
    assert.equal(parseAffordableTokens({ status: 500, message: 'boom' }), null);
    assert.equal(parseAffordableTokens({ status: 402, message: 'payment required' }), null);
    assert.equal(parseAffordableTokens({ status: 402, message: 'can only afford 100 tokens' }), null);
    assert.equal(parseAffordableTokens(null), null);
  });
});

// ── wrapOpenRouterClient ──────────────────────────────────────────────────

function affordError() {
  const err = new Error('402 This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 4000.');
  err.status = 402;
  return err;
}

function fakeClient(behaviour) {
  const calls = [];
  return {
    calls,
    chat: { completions: { create: async (params, opts) => {
      calls.push({ params, opts });
      return behaviour(calls.length, params);
    } } },
  };
}

describe('wrapOpenRouterClient', () => {
  test('402 insufficient credits → one retry with clamped max_tokens', async () => {
    const client = fakeClient((n) => {
      if (n === 1) throw affordError();
      return { ok: true };
    });
    wrapOpenRouterClient(client);
    const res = await client.chat.completions.create({ model: 'x-ai/grok-4.20', messages: [] });
    assert.equal(res.ok, true);
    assert.equal(client.calls.length, 2);
    assert.equal(client.calls[1].params.max_tokens, Math.floor(4000 * 0.85));
  });

  test('other errors pass through untouched; wrap is idempotent', async () => {
    const client = fakeClient(() => { throw Object.assign(new Error('429 rate limited'), { status: 429 }); });
    wrapOpenRouterClient(client);
    wrapOpenRouterClient(client); // double-wrap must not double-retry
    await assert.rejects(() => client.chat.completions.create({ messages: [] }), /429/);
    assert.equal(client.calls.length, 1);
  });

  test('a 402 on the retry itself surfaces (no infinite loop)', async () => {
    const client = fakeClient(() => { throw affordError(); });
    wrapOpenRouterClient(client);
    await assert.rejects(() => client.chat.completions.create({ messages: [] }), /402/);
    assert.equal(client.calls.length, 2);
  });
});

// ── Gateway default max_tokens for OpenRouter ─────────────────────────────

describe('gateway — OpenRouter default max_tokens', () => {
  test('absent maxOutputTokens → default 8192 cap on OpenRouter payloads', () => {
    const { payload } = gateway.buildProviderChatPayload({
      provider: 'OpenRouter',
      model: 'x-ai/grok-4.20',
      messages: [{ role: 'user', content: 'hola' }],
    });
    assert.equal(payload.max_tokens, 8192);
  });

  test('env override and 0-disable are honored', () => {
    process.env.SIRAGPT_OPENROUTER_DEFAULT_MAX_TOKENS = '4096';
    let { payload } = gateway.buildProviderChatPayload({
      provider: 'OpenRouter', model: 'z-ai/glm-5.1', messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(payload.max_tokens, 4096);

    process.env.SIRAGPT_OPENROUTER_DEFAULT_MAX_TOKENS = '0';
    ({ payload } = gateway.buildProviderChatPayload({
      provider: 'OpenRouter', model: 'z-ai/glm-5.1', messages: [{ role: 'user', content: 'x' }],
    }));
    assert.equal('max_tokens' in payload, false);
  });

  test('explicit maxOutputTokens still wins; other providers untouched', () => {
    const { payload: explicit } = gateway.buildProviderChatPayload({
      provider: 'OpenRouter', model: 'x-ai/grok-4.20', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 2000,
    });
    assert.equal(explicit.max_tokens, 2000);

    const { payload: openai } = gateway.buildProviderChatPayload({
      provider: 'OpenAI', model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal('max_tokens' in openai, false);
    assert.equal('max_completion_tokens' in openai, false);
  });
});

// ── Embedding billing cooldown ────────────────────────────────────────────

describe('embedding billing cooldown', () => {
  test('a 403 trips the cooldown: next call fails fast WITHOUT hitting the provider', async () => {
    memoryStore.resetEmbedBillingCooldown();
    let fetchCalls = 0;
    const fetch403 = async () => { fetchCalls += 1; return { ok: false, status: 403, text: async () => '{"detail":"Insufficient account balance"}' }; };

    await assert.rejects(
      () => memoryStore.embedTexts(['hola'], { provider: 'jina', apiKey: 'k', fetch: fetch403 }),
      /403/,
    );
    assert.equal(fetchCalls, 1);

    await assert.rejects(
      () => memoryStore.embedTexts(['hola'], { provider: 'jina', apiKey: 'k', fetch: fetch403 }),
      /cooldown/i,
    );
    assert.equal(fetchCalls, 1, 'second call must not reach the provider');
  });

  test('transient 5xx does NOT trip the cooldown', async () => {
    memoryStore.resetEmbedBillingCooldown();
    let fetchCalls = 0;
    const fetch500 = async () => { fetchCalls += 1; return { ok: false, status: 500, text: async () => 'oops' }; };
    await assert.rejects(() => memoryStore.embedTexts(['a'], { provider: 'jina', apiKey: 'k', fetch: fetch500 }), /500/);
    await assert.rejects(() => memoryStore.embedTexts(['a'], { provider: 'jina', apiKey: 'k', fetch: fetch500 }), /500/);
    assert.equal(fetchCalls, 2, 'both calls reach the provider');
  });
});

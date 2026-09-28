'use strict';

/**
 * Item 4 (prod 2026-09-28): at every boot and every RAG call
 * `[embedding-provider] openai failed (429 You have no credits remaining…);
 * trying the next provider`. A billing/quota rejection now puts the provider
 * in a 30 min cooldown: later calls skip it without a network round-trip
 * (debug log only) and the ladder semantics stay intact.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const keyHealth = require('../src/utils/provider-key-health');

function fakeOpenAiSdk(behaviour) {
  require.cache[require.resolve('openai')] = {
    exports: class FakeOpenAI {
      constructor(opts) { this.opts = opts; this.embeddings = { create: async (body) => behaviour(body, opts) }; }
    },
  };
  delete require.cache[require.resolve('../src/services/embedding-provider')];
  return require('../src/services/embedding-provider');
}

function geminiFetch(dim, calls) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, n: body.requests.length });
    const embeddings = body.requests.map((r, i) => ({ values: Array.from({ length: r.outputDimensionality }, (_, k) => (k === i % r.outputDimensionality ? 3 : 0)) }));
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ embeddings }) };
  };
}

function captureConsole() {
  const out = { warn: [], debug: [] };
  const orig = { warn: console.warn, debug: console.debug };
  console.warn = (...a) => out.warn.push(a.join(' '));
  console.debug = (...a) => out.debug.push(a.join(' '));
  return { out, restore: () => { console.warn = orig.warn; console.debug = orig.debug; } };
}

test.beforeEach(() => keyHealth.clear());

test('isBillingRejection: no-credit / quota answers yes; auth, rate limits and 5xx no', () => {
  const ladder = fakeOpenAiSdk(async () => ({ data: [] }));
  assert.equal(ladder.isBillingRejection(Object.assign(new Error('429 You have no credits remaining. Add credits to continue.'), { status: 429 })), true);
  assert.equal(ladder.isBillingRejection(Object.assign(new Error('You exceeded your current quota, please check your plan and billing details.'), { status: 429 })), true);
  assert.equal(ladder.isBillingRejection(Object.assign(new Error('Payment required'), { status: 402 })), true);
  assert.equal(ladder.isBillingRejection(Object.assign(new Error('Rate limit reached for requests'), { status: 429 })), false);
  assert.equal(ladder.isBillingRejection(Object.assign(new Error('Incorrect API key provided'), { status: 401 })), false);
  assert.equal(ladder.isBillingRejection(Object.assign(new Error('Bad gateway'), { status: 502 })), false);
  assert.equal(ladder.isBillingRejection(null), false);
});

test('ladder: OpenAI 429 «no credits» → 30 min cooldown, Gemini serves, later calls skip OpenAI without a round-trip', async () => {
  const cap = captureConsole();
  try {
    const sdkCalls = [];
    const ladder = fakeOpenAiSdk(async (body) => {
      sdkCalls.push(body);
      throw Object.assign(new Error('429 You have no credits remaining. Add credits to continue.'), { status: 429 });
    });
    ladder.resetForTests();
    const env = { OPENAI_API_KEY: 'sk-dry', GEMINI_API_KEY: 'g-ok' };
    const gcalls = [];

    const vecs = await ladder.embed(['hola', 'mundo'], { targetDim: 1536, env, fetchImpl: geminiFetch(1536, gcalls) });
    assert.equal(vecs.length, 2);
    assert.equal(sdkCalls.length, 1);
    assert.equal(gcalls.length, 1);
    assert.equal(ladder.billingCoolingDown('openai'), true);
    assert.equal(keyHealth.isRejected('openai', 'sk-dry'), false, 'a billing answer is not an invalid key');
    assert.equal(cap.out.warn.filter((l) => /openai has no credit/.test(l)).length, 1, 'one WARN when the cooldown starts');

    // Second call: OpenAI skipped with no network call, logged at debug only.
    await ladder.embed(['otra'], { targetDim: 1536, env, fetchImpl: geminiFetch(1536, gcalls) });
    assert.equal(sdkCalls.length, 1, 'memoised: no second OpenAI call');
    assert.equal(gcalls.length, 2);
    assert.equal(cap.out.warn.filter((l) => /\[embedding-provider\] openai/.test(l)).length, 1, 'no repeated WARN');
    assert.ok(cap.out.debug.some((l) => /skipping openai \(billing cooldown/.test(l)));

    const st = ladder.status(env);
    assert.equal(st.providers.openai.rejected, true);
    assert.match(String(st.providers.openai.billingCooldownUntil), /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(st.spaces[1536].available, ['gemini']);
    assert.equal(ladder.isAvailable(1536, { OPENAI_API_KEY: 'sk-dry' }), false, 'the only provider is cooling down');
    assert.equal(ladder.DEFAULT_BILLING_COOLDOWN_MS, 30 * 60 * 1000);

    // Exact space demanded on the cooling provider → unavailable, never substituted.
    await assert.rejects(
      () => ladder.embed(['x'], { targetDim: 1536, env, space: 'openai:text-embedding-3-small:1536', fetchImpl: geminiFetch(1536, []) }),
      (err) => err.code === 'EMBEDDING_UNAVAILABLE' && /billing-cooldown/.test(err.message),
    );
    assert.equal(sdkCalls.length, 1);

    // The cooldown is process state: resetForTests clears it (and the env knob is honoured).
    ladder.resetForTests();
    assert.equal(ladder.billingCoolingDown('openai'), false);
    const short = { ...env, SIRAGPT_EMBED_BILLING_COOLDOWN_MS: '1000' };
    await ladder.embed(['y'], { targetDim: 1536, env: short, fetchImpl: geminiFetch(1536, []) });
    assert.equal(sdkCalls.length, 2);
    assert.ok(cap.out.warn.some((l) => /skipped for 0 min/.test(l)), 'cooldown length comes from SIRAGPT_EMBED_BILLING_COOLDOWN_MS');
  } finally {
    cap.restore();
  }
});

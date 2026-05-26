'use strict';

/**
 * Phase 8F.2 — verifies that callUserSelectedModel transparently wires
 * the native Anthropic provider when the env flag is set, and falls
 * back to the deterministic stub otherwise. Explicit `providers`
 * passed by the caller always win.
 *
 * The Anthropic SDK is never invoked. We inject a fake client via
 * the provider module's test seam so the suite stays offline.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const modelAdapter = require('../src/services/sira/model-adapter');
const anthropicNative = require('../src/services/providers/anthropic-native');

function withEnv(overrides, fn) {
  const previous = {};
  for (const [k, v] of Object.entries(overrides)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    anthropicNative._resetClientForTests();
  });
}

const ANTHROPIC_CALL = {
  selectedModel: { provider: 'anthropic', modelId: 'claude-sonnet-4-6', modality: 'text' },
  systemPrompt: 'You are concise.',
  messages: [{ role: 'user', content: 'hola' }],
};

// All identity assertions intentionally avoid `===` on the stub closures:
// `createDefaultProviders()` builds fresh closures on every call, so two
// "equivalent stubs" are never reference-equal. We assert behavior instead.
const STUB_PROBE = {
  selectedModel: { provider: 'anthropic', modelId: 'probe-model' },
  systemPrompt: '',
  messages: [{ role: 'user', content: 'probe' }],
  responseFormat: 'text',
};

async function isStubBehavior(fn) {
  const out = await fn(STUB_PROBE);
  // The stub returns a deterministic "[anthropic:<modelId>] ..." string;
  // see createDefaultProviders() in src/services/sira/model-adapter.js.
  return typeof out?.text === 'string' && /\[anthropic:probe-model\]/.test(out.text);
}

test('resolveProviders falls back to stub when ANTHROPIC_API_KEY is missing', () => {
  return withEnv({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_NATIVE_ENABLED: undefined }, async () => {
    const providers = modelAdapter.resolveProviders();
    assert.equal(typeof providers.anthropic, 'function');
    assert.ok(await isStubBehavior(providers.anthropic), 'expected stub behavior when env is missing');
  });
});

test('resolveProviders swaps the Anthropic stub for the native provider when env is set', () => {
  return withEnv({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_NATIVE_ENABLED: undefined }, async () => {
    let createCalls = 0;
    anthropicNative._setClientForTests({
      messages: { create: async () => { createCalls += 1; return { content: [{ type: 'text', text: 'native' }], usage: {} }; } },
    });
    const providers = modelAdapter.resolveProviders();
    const out = await providers.anthropic(STUB_PROBE);
    assert.equal(createCalls, 1, 'native client must be invoked, not the stub');
    assert.equal(out.text, 'native');

    // Other providers stay as stubs in 8F.2 — verify by behavior probe.
    const openaiProbe = { ...STUB_PROBE, selectedModel: { provider: 'openai', modelId: 'probe-model' } };
    const openaiOut = await providers.openai(openaiProbe);
    assert.match(openaiOut.text, /\[openai:probe-model\]/);
  });
});

test('resolveProviders keeps the stub when ANTHROPIC_NATIVE_ENABLED=false even with key', () => {
  return withEnv({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_NATIVE_ENABLED: 'false' }, async () => {
    const providers = modelAdapter.resolveProviders();
    assert.ok(await isStubBehavior(providers.anthropic), 'expected stub behavior when env disables native');
  });
});

test('callUserSelectedModel routes through the native provider when env is set', () => {
  return withEnv({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_NATIVE_ENABLED: undefined }, async () => {
    const fakeResp = {
      content: [{ type: 'text', text: 'respuesta nativa via wiring' }],
      usage: { input_tokens: 8, output_tokens: 5 },
    };
    let createCalls = 0;
    anthropicNative._setClientForTests({
      messages: { create: async (payload) => { createCalls += 1; assert.equal(payload.model, 'claude-sonnet-4-6'); return fakeResp; } },
    });

    const result = await modelAdapter.callUserSelectedModel(ANTHROPIC_CALL, {
      // Disable instrumentation so the test does not touch the cost
      // ledger / circuit breaker. The wiring path itself is what we
      // are asserting here.
      instrument: false,
    });

    assert.equal(createCalls, 1);
    assert.equal(result.provider, 'anthropic');
    assert.equal(result.text, 'respuesta nativa via wiring');
    assert.equal(result.usage.input_tokens, 8);
  });
});

test('callUserSelectedModel still uses the stub when env is missing', () => {
  return withEnv({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_NATIVE_ENABLED: undefined }, async () => {
    let createCalls = 0;
    anthropicNative._setClientForTests({
      messages: { create: async () => { createCalls += 1; return { content: [], usage: {} }; } },
    });

    const result = await modelAdapter.callUserSelectedModel(ANTHROPIC_CALL, { instrument: false });

    assert.equal(createCalls, 0, 'native client must not be invoked when env is unset');
    // The stub returns a synthetic "[anthropic:<modelId>] ..." string
    // — see createDefaultProviders() in model-adapter.js.
    assert.match(result.text, /\[anthropic:claude-sonnet-4-6\]/);
  });
});

test('explicit providers override resolveProviders even when env is set', () => {
  return withEnv({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_NATIVE_ENABLED: undefined }, async () => {
    let nativeCalls = 0;
    anthropicNative._setClientForTests({
      messages: { create: async () => { nativeCalls += 1; return { content: [], usage: {} }; } },
    });

    let stubCalls = 0;
    const explicitProviders = {
      ...modelAdapter.createDefaultProviders(),
      anthropic: async () => {
        stubCalls += 1;
        return { text: 'caller-supplied stub', parsed: null, usage: { input_tokens: 0, output_tokens: 0 }, raw: null };
      },
    };

    const result = await modelAdapter.callUserSelectedModel(ANTHROPIC_CALL, {
      providers: explicitProviders,
      instrument: false,
    });

    assert.equal(nativeCalls, 0, 'native client must not be invoked when caller supplies providers');
    assert.equal(stubCalls, 1);
    assert.equal(result.text, 'caller-supplied stub');
  });
});

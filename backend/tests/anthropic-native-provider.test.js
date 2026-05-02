'use strict';

/**
 * Phase 8F — unit coverage for the Anthropic-native provider factory.
 *
 * The official SDK is never invoked here. We inject a stub client via
 * `_setClientForTests` so the test runner stays offline and free of
 * Anthropic credentials.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const provider = require('../src/services/providers/anthropic-native');

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
  });
}

function makeFakeClient(returnedResp, opts = {}) {
  const calls = [];
  const client = {
    messages: {
      async create(payload) {
        calls.push(payload);
        if (opts.shouldThrow) throw opts.shouldThrow;
        return returnedResp;
      },
    },
  };
  return { client, calls };
}

test.beforeEach(() => provider._resetClientForTests());

test('isEnabled is false without ANTHROPIC_API_KEY', () => {
  return withEnv({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_NATIVE_ENABLED: undefined }, () => {
    assert.equal(provider.isEnabled(), false);
  });
});

test('isEnabled is true with key and default flag', () => {
  return withEnv({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_NATIVE_ENABLED: undefined }, () => {
    assert.equal(provider.isEnabled(), true);
  });
});

test('isEnabled is false when explicitly disabled even with key', () => {
  return withEnv({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_NATIVE_ENABLED: 'false' }, () => {
    assert.equal(provider.isEnabled(), false);
  });
});

test('createAnthropicProvider returns null when env is missing', () => {
  return withEnv({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_NATIVE_ENABLED: undefined }, () => {
    assert.equal(provider.createAnthropicProvider(), null);
  });
});

test('createAnthropicProvider returns a callable when env is set', () => {
  return withEnv({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_NATIVE_ENABLED: undefined }, () => {
    const fn = provider.createAnthropicProvider();
    assert.equal(typeof fn, 'function');
  });
});

test('toAnthropicMessages strips non user/assistant roles and stringifies non-string content', () => {
  const out = provider.toAnthropicMessages([
    { role: 'system', content: 'should-be-dropped' },
    { role: 'user', content: 'hola' },
    { role: 'tool', content: 'should-be-dropped' },
    { role: 'assistant', content: { kind: 'object' } },
  ]);
  assert.deepEqual(out, [
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: '{"kind":"object"}' },
  ]);
});

test('extractText concatenates only text-typed content blocks', () => {
  const text = provider.extractText([
    { type: 'text', text: 'hola ' },
    { type: 'tool_use', name: 'ignored' },
    { type: 'text', text: 'mundo' },
  ]);
  assert.equal(text, 'hola mundo');
});

test('callAnthropic surfaces text + usage + raw from the SDK response', async () => {
  return withEnv({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_NATIVE_ENABLED: undefined }, async () => {
    const fakeResp = {
      content: [{ type: 'text', text: 'respuesta nativa' }],
      usage: { input_tokens: 12, output_tokens: 7 },
    };
    const { client, calls } = makeFakeClient(fakeResp);
    provider._setClientForTests(client);

    const out = await provider.callAnthropic({
      selectedModel: { provider: 'anthropic', modelId: 'claude-sonnet-4-6' },
      systemPrompt: 'You are concise.',
      messages: [{ role: 'user', content: '¿Hola?' }],
    });

    assert.equal(out.text, 'respuesta nativa');
    assert.deepEqual(out.usage, { input_tokens: 12, output_tokens: 7 });
    assert.equal(out.raw, fakeResp);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'claude-sonnet-4-6');
    assert.equal(calls[0].system, 'You are concise.');
    assert.deepEqual(calls[0].messages, [{ role: 'user', content: '¿Hola?' }]);
  });
});

test('callAnthropic parses JSON when responseFormat is json', async () => {
  return withEnv({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_NATIVE_ENABLED: undefined }, async () => {
    const fakeResp = {
      content: [{ type: 'text', text: '{"ok":true,"n":2}' }],
      usage: { input_tokens: 4, output_tokens: 9 },
    };
    const { client } = makeFakeClient(fakeResp);
    provider._setClientForTests(client);

    const out = await provider.callAnthropic({
      selectedModel: { provider: 'anthropic', modelId: 'claude-sonnet-4-6' },
      systemPrompt: '',
      messages: [{ role: 'user', content: 'json please' }],
      responseFormat: 'json',
    });

    assert.deepEqual(out.parsed, { ok: true, n: 2 });
  });
});

test('callAnthropic returns parsed=null on invalid JSON without throwing', async () => {
  return withEnv({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_NATIVE_ENABLED: undefined }, async () => {
    const fakeResp = {
      content: [{ type: 'text', text: 'not json at all' }],
      usage: { input_tokens: 1, output_tokens: 5 },
    };
    const { client } = makeFakeClient(fakeResp);
    provider._setClientForTests(client);

    const out = await provider.callAnthropic({
      selectedModel: { provider: 'anthropic', modelId: 'claude-sonnet-4-6' },
      messages: [{ role: 'user', content: 'q' }],
      responseFormat: 'json_schema',
    });

    assert.equal(out.parsed, null);
    assert.equal(out.text, 'not json at all');
  });
});

test('callAnthropic throws a tagged error when the env is disabled', async () => {
  return withEnv({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_NATIVE_ENABLED: undefined }, async () => {
    provider._setClientForTests(null);
    await assert.rejects(
      () => provider.callAnthropic({
        selectedModel: { provider: 'anthropic', modelId: 'claude-sonnet-4-6' },
        messages: [{ role: 'user', content: 'hi' }],
      }),
      (err) => err.code === 'anthropic_native_disabled',
    );
  });
});

test('callAnthropic propagates SDK errors so the gateway circuit breaker can react', async () => {
  return withEnv({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_NATIVE_ENABLED: undefined }, async () => {
    const sdkErr = Object.assign(new Error('upstream 503'), { status: 503 });
    const { client } = makeFakeClient(null, { shouldThrow: sdkErr });
    provider._setClientForTests(client);

    await assert.rejects(
      () => provider.callAnthropic({
        selectedModel: { provider: 'anthropic', modelId: 'claude-sonnet-4-6' },
        messages: [{ role: 'user', content: 'hi' }],
      }),
      (err) => err.message === 'upstream 503' && err.status === 503,
    );
  });
});

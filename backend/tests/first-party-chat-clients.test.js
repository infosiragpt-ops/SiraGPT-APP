'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  stripVendorPrefix,
  createAnthropicStreamingClient,
  createMoonshotClient,
  createXaiClient,
  anthropicSupportsThinkingToggle,
  applyAnthropicThinkingControls,
} = require('../src/services/ai/first-party-chat-clients');
const { PROVIDER_UNAVAILABLE_MESSAGE } = require('../src/services/ai/provider-inference');

test('stripVendorPrefix removes only the matching leading slug', () => {
  assert.equal(stripVendorPrefix('anthropic/claude-fable-5', ['anthropic/']), 'claude-fable-5');
  assert.equal(stripVendorPrefix('moonshotai/kimi-k2.6', ['moonshotai/']), 'kimi-k2.6');
  assert.equal(stripVendorPrefix('claude-sonnet-5', ['anthropic/']), 'claude-sonnet-5');
});

test('createXaiClient points at api.x.ai when the key is present', () => {
  const prev = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'xai-test-key';
  try {
    const client = createXaiClient();
    assert.equal(client.baseURL, 'https://api.x.ai/v1');
  } finally {
    if (prev === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = prev;
  }
});

test('missing first-party keys throw provider-unavailable, not a vendor swap', () => {
  const prev = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    SIRA_ANTHROPIC_API_KEY: process.env.SIRA_ANTHROPIC_API_KEY,
    MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
    KIMI_API_KEY: process.env.KIMI_API_KEY,
    XAI_API_KEY: process.env.XAI_API_KEY,
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SIRA_ANTHROPIC_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  delete process.env.KIMI_API_KEY;
  delete process.env.XAI_API_KEY;
  try {
    assert.throws(() => createAnthropicStreamingClient({ apiKey: '' }), (err) => {
      assert.equal(err.message, PROVIDER_UNAVAILABLE_MESSAGE);
      assert.equal(err.code, 'PROVIDER_CONNECTION_UNAVAILABLE');
      return true;
    });
    assert.throws(() => createMoonshotClient(), (err) => {
      assert.equal(err.message, PROVIDER_UNAVAILABLE_MESSAGE);
      return true;
    });
    assert.throws(() => createXaiClient(), (err) => {
      assert.equal(err.message, PROVIDER_UNAVAILABLE_MESSAGE);
      return true;
    });
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Anthropic thinking toggle covers Claude 4/5 and disables on trivial payloads', () => {
  assert.equal(anthropicSupportsThinkingToggle('claude-sonnet-5'), true);
  // Fable 5.x / Opus 5.5 reject `thinking: disabled` (400) — never sent there.
  assert.equal(anthropicSupportsThinkingToggle('claude-fable-5'), false);
  assert.equal(anthropicSupportsThinkingToggle('claude-opus-5-5'), false);
  assert.equal(anthropicSupportsThinkingToggle('claude-3-5-sonnet'), false);
  const body = { model: 'claude-sonnet-5' };
  applyAnthropicThinkingControls(body, { thinking: { type: 'disabled' } }, 'claude-sonnet-5');
  assert.deepEqual(body.thinking, { type: 'disabled' });
});


test('Sonnet 5.5 sends between_tools on the first native request in every chat path', async () => {
  for (const stream of [false, true]) {
    for (const withTools of [false, true]) {
      for (const controls of [
        { thinking: { type: 'disabled' } },
        { reasoning: { exclude: true } },
        { thinking: { type: 'between_tools' } },
      ]) {
        const requests = [];
        const sdkClient = { messages: {
          async create(body) {
            requests.push(body);
            return { id: 'test', content: [{ type: 'text', text: 'Hola' }], stop_reason: 'end_turn', usage: {} };
          },
          stream(body) {
            requests.push(body);
            return { async *[Symbol.asyncIterator]() {
              yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hola' } };
              yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
            } };
          },
        } };
        const client = createAnthropicStreamingClient({ apiKey: 'test-key', sdkClient });
        const result = await client.chat.completions.create({
          model: 'anthropic/claude-sonnet-5-5', stream,
          messages: [{ role: 'user', content: 'Hola' }], ...controls,
          ...(withTools ? { tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }], tool_choice: 'none' } : {}),
        });
        if (stream) for await (const _chunk of result) { /* consume native stream */ }
        assert.equal(requests.length, 1, 'no rejected first request or compatibility retry');
        assert.equal(requests[0].model, 'claude-sonnet-5-5', 'preserve selected model');
        assert.deepEqual(requests[0].thinking, { type: 'between_tools' });
        if (withTools) assert.deepEqual(requests[0].tool_choice, { type: 'none' });
      }
    }
  }
});

test('native text-only completion preserves max_tokens as the length stop reason', async () => {
  const client = createAnthropicStreamingClient({ apiKey: 'test-key', sdkClient: {
    messages: { create: async () => ({ content: [{ type: 'text', text: '{"answer":5}' }], stop_reason: 'max_tokens' }) },
  } });
  const response = await client.chat.completions.create({
    model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'Calcula' }], stream: false,
  });
  assert.equal(response.choices[0].finish_reason, 'length');
});

test('math and viz reject parseable native JSON when max_tokens stopped generation', async () => {
  const { solveMath } = require('../src/services/math-solver');
  const { generateViz } = require('../src/services/viz-generator');
  const results = [
    [solveMath, { topic: 'algebra', explanation: 'Resultado parcial.', python: '', answer_latex: '5' }],
    [generateViz, { format: 'chartjs', title: 'Datos', explanation: 'Resultado parcial.', payload: {
      config: { type: 'bar', data: { labels: ['A'], datasets: [{ label: 'Ventas', data: [5] }] } },
    } }],
  ];
  for (const [run, parsed] of results) {
    let calls = 0;
    await assert.rejects(run({ prompt: 'Completa todos los resultados.', model: 'claude-sonnet-5-5', clientOptions: {
      env: { ANTHROPIC_API_KEY: 'test-key' }, anthropicSdkClient: {
        messages: { create: async () => {
          calls += 1;
          return { content: [{ type: 'text', text: JSON.stringify(parsed) }], stop_reason: 'max_tokens' };
        } },
      },
    } }), (error) => error.code === 'E_CONTENT');
    assert.equal(calls, 1, 'truncation must not trigger a new provider request');
  }
});

for (const withTools of [false, true]) {
  test(`native SDK respects an explicit zero retry budget on 429 (${withTools ? 'tools' : 'text'})`, async () => {
    const Anthropic = require('@anthropic-ai/sdk');
    let calls = 0;
    const sdkClient = new Anthropic({
      apiKey: 'test-key',
      maxRetries: 1, // A per-request zero must override this client default.
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ type: 'error', error: {
          type: 'rate_limit_error', message: 'Synthetic rate limit',
        } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' } });
      },
    });
    const client = createAnthropicStreamingClient({ apiKey: 'test-key', sdkClient });
    await assert.rejects(client.chat.completions.create({
      model: 'claude-sonnet-5-5', stream: false,
      messages: [{ role: 'user', content: 'Ejemplo' }],
      ...(withTools ? { tools: [{ type: 'function', function: {
        name: 'read_file', parameters: { type: 'object', properties: {} },
      } }] } : {}),
    }, { maxRetries: 0 }), (error) => error.status === 429);
    assert.equal(calls, 1, 'the selected provider receives exactly one request');
  });
}

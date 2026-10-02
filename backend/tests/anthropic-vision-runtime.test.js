'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { modelSupportsVision, selectVisionRuntime, visionClientConfig } = require('../src/services/ai/vision-runtime');
const { answerImageTurnWithVision } = require('../src/services/image-attachment-vision');
const { createAnthropicStreamingClient } = require('../src/services/ai/first-party-chat-clients');
const { toAnthropicTranscript } = require('../src/services/providers/anthropic-openai-adapter');

const DATA = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const IMAGE = { type: 'image_url', image_url: { url: `data:image/png;base64,${DATA}` } };
const NATIVE_IMAGE = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: DATA } };
const TOOL = { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } };

function nativeSdk(error = null) {
  const calls = [];
  const sdk = { messages: {
    async create(body) {
      calls.push(body);
      if (error) throw error;
      return { content: [{ type: 'text', text: 'Veo la imagen.' }], stop_reason: 'end_turn' };
    },
    stream(body) {
      calls.push(body);
      return { async *[Symbol.asyncIterator]() {
        if (error) throw error;
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Veo la imagen.' } };
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
      } };
    },
  } };
  return { calls, client: createAnthropicStreamingClient({ apiKey: 'test-only', sdkClient: sdk }) };
}

test('native Claude vision stays selected even with other provider keys present', () => {
  for (const model of ['claude-sonnet-5-5', 'anthropic/claude-opus-5-5', 'claude-3-5-sonnet-20241022', 'claude-haiku-4-5', 'claude-fable-5-1']) {
    assert.equal(modelSupportsVision('Anthropic', model), true, model);
    assert.deepEqual(selectVisionRuntime('Anthropic', model, { GEMINI_API_KEY: 'test-other', OPENAI_API_KEY: 'test-other' }),
      { provider: 'Anthropic', model, switched: false, fallbacks: [] });
  }
  for (const model of ['claude-2.1', 'claude-instant-1.2', 'gpt-5']) assert.equal(modelSupportsVision('Anthropic', model), false, model);
});

for (const stream of [false, true]) {
  for (const withTools of [false, true]) {
    test(`native image bytes reach the selected API with stream=${stream}, tools=${withTools}`, async () => {
      const { client, calls } = nativeSdk();
      const original = [{ role: 'user', content: [{ type: 'text', text: 'Describe estas imágenes.' }, IMAGE,
        { type: 'image_url', image_url: { url: 'https://example.com/photo.jpg' } }] }];
      const snapshot = JSON.stringify(original);
      const result = await client.chat.completions.create({ model: 'anthropic/claude-sonnet-5-5', stream, messages: original,
        ...(withTools ? { tools: [TOOL], tool_choice: 'none' } : {}) });
      if (stream) {
        let text = '';
        for await (const chunk of result) text += chunk.choices[0].delta.content || '';
        assert.equal(text, 'Veo la imagen.');
      } else assert.equal(result.choices[0].message.content, 'Veo la imagen.');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].model, 'claude-sonnet-5-5');
      assert.deepEqual(calls[0].messages[0].content, [{ type: 'text', text: 'Describe estas imágenes.' }, NATIVE_IMAGE,
        { type: 'image', source: { type: 'url', url: 'https://example.com/photo.jpg' } }]);
      assert.equal(JSON.stringify(original), snapshot, 'conversion must not rewrite chat history');
    });
  }
}

test('image recovery reads pixels on native selected Claude instead of a different provider', async () => {
  const { client, calls } = nativeSdk();
  const providers = [];
  const result = await answerImageTurnWithVision({
    prompt: 'Describe la imagen', imageFiles: [{ path: 'fixture.png', mimeType: 'image/png' }],
    provider: 'Anthropic', model: 'claude-sonnet-5-5', pinned: true,
    env: { GEMINI_API_KEY: 'test-other' }, prepareImage: async () => IMAGE,
    getClient(provider) { providers.push(provider); return client; },
  });
  assert.deepEqual(providers, ['Anthropic']);
  assert.equal(result.pickedOnly, true);
  assert.equal(result.text, 'Veo la imagen.');
  assert.deepEqual(calls[0].messages[0].content[1], NATIVE_IMAGE);
});

test('selected Claude billing failure remains its failure with no vision fallback', async () => {
  const error = Object.assign(new Error('Your credit balance is too low'), { status: 400 });
  const { client, calls } = nativeSdk(error);
  const providers = [];
  const result = await answerImageTurnWithVision({
    prompt: 'Describe la imagen', imageFiles: [{ path: 'fixture.png', mimeType: 'image/png' }],
    provider: 'Anthropic', model: 'claude-sonnet-5-5', pinned: true,
    env: { GEMINI_API_KEY: 'test-other', OPENAI_API_KEY: 'test-other' }, prepareImage: async () => IMAGE,
    getClient(provider) { providers.push(provider); return client; }, logger: { warn() {} },
  });
  assert.deepEqual(providers, ['Anthropic']);
  assert.equal(calls.length, 1);
  assert.equal(result.pickedOnly, true);
  assert.equal(result.error, error);
  assert.equal(result.text, '');
});

test('tool-result images preserve their native content and malformed image inputs fail explicitly', () => {
  const result = toAnthropicTranscript([{ role: 'tool', tool_call_id: 'call_1', content: [IMAGE] }]);
  assert.deepEqual(result.messages[0].content[0].content, [NATIVE_IMAGE]);
  for (const url of ['file:///etc/passwd', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,%%%']) {
    assert.throws(() => toAnthropicTranscript([{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }]),
      (error) => error.code === 'E_PARAMS' && !error.message.includes(url));
  }
});

test('native vision helper config uses its own key and protocol, never OpenAI credentials', () => {
  const config = visionClientConfig('Anthropic', { ANTHROPIC_API_KEY: 'test-selected', OPENAI_API_KEY: 'test-other' });
  assert.equal(config.apiKey, 'test-selected');
  assert.equal(config.protocol, 'anthropic');
  assert.equal(config.strictJsonSchema, false);
});

test('generateStream keeps the selected native model and sends image pixels end to end', async () => {
  const service = require('../src/services/ai-service');
  const { client, calls } = nativeSdk();
  const originalPrepare = service.prepareImageForVision;
  const originalClient = service.getClient;
  const originalGemini = process.env.GEMINI_API_KEY;
  const events = [];
  let crossProviderCalls = 0;
  process.env.GEMINI_API_KEY = 'test-other';
  service.prepareImageForVision = async () => IMAGE;
  service.getClient = () => { crossProviderCalls++; throw new Error('unexpected provider switch'); };
  try {
    const answer = await service.generateStream({
      provider: 'Anthropic', model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'Describe la imagen.' }],
      files: [{ path: 'fixture.png', name: 'fixture.png', mimeType: 'image/png' }],
      client, qualityGuard: false, userPrompt: 'Describe la imagen.',
      res: { write(chunk) { events.push(chunk); } },
    });
    assert.equal(answer, 'Veo la imagen.');
    assert.equal(crossProviderCalls, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'claude-sonnet-5-5');
    assert.deepEqual(calls[0].messages.at(-1).content[1], NATIVE_IMAGE);
    assert.match(events.join(''), /Veo la imagen/);
  } finally {
    service.prepareImageForVision = originalPrepare;
    service.getClient = originalClient;
    if (originalGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGemini;
  }
});

test('document vision helper sends selected Claude requests to the native endpoint', async () => {
  const fileProcessor = require('../src/services/fileProcessor');
  const factories = require('../src/services/ai/first-party-chat-clients');
  const originalFactory = factories.createAnthropicStreamingClient;
  const calls = [];
  factories.createAnthropicStreamingClient = (options) => {
    assert.equal(options.timeout, 25_000);
    assert.equal(options.maxRetries, 1);
    return originalFactory({ ...options, fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      calls.push({ url: request.url, body: await request.json() });
      return new Response(JSON.stringify({ id: 'test', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
        content: [{ type: 'text', text: 'Documento leído.' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
    } });
  };
  try {
    const client = fileProcessor._createVisionClient(visionClientConfig('Anthropic', { ANTHROPIC_API_KEY: 'test-only' }));
    const response = await client.chat.completions.create({
      model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: [IMAGE] }], stream: false,
    });
    assert.equal(response.choices[0].message.content, 'Documento leído.');
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url).hostname, 'api.anthropic.com');
    assert.deepEqual(calls[0].body.messages[0].content, [NATIVE_IMAGE]);
  } finally { factories.createAnthropicStreamingClient = originalFactory; }
});

test('generateStream reports selected Claude funding failure without another API attempt', async () => {
  const service = require('../src/services/ai-service');
  const { client, calls } = nativeSdk(Object.assign(new Error('Your credit balance is too low'), { status: 400 }));
  const originalPrepare = service.prepareImageForVision;
  const originalClient = service.getClient;
  const originalGemini = process.env.GEMINI_API_KEY;
  const events = [], failures = [];
  let crossProviderCalls = 0;
  process.env.GEMINI_API_KEY = 'test-other';
  service.prepareImageForVision = async () => IMAGE;
  service.getClient = () => { crossProviderCalls++; throw new Error('unexpected provider switch'); };
  try {
    const answer = await service.generateStream({
      provider: 'Anthropic', model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'Describe la imagen.' }],
      files: [{ path: 'fixture.png', name: 'fixture.png', mimeType: 'image/png' }],
      client, qualityGuard: false, userPrompt: 'Describe la imagen.',
      onProviderFailure(failure) { failures.push(failure); },
      res: { write(chunk) { events.push(chunk); }, end() {} },
    });
    assert.equal(crossProviderCalls, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'claude-sonnet-5-5');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].failureProvider, 'Anthropic');
    assert.equal(failures[0].failureReason, 'billing');
    assert.match(answer, /saldo|facturaci[oó]n/i);
    assert.match(events.join(''), /E_PROVIDER|E_QUOTA/);
  } finally {
    service.prepareImageForVision = originalPrepare;
    service.getClient = originalClient;
    if (originalGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGemini;
  }
});

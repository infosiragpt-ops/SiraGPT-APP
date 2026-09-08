'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  anthropicTurn,
  cacheStableTranscriptPrefix,
} = require('../src/services/codex/anthropic-turn');

test('prompt cache: SDK request has stable breakpoints, standard headers and normalized cache usage', async () => {
  let request = null;
  const fetchImpl = async (input, init = {}) => {
    request = {
      url: typeof input === 'string' ? input : input.url,
      headers: new Headers(init.headers),
      body: JSON.parse(String(init.body || '{}')),
    };
    return new Response(JSON.stringify({
      id: 'msg_cache_hit',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'Listo.' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 80,
        output_tokens: 12,
        cache_creation_input_tokens: 1_200,
        cache_read_input_tokens: 4_800,
        cache_creation: {
          ephemeral_5m_input_tokens: 1_000,
          ephemeral_1h_input_tokens: 200,
        },
      },
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'request-id': 'req_cache_1',
      },
    });
  };

  const out = await anthropicTurn({
    messages: [
      { role: 'system', content: 'Instrucciones estables del agente.' },
      { role: 'user', content: 'Construye la aplicación.' },
      { role: 'assistant', content: 'Voy a inspeccionar el proyecto.' },
      { role: 'user', content: '[TOOL_RESULT list_files] src/App.tsx' },
    ],
    tools: [
      { name: 'list_files', description: 'Lista archivos', parameters: { type: 'object', properties: {} } },
      { name: 'read_file', description: 'Lee archivos', parameters: { type: 'object', properties: {} } },
    ],
    env: {
      ANTHROPIC_API_KEY: 'sk-test-cache',
      ANTHROPIC_BASE_URL: 'https://anthropic.invalid',
    },
    tier: 'power',
    fetchImpl,
    maxTokens: 64,
  });

  assert.equal(request.url, 'https://anthropic.invalid/v1/messages');
  assert.equal(request.headers.get('x-api-key'), 'sk-test-cache');
  assert.equal(request.headers.get('anthropic-version'), '2023-06-01');
  assert.match(request.headers.get('content-type'), /^application\/json/);
  assert.equal(request.headers.get('anthropic-beta'), null, 'prompt caching GA no usa el beta retirado');

  assert.deepEqual(request.body.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(request.body.messages[0].content, 'Construye la aplicación.');
  assert.deepEqual(
    request.body.messages[1].content[0].cache_control,
    { type: 'ephemeral' },
    'el turno completo anterior al tail es el prefijo estable'
  );
  assert.equal(request.body.messages[2].content, '[TOOL_RESULT list_files] src/App.tsx');
  assert.equal(request.body.tools[0].cache_control, undefined);
  assert.deepEqual(request.body.tools[1].cache_control, { type: 'ephemeral' });

  assert.equal(out.usage.tokensIn, 80);
  assert.equal(out.usage.tokensOut, 12);
  assert.equal(out.usage.cacheCreationTokens, 1_200);
  assert.equal(out.usage.cacheReadTokens, 4_800);
  assert.equal(out.usage.cacheCreation5mTokens, 1_000);
  assert.equal(out.usage.cacheCreation1hTokens, 200);
  assert.equal(out.usage.cacheHit, true);
});

test('prompt cache: stable-prefix helper is immutable and leaves a single live turn uncached', () => {
  const turns = [
    { role: 'user', content: 'uno' },
    { role: 'assistant', content: 'dos' },
    { role: 'user', content: 'tres' },
  ];
  const cached = cacheStableTranscriptPrefix(turns);

  assert.equal(turns[1].content, 'dos', 'no muta el transcript de entrada');
  assert.deepEqual(cached[1].content, [{
    type: 'text',
    text: 'dos',
    cache_control: { type: 'ephemeral' },
  }]);
  assert.equal(cached[2].content, 'tres');

  const single = cacheStableTranscriptPrefix([{ role: 'user', content: 'único' }]);
  assert.equal(single[0].content, 'único');
});

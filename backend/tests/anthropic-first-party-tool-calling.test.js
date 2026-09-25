'use strict';

// Direct Claude in the /agentes ReAct loop: the first-party Anthropic client
// must carry tools / tool_choice / role:'tool' end to end (regression from
// PR #499, where the text-only shim dropped them and always answered 'stop').

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createAnthropicStreamingClient } = require('../src/services/ai/first-party-chat-clients');
const { resolveProviderEffortFields } = require('../src/services/ai-product-os/litellm-gateway');
const reactAgent = require('../src/services/react-agent');

const SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
};

function mockSdk(responses) {
  const requests = [];
  let i = 0;
  return {
    requests,
    sdk: {
      messages: {
        create: async (request) => {
          requests.push(JSON.parse(JSON.stringify(request)));
          const next = responses[Math.min(i, responses.length - 1)];
          i += 1;
          return typeof next === 'function' ? next(request) : next;
        },
      },
    },
  };
}

test('tools → tool_use → tool_calls → tool_result → final answer round-trips', async () => {
  const { sdk, requests } = mockSdk([
    {
      id: 'm1', model: 'claude-opus-4-7', stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 },
      content: [
        { type: 'thinking', thinking: 'Necesito el tipo de cambio.', signature: 'sig-1' },
        { type: 'text', text: 'Busco el dato.' },
        { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { query: 'dólar hoy Perú' } },
      ],
    },
    {
      id: 'm2', model: 'claude-opus-4-7', stop_reason: 'end_turn', usage: {},
      content: [{ type: 'text', text: 'El dólar está a S/ 3,72 (fuente: https://www.sbs.gob.pe).' }],
    },
  ]);
  const client = createAnthropicStreamingClient({ apiKey: 'test-key', sdkClient: sdk });
  const messages = [
    { role: 'system', content: 'Eres SiraGPT.' },
    { role: 'user', content: '¿Precio del dólar hoy en Perú?' },
  ];

  const first = await client.chat.completions.create({
    model: 'claude-opus-4-7', messages, tools: [SEARCH_TOOL], tool_choice: 'auto',
    thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' },
    temperature: 0.3,
  });
  assert.equal(requests[0].tools[0].name, 'web_search');
  assert.deepEqual(requests[0].tool_choice, { type: 'auto' });
  assert.equal(requests[0].system, 'Eres SiraGPT.');
  assert.deepEqual(requests[0].output_config, { effort: 'high' });
  assert.equal('temperature' in requests[0], false, 'sampling controls are never sent with thinking');
  const msg = first.choices[0].message;
  assert.equal(first.choices[0].finish_reason, 'tool_calls');
  assert.equal(msg.tool_calls[0].id, 'toolu_1');
  assert.deepEqual(JSON.parse(msg.tool_calls[0].function.arguments), { query: 'dólar hoy Perú' });
  assert.equal(msg.reasoning_content, 'Necesito el tipo de cambio.');

  messages.push(msg);
  messages.push({ role: 'tool', tool_call_id: 'toolu_1', content: '{"results":[{"url":"https://www.sbs.gob.pe"}]}' });
  const second = await client.chat.completions.create({ model: 'claude-opus-4-7', messages, tools: [SEARCH_TOOL] });

  const replayed = requests[1].messages[1];
  assert.equal(replayed.role, 'assistant');
  assert.deepEqual(replayed.content.map((b) => b.type), ['thinking', 'text', 'tool_use'], 'native blocks replay verbatim, in order');
  assert.equal(replayed.content[0].signature, 'sig-1');
  assert.equal(requests[1].messages[2].content[0].type, 'tool_result');
  assert.equal(requests[1].messages[2].content[0].tool_use_id, 'toolu_1');
  assert.equal(second.choices[0].finish_reason, 'stop');
  assert.match(second.choices[0].message.content, /sbs\.gob\.pe/);
  assert.equal(Object.keys(msg).includes('_anthropicContent'), false, 'native blocks stay off the serialized message');
});

test('forced tool_choice becomes auto + a persistent instruction on Fable 5.1', async () => {
  const { sdk, requests } = mockSdk([
    { id: 'a', model: 'claude-fable-5-1', stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'ok' }] },
  ]);
  const client = createAnthropicStreamingClient({ apiKey: 'k', sdkClient: sdk });
  const messages = [{ role: 'user', content: 'Resume.' }];
  const forced = { type: 'function', function: { name: 'finalize' } };
  await client.chat.completions.create({ model: 'claude-fable-5-1', messages, tools: [SEARCH_TOOL], tool_choice: forced });
  await client.chat.completions.create({ model: 'claude-fable-5-1', messages, tools: [SEARCH_TOOL], tool_choice: 'auto' });

  assert.deepEqual(requests[0].tool_choice, { type: 'auto' });
  const nudge0 = requests[0].messages[0].content.at(-1).text;
  assert.match(nudge0, /finalize/);
  assert.deepEqual(requests[1].messages[0], requests[0].messages[0], 'earlier turns are rendered identically on later requests');
});

test('forced tool_choice stays native on models without thinking', async () => {
  const { sdk, requests } = mockSdk([
    { id: 'a', model: 'claude-opus-4-7', stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', id: 't', name: 'web_search', input: {} }] },
  ]);
  const client = createAnthropicStreamingClient({ apiKey: 'k', sdkClient: sdk });
  await client.chat.completions.create({
    model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'x' }], tools: [SEARCH_TOOL],
    tool_choice: { type: 'function', function: { name: 'web_search' } },
  });
  assert.equal(requests[0].tool_choice.type, 'tool');
  assert.equal(requests[0].tool_choice.name, 'web_search');
});

test('streaming turns native tool_use events into OpenAI tool_calls deltas', async () => {
  const events = [
    { type: 'message_start', message: { id: 'm' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pienso' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_9', name: 'web_search', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"dólar"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ];
  const sdk = {
    messages: {
      stream: () => ({
        abort() {},
        [Symbol.asyncIterator]() {
          let i = 0;
          return { next: async () => (i < events.length ? { value: events[i++], done: false } : { value: undefined, done: true }) };
        },
      }),
    },
  };
  const client = createAnthropicStreamingClient({ apiKey: 'k', sdkClient: sdk });
  const stream = await client.chat.completions.create({
    model: 'claude-opus-4-7', stream: true, messages: [{ role: 'user', content: 'x' }], tools: [SEARCH_TOOL],
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const deltas = chunks.map((c) => c.choices[0]);
  assert.equal(deltas[0].delta.reasoning_content, 'pienso');
  assert.equal(deltas[1].delta.tool_calls[0].id, 'toolu_9');
  assert.equal(deltas[1].delta.tool_calls[0].function.name, 'web_search');
  const args = deltas.flatMap((d) => (d.delta.tool_calls || []).map((t) => t.function.arguments || '')).join('');
  assert.deepEqual(JSON.parse(args), { query: 'dólar' });
  assert.equal(deltas.at(-1).finish_reason, 'tool_calls');
});

test('plain text requests keep the text-only path', async () => {
  const { sdk, requests } = mockSdk([
    { id: 'a', model: 'claude-opus-4-7', stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'hola' }] },
  ]);
  const client = createAnthropicStreamingClient({ apiKey: 'k', sdkClient: sdk });
  const out = await client.chat.completions.create({ model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'hola' }] });
  assert.equal(out.choices[0].message.content, 'hola');
  assert.equal('tools' in requests[0], false);
});

test('ReAct loop on direct Claude executes a real tool call and finalizes with the effort fields', async () => {
  const { sdk, requests } = mockSdk([
    {
      id: 'm1', model: 'claude-opus-4-7', stop_reason: 'tool_use', usage: {},
      content: [{ type: 'tool_use', id: 'toolu_s', name: 'web_search', input: { query: 'dólar Perú hoy' } }],
    },
    {
      id: 'm2', model: 'claude-opus-4-7', stop_reason: 'tool_use', usage: {},
      content: [{ type: 'tool_use', id: 'toolu_f', name: 'finalize', input: { answer: 'S/ 3,72 según https://www.sbs.gob.pe' } }],
    },
  ]);
  const client = createAnthropicStreamingClient({ apiKey: 'k', sdkClient: sdk });
  const executed = [];
  const result = await reactAgent.run(client, {
    query: '¿Precio del dólar hoy en Perú?',
    model: 'claude-opus-4-7',
    maxSteps: 4,
    toolCallMode: 'native',
    thinkingLevel: 'xhigh',
    thinkingLevelExplicit: true,
    ctx: { provider: 'Anthropic' },
    tools: [{
      name: 'web_search', description: 'Search the web',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      execute: async (args) => { executed.push(args.query); return { results: [{ url: 'https://www.sbs.gob.pe' }] }; },
    }],
  });
  assert.deepEqual(executed, ['dólar Perú hoy']);
  assert.equal(result.stoppedReason, 'finalized');
  assert.match(result.finalAnswer, /sbs\.gob\.pe/);
  assert.deepEqual(requests[0].output_config, { effort: 'xhigh' });
  assert.equal(requests[0].thinking.type, 'adaptive');
  assert.ok(requests[0].tools.some((t) => t.name === 'web_search'));
});

test('effort fields per provider for the agent loop', () => {
  assert.deepEqual(
    resolveProviderEffortFields({ provider: 'Meta', model: 'muse-spark-1.3', thinkingLevel: 'high', thinkingLevelExplicit: true }),
    { reasoning_effort: 'high' },
  );
  assert.deepEqual(
    resolveProviderEffortFields({ provider: 'Anthropic', model: 'claude-opus-5-5', thinkingLevel: 'disabled' }),
    { output_config: { effort: 'low' } },
  );
  assert.deepEqual(resolveProviderEffortFields({ provider: 'DeepSeek', model: 'deepseek-v4-pro', thinkingLevel: 'high', thinkingLevelExplicit: true }), {});
  assert.deepEqual(resolveProviderEffortFields({ provider: 'Anthropic', model: 'claude-opus-4-7', thinkingLevel: null }), {});
});

test('the agentic route forwards the composer effort to the loop', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
  assert.match(route, /agenticStream\.runAgenticChat\(\{[\s\S]{0,4000}thinkingLevel: req\._thinkingLevel \|\| null/);
  const stream = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'agentic-chat-stream.js'), 'utf8');
  assert.match(stream, /reactAgent\.run\(openai, \{[\s\S]{0,600}thinkingLevel,\s+thinkingLevelExplicit,/);
});

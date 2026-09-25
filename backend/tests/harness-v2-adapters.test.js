'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sseResponse, anthropicEvents, createFetchMock } = require('./helpers/harness-sse');
const { createAnthropicAdapter, toAnthropicMessages } = require('../src/services/harness/adapters/anthropic');
const { createOpenAIChatAdapter } = require('../src/services/harness/adapters/openai-chat');
const { createOpenAIResponsesAdapter } = require('../src/services/harness/adapters/openai-responses');
const { createGeminiAdapter, toGeminiSchema } = require('../src/services/harness/adapters/gemini');
const { createAdapter } = require('../src/services/harness/adapters');
const { HarnessProviderError } = require('../src/services/harness/errors');

const TOOLS = [
  { name: 'get_time', description: 'Hora actual', input_schema: { type: 'object', properties: { timezone: { type: 'string' } }, required: ['timezone'], additionalProperties: false } },
  { name: 'calculator', description: 'Calcula', input_schema: { type: 'object', properties: { expression: { type: ['string', 'null'] }, mode: { type: 'string', enum: ['exact', 'approx'] } }, required: ['expression'] } },
];
const USER = [{ role: 'user', content: 'Hora en Lima y 17*23' }];

function collect() {
  const events = [];
  return { events, emit: (e) => events.push(e) };
}

// ── Anthropic ───────────────────────────────────────────────────────────────

test('anthropic: streams thinking + text + two parallel tool_use blocks', async () => {
  const { fetchImpl, calls } = createFetchMock([sseResponse(anthropicEvents([
    { type: 'message_start', message: { usage: { input_tokens: 120, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Necesito dos ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'herramientas.' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Voy a consultar.' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_time', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"timez' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'one":"America/Lima"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'toolu_2', name: 'calculator', input: {} } },
    { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"expression":"17*23"}' } },
    { type: 'content_block_stop', index: 3 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } },
    { type: 'message_stop' },
  ]), { chunkSize: 7 })]);
  const adapter = createAnthropicAdapter({ endpoint: { baseURL: 'https://api.anthropic.test', apiKey: 'k-test' }, fetchImpl });
  const { events, emit } = collect();
  const out = await adapter.streamTurn({ model: 'claude-fable-5.1', system: 'Eres Sira.', messages: USER, tools: TOOLS, effort: { level: 'xhigh', explicit: true }, maxTokens: 8000, emit });

  const req = calls[0];
  assert.equal(req.url, 'https://api.anthropic.test/v1/messages');
  assert.equal(req.headers['x-api-key'], 'k-test');
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.body.model, 'claude-fable-5-1');
  assert.equal(req.body.stream, true);
  assert.deepEqual(req.body.system[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(req.body.output_config, { effort: 'xhigh' });
  assert.equal(req.body.thinking.type, 'adaptive');
  assert.equal(req.body.temperature, undefined);
  assert.equal(req.body.tool_choice, undefined, 'never forced tool_choice');
  assert.equal(req.body.tools.length, 2);

  assert.equal(out.stopReason, 'tool_use');
  assert.equal(out.usage.cacheReadTokens, 100);
  assert.equal(out.usage.outputTokens, 42);
  const [thinking, text, t1, t2] = out.content;
  assert.equal(thinking.type, 'thinking');
  assert.equal(thinking.text, 'Necesito dos herramientas.');
  assert.equal(thinking.signature, 'sig-abc');
  assert.equal(text.text, 'Voy a consultar.');
  assert.deepEqual(t1, { type: 'tool_call', id: 'toolu_1', name: 'get_time', input: { timezone: 'America/Lima' } });
  assert.deepEqual(t2.input, { expression: '17*23' });
  const types = events.map((e) => e.type);
  assert.ok(types.includes('thinking_delta') && types.includes('text_delta') && types.includes('tool_input_delta'));
  assert.equal(events.filter((e) => e.type === 'tool_call_end').length, 2);
});

test('anthropic: history replays signed thinking for the same model only, merges tool results', () => {
  const history = [
    ...USER,
    { role: 'assistant', content: [
      { type: 'thinking', text: 'plan', signature: 'sig-1', origin: { adapter: 'anthropic', model: 'claude-opus-5.5' } },
      { type: 'thinking', text: 'otro', origin: { adapter: 'openai-chat', model: 'deepseek-v4-pro' } },
      { type: 'tool_call', id: 'call.1', name: 'get_time', input: { timezone: 'UTC' } },
    ] },
    { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'call.1', name: 'get_time', content: '12:00', isError: false }] },
    { role: 'user', content: 'gracias' },
  ];
  const same = toAnthropicMessages(history, 'claude-opus-5.5');
  assert.deepEqual(same[1].content[0], { type: 'thinking', thinking: 'plan', signature: 'sig-1' });
  assert.equal(same[1].content.length, 2, 'foreign thinking dropped');
  assert.equal(same[1].content[1].id, 'call_1', 'tool id sanitized');
  assert.equal(same.length, 3, 'tool_result + next user text merged into one user turn');
  assert.equal(same[2].content[0].type, 'tool_result');
  assert.equal(same[2].content[0].tool_use_id, 'call_1');
  assert.equal(same[2].content[1].text, 'gracias');
  const other = toAnthropicMessages(history, 'claude-sonnet-5');
  assert.ok(!other[1].content.some((b) => b.type === 'thinking'));
});

test('anthropic: Haiku 4.5 gets budget_tokens thinking; stream overloaded error is retryable', async () => {
  const { fetchImpl, calls } = createFetchMock([sseResponse(anthropicEvents([
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
  ]))]);
  const adapter = createAnthropicAdapter({ endpoint: { baseURL: 'https://a.test', apiKey: 'k' }, fetchImpl });
  await assert.rejects(
    adapter.streamTurn({ model: 'claude-haiku-4-5', messages: USER, tools: TOOLS, effort: { level: 'high', explicit: true }, maxTokens: 8000 }),
    (err) => err instanceof HarnessProviderError && err.retryable === true && err.status === 529,
  );
  assert.deepEqual(calls[0].body.thinking, { type: 'enabled', budget_tokens: 4096 });
  assert.equal(calls[0].body.output_config, undefined);
});

test('anthropic: HTTP 429 carries retry-after; 400 is not retryable', async () => {
  const { fetchImpl } = createFetchMock([
    new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429, headers: { 'retry-after': '2' } }),
    new Response(JSON.stringify({ error: { message: 'bad thinking' } }), { status: 400 }),
  ]);
  const adapter = createAnthropicAdapter({ endpoint: { baseURL: 'https://a.test', apiKey: 'k' }, fetchImpl });
  await assert.rejects(adapter.streamTurn({ model: 'claude-sonnet-5', messages: USER }), (e) => e.retryable && e.retryAfterMs === 2000 && e.status === 429);
  await assert.rejects(adapter.streamTurn({ model: 'claude-sonnet-5', messages: USER }), (e) => !e.retryable && e.status === 400 && /bad thinking/.test(e.message));
});

// ── OpenAI-compatible chat ──────────────────────────────────────────────────

test('openai-chat (xAI): tool_call deltas split across chunks, parallel calls, text', async () => {
  const chunks = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: 'Consultando' } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'get_time', arguments: '' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"timezone":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"America/Lima"}' } }, { index: 1, id: 'call_b', function: { name: 'calculator', arguments: '{"expression":"17*23"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 50, completion_tokens: 20 } },
    '[DONE]',
  ];
  const { fetchImpl, calls } = createFetchMock([sseResponse(chunks.map((c) => (typeof c === 'string' ? c : { data: c })), { chunkSize: 11 })]);
  const adapter = createOpenAIChatAdapter({ endpoint: { provider: 'xAI', baseURL: 'https://api.x.test/v1', apiKey: 'xk' }, fetchImpl });
  const { events, emit } = collect();
  const out = await adapter.streamTurn({ model: 'grok-4.6', system: 'S', messages: USER, tools: TOOLS, maxTokens: 4000, emit });
  const req = calls[0];
  assert.equal(req.url, 'https://api.x.test/v1/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer xk');
  assert.equal(req.body.stream, true);
  assert.equal(req.body.tool_choice, 'auto');
  assert.equal(req.body.tools[1].function.parameters.properties.mode.enum[1], 'approx');
  assert.equal(req.body.messages[0].role, 'system');
  assert.deepEqual(req.body.stream_options, { include_usage: true });
  assert.equal(out.stopReason, 'tool_use');
  assert.equal(out.content[0].text, 'Consultando');
  assert.deepEqual(out.content.slice(1).map((b) => [b.id, b.name, b.input]), [
    ['call_a', 'get_time', { timezone: 'America/Lima' }],
    ['call_b', 'calculator', { expression: '17*23' }],
  ]);
  assert.equal(out.usage.inputTokens, 50);
  assert.equal(events.filter((e) => e.type === 'tool_call_start').length, 2);
});

test('openai-chat (Meta Muse Spark): reasoning_effort always present; (DeepSeek V4) reasoning_content captured and replayed', async () => {
  const { fetchImpl, calls } = createFetchMock([
    sseResponse([{ data: { choices: [{ delta: { content: 'hola' }, finish_reason: 'stop' }] } }, '[DONE]']),
    sseResponse([
      { data: { choices: [{ delta: { reasoning_content: 'pienso' } }] } },
      { data: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_time', arguments: '{"timezone":"UTC"}' } }] }, finish_reason: 'tool_calls' }] } },
      '[DONE]',
    ]),
  ]);
  const meta = createOpenAIChatAdapter({ endpoint: { provider: 'Meta', baseURL: 'https://api.meta.test/v1', apiKey: 'm' }, fetchImpl });
  await meta.streamTurn({ model: 'muse-spark-1.3', messages: USER, tools: TOOLS, effort: { level: 'high', explicit: true } });
  assert.equal(calls[0].body.reasoning_effort, 'high');
  assert.equal(calls[0].body.reasoning, undefined);

  const ds = createOpenAIChatAdapter({ endpoint: { provider: 'DeepSeek', baseURL: 'https://api.deepseek.test', apiKey: 'd' }, fetchImpl });
  const { events, emit } = collect();
  const out = await ds.streamTurn({ model: 'deepseek-v4-pro', messages: USER, tools: TOOLS, effort: { level: 'max', explicit: true }, emit });
  assert.equal(out.content[0].type, 'thinking');
  assert.equal(out.content[0].text, 'pienso');
  assert.ok(events.some((e) => e.type === 'thinking_delta'));
  assert.equal(calls[1].body.thinking.type, 'enabled');
  assert.equal(calls[1].body.reasoning_effort, 'max');

  // Replay: the assistant tool-call turn carries its reasoning_content back.
  const { toOpenAIChatMessages } = require('../src/services/harness/adapters/openai-chat');
  const msgs = toOpenAIChatMessages({ messages: [...USER, { role: 'assistant', content: out.content }], model: 'deepseek-v4-pro' });
  assert.equal(msgs[1].reasoning_content, 'pienso');
  assert.equal(msgs[1].tool_calls[0].function.arguments, '{"timezone":"UTC"}');
  assert.equal(msgs[1].content, null);
});

test('openai-chat: provider without tool-call ids and with a bad JSON argument', async () => {
  const { fetchImpl } = createFetchMock([sseResponse([
    { data: { choices: [{ delta: { tool_calls: [{ function: { name: 'calculator', arguments: '{"expression": 17*' } }] } }] } },
    { data: { choices: [{ delta: {}, finish_reason: 'stop' }] } },
  ])]);
  const adapter = createOpenAIChatAdapter({ endpoint: { provider: 'Cerebras', baseURL: 'https://c.test/v1', apiKey: 'c' }, fetchImpl });
  const out = await adapter.streamTurn({ model: 'qwen-3-235b', messages: USER, tools: TOOLS });
  assert.equal(out.stopReason, 'tool_use', 'tool calls win over a "stop" finish_reason');
  assert.match(out.content[0].id, /^call_/);
  assert.ok(out.content[0].parseError);
});

// ── OpenAI Responses ────────────────────────────────────────────────────────

test('openai-responses: reasoning summary, function call, encrypted reasoning replay', async () => {
  const { fetchImpl, calls } = createFetchMock([sseResponse([
    { event: 'response.output_item.added', data: { type: 'response.output_item.added', item: { type: 'reasoning', id: 'rs_1' } } },
    { event: 'x', data: { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'Calculo.' } },
    { event: 'x', data: { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Calculo.' }], encrypted_content: 'ENC' } } },
    { event: 'x', data: { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'calculator', arguments: '' } } },
    { event: 'x', data: { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"expression":"2+2"}' } },
    { event: 'x', data: { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'calculator', arguments: '{"expression":"2+2"}' } } },
    { event: 'x', data: { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 5 } } } },
  ])]);
  const adapter = createOpenAIResponsesAdapter({ endpoint: { provider: 'OpenAI', baseURL: 'https://o.test/v1', apiKey: 'o' }, fetchImpl });
  const out = await adapter.streamTurn({ model: 'gpt-5.5', system: 'S', messages: USER, tools: TOOLS, effort: { level: 'max', explicit: true } });
  assert.equal(calls[0].url, 'https://o.test/v1/responses');
  assert.equal(calls[0].body.reasoning.effort, 'high');
  assert.equal(calls[0].body.store, false);
  assert.equal(calls[0].body.instructions, 'S');
  assert.equal(out.stopReason, 'tool_use');
  assert.equal(out.content[0].meta.item.encrypted_content, 'ENC');
  assert.deepEqual(out.content[1].input, { expression: '2+2' });
  const { toResponsesInput } = require('../src/services/harness/adapters/openai-responses');
  const input = toResponsesInput([...USER, { role: 'assistant', content: out.content }, { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'call_9', content: '4' }] }], 'gpt-5.5');
  assert.deepEqual(input.map((i) => i.type || i.role), ['user', 'reasoning', 'function_call', 'function_call_output']);
});

// ── Gemini native ───────────────────────────────────────────────────────────

test('gemini: schema down-conversion, thought parts, functionCall with thoughtSignature replay', async () => {
  const { fetchImpl, calls } = createFetchMock([sseResponse([
    { data: { candidates: [{ content: { role: 'model', parts: [{ text: 'Pensando…', thought: true }] } }] } },
    { data: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_time', args: { timezone: 'America/Lima' } }, thoughtSignature: 'TS1' }, { functionCall: { name: 'calculator', args: { expression: '17*23' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 10, thoughtsTokenCount: 4 } } },
  ])]);
  const adapter = createGeminiAdapter({ endpoint: { baseURL: 'https://g.test/v1beta', apiKey: 'g' }, fetchImpl });
  const out = await adapter.streamTurn({ model: 'gemini-3.8-flash', system: 'S', messages: USER, tools: TOOLS, effort: { level: 'high', explicit: true } });
  assert.equal(calls[0].url, 'https://g.test/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
  assert.equal(calls[0].headers['x-goog-api-key'], 'g');
  const decl = calls[0].body.tools[0].functionDeclarations;
  assert.equal(decl[0].parameters.additionalProperties, undefined);
  assert.equal(decl[1].parameters.properties.expression.type, 'string');
  assert.equal(decl[1].parameters.properties.expression.nullable, true);
  assert.deepEqual(calls[0].body.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: 'high' });
  assert.equal(out.stopReason, 'tool_use');
  assert.equal(out.content[0].type, 'thinking');
  assert.equal(out.content[1].meta.thoughtSignature, 'TS1');
  assert.equal(out.usage.outputTokens, 14);

  const { toGeminiContents } = require('../src/services/harness/adapters/gemini');
  const contents = toGeminiContents([...USER, { role: 'assistant', content: out.content }, { role: 'tool', content: [
    { type: 'tool_result', toolCallId: out.content[1].id, name: 'get_time', content: '09:00' },
    { type: 'tool_result', toolCallId: out.content[2].id, name: 'calculator', content: '391' },
  ] }], 'gemini-3.8-flash');
  assert.equal(contents[1].role, 'model');
  assert.equal(contents[1].parts[0].thoughtSignature, 'TS1');
  assert.equal(contents[1].parts[1].thoughtSignature, undefined);
  assert.deepEqual(contents[2].parts.map((p) => p.functionResponse.name), ['get_time', 'calculator']);
  assert.deepEqual(toGeminiSchema({ type: 'object', properties: { a: { type: 'integer', enum: [1, 2] } }, additionalProperties: false }), { type: 'object', properties: { a: { type: 'integer', enum: ['1', '2'] } } });
});

// ── Selection ───────────────────────────────────────────────────────────────

test('createAdapter picks the right transport per provider/model and fails closed without a key', () => {
  const env = { ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o', META_API_KEY: 'm', XAI_API_KEY: 'x', DEEPSEEK_API_KEY: 'd', GROQ_API_KEY: 'q' };
  const pick = (provider, model) => { const r = createAdapter({ provider, model, env }); return `${r.adapter.name}/${r.toolMode}`; };
  assert.equal(pick('Anthropic', 'claude-opus-5.5'), 'anthropic/native');
  assert.equal(pick('Gemini', 'gemini-3.8-flash'), 'gemini/native');
  assert.equal(pick('OpenAI', 'gpt-5.5'), 'openai-responses/native');
  assert.equal(pick('OpenAI', 'gpt-4o'), 'openai-chat/native');
  assert.equal(pick('Meta', 'muse-spark-1.3'), 'openai-chat/native');
  assert.equal(pick('xAI', 'grok-4.6'), 'openai-chat/native');
  assert.equal(pick('DeepSeek', 'deepseek-v4-flash'), 'openai-chat/native');
  assert.equal(pick('Groq', 'mystery-model-7b'), 'prompted-xml/prompted');
  assert.equal(createAdapter({ provider: 'xAI', model: 'grok-4.6', env, toolMode: 'prompted' }).adapter.name, 'prompted-xml');
  assert.throws(() => createAdapter({ provider: 'Anthropic', model: 'claude-sonnet-5', env: {} }), (e) => e.code === 'PROVIDER_CONNECTION_UNAVAILABLE' && e.status === 503);
  assert.equal(createAdapter({ provider: 'Anthropic', model: 'claude-fable-5.1', env }).adapter.appendOnlyHistory('claude-fable-5.1'), true);
});

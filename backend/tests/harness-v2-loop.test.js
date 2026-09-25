'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runAgentLoop, runHarness, createToolRegistry, isHarnessV2Enabled, createHarnessEventBridge } = require('../src/services/harness');
const { HarnessProviderError } = require('../src/services/harness/errors');
const { createAgentEventStream } = require('../src/services/agent-harness/event-stream');
const { sseResponse, createFetchMock } = require('./helpers/harness-sse');

function scripted(turns) {
  const requests = [];
  return {
    name: 'fake', provider: 'Fake', requests,
    appendOnlyHistory: () => false,
    async streamTurn(args) {
      requests.push({ ...args, messages: JSON.parse(JSON.stringify(args.messages)) });
      const next = turns.shift();
      if (!next) throw new Error('no more scripted turns');
      if (typeof next === 'function') return next(args);
      for (const b of next.content) {
        if (b.type === 'text') args.emit({ type: 'text_delta', text: b.text });
        if (b.type === 'tool_call') {
          args.emit({ type: 'tool_call_start', id: b.id, name: b.name });
          args.emit({ type: 'tool_call_end', id: b.id, name: b.name, input: b.input });
        }
      }
      return { stopReason: next.stopReason || (next.content.some((b) => b.type === 'tool_call') ? 'tool_use' : 'end_turn'), usage: { inputTokens: 10, outputTokens: 5 }, content: next.content };
    },
  };
}

const call = (id, name, input) => ({ type: 'tool_call', id, name, input });
const text = (t) => ({ type: 'text', text: t });

function calculatorTool(extra = {}) {
  return {
    name: 'calculator', description: 'Multiplica dos enteros',
    input_schema: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'], additionalProperties: false },
    run: ({ a, b }) => String(a * b),
    parallelSafe: true,
    ...extra,
  };
}

test('flag is OFF by default', () => {
  assert.equal(isHarnessV2Enabled({}), false);
  assert.equal(isHarnessV2Enabled({ SIRAGPT_HARNESS_V2: '1' }), true);
});

test('loop: parallel-safe tools run concurrently, results feed the next turn, final answer is plain text', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const slow = (name) => ({
    name, description: name, input_schema: { type: 'object', properties: {} }, parallelSafe: true,
    run: async () => { inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 30)); inFlight -= 1; return { content: `${name}-ok` }; },
  });
  const adapter = scripted([
    { content: [text('Consulto dos cosas.'), call('c1', 'alpha', {}), call('c2', 'beta', {})] },
    { content: [text('Listo: alpha-ok y beta-ok.')] },
  ]);
  const events = [];
  const out = await runAgentLoop({ adapter, model: 'm', system: 'S', messages: [{ role: 'user', content: 'hazlo' }], tools: [slow('alpha'), slow('beta')], onEvent: (e) => events.push(e) });
  assert.equal(out.stopReason, 'end_turn');
  assert.equal(out.finalText, 'Listo: alpha-ok y beta-ok.');
  assert.equal(maxInFlight, 2, 'independent calls ran in parallel');
  assert.equal(out.steps, 2);
  assert.equal(out.toolCalls, 2);
  assert.deepEqual(out.newMessages.map((m) => m.role), ['assistant', 'tool', 'assistant']);
  const toolMsg = adapter.requests[1].messages[2];
  assert.deepEqual(toolMsg.content.map((b) => [b.toolCallId, b.content, b.isError]), [['c1', 'alpha-ok', false], ['c2', 'beta-ok', false]]);
  assert.deepEqual(events.filter((e) => e.type === 'tool_result').map((e) => e.name).sort(), ['alpha', 'beta']);
  assert.equal(events.at(-1).type, 'done');
  assert.equal(out.usage.inputTokens, 20);
});

test('loop: schema violation comes back as an error result and the model self-corrects', async () => {
  const adapter = scripted([
    { content: [call('c1', 'calculator', { a: 17 })] },
    { content: [call('c2', 'calculator', { a: 17, b: 23 })] },
    { content: [text('17 × 23 = 391')] },
  ]);
  const out = await runAgentLoop({ adapter, model: 'm', messages: [{ role: 'user', content: '17*23' }], tools: [calculatorTool()] });
  assert.equal(out.finalText, '17 × 23 = 391');
  const firstResult = out.newMessages[1].content[0];
  assert.equal(firstResult.isError, true);
  assert.match(firstResult.content, /falta el campo obligatorio "b"/);
  assert.equal(out.newMessages[3].content[0].content, '391');
});

test('loop: unknown tool, invalid JSON args and a thrown error are all model-readable', async () => {
  const adapter = scripted([
    { content: [call('c1', 'nope', {}), { type: 'tool_call', id: 'c2', name: 'calculator', input: {}, parseError: 'Unexpected token' }, call('c3', 'boom', {})] },
    { content: [text('ok')] },
  ]);
  const boom = { name: 'boom', description: 'x', input_schema: { type: 'object' }, run: () => { throw new Error('se rompió'); } };
  const out = await runAgentLoop({ adapter, model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [calculatorTool(), boom] });
  const [r1, r2, r3] = out.newMessages[1].content;
  assert.match(r1.content, /no existe.*calculator, boom/);
  assert.match(r2.content, /no son JSON válido/);
  assert.match(r3.content, /se rompió/);
  assert.ok([r1, r2, r3].every((r) => r.isError));
});

test('loop: 429 / overloaded are retried with backoff and Retry-After; 400 is not', async () => {
  const delays = [];
  const adapter = scripted([
    () => { throw new HarnessProviderError('HTTP 429', { status: 429, retryAfterMs: 1500 }); },
    () => { throw new HarnessProviderError('overloaded', { status: 529 }); },
    { content: [text('bien')] },
  ]);
  const events = [];
  const out = await runAgentLoop({ adapter, model: 'm', messages: [{ role: 'user', content: 'x' }], sleep: async (ms) => { delays.push(ms); }, onEvent: (e) => events.push(e) });
  assert.equal(out.stopReason, 'end_turn');
  assert.equal(out.finalText, 'bien');
  assert.equal(delays[0], 1500, 'Retry-After honoured');
  assert.ok(delays[1] >= 600 && delays[1] <= 1200, `jittered exponential backoff, got ${delays[1]}`);
  assert.equal(events.filter((e) => e.type === 'error' && e.retrying).length, 2);

  const bad = scripted([() => { throw new HarnessProviderError('HTTP 400 bad', { status: 400 }); }]);
  const failed = await runAgentLoop({ adapter: bad, model: 'm', messages: [{ role: 'user', content: 'x' }], sleep: async () => { throw new Error('must not sleep'); } });
  assert.equal(failed.stopReason, 'error');
  assert.equal(failed.error.status, 400);
  assert.equal(bad.requests.length, 1);
});

test('loop: a turn that dropped mid-stream emits turn_reset before retrying', async () => {
  const adapter = scripted([
    (args) => { args.emit({ type: 'text_delta', text: 'Hola, est' }); const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; },
    { content: [text('Hola, este es el texto completo.')] },
  ]);
  const events = [];
  const out = await runAgentLoop({ adapter, model: 'm', messages: [{ role: 'user', content: 'x' }], sleep: async () => {}, onEvent: (e) => events.push(e) });
  assert.equal(out.finalText, 'Hola, este es el texto completo.');
  const idxReset = events.findIndex((e) => e.type === 'turn_reset');
  assert.ok(idxReset > 0);
  assert.equal(events.slice(0, idxReset).filter((e) => e.type === 'text_delta').length, 1);
});

test('loop: abort during a tool keeps the transcript valid and stops as aborted', async () => {
  const controller = new AbortController();
  const adapter = scripted([{ content: [call('c1', 'wait', {})] }]);
  const wait = { name: 'wait', description: 'w', input_schema: { type: 'object' }, run: (_, ctx) => new Promise((resolve, reject) => { ctx.signal.addEventListener('abort', () => reject(new Error('cancel'))); setTimeout(() => controller.abort(), 10); }) };
  const out = await runAgentLoop({ adapter, model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [wait], signal: controller.signal });
  assert.equal(out.stopReason, 'aborted');
  const last = out.messages.at(-1);
  if (last.role === 'tool') assert.equal(last.content[0].toolCallId, 'c1');
});

test('loop: max steps forces a final no-tools turn and never leaves an unanswered tool call', async () => {
  const always = (args) => {
    if (args.toolChoice === 'none') return { content: [text('Resumen con lo que tengo.'), call('zz', 'calculator', { a: 1, b: 1 })], stopReason: 'tool_use', usage: {} };
    return { content: [call(`c${Math.random()}`, 'calculator', { a: 2, b: 3 })], stopReason: 'tool_use', usage: {} };
  };
  const adapter = scripted([always, always, always]);
  const out = await runAgentLoop({ adapter, model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [calculatorTool()], maxSteps: 2 });
  assert.equal(out.stopReason, 'max_steps');
  assert.equal(out.finalText, 'Resumen con lo que tengo.');
  assert.equal(adapter.requests.at(-1).toolChoice, 'none');
  assert.match(JSON.stringify(adapter.requests.at(-1).messages.at(-1)), /límite de pasos/);
  assert.ok(!out.messages.at(-1).content.some((b) => b.type === 'tool_call'));
});

test('loop: non-parallel-safe tools run one at a time in order', async () => {
  const order = [];
  const seqTool = (name) => ({ name, description: name, input_schema: { type: 'object' }, run: async () => { order.push(`start:${name}`); await new Promise((r) => setTimeout(r, 5)); order.push(`end:${name}`); return name; } });
  const adapter = scripted([{ content: [call('1', 'w1', {}), call('2', 'w2', {})] }, { content: [text('fin')] }]);
  await runAgentLoop({ adapter, model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [seqTool('w1'), seqTool('w2')] });
  assert.deepEqual(order, ['start:w1', 'end:w1', 'start:w2', 'end:w2']);
});

test('registry: per-tool timeout returns an error result', async () => {
  const registry = createToolRegistry([{ name: 'slow', description: 's', input_schema: { type: 'object' }, timeoutMs: 20, run: () => new Promise(() => {}) }]);
  const res = await registry.execute({ id: 'x', name: 'slow', input: {} });
  assert.equal(res.isError, true);
  assert.match(res.content, /no respondió en/);
});

test('bridge: harness events drive the existing AgentTrace SSE protocol', async () => {
  const frames = [];
  const es = createAgentEventStream({ write: (f) => frames.push(f) });
  const texts = [];
  const bridge = createHarnessEventBridge(es, { onText: (t) => texts.push(t) });
  const adapter = scripted([
    { content: [call('c1', 'calculator', { a: 17, b: 23 })] },
    { content: [text('Es 391.')] },
  ]);
  await runAgentLoop({ adapter, model: 'm', messages: [{ role: 'user', content: '17*23' }], tools: [calculatorTool()], onEvent: bridge.handle });
  assert.deepEqual(frames.map((f) => f.type), ['tool_call_start', 'tool_result', 'agent_done']);
  assert.equal(frames[1].preview, '"391"');
  assert.equal(frames[2].toolCalls, 1);
  assert.equal(texts.join(''), 'Es 391.');
  assert.equal(bridge.run.steps[0].toolName, 'calculator');
});

test('end-to-end: runHarness over the real openai-chat adapter with a mocked provider', async () => {
  const { fetchImpl, calls } = createFetchMock([
    sseResponse([{ data: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'calculator', arguments: '{"a":17,"b":23}' } }] }, finish_reason: 'tool_calls' }] } }, '[DONE]']),
    sseResponse([{ data: { choices: [{ delta: { content: 'El resultado es ' } }] } }, { data: { choices: [{ delta: { content: '391.' }, finish_reason: 'stop' }] } }, '[DONE]']),
  ]);
  const out = await runHarness({
    provider: 'xAI', model: 'grok-4.6', env: { XAI_API_KEY: 'x' }, fetchImpl,
    system: 'S', messages: [{ role: 'user', content: '17*23?' }], tools: [calculatorTool()],
  });
  assert.equal(out.finalText, 'El resultado es 391.');
  assert.equal(out.toolMode, 'native');
  const second = calls[1].body.messages;
  assert.deepEqual(second.map((m) => m.role), ['system', 'user', 'assistant', 'tool']);
  assert.equal(second[3].tool_call_id, 'call_1');
  assert.equal(second[3].content, '391');
});

test('end-to-end: prompted mode on a model without native tools', async () => {
  const { fetchImpl, calls } = createFetchMock([
    sseResponse([{ data: { choices: [{ delta: { content: 'Calculo.\n<tool_call>{"name": "calculator", "arg' } }] } }, { data: { choices: [{ delta: { content: 'uments": {"a": 17, "b": 23}}</tool_call>\n<tool_result>391</tool_result> inventado' } }] } }, '[DONE]']),
    sseResponse([{ data: { choices: [{ delta: { content: 'Son 391.' }, finish_reason: 'stop' }] } }, '[DONE]']),
  ]);
  const events = [];
  const out = await runHarness({
    provider: 'Groq', model: 'mystery-model-7b', env: { GROQ_API_KEY: 'q' }, fetchImpl,
    messages: [{ role: 'user', content: '17*23?' }], tools: [calculatorTool()], onEvent: (e) => events.push(e),
  });
  assert.equal(out.toolMode, 'prompted');
  assert.equal(out.finalText, 'Son 391.');
  assert.equal(calls[0].body.tools, undefined, 'no native tools param');
  assert.match(calls[0].body.messages[0].content, /"required":\["a","b"\]/, 'full schema in the prompt');
  const shown = events.filter((e) => e.type === 'text_delta').map((e) => e.text).join('');
  assert.ok(!shown.includes('<tool_call') && !shown.includes('inventado'));
  const replay = calls[1].body.messages;
  assert.match(replay[2].content, /<tool_call>\{"name":"calculator"/);
  assert.match(replay[3].content, /<tool_result id="ptc_[^"]+" name="calculator" status="ok">\n391\n<\/tool_result>/);
});

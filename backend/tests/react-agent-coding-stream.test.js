'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const agent = require('../src/services/react-agent');
const { codingOutputFields, collectCodingResponse, CODING_OUTPUT_TOKENS } = require('../src/services/codex/coding-model-response');

function toolChunks(name, args, { finish = 'tool_calls', id = 'call-1' } = {}) {
  const encoded = JSON.stringify(args);
  return [
    { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: encoded.slice(0, 8) } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: encoded.slice(8) } }] } }] },
    ...(finish ? [{ choices: [{ delta: {}, finish_reason: finish }] }] : []),
  ];
}
async function* stream(chunks) { yield* chunks; }
function setup(script) {
  const requests = [];
  const writes = [];
  let calls = 0;
  const client = { chat: { completions: { create: async (payload, options) => {
    requests.push(payload);
    return script(calls++, payload, options);
  } } } };
  const tools = [{ name: 'project_write', description: 'Write a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }, execute: async (args) => { writes.push(args); return { ok: true }; } }];
  return { client, requests, writes, tools };
}
const opts = { query: 'Create a bicycle web app', model: 'grok-4.7', maxSteps: 5, maxRuntimeMs: 2000, ctx: { provider: 'xAI', codingWorkspace: { projectId: 'p1' } } };

test('coding assembles fragmented args, writes only complete response, and keeps selected model and output limit', async () => {
  const f = setup((i) => stream(i === 0 ? toolChunks('project_write', { path: 'src/App.tsx', content: 'Bicicletas 🚲' }) : toolChunks('finalize', { answer: 'Build verified' }, { id: 'final' })));
  const result = await agent.run(f.client, { ...opts, tools: f.tools });
  assert.equal(result.stoppedReason, 'finalized');
  assert.deepEqual(f.writes, [{ path: 'src/App.tsx', content: 'Bicicletas 🚲' }]);
  assert.ok(f.requests.every((r) => r.model === 'grok-4.7' && r.stream === true && r.max_tokens === CODING_OUTPUT_TOKENS));
  assert.deepEqual(f.requests[0].stream_options, { include_usage: true });
});

test('length cutoff executes no partial or complete-looking mutation and next bounded step splits the change', async () => {
  const f = setup((i) => stream(i === 0
    ? toolChunks('project_write', { path: 'huge.tsx', content: 'must not write' }, { finish: 'length' })
    : i === 1 ? toolChunks('project_write', { path: 'small.tsx', content: 'small component' }, { id: 'small' })
      : toolChunks('finalize', { answer: 'Verified' }, { id: 'done' })));
  const result = await agent.run(f.client, { ...opts, tools: f.tools });
  assert.equal(result.stoppedReason, 'finalized');
  assert.deepEqual(f.writes, [{ path: 'small.tsx', content: 'small component' }]);
  assert.equal(result.steps.length, 3, 'truncated output consumes a model step');
  assert.ok(f.requests[1].messages.some((m) => /NO se ejecutó ninguna herramienta/.test(m.content || '')));
  assert.ok(!f.requests[1].messages.some((m) => m.role === 'assistant' && JSON.stringify(m).includes('huge.tsx')));
});

test('EOF without a terminal frame never executes a complete-looking write', async () => {
  const f = setup(() => stream(toolChunks('project_write', { path: 'x.js', content: 'partial' }, { finish: null })));
  const result = await agent.run(f.client, { ...opts, tools: f.tools });
  assert.match(result.stoppedReason, /^model_error: coding_response_incomplete/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.requests.length, 1, 'no hidden retry');
});

test('cancellation midstream never writes or switches provider', async () => {
  const controller = new AbortController();
  const f = setup(() => (async function* () {
    const chunks = toolChunks('project_write', { path: 'x.js', content: 'partial' });
    yield chunks[0];
    controller.abort();
    yield chunks[1];
  }()));
  const result = await agent.run(f.client, { ...opts, tools: f.tools, ctx: { ...opts.ctx, signal: controller.signal } });
  assert.match(result.stoppedReason, /aborted/i);
  assert.equal(f.writes.length, 0);
  assert.equal(f.requests.length, 1);
});

test('stream remains under the existing absolute per-step timeout even after receiving a delta', async () => {
  const previous = process.env.REACT_STEP_TIMEOUT_MS;
  process.env.REACT_STEP_TIMEOUT_MS = '15';
  try {
    const f = setup((_i, _payload, { signal }) => (async function* () {
      yield toolChunks('project_write', { path: 'x.js', content: 'partial' })[0];
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }()));
    const result = await agent.run(f.client, { ...opts, tools: f.tools });
    assert.equal(result.stoppedReason, 'model_error: step_timeout_15ms');
    assert.equal(f.writes.length, 0);
    assert.equal(f.requests.length, 1);
  } finally {
    if (previous === undefined) delete process.env.REACT_STEP_TIMEOUT_MS;
    else process.env.REACT_STEP_TIMEOUT_MS = previous;
  }
});

test('ordinary native turns retain their existing non-streaming transport and output fields', async () => {
  const f = setup(() => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'done', type: 'function', function: { name: 'finalize', arguments: JSON.stringify({ answer: 'OK' }) } }] } }] }));
  const result = await agent.run(f.client, { ...opts, tools: [], ctx: { provider: 'xAI' } });
  assert.equal(result.stoppedReason, 'finalized');
  assert.equal(f.requests[0].stream, undefined);
  assert.equal(f.requests[0].max_tokens, undefined);
});

test('Claude explicit high effort keeps identical transport and budgets in coding and ordinary turns', async () => {
  const request = () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }] });
  const ordinary = setup(request);
  const coding = setup(request);
  const common = { ...opts, model: 'claude-3-7-sonnet', tools: [], thinkingLevel: 'high', thinkingLevelExplicit: true };
  await agent.run(ordinary.client, { ...common, ctx: { provider: 'Anthropic' } });
  await agent.run(coding.client, { ...common, ctx: { ...opts.ctx, provider: 'Anthropic' } });
  const fields = (r) => ({ stream: r.stream, max_tokens: r.max_tokens, thinking: r.thinking, output_config: r.output_config });
  assert.deepEqual(fields(coding.requests[0]), fields(ordinary.requests[0]));
  assert.equal(coding.requests[0].stream, undefined);
  assert.notEqual(coding.requests[0].max_tokens, 4096);
  assert.deepEqual(codingOutputFields('xAI', 'grok-4.7'), { max_tokens: 4096 });
});

test('collector reports only first-delta timing; reasoning and arguments are not sent to progress hooks', async () => {
  let observed = null;
  const out = await collectCodingResponse(stream([
    { choices: [{ delta: { reasoning_content: 'private provider reasoning' } }] },
    ...toolChunks('finalize', { answer: 'OK' }),
    { usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }, choices: [] },
  ]), { onFirstDelta: (...args) => { assert.equal(observed, null); observed = args; } });
  assert.deepEqual(observed, []);
  assert.equal(out.usage.total_tokens, 17);
  assert.equal(out.choices[0].message.reasoning_content, 'private provider reasoning');
});


test('provider filtering and malformed completed JSON never dispatch a write', async () => {
  for (const response of [
    toolChunks('project_write', { path: 'x.js', content: 'not accepted' }, { finish: 'content_filter' }),
    [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'bad', function: { name: 'project_write', arguments: '{"path":"x.js"' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ],
  ]) {
    const f = setup(() => stream(response));
    const result = await agent.run(f.client, { ...opts, tools: f.tools });
    assert.match(result.stoppedReason, /^model_error: coding_response_/);
    assert.equal(f.writes.length, 0);
    assert.equal(f.requests.length, 1);
  }
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const reactAgent = require('../src/services/react-agent');

function tool(name, execute) {
  return { name, description: name, parameters: { type: 'object', additionalProperties: true }, execute };
}

function scripted(entries) {
  let index = 0;
  return { chat: { completions: { create: async (params) => {
    const entry = params.tool_choice?.function?.name === 'finalize'
      ? { name: 'finalize', args: { answer: 'No pude completar la operación solicitada.' } }
      : entries[index++] || { name: 'finalize', args: { answer: 'Final.' } };
    return { choices: [{ message: {
      role: 'assistant', content: 'Procesando.', tool_calls: [{
        id: `call_${index}`, type: 'function',
        function: { name: entry.name, arguments: JSON.stringify(entry.args || {}) },
      }],
    } }] };
  } } } };
}

for (const [shape, failed] of [
  ['error', { error: 'missing_user_context', details: { preserved: true } }],
  ['ok_false', { ok: false, code: 'E_PARAMS', details: { preserved: true } }],
  ['mcp_error', { isError: true, content: [{ type: 'text', text: 'No disponible' }] }],
]) {
  test(`reported ${shape} failure exhausts a tool instead of counting as progress`, async () => {
    let calls = 0;
    const broken = tool('document_edit', async () => { calls++; return failed; });
    const result = await reactAgent.run(scripted(Array.from({ length: 7 }, () => ({ name: broken.name }))), {
      query: 'Editar un documento', tools: [broken], model: 'test-model', maxSteps: 12,
    });
    assert.equal(calls, 5, 'repeated terminal failures must reach the existing five-error cap');
    assert.ok(result.exhaustedTools.includes(broken.name));
    const first = result.steps[0].actions[0].observation;
    assert.ok(first.error, 'the trace must report failure');
    for (const [key, value] of Object.entries(failed)) assert.deepEqual(first[key], value);
    assert.ok(result.finalAnswer);
  });
}

test('an ok:false read is not cached as success and a corrected attempt can run', async () => {
  let calls = 0;
  const read = tool('read_url', async () => ++calls === 1
    ? { ok: false, code: 'E_PARAMS' }
    : { ok: true, content: 'Recovered content' });
  const result = await reactAgent.run(scripted([{ name: read.name }, { name: read.name }]), {
    query: 'Leer una página', tools: [read], model: 'test-model', maxSteps: 5,
  });
  assert.equal(calls, 2);
  assert.equal(result.steps[1].actions[0].observation.content, 'Recovered content');
  assert.deepEqual(result.exhaustedTools, []);
});

test('a fallback returning failure is not recorded as recovered', async () => {
  const result = await reactAgent.run(scripted([{ name: 'read_url' }]), {
    query: 'Leer una página', model: 'test-model', maxSteps: 4,
    tools: [
      tool('read_url', async () => { throw new Error('transport unavailable'); }),
      tool('web_extract', async () => ({ ok: false, error: 'content_denied' })),
    ],
  });
  const observation = result.steps[0].actions[0].observation;
  assert.match(observation.error, /transport unavailable/);
  assert.equal(observation._recovered_via, undefined);
});

test('reported denial does not automatically execute a different tool', async () => {
  let alternatives = 0;
  const result = await reactAgent.run(scripted([{ name: 'read_url' }]), {
    query: 'Leer una página', model: 'test-model', maxSteps: 4,
    tools: [
      tool('read_url', async () => ({ ok: false, error: 'permission_denied' })),
      tool('web_extract', async () => { alternatives++; return { ok: true }; }),
    ],
  });
  assert.equal(alternatives, 0);
  assert.equal(result.steps[0].actions[0].observation.error, 'permission_denied');
});

test('success, empty output and nested error fields remain valid data', async () => {
  const values = [{ ok: true }, undefined, { record: { error: 'sample text' } }, ['error'], { error: null }];
  let calls = 0;
  const result = await reactAgent.run(scripted(values.map(() => ({ name: 'inspect_document' }))), {
    query: 'Inspeccionar', model: 'test-model', maxSteps: 9,
    tools: [tool('inspect_document', async () => values[calls++])],
  });
  assert.equal(calls, values.length);
  assert.deepEqual(result.exhaustedTools, []);
  for (let i = 0; i < values.length; i++) assert.deepEqual(result.steps[i].actions[0].observation, values[i]);
});

test('reported failures do not reset the consecutive finalization guard', async () => {
  let guards = 0;
  let calls = 0;
  const entries = Array.from({ length: 4 }, () => [
    { name: 'finalize', args: { answer: 'Propuesta no verificada.' } },
    { name: 'document_edit' },
  ]).flat();
  const result = await reactAgent.run(scripted(entries), {
    query: 'Editar', model: 'test-model', maxSteps: 16,
    tools: [tool('document_edit', async () => { calls++; return { ok: false, error: 'missing_source' }; })],
    finalizeGuard: () => { guards++; return { ok: false, message: 'Sin evidencia' }; },
  });
  assert.equal(guards, 3, 'failed tools are not progress between rejected finalizations');
  assert.equal(calls, 2);
  assert.match(result.stoppedReason, /^finalized_guard_breaker:/);
});

test('genuine success resets the error budget between independent failure streaks', async () => {
  let calls = 0;
  const result = await reactAgent.run(scripted(Array.from({ length: 9 }, () => ({ name: 'document_edit' }))), {
    query: 'Editar', model: 'test-model', maxSteps: 13,
    tools: [tool('document_edit', async () => ++calls === 5 ? { ok: true } : { ok: false, error: 'missing_source' })],
  });
  assert.equal(calls, 9);
  assert.deepEqual(result.exhaustedTools, []);
});

test('parallel MCP failures remain distinct from a successful peer and are not cached', async () => {
  let deniedCalls = 0;
  const requests = [];
  let step = 0;
  const openai = { chat: { completions: { create: async params => {
    requests.push(structuredClone(params.messages));
    const names = ++step <= 2 ? ['web_search', 'read_url'] : ['finalize'];
    return { choices: [{ message: { role: 'assistant', content: null, tool_calls: names.map((name, index) => ({
      id: `parallel_${step}_${index}`, type: 'function',
      function: { name, arguments: JSON.stringify(name === 'finalize' ? { answer: 'Parcial.' } : {}) },
    })) } }] };
  } } } };
  const result = await reactAgent.run(openai, {
    query: 'Leer', model: 'test-model', maxSteps: 5,
    tools: [
      tool('web_search', async () => { deniedCalls++; return { isError: true, content: [] }; }),
      tool('read_url', async () => ({ ok: true, content: 'Evidence' })),
    ],
  });
  assert.equal(deniedCalls, 2);
  assert.equal(result.steps[0].actions[0].observation.isError, true);
  assert.equal(result.steps[0].actions[0].observation.error, 'tool_reported_failure');
  assert.equal(result.steps[0].actions[1].observation.content, 'Evidence');
  assert.equal(JSON.parse(requests[1].find(message => message.tool_call_id === 'parallel_1_0').content).isError, true);
});

for (const details of [
  { message: 'request timed out' },
  { reason: 'rate limit exceeded' },
  { status: 503 },
]) {
  test(`reported transient failure keeps its original classification: ${JSON.stringify(details)}`, async () => {
    let calls = 0;
    const result = await reactAgent.run(scripted(Array.from({ length: 7 }, () => ({ name: 'document_edit' }))), {
      query: 'Editar', model: 'test-model', maxSteps: 10,
      tools: [tool('document_edit', async () => { calls++; return { ok: false, ...details }; })],
    });
    assert.equal(calls, 7, 'seven explicit model calls do not exhaust the weighted transient budget');
    assert.deepEqual(result.exhaustedTools, []);
    assert.equal(result.steps[0].actions[0].observation.error, 'tool_reported_failure');
  });
}

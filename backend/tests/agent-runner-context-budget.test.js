"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runAgentLoop, resolveContextBudgetTokens, estimateRunnerContextTokens, compactMessagesInPlace } = require('../src/services/agent-runner/loop');
const { toStageEvent } = require('../src/services/agent-runner/trace');

function clientWith(check) {
  return { chat: { completions: { create: async (payload) => {
    check(payload);
    return { choices: [{ message: { role: 'assistant', content: 'He revisado los datos.' } }] };
  } } } };
}

test('context budget reserves the selected model output and tool schema', () => {
  assert.equal(resolveContextBudgetTokens({}, { model: 'sira-mini', maxTokens: 2048, tools: [] }), Math.floor(8192 * 0.8) - 2048);
  const tools = [{ type: 'function', function: { name: 'read_file', description: 'a'.repeat(4000) } }];
  assert.ok(resolveContextBudgetTokens({}, { model: 'sira-mini', maxTokens: 2048, tools }) < 3505);
  assert.equal(resolveContextBudgetTokens({}), 60000, 'legacy helper callers retain their explicit context-only budget');
});

test('context estimate includes tool arguments and image parts, without treating base64 as text', () => {
  const plain = estimateRunnerContextTokens([{ role: 'user', content: 'x' }]);
  const calls = estimateRunnerContextTokens([{ role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ content: 'z'.repeat(16000) }) } }] }]);
  assert.ok(calls > 4000);
  const vision = estimateRunnerContextTokens([{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(100000) } }] }]);
  assert.ok(vision > plain + 1000 && vision < plain + 2000);
});

test('model never receives a pinned request that exceeds its remaining context', async () => {
  let called = 0;
  const events = [];
  const request = 'Mantén todos estos datos: ' + 'dato '.repeat(10000);
  const messages = [{ role: 'system', content: 'Política.' }, { role: 'user', content: request }];
  const original = structuredClone(messages);
  const result = await runAgentLoop({
    client: clientWith(() => { called++; }), model: 'sira-mini', messages,
    tools: [], executors: {}, maxTokens: 2048, maxIterations: 1, onEvent: e => events.push(e),
  });
  assert.equal(called, 0);
  assert.equal(result.errorCode, 'E_PARAMS');
  assert.equal(result.stoppedReason, 'context_budget_exceeded');
  assert.match(result.errorMessage, /por partes|mayor contexto/);
  assert.deepEqual(messages, original, 'failed compaction retains the source transcript');
  assert.ok(events.some(e => e.type === 'error' && e.code === 'E_PARAMS' && e.retryable === false));
  assert.ok(!JSON.stringify(events).includes(request));
});

test('large tool history compacts within the model budget and announces progress before the call', async () => {
  const events = [];
  const request = 'Revisa los resultados, conserva las restricciones y resume.';
  const messages = [{ role: 'system', content: 'Política.' }, { role: 'user', content: request }];
  for (let i=0; i<12; i++) {
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'r'+i, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'tmp/'+i }) } }] });
    messages.push({ role: 'tool', tool_call_id: 'r'+i, content: 'dato '.repeat(2500) });
  }
  let called = 0;
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
  const result = await runAgentLoop({
    client: clientWith(payload => {
      called++;
      assert.ok(estimateRunnerContextTokens(payload.messages) <= resolveContextBudgetTokens({}, { model: 'sira-mini', maxTokens: 1024, tools }));
      assert.ok(payload.messages.some(m => m.content === request));
      const stages = events.map(toStageEvent).filter(Boolean);
      assert.ok(stages.some(e => e.label === 'Compactando contexto'));
      assert.ok(stages.some(e => e.label === 'Contexto compactado'));
    }), model: 'sira-mini', messages, tools, executors: {}, maxTokens: 1024,
    maxIterations: 1, onEvent: e => events.push(e),
  });
  assert.equal(called, 1);
  assert.equal(result.stoppedReason, 'final');
});


test('restored document map cannot push the request over budget silently', async (t) => {
  const prior = process.env.SIRAGPT_AGENT_RUNNER_CONTEXT_TOKENS;
  process.env.SIRAGPT_AGENT_RUNNER_CONTEXT_TOKENS = '8000';
  t.after(() => { if (prior === undefined) delete process.env.SIRAGPT_AGENT_RUNNER_CONTEXT_TOKENS; else process.env.SIRAGPT_AGENT_RUNNER_CONTEXT_TOKENS = prior; });
  let calls = 0;
  const map = JSON.stringify({ ok: true, paragraphs: [{ id: 1, text: 'Texto descriptivo de la celda. '.repeat(300) }] });
  const request = 'Cambia únicamente el primer párrafo y conserva el resto. ' + 'Instrucción detallada para esta edición. '.repeat(600);
  const messages = [{ role: 'system', content: 'Conserva la evidencia.' }, { role: 'user', content: request }];
  const client = { chat: { completions: { create: async () => {
    calls++;
    return { choices: [{ message: { tool_calls: [{ id: 'map', type: 'function', function: { name: 'inspect_document', arguments: '{"path":"uploads/report.docx"}' } }] } }] };
  } } } };
  const result = await runAgentLoop({ client, model: 'deepseek-v4-flash', messages,
    tools: require('../src/services/agent-runner/tools').buildToolDefinitions({ NODE_ENV: 'test' }),
    executors: { inspect_document: async () => map }, maxIterations: 3 });
  assert.equal(calls, 1, 'oversized pinned map must stop before the next provider request');
  assert.equal(result.errorCode, 'E_PARAMS');
  assert.ok(messages.some(m => m.content === request));
  assert.ok(messages.some(m => m.content === map), 'original inspection remains available after budget failure');
});


test('compaction preserves signed native blocks and counts their hidden reasoning', () => {
  const model = 'claude-sonnet-4-5';
  const native = [{ type: 'thinking', thinking: 'razonamiento '.repeat(1000), signature: 'synthetic-signature' }, { type: 'tool_use', id: 'last', name: 'read_file', input: { path: 'tmp/a' } }];
  const call = { role: 'assistant', content: '', tool_calls: [{ id: 'last', type: 'function', function: { name: 'read_file', arguments: '{"path":"tmp/a"}' } }] };
  Object.defineProperty(call, '_anthropicContent', { value: native, enumerable: false });
  Object.defineProperty(call, '_anthropicModel', { value: model, enumerable: false });
  const messages = [{ role: 'system', content: 'policy' }, { role: 'user', content: 'revisa' }, ...Array.from({ length: 20 }, () => ({ role: 'assistant', content: 'x'.repeat(5000) })), call, { role: 'tool', tool_call_id: 'last', content: 'resultado' }];
  compactMessagesInPlace(messages, { model, maxTokens: 1024, env: { SIRAGPT_AGENT_RUNNER_CONTEXT_TOKENS: '8000' }, pinned: { request: 'revisa' } });
  const retained = messages.find(m => m.tool_calls?.[0]?.id === 'last');
  assert.deepEqual(retained._anthropicContent, native);
  assert.equal(retained._anthropicModel, model);
  assert.ok(estimateRunnerContextTokens([retained], model) > 3000);
  assert.ok(estimateRunnerContextTokens(messages, model) <= 8000);
});

test('latest tool exchange stays protected even with a verification nudge after it', () => {
  const messages = [{ role: 'system', content: 'policy' }, { role: 'user', content: 'edita y verifica' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'edit', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ content: 'x'.repeat(30000) }) } }] },
    { role: 'tool', tool_call_id: 'edit', content: 'escritura terminada' },
    { role: 'user', content: 'Verifica antes de terminar.' }];
  const original = structuredClone(messages);
  assert.throws(() => compactMessagesInPlace(messages, { model: 'sira-mini', maxTokens: 1024, pinned: { request: 'edita y verifica' } }), error => error.reason === 'context_budget_exceeded');
  assert.deepEqual(messages, original);
});


test('candidate compaction cannot replace the latest tool result with an omitted-result marker', () => {
  const result = 'Resultado detallado único. '.repeat(1600);
  const messages = [{ role: 'system', content: 'policy' }, { role: 'user', content: 'Edita y verifica.' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"tmp/a"}' } }] },
    { role: 'tool', tool_call_id: 'read', content: result },
    { role: 'user', content: 'Verifica antes de terminar.' }];
  const original = structuredClone(messages);
  assert.throws(() => compactMessagesInPlace(messages, { model: 'sira-mini', maxTokens: 1024, pinned: { request: 'Edita y verifica.' } }), error => error.reason === 'context_budget_exceeded');
  assert.deepEqual(messages, original);
});


test('all three recent user turns survive the first compaction pass', () => {
  const messages = [
    { role: 'system', content: 'Política.' },
    { role: 'user', content: 'Solicitud base.' },
    { role: 'user', content: 'Datos primera revisión. '.repeat(550) },
    { role: 'user', content: 'Datos segunda revisión. '.repeat(550) },
    { role: 'user', content: 'Ahora entrega el resultado.' },
  ];
  const original = structuredClone(messages);
  assert.throws(() => compactMessagesInPlace(messages, { model: 'sira-mini', maxTokens: 1024, pinned: { request: 'Solicitud base.' } }), error => error.reason === 'context_budget_exceeded');
  assert.deepEqual(messages, original);
});

test('repeated verification text does not move an intact tool exchange earlier in the conversation', () => {
  const messages = [
    { role: 'system', content: 'Política.' },
    { role: 'user', content: 'Edita y verifica.' },
    { role: 'user', content: 'Verifica antes de terminar.' },
    { role: 'assistant', content: 'Primera comprobación.' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"tmp/a"}' } }] },
    { role: 'tool', tool_call_id: 'read', content: 'Resultado final.' },
    { role: 'user', content: 'Verifica antes de terminar.' },
  ];
  const original = structuredClone(messages);
  compactMessagesInPlace(messages, { model: 'deepseek-v4-flash', maxTokens: 1024, pinned: { request: 'Edita y verifica.' } });
  assert.deepEqual(messages, original);
});


test('query-overlap pruning cannot discard recent constraints before the budget check', async () => {
  const constraints = ['No modifiques márgenes ni encabezados.', 'Conserva tipografía e interlineado.'];
  const messages = [
    { role: 'system', content: 'Política.' },
    { role: 'user', content: 'Revisa el documento.' },
    ...constraints.map(content => ({ role: 'user', content })),
    ...Array.from({ length: 28 }, (_, i) => ({ role: 'assistant', content: 'Estado rutinario ' + i })),
    { role: 'user', content: 'Entrega ahora.' },
  ];
  let calls = 0;
  const result = await runAgentLoop({ client: clientWith(payload => {
    calls++;
    for (const constraint of constraints) assert.ok(payload.messages.some(m => m.role === 'user' && m.content === constraint));
  }), model: 'deepseek-v4-flash', messages, tools: [], executors: {}, maxIterations: 1 });
  assert.equal(result.stoppedReason, 'final');
  assert.equal(calls, 1);
});

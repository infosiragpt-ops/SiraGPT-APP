'use strict';

// «tool transcript repaired (N fixes: orphan_result×k …)» repeated on every
// iteration of long document turns. The repair itself was fine; the
// producers were not: the query-overlap prune and the token-budget
// compaction dropped an assistant tool_calls message but kept its results,
// and an early loop exit left calls unanswered in a transcript that the
// caller re-runs. The producers now keep call + results together and the
// loop seals its own transcript where it mutates it. Offline.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeToolTranscript,
  sealToolTranscriptInPlace,
  toolCallGroups,
} = require('../src/services/agent-runner/tool-transcript');
const w60 = require('../src/services/agent-runner/engine-3h60');
const adapter = require('../src/services/agent-runner/engine-adapter');
const { runAgentLoop } = require('../src/services/agent-runner/loop');

const REQUEST = 'Edita el informe trimestral de ventas docx y cambia el título a Resultados Q3';

function pyTranscript(iterations = 12) {
  const messages = [
    { role: 'system', content: 'You are the agent runner. Tools: execute_python' },
    { role: 'user', content: REQUEST },
  ];
  for (let i = 1; i <= iterations; i += 1) {
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `call_${i}`, type: 'function', function: { name: 'execute_python', arguments: '{"code":"print(1)"}' } }] });
    // Odd results echo the request (high overlap), even ones do not.
    messages.push({ role: 'tool', tool_call_id: `call_${i}`, content: i % 2 ? `informe trimestral ventas título Resultados Q3 paso ${i}` : `ok ${i}` });
  }
  return messages;
}

function captureConsole() {
  const out = { warn: [], debug: [] };
  const original = { warn: console.warn, debug: console.debug };
  console.warn = (...a) => out.warn.push(a.join(' '));
  console.debug = (...a) => out.debug.push(a.join(' '));
  return { out, restore: () => { console.warn = original.warn; console.debug = original.debug; } };
}

test('query-overlap prune keeps each tool call together with its result', () => {
  const messages = pyTranscript(12);
  assert.equal(messages.length, 26);
  const pruned = w60.pruneMessagesByQueryOverlap(messages, REQUEST, { keepLast: 4 });
  assert.ok(pruned.pruned > 0, 'low-overlap units are still pruned');
  assert.equal(normalizeToolTranscript(pruned.messages).repaired, 0);
  // The loop's exact sequence (prune → faithful summary → keep last user).
  let next = pruned.messages;
  next = w60.compactFaithfulDroppedSummary(messages, next).messages;
  next = w60.neverDropLastUserOnCompact(messages, next).messages;
  assert.equal(normalizeToolTranscript(next).repaired, 0);
});

test('prune: a unit is scored by its call arguments too, and keepLast never splits a unit', () => {
  const messages = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'renombra la hoja ventas trimestrales' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'rename_sheet', arguments: '{"name":"ventas trimestrales"}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'ok' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'b', type: 'function', function: { name: 'noop', arguments: '{}' } }, { id: 'c', type: 'function', function: { name: 'noop', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'b', content: 'x' },
    { role: 'tool', tool_call_id: 'c', content: 'y' },
  ];
  const out = w60.pruneMessagesByQueryOverlap(messages, 'renombra la hoja ventas trimestrales', { keepLast: 1 });
  assert.ok(out.messages.includes(messages[2]) && out.messages.includes(messages[3]), 'arguments overlap keeps the unit');
  assert.ok(out.messages.includes(messages[4]), 'the tail unit is kept whole even though keepLast=1 starts inside it');
  assert.equal(normalizeToolTranscript(out.messages).repaired, 0);
});

test('prune: messages without tool calls keep their previous behaviour', () => {
  const original = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'analiza el contrato de alquiler' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'resume las cláusulas de salida' },
  ];
  const pruned = w60.pruneMessagesByQueryOverlap(original, 'cláusulas de salida', { keepLast: 1, minOverlap: 0.99 });
  assert.deepEqual(pruned.messages.map((m) => m.content), ['rules', 'resume las cláusulas de salida']);
});

test('token-budget compaction drops a call and its results together', () => {
  const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'haz algo' }];
  for (let i = 1; i <= 8; i += 1) {
    msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
    msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: 'x '.repeat(20000) });
  }
  const packed = adapter.compactUntilTokenBudget(msgs, { remaining: 8000, keep: 6 });
  assert.ok(packed.rounds >= 1);
  assert.equal(packed.messages[0].role, 'system');
  assert.deepEqual(normalizeToolTranscript(packed.messages).kinds, {});
});

test('compactUntilTokenBudget keeps shortening when the only removable unit is the tail', () => {
  const big = 'x'.repeat(40_000);
  const calls = ['a', 'b', 'c'].map((id) => ({ id, type: 'function', function: { name: 'read_file', arguments: '{}' } }));
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: null, tool_calls: calls },
    ...calls.map((c) => ({ role: 'tool', tool_call_id: c.id, name: 'read_file', content: big })),
  ];
  const packed = adapter.compactUntilTokenBudget(msgs, { remaining: 2000, keep: 6 });
  assert.equal(packed.rounds, 6, 'every round ran; the tail unit did not stop the loop');
  assert.ok(packed.used < 12_000, `used ${packed.used}`);
  assert.equal(packed.messages.length, msgs.length, 'the call and its results stay together');
  assert.deepEqual(normalizeToolTranscript(packed.messages).kinds, {});
});

test('toolCallGroups returns call + results ranges (tool images inside the unit)', () => {
  const list = [
    { role: 'user', content: 'u' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a' }, { id: 'b' }] },
    { role: 'tool', tool_call_id: 'a', content: '1' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:' } }] },
    { role: 'tool', tool_call_id: 'b', content: '2' },
    { role: 'user', content: 'nudge' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'z' }] },
  ];
  assert.deepEqual(toolCallGroups(list), [{ start: 1, end: 4 }, { start: 6, end: 6 }]);
});

test('sealToolTranscriptInPlace repairs the array itself and keeps message identity', () => {
  const signed = { role: 'assistant', content: null, tool_calls: [{ id: 'k1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] };
  Object.defineProperty(signed, '_anthropicContent', { value: [{ type: 'thinking' }], enumerable: false });
  const messages = [
    { role: 'user', content: 'u' },
    { role: 'tool', tool_call_id: 'gone', name: 'execute_python', content: 'stdout' },
    signed,
  ];
  const sealed = sealToolTranscriptInPlace(messages, { missingResultText: 'no se ejecutó' });
  assert.equal(sealed.repaired, 2);
  assert.equal(messages[1].role, 'user', 'the orphan result became readable user text');
  assert.equal(messages[2], signed, 'kept messages are the same objects');
  assert.ok(Object.getOwnPropertyDescriptor(messages[2], '_anthropicContent'));
  assert.equal(messages[3].content, '[read_file] no se ejecutó');
  assert.equal(normalizeToolTranscript(messages).repaired, 0);
  assert.equal(sealToolTranscriptInPlace(messages).repaired, 0, 'idempotent');
});

test('a long tool turn never sends [TOOL_RESULT] text nor logs a transcript repair', async () => {
  const requests = [];
  let n = 0;
  const client = { chat: { completions: { create: async (payload) => {
    requests.push(payload.messages.map((m) => ({ role: m.role, content: m.content })));
    n += 1;
    if (n <= 14) {
      return { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{
        id: `call_${n}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `parte_${n}.txt` }) },
      }] } }] };
    }
    return { choices: [{ finish_reason: 'stop', message: { content: 'Listo, informe actualizado.' } }] };
  } } } };
  const messages = [
    { role: 'system', content: 'You are the agent runner.' },
    { role: 'user', content: REQUEST },
  ];
  let k = 0;
  const cap = captureConsole();
  let result;
  try {
    result = await runAgentLoop({
      client,
      model: 'deepseek-v4-flash',
      messages,
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
      executors: { read_file: async () => { k += 1; return k % 2 ? `informe trimestral ventas título Resultados Q3 paso ${k}` : `ok ${k}`; } },
      maxIterations: 20,
    });
  } finally {
    cap.restore();
  }
  assert.equal(result.stoppedReason, 'final');
  assert.ok(n >= 15, `model called ${n} times`);
  const leaked = requests.some((msgs) => msgs.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[TOOL_RESULT')));
  assert.equal(leaked, false, 'no call/result pair was split');
  const repairs = [...cap.out.warn, ...cap.out.debug].filter((l) => l.includes('tool transcript repaired'));
  assert.deepEqual(repairs, []);
});

test('an early exit leaves the transcript sealed for the next run on the same messages', async () => {
  let calls = 0;
  const client = { chat: { completions: { create: async () => {
    calls += 1;
    if (calls === 1) {
      return { choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [
        { id: 'a1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { id: 'a2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.txt"}' } },
      ] } }] };
    }
    return { choices: [{ finish_reason: 'stop', message: { content: 'Listo.' } }] };
  } } } };
  const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'lee los archivos' }];
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }];
  const first = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages,
    tools,
    // A transient transport error until the tool retries are exhausted.
    executors: { read_file: async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); } },
    maxIterations: 3,
  });
  assert.equal(first.stoppedReason, 'tool_retry_exhausted');
  assert.equal(normalizeToolTranscript(messages).repaired, 0, 'every call id is answered after the exit');
  const synthetic = messages.filter((m) => m.role === 'tool');
  assert.equal(synthetic.length, 2);
  for (const m of synthetic) {
    assert.equal(m.content, '[read_file] no se ejecutó: el turno se detuvo antes de esta herramienta');
  }

  const cap = captureConsole();
  try {
    const second = await runAgentLoop({ client, model: 'deepseek-v4-flash', messages, tools, executors: {}, maxIterations: 2 });
    assert.equal(second.finalText, 'Listo.');
  } finally {
    cap.restore();
  }
  assert.deepEqual([...cap.out.warn, ...cap.out.debug].filter((l) => l.includes('tool transcript repaired')), []);
});

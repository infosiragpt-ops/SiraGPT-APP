'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createToolCallStreamParser, toolsPrompt, interpretCall } = require('../src/services/harness/adapters/prompted-xml');
const { fitToContext, estimateTextTokens } = require('../src/services/harness/token-budget');

function run(chunks) {
  const shown = [];
  const calls = [];
  const p = createToolCallStreamParser({ onText: (t) => shown.push(t), onCall: (c) => calls.push(c) });
  for (const c of chunks) p.feed(c);
  const segments = p.end();
  return { shown: shown.join(''), calls, segments, stopped: p.stopped };
}

function strip(segments) {
  return segments.map((s) => (s.type === 'text' ? { type: 'text', text: s.text } : { type: 'tool_call', name: s.name, input: s.input, err: Boolean(s.parseError) }));
}

const STREAM = 'Primero busco. <tool_call>{"name": "web_search", "arguments": {"query": "dólar hoy <Perú>", "filters": {"days": 1, "sites": ["a.pe", "b.pe"]}}}</tool_call>\n<tool_call>\n```json\n{"name": "calculator", "arguments": {"a": 3, "b": 4,}}\n```\n</tool_call> Espero los resultados.';

test('prompted parser: text outside tags streams, tags never leak, fences and trailing commas tolerated', () => {
  const out = run([STREAM]);
  assert.equal(out.shown, 'Primero busco. \n Espero los resultados.');
  assert.deepEqual(strip(out.segments), [
    { type: 'text', text: 'Primero busco. ' },
    { type: 'tool_call', name: 'web_search', input: { query: 'dólar hoy <Perú>', filters: { days: 1, sites: ['a.pe', 'b.pe'] } }, err: false },
    { type: 'text', text: '\n' },
    { type: 'tool_call', name: 'calculator', input: { a: 3, b: 4 }, err: false },
    { type: 'text', text: ' Espero los resultados.' },
  ]);
});

test('prompted parser fuzz: any chunking of the stream yields identical segments', () => {
  const expected = JSON.stringify(strip(run([STREAM]).segments));
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 300; i += 1) {
    const chunks = [];
    let pos = 0;
    while (pos < STREAM.length) {
      const size = 1 + Math.floor(rand() * (i % 3 === 0 ? 3 : 25));
      chunks.push(STREAM.slice(pos, pos + size));
      pos += size;
    }
    const got = run(chunks);
    assert.equal(JSON.stringify(strip(got.segments)), expected, `chunking #${i} diverged`);
    assert.ok(!got.shown.includes('<tool_'), `chunking #${i} leaked a tag`);
  }
});

test('prompted parser: hallucinated <tool_result> cuts the stream; incomplete call reported', () => {
  const cut = run(['ok <tool_call>{"name":"a","arguments":{}}</tool_call>\n<tool_res', 'ult>fake</tool_result> más texto']);
  assert.equal(cut.stopped, true);
  assert.equal(cut.calls.length, 1);
  assert.ok(!cut.shown.includes('fake') && !cut.shown.includes('más texto'));

  const incomplete = run(['<tool_call>{"name":"a","arguments":{"x": 1']);
  assert.equal(incomplete.calls.length, 1);
  assert.match(incomplete.calls[0].parseError, /incompleta/);

  const lookalike = run(['a < b y <tool es texto <tool_callx no']);
  assert.equal(lookalike.calls.length, 0);
  assert.equal(lookalike.shown, 'a < b y <tool es texto <tool_callx no');
});

test('prompted parser: attribute form, string arguments, bad shapes', () => {
  assert.deepEqual(interpretCall(' name="calc"', '{"a":1}'), { name: 'calc', input: { a: 1 } });
  assert.deepEqual(interpretCall('', '{"name":"calc","arguments":"{\\"a\\":2}"}'), { name: 'calc', input: { a: 2 } });
  assert.ok(interpretCall('', '[1,2]').parseError);
  assert.ok(interpretCall('', '{nope').parseError);
});

test('tools prompt carries FULL schemas (enums, nested, required)', () => {
  const prompt = toolsPrompt([{ name: 'search', description: 'Busca', input_schema: { type: 'object', properties: { mode: { type: 'string', enum: ['fast', 'deep'] }, filters: { type: 'object', properties: { days: { type: 'integer', minimum: 1 } } } }, required: ['mode'] } }]);
  assert.match(prompt, /"enum":\["fast","deep"\]/);
  assert.match(prompt, /"days":\{"type":"integer","minimum":1\}/);
  assert.match(prompt, /"required":\["mode"\]/);
});

// ── token budget ────────────────────────────────────────────────────────────

function round(i, resultChars) {
  return [
    { role: 'user', content: `pregunta ${i}` },
    { role: 'assistant', content: [{ type: 'tool_call', id: `c${i}`, name: 't', input: {} }] },
    { role: 'tool', content: [{ type: 'tool_result', toolCallId: `c${i}`, name: 't', content: 'x'.repeat(resultChars) }] },
    { role: 'assistant', content: [{ type: 'text', text: `respuesta ${i}` }] },
  ];
}

test('fitToContext: within budget is a no-op', () => {
  const messages = round(1, 100);
  const out = fitToContext({ messages, contextWindow: 100_000 });
  assert.equal(out.trimmed, false);
  assert.equal(out.messages, messages);
});

test('fitToContext: clears oldest tool results first, keeps the newest intact', () => {
  const messages = [...round(1, 30_000), ...round(2, 30_000), ...round(3, 30_000)];
  const out = fitToContext({ messages, contextWindow: 20_000, reserveOutput: 1_000, keepRecentToolResults: 1 });
  assert.ok(out.actions.includes('clear_tool_result'));
  assert.match(out.messages[2].content[0].content, /omitido para ahorrar contexto/);
  assert.equal(out.messages.at(-2).content[0].content.length, 30_000, 'newest result untouched');
  assert.equal(messages[2].content[0].content.length, 30_000, 'input not mutated');
  assert.equal(out.overflow, false);
});

test('fitToContext: drops leading rounds, then caps; append-only models are never edited', () => {
  const messages = [...round(1, 5_000), ...round(2, 5_000), ...round(3, 60_000)];
  const out = fitToContext({ messages, contextWindow: 12_000, reserveOutput: 500, keepRecentToolResults: 5 });
  assert.ok(out.actions.includes('drop_round'));
  assert.equal(out.messages[0].content, 'pregunta 3');
  assert.ok(out.actions.includes('cap_tool_result'));
  assert.ok(out.tokens <= out.budget);

  const frozen = fitToContext({ messages, contextWindow: 12_000, appendOnly: true });
  assert.equal(frozen.overflow, true);
  assert.equal(frozen.messages, messages);
  assert.ok(estimateTextTokens('abcdefg') >= 2);
});

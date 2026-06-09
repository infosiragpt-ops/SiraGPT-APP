'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPromptedToolsBlock,
  parsePromptedToolCalls,
  hasPromptedToolCalls,
  toPromptedTranscript,
  capToolsForPrompted,
  describeSchema,
  extractBareJsonObjects,
  PROMPTED_MAX_TOOLS_DEFAULT,
} = require('../src/services/agents/prompted-tool-calling');

const REGISTRY = [
  {
    name: 'web_search',
    description: 'Free-text web search; returns ranked snippets.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        maxResults: { type: 'integer' },
      },
      required: ['query'],
    },
  },
  {
    name: 'finalize',
    description: 'Emit the final answer and stop.',
    parameters: {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    },
  },
];

test('buildPromptedToolsBlock describes the protocol, every tool and a worked example', () => {
  const block = buildPromptedToolsBlock(REGISTRY);
  assert.match(block, /TOOL-CALL PROTOCOL/);
  assert.match(block, /```tool_call/);
  assert.match(block, /- web_search: Free-text web search/);
  assert.match(block, /- finalize: Emit the final answer/);
  assert.match(block, /Worked example/);
  // Schema rendered as a compact one-liner with required markers.
  assert.match(block, /"query": string/);
  assert.match(block, /"maxResults"\?: integer/);
});

test('describeSchema marks optional props with ? and handles empty schemas', () => {
  assert.equal(describeSchema(null), '{}');
  assert.equal(describeSchema({ type: 'object' }), '{}');
  const out = describeSchema(REGISTRY[0].parameters);
  assert.match(out, /"query": string/);
  assert.match(out, /"maxResults"\?: integer/);
});

test('parsePromptedToolCalls extracts a fenced tool_call block', () => {
  const content = 'Necesito datos frescos, busco primero.\n```tool_call\n{"tool": "web_search", "args": {"query": "dolar peru hoy"}}\n```';
  assert.equal(hasPromptedToolCalls(content), true);
  const { toolCalls, cleanedContent } = parsePromptedToolCalls(content, new Set(['web_search', 'finalize']));
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].type, 'function');
  assert.equal(toolCalls[0].function.name, 'web_search');
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { query: 'dolar peru hoy' });
  assert.match(cleanedContent, /Necesito datos frescos/);
  assert.doesNotMatch(cleanedContent, /tool_call/);
});

test('parsePromptedToolCalls accepts json fences and multiple blocks', () => {
  const content = [
    'Buscaré dos cosas en paralelo.',
    '```json',
    '{"tool": "web_search", "args": {"query": "a"}}',
    '```',
    '```tool_call',
    '{"name": "web_search", "arguments": {"query": "b"}}',
    '```',
  ].join('\n');
  const { toolCalls } = parsePromptedToolCalls(content);
  assert.equal(toolCalls.length, 2);
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { query: 'a' });
  assert.deepEqual(JSON.parse(toolCalls[1].function.arguments), { query: 'b' });
});

test('parsePromptedToolCalls falls back to a bare JSON object with a tool key', () => {
  const content = 'Voy a finalizar. {"tool": "finalize", "args": {"answer": "Listo: **resultado**."}}';
  const { toolCalls, cleanedContent } = parsePromptedToolCalls(content, new Set(['finalize']));
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.name, 'finalize');
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { answer: 'Listo: **resultado**.' });
  assert.match(cleanedContent, /Voy a finalizar\./);
});

test('parsePromptedToolCalls ignores JSON quoted in prose that names no registered tool', () => {
  const content = 'El config es ```json\n{"tool": "no_such_tool", "args": {}}\n``` y también {"name": "otra_cosa", "args": {}}.';
  const { toolCalls } = parsePromptedToolCalls(content, new Set(['web_search', 'finalize']));
  assert.equal(toolCalls.length, 0);
});

test('parsePromptedToolCalls ignores plain JSON without a tool/name key', () => {
  const content = 'Datos: {"ventas": 100, "mes": "enero"} — sin llamadas.';
  const { toolCalls } = parsePromptedToolCalls(content);
  assert.equal(toolCalls.length, 0);
});

test('extractBareJsonObjects balances braces and survives strings with braces', () => {
  const objs = extractBareJsonObjects('x {"a": "tiene } llave", "b": {"c": 1}} y {"d": 2}');
  assert.equal(objs.length, 2);
  assert.deepEqual(JSON.parse(objs[0]), { a: 'tiene } llave', b: { c: 1 } });
  assert.deepEqual(JSON.parse(objs[1]), { d: 2 });
});

test('toPromptedTranscript renders tool calls as fences and tool results as labelled user messages', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'pregunta' },
    {
      role: 'assistant',
      content: 'Busco primero.',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"a"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"results":[1]}' },
  ];
  const out = toPromptedTranscript(messages);
  assert.equal(out.length, 4);
  // No provider-hostile shapes left: no role:'tool', no tool_calls field.
  assert.ok(out.every((m) => m.role !== 'tool'));
  assert.ok(out.every((m) => !('tool_calls' in m)));
  assert.match(out[2].content, /Busco primero\./);
  assert.match(out[2].content, /```tool_call/);
  assert.match(out[2].content, /"tool":"web_search"/);
  assert.equal(out[3].role, 'user');
  assert.match(out[3].content, /^\[TOOL_RESULT web_search\]/);
  assert.match(out[3].content, /\{"results":\[1\]\}/);
});

test('toPromptedTranscript appends a forced-tool instruction when requested', () => {
  const out = toPromptedTranscript([{ role: 'user', content: 'q' }], { forceToolName: 'finalize' });
  assert.equal(out.length, 2);
  assert.equal(out[1].role, 'user');
  assert.match(out[1].content, /MUST now respond/);
  assert.match(out[1].content, /"finalize"/);
});

test('capToolsForPrompted keeps pinned + preferred tools under the cap', () => {
  const tools = Array.from({ length: 40 }, (_, i) => ({ name: `tool_${i}` }));
  tools.push({ name: 'web_search' }, { name: 'read_url' }, { name: 'generate_video' }, { name: 'create_chart' });
  const capped = capToolsForPrompted(tools, { pinned: ['generate_video'] });
  assert.equal(capped.length, PROMPTED_MAX_TOOLS_DEFAULT);
  const names = capped.map((t) => t.name);
  // Pinned intent tool survives and goes first.
  assert.equal(names[0], 'generate_video');
  assert.ok(names.includes('web_search'));
  assert.ok(names.includes('read_url'));
  assert.ok(names.includes('create_chart'));
});

test('capToolsForPrompted is a no-op for already-small toolsets', () => {
  const tools = [{ name: 'a' }, { name: 'b' }];
  assert.deepEqual(capToolsForPrompted(tools), tools);
});

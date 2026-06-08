'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseNativeToolCalls,
  hasNativeToolCalls,
  stripNativeToolCallMarkup,
} = require('../src/services/react-agent');

test('parses Moonshot/Kimi native tool-call tokens into OpenAI tool_calls', () => {
  const content = 'Voy a buscar fuentes verificadas.<|tool_calls_section_begin|><|tool_call_begin|>functions.web_search:0<|tool_call_argument_begin|>{"query":"poliestireno reciclado construccion"}<|tool_call_end|><|tool_calls_section_end|>';
  assert.equal(hasNativeToolCalls(content), true);
  const { toolCalls, cleanedContent } = parseNativeToolCalls(content);
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].type, 'function');
  assert.equal(toolCalls[0].function.name, 'web_search');
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { query: 'poliestireno reciclado construccion' });
  // The visible thought must NOT leak any tool-call markup.
  assert.match(cleanedContent, /Voy a buscar fuentes verificadas\./);
  assert.doesNotMatch(cleanedContent, /tool_call|<\|/);
});

test('parses multiple Kimi native tool calls', () => {
  const content = '<|tool_call_begin|>functions.web_search:0<|tool_call_argument_begin|>{"query":"a"}<|tool_call_end|><|tool_call_begin|>functions.read_url:1<|tool_call_argument_begin|>{"url":"https://x.test"}<|tool_call_end|>';
  const { toolCalls } = parseNativeToolCalls(content);
  assert.equal(toolCalls.length, 2);
  assert.equal(toolCalls[0].function.name, 'web_search');
  assert.equal(toolCalls[1].function.name, 'read_url');
});

test('parses Hermes/Qwen <tool_call> JSON format', () => {
  const content = 'Pensando...\n<tool_call>{"name":"web_search","arguments":{"query":"b"}}</tool_call>';
  const { toolCalls, cleanedContent } = parseNativeToolCalls(content);
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.name, 'web_search');
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { query: 'b' });
  assert.doesNotMatch(cleanedContent, /tool_call/);
});

test('returns no tool calls for plain content (and leaves it intact)', () => {
  const content = 'La fotosíntesis convierte luz en energía química.';
  assert.equal(hasNativeToolCalls(content), false);
  const { toolCalls, cleanedContent } = parseNativeToolCalls(content);
  assert.equal(toolCalls.length, 0);
  assert.equal(cleanedContent, content);
});

test('strips markup even when arguments are malformed JSON', () => {
  const content = 'x<|tool_call_begin|>functions.finalize:0<|tool_call_argument_begin|>{not json<|tool_call_end|>';
  const { toolCalls, cleanedContent } = parseNativeToolCalls(content);
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.name, 'finalize');
  assert.doesNotMatch(cleanedContent, /tool_call|<\|/);
});

test('stripNativeToolCallMarkup handles null/empty safely', () => {
  assert.equal(stripNativeToolCallMarkup(null), '');
  assert.equal(stripNativeToolCallMarkup(''), '');
  assert.equal(stripNativeToolCallMarkup('hello'), 'hello');
});

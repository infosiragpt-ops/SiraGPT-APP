'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeToolCalls,
  collectToolCallIds,
  INVALID_TOOL_CALLS,
} = require('../src/services/agents/tool-call-normalizer');

const call = (id, name = 'web_search', args = '{"q":"alpha"}') => ({
  id, type: 'function', function: { name, arguments: args },
});

test('valid unique identities and exact arguments are preserved without mutating input', () => {
  const input = [call('provider-A'), call('provider-B', 'read_url', ' { "q" : "beta" } ')];
  const original = structuredClone(input);
  const usedIds = new Set();
  const result = normalizeToolCalls(input, { usedIds });
  assert.deepEqual(result, original);
  assert.deepEqual(input, original);
  assert.notEqual(result, input);
  assert.notEqual(result[0], input[0]);
  assert.notEqual(result[0].function, input[0].function);
  assert.deepEqual([...usedIds], ['provider-A', 'provider-B']);
});

test('duplicate identities are repaired while preserving each function and arguments', () => {
  const input = [call('same'), call('same', 'read_url', '{"q":"beta"}')];
  const result = normalizeToolCalls(input);
  assert.equal(result[0].id, 'same');
  assert.notEqual(result[1].id, 'same');
  assert.deepEqual(result.map(item => item.function), input.map(item => item.function));
});

test('repairs reserve IDs from the entire batch and previous steps', () => {
  const usedIds = new Set(['prior', 'call_sira_1']);
  const input = [call(undefined), call('call_sira_2'), call('prior'), call('call_sira_4')];
  const result = normalizeToolCalls(input, { usedIds });
  assert.deepEqual(result.map(item => item.id), ['call_sira_3', 'call_sira_2', 'call_sira_5', 'call_sira_4']);
  assert.equal(new Set(result.map(item => item.id)).size, 4);
});

test('the same run Set prevents provider ID reuse across subsequent steps', () => {
  const usedIds = new Set();
  const first = normalizeToolCalls([call('native_0')], { usedIds });
  const second = normalizeToolCalls([call('native_0')], { usedIds });
  const third = normalizeToolCalls([call(second[0].id)], { usedIds });
  assert.equal(first[0].id, 'native_0');
  assert.equal(new Set([first[0].id, second[0].id, third[0].id]).size, 3);
});

test('missing, empty, non-string and control-character IDs get safe identities', () => {
  const result = normalizeToolCalls([undefined, null, '', '  ', 17, {}, 'bad\nID'].map(id => call(id)));
  assert.equal(new Set(result.map(item => item.id)).size, 7);
  assert.ok(result.every(item => /^call_sira_\d+$/.test(item.id)));
});

test('legacy omitted type and arguments preserve dispatcher defaults', () => {
  const input = [{ id: 'legacy', function: { name: 'web_search' } }];
  const result = normalizeToolCalls(input);
  assert.equal(result[0].type, 'function');
  assert.equal(Object.hasOwn(result[0].function, 'arguments'), false);
  assert.deepEqual(input, [{ id: 'legacy', function: { name: 'web_search' } }]);
});

test('argument JSON and schema validation remain the dispatcher responsibility', () => {
  const args = ['{broken json', null, {}, [], 1, false];
  const result = normalizeToolCalls(args.map((value, index) => call(`args_${index}`, 'web_search', value)));
  assert.deepEqual(result.map(item => item.function.arguments), args);
});

test('an absent or empty batch changes no reserved identity', () => {
  const usedIds = new Set(['before']);
  for (const input of [null, undefined, []]) assert.deepEqual(normalizeToolCalls(input, { usedIds }), []);
  assert.deepEqual([...usedIds], ['before']);
});

for (const [name, input] of [
  ['non-array batch', {}],
  ['null call', [null]],
  ['sparse batch', Array(1)],
  ['array call', [[]]],
  ['unsupported type', [{ ...call('bad'), type: 'custom' }]],
  ['explicit null type', [{ ...call('bad'), type: null }]],
  ['missing function', [{ id: 'bad' }]],
  ['array function', [{ id: 'bad', function: [] }]],
  ['missing name', [{ id: 'bad', function: {} }]],
  ['non-string name', [{ id: 'bad', function: { name: {} } }]],
  ['blank name', [{ id: 'bad', function: { name: '  ' } }]],
]) {
  test(`rejects ${name} with a stable code, no argument leakage and no reservation mutation`, () => {
    const usedIds = new Set(['before']);
    assert.throws(() => normalizeToolCalls(input, { usedIds }), error => {
      assert.equal(error.code, INVALID_TOOL_CALLS);
      assert.match(error.message, /^Invalid model tool calls: [a-z_]+$/);
      return true;
    });
    assert.deepEqual([...usedIds], ['before']);
  });
}

test('validation is atomic when a malformed call follows a valid call', () => {
  const usedIds = new Set(['before']);
  const input = [call('new_valid'), { id: 'bad', type: 'custom', function: { name: 'send_message', arguments: 'sensitive synthetic payload' } }];
  assert.throws(() => normalizeToolCalls(input, { usedIds }), error => {
    assert.equal(error.code, INVALID_TOOL_CALLS);
    assert.equal(error.index, 1);
    assert.doesNotMatch(error.message, /sensitive|send_message|new_valid/);
    return true;
  });
  assert.deepEqual([...usedIds], ['before']);
});

test('checkpoint identities include calls and orphaned results without modifying history', () => {
  const history = [
    { role: 'assistant', tool_calls: [call('previous'), call('previous'), null] },
    { role: 'tool', tool_call_id: 'orphaned', content: 'Synthetic historical result' },
    { role: 'user', tool_call_id: 'ignore', content: 'Synthetic prompt' },
    null,
  ];
  const original = structuredClone(history);
  const usedIds = collectToolCallIds(history);
  assert.deepEqual([...usedIds], ['previous', 'orphaned']);
  const result = normalizeToolCalls([call('previous'), call('orphaned')], { usedIds });
  assert.ok(result.every(item => !['previous', 'orphaned'].includes(item.id)));
  assert.deepEqual(history, original);
  assert.deepEqual([...collectToolCallIds(null)], []);
});

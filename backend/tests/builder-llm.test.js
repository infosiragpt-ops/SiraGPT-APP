'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isLlmAvailable, complete, completeJson, extractJson } = require('../src/services/builder/llm');

function fakeClient(content) {
  return { chat: { completions: { create: async () => ({ choices: [{ message: { content } }] }) } } };
}

test('isLlmAvailable is false without an API key', () => {
  assert.equal(isLlmAvailable({ env: {} }), false);
});

test('complete returns null when not configured', async () => {
  assert.equal(await complete({ system: 's', user: 'u', env: {} }), null);
});

test('extractJson tolerates fences and surrounding prose', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('blah {"b":2} tail'), { b: 2 });
  assert.deepEqual(extractJson('[1,2,3]'), [1, 2, 3]);
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson(42), null);
});

test('complete uses an injected client on the success path', async () => {
  const text = await complete({
    user: 'u', env: { CEREBRAS_API_KEY: 'k' }, createClient: () => fakeClient('hola'),
  });
  assert.equal(text, 'hola');
});

test('complete returns null when the client throws', async () => {
  const client = { chat: { completions: { create: async () => { throw new Error('boom'); } } } };
  const text = await complete({ user: 'u', env: { CEREBRAS_API_KEY: 'k' }, createClient: () => client });
  assert.equal(text, null);
});

test('complete returns null on empty content', async () => {
  const text = await complete({ user: 'u', env: { CEREBRAS_API_KEY: 'k' }, createClient: () => fakeClient('   ') });
  assert.equal(text, null);
});

test('completeJson parses the model JSON', async () => {
  const json = await completeJson({
    user: 'u', env: { CEREBRAS_API_KEY: 'k' }, createClient: () => fakeClient('{"ok":true}'),
  });
  assert.deepEqual(json, { ok: true });
});

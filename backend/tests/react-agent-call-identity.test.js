'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { run } = require('../src/services/react-agent');

const call = (id, name, args = {}, type = 'function') => ({
  id, type, function: { name, arguments: JSON.stringify(args) },
});

function scriptedClient(batches) {
  let index = 0;
  const requests = [];
  return {
    requests,
    chat: { completions: { create: async (params) => {
      requests.push(structuredClone(params.messages));
      const toolCalls = batches[index++] || [call('done', 'finalize', { answer: 'Done.' })];
      return { choices: [{ message: { role: 'assistant', content: '', tool_calls: toolCalls } }] };
    } } },
  };
}

function syntheticTool(name, executed) {
  return {
    name,
    description: 'Synthetic local handler; never contacts a provider.',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false },
    execute: async ({ value }) => {
      executed.push(name);
      return { source: name, value };
    },
  };
}

test('native duplicate IDs retain the correct parallel tool observation and transcript pairing', async () => {
  const executed = [];
  const client = scriptedClient([[
    call('same_id', 'web_search', { value: 'alpha' }),
    call('same_id', 'read_url', { value: 'beta' }),
  ]]);
  const result = await run(client, {
    query: 'Synthetic pairing audit', model: 'test-model', maxSteps: 4,
    tools: ['web_search', 'read_url'].map(name => syntheticTool(name, executed)),
  });

  assert.deepEqual(executed.sort(), ['read_url', 'web_search']);
  assert.deepEqual(result.steps[0].actions.map(action => action.observation), [
    { source: 'web_search', value: 'alpha' },
    { source: 'read_url', value: 'beta' },
  ]);
  const nextRequest = client.requests[1];
  const calls = nextRequest.find(message => message.role === 'assistant').tool_calls;
  const results = nextRequest.filter(message => message.role === 'tool');
  assert.equal(calls[0].id, 'same_id');
  assert.equal(new Set(calls.map(item => item.id)).size, 2);
  assert.deepEqual(results.map(item => item.tool_call_id), calls.map(item => item.id));
});

test('a malformed call rejects the whole batch before either read or mutating handlers execute', async () => {
  const executed = [];
  const client = scriptedClient([[
    call('read', 'web_search', { value: 'alpha' }),
    call('write', 'send_message', { value: 'beta' }, 'custom'),
  ]]);
  const result = await run(client, {
    query: 'Synthetic invalid batch audit', model: 'test-model', maxSteps: 4,
    tools: ['web_search', 'send_message'].map(name => syntheticTool(name, executed)),
  });
  assert.deepEqual(executed, []);
  assert.equal(result.stoppedReason, 'invalid_tool_calls');
  assert.equal(client.requests.length, 1);
});

test('provider IDs repeated across steps are normalized without losing previous observations', async () => {
  const executed = [];
  const client = scriptedClient([
    [call('call_native_0_web_search', 'web_search', { value: 'alpha' })],
    [call('call_native_0_web_search', 'web_search', { value: 'beta' })],
  ]);
  const result = await run(client, {
    query: 'Synthetic repeated native ID audit', model: 'test-model', maxSteps: 5,
    tools: [syntheticTool('web_search', executed)],
  });
  assert.equal(result.stoppedReason, 'finalized');
  assert.equal(executed.length, 2);
  const history = client.requests[2];
  const ids = history.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls.map(item => item.id));
  const results = history.filter(message => message.role === 'tool');
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(results.map(item => item.tool_call_id), ids);
  assert.deepEqual(results.map(item => JSON.parse(item.content).value), ['alpha', 'beta']);
});

test('new calls cannot reuse identities from a resumed checkpoint transcript', async () => {
  const executed = [];
  const client = scriptedClient([[call('checkpoint_call', 'web_search', { value: 'new' })]]);
  const checkpoint = {
    stepsCompleted: 1,
    messages: [
      { role: 'user', content: 'Synthetic historical request' },
      { role: 'assistant', content: '', tool_calls: [call('checkpoint_call', 'web_search', { value: 'old' })] },
      { role: 'tool', tool_call_id: 'checkpoint_call', content: JSON.stringify({ source: 'web_search', value: 'old' }) },
    ],
  };
  const original = structuredClone(checkpoint);
  const result = await run(client, {
    query: 'Continue the synthetic audit', model: 'test-model', maxSteps: 5,
    tools: [syntheticTool('web_search', executed)], resumeCheckpoint: checkpoint,
  });
  assert.equal(result.stoppedReason, 'finalized');
  assert.equal(executed.length, 1);
  const history = client.requests[1];
  const ids = history.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls.map(item => item.id));
  assert.equal(ids[0], 'checkpoint_call');
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(history.filter(message => message.role === 'tool').map(message => message.tool_call_id), ids);
  assert.deepEqual(checkpoint, original);
});

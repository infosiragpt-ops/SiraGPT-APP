'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { run, isParallelSafeTool, prefetchParallelDispatch } = require('../src/services/react-agent');
const tool = (name, execute, policy = {}) => ({ name, description: name, parameters: { type: 'object' }, execute, ...policy });
const call = (id, name) => ({ id, type: 'function', function: { name, arguments: '{}' } });

test('read-looking names are not authority for unknown or stateful tools', () => {
  for (const name of ['read_file_delete', 'web_search_send', 'session_history_clear', 'sunat_update', 'READ_FILE']) {
    assert.equal(isParallelSafeTool(name), false, name);
  }
});

test('an explicit local non-read policy overrides a familiar builtin name', async () => {
  let calls = 0;
  const registry = [tool('read_file', async () => { calls++; }, { readOnly: false }), tool('read_url', async () => ({}))];
  const result = await prefetchParallelDispatch(registry, [call('a', 'read_file'), call('b', 'read_url')], {});
  assert.equal(result.size, 0);
  assert.equal(calls, 0, 'a mutating override must remain an execution barrier');
});

test('trusted local read policy permits new read names but remote hints alone do not', async () => {
  const registry = [tool('inspect_alpha', async () => ({ source: 'a' }), { readOnly: true }),
    tool('inspect_beta', async () => ({ source: 'b' }), { readOnly: true })];
  const result = await prefetchParallelDispatch(registry, [call('a', 'inspect_alpha'), call('b', 'inspect_beta')], {});
  assert.equal(result.size, 2);
  assert.equal(isParallelSafeTool('mcp_external', [tool('mcp_external', async () => ({}), { annotations: { readOnlyHint: true } })]), false);
});

test('a live read opting out of caching is executed again and returns fresh data', async () => {
  let requests = 0;
  let reads = 0;
  const client = { chat: { completions: { create: async () => {
    requests++;
    return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [requests < 3
      ? call(`r${requests}`, 'read_file')
      : { id: 'f', type: 'function', function: { name: 'finalize', arguments: '{"answer":"done"}' } }],
    } }] };
  } } } };
  const result = await run(client, { query: 'Inspect fresh data', model: 'test-model', maxSteps: 4,
    tools: [tool('read_file', async () => ({ revision: ++reads }), { readOnly: true, cacheable: false })],
  });
  assert.equal(reads, 2);
  assert.equal(result.steps[1].actions[0].observation.revision, 2);
});

test('a read-looking mutation is never suppressed by a successful-read cache', async () => {
  let requests = 0;
  let effects = 0;
  const client = { chat: { completions: { create: async () => {
    requests++;
    return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [requests < 3
      ? call(`r${requests}`, 'read_file_update')
      : { id: 'f', type: 'function', function: { name: 'finalize', arguments: '{"answer":"done"}' } }],
    } }] };
  } } } };
  await run(client, { query: 'Synthetic state change', model: 'test-model', maxSteps: 4,
    tools: [tool('read_file_update', async () => ({ effects: ++effects }))],
  });
  assert.equal(effects, 2, 'ordered requested operations must not be silently turned into cached reads');
});

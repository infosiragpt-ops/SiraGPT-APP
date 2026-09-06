'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../src/services/react-agent');

function client(batches) {
  let index = 0;
  return { chat: { completions: { create: async () => ({ choices: [{ message: {
    role: 'assistant', content: '',
    tool_calls: (batches[index++] || ['finalize']).map((name, i) => ({
      id: `call_${index}_${i}`, type: 'function', function: {
        name, arguments: JSON.stringify(name === 'finalize' ? { answer: 'Resultado revisado.' } : {}),
      },
    })),
  } }] }) } } };
}

const tool = (name, execute) => ({ name, description: name, parameters: { type: 'object' }, execute });

test('reads after a write in the same batch observe the write, not prefetched stale data', async () => {
  let content = 'old';
  const order = [];
  const result = await run(client([['host_file', 'read_file', 'list_files']]), {
    query: 'Edita y comprueba', model: 'test-model', maxSteps: 4,
    tools: [
      tool('host_file', async () => { order.push('write'); content = 'new'; return { ok: true }; }),
      tool('read_file', async () => { order.push('read'); return { content }; }),
      tool('list_files', async () => { order.push('list'); return { content }; }),
    ],
  });
  assert.deepEqual(order, ['write', 'read', 'list']);
  assert.equal(result.steps[0].actions[1].observation.content, 'new');
  assert.equal(result.steps[0].actions[2].observation.content, 'new');
});

for (const uncertain of [false, true]) {
  test(`a read after ${uncertain ? 'an uncertain failed' : 'a successful'} mutation is executed again`, async () => {
    let content = 'old';
    let reads = 0;
    const result = await run(client([['read_file'], ['host_file'], ['read_file']]), {
      query: 'Edita y comprueba', model: 'test-model', maxSteps: 6,
      tools: [
        tool('read_file', async () => { reads++; return { content }; }),
        tool('host_file', async () => {
          content = 'new';
          if (uncertain) throw new Error('write confirmed but reply lost');
          return { ok: true };
        }),
      ],
    });
    assert.equal(reads, 2, 'read cache must be invalidated after a potentially mutating operation');
    assert.equal(result.steps[2].actions[0].observation.content, 'new');
  });
}

test('a finalize barrier does not speculatively start tools that follow it', async () => {
  let calls = 0;
  const result = await run(client([['finalize', 'read_file', 'list_files']]), {
    query: 'Contesta', model: 'test-model', maxSteps: 4,
    tools: ['read_file', 'list_files'].map(name => tool(name, async () => { calls++; return { ok: true }; })),
  });
  assert.equal(calls, 0);
  assert.equal(result.stoppedReason, 'finalized');
});

test('duplicate reads without an intervening mutation still use the per-run cache', async () => {
  let calls = 0;
  const result = await run(client([['read_file'], ['read_file']]), {
    query: 'Lee', model: 'test-model', maxSteps: 5,
    tools: [tool('read_file', async () => { calls++; return { content: 'unchanged' }; })],
  });
  assert.equal(calls, 1);
  assert.equal(result.steps[1].actions[0].observation.warning, 'duplicate_tool_call');
});

'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');

const { createAgentCheckpointStore } = require('../src/orchestration/agent-checkpoint-store');

test('createAgentCheckpointStore exports a factory', () => {
  assert.equal(typeof createAgentCheckpointStore, 'function');
});

test('put and get round-trip with thread + checkpoint IDs', async () => {
  const store = createAgentCheckpointStore({ prisma: createMockPrisma() });
  await store.put({
    threadId: 'thread-1',
    checkpointId: 'ckpt-1',
    state: { input: 'hello', plan: { steps: ['a', 'b'] } },
    metadata: { node: 'planner' },
  });
  const row = await store.get('thread-1', 'ckpt-1');
  assert.ok(row);
  assert.equal(row.threadId, 'thread-1');
  assert.equal(row.checkpointId, 'ckpt-1');
  assert.deepEqual(row.state, { input: 'hello', plan: { steps: ['a', 'b'] } });
});

test('latest returns most recent checkpoint for thread', async () => {
  const store = createAgentCheckpointStore({ prisma: createMockPrisma() });
  await store.put({ threadId: 't1', checkpointId: 'c1', state: { v: 1 } });
  await new Promise(resolve => setTimeout(resolve, 5));
  await store.put({ threadId: 't1', checkpointId: 'c2', state: { v: 2 } });
  const latest = await store.latest('t1');
  assert.equal(latest.checkpointId, 'c2');
  assert.deepEqual(latest.state, { v: 2 });
});

function createMockPrisma() {
  const rows = [];
  return {
    $executeRawUnsafe(query, ...params) {
      if (/INSERT.*agent_checkpoints/i.test(query)) {
        rows.push({
          threadId: params[0], checkpointId: params[1],
          parentCheckpointId: params[2], state: JSON.parse(params[3]),
          metadata: JSON.parse(params[4]), createdAt: new Date(),
        });
      }
      return 1;
    },
    $queryRawUnsafe(query, ...params) {
      if (/ORDER BY created_at DESC/.test(query)) {
        return rows.filter(r => r.threadId === params[0]).sort((a, b) => b.createdAt - a.createdAt).slice(0, 1);
      }
      return rows.filter(r => r.threadId === params[0] && r.checkpointId === params[1]).slice(0, 1);
    },
  };
}

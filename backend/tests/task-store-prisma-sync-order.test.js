'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('Prisma mirror serializes each task and snapshots producer values before deferred writes', async t => {
  const persistencePath = require.resolve('../src/services/agents/agent-task-persistence');
  const syncPath = require.resolve('../src/services/agents/task-store-prisma-sync');
  const previous = require.cache[persistencePath]; const env = process.env.AGENT_TASK_PRISMA_SYNC;
  const writes = []; const events = []; let release; let firstStarted;
  const started = new Promise(resolve => { firstStarted = resolve; });
  require.cache[persistencePath] = { id: persistencePath, filename: persistencePath, loaded: true, exports: {
    async upsertAgentTask(value) {
      writes.push({ ...value });
      if (writes.length === 1) { firstStarted(); await new Promise(resolve => { release = resolve; }); }
    },
    async appendAgentTaskEvent(snapshot, event) { events.push({ taskId: snapshot.taskId, ...event }); },
  } };
  process.env.AGENT_TASK_PRISMA_SYNC = '1'; delete require.cache[syncPath];
  t.after(() => { previous ? require.cache[persistencePath] = previous : delete require.cache[persistencePath]; delete require.cache[syncPath];
    env === undefined ? delete process.env.AGENT_TASK_PRISMA_SYNC : process.env.AGENT_TASK_PRISMA_SYNC = env; });
  const sync = require(syncPath);
  const state = { taskId: 'ordered', userId: 'owner', status: 'running', streamState: { phase: 'first' } };
  sync.schedulePrismaSync(state, { type: 'text', seq: 1 });
  state.status = 'completed'; state.streamState.phase = 'terminal';
  sync.schedulePrismaSync(state, { type: 'done', seq: 2 });
  state.status = 'mutated-after-enqueue';
  await started; await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 1, 'terminal upsert cannot overtake the pending progress write');
  assert.equal(writes[0].status, 'running'); assert.equal(writes[0].streamState.phase, 'first');
  release(); await sync.flushPrismaSync();
  assert.deepEqual(writes.map(value => value.status), ['running', 'completed']);
  assert.deepEqual(events.map(value => value.seq), [1, 2]);
});

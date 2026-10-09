'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.AGENT_TASK_PRISMA_SYNC = '0';
process.env.SIRAGPT_TURN_FAILURES = '0';
process.env.NODE_ENV = 'test';
const writer = require('../src/services/agents/task-store-writer');
const store = require('../src/services/agents/task-store');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'task-writer-'));

test('concurrent cumulative writes coalesce without losing events; shared index includes every task', async () => {
  const dir = temp();
  try {
    const events = [];
    for (let i = 1; i <= 60; i++) {
      events.push({ seq: i, type: 'text', text: String(i) });
      writer.enqueue(path.join(dir, 'a.json'), { taskId: 'a', userId: 'u', status: 'running', events });
      if (i % 10 === 0) writer.enqueue(path.join(dir, `b${i}.json`), { taskId: `b${i}`, userId: 'u', status: 'queued', events: [] });
      if (i % 7 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    events.length = 0; //Producer mutation cannot alter the enqueued snapshots.
    await writer.flush();
    const committed = JSON.parse(fs.readFileSync(path.join(dir, 'a.json')));
    assert.equal(committed.events.length, 60);
    assert.equal(committed.events.at(-1).seq, 60);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, '_index.json')))).length, 7);
    assert.equal(writer.hasPending(path.join(dir, 'a.json')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a write failure rejects the durability barrier; retry after repair retains the latest complete snapshot', async () => {
  const dir = temp(); const blocked = path.join(dir, 'blocked'); fs.writeFileSync(blocked, 'not-directory');
  const file = path.join(blocked, 'task.json');
  writer.enqueue(file, { taskId: 'task', userId: 'u', events: [{ seq: 1 }] });
  await assert.rejects(writer.flush(), { code: 'EEXIST' });
  writer.enqueue(file, { taskId: 'task', userId: 'u', status: 'completed', events: [{ seq: 1 }, { seq: 2 }] });
  fs.unlinkSync(blocked); fs.mkdirSync(blocked);
  await writer.flush();
  assert.equal(JSON.parse(fs.readFileSync(file)).events.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buffered progress is immediately readable but deletion waits for persistence; terminal await commits snapshot and index', async () => {
  const dir = temp(); process.env.AGENT_TASK_STORE_DIR = dir;
  await store.writeTaskSnapshotAsync({ taskId: 'barrier', userId: 'u', status: 'running', streamState: {}, events: [] });
  for (let i = 1; i <= 30; i++) store.appendTaskEventBuffered({ taskId: 'barrier', userId: 'u', status: 'running' }, { type: 'text', text: String(i) }, {});
  assert.equal(store.readTaskSnapshot('barrier').events.length, 30);
  assert.deepEqual(store.deleteTaskSnapshot('barrier', 'u', { force: true }), { ok: false, reason: 'persistence_pending' });
  await store.markTaskStatusAsync({ taskId: 'barrier', userId: 'u' }, 'completed', { streamState: { done: true, stoppedReason: 'completed' } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'barrier.json'))).events.length, 30);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '_index.json'))).barrier.status, 'completed');
  assert.equal(store.deleteTaskSnapshot('barrier', 'u').ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'barrier.json')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runtime watchdog recovers a stale task while another task has buffered progress', async () => {
  const dir = temp(); process.env.AGENT_TASK_STORE_DIR = dir;
  const watchdog = require('../src/services/agents/agent-task-runtime-watchdog');
  let tick;
  try {
    await store.writeTaskSnapshotAsync({ taskId: 'stalled', userId: 'u', status: 'running', events: [] });
    await store.updateTaskSnapshotAsync('stalled', 'u', { updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() });
    store.writeTaskSnapshotBuffered({ taskId: 'live', userId: 'u', status: 'running', events: [{ type: 'progress', seq: 1 }] });
    watchdog.startAgentTaskRuntimeWatchdog({ env: {}, taskStore: store, setIntervalFn: callback => { tick = callback; return { unref() {} }; } });
    await tick();
    const committed = JSON.parse(fs.readFileSync(path.join(dir, 'stalled.json')));
    assert.equal(committed.status, 'error');
    assert.equal(committed.streamState.done, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'live.json'))).events.length, 1);
    assert.equal(store.isTaskPersistencePending('stalled'), false);
  } finally { watchdog.stopAgentTaskRuntimeWatchdog(); await store.flushTaskStore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('boot resume persists its queued event when enqueue overlaps buffered progress', async () => {
  const dir = temp(); process.env.AGENT_TASK_STORE_DIR = dir;
  const recovery = require('../src/services/agents/agent-task-boot-recovery');
  try {
    await store.writeTaskSnapshotAsync({ taskId: 'resume', userId: 'u', status: 'error', displayGoal: 'resume safely',
      runnerCheckpoint: { stepsCompleted: 2 }, events: [] });
    const result = await recovery.resumeCheckpointedTasks({ env: {}, taskStore: store, recoveredRows: [{ taskId: 'resume', userId: 'u' }],
      enqueue: async () => {
        store.writeTaskSnapshotBuffered({ taskId: 'other', userId: 'u', status: 'running', events: [] });
        return { id: 'resumed-job' };
      },
    });
    assert.equal(result.resumed, 1);
    const committed = JSON.parse(fs.readFileSync(path.join(dir, 'resume.json')));
    assert.equal(committed.status, 'queued');
    assert.equal(committed.jobId, 'resumed-job');
    assert.equal(committed.events.at(-1).type, 'repair_attempt');
    assert.equal(fs.existsSync(path.join(dir, 'other.json')), true);
  } finally { await store.flushTaskStore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recovery respects same-task buffered heartbeats and terminal state over stale disk records', async () => {
  const dir = temp(); process.env.AGENT_TASK_STORE_DIR = dir;
  try {
    for (const taskId of ['alive', 'finished', 'expired']) {
      await store.writeTaskSnapshotAsync({ taskId, userId: 'u', status: 'running', events: [] });
      await store.updateTaskSnapshotAsync(taskId, 'u', { updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() });
    }
    store.touchTaskHeartbeatBuffered('alive', 'u');
    store.markTaskStatusBuffered({ taskId: 'finished', userId: 'u' }, 'completed', { streamState: { done: true } });
    assert.deepEqual(store.findStaleRunningTasks({ staleAfterMs: 120000 }).map(row => row.taskId), ['expired']);
    const result = store.recoverStaleRunningTasksBuffered({ staleAfterMs: 120000 });
    await store.flushTaskStore();
    assert.deepEqual(result.recovered.map(row => row.taskId), ['expired']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'alive.json'))).status, 'running');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'finished.json'))).status, 'completed');
  } finally { await store.flushTaskStore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const status of ['running', 'completed']) {
  test(`boot resume preserves ${status} progress produced before enqueue returns`, async () => {
    const dir = temp(); process.env.AGENT_TASK_STORE_DIR = dir;
    const recovery = require('../src/services/agents/agent-task-boot-recovery');
    try {
      await store.writeTaskSnapshotAsync({ taskId: 'resume-race', userId: 'u', status: 'error', jobId: 'old-job',
        runnerCheckpoint: { stepsCompleted: 2 }, events: [], streamState: { done: true, steps: ['old'] } });
      const result = await recovery.resumeCheckpointedTasks({ env: {}, taskStore: store,
        recoveredRows: [{ taskId: 'resume-race', userId: 'u' }],
        enqueue: async () => {
          store.updateTaskSnapshotBuffered('resume-race', 'u', { status, jobId: 'new-job',
            runnerCheckpoint: { stepsCompleted: 3 }, streamState: { done: status === 'completed', steps: ['old', 'new'] } });
          return { id: 'new-job' };
        },
      });
      assert.equal(result.resumed, 1);
      const committed = JSON.parse(fs.readFileSync(path.join(dir, 'resume-race.json')));
      assert.equal(committed.status, status);
      assert.equal(committed.jobId, 'new-job');
      assert.equal(committed.runnerCheckpoint.stepsCompleted, 3);
      assert.deepEqual(committed.streamState.steps, ['old', 'new']);
      assert.equal(committed.streamState.done, status === 'completed');
    } finally { await store.flushTaskStore(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

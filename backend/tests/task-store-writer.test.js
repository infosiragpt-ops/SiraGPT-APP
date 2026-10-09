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

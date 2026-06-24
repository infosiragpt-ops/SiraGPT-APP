/**
 * failTaskTerminal — guarantees that a permanently-failed agent task gets a
 * terminal `error` event + an 'error' status written to the task store, so
 * the streaming client surfaces a real reason instead of hanging until the
 * SSE timeout (which the UI renders as the opaque
 * `stream_closed_without_done`). The BullMQ worker's `failed` handler calls
 * this; it must be idempotent (never clobber a task that already finished).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.AGENT_TASK_PRISMA_SYNC = '0';
process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-fail-terminal-'));

const taskStore = require('../src/services/agents/task-store');
const { INTERNAL } = require('../src/routes/agent-task');

function baseState() {
  return { steps: [], artifacts: [], finalText: '', done: false };
}

describe('failTaskTerminal', () => {
  test('writes a terminal error event + marks status error on a queued task', () => {
    taskStore.writeTaskSnapshot({
      taskId: 'ft-queued', userId: 'u1', displayGoal: 'x',
      status: 'queued', streamState: baseState(), events: [],
    });

    const applied = INTERNAL.failTaskTerminal('ft-queued', 'u1', 'upstream model timeout');
    assert.equal(applied, true);

    const snap = taskStore.getTaskSnapshotForUser('ft-queued', 'u1');
    assert.equal(snap.status, 'error');
    assert.ok(
      (snap.events || []).some((e) => e.type === 'error' && /upstream model timeout/.test(e.message || '')),
      'expected a terminal error event carrying the failure reason',
    );
  });

  test('is idempotent — no-op when the task already reached a terminal state', () => {
    taskStore.writeTaskSnapshot({
      taskId: 'ft-completed', userId: 'u1', displayGoal: 'x',
      status: 'completed', streamState: { ...baseState(), finalText: 'all good', done: true }, events: [],
    });

    const applied = INTERNAL.failTaskTerminal('ft-completed', 'u1', 'should not overwrite');
    assert.equal(applied, false);

    const snap = taskStore.getTaskSnapshotForUser('ft-completed', 'u1');
    assert.equal(snap.status, 'completed');
    assert.ok(!(snap.events || []).some((e) => /should not overwrite/.test(e.message || '')));
  });

  test('returns false for an unknown task and never throws on bad input', () => {
    assert.equal(INTERNAL.failTaskTerminal('does-not-exist', 'u1', 'x'), false);
    assert.doesNotThrow(() => INTERNAL.failTaskTerminal(null, null, null));
    assert.doesNotThrow(() => INTERNAL.failTaskTerminal(undefined, undefined, undefined));
  });
});

/**
 * Branch-coverage tests for services/agents/task-store.js.
 *
 * Targets the validation paths, edge cases, and helper functions that
 * the existing agent-task-store.test.js does not exercise directly:
 *   - safeTaskId: input sanitisation rules
 *   - sanitizeTaskRecord: defaults & truncation
 *   - writeTaskSnapshot: missing taskId/userId
 *   - appendTaskEvent: null-input early-return paths and artifact dedupe
 *   - recoverStaleRunningTasks: skipJobBacked behaviour
 *   - compressSnapshotBytes: corrupt-input passthrough
 *   - listTaskSnapshotsForUser: slow path (useIndex=false)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const taskStore = require('../src/services/agents/task-store');

function freshDir(prefix = 'sgpt-task-store-branches-') {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return process.env.AGENT_TASK_STORE_DIR;
}

// ─── safeTaskId ────────────────────────────────────────────────────────────

test('safeTaskId: strips path separators and shell metacharacters', () => {
  // Dots are allowed (so version-like ids survive); slashes/backslashes/spaces are not.
  assert.equal(taskStore.safeTaskId('a/b\\c..\\..\\etc'), 'abc....etc');
  assert.equal(taskStore.safeTaskId('id with space; rm -rf'), 'idwithspacerm-rf');
});

test('safeTaskId: returns empty string for non-string falsy values', () => {
  assert.equal(taskStore.safeTaskId(null), '');
  assert.equal(taskStore.safeTaskId(undefined), '');
  assert.equal(taskStore.safeTaskId(0), '');
});

test('safeTaskId: caps length at 120 chars', () => {
  const out = taskStore.safeTaskId('x'.repeat(500));
  assert.equal(out.length, 120);
});

test('safeTaskId: preserves underscores, dashes, dots', () => {
  assert.equal(taskStore.safeTaskId('agent_task-2025.01.01'), 'agent_task-2025.01.01');
});

// ─── snapshotPathFor ───────────────────────────────────────────────────────

test('snapshotPathFor: throws on empty/blank id after sanitisation', () => {
  freshDir();
  assert.throws(() => taskStore.snapshotPathFor(''), /required/);
  assert.throws(() => taskStore.snapshotPathFor('!!!@@@'), /required/);
});

// ─── sanitizeTaskRecord ────────────────────────────────────────────────────

test('sanitizeTaskRecord: applies sane defaults for missing fields', () => {
  const out = taskStore.sanitizeTaskRecord({ taskId: 't1', userId: 'u1' });
  assert.equal(out.status, 'running');
  assert.deepEqual(out.streamState, { steps: [], artifacts: [], finalText: '', done: false });
  assert.deepEqual(out.events, []);
  assert.deepEqual(out.fileIds, []);
  assert.equal(out.lastEventSeq, 0);
});

test('sanitizeTaskRecord: truncates very long agentGoal/displayGoal/systemContract', () => {
  const huge = 'x'.repeat(10000);
  const out = taskStore.sanitizeTaskRecord({
    taskId: 't1', userId: 'u1',
    agentGoal: huge, systemContract: huge, displayGoal: huge,
  });
  assert.equal(out.agentGoal.length, 4000);
  assert.equal(out.systemContract.length, 4000);
  assert.equal(out.displayGoal.length, 4000);
});

test('sanitizeTaskRecord: caps fileIds to 300 entries and stringifies', () => {
  const ids = Array.from({ length: 350 }, (_, i) => i);
  const out = taskStore.sanitizeTaskRecord({ taskId: 't', userId: 'u', fileIds: ids });
  assert.equal(out.fileIds.length, 300);
  assert.equal(typeof out.fileIds[0], 'string');
});

test('sanitizeTaskRecord: trims events to the configured eventLimit', () => {
  const events = Array.from({ length: 1500 }, (_, i) => ({ seq: i, type: 'noop' }));
  const out = taskStore.sanitizeTaskRecord({ taskId: 't', userId: 'u', events });
  assert.equal(out.events.length, 1000); // DEFAULT_EVENT_LIMIT
  // Trimmed from the FRONT — most recent kept.
  assert.equal(out.events[out.events.length - 1].seq, 1499);
});

test('sanitizeTaskRecord: respects custom eventLimit', () => {
  const events = Array.from({ length: 500 }, (_, i) => ({ seq: i, type: 'x' }));
  const out = taskStore.sanitizeTaskRecord({ taskId: 't', userId: 'u', events, eventLimit: 100 });
  assert.equal(out.events.length, 100);
  assert.equal(out.events[0].seq, 400);
});

test('sanitizeTaskRecord: lastEventSeq falls back to 0 for non-finite values', () => {
  const out = taskStore.sanitizeTaskRecord({ taskId: 't', userId: 'u', lastEventSeq: 'not-a-number' });
  assert.equal(out.lastEventSeq, 0);
});

// ─── writeTaskSnapshot validation ─────────────────────────────────────────

test('writeTaskSnapshot: rejects missing taskId', () => {
  freshDir();
  assert.throws(() => taskStore.writeTaskSnapshot({ userId: 'u' }), /taskId/);
});

test('writeTaskSnapshot: rejects missing userId', () => {
  freshDir();
  assert.throws(() => taskStore.writeTaskSnapshot({ taskId: 't' }), /userId/);
});

// ─── appendTaskEvent ──────────────────────────────────────────────────────

test('appendTaskEvent: returns null when snapshot identifiers are missing', () => {
  freshDir();
  assert.equal(taskStore.appendTaskEvent(null, { type: 'meta' }), null);
  assert.equal(taskStore.appendTaskEvent({ taskId: 't' }, { type: 'meta' }), null);
  assert.equal(taskStore.appendTaskEvent({ taskId: 't', userId: 'u' }, null), null);
});

test('appendTaskEvent: stamps id/seq/ts on every appended event', () => {
  freshDir();
  taskStore.writeTaskSnapshot({ taskId: 't1', userId: 'u1', status: 'running' });
  const out = taskStore.appendTaskEvent(
    { taskId: 't1', userId: 'u1' },
    { type: 'meta', message: 'hello' },
  );
  const last = out.events[out.events.length - 1];
  assert.equal(last.type, 'meta');
  assert.equal(typeof last.id, 'string');
  assert.ok(last.seq >= 1);
  assert.ok(last.ts);
  assert.equal(out.lastEventSeq, last.seq);
});

test('appendTaskEvent: dedupes file_artifact entries by artifact.id', () => {
  freshDir();
  taskStore.writeTaskSnapshot({ taskId: 't-dup', userId: 'u', status: 'running' });
  const artifact = { id: 'art-1', filename: 'x.txt' };

  taskStore.appendTaskEvent(
    { taskId: 't-dup', userId: 'u' },
    { type: 'file_artifact', artifact },
  );
  const second = taskStore.appendTaskEvent(
    { taskId: 't-dup', userId: 'u' },
    { type: 'file_artifact', artifact },
  );

  // Two events appended (event log keeps both), but artifacts list deduped.
  assert.equal(second.artifacts.filter(a => a.id === 'art-1').length, 1);
});

test('appendTaskEvent: assigns monotonic seq if not provided', () => {
  freshDir();
  taskStore.writeTaskSnapshot({ taskId: 't-seq', userId: 'u', status: 'running' });
  const a = taskStore.appendTaskEvent({ taskId: 't-seq', userId: 'u' }, { type: 'meta' });
  const b = taskStore.appendTaskEvent({ taskId: 't-seq', userId: 'u' }, { type: 'meta' });
  const c = taskStore.appendTaskEvent({ taskId: 't-seq', userId: 'u' }, { type: 'meta' });
  assert.ok(a.lastEventSeq < b.lastEventSeq);
  assert.ok(b.lastEventSeq < c.lastEventSeq);
});

// ─── markTaskStatus ───────────────────────────────────────────────────────

test('markTaskStatus: returns null on missing taskId/userId', () => {
  freshDir();
  assert.equal(taskStore.markTaskStatus(null, 'completed'), null);
  assert.equal(taskStore.markTaskStatus({ taskId: 't' }, 'completed'), null);
});

test('markTaskStatus: stamps cancelledAt for cancelled status', () => {
  freshDir();
  taskStore.writeTaskSnapshot({ taskId: 't-cancel', userId: 'u', status: 'running' });
  const out = taskStore.markTaskStatus({ taskId: 't-cancel', userId: 'u' }, 'cancelled');
  assert.equal(out.status, 'cancelled');
  assert.ok(out.cancelledAt);
});

test('markTaskStatus: stamps failedAt for error status', () => {
  freshDir();
  taskStore.writeTaskSnapshot({ taskId: 't-err', userId: 'u', status: 'running' });
  const out = taskStore.markTaskStatus({ taskId: 't-err', userId: 'u' }, 'error');
  assert.equal(out.status, 'error');
  assert.ok(out.failedAt);
});

// ─── deleteTaskSnapshot ────────────────────────────────────────────────────

test('deleteTaskSnapshot: missing snapshot returns not_found_or_forbidden', () => {
  freshDir();
  const out = taskStore.deleteTaskSnapshot('nope', 'u');
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'not_found_or_forbidden');
});

test('deleteTaskSnapshot: refuses to delete running task without force', () => {
  freshDir();
  taskStore.writeTaskSnapshot({ taskId: 't-running', userId: 'u', status: 'running' });
  const out = taskStore.deleteTaskSnapshot('t-running', 'u');
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'task_active');
});

test('deleteTaskSnapshot: force=true deletes a running task', () => {
  freshDir();
  taskStore.writeTaskSnapshot({ taskId: 't-running', userId: 'u', status: 'running' });
  const out = taskStore.deleteTaskSnapshot('t-running', 'u', { force: true });
  assert.equal(out.ok, true);
  assert.equal(taskStore.getTaskSnapshotForUser('t-running', 'u'), null);
});

test('deleteTaskSnapshot: refuses cross-user deletion', () => {
  freshDir();
  taskStore.writeTaskSnapshot({ taskId: 't-priv', userId: 'owner', status: 'completed' });
  const out = taskStore.deleteTaskSnapshot('t-priv', 'someone-else');
  assert.equal(out.ok, false);
  // Snapshot still on disk
  assert.ok(taskStore.getTaskSnapshotForUser('t-priv', 'owner'));
});

// ─── listTaskSnapshotsForUser slow path ───────────────────────────────────

test('listTaskSnapshotsForUser: slow path (useIndex=false) scans directory', () => {
  freshDir();
  taskStore.writeTaskSnapshot({ taskId: 't-a', userId: 'u', status: 'completed' });
  taskStore.writeTaskSnapshot({ taskId: 't-b', userId: 'u', status: 'running' });
  taskStore.writeTaskSnapshot({ taskId: 't-c', userId: 'other', status: 'completed' });
  const rows = taskStore.listTaskSnapshotsForUser('u', { useIndex: false });
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.userId === 'u'));
});

test('listTaskSnapshotsForUser: slow path tolerates corrupt JSON files', () => {
  const dir = freshDir();
  taskStore.writeTaskSnapshot({ taskId: 't-good', userId: 'u', status: 'completed' });
  fs.writeFileSync(path.join(dir, 'broken.json'), '{not json');
  const rows = taskStore.listTaskSnapshotsForUser('u', { useIndex: false });
  assert.equal(rows.length, 1);
});

test('listTaskSnapshotsForUser: respects limit', () => {
  freshDir();
  for (let i = 0; i < 8; i++) {
    taskStore.writeTaskSnapshot({ taskId: `t-${i}`, userId: 'u', status: 'completed' });
  }
  const rows = taskStore.listTaskSnapshotsForUser('u', { limit: 3 });
  assert.equal(rows.length, 3);
});

test('listTaskSnapshotsForUser: fast path re-validates ownership against a corrupt index (no IDOR)', () => {
  freshDir();
  // Snapshot truly belongs to "other"; corrupt the index to claim it for "u".
  taskStore.writeTaskSnapshot({ taskId: 't-x', userId: 'other', status: 'completed' });
  const idx = taskStore.readIndex();
  idx['t-x'].userId = 'u'; // index now lies about ownership
  taskStore.writeIndex(idx);

  // Fast path (useIndex=true) trusts the index to SELECT but must re-validate
  // the loaded snapshot's real userId before returning it.
  const rows = taskStore.listTaskSnapshotsForUser('u', { useIndex: true });
  assert.equal(rows.length, 0, "a mislabelled index entry must not leak another user's task");
});

// ─── compressSnapshotBytes ────────────────────────────────────────────────

test('compressSnapshotBytes: returns input unchanged when below MAX_SNAPSHOT_BYTES', () => {
  const buf = Buffer.from(JSON.stringify({ taskId: 't', userId: 'u' }));
  const out = taskStore.compressSnapshotBytes(buf);
  assert.equal(out, buf);
});

test('compressSnapshotBytes: returns raw bytes if input is not valid JSON', () => {
  // Construct a >MAX_SNAPSHOT_BYTES buffer of garbage so the early-exit
  // (size <= MAX) is not taken; the JSON.parse path then throws and
  // the catch-block returns rawBytes unchanged.
  const big = Buffer.alloc(taskStore.MAX_SNAPSHOT_BYTES + 1024, '?');
  const out = taskStore.compressSnapshotBytes(big);
  assert.equal(out, big, 'corrupt oversized payload should pass through unchanged');
});

test('compressSnapshotBytes: shrinks oversized snapshot JSON to a summary', () => {
  const events = Array.from({ length: 5000 }, (_, i) => ({
    type: 'tool_output', seq: i, ts: '2025-01-01T00:00:00.000Z',
    payload: 'x'.repeat(300),
  }));
  const obj = {
    taskId: 't', userId: 'u', status: 'completed',
    events, checkpoints: [], artifacts: [],
    lastEventSeq: 4999,
  };
  const raw = Buffer.from(JSON.stringify(obj));
  assert.ok(raw.length > taskStore.MAX_SNAPSHOT_BYTES, 'fixture should exceed cap');
  const out = taskStore.compressSnapshotBytes(raw);
  const parsed = JSON.parse(out.toString('utf8'));
  assert.equal(parsed._compressed, true);
  assert.equal(parsed.eventCount, 5000);
  assert.equal(parsed.taskId, 't');
  assert.ok(out.length < raw.length, 'compressed payload should shrink');
});

// ─── verifySnapshotIntegrity ──────────────────────────────────────────────

test('verifySnapshotIntegrity: file_missing for unknown task', () => {
  freshDir();
  const out = taskStore.verifySnapshotIntegrity('does-not-exist');
  assert.equal(out.ok, false);
  assert.deepEqual(out.problems, ['file_missing']);
});

test('verifySnapshotIntegrity: detects invalid_status', () => {
  const dir = freshDir();
  // Hand-write a snapshot file with a bogus status (writeTaskSnapshot would
  // sanitise it away).
  const snap = {
    taskId: 't-bad-status', userId: 'u', status: 'banana',
    events: [], checkpoints: [], artifacts: [], updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 't-bad-status.json'), JSON.stringify(snap));
  const out = taskStore.verifySnapshotIntegrity('t-bad-status');
  assert.equal(out.ok, false);
  assert.ok(out.problems.includes('invalid_status'));
});

test('verifySnapshotIntegrity: detects taskId_mismatch', () => {
  const dir = freshDir();
  const snap = {
    taskId: 'other', userId: 'u', status: 'completed',
    events: [], checkpoints: [], artifacts: [], updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 't-mismatch.json'), JSON.stringify(snap));
  const out = taskStore.verifySnapshotIntegrity('t-mismatch');
  assert.equal(out.ok, false);
  assert.ok(out.problems.includes('taskId_mismatch'));
});

// ─── recoverStaleRunningTasks: skipJobBacked ──────────────────────────────

test('recoverStaleRunningTasks: skipJobBacked skips tasks with a jobId', () => {
  freshDir();
  const oldStamp = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  taskStore.writeTaskSnapshot({
    taskId: 't-jobbed', userId: 'u', status: 'running',
    jobId: 'queue-handle-42', updatedAt: oldStamp, createdAt: oldStamp,
  });
  taskStore.writeTaskSnapshot({
    taskId: 't-orphan', userId: 'u', status: 'running',
    updatedAt: oldStamp, createdAt: oldStamp,
  });
  const out = taskStore.recoverStaleRunningTasks({ skipJobBacked: true });
  assert.equal(out.recovered.length, 1);
  assert.equal(out.recovered[0].taskId, 't-orphan');
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].taskId, 't-jobbed');
});

test('recoverStaleRunningTasks: defaults to "error" status with recovery event', () => {
  freshDir();
  const oldStamp = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  taskStore.writeTaskSnapshot({
    taskId: 't-stuck', userId: 'u', status: 'running',
    updatedAt: oldStamp, createdAt: oldStamp,
  });
  const out = taskStore.recoverStaleRunningTasks();
  assert.equal(out.count, 1);
  const after = taskStore.readTaskSnapshot('t-stuck');
  assert.equal(after.status, 'error');
  assert.ok(after.failedAt);
  const lastEvent = after.events[after.events.length - 1];
  assert.equal(lastEvent.type, 'error');
});

// ─── getTasksByStatus ────────────────────────────────────────────────────

test('getTasksByStatus: accepts a single status string', () => {
  freshDir();
  taskStore.writeTaskSnapshot({ taskId: 't-a', userId: 'u', status: 'completed' });
  taskStore.writeTaskSnapshot({ taskId: 't-b', userId: 'u', status: 'running' });
  const out = taskStore.getTasksByStatus('completed');
  assert.equal(out.length, 1);
  assert.equal(out[0].taskId, 't-a');
});

test('getTasksByStatus: accepts an array of statuses', () => {
  freshDir();
  taskStore.writeTaskSnapshot({ taskId: 't-a', userId: 'u', status: 'completed' });
  taskStore.writeTaskSnapshot({ taskId: 't-b', userId: 'u', status: 'cancelled' });
  taskStore.writeTaskSnapshot({ taskId: 't-c', userId: 'u', status: 'running' });
  const out = taskStore.getTasksByStatus(['completed', 'cancelled']);
  assert.equal(out.length, 2);
});

// ─── compactSnapshotEvents ────────────────────────────────────────────────

test('compactSnapshotEvents: returns null for unknown task', () => {
  freshDir();
  const out = taskStore.compactSnapshotEvents('nope', 'u');
  assert.equal(out, null);
});

test('compactSnapshotEvents: no-op when below keepRecent threshold', () => {
  freshDir();
  taskStore.writeTaskSnapshot({
    taskId: 't-small', userId: 'u', status: 'completed',
    events: [{ type: 'meta', seq: 1 }, { type: 'meta', seq: 2 }],
  });
  const out = taskStore.compactSnapshotEvents('t-small', 'u', { keepRecent: 200 });
  assert.equal(out.compacted, 0);
});

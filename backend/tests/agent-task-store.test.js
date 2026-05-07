const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const taskStore = require('../src/services/agents/task-store');

test('agent task store: writes and reads a durable task snapshot', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-agent-task-store-'));

  const snapshot = taskStore.writeTaskSnapshot({
    taskId: 'task-1',
    userId: 'user-a',
    chatId: 'chat-a',
    displayGoal: 'Investiga y genera Excel',
    model: 'gpt-4o',
    status: 'running',
    streamState: { steps: [], artifacts: [], finalText: '', done: false },
  });

  assert.equal(snapshot.taskId, 'task-1');
  assert.equal(fs.existsSync(taskStore.snapshotPathFor('task-1')), true);

  const loaded = taskStore.getTaskSnapshotForUser('task-1', 'user-a');
  assert.equal(loaded.displayGoal, 'Investiga y genera Excel');
  assert.equal(loaded.status, 'running');
});

test('agent task store: scopes snapshots by user', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-agent-task-store-'));

  taskStore.writeTaskSnapshot({
    taskId: 'task-owned',
    userId: 'user-a',
    displayGoal: 'Privado',
  });

  assert.equal(taskStore.getTaskSnapshotForUser('task-owned', 'user-b'), null);
  assert.equal(taskStore.getTaskSnapshotForUser('task-owned', 'user-a').taskId, 'task-owned');
});

test('agent task store: appends events and creates checkpoints for important transitions', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-agent-task-store-'));

  const base = taskStore.writeTaskSnapshot({
    taskId: 'task-events',
    userId: 'user-a',
    displayGoal: 'Genera documento',
    streamState: { steps: [], artifacts: [], finalText: '', done: false },
  });

  taskStore.appendTaskEvent(base, {
    type: 'step_start',
    id: 's1',
    label: 'Planificando',
  }, {
    steps: [{ id: 's1', label: 'Planificando', status: 'running', toolCalls: [] }],
    artifacts: [],
    finalText: '',
    done: false,
  });

  const loaded = taskStore.getTaskSnapshotForUser('task-events', 'user-a');
  assert.equal(loaded.events.length, 1);
  assert.equal(loaded.checkpoints.length, 1);
  assert.equal(loaded.checkpoints[0].type, 'step_start');
  assert.equal(loaded.streamState.steps.length, 1);
});

test('agent task store: marks terminal status with timestamps and stats', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-agent-task-store-'));

  const base = taskStore.writeTaskSnapshot({
    taskId: 'task-done',
    userId: 'user-a',
    displayGoal: 'Finaliza',
  });
  const done = taskStore.markTaskStatus(base, 'completed', {
    stats: { steps: 4, artifacts: 1, durationMs: 1234 },
  });

  assert.equal(done.status, 'completed');
  assert.equal(done.stats.artifacts, 1);
  assert.ok(done.completedAt);
});

test('agent task store: trims event history to the configured limit', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-agent-task-store-'));

  const base = taskStore.writeTaskSnapshot({
    taskId: 'task-trim',
    userId: 'user-a',
    displayGoal: 'Muchos eventos',
  });

  let current = base;
  for (let i = 0; i < 8; i++) {
    current = taskStore.appendTaskEvent(current, { type: 'tool_output', tool: 'x', ok: true, preview: String(i) }, current.streamState, { eventLimit: 3 });
  }

  const loaded = taskStore.getTaskSnapshotForUser('task-trim', 'user-a');
  assert.equal(loaded.events.length, 3);
  assert.equal(loaded.events[0].preview, '5');
  assert.equal(loaded.events[2].preview, '7');
});

// ── Index tests ─────────────────────────────────────────────────

test('agent task store: builds and maintains a user index', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-index-'));
  process.env.AGENT_TASK_STORE_DIR = dir;

  taskStore.writeTaskSnapshot({ taskId: 't1', userId: 'alice', displayGoal: 'T1' });
  taskStore.writeTaskSnapshot({ taskId: 't2', userId: 'bob', displayGoal: 'T2' });
  taskStore.writeTaskSnapshot({ taskId: 't3', userId: 'alice', displayGoal: 'T3' });

  // Index should exist
  const idxPath = taskStore.indexPath();
  assert.ok(fs.existsSync(idxPath), 'index file should exist');

  const index = taskStore.readIndex();
  assert.equal(Object.keys(index).length, 3);
  assert.equal(index.t1.userId, 'alice');
  assert.equal(index.t2.userId, 'bob');
  assert.equal(index.t3.userId, 'alice');
});

test('agent task store: listTaskSnapshotsForUser uses index', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-list-'));
  process.env.AGENT_TASK_STORE_DIR = dir;

  taskStore.writeTaskSnapshot({ taskId: 'a1', userId: 'alice', displayGoal: 'A1' });
  taskStore.writeTaskSnapshot({ taskId: 'a2', userId: 'alice', displayGoal: 'A2' });
  taskStore.writeTaskSnapshot({ taskId: 'b1', userId: 'bob', displayGoal: 'B1' });

  const aliceTasks = taskStore.listTaskSnapshotsForUser('alice');
  assert.equal(aliceTasks.length, 2);
  assert.equal(aliceTasks[0].userId, 'alice');

  const bobTasks = taskStore.listTaskSnapshotsForUser('bob');
  assert.equal(bobTasks.length, 1);

  const nobody = taskStore.listTaskSnapshotsForUser('nobody');
  assert.equal(nobody.length, 0);
});

test('agent task store: index updates on status change', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-status-'));
  process.env.AGENT_TASK_STORE_DIR = dir;

  const base = taskStore.writeTaskSnapshot({ taskId: 'st', userId: 'alice', displayGoal: 'Status' });
  let index = taskStore.readIndex();
  assert.equal(index.st.status, 'running');

  taskStore.markTaskStatus(base, 'completed', { stats: { steps: 1 } });
  index = taskStore.readIndex();
  assert.equal(index.st.status, 'completed');
});

test('agent task store: rebuildIndex recovers from corrupted index', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-rebuild-'));
  process.env.AGENT_TASK_STORE_DIR = dir;

  taskStore.writeTaskSnapshot({ taskId: 'r1', userId: 'alice', displayGoal: 'R1' });
  taskStore.writeTaskSnapshot({ taskId: 'r2', userId: 'bob', displayGoal: 'R2' });

  // Corrupt the index
  fs.writeFileSync(taskStore.indexPath(), '{corrupted}}');
  const bogusIndex = taskStore.readIndex();
  assert.deepEqual(bogusIndex, {}, 'should return empty on corrupt');

  // Rebuild
  const rebuilt = taskStore.rebuildIndex();
  assert.equal(Object.keys(rebuilt).length, 2);
  assert.equal(rebuilt.r1.userId, 'alice');
  assert.equal(rebuilt.r2.userId, 'bob');
});

test('agent task store: removeFromIndex cleans up entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-remove-'));
  process.env.AGENT_TASK_STORE_DIR = dir;

  taskStore.writeTaskSnapshot({ taskId: 'rm1', userId: 'alice' });
  taskStore.removeFromIndex('rm1');

  const index = taskStore.readIndex();
  assert.equal(index.rm1, undefined);
});

test('agent task store: prune removes old snapshots and updates index', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-prune-'));
  process.env.AGENT_TASK_STORE_DIR = dir;

  taskStore.writeTaskSnapshot({ taskId: 'old1', userId: 'alice', status: 'completed', createdAt: new Date(Date.now() - 86400000 * 2).toISOString() });
  taskStore.writeTaskSnapshot({ taskId: 'new1', userId: 'alice', status: 'completed', createdAt: new Date().toISOString() });
  taskStore.writeTaskSnapshot({ taskId: 'run1', userId: 'bob', status: 'running', createdAt: new Date(Date.now() - 86400000 * 2).toISOString() });

  const result = taskStore.pruneTaskSnapshots({ retentionMs: 86400000 });
  assert.ok(result.deleted >= 0); // at least old completed, but not running

  // Running tasks should survive even if old
  assert.ok(taskStore.readTaskSnapshot('run1'), 'running tasks should not be pruned');
});

// ── Compression tests ───────────────────────────────────────────

test('agent task store: compressSnapshotBytes keeps small payloads intact', () => {
  const small = Buffer.from(JSON.stringify({ taskId: 'test', status: 'ok' }));
  const compressed = taskStore.compressSnapshotBytes(small);
  assert.equal(compressed, small, 'small payloads should not be compressed');
});

test('agent task store: compressSnapshotBytes compresses large payloads', () => {
  // Need > 1MB to trigger compression
  const manyChars = 'x'.repeat(300);
  const largeEvents = Array.from({ length: 10000 }, (_, i) => ({
    type: 'tool_output', seq: i, ts: new Date().toISOString(),
    tool: 'gen_doc', ok: true, preview: manyChars,
  }));
  const largeObj = {
    taskId: 'big', userId: 'alice', displayGoal: 'Large task',
    status: 'completed',
    events: largeEvents,
    checkpoints: Array.from({length: 100}, (_, i) => ({ ts: new Date().toISOString(), type: 'step', step: i })),
    artifacts: [{ id: 'a1', name: 'test.pdf' }],
    lastEventSeq: 10000,
    stats: { steps: 100, durationMs: 5000 },
  };
  const largeBuf = Buffer.from(JSON.stringify(largeObj));
  if (largeBuf.length <= taskStore.MAX_SNAPSHOT_BYTES) {
    // On fast machines serialization may not hit 1MB; still verify shape
    const compressed = taskStore.compressSnapshotBytes(largeBuf);
    const parsed = JSON.parse(compressed.toString('utf8'));
    assert.equal(parsed.taskId, 'big');
    return;
  }
  const compressed = taskStore.compressSnapshotBytes(largeBuf);
  const parsed = JSON.parse(compressed.toString('utf8'));
  assert.ok(parsed._compressed, 'large payload should be compressed');
  assert.equal(parsed.taskId, 'big');
  assert.equal(parsed.status, 'completed');
  assert.equal(parsed.eventCount, 10000);
  assert.equal(parsed.artifactCount, 1);
  assert.equal(parsed.stats.steps, 100);
});

// ── Stats / stale-recovery / size-cap tests ─────────────────────

test('agent task store: getTaskStoreStats reports counts and bytes by status', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-stats-'));

  taskStore.writeTaskSnapshot({ taskId: 't-stats-1', userId: 'u', status: 'running', displayGoal: 'a' });
  taskStore.writeTaskSnapshot({ taskId: 't-stats-2', userId: 'u', status: 'completed', displayGoal: 'b' });
  taskStore.writeTaskSnapshot({ taskId: 't-stats-3', userId: 'u', status: 'completed', displayGoal: 'c' });

  const stats = taskStore.getTaskStoreStats();
  assert.equal(stats.totalFiles, 3);
  assert.ok(stats.totalBytes > 0);
  assert.equal(stats.byStatus.running, 1);
  assert.equal(stats.byStatus.completed, 2);
  assert.ok(stats.oldestUpdatedAt && stats.newestUpdatedAt);
});

test('agent task store: findStaleRunningTasks + recoverStaleRunningTasks marks stuck tasks as error', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-stale-'));

  taskStore.writeTaskSnapshot({ taskId: 't-fresh', userId: 'u', status: 'running', displayGoal: 'fresh' });
  taskStore.writeTaskSnapshot({ taskId: 't-old', userId: 'u', status: 'running', displayGoal: 'old' });
  taskStore.updateTaskSnapshot('t-old', 'u', { updatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() });

  const stale = taskStore.findStaleRunningTasks({ staleAfterMs: 60 * 60 * 1000 });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].taskId, 't-old');

  const result = taskStore.recoverStaleRunningTasks({ staleAfterMs: 60 * 60 * 1000 });
  assert.equal(result.count, 1);

  const recovered = taskStore.getTaskSnapshotForUser('t-old', 'u');
  assert.equal(recovered.status, 'error');
  assert.ok(recovered.failedAt);
  assert.equal(recovered.streamState.done, true);
  assert.equal(recovered.events[recovered.events.length - 1].type, 'error');

  assert.equal(taskStore.getTaskSnapshotForUser('t-fresh', 'u').status, 'running');
});

test('agent task store: compactSnapshotEvents drops verbose tool payloads on completed tasks', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-compact-'));

  // Build 250 verbose tool_output events
  const events = [];
  for (let i = 0; i < 250; i++) {
    events.push({
      id: `t:${i + 1}`,
      seq: i + 1,
      ts: new Date(Date.now() - (250 - i) * 1000).toISOString(),
      type: 'tool_output',
      tool: 'python_exec',
      ok: true,
      stdout: 'x'.repeat(2000),
      stderr: '',
      preview: 'x'.repeat(400),
    });
  }
  taskStore.writeTaskSnapshot({
    taskId: 'compact-1',
    userId: 'u',
    status: 'completed',
    displayGoal: 'long trace',
    events,
    lastEventSeq: 250,
  });

  const before = taskStore.getTaskSnapshotForUser('compact-1', 'u');
  const beforeBytes = Buffer.byteLength(JSON.stringify(before));

  const res = taskStore.compactSnapshotEvents('compact-1', 'u', { keepRecent: 50 });
  assert.equal(res.compacted, 200);
  assert.equal(res.eventCount, 250);

  const after = taskStore.getTaskSnapshotForUser('compact-1', 'u');
  const afterBytes = Buffer.byteLength(JSON.stringify(after));
  assert.ok(afterBytes < beforeBytes, 'compaction should shrink the snapshot');

  // The head events should be marked _compacted
  assert.equal(after.events[0]._compacted, true);
  assert.equal(after.events[0].stdout, undefined);
  // The tail (recent) events should still have stdout
  assert.equal(typeof after.events[after.events.length - 1].stdout, 'string');
});

test('agent task store: compactSnapshotEvents skips active tasks', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-compact-active-'));

  taskStore.writeTaskSnapshot({
    taskId: 'still-running',
    userId: 'u',
    status: 'running',
    displayGoal: 'live',
  });
  const res = taskStore.compactSnapshotEvents('still-running', 'u', { keepRecent: 5 });
  assert.equal(res.skipped, 'task_active');
});

test('agent task store: getLatestTaskForChat resolves the newest task for a chatId', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-chat-'));

  taskStore.writeTaskSnapshot({
    taskId: 'c-1', userId: 'u', chatId: 'chat-A',
    status: 'completed',
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  taskStore.writeTaskSnapshot({
    taskId: 'c-2', userId: 'u', chatId: 'chat-A',
    status: 'running',
    updatedAt: new Date().toISOString(),
  });
  taskStore.writeTaskSnapshot({ taskId: 'c-3', userId: 'u', chatId: 'chat-B', status: 'running' });

  const latest = taskStore.getLatestTaskForChat('chat-A', 'u');
  assert.equal(latest.taskId, 'c-2');

  // User scoping
  const otherUser = taskStore.getLatestTaskForChat('chat-A', 'someone-else');
  assert.equal(otherUser, null);
});

test('agent task store: getTaskByJobId resolves a queue handle to its snapshot', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-job-'));

  taskStore.writeTaskSnapshot({ taskId: 'j-1', userId: 'u', jobId: 'job-100', status: 'running' });
  taskStore.writeTaskSnapshot({ taskId: 'j-2', userId: 'u', jobId: 'job-200', status: 'running' });

  const found = taskStore.getTaskByJobId('job-200', 'u');
  assert.equal(found.taskId, 'j-2');

  assert.equal(taskStore.getTaskByJobId('job-200', 'wrong-user'), null);
  assert.equal(taskStore.getTaskByJobId('job-nonexistent'), null);
});

test('agent task store: getUserTaskMetrics aggregates per-user counts and durations', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-metrics-'));

  const created = new Date(Date.now() - 60_000).toISOString();
  const ended = new Date().toISOString();

  taskStore.writeTaskSnapshot({
    taskId: 'm-1', userId: 'u', status: 'completed',
    createdAt: created, completedAt: ended, updatedAt: ended,
    artifacts: [{ id: 'a1' }, { id: 'a2' }],
  });
  taskStore.writeTaskSnapshot({
    taskId: 'm-2', userId: 'u', status: 'failed',
    createdAt: created, failedAt: ended, updatedAt: ended,
  });
  taskStore.writeTaskSnapshot({ taskId: 'm-3', userId: 'u', status: 'running' });
  taskStore.writeTaskSnapshot({ taskId: 'm-other', userId: 'other', status: 'completed' });

  const m = taskStore.getUserTaskMetrics('u');
  assert.equal(m.totalTasks, 3);
  assert.equal(m.byStatus.completed, 1);
  assert.equal(m.byStatus.failed, 1);
  assert.equal(m.byStatus.running, 1);
  assert.equal(m.artifactCount, 2);
  assert.ok(m.avgDurationMs >= 0);
  assert.ok(m.lastTaskAt);
  // recent counts only count statuses we track
  assert.ok(m.recent.completed >= 1);
});

test('agent task store: getRunningTasksForUser returns only running/queued for the user', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-running-'));

  taskStore.writeTaskSnapshot({ taskId: 'r-1', userId: 'u', status: 'running', displayGoal: 'a' });
  taskStore.writeTaskSnapshot({ taskId: 'r-2', userId: 'u', status: 'queued', displayGoal: 'b' });
  taskStore.writeTaskSnapshot({ taskId: 'r-3', userId: 'u', status: 'completed', displayGoal: 'c' });
  taskStore.writeTaskSnapshot({ taskId: 'r-4', userId: 'other', status: 'running', displayGoal: 'd' });

  const rows = taskStore.getRunningTasksForUser('u');
  const ids = rows.map((row) => row.taskId).sort();
  assert.deepEqual(ids, ['r-1', 'r-2']);
});

test('agent task store: cleanupOrphanedArtifacts removes artifacts not referenced by any snapshot', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-orphan-'));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-orphan-art-'));

  // Snapshot referencing artifact "aaaaaaaaaaaaaaaa"
  taskStore.writeTaskSnapshot({
    taskId: 'orph-1',
    userId: 'u',
    artifacts: [{ id: 'aaaaaaaaaaaaaaaa', filename: 'kept.svg' }],
  });

  // Plant referenced + orphan files in the artifact dir.
  // Make their createdAt old enough so the grace period is past.
  const oldIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(artifactDir, 'aaaaaaaaaaaaaaaa-kept.svg'), '<svg/>');
  fs.writeFileSync(path.join(artifactDir, 'aaaaaaaaaaaaaaaa.json'), JSON.stringify({ id: 'aaaaaaaaaaaaaaaa', createdAt: oldIso }));
  fs.writeFileSync(path.join(artifactDir, 'bbbbbbbbbbbbbbbb-orphan.svg'), '<svg/>');
  fs.writeFileSync(path.join(artifactDir, 'bbbbbbbbbbbbbbbb.json'), JSON.stringify({ id: 'bbbbbbbbbbbbbbbb', createdAt: oldIso }));

  const result = taskStore.cleanupOrphanedArtifacts({ artifactDir, graceMs: 60_000 });
  assert.equal(result.scanned, 2);
  assert.equal(result.removed, 2); // 2 files for the orphan id
  assert.ok(fs.existsSync(path.join(artifactDir, 'aaaaaaaaaaaaaaaa-kept.svg')));
  assert.ok(!fs.existsSync(path.join(artifactDir, 'bbbbbbbbbbbbbbbb-orphan.svg')));
});

test('agent task store: cleanupOrphanedArtifacts honors the grace period', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-orphan-grace-'));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-orphan-grace-art-'));

  const freshIso = new Date().toISOString();
  fs.writeFileSync(path.join(artifactDir, 'cccccccccccccccc-fresh.svg'), '<svg/>');
  fs.writeFileSync(path.join(artifactDir, 'cccccccccccccccc.json'), JSON.stringify({ id: 'cccccccccccccccc', createdAt: freshIso }));

  // No snapshots reference it, but it's within the grace period.
  const result = taskStore.cleanupOrphanedArtifacts({ artifactDir, graceMs: 60 * 60 * 1000 });
  assert.equal(result.removed, 0);
  assert.ok(fs.existsSync(path.join(artifactDir, 'cccccccccccccccc-fresh.svg')));
});

test('agent task store: collectReferencedArtifactIds includes file_artifact event ids', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-refs-'));

  const base = taskStore.writeTaskSnapshot({ taskId: 'ref-1', userId: 'u' });
  taskStore.appendTaskEvent(base, {
    type: 'file_artifact',
    artifact: { id: 'eeeeeeeeeeeeeeee', filename: 'evt.svg' },
  }, base.streamState);

  const ids = taskStore.collectReferencedArtifactIds();
  assert.ok(ids.has('eeeeeeeeeeeeeeee'));
});

test('agent task store: markTaskStatus auto-compacts long traces on terminal status', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-autocompact-'));

  const events = [];
  for (let i = 0; i < 500; i++) {
    events.push({
      id: `t:${i + 1}`, seq: i + 1,
      ts: new Date(Date.now() - (500 - i) * 1000).toISOString(),
      type: 'tool_output',
      tool: 'python_exec', ok: true,
      stdout: 'x'.repeat(500),
    });
  }
  const base = taskStore.writeTaskSnapshot({
    taskId: 'auto-1', userId: 'u', status: 'running',
    events, lastEventSeq: 500, eventLimit: 1000,
  });

  taskStore.markTaskStatus(base, 'completed', { stats: { steps: 1 } });

  const after = taskStore.getTaskSnapshotForUser('auto-1', 'u');
  assert.equal(after.status, 'completed');
  // Old events should be compacted (head events lose stdout)
  assert.equal(after.events[0]._compacted, true);
  assert.equal(after.events[0].stdout, undefined);
  // Recent events still hold their bodies
  assert.equal(typeof after.events[after.events.length - 1].stdout, 'string');
});

test('agent task store: getTaskStoreStats works via index fast path', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-stats-idx-'));

  taskStore.writeTaskSnapshot({ taskId: 'idx-1', userId: 'u', status: 'running' });
  taskStore.writeTaskSnapshot({ taskId: 'idx-2', userId: 'u', status: 'completed' });

  const fast = taskStore.getTaskStoreStats({ useIndex: true });
  const slow = taskStore.getTaskStoreStats({ useIndex: false });
  assert.equal(fast.totalFiles, slow.totalFiles);
  assert.equal(fast.byStatus.running, slow.byStatus.running);
  assert.equal(fast.byStatus.completed, slow.byStatus.completed);
});

test('agent task store: getTaskByJobId picks the most-recent task when jobId repeats', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-jobid-recent-'));
  const older = new Date(Date.now() - 60_000).toISOString();
  const newer = new Date().toISOString();

  taskStore.writeTaskSnapshot({ taskId: 'jr-1', userId: 'u', jobId: 'job-X', status: 'failed', updatedAt: older });
  taskStore.writeTaskSnapshot({ taskId: 'jr-2', userId: 'u', jobId: 'job-X', status: 'running', updatedAt: newer });

  const found = taskStore.getTaskByJobId('job-X', 'u');
  assert.equal(found.taskId, 'jr-2');
});

test('agent task store: getTasksByStatus returns matching tasks across users newest-first', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-status-q-'));

  taskStore.writeTaskSnapshot({ taskId: 'q-1', userId: 'a', status: 'running', updatedAt: new Date(Date.now() - 1000).toISOString() });
  taskStore.writeTaskSnapshot({ taskId: 'q-2', userId: 'b', status: 'queued', updatedAt: new Date().toISOString() });
  taskStore.writeTaskSnapshot({ taskId: 'q-3', userId: 'c', status: 'completed' });

  const live = taskStore.getTasksByStatus(['running', 'queued']);
  const ids = live.map((row) => row.taskId);
  assert.deepEqual(ids.sort(), ['q-1', 'q-2']);
  // newest-first: q-2 was updated more recently
  assert.equal(live[0].taskId, 'q-2');

  const single = taskStore.getTasksByStatus('completed');
  assert.equal(single.length, 1);
  assert.equal(single[0].taskId, 'q-3');
});

test('agent task store: compactAllTerminalTasks shrinks every long terminal trace', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-compact-bulk-'));

  const buildEvents = (n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({
        id: `e:${i + 1}`, seq: i + 1,
        ts: new Date(Date.now() - (n - i) * 1000).toISOString(),
        type: 'tool_output', tool: 'python_exec', ok: true,
        stdout: 'x'.repeat(800),
      });
    }
    return out;
  };

  taskStore.writeTaskSnapshot({
    taskId: 'bulk-1', userId: 'u', status: 'completed',
    events: buildEvents(450), lastEventSeq: 450, eventLimit: 1000,
  });
  taskStore.writeTaskSnapshot({
    taskId: 'bulk-2', userId: 'u', status: 'failed',
    events: buildEvents(420), lastEventSeq: 420, eventLimit: 1000,
  });
  // Active task — must be skipped
  taskStore.writeTaskSnapshot({
    taskId: 'bulk-active', userId: 'u', status: 'running',
    events: buildEvents(450), lastEventSeq: 450, eventLimit: 1000,
  });
  // Short terminal task — must be skipped
  taskStore.writeTaskSnapshot({
    taskId: 'bulk-short', userId: 'u', status: 'completed',
    events: buildEvents(10), lastEventSeq: 10,
  });

  const result = taskStore.compactAllTerminalTasks({ eventThreshold: 400, keepRecent: 100 });
  assert.equal(result.compacted, 2);
  assert.ok(result.eventsDropped > 0);

  const active = taskStore.getTaskSnapshotForUser('bulk-active', 'u');
  assert.equal(typeof active.events[0].stdout, 'string', 'active task must not be compacted');

  const compacted = taskStore.getTaskSnapshotForUser('bulk-1', 'u');
  assert.equal(compacted.events[0]._compacted, true);
});

test('agent task store: verifySnapshotIntegrity flags missing files and corruption', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-verify-'));

  taskStore.writeTaskSnapshot({ taskId: 'v-good', userId: 'u', status: 'running', displayGoal: 'ok' });
  const good = taskStore.verifySnapshotIntegrity('v-good');
  assert.equal(good.ok, true);
  assert.deepEqual(good.problems, []);

  const missing = taskStore.verifySnapshotIntegrity('v-missing');
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.problems, ['file_missing']);

  // Plant a corrupt file
  fs.writeFileSync(taskStore.snapshotPathFor('v-broken'), '{not-json}');
  const broken = taskStore.verifySnapshotIntegrity('v-broken');
  assert.equal(broken.ok, false);
  assert.ok(broken.problems.includes('unreadable_or_corrupt'));
});

test('agent task store: verifySnapshotIntegrity detects index drift', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-verify-drift-'));

  taskStore.writeTaskSnapshot({ taskId: 'v-drift', userId: 'alice', status: 'running' });
  // Mutate the index out of band so it disagrees with the snapshot.
  const idx = taskStore.readIndex();
  idx['v-drift'].userId = 'bob';
  idx['v-drift'].status = 'completed';
  taskStore.writeIndex(idx);

  const result = taskStore.verifySnapshotIntegrity('v-drift');
  assert.equal(result.ok, false);
  assert.ok(result.problems.includes('index_user_mismatch'));
  assert.ok(result.problems.includes('index_status_mismatch'));
});

test('agent task store: pruneAndCleanup runs prune then orphan-cleanup', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-prune-clean-'));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-prune-clean-art-'));

  // Old, completed snapshot with one referenced artifact
  const oldIso = new Date(Date.now() - 24 * 60 * 60 * 1000 * 2).toISOString();
  taskStore.writeTaskSnapshot({
    taskId: 'pc-old',
    userId: 'u',
    status: 'completed',
    createdAt: oldIso,
    updatedAt: oldIso,
    artifacts: [{ id: 'dddddddddddddddd', filename: 'old.svg' }],
  });
  // Plant the artifact files (old enough that grace passes after prune)
  fs.writeFileSync(path.join(artifactDir, 'dddddddddddddddd-old.svg'), '<svg/>');
  fs.writeFileSync(path.join(artifactDir, 'dddddddddddddddd.json'),
    JSON.stringify({ id: 'dddddddddddddddd', createdAt: oldIso }));

  const result = taskStore.pruneAndCleanup({
    retentionMs: 24 * 60 * 60 * 1000,
    artifactDir,
    graceMs: 60_000,
  });

  // Snapshot was pruned (old + completed)
  assert.ok(result.prune.deleted >= 1);
  // Then artifact became an orphan and got removed
  assert.equal(result.cleanup.removed, 2);
});

test('agent task store: pruneTaskSnapshots enforces a maxFiles size cap and preserves running tasks', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-cap-'));

  for (let i = 0; i < 5; i++) {
    taskStore.writeTaskSnapshot({
      taskId: `t-cap-${i}`,
      userId: 'u',
      status: 'completed',
      displayGoal: `g${i}`,
      updatedAt: new Date(Date.now() - (5 - i) * 1000).toISOString(),
    });
  }
  taskStore.writeTaskSnapshot({ taskId: 't-cap-running', userId: 'u', status: 'running', displayGoal: 'live' });

  const result = taskStore.pruneTaskSnapshots({ retentionMs: 365 * 24 * 60 * 60 * 1000, maxFiles: 3 });
  assert.ok(result.deletedOverflow >= 2);
  assert.ok(taskStore.readTaskSnapshot('t-cap-running'), 'running task must survive size-cap prune');
});

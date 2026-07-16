'use strict';

const { afterEach, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/services/agents/task-flow-store');

let previousDir;
let tmpDir;

beforeEach(() => {
  previousDir = process.env.SIRAGPT_TASK_FLOW_STORE_DIR;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-task-flow-'));
  process.env.SIRAGPT_TASK_FLOW_STORE_DIR = tmpDir;
});

afterEach(() => {
  if (previousDir == null) delete process.env.SIRAGPT_TASK_FLOW_STORE_DIR;
  else process.env.SIRAGPT_TASK_FLOW_STORE_DIR = previousDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createFixture(overrides = {}) {
  return store.createManagedTaskFlow({
    flowId: overrides.flowId || 'flow-test-1',
    userId: overrides.userId || 'user-a',
    chatId: 'chat-a',
    controllerId: 'siragpt/test',
    goal: 'Complete a durable research task',
    currentStep: 'plan',
    stateJson: { sources: [] },
  });
}

test('creates an owner-scoped managed task flow', () => {
  const created = createFixture();
  assert.equal(created.status, 'running');
  assert.equal(created.revision, 1);
  assert.equal(store.getTaskFlowForUser(created.flowId, 'user-a').flowId, created.flowId);
  assert.equal(store.getTaskFlowForUser(created.flowId, 'user-b'), null);
  assert.equal(created.events[0].type, 'flow_created');
});

test('rejects an empty flow goal before writing a record', () => {
  assert.throws(
    () => store.createManagedTaskFlow({ flowId: 'flow-empty', userId: 'user-a', goal: '   ' }),
    (error) => error.code === 'invalid_goal',
  );
  assert.equal(fs.existsSync(path.join(tmpDir, 'flow-empty.json')), false);
});

test('never replaces an existing flow record during creation', () => {
  const original = createFixture({ flowId: 'flow-exclusive' });
  assert.throws(
    () => store.createManagedTaskFlow({
      flowId: original.flowId,
      userId: 'user-b',
      goal: 'Replace another owner flow',
    }),
    (error) => error.code === 'flow_exists',
  );
  assert.equal(store.getTaskFlowForUser(original.flowId, 'user-a').goal, original.goal);
  assert.equal(store.getTaskFlowForUser(original.flowId, 'user-b'), null);
});

test('waits, resumes, and finishes while carrying state forward', async () => {
  const created = createFixture();
  const waiting = await store.setTaskFlowWaiting({
    flowId: created.flowId,
    userId: 'user-a',
    expectedRevision: created.revision,
    currentStep: 'await_review',
    stateJson: { sources: ['doc-1'] },
    waitJson: { kind: 'human_review' },
  });
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.revision, 2);
  assert.deepEqual(waiting.waitJson, { kind: 'human_review' });

  const resumed = await store.resumeTaskFlow({
    flowId: created.flowId,
    userId: 'user-a',
    expectedRevision: waiting.revision,
    currentStep: 'finalize',
  });
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.waitJson, null);

  const completed = await store.finishTaskFlow({
    flowId: created.flowId,
    userId: 'user-a',
    expectedRevision: resumed.revision,
    stateJson: { sources: ['doc-1'], delivered: true },
  });
  assert.equal(completed.status, 'completed');
  assert.ok(completed.completedAt);
  assert.equal(completed.stateJson.delivered, true);
});

test('rejects stale revisions under concurrent mutation', async () => {
  const created = createFixture();
  const args = { flowId: created.flowId, userId: 'user-a', expectedRevision: created.revision };
  const results = await Promise.allSettled([
    store.setTaskFlowWaiting({ ...args, waitJson: { kind: 'external' } }),
    store.blockTaskFlow({ ...args, blockedSummary: 'Waiting for approval' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'revision_conflict');
  assert.equal(store.getTaskFlowForUser(created.flowId, 'user-a').revision, 2);
});

test('links and updates a child task without duplicating it', async () => {
  const created = createFixture();
  const linked = await store.linkTaskFlowChild({
    flowId: created.flowId,
    userId: 'user-a',
    expectedRevision: 1,
    childTask: { taskId: 'task-1', status: 'queued', runId: 'job-1' },
  });
  assert.equal(linked.childTasks.length, 1);
  assert.equal(linked.childTasks[0].status, 'queued');

  const updated = await store.linkTaskFlowChild({
    flowId: created.flowId,
    userId: 'user-a',
    expectedRevision: 2,
    childTask: { taskId: 'task-1', status: 'completed', completedAt: new Date().toISOString() },
  });
  assert.equal(updated.childTasks.length, 1);
  assert.equal(updated.childTasks[0].status, 'completed');
});

test('enforces owner scope, state bounds, and terminal transitions', async () => {
  const created = createFixture();
  await assert.rejects(
    store.finishTaskFlow({ flowId: created.flowId, userId: 'user-b', expectedRevision: 1 }),
    (error) => error.code === 'flow_not_found',
  );
  await assert.rejects(
    store.setTaskFlowWaiting({
      flowId: created.flowId,
      userId: 'user-a',
      expectedRevision: 1,
      stateJson: { oversized: 'x'.repeat(store.MAX_STATE_CHARS + 1) },
    }),
    (error) => error.code === 'state_too_large',
  );
  const cancelled = await store.cancelTaskFlow({
    flowId: created.flowId,
    userId: 'user-a',
    expectedRevision: 1,
    reason: 'User stopped the workflow',
  });
  await assert.rejects(
    store.resumeTaskFlow({ flowId: created.flowId, userId: 'user-a', expectedRevision: cancelled.revision }),
    (error) => error.code === 'flow_terminal',
  );
});

test('lists only the current owner and supports status filters', async () => {
  createFixture({ flowId: 'flow-a', userId: 'user-a' });
  const second = createFixture({ flowId: 'flow-b', userId: 'user-a' });
  createFixture({ flowId: 'flow-c', userId: 'user-b' });
  await store.finishTaskFlow({ flowId: second.flowId, userId: 'user-a', expectedRevision: 1 });

  assert.equal(store.listTaskFlowsForUser('user-a').length, 2);
  const completed = store.listTaskFlowsForUser('user-a', { status: ['completed'] });
  assert.equal(completed.length, 1);
  assert.equal(completed[0].flowId, 'flow-b');
});

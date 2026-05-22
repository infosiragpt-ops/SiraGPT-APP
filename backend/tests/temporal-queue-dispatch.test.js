'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const QUEUE_PATH = path.resolve(__dirname, '../src/services/agents/agent-task-queue');
const CLIENT_PATH = path.resolve(__dirname, '../src/services/agents/temporal/temporal-client');

function freshQueueModule({ temporalClientStub }) {
  delete require.cache[require.resolve(QUEUE_PATH)];
  delete require.cache[require.resolve(CLIENT_PATH)];
  if (temporalClientStub) {
    require.cache[require.resolve(CLIENT_PATH)] = {
      id: require.resolve(CLIENT_PATH),
      filename: require.resolve(CLIENT_PATH),
      loaded: true,
      exports: temporalClientStub,
    };
  }
  // eslint-disable-next-line global-require
  return require(QUEUE_PATH);
}

test('enqueueAgentTask: dispatches to Temporal when shouldUseTemporalForTaskType is true', async () => {
  let startCalled = null;
  const stub = {
    shouldUseTemporalForTaskType: (taskType) => taskType === 'research',
    startAgentTaskWorkflow: async (opts) => {
      startCalled = opts;
      return { workflowId: 'wf-task-1', runId: 'run-1' };
    },
  };
  const queue = freshQueueModule({ temporalClientStub: stub });
  const result = await queue.enqueueAgentTask({ taskId: 'task-1', taskType: 'research', userId: 'u1' });
  assert.equal(result._temporal, true);
  assert.equal(result.id, 'wf-task-1');
  assert.equal(startCalled.taskType, 'research');
  assert.equal(startCalled.idempotencyKey, 'task-1');
});

test('enqueueAgentTask: falls back to BullMQ when Temporal returns null', async () => {
  const stub = {
    shouldUseTemporalForTaskType: () => true,
    startAgentTaskWorkflow: async () => null,
  };
  const queue = freshQueueModule({ temporalClientStub: stub });
  // BullMQ path requires REDIS_URL — make sure we hit it (and fail with
  // the documented error) rather than silently dispatching to Temporal.
  const prev = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  try {
    await assert.rejects(
      () => queue.enqueueAgentTask({ taskId: 't', taskType: 'research' }),
      /REDIS_URL is required/
    );
  } finally {
    if (prev !== undefined) process.env.REDIS_URL = prev;
  }
});

test('enqueueAgentTask: Temporal dispatch error falls back to BullMQ (does not throw)', async () => {
  const stub = {
    shouldUseTemporalForTaskType: () => true,
    startAgentTaskWorkflow: async () => { throw new Error('temporal down'); },
  };
  const queue = freshQueueModule({ temporalClientStub: stub });
  const prev = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  try {
    // Should NOT rethrow 'temporal down' — it should fall through to
    // BullMQ which then complains about REDIS_URL. That proves the
    // fallback path executed.
    await assert.rejects(
      () => queue.enqueueAgentTask({ taskId: 't', taskType: 'research' }),
      /REDIS_URL is required/
    );
  } finally {
    if (prev !== undefined) process.env.REDIS_URL = prev;
  }
});

test('workflow type contract: client starts a name that the worker bundle exports', () => {
  // Pins the workflow-type contract: the name `startAgentTaskWorkflow`
  // passes to `client.workflow.start(...)` MUST match a function
  // exported by the workflow bundle the worker registers, and the
  // activity bundle MUST export the activity the workflow proxies to.
  // We can't `require()` the workflow file directly (it pulls in
  // `@temporalio/workflow` which is only valid inside a worker
  // sandbox), so we assert against the source — same effect, no SDK
  // install needed at test time.
  const fs = require('fs');
  const path = require('path');
  const workflowSrc = fs.readFileSync(
    path.resolve(__dirname, '../src/services/agents/temporal/workflows/agent-task.workflow.js'),
    'utf8'
  );
  const activitySrc = fs.readFileSync(
    path.resolve(__dirname, '../src/services/agents/temporal/activities/agent-task.activity.js'),
    'utf8'
  );
  const clientSrc = fs.readFileSync(
    path.resolve(__dirname, '../src/services/agents/temporal/temporal-client.js'),
    'utf8'
  );
  assert.match(workflowSrc, /async function runAgentTaskWorkflow\b/);
  assert.match(workflowSrc, /module\.exports[\s\S]*runAgentTaskWorkflow/);
  assert.match(activitySrc, /async function runAgentTaskActivity\b/);
  assert.match(activitySrc, /module\.exports[\s\S]*runAgentTaskActivity/);
  // Workflow proxies to the same activity name the bundle exports.
  assert.match(workflowSrc, /proxyActivities[\s\S]*runAgentTaskActivity/);
  // Client starts the workflow by the same function name.
  assert.match(clientSrc, /workflowType\s*\|\|\s*['"]runAgentTaskWorkflow['"]/);
});

test('enqueueAgentTask: rejects payload without taskId before checking Temporal', async () => {
  let temporalChecked = false;
  const stub = {
    shouldUseTemporalForTaskType: () => { temporalChecked = true; return true; },
    startAgentTaskWorkflow: async () => ({ workflowId: 'x', runId: 'y' }),
  };
  const queue = freshQueueModule({ temporalClientStub: stub });
  await assert.rejects(
    () => queue.enqueueAgentTask({ taskType: 'research' }),
    /taskId is required/
  );
  assert.equal(temporalChecked, false);
});

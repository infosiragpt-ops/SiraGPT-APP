'use strict';

// Per-user in-flight concurrency cap on agent-task creation (brain-infra
// roadmap: "concurrencia con rate limiting por usuario"). One user must not
// monopolise the worker pool; above the cap → 429 + active task list.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const taskStore = require('../src/services/agents/task-store');

function loadCheck() {
  // The helper lives in the route module; require pulls the whole router but
  // the check function is module-private — exercise it through a stub pair.
  delete require.cache[require.resolve('../src/routes/agent-task.js')];
  const mod = require('../src/routes/agent-task.js');
  return mod.checkUserInflightCap || (mod.__test && mod.__test.checkUserInflightCap);
}

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('cap allows under limit, rejects at limit with 429 + task list', () => {
  const check = loadCheck();
  assert.equal(typeof check, 'function', 'checkUserInflightCap must be exported for tests');
  const orig = taskStore.getRunningTasksForUser;
  try {
    process.env.SIRAGPT_MAX_INFLIGHT_TASKS = '2';
    // under limit
    taskStore.getRunningTasksForUser = () => [{ taskId: 'a', status: 'running', displayGoal: 'x' }];
    let res = fakeRes();
    assert.equal(check({ user: { id: 'u1' } }, res), true);
    assert.equal(res.statusCode, null);
    // at limit
    taskStore.getRunningTasksForUser = () => [
      { taskId: 'a', status: 'running', displayGoal: 'x' },
      { taskId: 'b', status: 'queued', displayGoal: 'y'.repeat(300) },
    ];
    res = fakeRes();
    assert.equal(check({ user: { id: 'u1' } }, res), false);
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.code, 'inflight_cap');
    assert.equal(res.body.activeTasks.length, 2);
    assert.ok(res.body.activeTasks[1].displayGoal.length <= 120, 'goal capped at 120 chars');
  } finally {
    taskStore.getRunningTasksForUser = orig;
    delete process.env.SIRAGPT_MAX_INFLIGHT_TASKS;
  }
});

test('cap disabled with <=0 and fails open on store errors', () => {
  const check = loadCheck();
  const orig = taskStore.getRunningTasksForUser;
  try {
    process.env.SIRAGPT_MAX_INFLIGHT_TASKS = '0';
    taskStore.getRunningTasksForUser = () => { throw new Error('should not be called'); };
    assert.equal(check({ user: { id: 'u1' } }, fakeRes()), true);

    process.env.SIRAGPT_MAX_INFLIGHT_TASKS = '3';
    taskStore.getRunningTasksForUser = () => { throw new Error('store down'); };
    const res = fakeRes();
    assert.equal(check({ user: { id: 'u1' } }, res), true, 'store error must fail open');
    assert.equal(res.statusCode, null);
  } finally {
    taskStore.getRunningTasksForUser = orig;
    delete process.env.SIRAGPT_MAX_INFLIGHT_TASKS;
  }
});

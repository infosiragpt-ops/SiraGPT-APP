'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the inline route's actual persistence closures with local adapters.
// This is a consumer regression test, not an authenticated HTTP/E2E test. The
// extraction avoids initializing providers, Prisma, queues or paid AI calls.
function harness({ update = async () => ({}) } = {}) {
  const filename = path.join(__dirname, '../src/routes/agent-task.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('    let assistantMessageId = null;');
  const end = source.indexOf('    const applyEvent = (obj) =>', start);
  assert.ok(start >= 0 && end > start, 'inline persistence block remains identifiable');
  const task = { taskId: 'fixture-inline', status: 'running' };
  const writes = [];
  const state = { done: false, steps: [] };
  let now = 10_000;
  class Clock extends Date { static now() { return now; } }
  const context = {
    Date: Clock, setTimeout, clearTimeout,
    task, streamState: state, taskId: task.taskId,
    taskStore: { markTaskStatus: (_task, status) => writes.push(status) },
    prisma: { message: { update } },
    serializeAgentState: JSON.stringify,
    artifacts: [], displayGoal: 'Synthetic fixture', maxSteps: 1, maxRuntimeMs: 1000,
  };
  for (const key of [
    'executionProfile', 'intentAlignmentProfile', 'taskPlan', 'openclawRuntimeProfile',
    'universalTaskContract', 'enterpriseExecutionGraph', 'enterpriseRuntimeProfile',
    'enterpriseToolRuntimePlan', 'enterpriseQaBoardReview', 'agenticOperatingCore',
    'documentPolicy', 'frameworkStatus',
  ]) context[key] = {};
  vm.runInNewContext(`${source.slice(start, end)}
    assistantMessageId = 'fixture-message';
    globalThis.api = {
      schedule: schedulePersistTaskState,
      persist: persistTaskState,
      finish: finishProgressPersistence,
    };
  `, context, { filename });
  return { ...context.api, task, state, writes, advance: ms => { now += ms; } };
}

test('inline completion cancels scheduled progress and ignores final_text progress after a long model turn', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const metadata = [];
  const flow = harness({ update: async ({ data }) => { metadata.push(data.metadata.status); return {}; } });
  flow.schedule();
  flow.advance(10);
  flow.schedule(); // throttled progress timer is now outstanding
  flow.state.done = true;
  flow.state.stoppedReason = 'verification_failed';
  await flow.finish('failed');
  flow.advance(2000); // a model call lasting longer than the throttle interval
  t.mock.timers.tick(2000);
  flow.schedule(); // emit(final_text) schedules progress in the real consumer
  await flow.persist(); // direct stale progress must also be harmless
  assert.equal(flow.task.status, 'failed');
  assert.deepEqual(flow.writes, ['running']);
  assert.deepEqual(metadata, ['running']);
  await flow.persist('failed');
  assert.deepEqual(flow.writes, ['running', 'failed']);
  assert.deepEqual(metadata, ['running', 'failed']);
});

test('inline completion drains a slow progress DB update before the terminal metadata write', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const committed = [];
  const flow = harness({ update: async ({ data }) => {
    if (data.metadata.status === 'running') await waiting;
    committed.push(data.metadata.status);
    return {};
  } });
  flow.schedule();
  flow.state.done = true;
  flow.state.stoppedReason = 'verification_failed';
  let finished = false;
  const finishing = flow.finish('failed').then(() => { finished = true; });
  flow.advance(2000);
  flow.schedule();
  await Promise.resolve();
  assert.equal(finished, false, 'terminal persistence must not race an older running write');
  assert.equal(flow.task.status, 'failed');
  assert.deepEqual(flow.writes, ['running']);
  release();
  await finishing;
  await flow.persist('failed');
  assert.deepEqual(committed, ['running', 'failed']);
  assert.equal(flow.task.status, 'failed');
});

test('inline completion survives a rejected progress DB update without reopening the task', async () => {
  let reject;
  const waiting = new Promise((_resolve, rejectPromise) => { reject = rejectPromise; });
  const committed = [];
  const flow = harness({ update: async ({ data }) => {
    if (data.metadata.status === 'running') await waiting;
    committed.push(data.metadata.status);
    return {};
  } });
  flow.schedule();
  const finishing = flow.finish('cancelled');
  reject(new Error('Synthetic slow DB rejection'));
  await finishing;
  await flow.persist('cancelled');
  flow.advance(2000);
  flow.schedule();
  assert.equal(flow.task.status, 'cancelled');
  assert.deepEqual(committed, ['cancelled']);
  assert.deepEqual(flow.writes, ['running', 'cancelled']);
});

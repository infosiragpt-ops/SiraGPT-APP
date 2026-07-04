'use strict';

/**
 * Durable checkpoint/resume for the react-agent loop (brain-infra roadmap:
 * "checkpointing a BD para reanudar runs interrumpidos"). Covers:
 *  - onCheckpoint fires at step boundaries with a serializable snapshot
 *  - resumeCheckpoint re-enters the loop (trace restored, budget offset)
 *  - task-store saveRunnerCheckpoint persistence + size cap + whitelist
 *  - boot-recovery re-enqueues checkpointed tasks
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const reactAgent = require('../src/services/react-agent');

function nativeToolCall(name, args) {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: 'thinking',
        tool_calls: [{ id: `call_${name}_${Math.floor(Math.random() * 1e6)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  };
}

function makeFakeOpenAI(scripted, captured = []) {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async (params) => {
          captured.push(params);
          return scripted[Math.min(i++, scripted.length - 1)];
        },
      },
    },
  };
}

const PING_TOOL = {
  name: 'ping',
  description: 'Returns pong.',
  parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'], additionalProperties: false },
  execute: async ({ n }) => ({ pong: n }),
};

test('onCheckpoint fires per step with serializable loop state', async () => {
  const checkpoints = [];
  const openai = makeFakeOpenAI([
    nativeToolCall('ping', { n: 1 }),
    nativeToolCall('ping', { n: 2 }),
    nativeToolCall('finalize', { answer: 'done' }),
  ]);
  const result = await reactAgent.run(openai, {
    query: 'ping twice then finish',
    tools: [PING_TOOL],
    maxSteps: 6,
    onCheckpoint: (cp) => checkpoints.push(cp),
  });
  assert.equal(result.stoppedReason, 'finalized');
  assert.equal(checkpoints.length, 2, 'one checkpoint per non-final step');
  const last = checkpoints[1];
  assert.equal(last.stepsCompleted, 2);
  assert.ok(Array.isArray(last.messages) && last.messages.length >= 4);
  assert.ok(last.messages.every((m) => m.role !== 'system'), 'system head excluded');
  // must round-trip through JSON (durable persistence contract)
  const revived = JSON.parse(JSON.stringify(last));
  assert.equal(revived.stepsCompleted, 2);
});

test('resumeCheckpoint re-enters mid-run: trace restored, no repeated work', async () => {
  // First run: 2 steps then crash (simulated by capturing checkpoint + stopping)
  const checkpoints = [];
  const openai1 = makeFakeOpenAI([
    nativeToolCall('ping', { n: 1 }),
    nativeToolCall('ping', { n: 2 }),
    nativeToolCall('ping', { n: 3 }),
  ]);
  await reactAgent.run(openai1, {
    query: 'count pings',
    tools: [PING_TOOL],
    maxSteps: 3, // exhausts budget without finalize → we still got checkpoints
    onCheckpoint: (cp) => checkpoints.push(cp),
  });
  assert.ok(checkpoints.length >= 2);
  const cp = JSON.parse(JSON.stringify(checkpoints[1])); // durable copy at step 2

  // Resume: model immediately finalizes; capture the request payload
  const captured = [];
  const openai2 = makeFakeOpenAI([nativeToolCall('finalize', { answer: 'resumed fine' })], captured);
  const result = await reactAgent.run(openai2, {
    query: 'count pings',
    tools: [PING_TOOL],
    maxSteps: 6,
    resumeCheckpoint: cp,
  });
  assert.equal(result.finalAnswer, 'resumed fine');
  assert.equal(result.stoppedReason, 'finalized');
  // The restored trace must include the prior tool observations
  const sent = captured[0].messages;
  const toolMsgs = sent.filter((m) => m.role === 'tool');
  assert.ok(toolMsgs.length >= 2, `prior observations restored (got ${toolMsgs.length})`);
  assert.ok(sent.some((m) => m.role === 'user' && /REANUDACIÓN/i.test(String(m.content))), 'resume marker injected');
  // steps from the checkpoint are carried into the result
  assert.ok(result.steps.length >= 3, 'prior steps + the finalize step');
});

test('invalid/stale resumeCheckpoint is ignored (fresh start)', async () => {
  const captured = [];
  const openai = makeFakeOpenAI([nativeToolCall('finalize', { answer: 'ok' })], captured);
  const result = await reactAgent.run(openai, {
    query: 'simple',
    tools: [PING_TOOL],
    maxSteps: 4,
    resumeCheckpoint: { v: 1, stepsCompleted: 99, messages: [{ role: 'user', content: 'x' }] }, // >= maxSteps
  });
  assert.equal(result.stoppedReason, 'finalized');
  const sent = captured[0].messages;
  assert.ok(!sent.some((m) => /REANUDACIÓN/i.test(String(m.content || ''))), 'no resume marker on rejected checkpoint');
});

test('task-store persists runnerCheckpoint, caps size, clears on completed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-store-cp-'));
  process.env.AGENT_TASK_STORE_DIR = dir;
  delete require.cache[require.resolve('../src/services/agents/task-store')];
  const taskStore = require('../src/services/agents/task-store');
  try {
    const base = { taskId: 'cp-task-1', userId: 'u1', status: 'running', agentGoal: 'g', displayGoal: 'g' };
    taskStore.writeTaskSnapshot(base);
    const cp = { v: 1, stepsCompleted: 3, messages: [{ role: 'user', content: 'hola' }] };
    const written = taskStore.saveRunnerCheckpoint('cp-task-1', 'u1', cp);
    assert.equal(written.runnerCheckpoint.stepsCompleted, 3);
    // survives an unrelated event append (whitelist regression guard)
    taskStore.appendTaskEvent({ taskId: 'cp-task-1', userId: 'u1' }, { type: 'step_start', label: 'x' });
    assert.equal(taskStore.readTaskSnapshot('cp-task-1').runnerCheckpoint.stepsCompleted, 3);
    // oversized checkpoint rejected, previous kept
    const huge = { v: 1, stepsCompleted: 4, messages: [{ role: 'user', content: 'y'.repeat(800_000) }] };
    assert.equal(taskStore.saveRunnerCheckpoint('cp-task-1', 'u1', huge), null);
    assert.equal(taskStore.readTaskSnapshot('cp-task-1').runnerCheckpoint.stepsCompleted, 3);
    // completed clears it; error keeps it
    taskStore.markTaskStatus({ taskId: 'cp-task-1', userId: 'u1' }, 'completed');
    assert.equal(taskStore.readTaskSnapshot('cp-task-1').runnerCheckpoint, null);
  } finally {
    delete process.env.AGENT_TASK_STORE_DIR;
    delete require.cache[require.resolve('../src/services/agents/task-store')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('boot recovery re-enqueues checkpointed tasks with resume payload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-resume-'));
  process.env.AGENT_TASK_STORE_DIR = dir;
  delete require.cache[require.resolve('../src/services/agents/task-store')];
  const taskStore = require('../src/services/agents/task-store');
  delete require.cache[require.resolve('../src/services/agents/agent-task-boot-recovery')];
  const bootRecovery = require('../src/services/agents/agent-task-boot-recovery');
  try {
    // one task WITH checkpoint, one WITHOUT
    taskStore.writeTaskSnapshot({
      taskId: 'boot-a', userId: 'u1', status: 'error', agentGoal: 'do the thing', displayGoal: 'do the thing',
      model: 'gpt-4o', maxSteps: 40,
      runnerCheckpoint: { v: 1, stepsCompleted: 5, messages: [{ role: 'user', content: 'q' }] },
    });
    taskStore.writeTaskSnapshot({ taskId: 'boot-b', userId: 'u1', status: 'error', agentGoal: 'other', displayGoal: 'other' });

    const enqueued = [];
    const result = await bootRecovery.resumeCheckpointedTasks({
      env: { REDIS_URL: 'redis://x' },
      taskStore,
      recoveredRows: [
        { taskId: 'boot-a', userId: 'u1' },
        { taskId: 'boot-b', userId: 'u1' },
      ],
      enqueue: async (payload, opts) => { enqueued.push({ payload, opts }); return { id: opts.jobId }; },
    });
    assert.equal(result.resumed, 1, 'only the checkpointed task is re-enqueued');
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].payload.taskId, 'boot-a');
    assert.equal(enqueued[0].payload.resumeCheckpoint.stepsCompleted, 5);
    assert.ok(/boot-resume-/.test(enqueued[0].opts.jobId), 'fresh jobId avoids BullMQ collision');
    const after = taskStore.readTaskSnapshot('boot-a');
    assert.equal(after.status, 'queued');
    assert.equal(after.streamState.done, false);
  } finally {
    delete process.env.AGENT_TASK_STORE_DIR;
    delete require.cache[require.resolve('../src/services/agents/task-store')];
    delete require.cache[require.resolve('../src/services/agents/agent-task-boot-recovery')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('boot resume respects the per-boot limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-limit-'));
  process.env.AGENT_TASK_STORE_DIR = dir;
  delete require.cache[require.resolve('../src/services/agents/task-store')];
  const taskStore = require('../src/services/agents/task-store');
  delete require.cache[require.resolve('../src/services/agents/agent-task-boot-recovery')];
  const bootRecovery = require('../src/services/agents/agent-task-boot-recovery');
  try {
    const rows = [];
    for (let i = 0; i < 4; i += 1) {
      taskStore.writeTaskSnapshot({
        taskId: `lim-${i}`, userId: 'u1', status: 'error', agentGoal: 'g', displayGoal: 'g',
        runnerCheckpoint: { v: 1, stepsCompleted: 2, messages: [{ role: 'user', content: 'q' }] },
      });
      rows.push({ taskId: `lim-${i}`, userId: 'u1' });
    }
    const enqueued = [];
    const result = await bootRecovery.resumeCheckpointedTasks({
      env: { REDIS_URL: 'redis://x', AGENT_TASK_BOOT_RESUME_LIMIT: '2' },
      taskStore,
      recoveredRows: rows,
      enqueue: async (payload, opts) => { enqueued.push(payload.taskId); return { id: opts.jobId }; },
    });
    assert.equal(result.resumed, 2);
    assert.equal(enqueued.length, 2);
  } finally {
    delete process.env.AGENT_TASK_STORE_DIR;
    delete require.cache[require.resolve('../src/services/agents/task-store')];
    delete require.cache[require.resolve('../src/services/agents/agent-task-boot-recovery')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

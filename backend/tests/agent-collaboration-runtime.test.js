/**
 * Runtime-shape tests for agent-collaboration.
 *
 * These stub runAgentTaskJob before loading the collaboration module so the
 * tests cover orchestration behavior without invoking OpenAI or workers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

function loadCollaborationWithRunner(runAgentTaskJob) {
  const runnerPath = require.resolve('../src/services/agents/agent-task-runner');
  const collaborationPath = require.resolve('../src/services/agents/agent-collaboration');
  const originalRunner = require.cache[runnerPath];
  const originalCollaboration = require.cache[collaborationPath];

  delete require.cache[collaborationPath];
  require.cache[runnerPath] = {
    id: runnerPath,
    filename: runnerPath,
    loaded: true,
    exports: { runAgentTaskJob },
  };

  const collaboration = require(collaborationPath);

  return {
    collaboration,
    restore() {
      delete require.cache[collaborationPath];
      if (originalCollaboration) require.cache[collaborationPath] = originalCollaboration;
      if (originalRunner) {
        require.cache[runnerPath] = originalRunner;
      } else {
        delete require.cache[runnerPath];
      }
    },
  };
}

test('forkJoin runs only valid tasks and forwards task/runtime options', async () => {
  const calls = [];
  const { collaboration, restore } = loadCollaborationWithRunner(async (payload, job) => {
    calls.push({ payload, job });
    return { ok: true, output: `done:${payload.goal}` };
  });

  try {
    const result = await collaboration.forkJoin({
      user: { id: 'user-1' },
      options: { chatId: 'chat-1', maxSteps: 9, maxRuntimeMs: 1234 },
      subTasks: [
        { goal: 'first', context: { a: 1 } },
        { goal: '   ' },
        { goal: 'second', taskId: 'task-2', maxSteps: 3 },
      ],
    });

    assert.equal(result.ok, true);
    assert.equal(result.pattern, 'fork_join');
    assert.equal(result.totalSubAgents, 2);
    assert.equal(result.results.length, 2);
    assert.deepEqual(result.results.map((r) => r.goal), ['first', 'second']);
    assert.deepEqual(result.results.map((r) => r.result.output), ['done:first', 'done:second']);

    assert.equal(calls.length, 2);
    assert.equal(calls[0].job, null);
    assert.equal(calls[0].payload.user.id, 'user-1');
    assert.equal(calls[0].payload.chatId, 'chat-1');
    assert.equal(calls[0].payload.maxSteps, 9);
    assert.equal(calls[0].payload.maxRuntimeMs, 1234);
    assert.deepEqual(calls[0].payload.context, { a: 1 });
    assert.equal(calls[1].payload.taskId, 'task-2');
    assert.equal(calls[1].payload.maxSteps, 3);
  } finally {
    restore();
  }
});

test('forkJoin returns ok:false when every sub-task explicitly fails', async () => {
  const { collaboration, restore } = loadCollaborationWithRunner(async (payload) => ({
    ok: false,
    error: `failed:${payload.goal}`,
  }));

  try {
    const result = await collaboration.forkJoin({
      user: { id: 'user-1' },
      subTasks: [{ goal: 'a' }, { goal: 'b' }],
    });

    assert.equal(result.ok, false);
    assert.equal(result.pattern, 'fork_join');
    assert.equal(result.results.length, 2);
    assert.deepEqual(result.results.map((r) => r.ok), [false, false]);
    assert.deepEqual(result.results.map((r) => r.result.error), ['failed:a', 'failed:b']);
  } finally {
    restore();
  }
});

test('chain passes previous output into the next task context', async () => {
  const calls = [];
  const responses = [
    { ok: true, output: 'draft result' },
    { ok: true, summary: 'review result' },
  ];
  const { collaboration, restore } = loadCollaborationWithRunner(async (payload) => {
    calls.push(payload);
    return responses.shift();
  });

  try {
    const result = await collaboration.chain({
      user: { id: 'user-1' },
      options: { chatId: 'chat-1', maxSteps: 7 },
      subTasks: [
        { goal: 'draft', context: { phase: 'draft' } },
        { goal: 'review', context: { phase: 'review' } },
      ],
    });

    assert.equal(result.ok, true);
    assert.equal(result.pattern, 'chain');
    assert.equal(result.totalSubAgents, 2);
    assert.deepEqual(result.results.map((r) => r.ok), [true, true]);

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].context, { phase: 'draft' });
    assert.deepEqual(calls[1].context, {
      previousOutput: 'draft result',
      phase: 'review',
    });
    assert.equal(calls[1].chatId, 'chat-1');
    assert.equal(calls[1].maxSteps, 7);
  } finally {
    restore();
  }
});

test('chain stops after a failed step when stopOnError is true', async () => {
  const calls = [];
  const { collaboration, restore } = loadCollaborationWithRunner(async (payload) => {
    calls.push(payload);
    throw new Error(`boom:${payload.goal}`);
  });

  try {
    const result = await collaboration.chain({
      user: { id: 'user-1' },
      options: { stopOnError: true },
      subTasks: [{ goal: 'first' }, { goal: 'second' }],
    });

    assert.equal(result.ok, false);
    assert.equal(result.stoppedEarly, true);
    assert.equal(result.totalSubAgents, 2);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].ok, false);
    assert.equal(result.results[0].result, null);
    assert.equal(result.results[0].error, 'boom:first');
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

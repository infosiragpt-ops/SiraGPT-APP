'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { run } = require('../src/services/react-agent');
const { checkToolUsageBudget, getManifest } = require('../src/services/agents/tool-manifest');

const TOOL_NAME = 'create_document';
const TOOL_LIMIT = getManifest(TOOL_NAME).usage_limits.max_calls_per_task;
const QUERY = 'Synthetic checkpoint integrity audit';

// Real ReAct dispatch and real per-task budget policy; the tool only increments
// an in-memory counter and the scripted provider never uses a network. A JSON
// round trip represents checkpoint serialization, NOT a durable-storage test.
function syntheticWriter(effects) {
  return {
    name: TOOL_NAME,
    description: 'Synthetic effect counter; does not create a file.',
    parameters: {
      type: 'object',
      properties: { filename: { type: 'string' }, python: { type: 'string' } },
      required: ['filename', 'python'],
      additionalProperties: false,
    },
    execute: async () => ({ ok: true, effect: ++effects.count }),
  };
}

function scripted(names = []) {
  let index = 0;
  const requests = [];
  return {
    requests,
    chat: { completions: { create: async (request) => {
      requests.push(structuredClone(request));
      const name = names[index++] || 'finalize';
      return { choices: [{ message: {
        role: 'assistant', content: '',
        tool_calls: [{
          id: `synthetic-resume-${index}`, type: 'function', function: {
            name,
            arguments: JSON.stringify(name === 'finalize'
              ? { answer: 'Synthetic verification complete.' }
              : { filename: 'not-created.txt', python: '# This text is never executed.' }),
          },
        }],
      } }] };
    } } },
  };
}

function newBudgetContext(overrides = {}) {
  return { toolUsageMap: {}, checkToolBudget: checkToolUsageBudget, ...overrides };
}

async function checkpointAfterWrites(effects, count, maxSteps = TOOL_LIMIT + 2) {
  const controller = new AbortController();
  let checkpoint;
  await run(scripted(Array(count).fill(TOOL_NAME)), {
    query: QUERY, tools: [syntheticWriter(effects)], model: 'test-model', maxSteps,
    ctx: newBudgetContext({ signal: controller.signal }),
    onCheckpoint: async (snapshot) => {
      checkpoint = JSON.parse(JSON.stringify(snapshot));
      if (snapshot.stepsCompleted === count) controller.abort();
    },
  });
  assert.ok(checkpoint, 'the real engine must emit a checkpoint');
  assert.equal(checkpoint.stepsCompleted, count);
  assert.equal(effects.count, count);
  return checkpoint;
}

test('resume at the completed-step limit cannot restart the loop or repeat a prior effect', async () => {
  const effects = { count: 0 };
  let checkpoint;
  await run(scripted([TOOL_NAME, 'finalize']), {
    query: QUERY, tools: [syntheticWriter(effects)], model: 'test-model', maxSteps: 2,
    finalizeGuard: async () => ({ ok: false, message: 'Synthetic verification is still required.' }),
    onCheckpoint: async (snapshot) => { checkpoint = JSON.parse(JSON.stringify(snapshot)); },
  });
  assert.equal(checkpoint.stepsCompleted, 2, 'the engine emits this boundary checkpoint itself');
  assert.equal(effects.count, 1);
  const client = scripted([TOOL_NAME, 'finalize']);
  const result = await run(client, {
    query: QUERY, tools: [syntheticWriter(effects)], model: 'test-model', maxSteps: 2,
    resumeCheckpoint: checkpoint,
  });
  assert.equal(client.requests.length, 0, 'an exhausted checkpoint has no model-step budget left');
  assert.equal(effects.count, 1, 'the previous synthetic write must not be repeated');
  assert.notEqual(result.stoppedReason, 'finalized');
  assert.ok(result.finalAnswer, 'the caller still needs an honest terminal explanation');
});

test('resume under a reduced step limit cannot discard progress and start at step zero', async () => {
  const effects = { count: 0 };
  const checkpoint = await checkpointAfterWrites(effects, 2);
  const client = scripted([TOOL_NAME, 'finalize']);
  await run(client, {
    query: QUERY, tools: [syntheticWriter(effects)], model: 'test-model', maxSteps: 1,
    resumeCheckpoint: checkpoint,
  });
  assert.equal(client.requests.length, 0);
  assert.equal(effects.count, 2);
});

test('serialized resume preserves the real per-task tool budget with a fresh worker context', async () => {
  const effects = { count: 0 };
  const checkpoint = await checkpointAfterWrites(effects, TOOL_LIMIT);
  const original = structuredClone(checkpoint);
  const result = await run(scripted([TOOL_NAME, 'finalize']), {
    query: QUERY, tools: [syntheticWriter(effects)], model: 'test-model', maxSteps: TOOL_LIMIT + 2,
    resumeCheckpoint: checkpoint,
    // agent-task-runner constructs exactly this new usage map on retry/boot.
    ctx: newBudgetContext(),
  });
  assert.equal(effects.count, TOOL_LIMIT, 'a restart must not grant another tool allowance');
  assert.ok(result.steps.some((step) => step.actions.some((action) =>
    action.tool === TOOL_NAME && action.observation?.error === 'budget_exhausted')));
  assert.deepEqual(checkpoint, original, 'resuming must not mutate the persisted input');
});

test('valid resume with remaining budget preserves history and offsets without repeating completed work', async () => {
  const effects = { count: 0 };
  const checkpoint = await checkpointAfterWrites(effects, 1);
  const client = scripted(['finalize']);
  const result = await run(client, {
    query: QUERY, tools: [syntheticWriter(effects)], model: 'test-model', maxSteps: TOOL_LIMIT + 2,
    resumeCheckpoint: checkpoint, ctx: newBudgetContext(),
  });
  assert.equal(effects.count, 1);
  assert.equal(client.requests.length, 1);
  assert.equal(result.stoppedReason, 'finalized');
  assert.deepEqual(result.steps.map((step) => step.step), [0, 1]);
  assert.ok(client.requests[0].messages.some((message) =>
    message.role === 'tool' && message.content.includes('"effect":1')));
});

test('resume must not lower a stricter usage count already supplied by the caller', async () => {
  const effects = { count: 0 };
  const checkpoint = await checkpointAfterWrites(effects, 1);
  const result = await run(scripted([TOOL_NAME, 'finalize']), {
    query: QUERY, tools: [syntheticWriter(effects)], model: 'test-model', maxSteps: TOOL_LIMIT + 2,
    resumeCheckpoint: checkpoint,
    ctx: newBudgetContext({ toolUsageMap: { [TOOL_NAME]: TOOL_LIMIT } }),
  });
  assert.equal(effects.count, 1);
  assert.ok(result.steps.some((step) => step.actions.some((action) =>
    action.tool === TOOL_NAME && action.observation?.error === 'budget_exhausted')));
});

test('malformed checkpoints fail closed without replaying any model or effect', async () => {
  const effects = { count: 0 };
  const valid = await checkpointAfterWrites(effects, 1);
  const invalid = [
    { ...valid, stepsCompleted: -1 }, { ...valid, stepsCompleted: 1.5 },
    { ...valid, stepsCompleted: '1' }, { ...valid, v: 900 },
    { ...valid, toolUsageMap: { create_document: -1 } },
    { ...valid, toolUsageMap: { create_document: '1' } },
    { ...valid, toolUsageMap: JSON.parse('{"__proto__":1}') },
    { ...valid, toolErrorBudget: { create_document: -0.5 } },
    { ...valid, finalizeRejectionsConsecutive: -1 },
    { ...valid, elapsedMs: -1 }, { ...valid, messages: valid.messages.slice(0, -1) },
    { ...valid, messages: [{ role: 'tool', tool_call_id: 'orphan', content: 'ok' }] },
    { ...valid, messages: [{ role: 'developer', content: 'untrusted' }] },
    { ...valid, steps: [{ step: 0, actions: 'malformed' }] },
    'not a checkpoint', {}, [],
  ];
  for (const checkpoint of invalid) {
    const client = scripted([TOOL_NAME]);
    const result = await run(client, { query: QUERY, tools: [syntheticWriter(effects)],
      model: 'test-model', maxSteps: 5, resumeCheckpoint: checkpoint, ctx: newBudgetContext() });
    assert.equal(result.stoppedReason, 'invalid_resume_checkpoint');
    assert.equal(client.requests.length, 0);
    assert.equal(effects.count, 1);
  }
});

test('legacy checkpoints without attempt accounting cannot get a fresh per-task budget', async () => {
  const effects = { count: 0 };
  const checkpoint = await checkpointAfterWrites(effects, 1);
  checkpoint.v = 1;
  delete checkpoint.toolUsageMap;
  const client = scripted([TOOL_NAME]);
  const result = await run(client, { query: QUERY, tools: [syntheticWriter(effects)],
    model: 'test-model', maxSteps: 5, resumeCheckpoint: checkpoint, ctx: newBudgetContext() });
  assert.equal(result.stoppedReason, 'invalid_resume_checkpoint');
  assert.equal(client.requests.length, 0);
  assert.equal(effects.count, 1);
});

test('restored runtime and rejection limits stop before any new request', async () => {
  const effects = { count: 0 };
  const valid = await checkpointAfterWrites(effects, 1);
  for (const [patch, reason] of [[{ elapsedMs: 1000 }, 'resume_budget_exhausted'],
    [{ finalizeRejectionsConsecutive: 3, finalizeRejectionsTotal: 3 }, 'verification_failed:resume_limit']]) {
    const client = scripted([TOOL_NAME]);
    const result = await run(client, { query: QUERY, tools: [syntheticWriter(effects)], model: 'test-model',
      maxSteps: 10, maxRuntimeMs: 1000, resumeCheckpoint: { ...valid, ...patch }, ctx: newBudgetContext() });
    assert.equal(result.stoppedReason, reason);
    assert.equal(client.requests.length, 0);
    assert.equal(effects.count, 1);
  }
});

test('serialized error allowances and force-finalize latch survive resume', async () => {
  let failures = 0;
  let checkpoint;
  const controller = new AbortController();
  const failing = { name: 'synthetic_fail', description: 'local failure', parameters: { type: 'object' },
    execute: async () => { failures++; return { ok: false, error: 'invalid_fixture' }; } };
  await run(scripted(Array(4).fill('synthetic_fail')), { query: QUERY, tools: [failing], model: 'test-model', maxSteps: 15,
    ctx: { signal: controller.signal }, onCheckpoint: cp => { checkpoint = structuredClone(cp); if (cp.stepsCompleted === 4) controller.abort(); } });
  assert.equal(checkpoint.toolErrorBudget.synthetic_fail, 4);
  const client = scripted(['synthetic_fail', 'synthetic_fail', 'finalize']);
  const result = await run(client, { query: QUERY, tools: [failing], model: 'test-model', maxSteps: 15,
    resumeCheckpoint: { ...checkpoint, forceFinalize: true } });
  assert.equal(failures, 5, 'the fifth failure retires the tool across the restart');
  assert.ok(result.exhaustedTools.includes('synthetic_fail'));
  assert.deepEqual(client.requests[0].tool_choice, { type: 'function', function: { name: 'finalize' } });
});

test('repeated no-op evidence cannot reset rejection progress after a restart', async () => {
  let checkpoint;
  const controller = new AbortController();
  const noOp = { name: 'synthetic_noop', description: 'Local no-op', parameters: { type: 'object' },
    execute: async () => ({ ok: true, changed: false, revision: 7 }) };
  const options = { query: QUERY, model: 'test-model', tools: [noOp], maxSteps: 20 };
  await run(scripted(['finalize', 'synthetic_noop', 'finalize', 'synthetic_noop', 'finalize']), {
    ...options, ctx: { signal: controller.signal }, finalizeGuard: () => ({ ok: false }),
    onCheckpoint: cp => { checkpoint = structuredClone(cp); if (cp.stepsCompleted === 5) controller.abort(); },
  });
  assert.equal(checkpoint.finalizeRejectionsConsecutive, 2);
  assert.equal(checkpoint.noProgressEvidence.length, 1);
  let reviews = 0;
  const result = await run(scripted(['synthetic_noop', 'finalize']), {
    ...options, resumeCheckpoint: checkpoint, finalizeGuard: () => { reviews++; return { ok: false }; },
  });
  assert.equal(reviews, 1);
  assert.equal(result.stoppedReason, 'verification_failed:3/4');
});

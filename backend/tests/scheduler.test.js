/**
 * scheduler tests — jobs CRUD, fireJob flow, webhook secret check,
 * template interpolation.
 *
 * Compile the actual scheduler in an isolated module whose __dirname
 * is inside a temporary directory. Persistence and node-cron remain
 * real; no global fs/path patches or repository data writes are needed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Module, createRequire } = require('node:module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
const sourcePath = require.resolve('../src/services/scheduler/scheduler');
const isolatedPath = path.join(TMP, 'src', 'services', 'scheduler', 'scheduler.js');
const isolatedModule = new Module(isolatedPath, module);
isolatedModule.filename = isolatedPath;
isolatedModule.require = createRequire(sourcePath);
isolatedModule._compile(fs.readFileSync(sourcePath, 'utf8'), isolatedPath);
const sched = isolatedModule.exports;

function resetJobsFile() {
  sched.stop();
  sched.setInvoker(null);
  // Failure fixtures are terminal. Retry/backoff has its own dedicated tests.
  sched.setJobClassifier(() => ({ retryable: false, reason: 'test-terminal' }));
  const p = sched._paths.JOBS_FILE;
  assert.equal(p, path.join(TMP, 'data', 'scheduled-jobs.json'));
  if (!fs.existsSync(path.dirname(p))) fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '[]');
}

test.after(() => {
  sched.stop();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('persistence uses only the isolated temporary directory', () => {
  resetJobsFile();
  assert.equal(sched._paths.DATA_DIR, path.join(TMP, 'data'));
  assert.equal(sched._paths.RUN_LOG_FILE, path.join(TMP, 'data', 'scheduled-runs.jsonl'));
  assert.equal(fs.readFileSync(sched._paths.JOBS_FILE, 'utf8'), '[]');
});

test('createCronJob validates cron expression', () => {
  resetJobsFile();
  assert.throws(() => sched.createCronJob({
    userId: 1, cron: 'not a cron', prompt: 'do it',
  }), /invalid cron/);
});

test('createCronJob rejects sub-minute schedules', () => {
  resetJobsFile();
  assert.throws(() => sched.createCronJob({
    userId: 1, cron: '* * * * * *', prompt: 'do it',
  }), /sub-minute/);
});

test('createCronJob persists and activates', () => {
  resetJobsFile();
  const job = sched.createCronJob({
    userId: 42, cron: '0 9 * * 1', prompt: 'weekly summary', thinking: 'medium',
  });
  assert.match(job.id, /^job_/);
  assert.equal(job.type, 'cron');
  assert.equal(job.userId, 42);
  assert.equal(sched._active.has(job.id), true);

  const list = sched.listJobs({ userId: 42 });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, job.id);
  assert.equal(list[0].status, 'idle');
  assert.equal(list[0].statusDetails.active, true);
});

test('listJobs filters by userId + type', () => {
  resetJobsFile();
  sched.createCronJob({ userId: 1, cron: '0 9 * * *', prompt: 'a' });
  sched.createWebhookJob({ userId: 1, prompt: 'b' });
  sched.createCronJob({ userId: 2, cron: '0 10 * * *', prompt: 'c' });

  assert.equal(sched.listJobs({ userId: 1 }).length, 2);
  assert.equal(sched.listJobs({ userId: 2 }).length, 1);
  assert.equal(sched.listJobs({ userId: 1, type: 'webhook' }).length, 1);
  assert.equal(sched.listJobs({ userId: 1, type: 'cron' }).length, 1);
});

test('createWebhookJob issues a secret and id', () => {
  resetJobsFile();
  const job = sched.createWebhookJob({ userId: 7, prompt: 'ping', thinking: 'low' });
  assert.match(job.id, /^hook_/);
  assert.equal(job.type, 'webhook');
  assert.ok(job.secret && job.secret.length >= 20);
});

test('cancelJob removes and deactivates', () => {
  resetJobsFile();
  const job = sched.createCronJob({ userId: 3, cron: '0 12 * * *', prompt: 'noon' });
  const before = sched._active.size;
  const res = sched.cancelJob({ userId: 3, jobId: job.id });
  assert.equal(res.ok, true);
  assert.equal(sched._active.size, before - 1);
  assert.equal(sched.listJobs({ userId: 3 }).length, 0);
});

test('cancelJob respects userId scoping', () => {
  resetJobsFile();
  const job = sched.createCronJob({ userId: 3, cron: '0 12 * * *', prompt: 'noon' });
  const res = sched.cancelJob({ userId: 999, jobId: job.id });
  assert.equal(res.ok, false);
  assert.equal(sched.listJobs({ userId: 3 }).length, 1);
});

test('fireJob routes through the registered invoker', async () => {
  resetJobsFile();
  const calls = [];
  sched.setInvoker(async (args) => {
    calls.push(args);
    return { answer: `ran for ${args.userId}`, stoppedReason: 'finalized' };
  });
  const job = sched.createWebhookJob({ userId: 9, prompt: 'hi {{payload.name}}' });
  const out = await sched.fireJob(job.id, { source: 'webhook', payload: { name: 'Luis' } });

  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userId, 9);
  assert.equal(calls[0].prompt, 'hi Luis'); // interpolation worked
  assert.equal(calls[0].source, 'webhook:' + job.id);

  // run was recorded into the job's ring buffer
  const fresh = sched.getJob(job.id);
  assert.equal(fresh.lastRuns.length, 1);
  assert.equal(fresh.lastRuns[0].ok, true);
  assert.match(fresh.lastRuns[0].answerSnippet, /ran for 9/);
  assert.equal(fresh.status, 'ok');
  assert.equal(fresh.statusDetails.lastRunOk, true);
});

test('fireJob captures invoker errors into the run record', async () => {
  resetJobsFile();
  sched.setInvoker(async () => { throw new Error('boom'); });
  const job = sched.createWebhookJob({ userId: 1, prompt: 'x' });
  const out = await sched.fireJob(job.id, { source: 'webhook', payload: {} });
  assert.equal(out.ok, false);
  const fresh = sched.getJob(job.id);
  assert.equal(fresh.lastRuns[0].ok, false);
  assert.match(fresh.lastRuns[0].error, /boom/);
  assert.equal(fresh.status, 'error');
  assert.match(fresh.statusDetails.reason, /boom/);
});

for (const stoppedReason of [
  'cancelled', 'aborted', 'cancelled_by_user', 'max_steps',
  'runtime_budget_exhausted', 'cost_budget_exhausted', 'model_error: private diagnostics',
  'verification_failed:step_budget', 'synthesis_error: provider diagnostics',
  'tool_circuit_open', 'new_unknown_stop_reason',
]) {
  test(`fireJob does not claim success for ${stoppedReason.split(':')[0]}`, async () => {
    resetJobsFile();
    let calls = 0;
    sched.setInvoker(async () => {
      calls += 1;
      return { answer: 'A partial answer is not proof of completion.', stoppedReason };
    });
    const job = sched.createWebhookJob({ userId: 5, prompt: 'finish the task' });
    const result = await sched.fireJob(job.id);
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
    assert.equal(sched.getJob(job.id).status, 'error');
    assert.equal(sched.getJob(job.id).lastRuns[0].ok, false);
    assert.equal(result.record.answerSnippet, undefined);
    assert.equal(typeof result.record.errorCode, 'string');
    assert.equal(sched._running.size, 0);
    const diskJobs = JSON.parse(fs.readFileSync(sched._paths.JOBS_FILE, 'utf8'));
    assert.deepEqual(diskJobs[0].lastRuns[0], result.record);
    const lastLog = fs.readFileSync(sched._paths.RUN_LOG_FILE, 'utf8').trim().split('\n').at(-1);
    assert.equal(JSON.parse(lastLog).ok, false);
  });
}

for (const [label, response] of [
  ['explicit failure', { ok: false, answer: 'not delivered', stoppedReason: 'finalized' }],
  ['error status', { status: 'error', answer: 'not delivered' }],
  ['queued acceptance', { ok: true, status: 'queued', taskId: 'fixture-task' }],
  ['accepted only', { accepted: true, answer: 'accepted, not finished' }],
  ['running status', { status: 'running', answer: 'still running' }],
  ['missing result', undefined],
  ['null result', null],
  ['empty object', {}],
  ['missing completion evidence', { ok: true }],
  ['unknown status', { status: 'new_state', answer: 'partial' }],
  ['numeric stop reason', { stoppedReason: 123, status: 'completed', answer: 'partial' }],
  ['empty stop reason', { stoppedReason: '', status: 'completed', answer: 'partial' }],
  ['malformed success flag', { ok: 'false', stoppedReason: 'finalized', answer: 'partial' }],
  ['array result', [{ answer: 'not a result envelope' }]],
]) {
  test(`fireJob rejects ${label} as completion evidence`, async () => {
    resetJobsFile();
    sched.setInvoker(async () => response);
    const job = sched.createWebhookJob({ userId: 5, prompt: 'complete a task' });
    assert.equal((await sched.fireJob(job.id)).ok, false);
    assert.equal(sched.getJob(job.id).lastRuns[0].ok, false);
  });
}

for (const stoppedReason of ['finalized', 'plain_text_finalize', 'completed']) {
  test(`fireJob retains explicit successful completion: ${stoppedReason}`, async () => {
    resetJobsFile();
    sched.setInvoker(async () => ({ answer: 'Task complete.', stoppedReason }));
    const job = sched.createWebhookJob({ userId: 1, prompt: 'complete a task' });
    assert.equal((await sched.fireJob(job.id)).ok, true);
  });
}

for (const stoppedReason of ['model_error', 'max_steps', 'error: failed step', 'cancelled', 'verification_failed']) {
  test(`fireJob rejects synthesized completion when a plan step stopped with ${stoppedReason.split(':')[0]}`, async () => {
    resetJobsFile();
    sched.setInvoker(async () => ({
      answer: 'A successful synthesis cannot repair a failed sub-goal.',
      stoppedReason: 'finalized',
      plan: [{ step: 1, goal: 'Complete the required action' }],
      steps: [{ step: 1, goal: 'Complete the required action', answer: 'partial', stoppedReason, subSteps: 1 }],
    }));
    const job = sched.createWebhookJob({ userId: 1, prompt: 'Complete every sub-goal' });
    const result = await sched.fireJob(job.id);
    assert.equal(result.ok, false);
    assert.equal(result.record.answerSnippet, undefined);
    assert.equal(sched.getJob(job.id).lastRuns[0].ok, false);
  });
}

test('fireJob checks the real planner/executor result even when synthesis succeeds after a model failure', async () => {
  resetJobsFile();
  const executor = require('../src/services/agents/executor');
  let calls = 0;
  let runResult;
  const sdk = { chat: { completions: { create: async (params) => {
    calls += 1;
    if (params.response_format) {
      return { choices: [{ message: { content: JSON.stringify({ plan: [{ step: 1, goal: 'Complete the required action' }] }) } }] };
    }
    if (params.tools) throw Object.assign(new Error('fixture model failed'), { status: 400 });
    return { choices: [{ message: { content: 'The synthesizer returned a final answer despite the failed step.' } }] };
  } } } };
  sched.setInvoker(async () => {
    runResult = await executor.run(sdk, { goal: 'Complete an action', tools: [], thinking: 'medium' });
    return { answer: runResult.finalAnswer, stoppedReason: runResult.stoppedReason, plan: runResult.plan, steps: runResult.stepResults };
  });
  const job = sched.createWebhookJob({ userId: 1, prompt: 'Complete an action' });
  const result = await sched.fireJob(job.id);
  assert.equal(calls, 3);
  assert.equal(runResult.stoppedReason, 'finalized');
  assert.match(runResult.stepResults[0].stoppedReason, /^model_error/);
  assert.equal(result.ok, false);
});

test('fireJob accepts the real planner/executor output when its sub-goal finalized', async () => {
  resetJobsFile();
  const executor = require('../src/services/agents/executor');
  const sdk = { chat: { completions: { create: async (params) => {
    if (params.response_format) {
      return { choices: [{ message: { content: JSON.stringify({ plan: [{ step: 1, goal: 'Produce the answer' }] }) } }] };
    }
    if (params.tools) return { choices: [{ message: {
      role: 'assistant', content: '', tool_calls: [{ id: 'fixture_final', type: 'function', function: {
        name: 'finalize', arguments: JSON.stringify({ answer: 'Sub-goal completed.' }),
      } }],
    } }] };
    return { choices: [{ message: { content: 'Final synthesis.' } }] };
  } } } };
  sched.setInvoker(async () => {
    const runResult = await executor.run(sdk, { goal: 'Produce the answer', tools: [], thinking: 'medium' });
    assert.equal(runResult.stepResults[0].stoppedReason, 'finalized');
    return { answer: runResult.finalAnswer, stoppedReason: runResult.stoppedReason, plan: runResult.plan, steps: runResult.stepResults };
  });
  const job = sched.createWebhookJob({ userId: 1, prompt: 'Produce the answer' });
  assert.equal((await sched.fireJob(job.id)).ok, true);
});

test('fireJob accepts a real ReAct run that recovered a historical failed read', async () => {
  resetJobsFile();
  const reactAgent = require('../src/services/react-agent');
  let sdkCalls = 0;
  let readCalls = 0;
  const sdk = { chat: { completions: { create: async () => {
    sdkCalls += 1;
    return { choices: [{ message: {
      role: 'assistant', content: '', tool_calls: [{ id: `fixture_${sdkCalls}`, type: 'function', function: {
        name: sdkCalls <= 2 ? 'read_url' : 'finalize',
        arguments: JSON.stringify(sdkCalls <= 2 ? {} : { answer: 'Recovered content verified.' }),
      } }],
    } }] };
  } } } };
  sched.setInvoker(async () => {
    const result = await reactAgent.run(sdk, {
      query: 'Read and verify the content.', model: 'test-model', maxSteps: 5,
      tools: [{ name: 'read_url', description: 'Read fixture', parameters: { type: 'object' }, execute: async () => {
        readCalls += 1;
        return readCalls === 1 ? { ok: false, error: 'fixture_temporary_failure' } : { ok: true, content: 'Verified content' };
      } }],
    });
    assert.equal(result.stoppedReason, 'finalized');
    assert.ok(result.steps[0].actions[0].observation.error);
    assert.equal(result.steps[1].actions[0].observation.content, 'Verified content');
    return { answer: result.finalAnswer, stoppedReason: result.stoppedReason, steps: result.steps };
  });
  const job = sched.createWebhookJob({ userId: 1, prompt: 'Read and verify the content.' });
  assert.equal((await sched.fireJob(job.id)).ok, true);
  assert.equal(readCalls, 2);
  assert.equal(sdkCalls, 3);
});

test('fireJob persists real ReAct circuit-open finalization as a failed single invocation', async () => {
  resetJobsFile();
  const reactAgent = require('../src/services/react-agent');
  const { createToolFailureCircuit } = require('../src/services/agents/tool-failure-circuit');
  const circuit = createToolFailureCircuit({ sessionThreshold: 2, toolThreshold: 20 });
  let invocations = 0;
  let sdkCalls = 0;
  let toolCalls = 0;
  const sdk = { chat: { completions: { create: async (params) => {
    sdkCalls++;
    const final = params.tool_choice?.function?.name === 'finalize';
    return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{
      id: `circuit_fixture_${sdkCalls}`, type: 'function', function: {
        name: final ? 'finalize' : 'broken_tool',
        arguments: JSON.stringify(final ? { answer: 'Partial synthesis only.' } : { q: String(sdkCalls) }),
      },
    }] } }] };
  } } } };
  sched.setInvoker(async () => {
    invocations++;
    const result = await reactAgent.run(sdk, {
      query: 'Synthetic circuit task', model: 'test-model', maxSteps: 8,
      ctx: { toolFailureCircuit: circuit, circuitSessionKey: 'scheduler-circuit-fixture' },
      tools: [{ name: 'broken_tool', description: 'inert failing fixture',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
        execute: async () => { toolCalls++; throw new Error('synthetic failure'); } }],
    });
    assert.equal(result.stoppedReason, 'tool_circuit_open');
    return { answer: result.finalAnswer, stoppedReason: result.stoppedReason, steps: result.steps };
  });
  const job = sched.createWebhookJob({ userId: 1, prompt: 'Synthetic circuit task' });
  const result = await sched.fireJob(job.id);
  assert.equal(invocations, 1);
  assert.equal(toolCalls, 2);
  assert.equal(result.ok, false);
  assert.equal(result.record.errorCode, 'agent_run_incomplete');
  assert.equal(sched.getJob(job.id).lastRuns[0].ok, false);
  assert.equal(result.record.answerSnippet, undefined);
});

for (const [label, plan, steps] of [
  ['missing step result', [{ step: 1, goal: 'Do the task' }], []],
  ['missing stop reason', [{ step: 1, goal: 'Do the task' }], [{ step: 1, goal: 'Do the task', answer: 'done' }]],
  ['wrong step identity', [{ step: 1, goal: 'Do the task' }], [{ step: 2, goal: 'Do the task', stoppedReason: 'finalized' }]],
  ['wrong step goal', [{ step: 1, goal: 'Do the task' }], [{ step: 1, goal: 'Different task', stoppedReason: 'finalized' }]],
  ['empty plan', [], []],
  ['malformed plan', null, []],
]) {
  test(`fireJob rejects incomplete plan evidence: ${label}`, async () => {
    resetJobsFile();
    sched.setInvoker(async () => ({ answer: 'Done', stoppedReason: 'finalized', plan, steps }));
    const job = sched.createWebhookJob({ userId: 1, prompt: 'Complete the plan' });
    assert.equal((await sched.fireJob(job.id)).ok, false);
  });
}

test('fireJob accepts completed plan steps without interpreting recovered ReAct observations as failures', async () => {
  resetJobsFile();
  const plan = [{ step: 1, goal: 'Find the result' }, { step: 2, goal: 'Deliver the result' }];
  const steps = plan.map((spec) => ({ ...spec, answer: 'completed', stoppedReason: 'finalized', subSteps: 2 }));
  const job = sched.createWebhookJob({ userId: 1, prompt: 'Complete the plan' });
  sched.setInvoker(async () => ({ answer: 'All done.', stoppedReason: 'finalized', plan, steps }));
  assert.equal((await sched.fireJob(job.id)).ok, true);
  sched.setInvoker(async () => ({
    answer: 'Recovered and finished.', stoppedReason: 'finalized',
    steps: [
      { actions: [{ tool: 'read_url', observation: { error: 'temporary error' } }] },
      { actions: [{ tool: 'read_url', observation: { text: 'recovered result' } }] },
      { actions: [{ tool: 'finalize', observation: { answer: 'Recovered and finished.' } }] },
    ],
  }));
  assert.equal((await sched.fireJob(job.id)).ok, true);
});

test('fireJob never repeats the whole agent after an effect followed by a transient error', async () => {
  resetJobsFile();
  let effects = 0;
  sched.setJobClassifier(() => ({ retryable: true, reason: 'network', ttlMs: 1 }));
  sched.setInvoker(async () => {
    effects += 1;
    if (effects === 1) throw Object.assign(new Error('connection lost after the effect'), { code: 'ECONNRESET' });
    return { answer: 'The repeated invocation completed.', stoppedReason: 'finalized' };
  });
  const job = sched.createWebhookJob({ userId: 1, prompt: 'perform an external action' });
  const result = await sched.fireJob(job.id);
  assert.equal(effects, 1);
  assert.equal(result.ok, false);
  assert.notEqual(result.record.retries, true);
  assert.equal(sched._running.size, 0);
});

test('fireJob marks returned and thrown cancellation without retrying', async () => {
  resetJobsFile();
  const job = sched.createWebhookJob({ userId: 1, prompt: 'cancel a task' });
  sched.setInvoker(async () => ({ answer: '', stoppedReason: 'cancelled' }));
  let result = await sched.fireJob(job.id);
  assert.equal(result.ok, false);
  assert.equal(result.record.errorCode, 'E_CANCELLED');
  sched.setInvoker(async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); });
  result = await sched.fireJob(job.id);
  assert.equal(result.ok, false);
  assert.equal(result.record.errorCode, 'E_CANCELLED');
});

test('fireJob redacts errors before persisting or returning them', async () => {
  resetJobsFile();
  const sensitive = ['Bearer', 'A'.repeat(28)].join(' ');
  sched.setInvoker(async () => { throw new Error(`request failed: ${sensitive}`); });
  const job = sched.createWebhookJob({ userId: 1, prompt: 'fail safely' });
  const result = await sched.fireJob(job.id);
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(sensitive), false);
  assert.equal(fs.readFileSync(sched._paths.JOBS_FILE, 'utf8').includes(sensitive), false);
  assert.equal(fs.readFileSync(sched._paths.RUN_LOG_FILE, 'utf8').includes(sensitive), false);
});

test('fireJob does not persist private diagnostics from returned failures', async () => {
  resetJobsFile();
  const privateDiagnostic = 'private-provider-diagnostic-fixture';
  sched.setInvoker(async () => ({
    answer: privateDiagnostic,
    stoppedReason: `model_error: ${privateDiagnostic}`,
    error: { message: privateDiagnostic },
  }));
  const job = sched.createWebhookJob({ userId: 1, prompt: 'record only the outcome' });
  const result = await sched.fireJob(job.id);
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(privateDiagnostic), false);
  assert.equal(fs.readFileSync(sched._paths.JOBS_FILE, 'utf8').includes(privateDiagnostic), false);
  assert.equal(fs.readFileSync(sched._paths.RUN_LOG_FILE, 'utf8').includes(privateDiagnostic), false);
});

test('fireJob safely records a null rejection and releases the job', async () => {
  resetJobsFile();
  sched.setInvoker(() => Promise.reject(null));
  const job = sched.createWebhookJob({ userId: 1, prompt: 'fail safely' });
  const result = await sched.fireJob(job.id);
  assert.equal(result.ok, false);
  assert.equal(typeof result.record.error, 'string');
  assert.equal(sched._running.size, 0);
});

test('computed status reports disabled, skipped, idle, running, ok, and error states', async () => {
  resetJobsFile();
  assert.equal(sched.computeJobStatus({ id: 'disabled', enabled: false, type: 'webhook' }), 'disabled');
  assert.equal(sched.computeJobStatus({ id: 'bad-cron', enabled: true, type: 'cron', cron: 'bad', lastRuns: [] }), 'skipped');

  const idleJob = sched.createWebhookJob({ userId: 1, prompt: 'idle' });
  assert.equal(sched.getJob(idleJob.id).status, 'idle');

  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  sched.setInvoker(async () => {
    assert.equal(sched.getJob(idleJob.id).status, 'running');
    release();
    await blocker;
    return { answer: 'done' };
  });
  const run = sched.fireJob(idleJob.id, { source: 'webhook', payload: {} });
  await blocker;
  await run;
  assert.equal(sched.getJob(idleJob.id).status, 'ok');

  sched.setInvoker(async () => { throw new Error('failed'); });
  await sched.fireJob(idleJob.id, { source: 'webhook', payload: {} });
  assert.equal(sched.getJob(idleJob.id).status, 'error');
});

test('fireJob returns "not found" for an unknown id', async () => {
  resetJobsFile();
  const out = await sched.fireJob('nope_000', {});
  assert.equal(out.ok, false);
  assert.match(out.reason, /not found/);
});

test('fireJob skips an overlapping invocation of the same job in this process', async () => {
  resetJobsFile();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  sched.setInvoker(async () => {
    calls += 1;
    await gate;
    return { answer: 'done' };
  });
  const job = sched.createWebhookJob({ userId: 1, prompt: 'once' });
  const first = sched.fireJob(job.id);
  const overlapping = sched.fireJob(job.id);
  try {
    assert.equal(calls, 1);
    assert.equal(sched.getJob(job.id).status, 'running');
  } finally {
    release();
    await Promise.all([first, overlapping]);
  }
  const skipped = await overlapping;
  assert.equal(skipped.ok, false);
  assert.equal(skipped.code, 'overlap_skipped');
  assert.match(skipped.reason, /solapamiento|ejecutando/);
  assert.equal((await first).ok, true);
  assert.equal(sched.getJob(job.id).lastRuns.length, 1);
});

test('fireJob allows different jobs concurrently and releases failed jobs', async () => {
  resetJobsFile();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  sched.setInvoker(async ({ userId }) => {
    calls.push(userId);
    await gate;
    if (userId === 1) throw new Error('terminal fixture');
    return { answer: 'done' };
  });
  const firstJob = sched.createWebhookJob({ userId: 1, prompt: 'one' });
  const secondJob = sched.createWebhookJob({ userId: 2, prompt: 'two' });
  const runs = [sched.fireJob(firstJob.id), sched.fireJob(secondJob.id)];
  try {
    assert.deepEqual(calls, [1, 2]);
    assert.equal(sched._running.size, 2);
  } finally {
    release();
    await Promise.all(runs);
  }
  assert.equal((await runs[0]).ok, false);
  assert.equal((await runs[1]).ok, true);
  assert.equal(sched._running.size, 0);
  sched.setInvoker(async () => ({ answer: 'recovered' }));
  assert.equal((await sched.fireJob(firstJob.id)).ok, true);
});

// Exercise the current Redis guard and timer lifecycle around the real
// scheduler persistence. The Redis transport is an in-memory fixture; no
// production connection or job is touched.
function redisLeaseFixture() {
  const rows = new Map();
  const calls = { renew: 0, release: 0 };
  return {
    rows, calls,
    async set(key, token) {
      if (rows.has(key)) return null;
      rows.set(key, token);
      return 'OK';
    },
    async eval(script, _keys, key, token) {
      if (rows.get(key) !== token) return 0;
      if (script.includes('PEXPIRE')) { calls.renew++; return 1; }
      if (script.includes('DEL')) { calls.release++; rows.delete(key); return 1; }
      throw new Error('unexpected lease script');
    },
  };
}

for (const outcome of ['finalized', 'tool_circuit_open', 'cancelled', 'thrown_error']) {
  test(`fireJob stops renewal and releases its Redis claim after ${outcome}`, async (t) => {
    resetJobsFile();
    const overlap = require('../src/services/scheduler/overlap-lease');
    const previous = overlap.getDefaultOverlapLease();
    const redis = redisLeaseFixture();
    const lease = overlap.createOverlapLease({ redis, ttlMs: 120_000 });
    overlap.setDefaultOverlapLease(lease);
    t.mock.timers.enable({ apis: ['setInterval'] });
    let finish;
    let calls = 0;
    const gate = new Promise(resolve => { finish = resolve; });
    const job = sched.createWebhookJob({ userId: 19, prompt: 'synthetic lease lifecycle' });
    sched.setInvoker(async () => {
      calls++;
      await gate;
      if (outcome === 'thrown_error') throw Object.assign(new Error('synthetic transport error'), { code: 'ECONNRESET' });
      return { answer: 'fixture', stoppedReason: outcome };
    });
    const run = sched.fireJob(job.id);
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls, 1);
      assert.equal(redis.rows.size, 1);
      t.mock.timers.tick(40_000);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(redis.calls.renew, 1);
      finish();
      const result = await run;
      assert.equal(result.ok, outcome === 'finalized');
      assert.equal(calls, 1);
      assert.equal(sched.getJob(job.id).lastRuns.length, 1);
      assert.equal(sched.getJob(job.id).lastRuns[0].ok, outcome === 'finalized');
      assert.equal(redis.rows.size, 0);
      assert.equal(redis.calls.release, 1);
      assert.equal(sched._running.size, 0);
      t.mock.timers.tick(120_000);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(redis.calls.renew, 1);
    } finally {
      finish();
      await run;
      overlap.setDefaultOverlapLease(previous);
    }
  });
}

test('fireJob skips an already held Redis claim without invocation or extra journal entry', async () => {
  resetJobsFile();
  const overlap = require('../src/services/scheduler/overlap-lease');
  const previous = overlap.getDefaultOverlapLease();
  const redis = redisLeaseFixture();
  const lease = overlap.createOverlapLease({ redis });
  overlap.setDefaultOverlapLease(lease);
  const job = sched.createWebhookJob({ userId: 23, prompt: 'synthetic held lease' });
  const claim = await lease.acquire({ jobId: job.id, ownerId: job.userId, holderId: 'another-worker' });
  assert.equal(claim.ok, true);
  const before = fs.existsSync(sched._paths.RUN_LOG_FILE) ? fs.readFileSync(sched._paths.RUN_LOG_FILE, 'utf8') : '';
  let calls = 0;
  sched.setInvoker(async () => { calls++; return { answer: 'done', stoppedReason: 'finalized' }; });
  try {
    const result = await sched.fireJob(job.id);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'overlap_skipped');
    assert.equal(result.reason, overlap.OVERLAP_HELD_REASON_ES);
    assert.equal(result.distributed, true);
    assert.equal(calls, 0);
    assert.equal(sched.getJob(job.id).lastRuns.length, 0);
    const after = fs.existsSync(sched._paths.RUN_LOG_FILE) ? fs.readFileSync(sched._paths.RUN_LOG_FILE, 'utf8') : '';
    assert.equal(after, before);
    assert.equal(redis.rows.size, 1);
  } finally {
    await lease.release(claim);
    overlap.setDefaultOverlapLease(previous);
  }
});

test('interpolate substitutes nested fields and leaves unknowns blank', () => {
  assert.equal(sched.interpolate('hi {{payload.name}}', { payload: { name: 'L' } }), 'hi L');
  assert.equal(sched.interpolate('{{a.b.c}}!', { a: { b: { c: 'deep' } } }), 'deep!');
  assert.equal(sched.interpolate('x={{missing.field}}', {}), 'x=');
});

test('validateCron accepts common 5-field expressions', () => {
  assert.equal(sched.validateCron('0 9 * * 1').ok, true);
  assert.equal(sched.validateCron('*/5 * * * *').ok, true);
  assert.equal(sched.validateCron('garbage').ok, false);
});

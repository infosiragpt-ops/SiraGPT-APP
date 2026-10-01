'use strict';

// The model is explicitly scripted; the ReAct loops, proposal/CAS adapter,
// finalization guard, temporary files and child Node test process are real.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const reactAgent = require('../src/services/react-agent');
const { createCodingAgentTeam } = require('../src/services/codex/coding-agent-team');
const { createCodingFinalizeGuard } = require('../src/services/codex/coding-finalize-guard');
const { codingTools, createTeamUsageRecorder } = require('../src/services/codex/chat-coding-workspace');
const { RunnerError } = require('../src/services/codex/runner-client');

const MODEL = 'gpt-4o';
const identity = { userId: 'team-user', chatId: 'team-chat', projectId: 'team-project' };
const QUERY = 'Modifica left.cjs y right.cjs con dos colaboradores y ejecuta las pruebas del proyecto.';
const ANSWER = 'Integré los dos archivos y las pruebas pasaron.';
const hash = content => createHash('sha256').update(content).digest('hex');
const initial = { 'left.cjs': 'module.exports = 1;\n', 'right.cjs': 'module.exports = 1;\n' };
const tasks = [
  { name: 'Izquierda', task: 'CHILD_LEFT: modifica únicamente left.cjs.', files: ['left.cjs'] },
  { name: 'Derecha', task: 'CHILD_RIGHT: modifica únicamente right.cjs.', files: ['right.cjs'] },
];

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function scenario(t, { apply = true, badProposal = false, maxSteps = 24, conflict = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sira-team-integration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(initial)) await fs.writeFile(path.join(root, file), content);
  await fs.writeFile(path.join(root, 'values.test.cjs'), [
    "const { test } = require('node:test');",
    "const assert = require('node:assert/strict');",
    "test('left edit survives integration', () => assert.equal(require('./left.cjs'), 2));",
    "test('right edit survives integration', () => assert.equal(require('./right.cjs'), 3));",
    "test('both edits work together', () => assert.equal(require('./left.cjs') + require('./right.cjs'), 5));",
  ].join('\n'));

  const runnerCalls = [], saves = [], executions = [], requests = [], guardResults = [];
  function own(id) { assert.equal(id, identity.projectId, 'every operation remains in the authorized project'); }
  const runner = {
    async readEditorFile(id, file) {
      own(id); runnerCalls.push({ op: 'snapshot', file });
      const content = await fs.readFile(path.join(root, file), 'utf8');
      return { path: file, content, revision: hash(content), truncated: false, readOnly: false };
    },
    async readFile(id, file) {
      own(id); runnerCalls.push({ op: 'read', file });
      return { content: await fs.readFile(path.join(root, file), 'utf8') };
    },
    async writeFiles() { throw Error('proposal applications must use revision-checked saveEditorFile'); },
    async saveEditorFile(id, file) {
      own(id);
      const current = await fs.readFile(path.join(root, file.path), 'utf8');
      saves.push({ ...file, currentRevision: hash(current) });
      if (file.expectedRevision !== hash(current)) {
        throw new RunnerError('conflict', { status: 409, body: { ok: false, error: 'file_conflict' } });
      }
      await fs.writeFile(path.join(root, file.path), file.content);
      runnerCalls.push({ op: 'save', file: file.path });
      return { path: file.path, revision: hash(file.content), written: 1 };
    },
    async exec(id, cmd) {
      own(id);
      assert.deepEqual(cmd, ['node', '--test', 'values.test.cjs']);
      const childEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;
      let result;
      try {
        const { stdout, stderr } = await promisify(execFile)(process.execPath, cmd.slice(1), { cwd: root, env: childEnv, timeout: 5_000 });
        result = { ok: true, exitCode: 0, stdout, stderr, timedOut: false };
      } catch (error) {
        result = { ok: false, exitCode: Number.isInteger(error.code) ? error.code : null,
          stdout: error.stdout || '', stderr: error.stderr || '', timedOut: Boolean(error.killed) };
      }
      executions.push(result);
      runnerCalls.push({ op: 'exec' });
      return result;
    },
  };
  const ctx = { userId: identity.userId, chatId: identity.chatId, provider: 'OpenAI', permission: 'workspace',
    codingWorkspace: { projectId: identity.projectId }, projectTools: { runner,
      binding: { findProjectForChat: async ({ userId, chatId }) => userId === identity.userId && chatId === identity.chatId ? { id: identity.projectId } : null } } };

  const bothChildrenStarted = deferred();
  const firstChildCalls = new Set();
  let barrierReached = false, batchResult = null, callId = 0;
  const counters = { parent: 0, left: 0, right: 0 };
  // This barrier proves overlap without elapsed-time or sleep assertions. A
  // sequential implementation fails the bounded test instead of seeming parallel.
  const barrierTimer = setTimeout(() => bothChildrenStarted.resolve(), 3_000);
  t.after(() => clearTimeout(barrierTimer));
  function proposal(file) {
    const found = batchResult?.tasks?.flatMap(task => task.proposals || []).find(item => item.path === file);
    assert.ok(found, `expected a real server-issued proposal for ${file}`);
    return found.id;
  }
  const openai = { chat: { completions: { create: async request => {
    const query = request.messages.find(message => message.role === 'user')?.content;
    const actor = query === tasks[0].task ? 'left' : query === tasks[1].task ? 'right' : 'parent';
    const step = counters[actor]++;
    requests.push({ actor, request: structuredClone(request) });
    if (actor !== 'parent' && step === 0) {
      firstChildCalls.add(actor);
      if (firstChildCalls.size === 2) { barrierReached = true; clearTimeout(barrierTimer); bothChildrenStarted.resolve(); }
      await bothChildrenStarted.promise;
      assert.equal(barrierReached, true, 'both child model calls must start before either is released');
    }
    let next;
    if (actor !== 'parent') {
      const file = actor === 'left' ? 'left.cjs' : 'right.cjs';
      const value = actor === 'left' ? 2 : badProposal ? 9 : 3;
      next = [
        ['project_read', { path: file }],
        ['project_write', { path: file, content: `module.exports = ${value};\n` }],
        ['finalize', { answer: 'Preparé la propuesta para el archivo asignado; no ejecuté pruebas.' }],
      ][Math.min(step, 2)];
    } else if (step === 0) {
      next = ['run_subagent', { tasks }];
    } else if (batchResult?.ok !== true) {
      next = ['finalize', { answer: ANSWER }];
    } else if (!apply) {
      next = step < 3
        ? ['project_read', { proposalId: proposal(step === 1 ? 'left.cjs' : 'right.cjs') }]
        : ['finalize', { answer: ANSWER }];
    } else {
      // Each proposal is inspected before applying. Verification then operates
      // on originals, not on child overlays or their claims of completion.
      const plan = [
        () => ['project_read', { proposalId: proposal('left.cjs') }],
        () => ['project_write', { proposalId: proposal('left.cjs') }],
        () => ['project_read', { proposalId: proposal('right.cjs') }],
        () => ['project_write', { proposalId: proposal('right.cjs') }],
        () => ['project_exec', { cmd: ['node', '--test', 'values.test.cjs'] }],
        () => ['project_read', { path: 'left.cjs' }],
        () => ['project_read', { path: 'right.cjs' }],
        () => ['finalize', { answer: ANSWER }],
      ];
      next = plan[Math.min(step - 1, plan.length - 1)]();
    }
    return { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }, choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', content: null, tool_calls: [{ id: `team-call-${++callId}`, type: 'function', function: { name: next[0], arguments: JSON.stringify(next[1]) } }],
    } }] };
  } } } };
  const team = createCodingAgentTeam({ openai, model: MODEL, provider: 'OpenAI', maxSteps, maxRuntimeMs: 10_000 });
  t.after(() => team.dispose());
  const teamTool = { ...team.tool, execute: async (args, context) => {
    batchResult = await team.tool.execute(args, context);
    for (const [file, content] of Object.entries(initial)) {
      assert.equal(await fs.readFile(path.join(root, file), 'utf8'), content, 'children never modify the real project');
    }
    if (conflict) await fs.writeFile(path.join(root, 'left.cjs'), 'module.exports = 17;\n');
    return batchResult;
  } };
  const guard = createCodingFinalizeGuard({ userQuery: QUERY, ...identity });
  const recordUsage = createTeamUsageRecorder(team);
  const result = await reactAgent.run(openai, { query: QUERY, model: MODEL, maxSteps, maxRuntimeMs: 10_000,
    tools: codingTools({ team }).map(tool => tool.name === team.tool.name ? teamTool : tool), ctx,
    onBeforeStep: team.beforeStep, onStepDone: recordUsage, finalizeGuard: args => {
      const checked = guard(args); guardResults.push(checked); return checked;
    } });
  const totals = result.steps.reduce((sum, step) => {
    for (const key of ['inputTokens', 'outputTokens', 'tokensEstimate']) sum[key] += step.usage?.[key] || 0;
    return sum;
  }, { inputTokens: 0, outputTokens: 0, tokensEstimate: 0 });
  assert.deepEqual(totals, { inputTokens: requests.length * 10, outputTokens: requests.length * 3, tokensEstimate: requests.length * 13 }, 'persisted coordinator usage includes each parent and child provider response once');
  assert.ok(result.steps.filter(step => step.usage).every(step => step.usage.model === MODEL && step.usage.provider === 'OpenAI'));
  const lastUsage = structuredClone(result.steps.at(-1).usage);
  recordUsage(result.steps.at(-1));
  assert.deepEqual(result.steps.at(-1).usage, lastUsage, 'replaying the accounting callback cannot recharge children');
  const usage = team.getUsage();
  const childCalls = requests.filter(item => item.actor !== 'parent').length;
  assert.deepEqual({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, tokensEstimate: usage.tokensEstimate },
    { inputTokens: 10 * childCalls, outputTokens: 3 * childCalls, tokensEstimate: 13 * childCalls }, 'child usage is counted once, not duplicated by callbacks and final results');
  assert.ok(Number.isFinite(usage.costUsd) && usage.costUsd >= 0);
  assert.ok(Object.values(usage).every(value => typeof value === 'number'), 'usage metadata never exposes provider/model identity');
  assert.ok(requests.every(({ request }) => request.model === MODEL), 'parent and all children preserve the selected model without fallback');
  assert.ok(requests.length <= maxSteps, 'parent and children share the model-call budget');
  for (const { actor, request } of requests) {
    if (actor === 'parent') {
      for (const name of ['project_read', 'project_write']) {
        const schema = request.tools.find(tool => tool.function.name === name).function.parameters;
        assert.equal(schema.properties.proposalId.type, 'string');
        assert.ok(!schema.required?.includes('path'), 'server-issued proposal ids can be used without fabricating a path');
        assert.ok(!schema.required?.includes('content'), 'applying a proposal does not require the model to reproduce its content');
      }
      continue;
    }
    const names = request.tools.map(tool => tool.function.name);
    for (const unsafe of ['run_subagent', 'project_exec', 'project_preview_start', 'project_open_pull_request', 'host_bash']) {
      assert.ok(!names.includes(unsafe), `child must not receive ${unsafe}`);
    }
  }
  return { root, result, batchResult, barrierReached, requests, guardResults, saves, executions, runnerCalls, usage };
}

test('two real ReAct children propose concurrently; the coordinator applies CAS and verifies the integrated files with Node', { timeout: 12_000 }, async t => {
  const state = await scenario(t);
  assert.equal(state.barrierReached, true);
  assert.ok(state.batchResult.tasks.every(task => task.status === 'completed'));
  assert.equal(state.result.stoppedReason, 'finalized');
  assert.equal(state.result.finalAnswer, ANSWER);
  assert.equal(state.saves.length, 2);
  for (const saved of state.saves) assert.equal(saved.expectedRevision, hash(initial[saved.path]));
  assert.equal(state.executions.length, 1);
  assert.equal(state.executions[0].exitCode, 0);
  assert.match(state.executions[0].stdout, /(?:#|ℹ) pass 3/);
  const lastExec = state.runnerCalls.findLastIndex(call => call.op === 'exec');
  assert.deepEqual(state.runnerCalls.slice(lastExec + 1).map(call => call.file), ['left.cjs', 'right.cjs']);
  assert.equal(await fs.readFile(path.join(state.root, 'left.cjs'), 'utf8'), 'module.exports = 2;\n');
  assert.equal(await fs.readFile(path.join(state.root, 'right.cjs'), 'utf8'), 'module.exports = 3;\n');
});

test('finished child proposals and their inspected content cannot finalize edits that were never applied', { timeout: 12_000 }, async t => {
  const state = await scenario(t, { apply: false });
  assert.ok(state.batchResult.tasks.every(task => task.status === 'completed'));
  assert.equal(state.saves.length, 0);
  assert.equal(state.executions.length, 0);
  assert.match(state.result.stoppedReason, /^verification_failed/);
  assert.ok(state.guardResults.every(result => !result.ok && result.allowUnverifiedDraft === false));
  assert.ok(state.guardResults.some(result => result.code === 'E_CODING_WRITE_REQUIRED'));
  assert.notEqual(state.result.finalAnswer, ANSWER);
});

test('a real failed Node suite blocks completion even when both child proposals were applied and reread', { timeout: 12_000 }, async t => {
  const state = await scenario(t, { badProposal: true });
  assert.equal(state.saves.length, 2);
  assert.equal(state.executions[0].exitCode, 1);
  assert.match(state.executions[0].stdout, /(?:#|ℹ) fail 2/);
  assert.match(state.result.stoppedReason, /^verification_failed/);
  assert.ok(state.guardResults.some(result => result.code === 'E_CODING_CHECK_FAILED'));
  assert.notEqual(state.result.finalAnswer, ANSWER);
});

test('an intervening file edit is preserved by CAS and cannot be hidden by another child succeeding', { timeout: 12_000 }, async t => {
  const state = await scenario(t, { conflict: true });
  assert.equal(await fs.readFile(path.join(state.root, 'left.cjs'), 'utf8'), 'module.exports = 17;\n');
  const actions = state.result.steps.flatMap(step => step.actions);
  assert.ok(actions.some(action => action.observation?.code === 'file_conflict'));
  assert.match(state.result.stoppedReason, /^verification_failed/);
  assert.notEqual(state.result.finalAnswer, ANSWER);
});

test('parallel children cannot multiply the parent budget or obtain a fallback model when their allowance ends', { timeout: 12_000 }, async t => {
  const state = await scenario(t, { maxSteps: 9 });
  assert.equal(state.barrierReached, true);
  assert.equal(state.batchResult.ok, false);
  assert.ok(state.batchResult.tasks.some(task => task.stoppedReason === 'team_budget_exhausted'));
  assert.ok(state.batchResult.tasks.filter(task => task.status === 'failed').every(task => task.proposals.length === 0), 'unfinished child work is never offered as a completed proposal');
  assert.equal(state.saves.length, 0);
  assert.ok(state.requests.length <= 9);
  assert.notEqual(state.result.stoppedReason, 'finalized');
  assert.notEqual(state.result.finalAnswer, ANSWER);
});

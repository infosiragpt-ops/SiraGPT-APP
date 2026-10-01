'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createCodingAgentTeam } = require('../src/services/codex/coding-agent-team');
const { RunnerError } = require('../src/services/codex/runner-client');
const workspace = require('../src/services/agents/project-workspace-tools');
const { safeReadEditorFile, safeSaveEditorFile } = require('../../scripts/code-runner-fs-helper');

const hash = (value) => createHash('sha256').update(value).digest('hex');
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-coding-team-'));
  const state = { projectId: 'project-one', writes: 0, saves: 0, models: 0 };
  const wrap = (fn) => async (...args) => {
    try { return fn(...args); } catch (error) {
      throw new RunnerError('runner request failed', {
        status: error.publicCode === 'file_not_found' ? 404 : 409,
        body: { ok: false, error: error.publicCode || 'unavailable' },
      });
    }
  };
  const runner = {
    readEditorFile: wrap((_project, file) => safeReadEditorFile(root, file)),
    saveEditorFile: wrap((_project, file) => { state.saves += 1; return safeSaveEditorFile(root, file); }),
    readFile: wrap((_project, file) => ({ content: fs.readFileSync(path.join(root, file), 'utf8') })),
    writeFiles: wrap((_project, files) => {
      state.writes += 1;
      for (const file of files) fs.writeFileSync(path.join(root, file.path), file.content);
      return { ok: true, written: files.length };
    }),
    exec: async () => ({ ok: true, exitCode: 0, stdout: fs.readdirSync(root).join('\n') }),
  };
  const ctx = { userId: 'user-one', chatId: 'chat-one', codingWorkspace: { projectId: 'project-one' },
    projectTools: { runner, binding: { findProjectForChat: async ({ userId, chatId }) =>
      userId === 'user-one' && chatId === 'chat-one' && state.projectId ? { id: state.projectId } : null } } };
  const client = { configured: true };
  const team = createCodingAgentTeam({ openai: client, model: 'selected-model', provider: 'selected-provider',
    toolCallMode: 'native', thinkingLevel: 'high', thinkingLevelExplicit: true, ...options });
  t.after(() => { team.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const tools = team.wrapWorkspaceTools([workspace.projectListTool, workspace.projectReadTool, workspace.projectWriteTool]);
  return { root, state, ctx, runner, client, team,
    read: (args, context = ctx) => tools.find((tool) => tool.name === 'project_read').execute(args, context),
    write: (args, context = ctx) => tools.find((tool) => tool.name === 'project_write').execute(args, context),
    put: (file, content) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), content); },
    get: (file) => fs.readFileSync(path.join(root, file), 'utf8') };
}
const task = (name, files = []) => ({ name, task: `Prepare ${name}`, files });
const call = (options, name, args) => options.tools.find((tool) => tool.name === name).execute(args, options.ctx);
async function proposalRun(_client, options) {
  const control = await options.onBeforeStep({ step: 0 });
  if (control?.stop) return { stoppedReason: control.reason, steps: [] };
  const file = options.query.includes('second') ? 'second.js' : 'first.js';
  assert.equal((await call(options, 'project_read', { path: file, limit: 2000 })).ok, true);
  assert.equal((await call(options, 'project_write', { path: file, content: `new ${file}` })).ok, true);
  return { stoppedReason: 'finalized', finalAnswer: 'Propuesta preparada.', steps: [] };
}

test('independent children enter together with the same model and only proposal tools; CAS applies explicitly', async (t) => {
  const bothEntered = deferred(), release = deferred(); let entered = 0, f;
  f = fixture(t, { run: async (client, options) => {
    assert.equal(client, f.client); assert.equal(options.model, 'selected-model');
    assert.equal(options.ctx.provider, 'selected-provider'); assert.equal(options.toolCallMode, 'native');
    assert.equal(options.thinkingLevel, 'high'); assert.equal(options.thinkingLevelExplicit, true);
    assert.deepEqual(options.tools.map((tool) => tool.name), ['project_list', 'project_read', 'project_write']);
    assert.equal(options.ctx.userId, f.ctx.userId); assert.equal(options.ctx.chatId, f.ctx.chatId);
    assert.equal(options.ctx.codingWorkspace.projectId, f.ctx.codingWorkspace.projectId);
    if (++entered === 2) bothEntered.resolve();
    await release.promise;
    return proposalRun(client, options);
  } });
  f.put('first.js', 'first original'); f.put('second.js', 'second original');
  const pending = f.team.tool.execute({ tasks: [task('first', ['first.js']), task('second', ['second.js'])] }, f.ctx);
  await bothEntered.promise; assert.equal(entered, 2); release.resolve();
  const result = await pending; assert.equal(result.ok, true);
  assert.equal(f.get('first.js'), 'first original'); assert.equal(f.state.writes, 0); assert.equal(f.state.saves, 0);
  for (const item of result.tasks) {
    const proposal = item.proposals[0];
    const inspection = await f.read({ proposalId: proposal.id });
    assert.equal(inspection.proposal, true); assert.equal(inspection.content, `new ${proposal.path}`);
    assert.equal(inspection.baseRevision, hash(proposal.path === 'first.js' ? 'first original' : 'second original'));
    const applied = await f.write({ proposalId: proposal.id });
    assert.equal(applied.ok, true); assert.equal(applied.applied, true); assert.equal(applied.proposalId, proposal.id);
    assert.equal(applied.revision, hash(inspection.content)); assert.equal(applied.bytes, Buffer.byteLength(inspection.content));
    assert.equal((await f.read({ path: proposal.path })).content, inspection.content);
    assert.equal((await f.write({ proposalId: proposal.id })).code, 'proposal_not_found');
  }
  assert.equal(f.state.saves, 2); assert.equal(f.state.writes, 0);
});

test('a stale proposal cannot overwrite a newer edit; lookup and every application are chat-owned', async (t) => {
  const f = fixture(t, { run: proposalRun }); f.put('first.js', 'original');
  const result = await f.team.tool.execute({ tasks: [task('first', ['first.js'])] }, f.ctx);
  const proposalId = result.tasks[0].proposals[0].id;
  assert.equal((await f.write({ proposalId, path: 'other.js' })).code, 'proposal_mismatch');
  assert.equal((await f.write({ proposalId, content: 'invented' })).code, 'proposal_mismatch');
  for (const ctx of [{ ...f.ctx, userId: 'other-user' }, { ...f.ctx, chatId: 'other-chat' },
    { ...f.ctx, codingWorkspace: { projectId: 'other-project' } }]) {
    assert.equal((await f.read({ proposalId }, ctx)).code, 'team_scope');
    const rejected = await f.write({ proposalId }, ctx);
    assert.equal(rejected.code, 'team_scope'); assert.equal(rejected.path, undefined); assert.equal(rejected.proposalId, undefined);
  }
  f.state.projectId = 'replacement-project';
  assert.equal((await f.write({ proposalId })).code, 'team_scope'); assert.equal(f.state.saves, 0);
  f.state.projectId = 'project-one'; f.put('first.js', 'newer edit');
  const conflict = await f.write({ proposalId });
  assert.equal(conflict.code, 'file_conflict'); assert.equal(conflict.path, 'first.js'); assert.equal(conflict.proposalId, proposalId);
  assert.equal(f.get('first.js'), 'newer edit'); assert.equal(f.state.saves, 1);
});

test('new files require an explicit missing-file response and use create-only CAS', async (t) => {
  const f = fixture(t, { run: proposalRun });
  const result = await f.team.tool.execute({ tasks: [task('first', ['first.js'])] }, f.ctx);
  assert.equal(result.ok, true); const proposal = result.tasks[0].proposals[0];
  assert.equal(proposal.baseRevision, null); assert.equal(fs.existsSync(path.join(f.root, 'first.js')), false);
  f.put('first.js', 'created meanwhile');
  assert.equal((await f.write({ proposalId: proposal.id })).code, 'file_conflict');
  assert.equal(f.get('first.js'), 'created meanwhile');
});

test('ambiguous missing files, truncated or dishonest snapshots never become writable', async (t) => {
  for (const response of [new Error('file_not_found'), new RunnerError('missing', { status: 404 }),
    new RunnerError('missing', { status: 500, body: { ok: false, error: 'file_not_found' } }),
    { path: 'first.js', content: '', revision: null, truncated: true, readOnly: true },
    { path: 'first.js', content: 'changed', revision: hash('original'), truncated: false, readOnly: false }]) {
    const f = fixture(t, { run: async (_client, options) => {
      const read = await call(options, 'project_read', { path: 'first.js' }); assert.equal(read.ok, false);
      const write = await call(options, 'project_write', { path: 'first.js', content: 'new' });
      assert.equal(write.code, 'read_required');
      return { stoppedReason: 'max_steps', steps: [] };
    } });
    f.runner.readEditorFile = async () => { if (response instanceof Error) throw response; return response; };
    const result = await f.team.tool.execute({ tasks: [task('first', ['first.js'])] }, f.ctx);
    assert.equal(result.ok, false); assert.deepEqual(result.tasks[0].proposals, []); assert.equal(f.state.saves, 0);
  }
});

test('invalid, secret, internal and overlapping paths are rejected before starting children', async (t) => {
  let started = 0; const f = fixture(t, { run: async () => { started += 1; } });
  for (const file of ['../escape.js', '/absolute.js', 'C:\\escape.js', 'a//b.js', 'a/./b.js',
    '.env', 'a/.env.production', '.git/config', '.sira-editor-lock', 'a\nb.js', 'id_rsa']) {
    assert.equal((await f.team.tool.execute({ tasks: [task('first', [file])] }, f.ctx)).code, 'invalid_team_tasks');
  }
  for (const tasks of [[], Array.from({ length: 5 }, (_, i) => task(`n${i}`)),
    [task('first', ['a.js']), task('second', ['a.js'])], [task('same'), task('same')],
    [task('first', ['a.js', 'a.js'])], [{ name: 'first', task: '' }],
    [{ ...task('first'), command: 'arbitrary' }], [task('first', Array.from({ length: 9 }, (_, i) => `${i}.js`))]]) {
    assert.equal((await f.team.tool.execute({ tasks }, f.ctx)).code, 'invalid_team_tasks');
  }
  assert.equal(started, 0);
});

test('assigned paths need a complete read and valid bounded text before an overlay write', async (t) => {
  const f = fixture(t, { run: async (_client, options) => {
    assert.equal((await call(options, 'project_write', { path: 'other.js', content: 'new' })).code, 'unassigned_path');
    assert.equal((await call(options, 'project_write', { path: 'first.js', content: 'new' })).code, 'read_required');
    assert.equal((await call(options, 'project_read', { path: 'first.js', limit: 1 })).truncated, true);
    assert.equal((await call(options, 'project_write', { path: 'first.js', content: 'new' })).code, 'read_required');
    await call(options, 'project_read', { path: 'first.js', limit: 2000 });
    for (const content of ['x'.repeat(65537), 'binary\0value', '\uD800', ['-----BEGIN ', 'PRIVATE KEY-----'].join('')]) {
      assert.equal((await call(options, 'project_write', { path: 'first.js', content })).code, 'proposal_too_large');
    }
    assert.equal((await call(options, 'project_write', { path: 'first.js', content: 'safe proposal' })).ok, true);
    assert.equal((await call(options, 'project_read', { path: 'first.js' })).proposal, true);
    return { stoppedReason: 'finalized', finalAnswer: 'Proposal only', steps: [] };
  } });
  f.put('first.js', 'one\ntwo\nthree');
  assert.equal((await f.team.tool.execute({ tasks: [task('first', ['first.js'])] }, f.ctx)).ok, true);
  assert.equal(f.get('first.js'), 'one\ntwo\nthree'); assert.equal(f.state.writes, 0);
});

test('read-only children expose no write or execution tool, and max eight children applies across batches', async (t) => {
  let started = 0;
  const f = fixture(t, { run: async (_client, options) => {
    started += 1; assert.deepEqual(options.tools.map((tool) => tool.name), ['project_list', 'project_read']);
    return { stoppedReason: 'finalized', finalAnswer: 'Reviewed, no changes.', steps: [] };
  } });
  for (let batch = 0; batch < 2; batch += 1) {
    assert.equal((await f.team.tool.execute({ tasks: Array.from({ length: 4 }, (_, i) => task(`review ${i}`)) }, f.ctx)).ok, true);
  }
  assert.equal((await f.team.tool.execute({ tasks: [task('ninth')] }, f.ctx)).code, 'team_limit'); assert.equal(started, 8);
});

test('shared model-call budget preserves four parent calls and cannot be reset after starting', async (t) => {
  const results = [], arrived = deferred(), release = deferred(); let started = 0;
  const f = fixture(t, { maxSteps: 9, run: async (_client, options) => {
    if (++started === 2) arrived.resolve(); await release.promise;
    for (;;) {
      const control = await options.onBeforeStep({});
      if (control?.stop) { results.push(control.reason); return { stoppedReason: control.reason, steps: [] }; }
      results.push('call'); await Promise.resolve();
    }
  } });
  assert.equal(f.team.configureBudget({ maxSteps: 10 }), true);
  assert.equal(f.team.beforeStep({ ctx: f.ctx }), null);
  assert.equal(f.team.configureBudget({ maxSteps: 100 }), false);
  const pending = f.team.tool.execute({ tasks: [task('one'), task('two')] }, f.ctx);
  await arrived.promise; release.resolve(); const result = await pending;
  assert.equal(result.ok, false); assert.equal(results.filter((value) => value === 'call').length, 5);
  assert.ok(result.tasks.every((item) => item.status === 'failed' && item.stoppedReason === 'team_budget_exhausted'));
  for (let i = 0; i < 4; i += 1) assert.equal(f.team.beforeStep(), null);
  assert.deepEqual(f.team.beforeStep(), { stop: true, reason: 'team_budget_exhausted' });
  assert.equal((await f.team.tool.execute({ tasks: [task('later')] }, f.ctx)).code, 'team_budget_exhausted');
});

test('reported child usage is aggregated once, including partial failures; no proposal at a step cap', async (t) => {
  const f = fixture(t, { run: async (client, options) => {
    const step = { step: 0, usage: { inputTokens: 10, outputTokens: 3, tokensEstimate: 13, costUsd: 0.002 } };
    options.onStepDone(step); options.onStepDone(step);
    await proposalRun(client, options);
    return { stoppedReason: options.query.includes('second') ? 'max_steps' : 'finalized',
      finalAnswer: 'Proposed only', steps: [step] };
  } });
  f.put('first.js', 'old'); f.put('second.js', 'old');
  const result = await f.team.tool.execute({ tasks: [task('first', ['first.js']), task('second', ['second.js'])] }, f.ctx);
  assert.equal(result.ok, false); assert.equal(result.tasks[0].proposals.length, 1);
  assert.equal(result.tasks[1].status, 'failed'); assert.equal(result.tasks[1].stoppedReason, 'max_steps');
  assert.deepEqual(result.tasks[1].proposals, []);
  assert.deepEqual(f.team.getUsage(), { inputTokens: 20, outputTokens: 6, tokensEstimate: 26, costUsd: 0.004 });
  const copy = f.team.getUsage(); copy.inputTokens = 0; assert.equal(f.team.getUsage().inputTokens, 20);
  assert.equal(f.state.saves, 0); assert.equal(f.state.writes, 0);
});

test('Stop cancels all children, retains reported usage and prevents publishing/applying proposals', async (t) => {
  const ready = deferred(), stopped = new AbortController();
  const f = fixture(t, { run: async (client, options) => {
    await proposalRun(client, options);
    options.onStepDone({ step: 0, usage: { inputTokens: 4, outputTokens: 2, tokensEstimate: 6 } });
    ready.resolve();
    await new Promise((resolve) => options.ctx.signal.addEventListener('abort', resolve, { once: true }));
    return { stoppedReason: 'finalized', finalAnswer: 'Late result cannot publish', steps: [] };
  } });
  f.ctx.signal = stopped.signal; f.put('first.js', 'original');
  assert.equal(f.team.beforeStep({ ctx: f.ctx }), null);
  const pending = f.team.tool.execute({ tasks: [task('first', ['first.js'])] }, f.ctx);
  await ready.promise; stopped.abort(); const result = await pending;
  assert.equal(f.team.signal.aborted, true); assert.equal(result.ok, false);
  assert.equal(result.tasks[0].stoppedReason, 'team_cancelled'); assert.deepEqual(result.tasks[0].proposals, []);
  assert.equal(f.team.getUsage().tokensEstimate, 6); assert.equal(f.get('first.js'), 'original');
  assert.equal((await f.write({ proposalId: 'unknown' })).code, 'team_cancelled');
});

test('absolute deadline aborts the exposed parent signal and every child without extending its budget', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const entered = deferred();
  const f = fixture(t, { maxRuntimeMs: 1000, run: async (_client, options) => {
    assert.equal(options.maxRuntimeMs, 900); assert.equal(options.onBeforeStep(), null);
    entered.resolve();
    await new Promise((resolve) => options.ctx.signal.addEventListener('abort', resolve, { once: true }));
    return { stoppedReason: 'finalized', finalAnswer: 'Too late', steps: [] };
  } });
  assert.equal(f.team.beforeStep({ ctx: f.ctx }), null); t.mock.timers.tick(100);
  const pending = f.team.tool.execute({ tasks: [task('review')] }, f.ctx);
  await entered.promise; t.mock.timers.tick(900); const result = await pending;
  assert.equal(f.team.signal.aborted, true); assert.equal(f.team.signal.reason.code, 'team_deadline');
  assert.equal(result.ok, false); assert.deepEqual(result.tasks[0].proposals, []);
  assert.equal(f.team.beforeStep().reason, 'team_deadline');
});

test('declared tool timeout follows configuration and the same finite absolute deadline without restarting it', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const f = fixture(t, { maxRuntimeMs: 1000 });
  assert.equal(f.team.tool.timeoutMs, 2000);
  assert.equal(f.team.configureBudget({ maxRuntimeMs: 180000 }), true);
  assert.equal(f.team.tool.timeoutMs, 181000);
  f.team.beforeStep(); t.mock.timers.tick(120000);
  assert.equal(f.team.tool.timeoutMs, 61000);
  assert.equal(f.team.configureBudget({ maxRuntimeMs: 999999 }), false);
  t.mock.timers.tick(59999); assert.equal(f.team.tool.timeoutMs, 1001); assert.equal(f.team.signal.aborted, false);
  t.mock.timers.tick(1); assert.equal(f.team.tool.timeoutMs, 1000); assert.equal(f.team.signal.aborted, true);
  assert.equal(f.team.beforeStep().stop, true);
  const invalid = fixture(t, { maxRuntimeMs: Infinity });
  assert.equal(Number.isFinite(invalid.team.tool.timeoutMs), true);
});

test('event harness waits beyond its default until team cancellation and records all reported child usage', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { createAgentEventStream } = require('../src/services/agent-harness/event-stream');
  const entered = deferred(), settling = deferred(); let settled = false;
  const f = fixture(t, { maxRuntimeMs: 1000, run: async (_client, options) => {
    entered.resolve();
    await new Promise((resolve) => options.ctx.signal.addEventListener('abort', resolve, { once: true }));
    const completion = new Promise((resolve) => setTimeout(resolve, 500));
    settling.resolve(); await completion;
    options.onStepDone({ step: 0, usage: { inputTokens: 9, outputTokens: 2, tokensEstimate: 11 } });
    return { stoppedReason: 'aborted', steps: [] };
  } });
  // Match production: the harness wraps before the final turn budget override.
  const events = createAgentEventStream();
  const [wrapped] = events.wrapTools([f.team.tool]);
  f.team.configureBudget({ maxRuntimeMs: 180000 }); f.team.beforeStep(); t.mock.timers.tick(30000);
  const pending = wrapped.execute({ tasks: [task('review')] }, f.ctx)
    .then((value) => { settled = true; return value; }, (error) => { settled = true; return { error }; });
  await entered.promise;
  t.mock.timers.tick(120001); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false, 'the generic 120-second timer must not abandon the running team');
  t.mock.timers.tick(29999);
  await settling.promise;
  assert.equal(f.team.signal.aborted, true); assert.equal(f.team.beforeStep().stop, true);
  assert.equal(settled, false); t.mock.timers.tick(500);
  const result = await pending;
  assert.equal(f.team.signal.aborted, true); assert.equal(result.ok, false); assert.equal(result.error, undefined);
  assert.equal(f.team.getUsage().tokensEstimate, 11);
});

test('ordinary workspace read/write delegates unchanged and a busy batch cannot overlap another batch', async (t) => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { run: async () => { entered.resolve(); await release.promise;
    return { stoppedReason: 'finalized', finalAnswer: 'Read only', steps: [] }; } });
  f.put('first.js', 'original'); assert.equal((await f.read({ path: 'first.js' })).content, 'original');
  assert.equal((await f.write({ path: 'first.js', content: 'parent edit' })).ok, true);
  assert.equal(f.get('first.js'), 'parent edit'); assert.equal(f.state.writes, 1);
  const pending = f.team.tool.execute({ tasks: [task('one')] }, f.ctx); await entered.promise;
  assert.equal((await f.team.tool.execute({ tasks: [task('two')] }, f.ctx)).code, 'team_busy');
  release.resolve(); assert.equal((await pending).ok, true);
});

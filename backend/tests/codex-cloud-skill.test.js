'use strict';

/**
 * codex_cloud skill — chat builds and runs cloud apps with zero new UI.
 *
 * All Codex collaborators come from ctx.codex fakes: no Docker, no Prisma,
 * no Redis, no network. Covers preflights (flag/user/gate), project
 * binding per chat, plan→build with bounded waits, preview URL shape,
 * exec/read validation, abort-cancels-run, and the pure helpers.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const skill = require('../src/skills/codex_cloud/handler');
const manifest = require('../src/skills/codex_cloud/manifest.json');

const USER = { id: 'user-1', isAdmin: false, isSuperAdmin: false, deletedAt: null };

function baseCodex(overrides = {}) {
  const projects = new Map();
  const runs = new Map();
  let seq = 0;
  const next = (p) => `${p}-${++seq}`;
  return {
    flags: { isCodexV2Enabled: () => true },
    access: { canUseCodexAgent: () => true },
    projects: {
      async listProjects() { return [...projects.values()]; },
      async getProject({ id }) {
        const p = projects.get(id);
        if (!p) return null;
        return p;
      },
      async createProject({ userId, name, brief }) {
        const p = { id: next('proj'), userId, name, brief: brief || null, status: 'ready' };
        projects.set(p.id, p);
        return p;
      },
    },
    runs: {
      async createRun({ projectId, mode, planRunId }) {
        if (mode === 'build' && !planRunId) {
          const err = new Error('plan_run_required: build requires planRunId');
          err.code = 'plan_run_required';
          throw err;
        }
        const r = { id: next('run'), projectId, mode, planRunId: planRunId || null, status: 'done', error: null, finishedAt: new Date().toISOString() };
        runs.set(r.id, r);
        return { ...r };
      },
      async getRun({ runId }) { return runs.get(runId) ? { ...runs.get(runId) } : null; },
      async cancelRun({ runId }) {
        const r = runs.get(runId);
        if (!r) { const e = new Error('run_not_found'); e.code = 'run_not_found'; throw e; }
        r.status = 'cancelled';
        return { ...r };
      },
      __runs: runs,
    },
    runner: {
      async devStatus() { return { running: false, ready: false }; },
      async startDev() { return { port: 5173 }; },
      async exec(project, cmd) { return { exitCode: 0, stdout: `ran ${cmd.join(' ')}`, stderr: '' }; },
      async readFile(project, path) { return { content: `// ${path}\nconsole.log(1);\n` }; },
    },
    previewProxy: {
      previewTokenFor: () => 'tok.body.sig',
      verifyPreviewToken: () => null,
    },
    ...overrides,
  };
}

function ctxWith(codex, extra = {}) {
  // Short budgets keep the suite fast; production defaults are ~100s.
  return {
    userId: USER.id, chatId: 'chat-9', prisma: {},
    userStore: { findUserById: async () => ({ ...USER }) },
    timeouts: { waitMs: 1500, previewMs: 1500, pollMs: 50 },
    codex, ...extra,
  };
}

test('manifest declares the chat-safe contract', () => {
  assert.equal(manifest.id, 'codex_cloud');
  assert.ok(manifest.description.length > 50);
  assert.ok(manifest.description.includes('explicitly confirmed'));
  assert.deepEqual(manifest.capabilities, ['net:outbound']);
  assert.ok(manifest.timeoutMs <= 120000);
  assert.deepEqual(manifest.params.required, ['action']);
  const actions = manifest.params.properties.action.enum;
  for (const a of ['ensure_project', 'plan', 'build', 'status', 'preview', 'exec', 'read', 'cancel']) {
    assert.ok(actions.includes(a), `missing action ${a}`);
  }
});

test('preflight: disabled flag refuses before touching anything', async () => {
  const codex = baseCodex({ flags: { isCodexV2Enabled: () => false } });
  await assert.rejects(
    skill.execute({ action: 'status', runId: 'r1' }, ctxWith(codex)),
    /codex_disabled/,
  );
});

test('preflight: unknown user and forbidden account are refused', async () => {
  const noUser = baseCodex();
  await assert.rejects(
    skill.execute({ action: 'status', runId: 'r1' }, { ...ctxWith(noUser), userId: null, userStore: null, prisma: null }),
    /codex_no_user|codex_store_unavailable/,
  );
  const denied = baseCodex({ access: { canUseCodexAgent: () => false } });
  await assert.rejects(
    skill.execute({ action: 'status', runId: 'r1' }, ctxWith(denied)),
    /codex_forbidden/,
  );
});

test('ensure_project binds one project per chat and reuses it', async () => {
  const codex = baseCodex();
  const ctx = ctxWith(codex);
  const first = await skill.execute({ action: 'ensure_project', chatId: 'chat-9', name: 'Mi tienda' }, ctx);
  assert.equal(first.ok, true);
  assert.ok(first.projectId);
  assert.equal(first.reused, false);
  const second = await skill.execute({ action: 'ensure_project', chatId: 'chat-9' }, ctx);
  assert.equal(second.projectId, first.projectId);
  assert.equal(second.reused, true);
});

test('plan then build flow with bounded waits', async () => {
  const codex = baseCodex();
  const ctx = ctxWith(codex);
  const ensured = await skill.execute({ action: 'ensure_project', chatId: 'chat-9', name: 'Blog' }, ctx);
  const plan = await skill.execute({ action: 'plan', projectId: ensured.projectId, goal: 'Un blog con 3 posts' }, ctx);
  assert.ok(plan.planRunId);
  assert.equal(plan.status, 'done');
  const build = await skill.execute({ action: 'build', projectId: ensured.projectId, planRunId: plan.planRunId }, ctx);
  assert.equal(build.status, 'done');
  const st = await skill.execute({ action: 'status', runId: build.runId }, ctx);
  assert.equal(st.status, 'done');
  assert.equal(st.active, false);
});

test('build without a plan is refused with a stable code', async () => {
  const codex = baseCodex();
  const ctx = ctxWith(codex);
  const ensured = await skill.execute({ action: 'ensure_project', chatId: 'chat-9', name: 'X' }, ctx);
  await assert.rejects(
    skill.execute({ action: 'build', projectId: ensured.projectId }, ctx),
    /plan_required/,
  );
});

test('preview returns the tokenized base path without leaking the secret', async () => {
  const codex = baseCodex();
  const ctx = ctxWith(codex);
  const ensured = await skill.execute({ action: 'ensure_project', chatId: 'chat-9', name: 'Shop' }, ctx);
  // Fake runner reports running with a fresh token basePath.
  codex.runner.devStatus = async () => ({ running: true, ready: true, basePath: '/api/codex/projects/p1/preview/abc.def/app/' });
  codex.previewProxy.verifyPreviewToken = () => ({ projectId: ensured.projectId, exp: Date.now() + 3600_000 });
  const reused = await skill.execute({ action: 'preview', projectId: ensured.projectId }, ctx);
  assert.equal(reused.previewUrl, '/api/codex/projects/p1/preview/abc.def/app/');
  assert.equal(reused.reused, true);
  // Fresh start mints a new token, then the dev server reports ready.
  let started = false;
  codex.runner.devStatus = async () => (started
    ? { running: true, ready: true, basePath: `/api/codex/projects/${ensured.projectId}/preview/new.tok/app/` }
    : { running: false, ready: false });
  codex.runner.startDev = async () => { started = true; return { port: 5173 }; };
  const startedRes = await skill.execute({ action: 'preview', projectId: ensured.projectId }, ctx);
  assert.equal(startedRes.reused, false);
  assert.equal(startedRes.previewUrl, `/api/codex/projects/${ensured.projectId}/preview/new.tok/app/`);
});

test('exec validates argv and truncates output; read validates paths', async () => {
  const codex = baseCodex();
  const ctx = ctxWith(codex);
  const ensured = await skill.execute({ action: 'ensure_project', chatId: 'chat-9', name: 'T' }, ctx);
  await assert.rejects(skill.execute({ action: 'exec', projectId: ensured.projectId, cmd: [] }, ctx), /invalid_cmd/);
  await assert.rejects(skill.execute({ action: 'exec', projectId: ensured.projectId, cmd: 'bun --version' }, ctx), /invalid_cmd/);
  const ok = await skill.execute({ action: 'exec', projectId: ensured.projectId, cmd: ['bun', '--version'] }, ctx);
  assert.equal(ok.exitCode, 0);
  assert.match(ok.stdout, /ran bun --version/);
  await assert.rejects(skill.execute({ action: 'read', projectId: ensured.projectId, path: '../../etc/passwd' }, ctx), /invalid_path/);
  await assert.rejects(skill.execute({ action: 'read', projectId: ensured.projectId, path: '/abs' }, ctx), /invalid_path/);
  const file = await skill.execute({ action: 'read', projectId: ensured.projectId, path: 'src/app.ts' }, ctx);
  assert.match(file.content, /app\.ts/);
});

test('pending runs return runId instead of hanging; cancel flips status', async () => {
  const codex = baseCodex();
  codex.runs.__runs.clear();
  const ctx = ctxWith(codex);
  const ensured = await skill.execute({ action: 'ensure_project', chatId: 'chat-9', name: 'Slow' }, ctx);
  // Never-terminal run: getRun always reports running.
  codex.runs.getRun = async ({ runId }) => ({ id: runId, projectId: ensured.projectId, mode: 'plan', status: 'running', error: null, finishedAt: null });
  codex.runs.createRun = async ({ projectId }) => {
    const r = { id: 'run-slow', projectId, mode: 'plan', status: 'running', error: null, finishedAt: null };
    codex.runs.__runs.set('run-slow', r);
    return { ...r };
  };
  const pending = await skill.execute({ action: 'plan', projectId: ensured.projectId, goal: 'algo enorme' }, ctx);
  assert.equal(pending.pending, true);
  assert.equal(pending.runId, 'run-slow');
  const cancelled = await skill.execute({ action: 'cancel', runId: 'run-slow' }, ctx);
  assert.equal(cancelled.status, 'cancelled');
});

test('abort during a plan cancels the created run', async () => {
  const codex = baseCodex();
  const ctx = ctxWith(codex);
  const ensured = await skill.execute({ action: 'ensure_project', chatId: 'chat-9', name: 'A' }, ctx);
  let calls = 0;
  codex.runs.getRun = async () => { calls += 1; if (calls === 1) return { id: 'run-x', projectId: ensured.projectId, mode: 'plan', status: 'running', error: null, finishedAt: null }; throw Object.assign(new Error('agent run aborted'), { name: 'AbortError', code: 'ABORT_ERR' }); };
  codex.runs.createRun = async ({ projectId }) => ({ id: 'run-x', projectId, mode: 'plan', status: 'running', error: null, finishedAt: null });
  let cancelledId = null;
  codex.runs.cancelRun = async ({ runId }) => { cancelledId = runId; return { id: runId, status: 'cancelled' }; };
  await assert.rejects(
    skill.execute({ action: 'plan', projectId: ensured.projectId, goal: 'x' }, ctx),
    (err) => { assert.equal(cancelledId, 'run-x'); return err?.name === 'AbortError'; },
  );
});

test('unknown action and missing skill deps fail loudly', async () => {
  const codex = baseCodex();
  await assert.rejects(skill.execute({ action: 'deploy_moon' }, ctxWith(codex)), /invalid_action/);
  await assert.rejects(
    skill.execute({ action: 'status', runId: 'r' }, { userId: 'u1', codex: {} }),
    /codex_unavailable|codex_disabled|codex_store_unavailable/,
  );
});

test('pure helpers: truncation, clamps, validators, base path', () => {
  const internal = skill._internal;
  assert.equal(internal.truncate('abcdef', 4).includes('…[truncated 2 chars]'), true);
  assert.equal(internal.truncate('abc', 10), 'abc');
  assert.equal(internal.clampTimeoutMs('nope', 5000), 5000);
  assert.equal(internal.clampTimeoutMs(999_999_999, 5000), 60_000);
  assert.equal(internal.isTerminalStatus('done'), true);
  assert.equal(internal.isTerminalStatus('running'), false);
  assert.equal(internal.validateCmd(['bun', '--version']), null);
  assert.ok(internal.validateCmd([]));
  assert.ok(internal.validateCmd('../x'));
  assert.ok(internal.validateReadPath('/abs'));
  assert.equal(internal.validateReadPath('src/a.ts'), null);
  assert.equal(
    internal.previewBasePath('p1', 't.k'),
    '/api/codex/projects/p1/preview/t.k/app/',
  );
});

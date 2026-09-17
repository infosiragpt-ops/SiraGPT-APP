'use strict';

// "Dame la web en local": project_clone_repo + project_preview_* drive the
// chat-bound Codex project through the runner. In-memory doubles only.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../src/services/codex/chat-preview.service');
const tools = require('../src/services/agents/project-preview-tools');
const opencodeHarness = require('../src/services/codex/opencode-harness');

const ENV = {
  CODE_RUNNER_PREVIEW_TOKEN_SECRET: 'test-secret-test-secret-test-secret-1234',
  PUBLIC_FRONTEND_URL: 'https://siragpt.com',
  CODEX_PREVIEW_START_TIMEOUT_MS: '3000',
  CODEX_PREVIEW_START_POLL_MS: '250',
};

function makeDb({ user = { id: 'u1', isAdmin: true, isSuperAdmin: false, deletedAt: null } } = {}) {
  const rows = [];
  return {
    rows,
    user: { findUnique: async ({ where }) => (where.id === user.id ? user : null) },
    codexProject: {
      create: async ({ data }) => { const row = { id: `p${rows.length + 1}`, ...data }; rows.push(row); return row; },
      update: async ({ where, data }) => { const row = rows.find((r) => r.id === where.id); Object.assign(row, data); return row; },
    },
  };
}

function makeBinding(map = {}) {
  return {
    cleanChatId: (id) => (typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null),
    findProjectForChat: async ({ userId, chatId }) => map[`${userId}:${chatId}`] || null,
  };
}

function makeRunner({ statuses = [], startDev } = {}) {
  const calls = [];
  let i = 0;
  return {
    calls,
    initWorkspace: async (p) => { calls.push(['initWorkspace', p]); return { ok: true }; },
    exec: async (p, cmd) => { calls.push(['exec', p, cmd.join(' ')]); return { ok: true, exitCode: cmd[0] === 'git' && cmd[1] === 'remote' && cmd[2] === 'get-url' ? 1 : 0, stdout: 'abc123\n', stderr: '' }; },
    startDev: async (p, opts) => { calls.push(['startDev', p, opts]); return startDev ? startDev(p, opts) : { port: 4301, project: p, reused: false }; },
    devStatus: async (p) => { calls.push(['devStatus', p]); const s = statuses[Math.min(i, statuses.length - 1)]; i += 1; return s || { running: false, ready: false }; },
    stopDev: async (p) => { calls.push(['stopDev', p]); return { ok: true }; },
  };
}

const noSleep = async () => {};

test('project_clone_repo: rejects non-github URLs and missing chat', async () => {
  const noChat = await tools.projectCloneRepoTool.execute({ repoUrl: 'https://github.com/a/b' }, { userId: 'u1' });
  assert.equal(noChat.code, 'no_chat_context');
  const ctx = { userId: 'u1', chatId: 'c1', projectTools: { db: makeDb(), runner: makeRunner(), binding: makeBinding(), projectService: {}, githubApi: null, env: ENV } };
  const bad = await tools.projectCloneRepoTool.execute({ repoUrl: 'https://gitlab.com/a/b' }, ctx);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'repository_host_unsupported');
  const empty = await tools.projectCloneRepoTool.execute({}, ctx);
  assert.equal(empty.code, 'invalid_repository_url');
});

test('project_clone_repo: codex gate blocks non-admin accounts without allowlist', async () => {
  const db = makeDb({ user: { id: 'u1', isAdmin: false, isSuperAdmin: false, deletedAt: null } });
  const ctx = { userId: 'u1', chatId: 'c1', projectTools: { db, runner: makeRunner(), binding: makeBinding(), projectService: {}, githubApi: null, env: { ...ENV, CODEX_AGENT_ALLOWED_USER_IDS: '' } } };
  const out = await tools.projectCloneRepoTool.execute({ repoUrl: 'https://github.com/infosiragpt-ops/runelectric' }, ctx);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'codex_forbidden');
  const allowed = { ...ctx, projectTools: { ...ctx.projectTools, env: { ...ENV, CODEX_AGENT_ALLOWED_USER_IDS: 'u1' } } };
  const ok = await tools.projectCloneRepoTool.execute({ repoUrl: 'https://github.com/infosiragpt-ops/runelectric' }, allowed);
  assert.equal(ok.ok, true);
});

test('project_clone_repo: clones into a chat-bound project and points to preview', async () => {
  const db = makeDb();
  const runner = makeRunner();
  const ctx = { userId: 'u1', chatId: 'c1', projectTools: { db, runner, binding: makeBinding(), projectService: {}, githubApi: null, env: ENV } };
  const out = await tools.projectCloneRepoTool.execute({ repoUrl: 'https://github.com/infosiragpt-ops/runelectric', branch: 'main' }, ctx);
  assert.equal(out.ok, true);
  assert.equal(out.reused, false);
  assert.equal(out.repository.fullName, 'infosiragpt-ops/runelectric');
  assert.equal(out.branch, 'main');
  assert.equal(out.commitSha, 'abc123');
  assert.match(out.next, /project_preview_start/);
  assert.equal(db.rows[0].brief.chatId, 'c1');
  assert.equal(db.rows[0].status, 'ready');
  assert.equal(db.rows[0].brief.repository.fullName, 'infosiragpt-ops/runelectric');
  assert.ok(runner.calls.some((c) => c[0] === 'exec' && /fetch --depth=1 origin refs\/heads\/main/.test(c[2])));
});

test('project_clone_repo: an already bound chat is reused, nothing is cloned', async () => {
  const db = makeDb();
  const runner = makeRunner();
  const binding = makeBinding({ 'u1:c1': { id: 'pX', name: 'Mi app', status: 'ready' } });
  const ctx = { userId: 'u1', chatId: 'c1', projectTools: { db, runner, binding, projectService: {}, githubApi: null, env: ENV } };
  const out = await tools.projectCloneRepoTool.execute({ repoUrl: 'https://github.com/infosiragpt-ops/runelectric' }, ctx);
  assert.equal(out.ok, true);
  assert.equal(out.reused, true);
  assert.equal(out.project.id, 'pX');
  assert.equal(runner.calls.length, 0);
  assert.equal(db.rows.length, 0);
});

test('project_clone_repo: clone failure marks the project as error and reports it', async () => {
  const db = makeDb();
  const runner = makeRunner();
  runner.exec = async (p, cmd) => (cmd.includes('fetch') ? { ok: false, exitCode: 128, stdout: '', stderr: 'fatal: could not read Username' } : { ok: true, exitCode: 1, stdout: '', stderr: '' });
  const ctx = { userId: 'u1', chatId: 'c1', projectTools: { db, runner, binding: makeBinding(), projectService: {}, githubApi: null, env: ENV } };
  const out = await tools.projectCloneRepoTool.execute({ repoUrl: 'https://github.com/infosiragpt-ops/private-thing' }, ctx);
  assert.equal(out.ok, false);
  assert.ok(['clone_failed', 'github_auth_required'].includes(out.code));
  assert.equal(db.rows[0].status, 'error');
});

test('project_preview_start: starts the dev server and returns an absolute tokenized preview URL', async () => {
  const runner = makeRunner({ statuses: [
    { running: false, ready: false },
    { running: true, ready: false, state: 'installing', port: 4301, project: 'pX', tail: ['$ bun install'] },
    { running: true, ready: true, state: 'ready', port: 4301, project: 'pX', framework: 'vite', tail: ['ready'] },
  ] });
  const binding = makeBinding({ 'u1:c1': { id: 'pX', name: 'runelectric' } });
  const ctx = { userId: 'u1', chatId: 'c1', projectTools: { db: makeDb(), runner, binding, projectService: {}, env: ENV, sleep: noSleep } };
  const out = await tools.projectPreviewStartTool.execute({}, ctx);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.match(out.previewUrl, /^https:\/\/siragpt\.com\/api\/codex\/projects\/pX\/preview\/[^/]+\/app\/$/);
  assert.equal(out.port, 4301);
  assert.equal(out.status.ready, true);
  assert.match(out.hint, /previewUrl/);
  const start = runner.calls.find((c) => c[0] === 'startDev');
  assert.equal(start[1], 'pX');
  assert.match(start[2].basePath, /^\/api\/codex\/projects\/pX\/preview\//);
});

test('project_preview_start: preferredPort is forwarded as a hint', async () => {
  const runner = makeRunner({ statuses: [
    { running: false, ready: false },
    { running: true, ready: true, state: 'ready', port: 4301, project: 'pX', tail: ['ready'] },
  ] });
  const binding = makeBinding({ 'u1:c1': { id: 'pX', name: 'x' } });
  const ctx = { userId: 'u1', chatId: 'c1', projectTools: { db: makeDb(), runner, binding, projectService: {}, env: ENV, sleep: noSleep } };
  const out = await tools.projectPreviewStartTool.execute({ preferredPort: 5000 }, ctx);
  assert.equal(out.ok, true, JSON.stringify(out));
  const start = runner.calls.find((c) => c[0] === 'startDev');
  assert.equal(start[2].preferredPort, 5000);
});

test('project_preview_start: no project → no_project; dev error → preview_not_ready with tail', async () => {
  const none = await tools.projectPreviewStartTool.execute({}, { userId: 'u1', chatId: 'c9', projectTools: { db: makeDb(), runner: makeRunner(), binding: makeBinding(), projectService: {}, env: ENV, sleep: noSleep } });
  assert.equal(none.code, 'no_project');
  const runner = makeRunner({ statuses: [
    { running: false, ready: false },
    { running: false, ready: false, error: 'bun install failed (exit 1)', tail: ['error: missing package.json'] },
  ] });
  const binding = makeBinding({ 'u1:c1': { id: 'pX', name: 'x' } });
  const out = await tools.projectPreviewStartTool.execute({}, { userId: 'u1', chatId: 'c1', projectTools: { db: makeDb(), runner, binding, projectService: {}, env: ENV, sleep: noSleep } });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'preview_not_ready');
  assert.match(out.message, /bun install failed/);
  assert.deepEqual(out.status.tail, ['error: missing package.json']);
});

test('project_preview_start: reuses a live server whose token is still fresh', async () => {
  const { previewTokenFor } = require('../src/services/code/preview-proxy');
  const token = previewTokenFor({ projectId: 'pX', userId: 'u1' }, ENV);
  const basePath = `/api/codex/projects/pX/preview/${encodeURIComponent(token)}/app/`;
  const runner = makeRunner({ statuses: [{ running: true, ready: true, port: 4302, project: 'pX', basePath }] });
  const binding = makeBinding({ 'u1:c1': { id: 'pX', name: 'x' } });
  const out = await tools.projectPreviewStartTool.execute({}, { userId: 'u1', chatId: 'c1', projectTools: { db: makeDb(), runner, binding, projectService: {}, env: ENV, sleep: noSleep } });
  assert.equal(out.ok, true);
  assert.equal(out.reused, true);
  assert.equal(out.previewUrl, `https://siragpt.com${basePath}`);
  assert.equal(runner.calls.some((c) => c[0] === 'startDev'), false);
});

test('project_preview_status / stop', async () => {
  const runner = makeRunner({ statuses: [{ running: true, ready: true, port: 4302, project: 'pX', basePath: '/api/codex/projects/pX/preview/t/app/', tail: ['a'] }] });
  const binding = makeBinding({ 'u1:c1': { id: 'pX', name: 'x' } });
  const ctx = { userId: 'u1', chatId: 'c1', projectTools: { db: makeDb(), runner, binding, projectService: {}, env: ENV } };
  const st = await tools.projectPreviewStatusTool.execute({}, ctx);
  assert.equal(st.ok, true);
  assert.equal(st.previewUrl, 'https://siragpt.com/api/codex/projects/pX/preview/t/app/');
  const stop = await tools.projectPreviewStopTool.execute({}, ctx);
  assert.equal(stop.stopped, true);
  assert.ok(runner.calls.some((c) => c[0] === 'stopDev'));
});

test('tools are registered in the agentic chat loop and never throw', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'agentic-chat-stream.js'), 'utf8');
  assert.match(src, /projectCloneRepoTool, projectPreviewStartTool, projectPreviewStatusTool, projectPreviewStopTool/);
  for (const tool of [tools.projectCloneRepoTool, tools.projectPreviewStartTool, tools.projectPreviewStatusTool, tools.projectPreviewStopTool]) {
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/);
    const out = await tool.execute({ repoUrl: 'https://github.com/a/b' }, { userId: 'u1', chatId: 'c1', projectTools: { previewService: { cloneRepoForChat: async () => { throw new Error('boom'); }, startPreviewForChat: async () => { throw new Error('boom'); }, previewStatusForChat: async () => { throw new Error('boom'); }, stopPreviewForChat: async () => { throw new Error('boom'); } } } });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'internal');
  }
  assert.equal(typeof opencodeHarness.parsePublicGithubRepo, 'function');
});

test('project_preview_start: still installing after the wait budget → preview_pending (not an error), env + port forwarded', async () => {
  const runner = makeRunner({ statuses: [
    { running: false, ready: false },
    { running: true, ready: false, state: 'installing', port: 5000, project: 'pX', tail: ['$ npm ci'] },
  ] });
  const binding = makeBinding({ 'u1:c1': { id: 'pX', name: 'SiraGPT-APP' } });
  const ctx = { userId: 'u1', chatId: 'c1', projectTools: { db: makeDb(), runner, binding, projectService: {}, env: { ...ENV, CODEX_PREVIEW_START_TIMEOUT_MS: '600' }, sleep: noSleep } };
  const out = await tools.projectPreviewStartTool.execute({ preferredPort: 5000, env: { NEXT_PUBLIC_API_URL: '/api', DATABASE_URL: 'nope' }, waitMs: 5000 }, ctx);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'preview_pending');
  assert.equal(out.pending, true);
  assert.equal(out.status.state, 'installing');
  assert.match(out.previewUrl, /^https:\/\/siragpt\.com\/api\/codex\/projects\/pX\/preview\//);
  const start = runner.calls.find((c) => c[0] === 'startDev');
  assert.equal(start[2].preferredPort, 5000);
  assert.deepEqual(start[2].env, { NEXT_PUBLIC_API_URL: '/api' });
});

test('project_preview_status waits when asked and reports ready', async () => {
  const runner = makeRunner({ statuses: [
    { running: true, ready: false, state: 'starting', port: 5000, project: 'pX' },
    { running: true, ready: true, state: 'ready', port: 5000, project: 'pX', basePath: '/api/codex/projects/pX/preview/t/app/' },
  ] });
  const binding = makeBinding({ 'u1:c1': { id: 'pX', name: 'x' } });
  const out = await tools.projectPreviewStatusTool.execute({ waitMs: 5000 }, { userId: 'u1', chatId: 'c1', projectTools: { db: makeDb(), runner, binding, projectService: {}, env: ENV, sleep: noSleep } });
  assert.equal(out.ok, true);
  assert.equal(out.status.ready, true);
  assert.equal(out.previewUrl, 'https://siragpt.com/api/codex/projects/pX/preview/t/app/');
});

test('RLCD outcomes: ready preview is tool_success, hard failure is failure, pending is nothing', () => {
  const { recordRlcdOutcome } = tools._internal;
  const rlcd = require('../src/services/rlcd');
  rlcd.reset();
  const id = rlcd.ledger.recordDecision({ kind: 'execution_lane', choice: 'agentic', confidence: 0.9, chatId: 'c1' });
  rlcd.ledger.markTurn('c1', [id]);
  recordRlcdOutcome({ chatId: 'c1' }, { ok: false, code: 'preview_pending', pending: true });
  assert.equal(rlcd.ledger.getDecision(id).outcome, null);
  recordRlcdOutcome({ chatId: 'c1' }, { ok: true, previewUrl: 'x', status: { ready: true } });
  assert.equal(rlcd.ledger.getDecision(id).outcome.label, 'tool_success');
  recordRlcdOutcome({ chatId: 'c1' }, { ok: false, code: 'preview_not_ready' });
  assert.equal(rlcd.ledger.getDecision(id).outcome.label, 'failure');
  rlcd.reset();
});

test('Next previews are shared without the trailing slash (skipTrailingSlashRedirect apps answer "/" empty)', async () => {
  const runner = makeRunner({ statuses: [
    { running: false, ready: false },
    { running: true, ready: true, state: 'ready', port: 5000, project: 'pX', framework: 'next', tail: [] },
  ] });
  const binding = makeBinding({ 'u1:c1': { id: 'pX', name: 'SiraGPT-APP' } });
  const out = await tools.projectPreviewStartTool.execute({ preferredPort: 5000 }, { userId: 'u1', chatId: 'c1', projectTools: { db: makeDb(), runner, binding, projectService: {}, env: ENV, sleep: noSleep } });
  assert.equal(out.ok, true);
  assert.match(out.previewUrl, /\/app$/);
  assert.match(out.basePath, /\/app\/$/);
  const { absolutePreviewUrl } = svc._internal;
  assert.equal(absolutePreviewUrl('/x/app/', ENV, 'vite'), 'https://siragpt.com/x/app/');
  assert.equal(absolutePreviewUrl('/x/app/', ENV, 'next'), 'https://siragpt.com/x/app');
});

'use strict';

// Contrato HTTP de la Etapa 7 (paridad Claude Code): GET /projects/:id/changes
// y POST /projects/:id/github/publish-workspace para el repo vinculado a un
// chat de /agentes. Harness real de opencode/self-hosting con runner falso
// (cero red), codexDb monkey-patcheado como en codex-github-clone-publish-route.
// El token OAuth del usuario viaja solo en memoria: nunca en la respuesta.

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { mockResolvedModule } = require('./http-test-utils');

const STORED_TOKEN = 'gho_storedOAuth_workspace_abcdef0123';

let authUser = { id: 'u-1', isAdmin: true, isSuperAdmin: false };
const restoreAuth = mockResolvedModule(require.resolve('../src/middleware/auth'), {
  authenticateToken(req, _res, next) {
    req.user = authUser;
    next();
  },
});

const githubState = { token: null };
const restoreGithubApi = mockResolvedModule(require.resolve('../src/services/github/github-api.service'), {
  async resolveUserToken() {
    if (!githubState.token) {
      const e = new Error('GitHub is not connected for this user');
      e.status = 409;
      e.code = 'github_not_connected';
      throw e;
    }
    return { account: { id: 'acc-1' }, accessToken: githubState.token };
  },
  async getRepository() {
    return null;
  },
});

const NS = 'M\0src/a.ts\0A\0src/new.ts\0';
const NUM = '3\t1\tsrc/a.ts\x0010\t0\tsrc/new.ts\0';
const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,3 @@\n-old\n+new\n';

function fakeRunner({ dirty = true, ahead = 0, files = {} } = {}) {
  const calls = [];
  return {
    calls,
    async initWorkspace() {
      return { ok: true };
    },
    async exec(_projectId, argv) {
      const joined = argv.join(' ');
      calls.push(joined);
      if (joined.startsWith('git rev-parse --verify --quiet ')) return { exitCode: 0, stdout: 'basesha1\n', stderr: '' };
      if (joined.startsWith('git rev-parse --abbrev-ref HEAD')) return { exitCode: 0, stdout: 'production-main\n', stderr: '' };
      if (joined.startsWith('git rev-parse HEAD')) return { exitCode: 0, stdout: 'headsha2\n', stderr: '' };
      if (joined.startsWith('git rev-parse production-main')) return { exitCode: 0, stdout: 'basesha1\n', stderr: '' };
      if (joined.startsWith('git rev-list --count')) return { exitCode: 0, stdout: `${ahead}\n`, stderr: '' };
      if (joined.startsWith('git diff --name-status -z')) return { exitCode: 0, stdout: dirty ? NS : '', stderr: '' };
      if (joined.startsWith('git diff --numstat -z')) return { exitCode: 0, stdout: dirty ? NUM : '', stderr: '' };
      if (joined.startsWith('git status --porcelain')) return { exitCode: 0, stdout: dirty ? ' M src/a.ts\0A  src/new.ts\0' : '', stderr: '' };
      if (joined.startsWith('git diff --no-index')) return { exitCode: 1, stdout: '+++ b/src/new.ts\n+x\n', stderr: '' };
      if (joined.startsWith('git diff --name-only')) {
        if (joined.includes('--diff-filter=D')) return { exitCode: 0, stdout: '', stderr: '' };
        return { exitCode: 0, stdout: dirty ? 'src/a.ts\0src/new.ts\0' : '', stderr: '' };
      }
      if (joined.startsWith('git diff production-main')) return { exitCode: 0, stdout: dirty ? DIFF : '', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async readFile(_projectId, path) {
      if (Object.hasOwn(files, path)) return { content: files[path] };
      return { content: 'console.log(1)\n' };
    },
  };
}

let activeRunner = fakeRunner();
const realSandbox = require('../src/services/codex/sandbox-provider');
const restoreSandbox = mockResolvedModule(require.resolve('../src/services/codex/sandbox-provider'), {
  ...realSandbox,
  createSandboxClient: () => activeRunner,
});

const publishCalls = [];
let publishResult = null;
const restoreSelfHosting = mockResolvedModule(require.resolve('../src/services/codex/self-hosting'), {
  async publishSelfHostedPullRequest(args) {
    publishCalls.push(args);
    if (publishResult instanceof Error) throw publishResult;
    return publishResult || {
      ok: true,
      status: 'pull_request_opened',
      branch: args.runId ? `run/${args.runId}` : 'run/x',
      commitSha: 'def5678',
      files: 2,
      deleted: 0,
      pullRequest: { number: 12, url: 'https://github.com/acme/app/pull/12', state: 'open' },
    };
  },
});

const codexRoutes = require('../src/routes/codex');
const codexDb = require('../src/config/database');

const originals = { findFirst: codexDb.codexProject.findFirst };

function repoRow(overrides = {}) {
  return {
    id: 'p1',
    userId: 'u-1',
    name: 'App',
    status: 'ready',
    brief: {
      kind: 'repo-private',
      repository: { url: 'https://github.com/acme/app.git', webUrl: 'https://github.com/acme/app', fullName: 'acme/app', private: true, defaultBranch: 'production-main' },
      sourceBranch: 'production-main',
      chatId: 'chat_1',
    },
    ...overrides,
  };
}

function installDb(row) {
  codexDb.codexProject.findFirst = async ({ where }) => (row && row.userId === where.userId ? { ...row } : null);
}

after(() => {
  restoreAuth();
  restoreSandbox();
  restoreSelfHosting();
  restoreGithubApi();
  codexDb.codexProject.findFirst = originals.findFirst;
  delete process.env.CODEX_AGENT_V2;
});

beforeEach(() => {
  authUser = { id: 'u-1', isAdmin: true, isSuperAdmin: false };
  process.env.CODEX_AGENT_V2 = '1';
  activeRunner = fakeRunner();
  githubState.token = null;
  publishCalls.length = 0;
  publishResult = null;
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/codex', codexRoutes);
  return app;
}

test('GET /projects/:id/changes devuelve archivos, diff y repo del brief sin caché', async () => {
  installDb(repoRow());
  const res = await request(buildApp()).get('/api/codex/projects/p1/changes');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.body.base, { branch: 'production-main', sha: 'basesha1' });
  assert.deepEqual(res.body.repository, { url: 'https://github.com/acme/app', fullName: 'acme/app' });
  assert.deepEqual(res.body.files.map((f) => [f.path, f.status]), [['src/a.ts', 'modified'], ['src/new.ts', 'added']]);
  assert.equal(res.body.filesChanged, 2);
  assert.ok(res.body.diff.startsWith('diff --git a/src/a.ts'));
  assert.ok(activeRunner.calls.every((c) => !/git (checkout|add|commit)/.test(c)), 'solo lectura');
});

test('GET /projects/:id/changes: 404 ajeno, 409 sin repo, 502 runner caído', async () => {
  installDb(repoRow({ userId: 'u-2' }));
  assert.equal((await request(buildApp()).get('/api/codex/projects/p1/changes')).status, 404);

  installDb({ id: 'p1', userId: 'u-1', name: 'Plain', brief: { chatId: 'chat_1' } });
  const notRepo = await request(buildApp()).get('/api/codex/projects/p1/changes');
  assert.equal(notRepo.status, 409);
  assert.equal(notRepo.body.error, 'project_not_repo');

  installDb(repoRow());
  activeRunner = {
    async exec() {
      const err = new Error('runner unreachable: fetch failed');
      err.name = 'RunnerError';
      throw err;
    },
  };
  const down = await request(buildApp()).get('/api/codex/projects/p1/changes');
  assert.equal(down.status, 502);
  assert.equal(down.body.error, 'runner_unreachable');
});

test('POST publish-workspace sin confirm → 428 + plan y CERO mutación (con y sin token)', async () => {
  installDb(repoRow());
  const res = await request(buildApp()).post('/api/codex/projects/p1/github/publish-workspace').send({ title: 'feat: x' });
  assert.equal(res.status, 428, JSON.stringify(res.body));
  assert.equal(res.body.error, 'confirmation_required');
  assert.equal(res.body.plan.status, 'github_auth_required');
  assert.equal(res.body.plan.hasGithubToken, false);
  assert.equal(res.body.plan.base, 'production-main');
  assert.match(res.body.plan.branch, /^run\/agentes-[a-z0-9]+-\d{12}$/);
  assert.equal(res.body.plan.files, 2);
  assert.ok(activeRunner.calls.every((c) => !/git (checkout|add|commit)/.test(c)), 'el plan no muta el workspace');
  assert.equal(publishCalls.length, 0);

  githubState.token = STORED_TOKEN;
  activeRunner = fakeRunner();
  const ready = await request(buildApp()).post('/api/codex/projects/p1/github/publish-workspace').send({});
  assert.equal(ready.status, 428);
  assert.equal(ready.body.plan.status, 'ready_to_publish');
  assert.equal(ready.body.plan.hasGithubToken, true);
  assert.ok(!JSON.stringify(ready.body).includes(STORED_TOKEN));
});

test('POST publish-workspace sin cambios → 200 no_changes', async () => {
  installDb(repoRow());
  activeRunner = fakeRunner({ dirty: false, ahead: 0 });
  const res = await request(buildApp()).post('/api/codex/projects/p1/github/publish-workspace').send({});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.plan.status, 'no_changes');
  assert.equal(res.body.pullRequest, null);
});

test('POST publish-workspace confirm sin GitHub conectado → 428 github_auth_required sin mutar', async () => {
  installDb(repoRow());
  const res = await request(buildApp()).post('/api/codex/projects/p1/github/publish-workspace').send({ confirm: true });
  assert.equal(res.status, 428);
  assert.equal(res.body.error, 'github_auth_required');
  assert.ok(activeRunner.calls.every((c) => !/git (checkout|add|commit)/.test(c)));
  assert.equal(publishCalls.length, 0);
});

test('POST publish-workspace confirm con OAuth: rama run/agentes-*, commit, plan validado y PR abierto sin filtrar el token', async () => {
  installDb(repoRow());
  githubState.token = STORED_TOKEN;
  const res = await request(buildApp())
    .post('/api/codex/projects/p1/github/publish-workspace')
    .send({ confirm: true, title: 'feat(app): desde el chat', body: 'Cambios hechos en /agentes' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.pullRequest.url, 'https://github.com/acme/app/pull/12');
  assert.match(res.body.branch, /^run\/agentes-[a-z0-9]+-\d{12}$/);
  assert.equal(res.body.plan.status, 'ready_to_publish');
  assert.equal(res.body.plan.title, 'feat(app): desde el chat');
  assert.equal(res.body.plan.base, 'production-main');
  // Mutación exacta: rama de trabajo + commit con identidad Codex, nunca push.
  const checkout = activeRunner.calls.find((c) => c.startsWith('git checkout -B run/agentes-'));
  assert.ok(checkout, activeRunner.calls.join('\n'));
  assert.ok(activeRunner.calls.includes('git add -A'));
  assert.ok(activeRunner.calls.some((c) => c.includes('commit') && c.includes('-m feat(app): desde el chat')));
  assert.ok(activeRunner.calls.every((c) => !c.startsWith('git push')));
  // Publicación con la cuenta del usuario, repo y base del brief (no del cliente).
  assert.equal(publishCalls.length, 1);
  assert.equal(publishCalls[0].repositoryUrl, 'https://github.com/acme/app');
  assert.equal(publishCalls[0].sourceBranch, 'production-main');
  assert.equal(publishCalls[0].runId, checkout.replace('git checkout -B run/', ''));
  assert.equal(publishCalls[0].env.CODEX_SELF_HOST_GITHUB_TOKEN, STORED_TOKEN);
  assert.equal(process.env.CODEX_SELF_HOST_GITHUB_TOKEN, undefined);
  assert.ok(!JSON.stringify(res.body).includes(STORED_TOKEN), 'el token nunca vuelve en la respuesta');
});

test('POST publish-workspace: ruta sensible bloqueada por el plan → 400 sin publicar', async () => {
  installDb(repoRow());
  githubState.token = STORED_TOKEN;
  const runner = fakeRunner();
  const origExec = runner.exec.bind(runner);
  runner.exec = async (projectId, argv) => {
    const joined = argv.join(' ');
    if (joined.startsWith('git diff --name-only') && !joined.includes('--diff-filter=D')) {
      runner.calls.push(joined);
      return { exitCode: 0, stdout: '.env\0src/a.ts\0', stderr: '' };
    }
    return origExec(projectId, argv);
  };
  activeRunner = runner;
  const res = await request(buildApp()).post('/api/codex/projects/p1/github/publish-workspace').send({ confirm: true });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.error, 'pull_request_sensitive_path');
  assert.equal(publishCalls.length, 0);
});

test('POST publish-workspace: base divergente en GitHub → 409 base_branch_diverged', async () => {
  installDb(repoRow());
  githubState.token = STORED_TOKEN;
  publishResult = Object.assign(new Error('remote base branch advanced'), { code: 'base_branch_diverged' });
  const res = await request(buildApp()).post('/api/codex/projects/p1/github/publish-workspace').send({ confirm: true });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'base_branch_diverged');
});

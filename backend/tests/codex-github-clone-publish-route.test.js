'use strict';

// Contrato HTTP del slice OpenCode-web: clonar repo público y plan/publicar en
// GitHub desde /agentes sin tocar UI. Usa el harness REAL con un runner falso
// (cero red) y codexDb monkey-patcheado como en codex-route-contract.test.js.
// El token de GitHub viaja solo en memoria: ningún assertion lo vería en la
// respuesta y process.env nunca se muta.

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { mockResolvedModule } = require('./http-test-utils');

const FAKE_TOKEN = 'ghp_testtoken_do_not_use_1234567890';

// ── Stubs (antes de cargar el router) ───────────────────────────────────────
let authUser = { id: 'u-1', isAdmin: true, isSuperAdmin: false };
const restoreAuth = mockResolvedModule(require.resolve('../src/middleware/auth'), {
  authenticateToken(req, _res, next) {
    req.user = authUser;
    next();
  },
});

function fakeRunner({ changed = '', deleted = '', files = {} } = {}) {
  const calls = [];
  return {
    calls,
    async initWorkspace(projectId) {
      calls.push(['initWorkspace', projectId]);
      return { ok: true };
    },
    async exec(_projectId, cmd) {
      calls.push(['exec', cmd.join(' ')]);
      const joined = cmd.join(' ');
      if (joined.includes('remote get-url')) return { exitCode: 1, stdout: '', stderr: 'no remote' };
      if (joined.includes('diff --name-only')) {
        if (joined.includes('--diff-filter=D')) return { exitCode: 0, stdout: deleted };
        return { exitCode: 0, stdout: changed };
      }
      if (joined.includes('rev-parse')) return { exitCode: 0, stdout: 'abc1234def\n', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async readFile(_projectId, path) {
      if (Object.hasOwn(files, path)) return { content: files[path] };
      const err = new Error('file_not_found');
      err.status = 404;
      throw err;
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
const restoreSelfHosting = mockResolvedModule(require.resolve('../src/services/codex/self-hosting'), {
  async publishSelfHostedPullRequest(args) {
    publishCalls.push(args);
    return {
      ok: true,
      status: 'pull_request_opened',
      branch: 'run/run-9',
      commitSha: 'def5678',
      files: 1,
      deleted: 0,
      pullRequest: { number: 7, url: 'https://github.com/acme/app/pull/7', state: 'open' },
    };
  },
});

const codexRoutes = require('../src/routes/codex');
const codexDb = require('../src/config/database');

const originals = {
  create: codexDb.codexProject.create,
  update: codexDb.codexProject.update,
  findFirst: codexDb.codexProject.findFirst,
};

const dbCalls = [];
function installDb({ row = null } = {}) {
  codexDb.codexProject.findFirst = async () => (row ? { ...row } : null);
  codexDb.codexProject.create = async ({ data }) => {
    dbCalls.push(['create', data]);
    return { id: 'p-clone', ...data, createdAt: new Date(), updatedAt: new Date() };
  };
  codexDb.codexProject.update = async ({ where, data }) => {
    dbCalls.push(['update', where, data]);
    return { id: where.id, userId: 'u-1', name: 'X', status: 'ready', ...data };
  };
}

after(() => {
  restoreAuth();
  restoreSandbox();
  restoreSelfHosting();
  codexDb.codexProject.create = originals.create;
  codexDb.codexProject.update = originals.update;
  codexDb.codexProject.findFirst = originals.findFirst;
  delete process.env.CODEX_AGENT_V2;
});

beforeEach(() => {
  authUser = { id: 'u-1', isAdmin: true, isSuperAdmin: false };
  process.env.CODEX_AGENT_V2 = '1';
  dbCalls.length = 0;
  publishCalls.length = 0;
  activeRunner = fakeRunner();
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/codex', codexRoutes);
  return app;
}

test('POST /projects/clone clona un repo público y devuelve sourceControl', async () => {
  installDb();
  const res = await request(buildApp())
    .post('/api/codex/projects/clone')
    .send({ name: 'Mi App', repoUrl: 'https://github.com/sst/opencode', branch: 'main' });
  assert.equal(res.status, 201);
  assert.equal(res.body.sourceControl.repository, 'https://github.com/sst/opencode');
  assert.equal(res.body.sourceControl.sourceBranch, 'main');
  assert.equal(res.body.sourceControl.commitSha, 'abc1234def');
  assert.equal(res.body.project.status, 'ready');
  const updates = dbCalls.filter((c) => c[0] === 'update');
  assert.equal(updates.length, 1);
  assert.equal(updates[0][2].status, 'ready');
  const execs = activeRunner.calls.filter((c) => c[0] === 'exec').map((c) => c[1]);
  assert.ok(execs.some((c) => c.includes('fetch --depth=1')));
});

test('POST /projects/clone rechaza URL inválida sin tocar la DB', async () => {
  installDb();
  const res = await request(buildApp())
    .post('/api/codex/projects/clone')
    .send({ name: 'X', repoUrl: 'notaurl' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_repository_url');
  assert.equal(dbCalls.filter((c) => c[0] === 'create').length, 0);
});

test('POST /projects/:id/github/plan devuelve plan manual con compareUrl', async () => {
  installDb({ row: { id: 'p1', userId: 'u-1', name: 'A' } });
  activeRunner = fakeRunner({ changed: 'src/a.ts\0', files: { 'src/a.ts': 'console.log(1)\n' } });
  const res = await request(buildApp())
    .post('/api/codex/projects/p1/github/plan')
    .send({ repoUrl: 'https://github.com/acme/app', runId: 'run-9' });
  assert.equal(res.status, 200);
  assert.equal(res.body.plan.status, 'manual_pr');
  assert.ok(res.body.plan.compareUrl.includes('/compare/main...run%2Frun-9'));
  assert.equal(res.body.plan.files, 1);
});

test('POST /projects/:id/github/plan 404 si el proyecto no es del usuario', async () => {
  installDb({ row: null });
  const res = await request(buildApp())
    .post('/api/codex/projects/p9/github/plan')
    .send({ repoUrl: 'https://github.com/acme/app', runId: 'run-9' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'project_not_found');
});

test('POST /projects/:id/github/publish sin confirm exige aprobación (428 + plan)', async () => {
  installDb({ row: { id: 'p1', userId: 'u-1', name: 'A' } });
  activeRunner = fakeRunner({ changed: 'src/a.ts\0', files: { 'src/a.ts': 'x\n' } });
  const res = await request(buildApp())
    .post('/api/codex/projects/p1/github/publish')
    .send({ repoUrl: 'https://github.com/acme/app', runId: 'run-9', githubToken: FAKE_TOKEN });
  assert.equal(res.status, 428);
  assert.equal(res.body.error, 'confirmation_required');
  assert.ok(res.body.plan.compareUrl);
  assert.equal(publishCalls.length, 0);
  assert.ok(!JSON.stringify(res.body).includes(FAKE_TOKEN), 'el token nunca vuelve en la respuesta');
});

test('POST /projects/:id/github/publish con confirm+token abre el PR sin filtrar el token', async () => {
  installDb({ row: { id: 'p1', userId: 'u-1', name: 'A' } });
  activeRunner = fakeRunner({ changed: 'src/a.ts\0', files: { 'src/a.ts': 'x\n' } });
  const res = await request(buildApp())
    .post('/api/codex/projects/p1/github/publish')
    .send({
      repoUrl: 'https://github.com/acme/app', runId: 'run-9', confirm: true, githubToken: FAKE_TOKEN,
    });
  assert.equal(res.status, 201);
  assert.equal(res.body.pullRequest.url, 'https://github.com/acme/app/pull/7');
  assert.equal(publishCalls.length, 1);
  assert.equal(publishCalls[0].env.CODEX_SELF_HOST_GITHUB_TOKEN, FAKE_TOKEN);
  assert.equal(process.env.CODEX_SELF_HOST_GITHUB_TOKEN, undefined);
  assert.ok(!JSON.stringify(res.body).includes(FAKE_TOKEN), 'el token nunca vuelve en la respuesta');
});

test('POST /projects/:id/github/publish con confirm pero sin token devuelve compareUrl', async () => {
  installDb({ row: { id: 'p1', userId: 'u-1', name: 'A' } });
  activeRunner = fakeRunner({ changed: 'src/a.ts\0', files: { 'src/a.ts': 'x\n' } });
  const res = await request(buildApp())
    .post('/api/codex/projects/p1/github/publish')
    .send({ repoUrl: 'https://github.com/acme/app', runId: 'run-9', confirm: true });
  assert.equal(res.status, 428);
  assert.equal(res.body.error, 'github_auth_required');
  assert.ok(res.body.plan.compareUrl.includes('github.com/acme/app/compare'));
  assert.equal(publishCalls.length, 0);
});

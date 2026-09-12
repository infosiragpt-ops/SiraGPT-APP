'use strict';

// github_checks: estado de CI del PR/rama del proyecto con la cuenta GitHub
// del usuario. Todo offline: octokit falso inyectado vía ctx.githubApi.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { TOOLS, toolRegistry } = require('../src/services/codex/build-tools');
const checks = require('../src/services/codex/github-checks');

function fakeOctokit({ checkRuns = [], jobs = {}, pull = null, listError = null, pullError = null } = {}) {
  const calls = [];
  return {
    calls,
    rest: {
      checks: {
        listForRef: async (params) => {
          calls.push(['checks.listForRef', params]);
          if (listError) throw listError;
          return { data: { total_count: checkRuns.length, check_runs: checkRuns } };
        },
      },
      actions: {
        getJobForWorkflowRun: async (params) => {
          calls.push(['actions.getJobForWorkflowRun', params]);
          const job = jobs[params.job_id];
          if (!job) { const e = new Error('Not Found'); e.status = 404; throw e; }
          return { data: job };
        },
      },
      pulls: {
        get: async (params) => {
          calls.push(['pulls.get', params]);
          if (pullError) throw pullError;
          return { data: pull };
        },
      },
    },
  };
}

function apiWith(octokit) {
  return { octokitForUser: async (userId) => { if (!userId) throw new Error('no user'); return { octokit, account: { id: 'acc' } }; } };
}

function notConnectedApi() {
  return {
    octokitForUser: async () => { const e = new Error('GitHub is not connected for this user'); e.status = 409; e.code = 'github_not_connected'; throw e; },
  };
}

const PROJECT = { id: 'p1', brief: { kind: 'repo-private', repository: { url: 'https://github.com/acme/app.git', webUrl: 'https://github.com/acme/app', fullName: 'acme/app', private: true } } };

test('github_checks está registrado como tool de build con kind web y schema', () => {
  assert.ok(TOOLS.github_checks);
  assert.equal(TOOLS.github_checks.kind, 'web');
  assert.ok(toolRegistry().some((t) => t.name === 'github_checks'));
  assert.deepEqual(Object.keys(TOOLS.github_checks.parameters.properties).sort(), ['pr', 'ref', 'repository']);
  assert.equal(TOOLS.github_checks.commandFor({ pr: 7 }), 'github_checks #7');
  assert.equal(TOOLS.github_checks.commandFor({}), 'github_checks run branch');
});

test('parseRepository / resolveRepository: owner/repo, URLs github.com, clone .git; otros hosts no', () => {
  assert.deepEqual(checks.parseRepository('acme/app'), { owner: 'acme', repo: 'app', fullName: 'acme/app' });
  assert.equal(checks.parseRepository('https://github.com/acme/app.git').fullName, 'acme/app');
  assert.equal(checks.parseRepository('https://github.com/acme/app/').fullName, 'acme/app');
  assert.equal(checks.parseRepository('https://gitlab.com/acme/app'), null);
  assert.equal(checks.parseRepository('acme'), null);
  assert.equal(checks.parseRepository(''), null);
  assert.equal(checks.resolveRepository({}, { projectRecord: PROJECT }).fullName, 'acme/app');
  assert.equal(checks.resolveRepository({ repository: 'other/repo' }, { projectRecord: PROJECT }).fullName, 'other/repo');
  assert.equal(checks.resolveRepository({}, { projectRecord: { brief: { kind: 'app' } } }), null);
  assert.equal(checks.defaultRef({ run: { id: 'run-9' } }), 'run/run-9');
  assert.equal(checks.defaultRef({}), '');
});

test('sin repositorio → error claro; sin cuenta GitHub → observación no-error que pide conectar', async () => {
  const noRepo = await TOOLS.github_checks.execute({}, { projectRecord: { brief: {} }, userId: 'u1', githubApi: apiWith(fakeOctokit()) });
  assert.equal(noRepo.isError, true);
  assert.match(noRepo.observation, /no está ligado a un repositorio/);

  const noUser = await TOOLS.github_checks.execute({}, { projectRecord: PROJECT, userId: null, githubApi: apiWith(fakeOctokit()) });
  assert.equal(noUser.isError, false);
  assert.match(noUser.observation, /no está conectada/);

  const notConnected = await TOOLS.github_checks.execute({}, { projectRecord: PROJECT, userId: 'u1', githubApi: notConnectedApi() });
  assert.equal(notConnected.isError, false);
  assert.match(notConnected.observation, /Ajustes/);
});

test('rama por defecto run/<id>: resume checks verdes/pendientes con enlaces', async () => {
  const octokit = fakeOctokit({
    checkRuns: [
      { id: 1, name: 'frontend', status: 'completed', conclusion: 'success', html_url: 'https://gh/1', app: { slug: 'github-actions' } },
      { id: 2, name: 'backend', status: 'in_progress', conclusion: null, html_url: 'https://gh/2', app: { slug: 'github-actions' } },
      { id: 3, name: 'licenses', status: 'completed', conclusion: 'skipped', html_url: 'https://gh/3', app: { slug: 'github-actions' } },
    ],
  });
  const out = await TOOLS.github_checks.execute({}, { projectRecord: PROJECT, userId: 'u1', run: { id: 'run-42' }, githubApi: apiWith(octokit) });
  assert.equal(out.isError, false);
  assert.equal(out.ref, 'run/run-42');
  assert.equal(octokit.calls[0][0], 'checks.listForRef');
  assert.deepEqual(octokit.calls[0][1], { owner: 'acme', repo: 'app', ref: 'run/run-42', per_page: 50 });
  assert.deepEqual(out.counts, { total: 3, success: 1, failed: 0, pending: 1, skipped: 1 });
  assert.match(out.observation, /en curso/);
  assert.match(out.observation, /✅ frontend — success — https:\/\/gh\/1/);
  assert.match(out.observation, /⏳ backend — in_progress/);
  assert.match(out.summary, /1\/3 ok/);
  assert.ok(!octokit.calls.some((c) => c[0] === 'actions.getJobForWorkflowRun'), 'sin fallos no se piden jobs');
});

test('fallos de GitHub Actions: pasos fallidos del job, resumen del check y siguiente paso', async () => {
  const octokit = fakeOctokit({
    checkRuns: [
      { id: 10, name: 'backend (shard 2/4)', status: 'completed', conclusion: 'failure', html_url: 'https://gh/10', app: { slug: 'github-actions' }, output: { title: '3 tests failed', summary: 'codex-llm-turn.test.js: expected 1 to equal 2 '.repeat(20) } },
      { id: 11, name: 'external-scan', status: 'completed', conclusion: 'failure', html_url: 'https://gh/11', app: { slug: 'some-other-app' } },
      { id: 12, name: 'lint', status: 'completed', conclusion: 'success', html_url: 'https://gh/12', app: { slug: 'github-actions' } },
    ],
    jobs: {
      10: { steps: [
        { name: 'Checkout', status: 'completed', conclusion: 'success' },
        { name: 'Backend tests', status: 'completed', conclusion: 'failure' },
        { name: 'Upload coverage', status: 'completed', conclusion: 'skipped' },
      ] },
    },
  });
  const out = await TOOLS.github_checks.execute({ ref: 'feature/x' }, { projectRecord: PROJECT, userId: 'u1', githubApi: apiWith(octokit) });
  assert.equal(out.isError, false);
  assert.equal(out.counts.failed, 2);
  assert.match(out.observation, /fallando/);
  assert.match(out.observation, /❌ backend \(shard 2\/4\) — failure/);
  assert.match(out.observation, /pasos fallidos: Backend tests \(failure\)/);
  assert.match(out.observation, /3 tests failed/);
  assert.match(out.observation, /Siguiente paso/);
  const jobLookups = octokit.calls.filter((c) => c[0] === 'actions.getJobForWorkflowRun');
  assert.equal(jobLookups.length, 1, 'solo los checks de github-actions consultan el job');
  assert.equal(jobLookups[0][1].job_id, 10);
  const failedCheck = out.checks.find((c) => c.id === 10);
  assert.ok(failedCheck.summary.length <= 400, 'resumen recortado');
});

test('con `pr`: consulta el PR, usa su HEAD sha como ref y reporta estado de merge', async () => {
  const octokit = fakeOctokit({
    pull: { number: 7, state: 'open', mergeable_state: 'clean', html_url: 'https://github.com/acme/app/pull/7', head: { sha: 'abc123', ref: 'run/run-7' } },
    checkRuns: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success', html_url: 'https://gh/1', app: { slug: 'github-actions' } }],
  });
  const out = await TOOLS.github_checks.execute({ pr: 7 }, { projectRecord: PROJECT, userId: 'u1', run: { id: 'run-7' }, githubApi: apiWith(octokit) });
  assert.equal(out.isError, false);
  assert.equal(out.ref, 'abc123');
  assert.deepEqual(out.pullRequest, { number: 7, state: 'open', mergeableState: 'clean', url: 'https://github.com/acme/app/pull/7' });
  assert.match(out.observation, /PR #7, merge: clean/);
  assert.match(out.observation, /verde/);
});

test('sin checks todavía: verde no, explica que el CI puede no haberse disparado', async () => {
  const octokit = fakeOctokit({ checkRuns: [] });
  const out = await TOOLS.github_checks.execute({ ref: 'run/x' }, { projectRecord: PROJECT, userId: 'u1', githubApi: apiWith(octokit) });
  assert.equal(out.isError, false);
  assert.match(out.observation, /sin checks/);
  assert.match(out.observation, /no se disparó/);
});

test('errores de GitHub: 404 ref/PR, 403 permisos, otros → isError con mensaje útil; sin ref ni run → error', async () => {
  const nf = new Error('Not Found'); nf.status = 404;
  const out404 = await TOOLS.github_checks.execute({ ref: 'nope' }, { projectRecord: PROJECT, userId: 'u1', githubApi: apiWith(fakeOctokit({ listError: nf })) });
  assert.equal(out404.isError, true);
  assert.match(out404.observation, /no encontró la ref "nope"/);

  const forb = new Error('Forbidden'); forb.status = 403;
  const out403 = await TOOLS.github_checks.execute({ pr: 3 }, { projectRecord: PROJECT, userId: 'u1', githubApi: apiWith(fakeOctokit({ pullError: forb })) });
  assert.equal(out403.isError, true);
  assert.match(out403.observation, /rechazó la consulta \(403\)/);

  const boom = new Error('socket hang up');
  const outBoom = await TOOLS.github_checks.execute({ ref: 'x' }, { projectRecord: PROJECT, userId: 'u1', githubApi: apiWith(fakeOctokit({ listError: boom })) });
  assert.equal(outBoom.isError, true);
  assert.match(outBoom.observation, /socket hang up/);

  const noRef = await TOOLS.github_checks.execute({}, { projectRecord: PROJECT, userId: 'u1', githubApi: apiWith(fakeOctokit()) });
  assert.equal(noRef.isError, true);
  assert.match(noRef.observation, /indica `ref`/);
});

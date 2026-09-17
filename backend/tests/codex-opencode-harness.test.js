'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const harness = require('../src/services/codex/opencode-harness');

test('provenance points at sst/opencode MIT (attribution, no verbatim copy)', () => {
  assert.equal(harness.OPENCODE_PROVENANCE.upstream, 'https://github.com/sst/opencode');
  assert.equal(harness.OPENCODE_PROVENANCE.license, 'MIT');
  assert.ok(harness.OPENCODE_PROVENANCE.portedFrom.includes('packages/opencode/src/tool/registry.ts'));
  assert.ok(harness.OPENCODE_PROVENANCE.portedFrom.includes('packages/opencode/src/permission/index.ts'));
});

test('catalog covers the OpenCode core tools with explicit gaps', () => {
  const ids = harness.OPENCODE_TOOL_CATALOG.map((r) => r.opencodeId);
  for (const expected of ['read', 'write', 'edit', 'glob', 'grep', 'shell', 'task', 'webfetch', 'websearch']) {
    assert.ok(ids.includes(expected), `missing ${expected}`);
  }
  const missing = harness.OPENCODE_TOOL_CATALOG.filter((r) => r.status === 'missing');
  assert.ok(missing.length >= 1, 'gaps must be explicit, never faked');
  const status = harness.catalogStatus();
  assert.equal(status.total, harness.OPENCODE_TOOL_CATALOG.length);
  assert.equal(status.native + status.adapted + status.missing, status.total);
});

test('evaluatePermission: last match wins, default ask (port of permission/index.ts)', () => {
  // Sin reglas → ask.
  assert.equal(harness.evaluatePermission('shell', 'ls').action, 'ask');
  // Allow gana si es la última coincidencia.
  const allow = harness.evaluatePermission('shell', 'git status', [
    { permission: 'shell', pattern: '*', action: 'ask' },
    { permission: 'shell', pattern: 'git *', action: 'allow' },
  ]);
  assert.equal(allow.action, 'allow');
  // Deny posterior revoca el allow previo.
  const deny = harness.evaluatePermission('shell', 'rm -rf /', [
    { permission: 'shell', pattern: '*', action: 'allow' },
    { permission: 'shell', pattern: 'rm *', action: 'deny' },
  ]);
  assert.equal(deny.action, 'deny');
});

test('wildcardMatch supports * globs on permission and pattern', () => {
  assert.equal(harness.wildcardMatch('*', 'anything/at/all'), true);
  assert.equal(harness.wildcardMatch('git *', 'git status'), true);
  assert.equal(harness.wildcardMatch('git *', 'npm run'), false);
  assert.equal(harness.wildcardMatch('edit', 'edit'), true);
});

test('visibleTools hides deny+* tools like OpenCode (edit family shares permission)', () => {
  const tools = { edit: 1, write: 2, read: 3, shell: 4 };
  const visible = harness.visibleTools(tools, [{ permission: 'edit', pattern: '*', action: 'deny' }]);
  assert.deepEqual(Object.keys(visible).sort(), ['read', 'shell']);
});

test('parsePublicGithubRepo accepts owner/repo https, rejects credentials/hosts', () => {
  const repo = harness.parsePublicGithubRepo('https://github.com/sst/opencode');
  assert.equal(repo.cloneUrl, 'https://github.com/sst/opencode.git');
  assert.equal(repo.webUrl, 'https://github.com/sst/opencode');
  assert.throws(() => harness.parsePublicGithubRepo('https://github.com/sst/opencode?x=1'), /query/);
  assert.throws(() => harness.parsePublicGithubRepo('https://user:pass@github.com/sst/opencode'), /credentials/);
  assert.throws(() => harness.parsePublicGithubRepo('https://gitlab.com/a/b'), /github\.com/);
  assert.throws(() => harness.parsePublicGithubRepo('not a url'), /invalid/);
});

test('isBlockedPublishPath mirrors self-hosting sensitive paths (.env.example allowed)', () => {
  assert.equal(harness.isBlockedPublishPath('.env'), true);
  assert.equal(harness.isBlockedPublishPath('src/.env.local'), true);
  assert.equal(harness.isBlockedPublishPath('.env.example'), false);
  assert.equal(harness.isBlockedPublishPath('key.pem'), true);
  assert.equal(harness.isBlockedPublishPath('src/app.ts'), false);
});

function fakeRunner({ changed = '', deleted = '', files = {} } = {}) {
  const calls = [];
  return {
    calls,
    async initWorkspace(projectId) {
      calls.push(['initWorkspace', projectId]);
      return { ok: true };
    },
    async exec(projectId, cmd) {
      calls.push(['exec', projectId, cmd.join(' ')]);
      const joined = cmd.join(' ');
      if (joined.includes('remote get-url')) return { exitCode: 1, stdout: '', stderr: 'no remote' };
      if (joined.includes('diff --name-only')) {
        if (joined.includes('--diff-filter=D')) return { exitCode: 0, stdout: deleted };
        return { exitCode: 0, stdout: changed };
      }
      if (joined.includes('rev-parse')) return { exitCode: 0, stdout: 'abc1234\n', stderr: '' };
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

test('clonePublicRepo fetches depth=1 and checks out base branch (offline fake runner)', async () => {
  const runner = fakeRunner();
  const out = await harness.clonePublicRepo({
    runner,
    projectId: 'proj-1',
    repoUrl: 'https://github.com/sst/opencode',
    branch: 'main',
  });
  assert.equal(out.ok, true);
  assert.equal(out.repository.slug, 'sst/opencode');
  assert.equal(out.sourceBranch, 'main');
  assert.equal(out.workBranch, null);
  const execs = runner.calls.filter((c) => c[0] === 'exec').map((c) => c[2]);
  assert.ok(execs.some((c) => c.includes('fetch --depth=1')), 'must shallow-fetch like self-hosting');
  assert.ok(execs.some((c) => c.includes('checkout -B main')), 'must checkout base branch');
});

test('clonePublicRepo creates run branch when runId is given', async () => {
  const runner = fakeRunner();
  const out = await harness.clonePublicRepo({
    runner,
    projectId: 'proj-1',
    repoUrl: 'https://github.com/sst/opencode.git',
    branch: 'main',
    runId: 'abc123',
  });
  assert.equal(out.workBranch, 'run/abc123');
});

test('buildPublishPlan returns manual_pr without token, ready_to_publish with token', async () => {
  const runner = fakeRunner({ changed: 'src/a.ts\0', files: { 'src/a.ts': 'console.log(1)\n' } });
  const base = {
    runner,
    projectId: 'proj-1',
    repoUrl: 'https://github.com/acme/app',
    sourceBranch: 'main',
    runId: 'run-9',
  };
  const manual = await harness.buildPublishPlan({ ...base, hasGithubToken: false });
  assert.equal(manual.status, 'manual_pr');
  assert.ok(manual.compareUrl.includes('/compare/main...run%2Frun-9'), manual.compareUrl);
  assert.equal(manual.files, 1);
  const ready = await harness.buildPublishPlan({ ...base, hasGithubToken: true });
  assert.equal(ready.status, 'ready_to_publish');
  assert.equal(ready.mergePolicy, 'pull_request_only');
});

test('buildPublishPlan blocks sensitive paths and reports no_changes', async () => {
  const blocked = fakeRunner({ changed: '.env\0' });
  await assert.rejects(
    harness.buildPublishPlan({ runner: blocked, projectId: 'p', repoUrl: 'https://github.com/a/b', runId: 'r1' }),
    /sensitive path/,
  );
  const empty = fakeRunner({ changed: '', deleted: '' });
  const out = await harness.buildPublishPlan({ runner: empty, projectId: 'p', repoUrl: 'https://github.com/a/b', runId: 'r1' });
  assert.equal(out.status, 'no_changes');
});

// ── Clone autenticado (OAuth del usuario, en memoria) ──────────────────────

test('clonePublicRepo con accessToken: fetch autenticado vía -c http.<github>.extraheader, remote limpio', async () => {
  const runner = fakeRunner();
  const token = 'gho_userOAuthToken_1234567890abcdef';
  const out = await harness.clonePublicRepo({
    runner,
    projectId: 'proj-1',
    repoUrl: 'https://github.com/acme/private-app',
    branch: 'develop',
    accessToken: token,
  });
  assert.equal(out.ok, true);
  assert.equal(out.authenticated, true);
  assert.equal(out.sourceBranch, 'develop');
  const execs = runner.calls.filter((c) => c[0] === 'exec').map((c) => c[2]);
  const fetchCmd = execs.find((c) => c.includes('fetch --depth=1'));
  assert.ok(fetchCmd, 'debe hacer el shallow fetch');
  const expectedBasic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  assert.ok(fetchCmd.includes(`-c http.https://github.com/.extraheader=AUTHORIZATION: basic ${expectedBasic}`), fetchCmd);
  assert.ok(!fetchCmd.includes(token), 'el token crudo nunca viaja en los argumentos');
  // El remote queda con la URL limpia: ni token ni credenciales en .git/config.
  const remoteCmd = execs.find((c) => c.includes('remote add origin') || c.includes('remote set-url origin'));
  assert.ok(remoteCmd.endsWith('https://github.com/acme/private-app.git'), remoteCmd);
  assert.ok(!remoteCmd.includes(token) && !remoteCmd.includes('x-access-token'));
  // El checkout/rev-parse posteriores no llevan la credencial.
  for (const c of execs.filter((c) => !c.includes('fetch'))) assert.ok(!c.includes('extraheader'), c);
});

test('clonePublicRepo sin accessToken: sin -c extraheader y authenticated=false', async () => {
  const runner = fakeRunner();
  const out = await harness.clonePublicRepo({ runner, projectId: 'proj-1', repoUrl: 'https://github.com/sst/opencode' });
  assert.equal(out.authenticated, false);
  const execs = runner.calls.filter((c) => c[0] === 'exec').map((c) => c[2]);
  assert.ok(execs.every((c) => !c.includes('extraheader')));
});

test('clonePublicRepo: un fallo de git nunca filtra el token ni su base64 en el error', async () => {
  const token = 'gho_leakyToken_ABCDEF0123456789';
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  const runner = {
    calls: [],
    async initWorkspace() { return { ok: true }; },
    async exec(_p, cmd) {
      const joined = cmd.join(' ');
      if (joined.includes('remote get-url')) return { exitCode: 1, stdout: '', stderr: '' };
      if (joined.includes('fetch')) {
        return { exitCode: 128, stdout: '', stderr: `fatal: unable to access 'https://github.com/acme/private-app.git/': header AUTHORIZATION: basic ${basic} rejected; token ${token} invalid` };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
  await assert.rejects(
    () => harness.clonePublicRepo({ runner, projectId: 'proj-1', repoUrl: 'https://github.com/acme/private-app', accessToken: token }),
    (err) => {
      assert.equal(err.code, 'git_operation_failed');
      assert.equal(err.details.operation, 'fetch', 'la operación es fetch, no el flag -c');
      const blob = JSON.stringify(err.details) + err.message;
      assert.ok(!blob.includes(token), 'token crudo filtrado');
      assert.ok(!blob.includes(basic), 'base64 del token filtrado');
      assert.ok(blob.includes('[REDACTED]'));
      return true;
    },
  );
});

test('githubAuthConfigArgs / scrubCredential: vacío sin token; redacta gho_/ghu_/ghs_ y cabeceras basic', () => {
  assert.deepEqual(harness.githubAuthConfigArgs(''), []);
  assert.deepEqual(harness.githubAuthConfigArgs(null), []);
  const args = harness.githubAuthConfigArgs('ghu_abc');
  assert.equal(args[0], '-c');
  assert.match(args[1], /^http\.https:\/\/github\.com\/\.extraheader=AUTHORIZATION: basic /);
  const scrubbed = harness.scrubCredential('remote: gho_aaaaBBBB1111 ghu_x1 ghs_y2 ghr_z3 AUTHORIZATION: basic QUJD= Authorization: Bearer tok_1', null);
  assert.ok(!/gho_aaaaBBBB1111|ghu_x1|ghs_y2|ghr_z3|QUJD=|tok_1/.test(scrubbed), scrubbed);
});

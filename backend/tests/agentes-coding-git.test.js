'use strict';

/**
 * agentes-coding/git — per-session init / status / diff / checkpoint
 * (AGENTES_CODING_V2 Phase 3f). Injectable git runner — no host git
 * binary and no upstream dump in CI.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const git = require('../src/services/agentes-coding/git');
const runner = require('../src/services/agentes-coding/git/runner');
const { createCodingSandbox, CodingSandboxError } = require('../src/services/agentes-coding/coding-sandbox');
const { CATALOG } = require('../src/services/agentes-coding/coding-sandbox/errors');
const { jailRelPath } = require('../src/services/agentes-coding/coding-sandbox/path-jail');

const FIXTURE = path.join(__dirname, 'fixtures/agentes-git/sample');
const ON = { AGENTES_CODING_V2: '1' };

const WORKSPACE = {
  'src/app.ts': fs.readFileSync(path.join(FIXTURE, 'src/app.ts'), 'utf8'),
  'README.md': fs.readFileSync(path.join(FIXTURE, 'README.md'), 'utf8'),
};

let express = null;
let createAgentesCodingRouter = null;
try {
  express = require('express');
  ({ createAgentesCodingRouter } = require('../src/routes/agentes-coding'));
} catch (_) {
  express = null;
  createAgentesCodingRouter = null;
}

function sandbox(extra = {}) {
  return createCodingSandbox({
    env: { ...ON, ...(extra.env || {}) },
    autoGc: false,
    ...extra,
  });
}

async function seeded(files = WORKSPACE) {
  const sb = sandbox();
  const session = await sb.createSession();
  for (const [p, body] of Object.entries(files)) {
    await sb.writeFile(session.id, p, body);
  }
  return { sb, session };
}

function fakeRunner(impl) {
  const calls = [];
  const run = async (input) => {
    calls.push(input);
    if (typeof impl === 'function') return impl(input, calls);
    return impl;
  };
  run.calls = calls;
  return run;
}

function spanishError(err, code) {
  assert.ok(err instanceof CodingSandboxError, err && err.stack);
  assert.equal(err.code, code);
  assert.match(
    err.message,
    /[áéíóúñÁÉÍÓÚÑ]|desactiv|sesión|sandbox|ruta|git|punto de control|repositorio|válid|tiempo|Tope|comando/i,
  );
  return true;
}

function sha40(value) {
  assert.match(String(value), /^[0-9a-f]{40}$/);
}

test('this suite never assigns process.env.AGENTES_CODING_V2', () => {
  const src = fs.readFileSync(__filename, 'utf8');
  assert.doesNotMatch(src, /process\.env\.AGENTES_CODING_V2\s*=/);
});

test('implementation stays a native pattern (no banned vendors, no /code page)', () => {
  const root = path.join(__dirname, '../src/services/agentes-coding/git');
  for (const file of ['index.js', 'runner.js', 'memory.js']) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(src, /daytona|OpenRouter|\/code\/page/i, file);
    assert.doesNotMatch(src, /require\(['"]isomorphic-git['"]\)/);
    assert.doesNotMatch(src, /require\(['"]simple-git['"]\)/);
  }
});

test('error catalog includes git codes in Spanish', () => {
  assert.ok(CATALOG.E_GIT_FAILED);
  assert.ok(CATALOG.E_CHECKPOINT_NOT_FOUND);
  assert.match(CATALOG.E_GIT_FAILED.message, /git|repositorio/i);
  assert.match(CATALOG.E_CHECKPOINT_NOT_FOUND.message, /punto de control/i);
  assert.match(CATALOG.E_FLAG_OFF.message, /desactiv/i);
});

test('initForRequest refuses when the flag is off', async () => {
  const sb = createCodingSandbox({ env: { AGENTES_CODING_V2: '0' }, autoGc: false });
  await assert.rejects(
    () => git.initForRequest(sb, 'csb_x', {}, { AGENTES_CODING_V2: '0' }),
    (err) => spanishError(err, 'E_FLAG_OFF'),
  );
});

test('init creates a main branch inside the jailed session', async () => {
  const { sb, session } = await seeded();
  const out = await git.initSession(sb, session.id, { env: ON });
  assert.equal(out.ok, true);
  assert.equal(out.initialized, true);
  assert.equal(out.already, false);
  assert.equal(out.branch, 'main');
});

test('init is idempotent and keeps the existing branch', async () => {
  const { sb, session } = await seeded();
  await git.initSession(sb, session.id, { env: ON, branch: 'trabajo' });
  const again = await git.initSession(sb, session.id, { env: ON, branch: 'otra' });
  assert.equal(again.already, true);
  assert.equal(again.branch, 'trabajo');
});

test('status lists fixture files as untracked before the first checkpoint', async () => {
  const { sb, session } = await seeded();
  await git.initSession(sb, session.id, { env: ON });
  const st = await git.statusSession(sb, session.id, { env: ON });
  assert.equal(st.ok, true);
  assert.equal(st.initialized, true);
  assert.equal(st.clean, false);
  const paths = st.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['README.md', 'src/app.ts']);
  assert.ok(st.files.every((f) => f.status === '??'));
  assert.match(WORKSPACE['src/app.ts'], /export const greeting/);
});

test('checkpoint then status is clean; edit marks the file modified', async () => {
  const { sb, session } = await seeded();
  const first = await git.checkpointSession(sb, session.id, {
    env: ON,
    message: 'punto inicial',
  });
  assert.equal(first.ok, true);
  sha40(first.checkpoint.sha);
  assert.equal(first.checkpoint.message, 'punto inicial');
  assert.ok(first.checkpoint.filesChanged >= 2);

  const clean = await git.statusSession(sb, session.id, { env: ON });
  assert.equal(clean.clean, true);
  assert.deepEqual(clean.files, []);

  await sb.writeFile(session.id, 'src/app.ts', "export const greeting = 'adios';\n");
  const dirty = await git.statusSession(sb, session.id, { env: ON });
  assert.equal(dirty.clean, false);
  const app = dirty.files.find((f) => f.path === 'src/app.ts');
  assert.ok(app);
  assert.equal(app.status, 'M');
});

test('diff is empty when clean and shows a Spanish-safe patch after edit', async () => {
  const { sb, session } = await seeded();
  await git.checkpointSession(sb, session.id, { env: ON, message: 'base' });
  const empty = await git.diffSession(sb, session.id, { env: ON });
  assert.equal(empty.ok, true);
  assert.equal(String(empty.patch || '').trim(), '');
  assert.deepEqual(empty.files, []);

  await sb.writeFile(session.id, 'src/app.ts', "export const greeting = 'adios';\n");
  const changed = await git.diffSession(sb, session.id, { env: ON });
  assert.match(changed.patch, /--- a\/src\/app\.ts/);
  assert.match(changed.patch, /\+\+\+ b\/src\/app\.ts/);
  assert.match(changed.patch, /adios/);
  assert.ok(changed.files.some((f) => f.path === 'src/app.ts'));
});

test('diff path escape is E_PATH_ESCAPE with Spanish copy', async () => {
  const { sb, session } = await seeded();
  await git.initSession(sb, session.id, { env: ON });
  await assert.rejects(
    () => git.diffSession(sb, session.id, { env: ON, path: '../etc/passwd' }),
    (err) => spanishError(err, 'E_PATH_ESCAPE'),
  );
  await assert.rejects(
    () => git.diffSession(sb, session.id, { env: ON, path: '/etc/passwd' }),
    (err) => spanishError(err, 'E_PATH_ESCAPE'),
  );
});

test('checkpoint message is required, bounded, and rejects control chars', async () => {
  const { sb, session } = await seeded();
  await assert.rejects(
    () => git.checkpointSession(sb, session.id, { env: ON, message: '' }),
    (err) => spanishError(err, 'E_PARAMS'),
  );
  await assert.rejects(
    () => git.checkpointSession(sb, session.id, { env: ON, message: 'x'.repeat(git.MAX_MESSAGE_CHARS + 1) }),
    (err) => spanishError(err, 'E_PARAMS'),
  );
  await assert.rejects(
    () => git.checkpointSession(sb, session.id, { env: ON, message: 'malo\x00msg' }),
    (err) => spanishError(err, 'E_PARAMS'),
  );
});

test('list checkpoints newest first; missing sha is E_CHECKPOINT_NOT_FOUND', async () => {
  const { sb, session } = await seeded();
  const a = await git.checkpointSession(sb, session.id, { env: ON, message: 'uno' });
  await sb.writeFile(session.id, 'nuevo.txt', 'n\n');
  const b = await git.checkpointSession(sb, session.id, { env: ON, message: 'dos' });
  const listed = await git.listCheckpoints(sb, session.id, { env: ON });
  assert.equal(listed.ok, true);
  assert.equal(listed.checkpoints.length, 2);
  assert.equal(listed.checkpoints[0].sha, b.checkpoint.sha);
  assert.equal(listed.checkpoints[0].message, 'dos');
  assert.equal(listed.checkpoints[1].sha, a.checkpoint.sha);

  const shown = await git.getCheckpoint(sb, session.id, b.checkpoint.sha, { env: ON });
  assert.equal(shown.ok, true);
  assert.equal(shown.checkpoint.sha, b.checkpoint.sha);
  assert.match(String(shown.patch || ''), /nuevo\.txt|n/);

  await assert.rejects(
    () => git.getCheckpoint(sb, session.id, 'a'.repeat(40), { env: ON }),
    (err) => spanishError(err, 'E_CHECKPOINT_NOT_FOUND'),
  );
});

test('missing session is E_SESSION_NOT_FOUND in Spanish', async () => {
  const sb = sandbox();
  await assert.rejects(
    () => git.statusSession(sb, 'csb_missing', { env: ON }),
    (err) => spanishError(err, 'E_SESSION_NOT_FOUND'),
  );
});

test('buildGitArgv is argv-only: no shell, no checkout of host paths', () => {
  assert.deepEqual(runner.buildGitArgv('init', { branch: 'main' }), ['init', '-b', 'main']);
  assert.deepEqual(runner.buildGitArgv('status'), ['status', '--porcelain=v1', '-uall']);
  const diff = runner.buildGitArgv('diff', { path: 'src/app.ts' });
  assert.deepEqual(diff.slice(0, 3), ['diff', '--no-color', '--no-ext-diff']);
  assert.ok(diff.includes('--'));
  assert.ok(diff.includes('src/app.ts'));
  assert.deepEqual(runner.buildGitArgv('add'), ['add', '-A']);
  const commit = runner.buildGitArgv('commit', { message: 'punto' });
  assert.ok(commit.includes('commit'));
  assert.ok(commit.includes('-m'));
  assert.ok(commit.includes('punto'));
  assert.ok(!commit.includes('--allow-empty') || commit.includes('-m'));
  assert.deepEqual(runner.buildGitArgv('rev-parse'), ['rev-parse', 'HEAD']);
  const log = runner.buildGitArgv('log', { limit: 20 });
  assert.ok(log[0] === 'log');
  assert.ok(log.includes('-n'));
  assert.throws(() => runner.buildGitArgv('push'), (e) => spanishError(e, 'E_PARAMS'));
  assert.throws(() => runner.buildGitArgv('commit', { message: 'x; rm -rf /' }), (e) => spanishError(e, 'E_PARAMS'));
});

test('injectable runner records argv and never concatenates a shell string', async () => {
  const { sb, session } = await seeded();
  const run = fakeRunner((input) => {
    const argv = input.argv || [];
    assert.ok(Array.isArray(argv), 'runner must receive argv');
    assert.ok(!argv.some((a) => /[;&|`$]/.test(String(a))), argv.join(' '));
    if (argv[0] === 'init') return { stdout: '', exitCode: 0 };
    if (argv[0] === 'status') return { stdout: '?? src/app.ts\n?? README.md\n', exitCode: 0 };
    if (argv[0] === 'diff') return { stdout: 'diff --git a/src/app.ts b/src/app.ts\n', exitCode: 0 };
    if (argv[0] === 'add') return { stdout: '', exitCode: 0 };
    if (argv.includes('commit')) return { stdout: '', exitCode: 0 };
    if (argv[0] === 'rev-parse') return { stdout: `${'ab'.repeat(20)}\n`, exitCode: 0 };
    if (argv[0] === 'log') return { stdout: `${'ab'.repeat(20)}\0punto\0${Math.floor(Date.now() / 1000)}\n`, exitCode: 0 };
    return { stdout: '', exitCode: 0 };
  });
  const init = await git.initSession(sb, session.id, { env: ON, runner: run });
  assert.equal(init.initialized, true);
  const st = await git.statusSession(sb, session.id, { env: ON, runner: run });
  assert.ok(st.files.some((f) => f.path === 'src/app.ts'));
  const cp = await git.checkpointSession(sb, session.id, { env: ON, runner: run, message: 'punto' });
  sha40(cp.checkpoint.sha);
  assert.ok(run.calls.length >= 3);
  for (const call of run.calls) {
    assert.ok(Array.isArray(call.argv));
    assert.equal(typeof call.command, 'undefined');
  }
});

test('parsePorcelain and parseLog accept fixture-shaped git output', () => {
  const files = runner.parsePorcelain(' M src/app.ts\n?? README.md\nA  added.ts\n D gone.ts\n');
  assert.deepEqual(files.map((f) => f.path), ['src/app.ts', 'README.md', 'added.ts', 'gone.ts']);
  assert.equal(files[0].status, 'M');
  assert.equal(files[1].status, '??');
  const log = runner.parseLog(`${'cd'.repeat(20)}\u0000hola\u00001710000000\n${'ef'.repeat(20)}\u0000adios\u00001710000001\n`);
  assert.equal(log.length, 2);
  assert.equal(log[0].message, 'hola');
  sha40(log[0].sha);
});

test('injected exec ENOENT becomes E_GIT_FAILED in Spanish', async () => {
  const { sb, session } = await seeded();
  const run = runner.createGitRunner({
    exec: async () => {
      const err = new Error('spawn git ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
  });
  await assert.rejects(
    () => git.initSession(sb, session.id, { env: ON, runner: run }),
    (err) => spanishError(err, 'E_GIT_FAILED'),
  );
});

test('runner timeout is E_TIMEOUT in Spanish', async () => {
  const { sb, session } = await seeded();
  await assert.rejects(
    () => git.statusSession(sb, session.id, {
      env: ON,
      runner: async () => {
        const err = new Error('timeout');
        err.code = 'E_TIMEOUT';
        throw err;
      },
    }),
    (err) => spanishError(err, 'E_TIMEOUT'),
  );
});

test('jailRelPath still owns git path filters', () => {
  assert.throws(() => jailRelPath('../x'), (e) => e.code === 'E_PATH_ESCAPE');
  assert.equal(jailRelPath('/workspace/src/app.ts'), 'src/app.ts');
});

test('POST /sessions/:id/git/* is 404 when the flag is off', { skip: !express }, async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agentes-coding', createAgentesCodingRouter({ env: {}, sandbox: sandbox() }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = server.address().port;
    const paths = [
      ['POST', '/api/agentes-coding/sessions/csb_x/git/init'],
      ['GET', '/api/agentes-coding/sessions/csb_x/git/status'],
      ['GET', '/api/agentes-coding/sessions/csb_x/git/diff'],
      ['POST', '/api/agentes-coding/sessions/csb_x/git/checkpoint'],
      ['GET', '/api/agentes-coding/sessions/csb_x/git/checkpoints'],
    ];
    for (const [method, urlPath] of paths) {
      const { status, body } = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: urlPath,
          method,
          headers: { 'Content-Type': 'application/json' },
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({
            status: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
          }));
        });
        req.on('error', reject);
        req.end('{}');
      });
      assert.equal(status, 404, `${method} ${urlPath}`);
      assert.equal(body.error, 'not_found');
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('HTTP init + status + checkpoint + diff when flag is on', { skip: !express }, async () => {
  const { sb, session } = await seeded();
  const app = express();
  app.use(express.json());
  app.use('/api/agentes-coding', createAgentesCodingRouter({
    env: ON,
    sandbox: sb,
    authenticate: (_req, _res, next) => next(),
  }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const request = (method, urlPath, body) => new Promise((resolve, reject) => {
    const port = server.address().port;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
      }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    const init = await request('POST', `/api/agentes-coding/sessions/${session.id}/git/init`, {});
    assert.equal(init.status, 200);
    assert.equal(init.json.initialized, true);
    const st = await request('GET', `/api/agentes-coding/sessions/${session.id}/git/status`);
    assert.equal(st.status, 200);
    assert.equal(st.json.clean, false);
    const cp = await request('POST', `/api/agentes-coding/sessions/${session.id}/git/checkpoint`, {
      message: 'fixture',
    });
    assert.equal(cp.status, 201);
    sha40(cp.json.checkpoint.sha);
    await sb.writeFile(session.id, 'src/app.ts', "export const greeting = 'editado';\n");
    const diff = await request('GET', `/api/agentes-coding/sessions/${session.id}/git/diff`);
    assert.equal(diff.status, 200);
    assert.match(diff.json.patch, /editado/);
    const list = await request('GET', `/api/agentes-coding/sessions/${session.id}/git/checkpoints`);
    assert.equal(list.status, 200);
    assert.equal(list.json.checkpoints.length, 1);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('route source mounts /git/* behind the flag helper', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/agentes-coding.js'), 'utf8');
  assert.match(src, /\/sessions\/:id\/git\/init/);
  assert.match(src, /\/sessions\/:id\/git\/status/);
  assert.match(src, /\/sessions\/:id\/git\/diff/);
  assert.match(src, /\/sessions\/:id\/git\/checkpoint/);
  assert.match(src, /\/sessions\/:id\/git\/checkpoints/);
  assert.match(src, /isAgentesCodingV2Enabled/);
  assert.match(src, /error: 'not_found'/);
  assert.doesNotMatch(src, /daytona|OpenRouter|\/code\/page|isomorphic-git|simple-git/i);
});

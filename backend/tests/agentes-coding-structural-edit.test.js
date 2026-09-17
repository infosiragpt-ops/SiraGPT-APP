'use strict';

/**
 * agentes-coding/structural-edit — ast-grep pattern preview/apply
 * (AGENTES_CODING_V2). Injectable runner — no real `sg` binary in CI.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const se = require('../src/services/agentes-coding/structural-edit');
const patterns = require('../src/services/agentes-coding/structural-edit/patterns');
const runner = require('../src/services/agentes-coding/structural-edit/runner');
const { createCodingSandbox, CodingSandboxError } = require('../src/services/agentes-coding/coding-sandbox');
const { CATALOG } = require('../src/services/agentes-coding/coding-sandbox/errors');
const { jailRelPath } = require('../src/services/agentes-coding/coding-sandbox/path-jail');

const FIXTURE = path.join(__dirname, 'fixtures/structural-edit/sample');
const ON = { AGENTES_CODING_V2: '1' };

const WORKSPACE = {
  'src/log.ts': 'export function greet(name: string) {\n  console.log(name);\n  return name;\n}\n\nconsole.log("boot");\n',
  'src/ok.ts': 'export const ready = true;\n',
  'src/skip.py': 'def greet(name):\n    print(name)\n',
  'node_modules/pkg/index.js': 'export function ignored() { console.log("vendor"); }\n',
};

function sandbox() {
  return createCodingSandbox({ env: { ...ON }, autoGc: false });
}

async function seeded(files = WORKSPACE) {
  const sb = sandbox();
  const session = await sb.createSession();
  for (const [p, body] of Object.entries(files)) {
    await sb.writeFile(session.id, p, body);
  }
  return { sb, session };
}

/** Injectable sg stand-in: records argv and returns canned or derived matches. */
function fakeRunner(impl) {
  const calls = [];
  const run = async (input) => {
    calls.push(input);
    if (typeof impl === 'function') {
      const out = await impl(input, calls);
      return out;
    }
    return impl;
  };
  run.calls = calls;
  return run;
}

function consoleLogToLogger(input) {
  const matches = [];
  for (const file of input.files || []) {
    const re = /console\.log\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(file.content))) {
      matches.push({
        path: file.path,
        text: m[0],
        replacement: `logger.info(${m[1]})`,
        start: m.index,
        end: m.index + m[0].length,
      });
    }
  }
  return { stdout: JSON.stringify(matches), exitCode: 0, matches };
}

function spanishError(err, code) {
  assert.ok(err instanceof CodingSandboxError, err && err.stack);
  assert.equal(err.code, code);
  assert.match(err.message, /[áéíóúñÁÉÍÓÚÑ]|desactiv|sesión|sandbox|patrón|ruta|edición|archivo|tiempo|Tope|válid/i);
  return true;
}

test('validatePattern rejects empty and oversized input in Spanish', () => {
  assert.throws(() => patterns.validatePattern(''), (e) => spanishError(e, 'E_PARAMS'));
  assert.throws(() => patterns.validatePattern('x'.repeat(patterns.MAX_PATTERN_CHARS + 1)), (e) => spanishError(e, 'E_PARAMS'));
  assert.equal(patterns.validatePattern('console.log($A)'), 'console.log($A)');
});

test('validateRewrite required and control-char guards', () => {
  assert.throws(() => patterns.validateRewrite('', { required: true }), (e) => spanishError(e, 'E_PARAMS'));
  assert.throws(() => patterns.validateRewrite('ok\x00no'), (e) => spanishError(e, 'E_PARAMS'));
  assert.equal(patterns.validateRewrite('logger.info($A)'), 'logger.info($A)');
});

test('inferLang / normalizeLang from extension and allowlist', () => {
  assert.equal(patterns.inferLang('src/App.tsx'), 'tsx');
  assert.equal(patterns.inferLang('src/main.ts'), 'typescript');
  assert.equal(patterns.inferLang('lib/util.py'), 'python');
  assert.equal(patterns.normalizeLang('TypeScript'), 'typescript');
  assert.throws(() => patterns.normalizeLang('brainfuck'), (e) => spanishError(e, 'E_PARAMS'));
});

test('parseSgJson accepts array, wrapped object, and ndjson', () => {
  const one = { file: 'src/a.ts', text: 'foo()', replacement: 'bar()', range: { byteOffset: { start: 0, end: 5 } } };
  assert.deepEqual(runner.parseSgJson(JSON.stringify([one])).map((m) => m.path), ['src/a.ts']);
  assert.equal(runner.parseSgJson(JSON.stringify({ matches: [one] }))[0].replacement, 'bar()');
  const nd = `${JSON.stringify(one)}\n${JSON.stringify({ path: 'b.ts', text: 'x', start: 1, end: 2 })}`;
  assert.equal(runner.parseSgJson(nd).length, 2);
  assert.equal(runner.parseSgJson(JSON.stringify(one))[0].start, 0);
});

test('buildSgArgv is preview-only: pattern, rewrite, lang, no --update-all', () => {
  const argv = runner.buildSgArgv({
    pattern: 'console.log($A)',
    rewrite: 'logger.info($A)',
    lang: 'typescript',
    paths: ['src/log.ts'],
  });
  assert.deepEqual(argv.slice(0, 6), ['--json', '--lang', 'typescript', '-p', 'console.log($A)', '-r']);
  assert.ok(argv.includes('logger.info($A)'));
  assert.ok(argv.includes('src/log.ts'));
  assert.ok(!argv.includes('--update-all'));
  assert.ok(!argv.includes('--update'));
  assert.ok(!argv.includes('-U'));
});

test('previewSession returns proposed diffs via injectable runner', async () => {
  const { sb, session } = await seeded();
  const result = await se.previewSession(sb, session.id, {
    pattern: 'console.log($A)',
    rewrite: 'logger.info($A)',
    lang: 'typescript',
    runner: fakeRunner(consoleLogToLogger),
  });
  assert.equal(result.ok, true);
  assert.ok(result.matches.length >= 2);
  const logDiff = result.diffs.find((d) => d.path === 'src/log.ts');
  assert.ok(logDiff);
  assert.match(logDiff.original, /console\.log/);
  assert.match(logDiff.proposed, /logger\.info\(name\)/);
  assert.ok(!logDiff.proposed.includes('console.log'));
  assert.equal(logDiff.changed, true);
  assert.ok(result.matches.every((m) => !m.path.includes('node_modules')));
});

test('preview path escape is E_PATH_ESCAPE with Spanish copy', async () => {
  const { sb, session } = await seeded();
  await assert.rejects(
    () => se.previewSession(sb, session.id, {
      pattern: 'x',
      paths: ['../etc/passwd'],
      runner: fakeRunner(() => ({ matches: [], stdout: '[]', exitCode: 0 })),
    }),
    (err) => spanishError(err, 'E_PATH_ESCAPE'),
  );
});

test('runner-reported path escape is E_PATH_ESCAPE', async () => {
  const { sb, session } = await seeded();
  await assert.rejects(
    () => se.previewSession(sb, session.id, {
      pattern: 'console.log($A)',
      rewrite: 'logger.info($A)',
      lang: 'typescript',
      runner: fakeRunner(() => ({
        matches: [{ path: '../etc/passwd', text: 'x', replacement: 'y', start: 0, end: 1 }],
        stdout: '[]',
        exitCode: 0,
      })),
    }),
    (err) => spanishError(err, 'E_PATH_ESCAPE'),
  );
});

test('previewForRequest refuses when the flag is off', async () => {
  const sb = createCodingSandbox({ env: { AGENTES_CODING_V2: '0' }, autoGc: false });
  await assert.rejects(
    () => se.previewForRequest(sb, 'csb_x', { pattern: 'x' }, { AGENTES_CODING_V2: '0' }),
    (err) => spanishError(err, 'E_FLAG_OFF'),
  );
});

test('preview missing session is E_SESSION_NOT_FOUND in Spanish', async () => {
  const sb = sandbox();
  await assert.rejects(
    () => se.previewSession(sb, 'csb_missing', {
      pattern: 'x',
      runner: fakeRunner(() => ({ matches: [], stdout: '[]', exitCode: 0 })),
    }),
    (err) => spanishError(err, 'E_SESSION_NOT_FOUND'),
  );
});

test('applySession writes only via sandbox.writeFile and changes content', async () => {
  const { sb, session } = await seeded();
  const writes = [];
  const origWrite = sb.writeFile.bind(sb);
  sb.writeFile = async (id, rel, content) => {
    writes.push({ id, rel, content: String(content) });
    return origWrite(id, rel, content);
  };
  const preview = await se.previewSession(sb, session.id, {
    pattern: 'console.log($A)',
    rewrite: 'logger.info($A)',
    lang: 'typescript',
    runner: fakeRunner(consoleLogToLogger),
  });
  const out = await se.applySession(sb, session.id, { diffs: preview.diffs.filter((d) => d.changed) });
  assert.equal(out.ok, true);
  assert.ok(out.applied.some((a) => a.path === 'src/log.ts'));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].rel, 'src/log.ts');
  const after = (await sb.readFile(session.id, 'src/log.ts')).toString('utf8');
  assert.match(after, /logger\.info\(name\)/);
  assert.ok(!after.includes('console.log'));
});

test('apply without diffs or rewrite is E_PARAMS', async () => {
  const { sb, session } = await seeded();
  await assert.rejects(
    () => se.applySession(sb, session.id, { pattern: 'console.log($A)' }),
    (err) => spanishError(err, 'E_PARAMS'),
  );
});

test('apply does not invoke runner with --update-all', async () => {
  const { sb, session } = await seeded();
  const run = fakeRunner((input) => {
    assert.ok(!(input.argv || []).includes('--update-all'));
    return consoleLogToLogger(input);
  });
  await se.applySession(sb, session.id, {
    pattern: 'console.log($A)',
    rewrite: 'logger.info($A)',
    lang: 'typescript',
    runner: run,
  });
  assert.ok(run.calls.length >= 1);
  for (const call of run.calls) {
    const argv = call.argv || runner.buildSgArgv(call);
    assert.ok(!argv.includes('--update-all'));
  }
});

test('apply stale original is E_CONTENT in Spanish', async () => {
  const { sb, session } = await seeded();
  await assert.rejects(
    () => se.applySession(sb, session.id, {
      diffs: [{ path: 'src/log.ts', original: 'stale', proposed: 'new\n' }],
    }),
    (err) => spanishError(err, 'E_CONTENT'),
  );
});

test('apply path escape in diffs is E_PATH_ESCAPE', async () => {
  const { sb, session } = await seeded();
  await assert.rejects(
    () => se.applySession(sb, session.id, {
      diffs: [{ path: '../etc/passwd', original: 'x', proposed: 'y' }],
    }),
    (err) => spanishError(err, 'E_PATH_ESCAPE'),
  );
  await assert.rejects(
    () => se.applySession(sb, session.id, {
      diffs: [{ path: '/etc/passwd', original: 'x', proposed: 'y' }],
    }),
    (err) => spanishError(err, 'E_PATH_ESCAPE'),
  );
});

test('applyForRequest refuses when the flag is off', async () => {
  const sb = createCodingSandbox({ env: {}, autoGc: false });
  await assert.rejects(
    () => se.applyForRequest(sb, 'csb_x', { diffs: [{ path: 'a.ts', proposed: 'x' }] }, {}),
    (err) => spanishError(err, 'E_FLAG_OFF'),
  );
});

test('injected exec ENOENT becomes E_STRUCT_EDIT_FAILED in Spanish', async () => {
  const { sb, session } = await seeded({ 'src/a.ts': 'export const a = 1\n' });
  const sg = runner.createSgRunner({
    binary: 'sg',
    exec: async () => {
      const err = new Error('spawn sg ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
  });
  await assert.rejects(
    () => se.previewSession(sb, session.id, {
      pattern: 'export const $A = $B',
      lang: 'typescript',
      runner: sg,
    }),
    (err) => spanishError(err, 'E_STRUCT_EDIT_FAILED'),
  );
});

test('error catalog includes E_STRUCT_EDIT_FAILED in Spanish', () => {
  assert.ok(CATALOG.E_STRUCT_EDIT_FAILED);
  assert.match(CATALOG.E_STRUCT_EDIT_FAILED.message, /edición estructural/i);
  assert.match(CATALOG.E_FLAG_OFF.message, /desactiv/i);
  assert.match(CATALOG.E_PATH_ESCAPE.message, /ruta/i);
});

test('POST /sessions/:id/struct-edit is 404 when the flag is off', async () => {
  let express;
  let createAgentesCodingRouter;
  try {
    express = require('express');
    ({ createAgentesCodingRouter } = require('../src/routes/agentes-coding'));
  } catch {
    return;
  }
  const app = express();
  app.use(express.json());
  app.use('/api/agentes-coding', createAgentesCodingRouter({ env: {}, sandbox: sandbox() }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = server.address().port;
    const { status, body } = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/agentes-coding/sessions/csb_x/struct-edit',
        method: 'POST',
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
      req.end(JSON.stringify({ pattern: 'console.log($A)' }));
    });
    assert.equal(status, 404);
    assert.equal(body.error, 'not_found');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('route source mounts struct-edit + apply behind the flag helper', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/agentes-coding.js'), 'utf8');
  assert.match(src, /\/sessions\/:id\/struct-edit/);
  assert.match(src, /struct-edit\/apply/);
  assert.match(src, /previewForRequest/);
  assert.match(src, /applyForRequest/);
  assert.match(src, /isAgentesCodingV2Enabled/);
  assert.match(src, /error: 'not_found'/);
  assert.doesNotMatch(src, /--update-all/);
  assert.doesNotMatch(src, /aider-ai|OpenRouter|daytona|ast-grep\/ast-grep/i);
});

test('disk fixture + injected runner skips node_modules and python when lang=typescript', async () => {
  const { sb, session } = await seeded();
  const result = await se.previewSession(sb, session.id, {
    pattern: 'console.log($A)',
    rewrite: 'logger.info($A)',
    lang: 'typescript',
    runner: fakeRunner(consoleLogToLogger),
  });
  assert.ok(result.matches.every((m) => m.path.startsWith('src/')));
  assert.ok(!result.matches.some((m) => m.path.endsWith('.py')));
  const fixtureLog = fs.readFileSync(path.join(FIXTURE, 'src/log.ts'), 'utf8');
  assert.match(fixtureLog, /console\.log/);
});

test('applyMatchesToText applies from the end so earlier offsets stay valid', () => {
  const src = 'aaXXbbXXcc';
  const next = se.applyMatchesToText(src, [
    { start: 2, end: 4, replacement: '11', text: 'XX' },
    { start: 6, end: 8, replacement: '22', text: 'XX' },
  ]);
  assert.equal(next, 'aa11bb22cc');
});

test('too many matches is E_QUOTA', async () => {
  const { sb, session } = await seeded({ 'src/a.ts': 'export const a = 1\n' });
  const many = Array.from({ length: patterns.MAX_MATCHES + 1 }, (_, i) => ({
    path: 'src/a.ts',
    text: 'a',
    replacement: 'b',
    start: 0,
    end: 1,
    i,
  }));
  await assert.rejects(
    () => se.previewSession(sb, session.id, {
      pattern: '$A',
      rewrite: '$B',
      lang: 'typescript',
      runner: fakeRunner(() => ({ matches: many, stdout: '[]', exitCode: 0 })),
    }),
    (err) => spanishError(err, 'E_QUOTA'),
  );
});

test('runner timeout is E_TIMEOUT in Spanish', async () => {
  const { sb, session } = await seeded({ 'src/a.ts': 'export const a = 1\n' });
  await assert.rejects(
    () => se.previewSession(sb, session.id, {
      pattern: '$A',
      lang: 'typescript',
      runner: async () => {
        const err = new Error('timeout');
        err.code = 'E_TIMEOUT';
        throw err;
      },
    }),
    (err) => spanishError(err, 'E_TIMEOUT'),
  );
});

test('jailRelPath still owns write-path escape (same catalog as sandbox)', () => {
  assert.throws(() => jailRelPath('../x'), (e) => e.code === 'E_PATH_ESCAPE');
  assert.equal(se.jailReportedPath('/workspace/src/a.ts'), 'src/a.ts');
});

test('identical proposed content is skipped, not rewritten', async () => {
  const { sb, session } = await seeded();
  const current = (await sb.readFile(session.id, 'src/ok.ts')).toString('utf8');
  const out = await se.applySession(sb, session.id, {
    diffs: [{ path: 'src/ok.ts', original: current, proposed: current }],
  });
  assert.deepEqual(out.applied, []);
  assert.equal(out.skipped[0].path, 'src/ok.ts');
});

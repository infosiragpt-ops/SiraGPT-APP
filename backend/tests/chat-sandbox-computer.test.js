'use strict';

/**
 * The chat's sandbox computer (production / isolated mode): python_exec and
 * bash_exec work in this chat's persistent /workspace, see the user's
 * uploads in uploads/, and every file they write to outputs/ during a call
 * is validated and delivered as a download. run_tests and verify_artifact
 * also execute inside the sandbox instead of the API host.
 *
 * Offline: fake sandboxes and a stubbed runner, plus end-to-end runs through
 * the real local driver (a temp /workspace on this host).
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.env.AGENT_ARTIFACT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-computer-'));

const runner = require('../src/services/agents/isolated-code-runner');
const hostSandbox = require('../src/services/agents/code-sandbox');
const { INTERNAL, saveArtifact } = require('../src/services/agents/task-tools');
const { Semaphore } = require('../src/utils/async-semaphore');

const realRunIsolated = runner.runIsolated;
const hasPython = spawnSync('python3', ['--version']).status === 0;
const previous = { mode: process.env.SIRAGPT_CODE_SANDBOX, driver: process.env.SIRAGPT_CODE_SANDBOX_DRIVER, hostRun: hostSandbox.run };
let calls;

beforeEach(() => {
  calls = [];
  process.env.SIRAGPT_CODE_SANDBOX = 'isolated';
  hostSandbox.run = async () => { throw new Error('host runner must not execute model code in isolated mode'); };
});

afterEach(() => {
  runner.runIsolated = realRunIsolated;
  hostSandbox.run = previous.hostRun;
  for (const [key, value] of [['SIRAGPT_CODE_SANDBOX', previous.mode], ['SIRAGPT_CODE_SANDBOX_DRIVER', previous.driver]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function stubRunner(result) {
  runner.runIsolated = async (opts) => {
    calls.push(opts);
    return typeof result === 'function' ? result(opts) : result;
  };
}

// ─── runIsolated: workspace mode, staging, outbox ─────────────────────────

function fakeSandbox({ exec, persistent = false, files = {} } = {}) {
  const log = { put: [], exec: [], read: [], destroyed: 0 };
  const store = new Map(Object.entries(files));
  return {
    log,
    store,
    sandbox: {
      driver: 'remote',
      persistent,
      async putFile(rel, buffer) { log.put.push(rel); store.set(rel, Buffer.from(buffer)); },
      async exec(command, opts) {
        log.exec.push({ command, opts });
        return exec ? exec(command, store) : { stdout: '', stderr: '', exitCode: 0 };
      },
      async readFile(rel) {
        log.read.push(rel);
        if (!store.has(rel)) throw new Error('missing');
        return store.get(rel);
      },
      async destroy() { log.destroyed += 1; },
    },
  };
}
const deps = (fake) => ({ createSandbox: async () => fake.sandbox, semaphore: new Semaphore(2) });
const runRelOf = (command) => (/(tmp\/run-[0-9a-f]{12})/.exec(command) || [])[1];

test('workspace mode: the script runs in /workspace with the computer environment; the change detector is inline', async () => {
  const fake = fakeSandbox({ persistent: true });
  const r = await runIsolated({ fake, workdir: 'workspace', outbox: { dir: 'outputs' } });
  assert.equal(r.ok, true);
  const command = fake.log.exec[0].command;
  const runRel = runRelOf(command);
  assert.ok(runRel);
  const lines = command.split('\n');
  assert.equal(lines[0], "cd '/workspace'");
  assert.ok(lines.includes('mkdir -p outputs uploads'));
  assert.ok(lines.some((line) => line.startsWith("find tmp -maxdepth 1 -type d -name 'run-*' -mmin +30")), 'stale run dirs of aborted runs are swept');
  assert.ok(lines.includes(`export SIRA_RUN_DIR='/workspace/${runRel}' WORKSPACE_DIR='/workspace' OUTPUT_DIR='/workspace/outputs' UPLOADS_DIR='/workspace/uploads'`));
  assert.ok(command.includes(`timeout -k 2 10 python3 '${runRel}/main.py' < '${runRel}/.stdin'`));
  // Heredoc: the terminator stands alone, redirections come before it.
  assert.equal(lines.filter((line) => line === 'SIRA_OUTBOX_EOF').length, 2);
  assert.ok(lines.some((line) => line.startsWith("python3 - snapshot 'outputs' > ") && line.endsWith("<<'SIRA_OUTBOX_EOF'")));
  assert.equal(lines[lines.length - 1], 'exit $__sira_status');
  // Only the script and its stdin are written: no detector file the model could rewrite.
  assert.deepEqual(fake.log.put.sort(), [`${runRel}/.stdin`, `${runRel}/main.py`].sort());
  // Persistent volume: the run dir is removed afterwards.
  assert.match(fake.log.exec.at(-1).command, /^rm -rf -- '\/workspace\/tmp\/run-[0-9a-f]{12}'$/);
  assert.equal(fake.log.destroyed, 1);
});

async function runIsolated({ fake, ...opts }) {
  return realRunIsolated({ language: 'python', source: 'print(1)', env: {}, deps: deps(fake), ...opts });
}

test('outbox: only changed files come back; sizes are re-measured by a trusted command; oversize, excess and escaping names are skipped', async () => {
  let report = null;
  const fake = fakeSandbox({
    files: {
      'outputs/a.csv': Buffer.from('x,y\n1,2\n'),
      'outputs/sub/b.png': Buffer.from('png-bytes'),
      'outputs/big.bin': Buffer.alloc(5000, 1),
    },
    exec: (command, store) => {
      const runRel = runRelOf(command);
      if (runRel && command.includes('SIRA_OUTBOX_EOF')) {
        report = `${runRel}/.outbox.json`;
        store.set(report, Buffer.from(JSON.stringify({ changed: ['a.csv', 'sub/b.png', 'big.bin', '../escape.txt', 'c1.txt', 'c2.txt'] })));
        return { stdout: 'listo\n', stderr: '', exitCode: 0 };
      }
      if (command.includes('wc -c <')) {
        // The size probe: a.csv and b.png small, big.bin over the cap; c1/c2 absent.
        return { stdout: 'outputs/a.csv\t8\noutputs/sub/b.png\t9\noutputs/big.bin\t   5000\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  const r = await runIsolated({ fake, workdir: 'workspace', outbox: { dir: 'outputs', maxFiles: 4, maxFileBytes: 1000 } });
  assert.equal(r.ok, true);
  assert.ok(report);
  assert.deepEqual(r.outbox.files.map((f) => [f.rel, f.buffer.toString()]), [['a.csv', 'x,y\n1,2\n'], ['sub/b.png', 'png-bytes']]);
  assert.deepEqual(r.outbox.skipped, [
    { rel: 'c2.txt', reason: 'too_many' },
    { rel: 'big.bin', reason: 'too_large', size: 5000 },
  ]);
  assert.ok(!fake.log.read.some((rel) => rel.includes('escape') || rel.includes('big.bin')), 'never reads an escaping or oversize file');
  const probe = fake.log.exec.find((e) => e.command.includes('wc -c <')).command;
  assert.match(probe, /\[ ! -L 'outputs\/a\.csv' \]/, 'symlinks are never followed');
});

test('stage: missing or different-size uploads travel, identical ones stay; tmp/ and oversize targets are refused', async () => {
  const fake = fakeSandbox({
    persistent: true,
    exec: (command) => (command.includes('wc -c <') && !command.includes('SIRA_OUTBOX_EOF')
      ? { stdout: 'uploads/igual.csv\t5\nuploads/cambio.csv\t3\n', stderr: '', exitCode: 0 }
      : { stdout: '', stderr: '', exitCode: 0 }),
  });
  const r = await runIsolated({
    fake,
    workdir: 'workspace',
    stage: [
      { rel: 'uploads/igual.csv', buffer: Buffer.from('12345') },
      { rel: 'uploads/cambio.csv', buffer: Buffer.from('1234') },
      { rel: 'uploads/nuevo.csv', buffer: Buffer.from('n') },
      { rel: 'tmp/run-evil/main.py', buffer: Buffer.from('x') },
      { rel: '../fuera.csv', buffer: Buffer.from('x') },
    ],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.staged, ['uploads/igual.csv', 'uploads/cambio.csv', 'uploads/nuevo.csv']);
  const uploadsPut = fake.log.put.filter((rel) => rel.startsWith('uploads/'));
  assert.deepEqual(uploadsPut, ['uploads/cambio.csv', 'uploads/nuevo.csv']);
  assert.ok(!fake.log.put.some((rel) => rel.includes('evil') || rel.includes('fuera')));
});

test('big files travel in chunks that are joined inside the sandbox', async () => {
  const fake = fakeSandbox();
  const buffer = crypto.randomBytes(25);
  await runner.putFileChunked(fake.sandbox, 'uploads/grande.bin', buffer, { chunkBytes: 10 });
  assert.deepEqual(fake.log.put, ['uploads/grande.bin.sira-part-0000', 'uploads/grande.bin.sira-part-0001', 'uploads/grande.bin.sira-part-0002']);
  assert.equal(Buffer.concat(fake.log.put.map((rel) => fake.store.get(rel))).toString('hex'), buffer.toString('hex'));
  assert.equal(fake.log.exec[0].command,
    "cd /workspace && cat 'uploads/grande.bin.sira-part-0000' 'uploads/grande.bin.sira-part-0001' 'uploads/grande.bin.sira-part-0002' > 'uploads/grande.bin' && rm -f -- 'uploads/grande.bin.sira-part-0000' 'uploads/grande.bin.sira-part-0001' 'uploads/grande.bin.sira-part-0002'");
  const small = fakeSandbox();
  await runner.putFileChunked(small.sandbox, 'a.txt', Buffer.from('hola'), { chunkBytes: 10 });
  assert.deepEqual(small.log.put, ['a.txt']);
  assert.equal(small.log.exec.length, 0);
});

test('an aborted run never tries the cleanup exec (the next run sweeps it) and still destroys the container', async () => {
  const controller = new AbortController();
  const fake = fakeSandbox({
    persistent: true,
    exec: () => { controller.abort(); return { stdout: '', stderr: '', exitCode: null, aborted: true }; },
  });
  const r = await runIsolated({ fake, workdir: 'workspace', signal: controller.signal });
  assert.equal(r.aborted, true);
  assert.equal(fake.log.exec.length, 1, 'no rm exec with an aborted signal');
  assert.equal(fake.log.destroyed, 1);
});

test('real local driver: uploads readable, outputs delivered once, bash is a real shell', async (t) => {
  if (!hasPython) { t.skip('python3 not available'); return; }
  const env = { ...process.env, SIRAGPT_CODE_SANDBOX_DRIVER: 'local' };
  const persistKey = `computer-${crypto.randomBytes(4).toString('hex')}`;
  const stage = [{ rel: 'uploads/ventas.csv', buffer: Buffer.from('region,ventas\nNorte,10\nSur,20\n') }];
  const first = await realRunIsolated({
    language: 'python', env, persistKey, workdir: 'workspace', stage, outbox: { dir: 'outputs' },
    source: [
      'import csv, os',
      'rows = list(csv.DictReader(open(os.path.join(os.environ["UPLOADS_DIR"], "ventas.csv"))))',
      'os.makedirs("outputs", exist_ok=True)',
      'open("outputs/total.txt", "w").write(str(sum(int(r["ventas"]) for r in rows)))',
      'print(os.path.realpath(os.getcwd()) == os.path.realpath(os.environ["WORKSPACE_DIR"]))',
    ].join('\n'),
  });
  assert.equal(first.ok, true, first.stderr);
  assert.equal(first.stdout.trim(), 'True');
  assert.deepEqual(first.outbox.files.map((f) => [f.rel, f.buffer.toString()]), [['total.txt', '30']]);
  const second = await realRunIsolated({
    language: 'bash', env, persistKey, workdir: 'workspace', stage, outbox: { dir: 'outputs' },
    source: 'set -e\ntest -f uploads/ventas.csv\nprintf "a\\n" > outputs/nuevo.txt\necho "shell=${BASH_VERSION:+bash}"',
  });
  assert.equal(second.ok, true, second.stderr);
  assert.match(second.stdout, /shell=bash/);
  assert.deepEqual(second.outbox.files.map((f) => f.rel), ['nuevo.txt'], 'the earlier output is not delivered again');
});

// ─── python_exec / bash_exec: uploads and delivered files ────────────────

function fakePrisma(rows) {
  const counter = { findMany: 0 };
  return {
    counter,
    file: {
      async findMany({ where }) {
        counter.findMany += 1;
        const ids = new Set(where.id.in);
        return rows.filter((row) => ids.has(row.id) && row.userId === where.userId);
      },
    },
  };
}

test('the turn uploads are staged into uploads/ once per turn, owner-checked, with the document agent names', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-uploads-'));
  const mine = path.join(dir, 'ventas.csv');
  fs.writeFileSync(mine, 'a,b\n1,2\n');
  const prisma = fakePrisma([
    { id: 'f1', userId: 'u1', path: mine, originalName: 'Ventas Q1.csv' },
    { id: 'f2', userId: 'otro', path: mine, originalName: 'ajeno.csv' },
  ]);
  stubRunner({ ok: true, exitCode: 0, stdout: 'ok', stderr: '', outbox: { files: [], skipped: [] } });
  const ctx = { userId: 'u1', chatId: 'c1', fileIds: ['f1', 'f2'], prisma };
  const r1 = await INTERNAL.pythonExec.execute({ source: 'print(1)' }, ctx);
  const r2 = await INTERNAL.bashExec.execute({ source: 'ls uploads' }, ctx);
  assert.equal(prisma.counter.findMany, 1, 'loaded once for the whole turn');
  for (const call of calls) {
    assert.deepEqual(call.stage.map((item) => item.rel), ['uploads/Ventas Q1.csv'], 'another user\'s file never reaches the sandbox');
    assert.equal(call.stage[0].buffer.toString(), 'a,b\n1,2\n');
    assert.equal(call.workdir, 'workspace');
  }
  assert.deepEqual(r1.uploads, ['uploads/Ventas Q1.csv']);
  assert.deepEqual(r2.uploads, ['uploads/Ventas Q1.csv']);
});

test('files written to outputs/ are validated and delivered; broken or oversize ones are reported, not delivered', async () => {
  const csv = 'region,ventas\nNorte,120\nSur,98\nCentro,143\n';
  stubRunner({
    ok: true,
    exitCode: 0,
    stdout: 'hecho',
    stderr: '',
    outbox: {
      files: [
        { rel: 'ventas.csv', size: csv.length, buffer: Buffer.from(csv) },
        { rel: 'roto.docx', size: 12, buffer: Buffer.from('no es un zip') },
      ],
      skipped: [{ rel: 'video.mp4', reason: 'too_large', size: 80 * 1024 * 1024 }],
    },
  });
  const events = [];
  const r = await INTERNAL.pythonExec.execute({ source: 'print(1)' }, { userId: 'u1', chatId: 'c1', onEvent: (e) => events.push(e) });
  assert.equal(r.ok, true);
  assert.equal(r.filesDelivered.length, 1);
  const [delivered] = r.filesDelivered;
  assert.equal(delivered.file, 'outputs/ventas.csv');
  assert.equal(delivered.filename, 'ventas.csv');
  assert.match(delivered.downloadUrl, /^\/api\/agent\/artifact\/[a-f0-9]{16}\?name=ventas\.csv$/);
  assert.match(r.deliveryNote, /ya se entregaron al usuario/);
  const card = events.find((e) => e.type === 'file_artifact');
  assert.equal(card.artifact.id, delivered.artifactId);
  const metadata = JSON.parse(fs.readFileSync(path.join(process.env.AGENT_ARTIFACT_DIR, `${delivered.artifactId}.json`), 'utf8'));
  assert.equal(metadata.ownerUserId, 'u1');
  assert.equal(metadata.chatId, 'c1');
  assert.equal(metadata.validation.passed, true, 'reusable later through generatedArtifactRefs');
  assert.deepEqual(r.filesNotDelivered.map((f) => f.file), ['outputs/roto.docx', 'outputs/video.mp4']);
  assert.match(r.filesNotDelivered[0].reason, /^no pasó la validación/);
  assert.match(r.filesNotDelivered[1].reason, /demasiado grande \(80 MB/);
  assert.equal(events.filter((e) => e.type === 'file_artifact').length, 1, 'a broken file never becomes a download');
});

test('long outputs keep the head and the tail', () => {
  const text = `INICIO-${'x'.repeat(20000)}-FINAL`;
  const out = INTERNAL.headTail(text, 1000);
  assert.ok(out.startsWith('INICIO-'));
  assert.ok(out.endsWith('-FINAL'));
  assert.match(out, /\[19013 caracteres omitidos\]/);
  assert.equal(INTERNAL.headTail('corto', 1000), 'corto');
});

// ─── run_tests and verify_artifact inside the sandbox ────────────────────

test('run_tests executes the harness in the isolated sandbox, never on the API host', async () => {
  stubRunner((opts) => ({ ok: true, exitCode: 0, stdout: 'SANDBOX_RESULT passed=2 failed=0\n', stderr: '', durationMs: 5, language: opts.language }));
  const r = await INTERNAL.runTests.execute({ language: 'python', source: 'def f(x):\n    return x * 2', testSource: '_check("doble", f(2) == 4)\n_check("cero", f(0) == 0)' }, { chatId: 'c-tests' });
  assert.equal(r.ok, true);
  assert.equal(r.passed, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].language, 'python');
  assert.match(calls[0].source, /SANDBOX_RESULT passed=/);
  assert.equal(calls[0].persistKey, 'c-tests');

  stubRunner({ ok: false, unavailable: true, stderr: runner.UNAVAILABLE_MESSAGE, stdout: '' });
  const down = await INTERNAL.runTests.execute({ language: 'javascript', source: 'const a = 1;', testSource: '_check("a", a === 1)' }, {});
  assert.equal(down.ok, false);
  assert.equal(down.code, 'E_SANDBOX_UNAVAILABLE');
});

test('verify_artifact opens the file inside the sandbox (python-docx / pptx / pypdf live there, not on the host)', async () => {
  const artifact = saveArtifact({ filename: 'informe.docx', base64: Buffer.from('PK fake docx').toString('base64'), ownerUserId: 'u1', chatId: 'c1', validation: { passed: true } });
  stubRunner({ ok: true, exitCode: 0, stdout: '{"ok": true, "ext": "docx", "paragraphCount": 3}\n', stderr: '' });
  const r = await INTERNAL.verifyArtifact.execute({ artifactId: artifact.id }, { userId: 'u1', chatId: 'c1' });
  assert.equal(r.ok, true);
  assert.equal(r.paragraphCount, 3);
  assert.equal(calls[0].inputs[0].rel, 'inputs/artifact.docx');
  assert.equal(calls[0].inputs[0].buffer.toString(), 'PK fake docx');
  assert.match(calls[0].source, /path = "inputs\/artifact\.docx"/);
  assert.ok(!calls[0].source.includes(process.env.AGENT_ARTIFACT_DIR), 'no host path in the sandbox script');
});

// ─── End to end: python_exec + bash_exec through the real local driver ──

test('end to end (real local driver): analysis of an upload delivered as a download, then a shell step', async (t) => {
  if (!hasPython) { t.skip('python3 not available'); return; }
  runner.runIsolated = realRunIsolated;
  process.env.SIRAGPT_CODE_SANDBOX_DRIVER = 'local';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-e2e-'));
  const upload = path.join(dir, 'ventas.csv');
  fs.writeFileSync(upload, 'region,ventas\nNorte,10\nSur,20\nCentro,30\n');
  const chatId = `e2e-${crypto.randomBytes(4).toString('hex')}`;
  const ctx = {
    userId: 'u-e2e',
    chatId,
    fileIds: ['up1'],
    prisma: fakePrisma([{ id: 'up1', userId: 'u-e2e', path: upload, originalName: 'ventas.csv' }]),
    onEvent: () => {},
  };
  const analysis = await INTERNAL.pythonExec.execute({ source: [
    'import csv',
    'rows = list(csv.DictReader(open("uploads/ventas.csv")))',
    'with open("outputs/resumen.csv", "w") as f:',
    '    f.write("metrica,valor\\n")',
    '    f.write("total,%d\\n" % sum(int(r["ventas"]) for r in rows))',
    '    f.write("regiones,%d\\n" % len(rows))',
    'print("filas", len(rows))',
  ].join('\n') }, ctx);
  assert.equal(analysis.ok, true, analysis.stderr);
  assert.match(analysis.stdout, /filas 3/);
  assert.deepEqual(analysis.uploads, ['uploads/ventas.csv']);
  assert.deepEqual(analysis.filesDelivered.map((f) => f.filename), ['resumen.csv']);

  const shell = await INTERNAL.bashExec.execute({ source: [
    'wc -l < outputs/resumen.csv',
    'printf "Resumen listo: total y regiones calculados.\\n" > outputs/nota.txt',
    'printf "ok" > outputs/mini.txt',
  ].join('\n') }, ctx);
  assert.equal(shell.ok, true, shell.stderr);
  assert.equal(shell.stdout.trim(), '3');
  assert.deepEqual(shell.filesDelivered.map((f) => f.filename), ['nota.txt'], 'resumen.csv was already delivered');
  assert.deepEqual(shell.filesNotDelivered, [{ file: 'outputs/mini.txt', reason: 'no pasó la validación: vacío o demasiado pequeño (calidad técnica 67/100)' }]);
});

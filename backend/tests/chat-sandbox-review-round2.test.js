'use strict';

/**
 * Second review of the chat sandbox computer: results that are complete and
 * honest. Each test fails without its fix.
 *  - long output kept only its head: the traceback or final result printed
 *    last never reached the model, and the cut split UTF-8 characters;
 *  - 8000 chars of stdout + 4000 of stderr never fit the loop's 8000-char
 *    observation, which is cut in the middle — where the traceback sits;
 *  - a busy or unreachable sandbox service surfaced as "sandbox internal
 *    error", and the turn's uploads were marked staged though they never were;
 *  - files written when a run was cut (time limit, memory) were delivered
 *    half-written: a ZIP / PNG / JPEG without its ending passed;
 *  - files the run wrote were lost without a word when the change detector
 *    or the size probe failed, or when outputs/ was crowded;
 *  - attachments over the caps were silently missing from uploads/ (and read
 *    whole into memory first); a transient load error emptied them for the turn;
 *  - describe_image wrote the original upload over an in-place edit;
 *  - a KILL after a slow container start was called a timeout, not memory;
 *  - the tool selector could drop install_sandbox_package while the recovery
 *    advice tells the model to call it;
 *  - a tool that lost the harness's timeout race kept running and delivering.
 *
 * Offline: fake sandboxes, a stubbed runner and prisma.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AGENT_ARTIFACT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-round2-'));

const runner = require('../src/services/agents/isolated-code-runner');
const docSandbox = require('../src/services/doc-agent/sandbox');
const agentRunner = require('../src/services/agent-runner');
const { INTERNAL } = require('../src/services/agents/task-tools');
const { selectTools } = require('../src/services/agents/tool-selector');
const { createAgentEventStream } = require('../src/services/agent-harness/event-stream');
const { formatObservation } = require('../src/services/react-agent');
const { Semaphore } = require('../src/utils/async-semaphore');

const saved = {
  mode: process.env.SIRAGPT_CODE_SANDBOX,
  runIsolated: runner.runIsolated,
  createSandbox: docSandbox.createSandbox,
  ladder: agentRunner.buildVisionLadderClient,
};

beforeEach(() => {
  process.env.SIRAGPT_CODE_SANDBOX = 'isolated';
});

afterEach(() => {
  if (saved.mode === undefined) delete process.env.SIRAGPT_CODE_SANDBOX;
  else process.env.SIRAGPT_CODE_SANDBOX = saved.mode;
  runner.runIsolated = saved.runIsolated;
  docSandbox.createSandbox = saved.createSandbox;
  agentRunner.buildVisionLadderClient = saved.ladder;
});

function fakeSandbox({ exec, putFile, persistent = false, files = {} } = {}) {
  const log = { put: [], exec: [], read: [], destroyed: 0 };
  const store = new Map(Object.entries(files));
  return {
    log,
    store,
    sandbox: {
      driver: 'remote',
      persistent,
      async putFile(rel, buffer) {
        if (putFile) await putFile(rel, buffer);
        log.put.push(rel);
        store.set(rel, Buffer.from(buffer));
      },
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

const runRelOf = (command) => (/(tmp\/run-[0-9a-f]{12})/.exec(command) || [])[1];
const run = (fake, opts = {}) => saved.runIsolated({
  language: 'python',
  source: 'print(1)',
  env: {},
  deps: { createSandbox: async () => fake.sandbox, semaphore: new Semaphore(2) },
  ...opts,
});

function fakePrisma(rows, { failFirst = false } = {}) {
  let calls = 0;
  return {
    calls: () => calls,
    file: {
      async findMany({ where }) {
        calls += 1;
        if (failFirst && calls === 1) throw new Error('database timeout');
        const ids = new Set(where.id.in);
        return rows.filter((row) => ids.has(row.id) && row.userId === where.userId);
      },
    },
  };
}

const okRun = (extra = {}) => ({
  ok: true, exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false, aborted: false, outbox: { files: [], skipped: [] }, ...extra,
});

// ─── Output: tail kept, observation fitted ───────────────────────────────

test('long output keeps its tail (the traceback / final result) and never splits a UTF-8 character', async () => {
  const noise = 'Advertencia: columna con valores vacíos — ñandú ✓\n'.repeat(2000);
  const fake = fakeSandbox({
    exec: () => ({
      stdout: `${noise}RESULTADO FINAL: 42\n`,
      stderr: `${noise}Traceback (most recent call last):\nZeroDivisionError: division by zero\n`,
      exitCode: 1,
    }),
  });
  const r = await run(fake);
  assert.equal(r.truncated, true);
  assert.ok(r.stdout.startsWith('Advertencia'), 'the head stays');
  assert.match(r.stdout, /RESULTADO FINAL: 42/, 'and so does the end');
  assert.match(r.stderr, /ZeroDivisionError: division by zero/);
  assert.ok(!r.stdout.includes('\uFFFD') && !r.stderr.includes('\uFFFD'), 'cuts land on character boundaries');
  assert.ok(Buffer.byteLength(r.stdout) <= 64 * 1024 + 200);
  for (let max = 3; max <= 14; max += 1) {
    assert.ok(!runner.truncateText('aÁ€😀b'.repeat(6), max).text.includes('\uFFFD'), `cut at ${max} bytes`);
  }
});

test('the python_exec payload fits the loop\'s observation cap: the traceback is never cut out of the middle', async () => {
  const stdout = 'fila procesada\n'.repeat(1500);
  const stderr = `${'FutureWarning: este comportamiento cambiará\n'.repeat(250)}Traceback (most recent call last):\n  File "main.py", line 9\nZeroDivisionError: division by zero\n`;
  runner.runIsolated = async () => ({
    ok: false, exitCode: 1, stdout, stderr, durationMs: 5, timedOut: false, aborted: false,
    outbox: { files: [], skipped: Array.from({ length: 8 }, (_, i) => ({ rel: `extra-${i}.csv`, reason: 'too_many' })) },
  });
  const payload = await INTERNAL.pythonExec.execute({ source: 'print(1)' }, { userId: 'u1', chatId: 'c1' });
  const observation = JSON.parse(formatObservation({ result: payload }));
  assert.equal(observation.truncated, undefined, 'the loop shows it whole');
  assert.match(observation.result.stderr, /ZeroDivisionError: division by zero/);
  assert.match(observation.result.stderr, /^FutureWarning/);
  assert.match(observation.result.stdout, /fila procesada/);
  assert.equal(payload.stdoutTruncated, true);
  assert.equal(payload.stderrTruncated, true);
  // A run that writes many files names five and counts the rest.
  assert.equal(payload.filesNotDelivered.length, 6);
  assert.match(payload.filesNotDelivered[5].reason, /y 3 archivos nuevos más sin entregar/);
  // A short result is left exactly as it was.
  runner.runIsolated = async () => okRun({ stdout: 'hola\n' });
  const small = await INTERNAL.pythonExec.execute({ source: 'print(1)' }, { userId: 'u1', chatId: 'c1' });
  assert.equal(small.stdout, 'hola\n');
  assert.equal(small.stdoutTruncated, false);
});

// ─── Availability and staging ────────────────────────────────────────────

test('a busy or unreachable service before the code runs is "unavailable" (nothing ran), never a crash of the code', async () => {
  const busy = Object.assign(new Error('El entorno de documentos está ocupado; reintenta en un momento'), {
    code: 'sandbox_at_capacity', category: 'capacity', status: 429,
  });
  const atCapacity = fakeSandbox({ putFile: async () => { throw busy; } });
  const r = await run(atCapacity, { workdir: 'workspace', stage: [{ rel: 'uploads/ventas.csv', buffer: Buffer.from('a,b\n1,2\n') }] });
  assert.equal(r.ok, false);
  assert.equal(r.unavailable, true);
  assert.equal(r.stderr, runner.BUSY_MESSAGE);
  assert.equal(r.staged, undefined, 'the uploads never reached /workspace');
  assert.equal(atCapacity.log.destroyed, 1);

  const down = fakeSandbox({ putFile: async () => { throw Object.assign(new Error('sandbox service 503: docker_unavailable'), { status: 503 }); } });
  const r2 = await run(down);
  assert.equal(r2.unavailable, true);
  assert.equal(r2.stderr, runner.UNAVAILABLE_MESSAGE);

  const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:8080'), { code: 'ECONNREFUSED' });
  const network = fakeSandbox({ putFile: async () => { throw new TypeError('fetch failed', { cause: refused }); } });
  assert.equal((await run(network)).unavailable, true);

  // Once the script started, a transport failure is not "nothing ran".
  const midRun = fakeSandbox({ exec: () => { throw Object.assign(new Error('sandbox service 502: bad gateway'), { status: 502 }); } });
  const r3 = await run(midRun);
  assert.equal(r3.unavailable, undefined);
  assert.match(r3.stderr, /^sandbox internal error: sandbox service 502/);
  // And a local failure while preparing says the code did not run.
  const broken = fakeSandbox({ putFile: async () => { throw new Error('could not assemble uploads/x.csv inside the sandbox'); } });
  assert.match((await run(broken)).stderr, /^sandbox internal error \(the code did not run\): could not assemble/);
});

test('the turn\'s uploads count as staged only on proof; a call that failed before staging stages them again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-round2-stage-'));
  const file = path.join(dir, 'ventas.csv');
  fs.writeFileSync(file, 'a,b\n1,2\n');
  const prisma = fakePrisma([{ id: 'f1', userId: 'u1', path: file, originalName: 'ventas.csv', size: 8 }]);
  const stages = [];
  runner.runIsolated = async (opts) => {
    stages.push(opts.stage.map((item) => item.rel));
    if (stages.length === 1) {
      return { ok: false, exitCode: null, stdout: '', stderr: 'sandbox internal error (the code did not run): socket closed', durationMs: 0, timedOut: false, aborted: false };
    }
    return okRun(opts.stage.length ? { staged: opts.stage.map((item) => item.rel), stageSkipped: [] } : {});
  };
  const ctx = { userId: 'u1', chatId: 'c1', fileIds: ['f1'], prisma, signal: new AbortController().signal };
  await INTERNAL.pythonExec.execute({ source: 'print(1)' }, ctx);
  await INTERNAL.bashExec.execute({ source: 'ls uploads' }, ctx);
  await INTERNAL.pythonExec.execute({ source: 'print(3)' }, ctx);
  assert.deepEqual(stages, [['uploads/ventas.csv'], ['uploads/ventas.csv'], []]);
});

// ─── Delivery: complete files only ───────────────────────────────────────

test('a file cut while saving is never delivered: ZIP / PNG / JPEG / GIF / WebP / SVG need their ending', () => {
  const ok = (ext, data, opts) => INTERNAL.validateOutboxFile(ext, Buffer.isBuffer(data) ? data : Buffer.from(data), opts).passed;
  const zipEnd = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
  const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('[Content_Types].xml word/document.xml '.repeat(4)), zipEnd]);
  assert.equal(ok('docx', docx), true);
  assert.equal(ok('docx', docx.subarray(0, docx.length - 30)), false, 'python-docx writes the manifest first: a cut file still has it');
  assert.equal(ok('xlsx', docx.subarray(0, 60)), false);
  assert.equal(INTERNAL.zipEndRecordPresent(docx), true);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 3),
    Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
  ]);
  assert.equal(ok('png', png), true);
  assert.equal(ok('png', png.subarray(0, 30)), false);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1), Buffer.from([0xff, 0xd9])]);
  assert.equal(ok('jpg', jpg), true);
  assert.equal(ok('jpeg', jpg.subarray(0, 60)), false);
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(30, 2), Buffer.from([0x3b])]);
  assert.equal(ok('gif', gif), true);
  assert.equal(ok('gif', gif.subarray(0, 20)), false);
  const webpBody = Buffer.concat([Buffer.from('WEBP'), Buffer.alloc(40, 5)]);
  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(webpBody.length);
  const webp = Buffer.concat([Buffer.from('RIFF'), riffSize, webpBody]);
  assert.equal(ok('webp', webp), true);
  assert.equal(ok('webp', webp.subarray(0, 30)), false);
  assert.equal(ok('svg', '<svg viewBox="0 0 10 10"><rect width="5"'), false, 'an SVG without its closing tag is cut');
  assert.equal(ok('pdf', '%PDF-1.7\nsin final'), false);
});

test('when the run was cut (time limit / killed), a format that cannot prove it is complete is not delivered', async () => {
  const cut = (extra) => ({
    ok: false, exitCode: 124, timedOut: true, ...extra,
    outbox: {
      files: [
        { rel: 'parcial.csv', buffer: Buffer.from('region,ventas\nNorte,120\nSur,9') },
        { rel: 'resumen.json', buffer: Buffer.from('{"total": 218}') },
      ],
      skipped: [],
    },
  });
  const events = [];
  const timedOut = await INTERNAL.deliverSandboxOutbox(cut(), { userId: 'u1', chatId: 'c1', onEvent: (e) => events.push(e) });
  assert.deepEqual(timedOut.delivered.map((d) => d.file), ['outputs/resumen.json'], 'a JSON that parses is complete');
  assert.deepEqual(timedOut.notDelivered.map((d) => d.file), ['outputs/parcial.csv']);
  assert.match(timedOut.notDelivered[0].reason, /se cortó/);
  assert.equal(events.filter((e) => e.type === 'file_artifact').length, 1, 'no download card for a possibly partial file');
  const killed = await INTERNAL.deliverSandboxOutbox(cut({ exitCode: 137, timedOut: false }), { userId: 'u1', chatId: 'c1' });
  assert.deepEqual(killed.notDelivered.map((d) => d.file), ['outputs/parcial.csv'], 'an out-of-memory KILL cuts too');
  // A script that simply failed closed its files: they are delivered.
  const failed = await INTERNAL.deliverSandboxOutbox(cut({ exitCode: 1, timedOut: false }), { userId: 'u1', chatId: 'c1' });
  assert.deepEqual(failed.delivered.map((d) => d.file).sort(), ['outputs/parcial.csv', 'outputs/resumen.json']);
});

test('files the run wrote are never lost in silence: detector failure, failed size probe and a crowded outputs/ are reported', async () => {
  const probeFails = fakeSandbox({
    files: { 'outputs/informe.xlsx': Buffer.from('x'), 'outputs/grafico.png': Buffer.from('y') },
    exec: (command, store) => {
      const runRel = runRelOf(command);
      if (runRel && command.includes('SIRA_OUTBOX_EOF')) {
        store.set(`${runRel}/.outbox.json`, Buffer.from(JSON.stringify({ changed: ['informe.xlsx', 'grafico.png'], capped: false })));
      }
      if (command.includes('SIRA_FILEINFO_EOF')) return { stdout: '', stderr: '', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  const r1 = await run(probeFails, { workdir: 'workspace', outbox: { dir: 'outputs' } });
  assert.deepEqual(r1.outbox.files, []);
  assert.deepEqual(r1.outbox.skipped, [{ rel: 'informe.xlsx', reason: 'unmeasured' }, { rel: 'grafico.png', reason: 'unmeasured' }]);
  assert.ok(!probeFails.log.read.some((rel) => rel.startsWith('outputs/')), 'nothing is read without a trusted size');

  const noReport = fakeSandbox();
  const r2 = await run(noReport, { workdir: 'workspace', outbox: { dir: 'outputs' } });
  assert.deepEqual(r2.outbox.skipped, [{ rel: '', reason: 'detector_failed' }]);

  const crowded = fakeSandbox({
    exec: (command, store) => {
      const runRel = runRelOf(command);
      if (runRel && command.includes('SIRA_OUTBOX_EOF')) store.set(`${runRel}/.outbox.json`, Buffer.from(JSON.stringify({ changed: [], capped: true })));
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  const r3 = await run(crowded, { workdir: 'workspace', outbox: { dir: 'outputs' } });
  assert.deepEqual(r3.outbox.skipped, [{ rel: '', reason: 'scan_capped', limit: runner.OUTBOX_SCAN_MAX_ENTRIES }]);
  assert.match(runner.OUTBOX_DETECTOR, /"capped": capped/, 'the detector reports when its scan is full');

  const told = await INTERNAL.deliverSandboxOutbox({
    ok: true, exitCode: 0, outbox: { files: [], skipped: [...r1.outbox.skipped, ...r2.outbox.skipped, ...r3.outbox.skipped] },
  }, {});
  assert.match(told.notDelivered[0].reason, /no se pudo medir/);
  assert.match(told.notDelivered[2].reason, /no se pudo comprobar qué archivos cambiaron/);
  assert.match(told.notDelivered[3].reason, /más de 2000 archivos/);
});

// ─── Uploads ─────────────────────────────────────────────────────────────

test('attachments that are not in uploads/ are reported, and an over-cap file is never read into memory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-round2-up-'));
  const small = path.join(dir, 'ventas.csv');
  fs.writeFileSync(small, 'a,b\n1,2\n');
  const rows = [
    { id: 'f1', userId: 'u1', path: small, originalName: 'ventas.csv', size: 8 },
    // Declared 900 MB and the path does not even exist: it must never be opened.
    { id: 'f2', userId: 'u1', path: path.join(dir, 'no-existe.mp4'), originalName: 'video.mp4', size: 900 * 1024 * 1024 },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `x${i}`, userId: 'u1', path: small, originalName: `extra-${i}.csv`, size: 8 })),
  ];
  const stages = [];
  runner.runIsolated = async (opts) => {
    stages.push(opts.stage.map((item) => item.rel));
    return okRun({ staged: opts.stage.map((item) => item.rel), stageSkipped: [] });
  };
  const r = await INTERNAL.pythonExec.execute({ source: 'print(1)' }, {
    userId: 'u1', chatId: 'c1', fileIds: rows.map((row) => row.id), prisma: fakePrisma(rows), signal: new AbortController().signal,
  });
  assert.equal(stages[0].includes('uploads/video.mp4'), false);
  assert.equal(r.uploads.includes('uploads/video.mp4'), false, 'never listed as present');
  assert.deepEqual(r.uploadsNotCopied.map((u) => u.file), ['uploads/', 'uploads/video.mp4']);
  assert.match(r.uploadsNotCopied[0].reason, /primeros 8 adjuntos del mensaje; 2 no están en uploads\//);
  assert.match(r.uploadsNotCopied[1].reason, /demasiado grande para copiarlo al sandbox \(900 MB; máximo 64 MB por archivo\)/);
});

test('loadFilesByIds reports an over-cap file without reading it; without a cap nothing changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-round2-load-'));
  const file = path.join(dir, 'grande.bin');
  fs.writeFileSync(file, Buffer.alloc(10, 1));
  const row = { id: 'g', userId: 'u1', path: file, originalName: 'grande.bin', size: 10 };
  const capped = await agentRunner.loadFilesByIds({ prisma: fakePrisma([row]), userId: 'u1', fileIds: ['g'], maxBytesPerFile: 5 });
  assert.deepEqual(capped, [{ name: 'grande.bin', fileId: 'g', skipped: 'too_large', size: 10 }]);
  const stale = await agentRunner.loadFilesByIds({ prisma: fakePrisma([{ ...row, size: 1 }]), userId: 'u1', fileIds: ['g'], maxBytesPerFile: 5 });
  assert.deepEqual(stale, [{ name: 'grande.bin', fileId: 'g', skipped: 'too_large', size: 10 }], 'a stale stored size is caught after reading');
  const plain = await agentRunner.loadFilesByIds({ prisma: fakePrisma([row]), userId: 'u1', fileIds: ['g'] });
  assert.equal(plain[0].buffer.length, 10);
});

test('a transient error loading the attachments is reported and retried on the next call, not cached for the turn', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-round2-retry-'));
  const file = path.join(dir, 'ventas.csv');
  fs.writeFileSync(file, 'a,b\n1,2\n');
  const prisma = fakePrisma([{ id: 'f1', userId: 'u1', path: file, originalName: 'ventas.csv', size: 8 }], { failFirst: true });
  const stages = [];
  runner.runIsolated = async (opts) => {
    stages.push(opts.stage.map((item) => item.rel));
    return okRun(opts.stage.length ? { staged: opts.stage.map((item) => item.rel), stageSkipped: [] } : {});
  };
  const ctx = { userId: 'u1', chatId: 'c1', fileIds: ['f1'], prisma, signal: new AbortController().signal };
  const first = await INTERNAL.pythonExec.execute({ source: 'print(1)' }, ctx);
  assert.match(first.uploadsNotCopied[0].reason, /no se pudieron cargar los adjuntos/);
  const second = await INTERNAL.pythonExec.execute({ source: 'print(2)' }, ctx);
  assert.deepEqual(stages, [[], ['uploads/ventas.csv']]);
  assert.deepEqual(second.uploads, ['uploads/ventas.csv']);
  assert.equal(prisma.calls(), 2);
});

test('describe_image never writes the original upload over an in-place edit of the same turn', async () => {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const original = Buffer.concat([header, Buffer.alloc(64, 1)]);
  const edited = Buffer.concat([header, Buffer.alloc(32, 9)]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-round2-img-'));
  const file = path.join(dir, 'foto.png');
  fs.writeFileSync(file, original);
  const boxes = [];
  docSandbox.createSandbox = async () => {
    const box = fakeSandbox({ files: { 'uploads/foto.png': edited } });
    boxes.push(box);
    return box.sandbox;
  };
  const sent = [];
  agentRunner.buildVisionLadderClient = () => ({
    chat: { completions: { async create(body) { sent.push(body); return { choices: [{ message: { content: 'Foto recortada.' } }] }; } } },
  });
  const ctx = {
    chatId: 'chat-edit', userId: 'u1', fileIds: ['img1'], signal: new AbortController().signal,
    prisma: fakePrisma([{ id: 'img1', userId: 'u1', path: file, originalName: 'foto.png', size: original.length }]),
  };
  // python_exec already staged the turn's uploads (and cropped the photo in place).
  INTERNAL.turnStateFor(ctx).staged = true;
  const r = await INTERNAL.describeImage.execute({ path: 'uploads/foto.png' }, ctx);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(boxes[0].log.put, [], 'the original is not written back');
  assert.ok(JSON.stringify(sent[0]).includes(edited.toString('base64')), 'the edited copy is what gets described');
});

// ─── Exit codes, tool selection, timeouts ────────────────────────────────

test('a KILL (137) after a slow container start is the memory limit, not a timeout, and the model is told', async () => {
  const fake = fakeSandbox({ exec: () => ({ stdout: '', stderr: '', exitCode: 137 }) });
  const r = await saved.runIsolated({
    language: 'python',
    source: 'x = [0] * 10 ** 10',
    timeoutMs: 500,
    env: {},
    deps: {
      createSandbox: async () => { await new Promise((resolve) => setTimeout(resolve, 650)); return fake.sandbox; },
      semaphore: new Semaphore(1),
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, false, 'the time spent starting the container is not the script\'s');
  assert.match(r.stderr, /código 137.*falta de memoria/);
});

test('the tool selector keeps install_sandbox_package whenever python_exec / bash_exec survive the cut', () => {
  const names = [
    'python_exec',
    'describe_image',
    ...Array.from({ length: 14 }, (_, i) => `rag_retrieve_${i}`),
    ...Array.from({ length: 6 }, (_, i) => `chart_${i}`),
    'bash_exec',
    'install_sandbox_package',
    'web_search',
  ];
  const out = selectTools({ tools: names.map((name) => ({ name })), intent: 'data_analysis', userQuery: 'analiza las ventas del trimestre' });
  assert.equal(out.applied, true);
  assert.ok(out.selectedNames.includes('python_exec'));
  assert.ok(out.selectedNames.includes('install_sandbox_package'), 'its ModuleNotFoundError advice must stay callable');
});

test('a sandbox tool that loses the harness timeout race is stopped (ctx.callSignal); the turn signal is untouched', async () => {
  const events = createAgentEventStream({ write: async () => {} });
  const turn = new AbortController();
  let seen = null;
  const slow = {
    name: 'slow_sandbox',
    timeoutMs: 60,
    abortOnTimeout: true,
    execute: (args, ctx) => new Promise((resolve) => {
      seen = ctx;
      ctx.callSignal.addEventListener('abort', () => resolve({ stoppedWith: String(ctx.callSignal.reason && ctx.callSignal.reason.message) }), { once: true });
    }),
  };
  const [wrapped] = events.wrapTools([slow]);
  const ctx = { signal: turn.signal, chatId: 'c1' };
  await assert.rejects(() => wrapped.execute({}, ctx), /tool_timeout/);
  assert.equal(seen.callSignal.aborted, true, 'the run is told to stop');
  assert.match(String(seen.callSignal.reason.message), /tool_timeout/);
  assert.equal(seen.signal, turn.signal, 'per-turn state keeps its key');
  assert.equal(turn.signal.aborted, false, 'the turn goes on');

  // Stop aborts the call as well.
  const stop = new AbortController();
  const [stoppable] = events.wrapTools([{ ...slow, timeoutMs: 5_000 }]);
  const pending = stoppable.execute({}, { signal: stop.signal });
  stop.abort(new Error('el usuario pulsó Detener'));
  assert.match((await pending).stoppedWith, /Detener/);

  // A tool that did not ask keeps the exact context object.
  let plainCtx = null;
  const [plain] = events.wrapTools([{ name: 'plain', timeoutMs: 5_000, execute: async (a, c) => { plainCtx = c; return { ok: true }; } }]);
  await plain.execute({}, ctx);
  assert.equal(plainCtx, ctx);

  // The chat sandbox tools ask for it, and run under it.
  for (const tool of [INTERNAL.pythonExec, INTERNAL.bashExec, INTERNAL.installSandboxPackage, INTERNAL.describeImage]) {
    assert.equal(tool.abortOnTimeout, true, tool.name);
  }
  let runSignal = null;
  runner.runIsolated = async (opts) => { runSignal = opts.signal; return okRun(); };
  const callSignal = new AbortController().signal;
  await INTERNAL.pythonExec.execute({ source: 'print(1)' }, { chatId: 'c1', signal: turn.signal, callSignal });
  assert.equal(runSignal, callSignal);
});

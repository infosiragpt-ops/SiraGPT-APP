'use strict';

/**
 * isolated-code-runner — model-authored code runs inside the hardened
 * document sandbox container, never on the API host, in production.
 *
 * Offline: a fake sandbox records every putFile/exec/readFile/destroy call.
 * No Docker, no network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  runIsolated,
  resolveCodeExecutionMode,
  safeRunRel,
  UNAVAILABLE_MESSAGE,
} = require('../src/services/agents/isolated-code-runner');
const { Semaphore } = require('../src/utils/async-semaphore');

function fakeSandbox({ exec, files = {}, onDestroy, persistent = false } = {}) {
  const calls = { put: [], exec: [], read: [], destroyed: 0 };
  const store = new Map(Object.entries(files));
  return {
    calls,
    sandbox: {
      driver: 'docker',
      runtime: 'runsc',
      gvisor: true,
      persistent,
      async putFile(rel, buffer) {
        calls.put.push({ rel, text: buffer.toString('utf8') });
        store.set(rel, buffer);
        return `/workspace/${rel}`;
      },
      async exec(command, opts) {
        calls.exec.push({ command, opts });
        return exec ? exec(command, opts, store) : { stdout: 'hola\n', stderr: '', exitCode: 0 };
      },
      async readFile(rel) {
        calls.read.push(rel);
        if (!store.has(rel)) throw new Error('missing');
        return store.get(rel);
      },
      async destroy() {
        calls.destroyed += 1;
        if (onDestroy) onDestroy();
      },
    },
  };
}

function depsFor(fake, extra = {}) {
  return { createSandbox: async () => fake.sandbox, semaphore: new Semaphore(4), ...extra };
}

test('mode: production defaults to isolated, elsewhere host; explicit values win', () => {
  assert.equal(resolveCodeExecutionMode({ NODE_ENV: 'production' }), 'isolated');
  assert.equal(resolveCodeExecutionMode({ NODE_ENV: 'development' }), 'host');
  assert.equal(resolveCodeExecutionMode({}), 'host');
  assert.equal(resolveCodeExecutionMode({ NODE_ENV: 'production', SIRAGPT_CODE_SANDBOX: 'host' }), 'host');
  assert.equal(resolveCodeExecutionMode({ NODE_ENV: 'test', SIRAGPT_CODE_SANDBOX: 'isolated' }), 'isolated');
  assert.equal(resolveCodeExecutionMode({ SIRAGPT_CODE_SANDBOX: 'container' }), 'isolated');
  assert.equal(resolveCodeExecutionMode({ NODE_ENV: 'production', SIRAGPT_CODE_SANDBOX: 'auto' }), 'isolated');
});

test('safeRunRel rejects absolute paths, traversal and NULs', () => {
  assert.equal(safeRunRel('inputs/a.docx'), 'inputs/a.docx');
  assert.equal(safeRunRel('out/./x.pdf'), 'out/x.pdf');
  assert.equal(safeRunRel('/etc/passwd'), null);
  assert.equal(safeRunRel('../escape'), null);
  assert.equal(safeRunRel('a/../../escape'), null);
  assert.equal(safeRunRel('a\0b'), null);
  assert.equal(safeRunRel('C:\\x'), null);
  assert.equal(safeRunRel(''), null);
});

test('python runs in the container with the in-container timeout and stdin; sandbox always destroyed', async () => {
  const fake = fakeSandbox();
  const r = await runIsolated({
    language: 'python',
    source: 'print("hola")',
    stdin: 'entrada',
    timeoutMs: 7_500,
    env: {},
    deps: depsFor(fake),
  });
  assert.equal(r.ok, true);
  assert.equal(r.stdout, 'hola\n');
  assert.deepEqual(r.isolation, { driver: 'docker', runtime: 'runsc', gvisor: true, persistent: false });
  assert.equal(fake.calls.exec.length, 1, 'ephemeral workspace: no cleanup exec needed');
  assert.equal(fake.calls.destroyed, 1);
  const main = fake.calls.put.find((p) => p.rel.endsWith('/main.py'));
  const stdin = fake.calls.put.find((p) => p.rel.endsWith('/.stdin'));
  assert.ok(main && main.rel.startsWith('tmp/run-'));
  assert.equal(main.text, 'print("hola")');
  assert.equal(stdin.text, 'entrada');
  const { command, opts } = fake.calls.exec[0];
  assert.match(command, /^cd '\/workspace\/tmp\/run-[0-9a-f]{12}' && if command -v timeout >\/dev\/null 2>&1; then timeout -k 2 8 python3 main\.py < \.stdin; else python3 main\.py < \.stdin; fi$/);
  assert.ok(opts.timeoutMs > 7_500, 'outer exec guard exceeds the script budget');
});

test('javascript runs node main.js', async () => {
  const fake = fakeSandbox();
  const r = await runIsolated({ language: 'javascript', source: 'console.log(1)', env: {}, deps: depsFor(fake) });
  assert.equal(r.ok, true);
  assert.match(fake.calls.exec[0].command, /timeout -k 2 10 node main\.js < \.stdin; else node main\.js < \.stdin; fi$/);
});

test('inputs are placed in the run dir (unsafe names dropped) and collect reads files back', async () => {
  const fake = fakeSandbox({
    exec: async (command, opts, store) => {
      const runRel = command.match(/\/workspace\/(tmp\/run-[0-9a-f]+)/)[1];
      store.set(`${runRel}/out/informe.docx`, Buffer.from('DOCX-BYTES'));
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  const r = await runIsolated({
    language: 'python',
    source: 'pass',
    inputs: [
      { rel: 'inputs/archivo_1.xlsx', buffer: Buffer.from('XLSX') },
      { rel: '../../escape.txt', buffer: Buffer.from('no') },
      { rel: '/abs.txt', buffer: Buffer.from('no') },
      { rel: 'inputs/not-a-buffer.txt', buffer: 'string' },
    ],
    collect: ['out/informe.docx', 'out/missing.pdf', '../escape'],
    env: {},
    deps: depsFor(fake),
  });
  assert.equal(r.ok, true);
  const placed = fake.calls.put.map((p) => p.rel.replace(/^tmp\/run-[0-9a-f]+\//, ''));
  assert.deepEqual(placed.sort(), ['.stdin', 'inputs/archivo_1.xlsx', 'main.py']);
  assert.equal(r.collected['out/informe.docx'].toString(), 'DOCX-BYTES');
  assert.equal(r.collected['out/missing.pdf'], null);
  assert.equal(Object.keys(r.collected).length, 2, 'traversal collect entries are dropped');
});

test('in-container timeout (exit 124) is reported as timedOut, not success', async () => {
  const fake = fakeSandbox({ exec: async () => ({ stdout: '', stderr: '', exitCode: 124 }) });
  const r = await runIsolated({ language: 'python', source: 'while True: pass', timeoutMs: 1000, env: {}, deps: depsFor(fake) });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.match(r.stderr, /timeout after 1s/);
  assert.equal(fake.calls.destroyed, 1);
});

test('non-zero exit keeps stderr and is not ok', async () => {
  const fake = fakeSandbox({ exec: async () => ({ stdout: '', stderr: 'Traceback: ZeroDivisionError', exitCode: 1 }) });
  const r = await runIsolated({ language: 'python', source: '1/0', env: {}, deps: depsFor(fake) });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, false);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /ZeroDivisionError/);
});

test('sandbox unavailable fails closed: honest message, nothing runs on the host', async () => {
  const r = await runIsolated({
    language: 'python',
    source: 'print(1)',
    env: {},
    deps: { createSandbox: async () => { throw new Error('gVisor (runsc) missing'); }, semaphore: new Semaphore(1) },
  });
  assert.equal(r.ok, false);
  assert.equal(r.unavailable, true);
  assert.equal(r.stderr, UNAVAILABLE_MESSAGE);
  assert.match(r.unavailableReason, /runsc/);
});

test('exec crash still destroys the sandbox and releases the permit', async () => {
  const semaphore = new Semaphore(1);
  const fake = fakeSandbox({ exec: async () => { throw new Error('docker exec died'); } });
  const r = await runIsolated({ language: 'python', source: 'x', env: {}, deps: depsFor(fake, { semaphore }) });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /sandbox internal error: docker exec died/);
  assert.equal(fake.calls.destroyed, 1);
  assert.equal(semaphore.active, 0);
});

test('aborted before start never creates a sandbox', async () => {
  const controller = new AbortController();
  controller.abort();
  let created = 0;
  const r = await runIsolated({
    language: 'python',
    source: 'x',
    signal: controller.signal,
    env: {},
    deps: { createSandbox: async () => { created += 1; return fakeSandbox().sandbox; }, semaphore: new Semaphore(1) },
  });
  assert.equal(r.aborted, true);
  assert.equal(created, 0);
});

test('input validation: language, empty and oversized source', async () => {
  const deps = depsFor(fakeSandbox());
  assert.match((await runIsolated({ language: 'ruby', source: 'x', env: {}, deps })).stderr, /unsupported language/);
  assert.match((await runIsolated({ language: 'python', source: '   ', env: {}, deps })).stderr, /empty source/);
  const big = 'x'.repeat(2048);
  assert.match((await runIsolated({ language: 'python', source: big, env: { SANDBOX_MAX_SOURCE_BYTES: '1024' }, deps })).stderr, /source too large/);
});

test('output is capped and flagged as truncated', async () => {
  const fake = fakeSandbox({ exec: async () => ({ stdout: 'a'.repeat(5000), stderr: '', exitCode: 0 }) });
  const r = await runIsolated({
    language: 'python',
    source: 'x',
    env: { SIRAGPT_CODE_SANDBOX_MAX_OUTPUT_BYTES: '1000' },
    deps: depsFor(fake),
  });
  assert.equal(r.truncated, true);
  assert.ok(Buffer.byteLength(r.stdout) < 1200);
});

test('concurrency is bounded: a second run waits for the first container to finish', async () => {
  const semaphore = new Semaphore(1);
  let releaseFirst;
  const order = [];
  const first = fakeSandbox({
    exec: () => new Promise((resolve) => { releaseFirst = () => resolve({ stdout: '1', stderr: '', exitCode: 0 }); }),
    onDestroy: () => order.push('first-destroyed'),
  });
  const second = fakeSandbox({ exec: async () => { order.push('second-exec'); return { stdout: '2', stderr: '', exitCode: 0 }; } });
  const sandboxes = [first.sandbox, second.sandbox];
  const deps = { createSandbox: async () => sandboxes.shift(), semaphore };
  const p1 = runIsolated({ language: 'python', source: 'a', env: {}, deps });
  await new Promise((resolve) => setImmediate(resolve));
  const p2 = runIsolated({ language: 'python', source: 'b', env: {}, deps });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(semaphore.pending, 1, 'second run queued while the first holds the permit');
  releaseFirst();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.stdout, '1');
  assert.equal(r2.stdout, '2');
  assert.deepEqual(order, ['first-destroyed', 'second-exec']);
});

// Real execution through the actual doc-agent sandbox factory (local driver:
// a temp /workspace on this host). Proves the composed command — cd into the
// run dir, stdin redirect, in-container timeout fallback, file placement and
// read-back — works against a real bash + python3, not only against fakes.
test('real run through createSandbox(local): stdin, inputs, outputs and exit codes', async (t) => {
  const { spawnSync } = require('node:child_process');
  if (spawnSync('python3', ['--version']).status !== 0) {
    t.skip('python3 not available');
    return;
  }
  const env = { ...process.env, NODE_ENV: 'test', SIRAGPT_CODE_SANDBOX_DRIVER: 'local' };
  delete env.SIRAGPT_SANDBOX_REQUIRE_GVISOR;
  const ok = await runIsolated({
    language: 'python',
    source: [
      'import sys, os',
      'data = open("inputs/datos.csv").read().splitlines()',
      'total = sum(int(line.split(",")[1]) for line in data[1:])',
      'os.makedirs("out", exist_ok=True)',
      'open("out/resumen.txt", "w").write(f"total={total}")',
      'print(sys.stdin.read().strip(), total)',
    ].join('\n'),
    stdin: 'suma:',
    inputs: [{ rel: 'inputs/datos.csv', buffer: Buffer.from('item,valor\na,40\nb,2\n') }],
    collect: ['out/resumen.txt'],
    timeoutMs: 20_000,
    env,
  });
  assert.equal(ok.ok, true, ok.stderr);
  assert.equal(ok.stdout.trim(), 'suma: 42');
  assert.equal(ok.collected['out/resumen.txt'].toString(), 'total=42');
  assert.equal(ok.isolation.driver, 'local');

  const failed = await runIsolated({ language: 'python', source: 'raise SystemExit(3)', env });
  assert.equal(failed.ok, false);
  assert.equal(failed.exitCode, 3);
});

test('persistKey mounts the chat workspace and the run dir is removed afterwards', async () => {
  const fake = fakeSandbox({ persistent: true });
  let seenOpts;
  const r = await runIsolated({
    language: 'python',
    source: 'print(1)',
    persistKey: 'chat123',
    env: {},
    deps: { createSandbox: async (opts) => { seenOpts = opts; return fake.sandbox; }, semaphore: new Semaphore(1) },
  });
  assert.equal(r.ok, true);
  assert.equal(seenOpts.persistKey, 'chat123');
  assert.equal(r.isolation.persistent, true);
  assert.equal(fake.calls.exec.length, 2);
  assert.match(fake.calls.exec[1].command, /^rm -rf -- '\/workspace\/tmp\/run-[0-9a-f]{12}'$/);
  assert.equal(fake.calls.destroyed, 1);
});

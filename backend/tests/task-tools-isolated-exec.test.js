'use strict';

/**
 * task-tools in isolated mode — python_exec / bash_exec / create_document
 * route model-authored code to the sandbox container (isolated-code-runner)
 * and never touch the host runner (code-sandbox). Host mode stays the
 * default outside production (covered by the existing task-tools suites).
 *
 * Offline: the isolated runner and the host runner are stubbed.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AGENT_ARTIFACT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-isolated-'));

const runner = require('../src/services/agents/isolated-code-runner');
const hostSandbox = require('../src/services/agents/code-sandbox');
const { INTERNAL } = require('../src/services/agents/task-tools');

const original = {
  runIsolated: runner.runIsolated,
  hostRun: hostSandbox.run,
  mode: process.env.SIRAGPT_CODE_SANDBOX,
};
let calls;

beforeEach(() => {
  calls = [];
  process.env.SIRAGPT_CODE_SANDBOX = 'isolated';
  hostSandbox.run = async () => { throw new Error('host runner must not execute model code in isolated mode'); };
});

afterEach(() => {
  runner.runIsolated = original.runIsolated;
  hostSandbox.run = original.hostRun;
  if (original.mode === undefined) delete process.env.SIRAGPT_CODE_SANDBOX;
  else process.env.SIRAGPT_CODE_SANDBOX = original.mode;
});

function stubRunner(result) {
  runner.runIsolated = async (opts) => {
    calls.push(opts);
    return typeof result === 'function' ? result(opts) : result;
  };
}

test('mode follows SIRAGPT_CODE_SANDBOX at call time', () => {
  assert.equal(INTERNAL.codeExecutionMode(), 'isolated');
  process.env.SIRAGPT_CODE_SANDBOX = 'host';
  assert.equal(INTERNAL.codeExecutionMode(), 'host');
});

test('python_exec runs in the container with clamped budget and stdin', async () => {
  stubRunner({ ok: true, exitCode: 0, stdout: '42\n', stderr: '', durationMs: 900, timedOut: false });
  const r = await INTERNAL.pythonExec.execute({ source: 'print(6*7)', stdin: 'x', timeoutMs: 999_999 }, { chatId: 'chat-42' });
  assert.equal(r.ok, true);
  assert.match(r.stdout, /42/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].language, 'python');
  assert.equal(calls[0].source, 'print(6*7)');
  assert.equal(calls[0].stdin, 'x');
  assert.equal(calls[0].timeoutMs, 120_000, 'schema max enforced');
  assert.deepEqual(calls[0].inputs, []);
  assert.equal(calls[0].persistKey, 'chat-42', 'runs in the chat workspace volume');
});

test('python_exec reports an unavailable sandbox honestly and never falls back to the host', async () => {
  stubRunner({ ok: false, unavailable: true, stderr: runner.UNAVAILABLE_MESSAGE, stdout: '' });
  const events = [];
  const r = await INTERNAL.pythonExec.execute({ source: 'print(1)' }, { onEvent: (e) => events.push(e) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_SANDBOX_UNAVAILABLE');
  assert.equal(r.error, runner.UNAVAILABLE_MESSAGE);
  assert.ok(events.some((e) => e.type === 'tool_output' && e.ok === false));
});

test('bash_exec is a real shell in the chat computer (workspace, uploads, outputs)', async () => {
  stubRunner({ ok: true, exitCode: 0, stdout: 'uploads\noutputs\n', stderr: '', outbox: { files: [], skipped: [] } });
  const r = await INTERNAL.bashExec.execute({ source: 'ls' }, { chatId: 'chat-sh' });
  assert.equal(r.ok, true);
  assert.equal(calls[0].language, 'bash');
  assert.equal(calls[0].source, 'ls');
  assert.equal(calls[0].timeoutMs, 15000);
  assert.equal(calls[0].workdir, 'workspace');
  assert.deepEqual(calls[0].outbox, { dir: 'outputs' });
  assert.equal(calls[0].persistKey, 'chat-sh');
});

test('create_document writes OUT_PATH inside the run dir and registers the collected file', async () => {
  const csv = 'region,ventas,variacion\nNorte,120,0.12\nSur,98,0.05\nCentro,143,0.09\n';
  stubRunner((opts) => ({ ok: true, exitCode: 0, stdout: '', stderr: '', collected: { [opts.collect[0]]: Buffer.from(csv) } }));
  const r = await INTERNAL.createDocument.execute({ filename: 'ventas.csv', python: 'import pandas' }, { userId: 'u1', chatId: 'c1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(calls[0].collect, ['out/ventas.csv']);
  assert.equal(calls[0].persistKey, 'c1');
  assert.match(calls[0].source, /os\.environ\["OUT_PATH"\] = os\.path\.abspath\("out\/ventas\.csv"\)/);
  assert.match(calls[0].source, /os\.makedirs\(os\.path\.dirname\(os\.environ\["OUT_PATH"\]\), exist_ok=True\)/);
  assert.ok(!calls[0].source.includes(process.env.AGENT_ARTIFACT_DIR), 'no host path leaks into the container script');
});

test('create_document fails honestly when the script wrote nothing', async () => {
  stubRunner({ ok: true, exitCode: 0, stdout: '', stderr: '', collected: { 'out/vacio.csv': null } });
  const r = await INTERNAL.createDocument.execute({ filename: 'vacio.csv', python: 'pass' }, { userId: 'u1', chatId: 'c1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /did not write OUT_PATH/);
});

test('create_document surfaces an unavailable sandbox', async () => {
  stubRunner({ ok: false, unavailable: true, stderr: runner.UNAVAILABLE_MESSAGE });
  const r = await INTERNAL.createDocument.execute({ filename: 'x.csv', python: 'pass' }, {});
  assert.equal(r.code, 'E_SANDBOX_UNAVAILABLE');
});

test('SPSS inspection reads the file inside the container', async () => {
  const file = path.join(process.env.AGENT_ARTIFACT_DIR, 'datos.sav');
  fs.writeFileSync(file, Buffer.from('$FL2 fake'));
  stubRunner({ ok: true, exitCode: 0, stdout: '{"ok": true, "rowCount": 3, "columnCount": 2, "columns": ["a", "b"]}', stderr: '' });
  const r = await INTERNAL.inspectSavArtifact(file);
  assert.equal(r.ok, true);
  assert.equal(r.rowCount, 3);
  assert.equal(calls[0].inputs[0].rel, 'inputs/artifact.sav');
  assert.equal(calls[0].inputs[0].buffer.toString(), '$FL2 fake');
  assert.match(calls[0].source, /path = "inputs\/artifact\.sav"/);
});

test('descriptions are truthful per mode', () => {
  const isolated = INTERNAL.pythonExecDescription('isolated');
  assert.match(isolated, /isolated Linux sandbox/);
  assert.match(isolated, /never pip install/);
  assert.match(isolated, /pandas/);
  assert.match(isolated, /matplotlib/);
  assert.match(isolated, /uploads\//);
  assert.match(isolated, /outputs\/ \(OUTPUT_DIR\) is validated and delivered/);
  assert.doesNotMatch(isolated, /read-only system|fresh workspace per run/, 'the chat volume persists: never claim otherwise');
  const host = INTERNAL.pythonExecDescription('host');
  assert.match(host, /host interpreter/);
  assert.match(host, /Only the Python standard library is guaranteed/);
  assert.doesNotMatch(host, /python-pptx/);
  const shell = INTERNAL.bashExecDescription('isolated');
  assert.match(shell, /bash script/);
  assert.match(shell, /soffice/);
  assert.match(shell, /outputs\//);
  assert.match(INTERNAL.bashExecDescription('host'), /Node\.js/);
});

// End-to-end through the REAL isolated runner and the doc-agent sandbox
// factory (local driver = a temp /workspace on this host): generated
// artifacts from this chat are copied into the run dir and ARTIFACT_FILES
// points at the in-sandbox copies, never at host paths.
test('python_exec reads chat artifacts copied into the sandbox run dir (real local driver)', async (t) => {
  const { spawnSync } = require('node:child_process');
  if (spawnSync('python3', ['--version']).status !== 0) {
    t.skip('python3 not available');
    return;
  }
  runner.runIsolated = original.runIsolated;
  const previousDriver = process.env.SIRAGPT_CODE_SANDBOX_DRIVER;
  process.env.SIRAGPT_CODE_SANDBOX_DRIVER = 'local';
  t.after(() => {
    if (previousDriver === undefined) delete process.env.SIRAGPT_CODE_SANDBOX_DRIVER;
    else process.env.SIRAGPT_CODE_SANDBOX_DRIVER = previousDriver;
  });
  const { saveArtifact } = require('../src/services/agents/task-tools');
  const ownerUserId = 'owner-iso';
  const chatId = 'chat-iso';
  const a = saveArtifact({ filename: 'a.csv', base64: Buffer.from('x,1\n').toString('base64'), ownerUserId, chatId, validation: { passed: true } });
  const b = saveArtifact({ filename: 'b.csv', base64: Buffer.from('x,1\n').toString('base64'), ownerUserId, chatId, validation: { passed: true } });
  const out = await INTERNAL.pythonExec.execute({ source: [
    'import os',
    'items = list(ARTIFACT_FILES.values())',
    'assert len(items) == 2',
    'assert all(os.path.isabs(i["path"]) and "/inputs/" in i["path"] for i in items)',
    'print("same=" + str(open(items[0]["path"]).read() == open(items[1]["path"]).read()).lower())',
  ].join('\n') }, { userId: ownerUserId, chatId, generatedArtifactRefs: [a, b].map(({ id, filename }) => ({ id, filename })) });
  assert.equal(out.ok, true, out.stderr);
  assert.match(out.stdout, /same=true/);
  assert.doesNotMatch(out.stdout + out.stderr, new RegExp(process.env.AGENT_ARTIFACT_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

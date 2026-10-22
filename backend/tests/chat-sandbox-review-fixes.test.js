'use strict';

/**
 * Fixes from the professional review of the chat sandbox computer
 * (#1056/#1057/#1059):
 *  - the agent harness cut every tool at 120 s, below what a long sandbox run
 *    or a package install legitimately needs;
 *  - delivered files were judged by create_document's "substantial
 *    deliverable" rules, refusing one-column CSVs, short notes, small pages;
 *  - per-turn state (uploads, install budget) lived on the context object,
 *    which the harness copies for approved calls;
 *  - one run could pull an unbounded total of bytes into backend memory.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AGENT_ARTIFACT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-review-'));

const runner = require('../src/services/agents/isolated-code-runner');
const { INTERNAL } = require('../src/services/agents/task-tools');
const { Semaphore } = require('../src/utils/async-semaphore');

test('sandbox tools declare a harness timeout above their real ceiling (the harness default is 120 s)', () => {
  const harness = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'agent-harness', 'event-stream.js'), 'utf8');
  assert.match(harness, /const toolTimeoutMs = Number\(tool\.timeoutMs\) > 0/, 'the harness honours tool.timeoutMs');
  assert.equal(INTERNAL.pythonExec.timeoutMs, 240_000);
  assert.equal(INTERNAL.bashExec.timeoutMs, 240_000);
  assert.equal(INTERNAL.createDocument.timeoutMs, 240_000);
  assert.equal(INTERNAL.runTests.timeoutMs, 180_000);
  assert.equal(INTERNAL.verifyArtifact.timeoutMs, 180_000);
  assert.equal(INTERNAL.describeImage.timeoutMs, 180_000);
  const previous = process.env.SIRAGPT_SANDBOX_PIP_TIMEOUT_MS;
  process.env.SIRAGPT_SANDBOX_PIP_TIMEOUT_MS = '300000';
  try {
    assert.equal(INTERNAL.installSandboxPackage.timeoutMs, 2 * 300_000 + 120_000, 'two installer attempts plus vetting');
  } finally {
    if (previous === undefined) delete process.env.SIRAGPT_SANDBOX_PIP_TIMEOUT_MS;
    else process.env.SIRAGPT_SANDBOX_PIP_TIMEOUT_MS = previous;
  }
  // The python/bash script maximum (120 s) plus container start must fit.
  assert.ok(INTERNAL.pythonExec.timeoutMs >= 120_000 + 60_000);
});

test('delivered files are checked for integrity, not for size or "substance"', () => {
  const ok = (ext, data) => INTERNAL.validateOutboxFile(ext, Buffer.isBuffer(data) ? data : Buffer.from(data)).passed;
  assert.equal(ok('csv', 'nombre\nAna\nLuis\n'), true, 'a one-column CSV is a legitimate export');
  assert.equal(ok('txt', 'ok'), true, 'a short note is a legitimate result');
  assert.equal(ok('md', '# Hola'), true);
  assert.equal(ok('html', '<p>hola</p>'), true);
  assert.equal(ok('json', '{"a":1}'), true);
  assert.equal(ok('json', '{roto'), false);
  assert.equal(ok('txt', ''), false, 'empty files are never delivered');
  // A complete PNG ends with its IEND chunk; a complete ZIP with its
  // end-of-central-directory record (truncated files: chat-sandbox-review-round2).
  const pngEnd = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16), pngEnd]);
  assert.equal(ok('png', png), true);
  assert.equal(ok('png', 'no soy un png'), false);
  const zipEnd = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
  const zip = (body) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(body), zipEnd]);
  assert.equal(ok('xlsx', zip('...[Content_Types].xml...')), true);
  assert.equal(ok('docx', zip('sin manifiesto')), false, 'an Office file without its package manifest is broken');
  assert.equal(ok('docx', 'texto con extension equivocada'), false);
  assert.equal(ok('zip', zip('x')), true);
  assert.equal(ok('pdf', '%PDF-1.7\n...\n%%EOF\n'), true);
  assert.equal(ok('pdf', '%PDF-1.7\ncortado a medias'), false, 'a truncated PDF is refused');
  assert.equal(ok('svg', '<svg><script>alert(1)</script></svg>'), false);
  assert.equal(ok('svg', '<svg viewBox="0 0 1 1"></svg>'), true);
  assert.equal(ok('mp4', '\u0000\u0000\u0000\u0018ftypmp42'), true, 'unknown binary formats only need to be non-empty');
});

test('the per-turn state survives the shallow copy the harness makes for approved calls', async () => {
  const signal = new AbortController().signal;
  const ctx = { chatId: 'c1', signal };
  const state = INTERNAL.turnStateFor(ctx);
  state.installCalls = 2;
  assert.equal(INTERNAL.turnStateFor({ ...ctx, approved: true }).installCalls, 2, 'same turn, same state');
  assert.equal(INTERNAL.turnStateFor({ chatId: 'c1', signal: new AbortController().signal }).installCalls, 0, 'a new turn starts clean');
  // The install budget really holds across copies.
  const previous = { mode: process.env.SIRAGPT_CODE_SANDBOX, pip: process.env.SIRAGPT_SANDBOX_PIP, max: process.env.SIRAGPT_SANDBOX_PIP_MAX_PER_TURN };
  process.env.SIRAGPT_CODE_SANDBOX = 'isolated';
  process.env.SIRAGPT_SANDBOX_PIP = '1';
  process.env.SIRAGPT_SANDBOX_PIP_MAX_PER_TURN = '2';
  try {
    const refused = await INTERNAL.installSandboxPackage.execute({ packages: ['seaborn'] }, { ...ctx, approved: true });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /install budget for this turn is exhausted \(2 calls\)/);
  } finally {
    for (const [key, value] of [['SIRAGPT_CODE_SANDBOX', previous.mode], ['SIRAGPT_SANDBOX_PIP', previous.pip], ['SIRAGPT_SANDBOX_PIP_MAX_PER_TURN', previous.max]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('one run hands back at most 100 MB in total; the rest is reported, never read', async () => {
  const MB = 1024 * 1024;
  const store = new Map();
  const reads = [];
  const sandbox = {
    driver: 'remote',
    persistent: false,
    async putFile(rel, buffer) { store.set(rel, buffer); },
    async exec(command) {
      const runRel = (/(tmp\/run-[0-9a-f]{12})/.exec(command) || [])[1];
      if (runRel && command.includes('SIRA_OUTBOX_EOF')) {
        store.set(`${runRel}/.outbox.json`, Buffer.from(JSON.stringify({ changed: ['a.bin', 'b.bin', 'c.bin'] })));
      }
      if (command.includes('SIRA_FILEINFO_EOF')) {
        return { stdout: JSON.stringify({ 'outputs/a.bin': [40 * MB, null], 'outputs/b.bin': [40 * MB, null], 'outputs/c.bin': [40 * MB, null] }), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async readFile(rel) {
      reads.push(rel);
      if (store.has(rel)) return store.get(rel);
      return Buffer.from('contenido');
    },
    async destroy() {},
  };
  const r = await runner.runIsolated({
    language: 'python',
    source: 'print(1)',
    env: {},
    workdir: 'workspace',
    outbox: { dir: 'outputs' },
    deps: { createSandbox: async () => sandbox, semaphore: new Semaphore(1) },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.outbox.files.map((f) => f.rel), ['a.bin', 'b.bin']);
  assert.deepEqual(r.outbox.skipped, [{ rel: 'c.bin', reason: 'total_too_large', size: 40 * MB }]);
  assert.ok(!reads.includes('outputs/c.bin'), 'a file over the run budget is never pulled into memory');
  assert.equal(runner.OUTBOX_MAX_TOTAL_BYTES, 100 * MB);
});

test('in production the local driver is never accepted as "isolated"', async () => {
  let destroyed = 0;
  const local = {
    driver: 'local', persistent: false,
    async putFile() { throw new Error('nothing may run'); },
    async exec() { throw new Error('nothing may run'); },
    async readFile() { throw new Error('nothing may run'); },
    async destroy() { destroyed += 1; },
  };
  const r = await runner.runIsolated({
    language: 'python', source: 'print(1)', env: { NODE_ENV: 'production' },
    deps: { createSandbox: async () => local, semaphore: new Semaphore(1) },
  });
  assert.equal(r.ok, false);
  assert.equal(r.unavailable, true);
  assert.equal(r.unavailableReason, 'local_driver_in_production');
  assert.equal(destroyed, 1, 'the session is still released');
  // Development and CI keep the local driver.
  const dev = await runner.runIsolated({
    language: 'python', source: 'print(1)', env: { NODE_ENV: 'test' },
    deps: { createSandbox: async () => ({ ...local, async putFile() {}, async exec() { return { stdout: '1\n', stderr: '', exitCode: 0 }; } }), semaphore: new Semaphore(1) },
  });
  assert.equal(dev.ok, true);
});

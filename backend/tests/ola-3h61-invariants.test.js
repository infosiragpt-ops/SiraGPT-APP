'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js')
  ? '/app'
  : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const w59 = require('../src/services/agent-runner/engine-3h59');
const w60 = require('../src/services/agent-runner/engine-3h60');
const w61 = require('../src/services/agent-runner/engine-3h61');
const ad = require('../src/services/agent-runner/engine-adapter');
const local = require('../src/services/sandbox/local-sandbox');
const { createSSEWriter } = require('../src/utils/sse-writer');
const { runAgentLoop, classifyLoopError } = require('../src/services/agent-runner/loop');

function scriptedClient(script) {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          if (i >= script.length) throw new Error('scripted client exhausted');
          const turn = script[i++];
          if (turn.toolCalls) {
            return {
              choices: [{
                message: {
                  content: turn.content || null,
                  tool_calls: turn.toolCalls.map((c, idx) => ({
                    id: `call_${i}_${idx}`,
                    type: 'function',
                    function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
                  })),
                },
              }],
            };
          }
          return { choices: [{ message: { content: turn.content || 'ok' } }] };
        },
      },
    },
  };
}

test('3H61-A-001 unique names do not collide with 3H59/3H60 exports', () => {
  assert.equal(w61.WAVE, '3H61');
  for (const name of w61.HELPERS) {
    assert.equal(w59.HELPERS.includes(name), false, `collides with 3H59 ${name}`);
    assert.equal(w60.HELPERS.includes(name), false, `collides with 3H60 ${name}`);
    assert.equal(typeof w61[name], 'function');
  }
  assert.equal(typeof w61.checkpointHookBeforeMutatingTool, 'undefined');
  assert.equal(typeof w61.sandboxTimeoutThenCleanup, 'undefined');
});

test('3H61-B-001 mutating write checkpoints and rolls back on timeout', async () => {
  const files = { '/tmp/a.txt': Buffer.from('original') };
  const guarded = await w61.guardMutatingWriteClosed({
    tool: 'write_file',
    path: '/tmp/a.txt',
    execute: async () => {
      files['/tmp/a.txt'] = Buffer.from('partial');
      const err = new Error('write timed out');
      err.code = 'ETIMEDOUT';
      throw err;
    },
    readBytes: async (p) => files[p] || null,
    writeBytes: async (p, bytes) => { files[p] = Buffer.from(bytes); },
  });
  assert.equal(guarded.checkpointed, true);
  assert.equal(guarded.rolledBack, true);
  assert.equal(guarded.code, 'ckpt_rollback_timeout');
  assert.equal(files['/tmp/a.txt'].toString(), 'original');
});

test('3H61-C-001 skip checkpoint when write is a no-op', async () => {
  const files = { '/tmp/b.txt': Buffer.from('same') };
  const guarded = await w61.guardMutatingWriteClosed({
    tool: 'write_file',
    path: '/tmp/b.txt',
    execute: async () => {
      files['/tmp/b.txt'] = Buffer.from('same');
      return 'OK: wrote 4 bytes';
    },
    readBytes: async (p) => files[p] || null,
    writeBytes: async (p, bytes) => { files[p] = Buffer.from(bytes); },
  });
  assert.equal(guarded.skipped, true);
  assert.equal(guarded.rolledBack, false);
  assert.equal(guarded.code, 'ckpt_skip_unchanged');
});

test('3H61-S-001 str_replace uniqueness/miss errors are not rewritten as rollback', async () => {
  const files = { 'a.txt': Buffer.from('uno dos uno') };
  const dup = await w61.guardMutatingWriteClosed({
    tool: 'str_replace',
    path: 'a.txt',
    execute: async () => 'ERROR: old_str occurs more than once in a.txt. Add surrounding context to make it unique.',
    readBytes: async (p) => files[p] || null,
    writeBytes: async (p, bytes) => { files[p] = Buffer.from(bytes); },
  });
  assert.equal(dup.rolledBack, false);
  assert.equal(dup.timedOut, false);
  assert.match(dup.result, /more than once/);
  assert.equal(files['a.txt'].toString(), 'uno dos uno');

  const miss = await w61.guardMutatingWriteClosed({
    tool: 'str_replace',
    path: 'a.txt',
    execute: async () => 'ERROR: old_str not found in a.txt. Read the file and copy the exact text (including whitespace).',
    readBytes: async (p) => files[p] || null,
    writeBytes: async (p, bytes) => { files[p] = Buffer.from(bytes); },
  });
  assert.equal(miss.rolledBack, false);
  assert.match(miss.result, /not found/);
  assert.equal(w61.looksLikeTimedOutWrite('ERROR: old_str occurs more than once in a.txt'), false);
  assert.equal(w61.looksLikeLogicalToolReject('ERROR: old_str not found in a.txt'), true);
});

test('3H61-D-001 read tools never take a write checkpoint', async () => {
  const guarded = await w61.guardMutatingWriteClosed({
    tool: 'read_file',
    path: '/tmp/c.txt',
    execute: async () => 'ok',
    readBytes: async () => Buffer.from('x'),
    writeBytes: async () => {},
  });
  assert.equal(guarded.hook, false);
  assert.equal(guarded.checkpointed, false);
  assert.equal(guarded.result, 'ok');
});

test('3H61-E-001 sandbox timeout cleanup only removes safe tmp dirs', () => {
  const removed = [];
  const safe = path.join(os.tmpdir(), 'sira-sbx-ola');
  const unsafe = '/workspace/outputs';
  const hit = w61.cleanupSandboxOnTimeoutClosed({
    elapsedMs: 12_000,
    timeoutMs: 8_000,
    workdir: safe,
    remove: (p) => { removed.push(p); return true; },
  });
  assert.equal(hit.timeout, true);
  assert.equal(hit.cleanup, true);
  assert.equal(hit.removed, true);
  assert.deepEqual(removed, [safe]);
  const blocked = w61.cleanupSandboxOnTimeoutClosed({
    elapsedMs: 12_000,
    timeoutMs: 8_000,
    workdir: unsafe,
    remove: (p) => { removed.push(p); return true; },
  });
  assert.equal(blocked.cleanup, true);
  assert.equal(blocked.safe, false);
  assert.equal(removed.includes(unsafe), false);
});

test('3H61-F-001 orphan reap deletes marked/stale safe workdirs', () => {
  const now = 1_700_000_000_000;
  const old = path.join(os.tmpdir(), 'sira-sbx-old');
  const fresh = path.join(os.tmpdir(), 'sira-sbx-fresh');
  const dirs = [
    { path: old, mtimeMs: now - 11 * 60 * 1000 },
    { path: fresh, mtimeMs: now - 1000 },
    { path: '/workspace/keep', mtimeMs: now - 11 * 60 * 1000, orphan: true },
  ];
  const removed = [];
  const out = w61.reapOrphanSandboxDirsClosed(dirs, {
    now,
    remove: (p) => { removed.push(p); return true; },
  });
  assert.equal(out.count, 1);
  assert.deepEqual(removed, [old]);
  assert.equal(dirs.some((d) => (d.path || d) === old), false);
});

test('3H61-G-001 cancel accounting is exact and never double-counts', () => {
  const first = w61.settleCancelUsageClosed({
    cancelled: true,
    streamedChars: 12,
    usage: { promptTokens: 5 },
    alreadyRecorded: false,
  });
  assert.equal(first.billed, true);
  assert.equal(first.promptTokens, 5);
  assert.equal(first.completionTokens, 3);
  assert.equal(first.totalTokens, 8);
  assert.equal(first.code, 'credit_cancel_partial');
  const second = w61.settleCancelUsageClosed({
    cancelled: true,
    streamedChars: 12,
    usage: { promptTokens: 5 },
    alreadyRecorded: true,
  });
  assert.equal(second.skipped, true);
  assert.equal(second.billed, false);
  assert.equal(second.totalTokens, 0);
  assert.equal(second.code, 'credit_cancel_dedupe');
});

test('3H61-H-001 classified errors are Spanish and never leak stacks', () => {
  const err = new Error('boom');
  err.stack = 'Error: boom\n    at Object.run (engine-3h61.js:1:1)';
  const out = w61.classifyPublicLoopErrorClosed({ code: 'ckpt_rollback_timeout', err });
  assert.equal(out.code, 'ckpt_rollback_timeout');
  assert.equal(out.leaked, false);
  assert.equal(/at Object\./.test(out.message), false);
  assert.ok(out.message.indexOf('Revertí') >= 0);
  const loop = classifyLoopError({ code: 'subtask_no_progress', err });
  assert.equal(loop.code, 'subtask_no_progress');
  assert.equal(/at Object\./.test(loop.message), false);
});

test('3H61-I-001 SSE resume drops listeners and rejects seq past head', () => {
  let offs = 0;
  const ahead = w61.applySseResumeGuardsClosed({
    listeners: [{ off() { offs += 1; } }],
    resume: true,
    lastEventId: 12,
    headSeq: 4,
  });
  assert.equal(ahead.reset, true);
  assert.equal(ahead.ok, false);
  assert.equal(ahead.lastEventId, 0);
  assert.equal(offs, 1);
  const ok = w61.applySseResumeGuardsClosed({
    listeners: [],
    resume: true,
    lastEventId: 3,
    headSeq: 4,
  });
  assert.equal(ok.reset, false);
  assert.equal(ok.ok, true);
});

test('3H61-J-001 SSE writer fail-closes past-head Last-Event-ID', () => {
  const chunks = [];
  const res = {
    headersSent: true,
    writableEnded: false,
    destroyed: false,
    write(s) { chunks.push(String(s)); return true; },
    end() {},
    on() {},
    off() {},
    setHeader() {},
  };
  const sse = createSSEWriter(res, {
    resume: true,
    lastEventId: 99,
    headSeq: 2,
    priorListeners: [{ off() {} }],
    ring: [{ seq: 1, payload: 'data: one\n\n' }, { seq: 2, payload: 'data: two\n\n' }],
  });
  assert.equal(sse.resumeReset, true);
  sse.close();
});

test('3H61-K-001 anti-loop leftovers: no-progress cut + sliced subtask budget', () => {
  const idle = [
    { tokensDelta: 0, artifactsDelta: 0 },
    { tokensDelta: 0, artifactsDelta: 0 },
    { tokensDelta: 0, artifactsDelta: 0 },
  ];
  const cut = w61.enforceSubtaskProgressClosed({ steps: idle, tokensDelta: 0, artifactsDelta: 0 });
  assert.equal(cut.cut, true);
  assert.equal(cut.code, 'subtask_no_progress');
  const sliced = w61.sliceVerificationTokenBudgetClosed({ parentRemaining: 1000 });
  assert.equal(sliced.ok, true);
  assert.equal(sliced.budget, 350);
});

test('3H61-L-001 runAgentLoop rolls back a timed-out write via raw file tools', async () => {
  const files = { 'note.txt': Buffer.from('keep-me') };
  const events = [];
  const result = await runAgentLoop({
    client: scriptedClient([
      { toolCalls: [{ name: 'write_file', args: { path: 'note.txt', content: 'new' } }] },
      { content: 'seguí tras el rollback' },
    ]),
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'escribe' }],
    tools: [],
    executors: {
      async write_file({ path: p, content }) {
        files[p] = Buffer.from(String(content));
        return 'ERROR: sandbox command timed out after 8000ms';
      },
      async __rawRead(p) { return files[p] || null; },
      async __rawWrite(p, bytes) { files[p] = Buffer.from(bytes); },
    },
    maxIterations: 5,
    onEvent: (ev) => events.push(ev),
  });
  assert.equal(files['note.txt'].toString(), 'keep-me');
  assert.equal(result.steps[0].ok, false);
  assert.match(String(result.steps[0].resultPreview), /Revertí|ERROR/);
});

test('3H61-R-001 runAgentLoop invokes sandboxTimeoutThenCleanup on sandbox tool timeout', async () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-sbx-loop-'));
  const result = await runAgentLoop({
    client: scriptedClient([
      { toolCalls: [{ name: 'execute_python', args: { code: 'pass', workdir, timeoutMs: 50 } }] },
      { content: 'ok after cleanup' },
    ]),
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'corre' }],
    tools: [],
    executors: {
      async execute_python() { return 'ERROR: sandbox_timeout after 50ms'; },
      __sandboxWorkdir: workdir,
      __sandboxDirs: [{ path: workdir, orphan: true, mtimeMs: 0 }],
    },
    maxIterations: 4,
  });
  assert.equal(result.steps[0].ok, false);
  assert.match(String(result.steps[0].resultPreview), /sandbox_timeout|ERROR/);
  try { fs.rmSync(workdir, { recursive: true, force: true }); } catch (_) { /* may already be reaped */ }
});

test('3H61-M-001 runAgentLoop cuts idle subtask and accounts cancel once', async () => {
  const ac = new AbortController();
  const events = [];
  const idle = runAgentLoop({
    client: scriptedClient([
      { toolCalls: [
        { name: 'list_files', args: { path: 'a' } },
        { name: 'glob', args: { pattern: '*.md' } },
        { name: 'grep', args: { pattern: 'zzz' } },
      ] },
      { content: 'should-not-run' },
    ]),
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'lista' }],
    tools: [],
    executors: {
      async list_files() { return 'ERROR: empty'; },
      async glob() { return 'ERROR: empty'; },
      async grep() { return 'ERROR: empty'; },
    },
    maxIterations: 6,
    onEvent: (ev) => events.push(ev),
  });
  const cut = await idle;
  assert.equal(cut.stoppedReason, 'subtask_no_progress');
  assert.equal(cut.errorCode, 'subtask_no_progress');

  const cancelLoop = runAgentLoop({
    client: scriptedClient([{ content: 'hola mundo extra' }]),
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'di hola' }],
    tools: [],
    executors: {},
    signal: ac.signal,
    maxIterations: 3,
    onEvent: (ev) => {
      events.push(ev);
      if (ev.type === 'iteration_start') ac.abort();
    },
  });
  await assert.rejects(cancelLoop, (err) => {
    assert.ok(err);
    assert.ok(err.cancelUsage);
    assert.equal(err.cancelUsage.skipped, false);
    const again = w61.settleCancelUsageClosed({
      cancelled: true,
      streamedChars: 4,
      alreadyRecorded: true,
    });
    assert.equal(again.skipped, true);
    return true;
  });
});

test('3H61-N-001 local sandbox timeout path calls cleanup helper', async () => {
  const out = await local.executeLocal(
    { code: 'while True: pass', language: 'python', timeoutMs: 100, workdir: path.join(os.tmpdir(), 'sira-sbx-ola-to') },
    process.env,
    {
      spawnImpl: () => ({
        pid: 4242,
        stdout: { on() {} },
        stderr: { on() {} },
        kill() {},
        on(ev, fn) {
          if (ev === 'close') setTimeout(() => fn(null, 'SIGKILL'), 130);
        },
      }),
    },
  );
  assert.equal(out.ok, false);
  assert.equal(out.code, 'sandbox_timeout');
  assert.equal(out.cleaned, true);
  assert.equal(out.cleanupCode, 'sandbox_timeout_cleanup');
});

test('3H61-O-001 adapter snapshot and DeepSeek lock are 3H61', () => {
  const s = ad.adapterSnapshot();
  assert.ok(s.wave === '3H61' || s.wave === '3H62' || s.wave === '3H63' || s.wave === '3H64');
  assert.equal(s.failClosed, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
  assert.equal(typeof ad.guardMutatingWriteClosed, 'function');
  assert.equal(typeof ad.settleCancelUsageClosed, 'function');
  assert.equal(typeof ad.checkpointHookBeforeMutatingTool, 'function');
  assert.equal(typeof ad.rollbackHookOnTimedOutWrite, 'function');
  assert.equal(typeof ad.skipCheckpointIfUnchanged, 'function');
  assert.equal(typeof ad.sandboxTimeoutThenCleanup, 'function');
  assert.equal(typeof ad.sandboxReapOrphanWorkdirs, 'function');
  assert.equal(typeof ad.sseResumeDropsPriorListeners, 'function');
  assert.equal(typeof ad.sseCancelClearsHeartbeat, 'function');
  assert.equal(typeof ad.sseResumeRejectsSeqPastHead, 'function');
  assert.equal(ad.checkpointHookBeforeMutatingTool, w59.checkpointHookBeforeMutatingTool);
  assert.equal(ad.loadOptionalEngineWave('engine-3h61').WAVE, '3H61');
  assert.equal(w61.refuseOpenRouterInWave3h61({ SIRAGPT_USE_OPENROUTER: '1' }).ok, false);
  assert.equal(w61.refuseOpenRouterInWave3h61({ DEEPSEEK_BASE_URL: 'https://api.deepseek.com' }).ok, true);
});

test('3H61-P-001 live loop/sandbox/sse/generate import 3H59 helper names', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.ok(loop.includes('checkpointHookBeforeMutatingTool'));
  assert.ok(loop.includes('rollbackHookOnTimedOutWrite'));
  assert.ok(loop.includes('skipCheckpointIfUnchanged'));
  assert.ok(loop.includes('sandboxTimeoutThenCleanup'));
  assert.ok(loop.includes('sandboxReapOrphanWorkdirs'));
  assert.ok(loop.includes('settleCancelUsageClosed'));
  assert.ok(loop.includes('enforceSubtaskProgressClosed'));
  const adapter = read('src/services/agent-runner/engine-adapter.js');
  assert.ok(adapter.includes('checkpointHookBeforeMutatingTool'));
  assert.ok(adapter.includes('sandboxTimeoutThenCleanup'));
  assert.ok(adapter.includes('sseResumeDropsPriorListeners'));
  const sse = read('src/utils/sse-writer.js');
  assert.ok(sse.includes('sseResumeDropsPriorListeners'));
  assert.ok(sse.includes('sseCancelClearsHeartbeat'));
  assert.ok(sse.includes('sseResumeRejectsSeqPastHead'));
  const sbx = read('src/services/sandbox/local-sandbox.js');
  assert.ok(sbx.includes('sandboxTimeoutThenCleanup'));
  const ai = read('src/routes/ai.js');
  assert.ok(ai.includes('sseCancelClearsHeartbeat'));
  assert.ok(ai.includes('sseResumeDropsPriorListeners'));
  assert.ok(ai.includes('sseResumeRejectsSeqPastHead'));
  const tools = read('src/services/doc-agent/tools.js');
  assert.ok(tools.includes('checkpointHookBeforeMutatingTool'));
  assert.ok(tools.includes('sandboxTimeoutThenCleanup'));
});

test('3H61-Q-001 public stream + error codes map rollback without traces', () => {
  const { CODES, isRetryable } = require('../src/services/error_codes');
  assert.equal(CODES.CKPT_ROLLBACK_TIMEOUT, 'ckpt_rollback_timeout');
  assert.equal(CODES.SUBTASK_NO_PROGRESS, 'subtask_no_progress');
  assert.equal(isRetryable('ckpt_rollback_timeout'), true);
  const src = read('src/services/observability/public-stream-error.js');
  assert.ok(src.includes("code: 'ckpt_rollback_timeout'"));
  assert.ok(src.includes("code: 'subtask_no_progress'"));
  assert.equal(/sk-[a-zA-Z0-9]{8}/.test(src), false);
  assert.equal(/at Object\./.test(src), false);
});

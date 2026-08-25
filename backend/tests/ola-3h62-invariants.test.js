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
const w62 = require('../src/services/agent-runner/engine-3h62');
const ad = require('../src/services/agent-runner/engine-adapter');
const { runAgentLoop, classifyLoopError, compactMessagesInPlace } = require('../src/services/agent-runner/loop');
const { createSSEWriter } = require('../src/utils/sse-writer');

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

test('3H62-A-001 unique names do not collide with 3H59/3H60/3H61 exports', () => {
  assert.equal(w62.WAVE, '3H62');
  for (const name of w62.HELPERS) {
    assert.equal(w59.HELPERS.includes(name), false, `collides with 3H59 ${name}`);
    assert.equal(w60.HELPERS.includes(name), false, `collides with 3H60 ${name}`);
    assert.equal(w61.HELPERS.includes(name), false, `collides with 3H61 ${name}`);
    assert.equal(typeof w62[name], 'function');
  }
  assert.equal(typeof w62.checkpointHookBeforeMutatingTool, 'undefined');
  assert.equal(typeof w62.guardMutatingWriteClosed, 'undefined');
  assert.equal(typeof w62.verifyReadAfterWriteHash, 'undefined');
  assert.equal(typeof w62.settleCreditsOnError, 'undefined');
});

test('3H62-B-001 syntax-invalid write restores the checkpoint', async () => {
  const files = { '/tmp/a.js': Buffer.from('const ok = 1;') };
  const out = await w62.validateWriteThenRevertClosed({
    path: '/tmp/a.js',
    beforeBytes: Buffer.from('const ok = 1;'),
    afterBytes: Buffer.from('function broken( {'),
    restore: async (p, bytes) => { files[p] = Buffer.from(bytes); },
    tool: 'write_file',
  });
  assert.equal(out.reverted, true);
  assert.equal(out.code, 'write_syntax_revert');
  assert.equal(files['/tmp/a.js'].toString(), 'const ok = 1;');
  const classified = w62.classifyEngine3h62Error({ code: 'write_syntax_revert' });
  assert.ok(classified.message.indexOf('sintaxis') >= 0);
  assert.equal(classified.message.indexOf('expiró'), -1);
});

test('3H62-C-001 hash mismatch after write restores the checkpoint', async () => {
  const files = { '/tmp/b.txt': Buffer.from('expected-body') };
  const out = await w62.validateWriteThenRevertClosed({
    path: '/tmp/b.txt',
    beforeBytes: Buffer.from('original'),
    afterBytes: Buffer.from('corrupt-partial'),
    expectedBytes: Buffer.from('expected-body'),
    restore: async (p, bytes) => { files[p] = Buffer.from(bytes); },
    tool: 'write_file',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reverted, true);
  assert.equal(out.code, 'write_hash_mismatch');
  assert.equal(files['/tmp/b.txt'].toString(), 'original');
});

test('3H62-D-001 exact diff requires ---/+++ and uniqueness stays distinct', async () => {
  const bad = w62.requireExactDiffMarkersClosed('@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'diff_markers');
  const good = w62.requireExactDiffMarkersClosed('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(good.ok, true);
  const uniq = await w62.validateWriteThenRevertClosed({
    path: 'a.txt',
    beforeBytes: Buffer.from('uno dos uno'),
    afterBytes: Buffer.from('uno dos uno'),
    restore: async () => { throw new Error('must-not-restore'); },
    tool: 'str_replace',
    result: 'ERROR: old_str occurs more than once in a.txt. Add surrounding context to make it unique.',
  });
  assert.equal(uniq.uniqueness, true);
  assert.equal(uniq.reverted, false);
  assert.equal(w62.looksLikeLogicalToolReject('ERROR: old_str not found in a.txt'), true);
});

test('3H62-E-001 persist Last-Event-ID never goes backwards and survives empty Map', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-3h62-sse-'));
  const store = {};
  const first = w62.persistLastEventIdClosed({
    sessionKey: 'chat-1',
    lastEventId: 7,
    store,
    root,
  });
  assert.equal(first.persisted, true);
  assert.equal(first.cursor, 7);
  const back = w62.persistLastEventIdClosed({
    sessionKey: 'chat-1',
    lastEventId: 3,
    store,
    root,
  });
  assert.equal(back.persisted, false);
  assert.equal(back.stale, true);
  assert.equal(back.cursor, 7);
  const resumed = w62.resumeGenerateFromPersistedIdClosed({
    sessionKey: 'chat-1',
    ring: [{ seq: 6 }, { seq: 7 }, { seq: 8 }],
    listeners: [{ off() {} }],
    root,
    headSeq: 8,
  });
  assert.equal(resumed.inclusive, true);
  assert.equal(resumed.lastEventId, 7);
  assert.equal(resumed.replay[0].seq, 7);
  assert.equal(resumed.dropped, 1);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* tmp */ }
});

test('3H62-F-001 resume rejects seq past head and drops prior listeners', () => {
  let offs = 0;
  const ahead = w62.resumeGenerateFromPersistedIdClosed({
    headerLastEventId: 99,
    ring: [{ seq: 1 }, { seq: 2 }],
    listeners: [{ off() { offs += 1; } }],
    headSeq: 2,
  });
  assert.equal(ahead.reset, true);
  assert.equal(ahead.ok, false);
  assert.equal(ahead.lastEventId, 0);
  assert.equal(offs, 1);
});

test('3H62-G-001 session checkpoint persist hydrates after a new store', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-3h62-ckpt-'));
  const persisted = w62.persistSessionCheckpointClosed({
    sessionKey: 'thread-9',
    state: { messages: [{ role: 'user', content: 'hola' }], stoppedReason: 'final' },
    root,
  });
  assert.equal(persisted.persisted, true);
  const empty = new Map();
  const hydrated = w62.hydrateSessionCheckpointClosed({
    sessionKey: 'thread-9',
    store: empty,
    root,
  });
  assert.equal(hydrated.hydrated, true);
  assert.equal(hydrated.source, 'file');
  assert.equal(hydrated.state.stoppedReason, 'final');
  assert.equal(hydrated.state.messages[0].content, 'hola');
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* tmp */ }
});

test('3H62-H-001 pgvector pin recovery restores score≥0.85 facts', async () => {
  const compacted = [{ role: 'user', content: 'sigue' }];
  const hits = [
    { factId: 'f1', content: 'MUST: keep-this-pin', score: 0.91, pin: true },
    { factId: 'f2', content: 'noise', score: 0.2 },
  ];
  const recovered = w62.recoverPgvectorPinsClosed({ compacted, memoryHits: hits });
  assert.equal(recovered.recovered, 1);
  assert.ok(recovered.messages.some((m) => String(m.content).includes('keep-this-pin')));
  const live = await w62.recoverPgvectorPinsClosed({
    compacted,
    retrieve: async () => hits,
    query: 'sigue',
  });
  assert.equal(live.recovered, 1);
  assert.equal(live.via, 'pgvector_or_store');
});

test('3H62-I-001 ledger settle never charges pre-token and never double-counts', async () => {
  const calls = [];
  const pre = w62.settleLedgerOnErrorClosed({
    errored: true,
    firstToken: false,
    tokens: 0,
    transaction: { id: 'tx1', userId: 'u1' },
    failLedger: (args) => { calls.push(args); return { ok: true, failed: true }; },
  });
  assert.equal(pre.charged, false);
  assert.equal(pre.code, 'credit_pre_token');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].code, 'credit_pre_token');

  const first = w62.settleLedgerOnErrorClosed({
    cancelled: true,
    firstToken: true,
    usage: { promptTokens: 4, streamedChars: 8 },
    transaction: { id: 'tx2', userId: 'u1' },
    failLedger: (args) => { calls.push(args); return { ok: true }; },
  });
  assert.equal(first.settled, true);
  assert.equal(first.promptTokens, 4);
  assert.ok(first.totalTokens > 0);

  const again = w62.settleLedgerOnErrorClosed({
    cancelled: true,
    alreadySettled: true,
    firstToken: true,
    usage: { promptTokens: 4, streamedChars: 8 },
  });
  assert.equal(again.skipped, true);
  assert.equal(again.charged, false);
  assert.equal(again.code, 'credit_cancel_dedupe');
});

test('3H62-J-001 first-token / turn-end p50/p95 with fake clock', () => {
  const { mock } = require('node:test');
  mock.timers.enable({ apis: ['Date'], now: 1_000 });
  try {
    const ring = [];
    mock.timers.tick(40);
    const a = w62.observeTurnLatencyClosed({
      kind: 'first_token',
      startedAt: 1_000,
      now: Date.now(),
      store: ring,
    });
    assert.equal(a.ok, true);
    assert.equal(a.ms, 40);
    mock.timers.tick(80);
    w62.observeTurnLatencyClosed({ kind: 'first_token', startedAt: 1_000, now: Date.now(), store: ring });
    mock.timers.tick(80);
    const snap = w62.observeTurnLatencyClosed({
      kind: 'turn_end',
      startedAt: 1_000,
      now: Date.now(),
      store: ring,
    });
    assert.equal(snap.snapshot.source, 'scripted');
    assert.equal(snap.snapshot.count, 3);
    assert.equal(snap.snapshot.p50, 120);
    assert.equal(snap.snapshot.p95, 200);
    assert.equal(snap.snapshot.p50 == null, false);
  } finally {
    mock.timers.reset();
  }
});

test('3H62-K-001 runAgentLoop reverts a syntax-broken write_file', async () => {
  const files = { 'app.js': Buffer.from('const ok = 1;') };
  const result = await runAgentLoop({
    client: scriptedClient([
      { toolCalls: [{ name: 'write_file', args: { path: 'app.js', content: 'function broken( {' } }] },
      { content: 'seguí tras el revert' },
    ]),
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'escribe' }],
    tools: [],
    executors: {
      async write_file({ path: p, content }) {
        files[p] = Buffer.from(String(content));
        return 'OK: wrote';
      },
      async __rawRead(p) { return files[p] || null; },
      async __rawWrite(p, bytes) { files[p] = Buffer.from(bytes); },
    },
    maxIterations: 5,
  });
  assert.equal(files['app.js'].toString(), 'const ok = 1;');
  assert.equal(result.steps[0].ok, false);
  assert.match(String(result.steps[0].resultPreview), /sintaxis|Restauré/);
  assert.equal(/expiró/.test(String(result.steps[0].resultPreview)), false);
});

test('3H62-L-001 runAgentLoop refuses apply_patch without ---/+++', async () => {
  const files = { 'x.txt': Buffer.from('keep') };
  const result = await runAgentLoop({
    client: scriptedClient([
      { toolCalls: [{ name: 'apply_patch', args: { path: 'x.txt', diff: '@@ -1 +1 @@\n-keep\n+new\n' } }] },
      { content: 'ok' },
    ]),
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'parche' }],
    tools: [],
    executors: {
      async apply_patch({ path: p, diff }) {
        files[p] = Buffer.from(String(diff));
        return 'OK';
      },
      async __rawRead(p) { return files[p] || null; },
      async __rawWrite(p, bytes) { files[p] = Buffer.from(bytes); },
    },
    maxIterations: 4,
  });
  assert.equal(files['x.txt'].toString(), 'keep');
  assert.equal(result.steps[0].ok, false);
  assert.match(String(result.steps[0].resultPreview), /---\/\+\+\+|marcadores/);
});

test('3H62-M-001 runAgentLoop persists session checkpoint and recovers pins', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-3h62-loop-'));
  const hits = [{ factId: 'p1', content: 'MUST: recovered-pin-xyz', score: 0.95, pin: true }];
  const result = await runAgentLoop({
    client: scriptedClient([{ content: 'listo con pins' }]),
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'continúa' }],
    tools: [],
    executors: {},
    threadId: 'thread-persist-1',
    persistRoot: root,
    memoryHits: hits,
    maxIterations: 2,
  });
  assert.equal(result.stoppedReason, 'final');
  const hydrated = w62.hydrateSessionCheckpointClosed({
    sessionKey: 'thread-persist-1',
    root,
  });
  assert.equal(hydrated.hydrated, true);
  assert.equal(hydrated.state.stoppedReason, 'final');
  assert.ok(result.finalText);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* tmp */ }
});

test('3H62-S-001 runAgentLoop hydrates empty messages from disk checkpoint', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-3h62-hydrate-'));
  w62.persistSessionCheckpointClosed({
    sessionKey: 'thread-hydrate-empty',
    state: { messages: [{ role: 'user', content: 'reanuda desde disco 3H62' }] },
    root,
  });
  const messages = [];
  const result = await runAgentLoop({
    client: scriptedClient([{ content: 'ok-from-disk-ckpt' }]),
    model: 'deepseek-v4-flash',
    messages,
    tools: [],
    executors: {},
    threadId: 'thread-hydrate-empty',
    persistRoot: root,
    maxIterations: 2,
  });
  assert.equal(result.stoppedReason, 'final');
  assert.ok(messages.some((m) => String(m && m.content).includes('reanuda desde disco 3H62')));
  assert.equal(result.finalText, 'ok-from-disk-ckpt');
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* tmp */ }
});

test('3H62-N-001 compact under budget still restores injected pins', () => {
  const messages = [
    { role: 'system', content: 'short' },
    { role: 'user', content: 'hi' },
  ];
  const changed = compactMessagesInPlace(messages, {
    memoryHits: [{ factId: 'a', content: 'MUST: pin-under-budget', score: 0.99, pin: true }],
  });
  assert.equal(changed, true);
  assert.ok(messages.some((m) => String(m && m.content).includes('pin-under-budget')));
});

test('3H62-O-001 adapter snapshot and DeepSeek lock are 3H62', () => {
  const s = ad.adapterSnapshot();
  assert.ok(s.wave === '3H62' || s.wave === '3H63' || s.wave === '3H64' || s.wave === '3H65' || s.wave === '3H66');
  assert.equal(s.failClosed, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
  assert.equal(typeof ad.validateWriteThenRevertClosed, 'function');
  assert.equal(typeof ad.persistLastEventIdClosed, 'function');
  assert.equal(typeof ad.settleLedgerOnErrorClosed, 'function');
  assert.equal(typeof ad.recordFirstTokenLatencySampleP95, 'function');
  assert.equal(typeof ad.retrieveMemoryBeforeGenerateClosed, 'function');
  assert.equal(typeof ad.persistSseLastEventIdCursor, 'function');
  assert.equal(typeof ad.checkpointHookBeforeMutatingTool, 'function');
  assert.equal(ad.checkpointHookBeforeMutatingTool, w59.checkpointHookBeforeMutatingTool);
  assert.equal(ad.loadOptionalEngineWave('engine-3h62').WAVE, '3H62');
  assert.equal(w62.refuseOpenRouterInWave3h62({ SIRAGPT_USE_OPENROUTER: '1' }).ok, false);
  assert.equal(w62.refuseOpenRouterInWave3h62({ DEEPSEEK_BASE_URL: 'https://api.deepseek.com' }).ok, true);
});

test('3H62-P-001 live loop/generate/sse import 3H62 helper names', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.ok(loop.includes('validateWriteThenRevertClosed'));
  assert.ok(loop.includes('requireExactDiffMarkersClosed'));
  assert.ok(loop.includes('recoverPgvectorPinsClosed'));
  assert.ok(loop.includes('persistSessionCheckpointClosed'));
  assert.ok(loop.includes('hydrateSessionCheckpointClosed'));
  assert.ok(loop.includes('settleLedgerOnErrorClosed'));
  assert.ok(loop.includes('observeTurnLatencyClosed'));
  assert.ok(loop.includes('checkpointHookBeforeMutatingTool'));
  const ai = read('src/routes/ai.js');
  assert.ok(ai.includes('resumeGenerateFromPersistedIdClosed'));
  assert.ok(ai.includes('persistLastEventIdClosed'));
  assert.ok(ai.includes('sseResumeDropsPriorListeners'));
  const sse = read('src/utils/sse-writer.js');
  assert.ok(sse.includes('resumeGenerateFromPersistedIdClosed'));
  assert.ok(sse.includes('persistSseLastEventIdCursor'));
  assert.ok(sse.includes('sseResumeDropsPriorListeners'));
  assert.ok(loop.includes('retrieveMemoryBeforeGenerateClosed'));
  assert.ok(loop.includes('retrieveMemoryForLoop'));
  assert.ok(loop.includes('recordFirstTokenLatencySampleP95'));
  assert.ok(ai.includes('persistSseLastEventIdCursor'));
  assert.ok(ai.includes('sira_last_event_id'));
  assert.ok(ai.includes('retrieveMemoryForLoop'));
  assert.ok(ai.includes('recordFirstTokenLatencySampleP95'));
  const tools = read('src/services/doc-agent/tools.js');
  assert.ok(tools.includes('validateWriteThenRevertClosed'));
  const gw = read('src/services/agent-runner/engine-gateway.js');
  assert.ok(gw.includes('settleLedgerOnErrorClosed'));
});

test('3H62-Q-001 SSE writer resume uses persisted id without leaking listeners', () => {
  let offs = 0;
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
    sessionKey: 'sse-3h62',
    priorListeners: [{ off() { offs += 1; } }],
    ring: [{ seq: 1, payload: 'data: one\n\n' }, { seq: 2, payload: 'data: two\n\n' }],
  });
  assert.ok(offs >= 1);
  assert.equal(sse.resumeReset, true);
  sse.close();
});

test('3H62-R-001 classified 3H62 errors are Spanish and never leak stacks', () => {
  const err = new Error('boom');
  err.stack = 'Error: boom\n    at Object.run (engine-3h62.js:1:1)';
  const out = w62.classifyEngine3h62Error({ code: 'write_syntax_revert', err });
  assert.equal(out.leaked, false);
  assert.equal(/at Object\./.test(out.message), false);
  assert.ok(out.message.indexOf('sintaxis') >= 0);
  const loop = classifyLoopError({ code: 'credit_ledger_settle', err });
  assert.equal(loop.code, 'credit_ledger_settle');
  assert.equal(/at Object\./.test(loop.message), false);
  const { CODES, isRetryable } = require('../src/services/error_codes');
  assert.equal(CODES.CREDIT_LEDGER_SETTLE, 'credit_ledger_settle');
  assert.equal(CODES.WRITE_SYNTAX_REVERT, 'write_syntax_revert');
  assert.equal(isRetryable('write_hash_mismatch'), true);
  const src = read('src/services/observability/public-stream-error.js');
  assert.ok(src.includes("code: 'write_syntax_revert'"));
  assert.equal(/sk-[a-zA-Z0-9]{8}/.test(src), false);
});

test('3H62-T-001 persistSseLastEventIdCursor is invoked via persistCursor inject', () => {
  const calls = [];
  const store = {};
  const out = w62.persistLastEventIdClosed({
    sessionKey: 'sid-cursor',
    lastEventId: 5,
    store,
    persistCursor: (args) => { calls.push(args); return ad.persistSseLastEventIdCursor(args); },
  });
  assert.equal(out.persisted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].lastEventId, 5);
  assert.equal(ad.persistSseLastEventIdCursor({ lastEventId: 3, store }).stale, true);
});

test('3H62-U-001 durable Last-Event-ID prefers cookie then file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-3h62-cookie-'));
  w62.persistLastEventIdClosed({ sessionKey: 'chat-cookie', lastEventId: 4, root });
  const fromCookie = w62.readDurableLastEventIdClosed({
    cookieHeader: 'sira_last_event_id=chat-cookie%3A9; Path=/api/ai',
    sessionKey: 'chat-cookie',
    root,
  });
  assert.equal(fromCookie.source, 'cookie');
  assert.equal(fromCookie.lastEventId, 9);
  const fromFile = w62.readDurableLastEventIdClosed({
    sessionKey: 'chat-cookie',
    root,
  });
  assert.equal(fromFile.source, 'file');
  assert.equal(fromFile.lastEventId, 4);
  const baked = w62.cookieForLastEventId({ sessionKey: 'chat-cookie', lastEventId: 9 });
  assert.ok(baked.header.includes('sira_last_event_id='));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* tmp */ }
});

test('3H62-V-001 retrieve-before-generate times out and drops inf/low scores', async () => {
  const infHits = [
    { factId: 'a', content: 'keep', score: 0.9 },
    { factId: 'b', content: 'inf', score: Number.POSITIVE_INFINITY },
    { factId: 'c', content: 'low', score: 0.01 },
  ];
  const filtered = await w62.retrieveMemoryBeforeGenerateClosed({ memoryHits: infHits, minScore: 0.25 });
  assert.equal(filtered.hits.length, 1);
  assert.equal(filtered.hits[0].factId, 'a');
  assert.equal(filtered.droppedInf, 1);
  assert.equal(filtered.droppedScore, 1);

  const timed = await w62.retrieveMemoryBeforeGenerateClosed({
    query: 'q',
    retrieve: () => new Promise(() => {}),
    timeoutMs: 15,
  });
  assert.equal(timed.timedOut, true);
  assert.equal(timed.failOpen, true);
  assert.equal(timed.hits.length, 0);
  assert.equal(timed.code, 'pgvector_timeout');
  const to = ad.pgvectorMemoryQueryTimeout({ elapsedMs: timed.elapsedMs || 15, timeoutMs: 15 });
  assert.equal(to.timedOut, true);
});

test('3H62-W-001 recordFirstTokenLatencySampleP95 fake timers + over-budget hint', () => {
  const { mock } = require('node:test');
  mock.timers.enable({ apis: ['Date'], now: 5_000 });
  try {
    const ring = [];
    mock.timers.tick(40);
    const a = w62.recordFirstTokenLatencySampleP95({
      startedAt: 5_000,
      now: Date.now(),
      store: ring,
      budgetMs: 8_000,
    });
    assert.equal(a.ok, true);
    assert.equal(a.ms, 40);
    assert.equal(a.overBudget, false);
    mock.timers.tick(9_000);
    const late = w62.recordFirstTokenLatencySampleP95({
      startedAt: 5_000,
      now: Date.now(),
      store: ring,
      budgetMs: 8_000,
    });
    assert.equal(late.overBudget, true);
    assert.equal(late.hint, 'first_token_over_budget');
    assert.equal(late.snapshot.p95, late.ms);
    assert.ok(late.p95 != null);
  } finally {
    mock.timers.reset();
  }
});

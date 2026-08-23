'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const ad = require('../src/services/agent-runner/engine-adapter');

test('3H32-A-001 backoff grows exponentially with jitter bounds', () => {
  const a0 = ad.backoffWithJitter(0, { first: 100, max: 2000, random: () => 0.5 });
  const a1 = ad.backoffWithJitter(1, { first: 100, max: 2000, random: () => 0.5 });
  const a3 = ad.backoffWithJitter(8, { first: 100, max: 2000, random: () => 0.5 });
  assert.ok(a1 > a0);
  assert.equal(a3, 2000);
});

test('3H32-A-002 retryToolWithBackoff retries retryable then succeeds', async () => {
  let n = 0;
  const out = await ad.retryToolWithBackoff(async () => {
    n += 1;
    if (n < 3) {
      const err = new Error('econnreset');
      err.code = 'ECONNRESET';
      throw err;
    }
    return 'ok';
  }, { sleepFn: async () => {}, random: () => 0 });
  assert.equal(out.ok, true);
  assert.equal(out.value, 'ok');
  assert.equal(out.attempts, 3);
});

test('3H32-A-003 retryToolWithBackoff does not retry invalid_args', async () => {
  const out = await ad.retryToolWithBackoff(async () => {
    const err = new Error('bad');
    err.code = 'tool_args_invalid';
    throw err;
  }, { sleepFn: async () => {} });
  assert.equal(out.ok, false);
  assert.equal(out.attempts, 1);
});

test('3H32-B-001 consecutive identical tool+args cuts at 2', () => {
  const cut = ad.createConsecutiveRepeatCut({ limit: 2 });
  const a = cut.see('read_file', { path: '/a.js' });
  const b = cut.see('read_file', { path: '/a.js' });
  const c = cut.see('read_file', { path: '/b.js' });
  assert.equal(a.cut, false);
  assert.equal(b.cut, true);
  assert.equal(b.code, 'loop_cut');
  assert.equal(c.cut, false);
});

test('3H32-B-002 session remaining steps is per-session not global', () => {
  ad.resetSessionBudgets();
  const a = ad.sessionRemainingSteps('s1', { maxSteps: 3, consume: 2 });
  const b = ad.sessionRemainingSteps('s2', { maxSteps: 3, consume: 0 });
  const c = ad.sessionRemainingSteps('s1', { maxSteps: 3, consume: 1 });
  assert.equal(a.remaining, 1);
  assert.equal(b.remaining, 3);
  assert.equal(c.ok, false);
  assert.equal(c.code, 'budget_exceeded');
});

test('3H32-C-001 compact drops stale tool bodies but keeps last N names', () => {
  const huge = 'x'.repeat(2000);
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'tool', name: 'read_file', content: huge },
    { role: 'tool', name: 'grep', content: huge },
    { role: 'assistant', content: 'done' },
  ];
  const out = ad.compactDropStaleBodies(msgs, { keepNames: 2, maxBody: 400 });
  assert.equal(out.droppedBodies, 2);
  assert.ok(out.keptNames.includes('grep'));
  assert.ok(out.messages[1].__compacted);
  assert.equal(out.messages[0].content, 'sys');
});

test('3H32-D-001 rollback last file edit restores before', () => {
  const writes = [];
  const ck = ad.rememberFileEdit({}, { path: '/w/a.js', before: 'old', after: 'new' });
  const out = ad.rollbackLastFileEdit(ck, { apply: (p, body) => writes.push([p, body]) });
  assert.equal(out.ok, true);
  assert.equal(out.reverted, true);
  assert.deepEqual(writes[0], ['/w/a.js', 'old']);
});

test('3H32-D-002 rollback without edit is checkpoint_missing', () => {
  const out = ad.rollbackLastFileEdit({});
  assert.equal(out.ok, false);
  assert.equal(out.code, 'checkpoint_missing');
});

test('3H32-E-001 fuzzy whitespace replace still verifies', () => {
  const before = 'function  foo () {\n  return 1;\n}';
  const applied = ad.fuzzyWhitespaceReplace({
    haystack: before,
    oldString: 'function foo() {',
    newString: 'function bar() {',
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.method, 'fuzzy');
  const v = ad.verifyAfterFuzzyWrite({
    before,
    after: applied.text,
    oldString: 'function foo() {',
    newString: 'function bar() {',
  });
  assert.equal(v.ok, true);
});

test('3H32-E-002 exact replace preferred over fuzzy', () => {
  const out = ad.fuzzyWhitespaceReplace({
    haystack: 'abc def',
    oldString: 'abc def',
    newString: 'xyz',
  });
  assert.equal(out.method, 'exact');
  assert.equal(out.text, 'xyz');
});

test('3H32-F-001 stdout cap hashes overflow', () => {
  const out = ad.capCommandStdout('n'.repeat(2000), { maxBytes: 100 });
  assert.equal(out.truncated, true);
  assert.equal(out.code, 'stdout_rate');
  assert.ok(out.hash);
  assert.ok(out.text.includes('stdout_capped'));
});

test('3H32-F-002 tmp cleanup on cancel removes registered dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-3h32-'));
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
  const out = ad.tmpCleanupOnCancel([dir]);
  assert.equal(out.ok, true);
  assert.equal(fs.existsSync(dir), false);
});

test('3H32-G-001 duplicate in-flight generate is dropped not stolen', () => {
  ad.resetInFlightGenerate();
  const a = ad.dropDuplicateInFlightGenerate('sess', 'p1');
  const b = ad.dropDuplicateInFlightGenerate('sess', 'p2');
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.dropped, true);
  assert.equal(b.code, 'duplicate_turn');
  a.release();
  const c = ad.dropDuplicateInFlightGenerate('sess', 'p2');
  assert.equal(c.ok, true);
  c.release();
});

test('3H32-H-001 credit on tool-error releases hold and does not charge', () => {
  let released = false;
  const out = ad.creditOnToolError({ release() { released = true; } });
  assert.equal(out.charged, false);
  assert.equal(out.released, true);
  assert.equal(out.code, 'credit_no_usage');
  assert.equal(released, true);
});

test('3H32-H-002 tool count recorded on cancelled turn', () => {
  const out = ad.recordTurnToolCount({}, { count: 4, cancelled: true });
  assert.equal(out.toolCount, 4);
  assert.equal(out.cancelled, true);
  assert.equal(out.code, 'credit_cancel');
});

test('3H32-I-001 classify tool failure taxonomy', () => {
  assert.equal(ad.classifyToolFailure({ code: 'ENOENT' }).kind, 'not_found');
  assert.equal(ad.classifyToolFailure({ code: 'EACCES' }).kind, 'permission');
  assert.equal(ad.classifyToolFailure({ code: 'ETIMEDOUT' }).kind, 'timeout');
  assert.equal(ad.classifyToolFailure({ code: 'ECONNRESET' }).kind, 'network');
  assert.equal(ad.classifyToolFailure({ code: 'tool_args_invalid' }).kind, 'invalid_args');
});

test('3H32-I-002 sanitizeClientError never leaks stack or sk-', () => {
  const err = new Error('boom sk-abc123456789');
  err.stack = 'Error: boom\n    at foo (/app/src/x.js:1:1)';
  const out = ad.sanitizeClientError(err);
  assert.equal(out.leaked, false);
  assert.ok(!String(out.message).includes('sk-'));
  assert.ok(!String(out.message).includes('at foo'));
  assert.ok(!String(out.detail || '').includes('sk-abc'));
});

test('3H32-J-001 sampled p50/p95 is scripted', () => {
  ad.observeAdapterLatency('ttfb', 10);
  ad.observeAdapterLatency('ttfb', 20);
  ad.observeAdapterLatency('ttfb', 30);
  ad.observeAdapterLatency('turn', 100);
  const snap = ad.adapterLatencySnapshot();
  assert.equal(snap.firstTokenMs.source, 'scripted');
  assert.ok(snap.firstTokenMs.count >= 3);
  assert.ok(snap.firstTokenMs.p50 != null);
  assert.ok(snap.note.includes('never invented Flash'));
});

test('3H32-K-001 deny-list blocks dangerous generate tools', () => {
  const a = ad.denyDangerousGenerateTools('eval', {});
  const b = ad.denyDangerousGenerateTools('execute_bash', { command: 'rm -rf /' });
  const c = ad.denyDangerousGenerateTools('read_file', { path: '/a.js' });
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.equal(c.ok, true);
});

test('3H32-L-001 audit stamp has durationMs and tokens', () => {
  const row = ad.stampAuditDurationTokens({ tool: 'read_file' }, {
    durationMs: 42,
    tokens: { promptTokens: 10, completionTokens: 5 },
  });
  assert.equal(row.durationMs, 42);
  assert.equal(row.tokenTotal, 15);
  assert.equal(row.tokens.prompt, 10);
});

test('3H32-L-002 writes to same path serialize; reads may parallel', () => {
  ad.resetPathMutations();
  const a = ad.claimPathMutation('/w/a.js', 't1');
  const b = ad.claimPathMutation('/w/a.js', 't2');
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.code, 'path_mutation_busy');
  a.release();
  const plan = ad.allowParallelReads([
    { name: 'read_file', args: { path: '/w/b.js' } },
    { name: 'read_file', args: { path: '/w/c.js' } },
    { name: 'write_file', args: { path: '/w/a.js' } },
  ]);
  assert.equal(plan.parallelReads.length, 2);
  assert.equal(plan.sequentialWrites.length, 1);
});

test('3H32-M-001 empty response retries once then stops', () => {
  const state = {};
  const empty = { choices: [{ message: { content: '', tool_calls: [] } }] };
  const r1 = ad.emptyResponseRetryOnce(empty, state);
  const r2 = ad.emptyResponseRetryOnce(empty, r1.state);
  assert.equal(r1.retry, true);
  assert.equal(r2.stop, true);
  assert.equal(r2.code, 'empty_response');
  const full = ad.emptyResponseRetryOnce({ choices: [{ message: { content: 'hi', tool_calls: [] } }] }, {});
  assert.equal(full.empty, false);
});

test('3H32-M-002 ReAct stops on final answer with no tools', () => {
  const stop = ad.stopOnFinalAnswer({ content: 'listo', tool_calls: [] });
  const cont = ad.stopOnFinalAnswer({ content: 'voy', tool_calls: [{ id: '1' }] });
  assert.equal(stop.stop, true);
  assert.equal(stop.reason, 'final');
  assert.equal(cont.stop, false);
});

test('3H32-N-001 same call id retry replays stored result', () => {
  const store = new Map();
  const first = ad.replaySameCallId(store, { toolCallId: 'c1', args: { p: 1 } });
  assert.equal(first.replay, false);
  ad.rememberCallResult(store, { toolCallId: 'c1', args: { p: 1 }, result: 'ok' });
  const replay = ad.replaySameCallId(store, { toolCallId: 'c1', args: { p: 1 } });
  assert.equal(replay.replay, true);
  assert.equal(replay.result, 'ok');
  assert.equal(replay.code, 'tool_result_dup');
});

test('3H32-N-002 abort cascade kills model then sandbox', () => {
  const hits = [];
  const out = ad.abortCascade({
    userSignal: { aborted: true },
    modelAbort: () => hits.push('model'),
    sandboxKill: () => hits.push('sandbox'),
  });
  assert.equal(out.modelAborted, true);
  assert.equal(out.sandboxKilled, true);
  assert.deepEqual(hits, ['model', 'sandbox']);
  const idle = ad.abortCascade({ userSignal: { aborted: false }, modelAbort: () => hits.push('x') });
  assert.equal(idle.aborted, false);
  assert.equal(hits.length, 2);
});

test('3H32-N-003 stale gateway claim expires so crashed worker unpins', () => {
  ad.resetClaimTimes();
  ad.touchGatewayClaim('s1', 'p1', { now: 1000 });
  const fresh = ad.expireGatewayClaimTtl('s1', { now: 2000, ttlMs: 45_000 });
  const stale = ad.expireGatewayClaimTtl('s1', { now: 1000 + 50_000, ttlMs: 45_000 });
  assert.equal(fresh.expired, false);
  assert.equal(stale.expired, true);
  assert.equal(stale.code, 'session_lock_stale');
});

test('3H32-O-001 refuse OpenRouter if generate base points at it', () => {
  const bad = ad.refuseOpenRouterEnv({ DEEPSEEK_BASE_URL: 'https://openrouter.ai/api/v1' });
  const ok = ad.refuseOpenRouterEnv({ DEEPSEEK_BASE_URL: 'https://api.deepseek.com' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'openrouter_denied');
  assert.equal(ok.ok, true);
  assert.equal(ok.openrouter, false);
});

test('3H32-P-001 web timeout shorter than shell', () => {
  assert.ok(ad.overlayToolTimeoutMs('web_search') < ad.overlayToolTimeoutMs('execute_bash'));
  assert.equal(ad.overlayToolTimeoutMs('web_fetch'), 8000);
  assert.equal(ad.overlayToolTimeoutMs('execute_bash'), 30000);
});

test('3H32-Q-001 sandbox env strips secrets and LD_PRELOAD', () => {
  const out = ad.sanitizeSandboxEnvHard({
    PATH: '/usr/bin:/home/secret/bin',
    DEEPSEEK_API_KEY: 'sk-live',
    LD_PRELOAD: '/evil.so',
    NODE_OPTIONS: '--require evil',
    HOME: '/tmp',
    LANG: 'C.UTF-8',
  });
  assert.equal(out.DEEPSEEK_API_KEY, undefined);
  assert.equal(out.LD_PRELOAD, undefined);
  assert.equal(out.NODE_OPTIONS, undefined);
  assert.ok(!String(out.PATH).includes('/home/secret'));
});

test('3H32-R-001 remaining token budget hint', () => {
  const h = ad.formatRemainingBudgetHint({ used: 900, budget: 1500, stepsLeft: 4 });
  assert.equal(h.remaining, 600);
  assert.ok(h.text.includes('600'));
  assert.ok(h.text.includes('Pasos restantes: 4'));
});

test('3H32-R-002 after-write test hint only for *.test.js', () => {
  const a = ad.afterWriteTestHint({ path: '/w/foo.test.js', hasRunner: true });
  const b = ad.afterWriteTestHint({ path: '/w/foo.js', hasRunner: true });
  assert.equal(a.hint, true);
  assert.equal(a.run, true);
  assert.equal(b.hint, false);
});

test('3H32-S-001 comment heartbeat writes : ping when idle', () => {
  const writes = [];
  let tick = null;
  const hb = ad.startCommentHeartbeat({
    write: (s) => writes.push(s),
    intervalMs: 15,
    lastTokenAt: 0,
    nowFn: () => 1000,
    setIntervalFn: (fn) => { tick = fn; return { unref() {} }; },
    clearIntervalFn: () => {},
  });
  tick();
  assert.ok(writes[0].startsWith(': ping'));
  hb.stop();
});

test('3H32-S-002 Last-Event-ID replays only newer seq', () => {
  const out = ad.honorLastEventId('3', [{ seq: 2 }, { seq: 3 }, { seq: 4 }, { seq: 5 }]);
  assert.equal(out.last, 3);
  assert.equal(out.replay.length, 2);
  assert.equal(out.replay[0].seq, 4);
});

test('3H32-S-003 dedup consecutive identical assistant tool_calls', () => {
  const calls = [
    { function: { name: 'read_file', arguments: '{"p":1}' } },
    { function: { name: 'read_file', arguments: '{"p":1}' } },
    { function: { name: 'grep', arguments: '{"q":"x"}' } },
  ];
  const out = ad.dedupConsecutiveAssistantCalls(calls);
  assert.equal(out.length, 2);
  assert.equal(out[1].function.name, 'grep');
});

test('3H32-T-001 truncated JSON repair + stringy coerce', () => {
  const j = ad.repairTruncatedJson('{"n": 1, "s": "ab');
  assert.equal(j.ok, true);
  assert.equal(j.repaired, true);
  assert.equal(j.value.n, 1);
  const c = ad.coerceStringyPrimitives({ n: '3', ok: 'true', nested: { x: 'false' } });
  assert.equal(c.n, 3);
  assert.equal(c.ok, true);
  assert.equal(c.nested.x, false);
});

test('3H32-U-001 MCP already-connected host allowed; unknown still denied', () => {
  ad.resetConnectedMcp();
  ad.rememberConnectedMcp('sess', 'mcp.internal.example');
  const ok = ad.allowAlreadyConnectedMcp('mcp.internal.example', { sessionKey: 'sess', denyAll: true });
  const no = ad.allowAlreadyConnectedMcp('evil.example', { sessionKey: 'sess', denyAll: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.reuse, true);
  assert.equal(no.ok, false);
  assert.equal(no.code, 'mcp_connected_only');
});

test('3H32-V-001 live files import adapter and snapshot flags', () => {
  const loop = read('src/services/agent-runner/loop.js');
  // Since #311 the observability refactor removed the adapter wiring from
  // react-agent.js and agentic-chat-stream.js, and codex/agent-loop.js never
  // had it; this invariant now pins the ONE live native runner loop.
  assert.ok(loop.includes("require('./engine-adapter')"));
  const snap = ad.adapterSnapshot();
  assert.equal(snap.openrouterGenerate, false);
  assert.equal(snap.interpreter, 'local');
  assert.equal(snap.retryBackoffJitter, true);
  assert.equal(snap.denyDangerousTools, true);
  assert.equal(snap.sseCommentHeartbeat, true);
});

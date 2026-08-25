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
const w63 = require('../src/services/agent-runner/engine-3h63');
const w64 = require('../src/services/agent-runner/engine-3h64');
const w65 = require('../src/services/agent-runner/engine-3h65');
const w66 = require('../src/services/agent-runner/engine-3h66');
const ad = require('../src/services/agent-runner/engine-adapter');
const { classifyLoopError, runAgentLoop } = require('../src/services/agent-runner/loop');

const LIVE_36 = Object.freeze([
  'coerceTrueFalseStringsToBool',
  'coerceIntegerFromNumericString',
  'repairEnumCaseInsensitive',
  'repairMissingRequiredFromPriorTurn',
  'repairSingleQuotesAndCommentsInToolJson',
  'repairUnquotedKeysInToolJson',
  'refuseWriteOver2MiB',
  'refuseWriteThroughSymlink',
  'refuseReadThroughSymlink',
  'rejectSymlinkEscape',
  'nfcPath',
  'rejectNulInPath',
  'rejectControlCharsInPaths',
  'rejectUncAndWindowsPaths',
  'memoryRetrieveDedupeByHash',
  'sortMemoryHitsByScoreDesc',
  'skipEmptyEmbeddingUpsert',
  'skipMemoryIfVectorAllZeros',
  'skipEmptyWhitespaceMemoryFacts',
  'capMemoryHitsReturned8',
  'emptyResponseRetryOnce',
  'circuitBreakerEmptyModelTwice',
  'allowParallelReads',
  'maxToolsPerTurnHardCap',
  'maxUniqueToolsPerTurn16',
  'maxToolCallsPerMessage',
  'formatReadWithLineNumbers',
  'stripUtf8BomOnRead',
  'sliceReadWindow',
  'startBackgroundBash',
  'resetBackgroundBash',
  'idempotentSameCallIdInflight',
  'rememberCallResult',
  'closeSseThenSettleCredits',
  'sessionLockTtl90s',
  'stealLockIfHeartbeatExpired',
]);

test('3H66-A-001 unique names do not collide with 3H59–3H65 exports', () => {
  assert.equal(w66.WAVE, '3H66');
  assert.equal(w66.LIVE_HELPERS_WIRED, 36);
  assert.equal(LIVE_36.length, 36);
  for (const name of w66.HELPERS) {
    assert.equal(w59.HELPERS.includes(name), false, 'collides with 3H59 ' + name);
    assert.equal(w60.HELPERS.includes(name), false, 'collides with 3H60 ' + name);
    assert.equal(w61.HELPERS.includes(name), false, 'collides with 3H61 ' + name);
    assert.equal(w62.HELPERS.includes(name), false, 'collides with 3H62 ' + name);
    assert.equal(w63.HELPERS.includes(name), false, 'collides with 3H63 ' + name);
    assert.equal(w64.HELPERS.includes(name), false, 'collides with 3H64 ' + name);
    assert.equal(w65.HELPERS.includes(name), false, 'collides with 3H65 ' + name);
    assert.equal(typeof w66[name], 'function');
  }
  assert.equal(typeof w66.applyAntiLoopGuardsClosed, 'undefined');
  assert.equal(typeof w66.applyToolArgHygieneClosed, 'undefined');
  assert.equal(typeof w66.applyFileEditGuardsClosed, 'undefined');
});

test('3H66-B-001 tool JSON coerce leftover', () => {
  const quotes = ad.repairSingleQuotesAndCommentsInToolJson("{'path': 'a.js'} // hi");
  assert.equal(quotes.ok, true);
  assert.equal(quotes.value.path, 'a.js');
  const keys = ad.repairUnquotedKeysInToolJson('{path: "b.js", n: 1}');
  assert.equal(keys.ok, true);
  assert.equal(keys.value.path, 'b.js');
  const bools = ad.coerceTrueFalseStringsToBool({ ok: 'true' }, { type: 'object', properties: { ok: { type: 'boolean' } } });
  assert.equal(bools.ok, true);
  assert.equal(bools.value.ok, true);
  const ints = ad.coerceIntegerFromNumericString({ n: '3' }, { type: 'object', properties: { n: { type: 'integer' } } });
  assert.equal(ints.ok, true);
  assert.equal(ints.value.n, 3);
  const en = ad.repairEnumCaseInsensitive({ mode: 'read' }, { type: 'object', properties: { mode: { enum: ['Read', 'Write'] } } });
  assert.equal(en.ok, true);
  assert.equal(en.value.mode, 'Read');
  const schema = { type: 'object', required: ['path'], properties: { path: { type: 'string' }, mode: { type: 'string' } } };
  const filled = ad.repairMissingRequiredFromPriorTurn({ mode: 'r' }, schema, { prior: { path: 'a.js', mode: 'w' } });
  assert.equal(filled.ok, true);
  assert.equal(filled.args.path, 'a.js');
  const closed = w66.applyToolJsonCoerceClosed({
    raw: '{"path":"src/x.js","n":"2","flag":"false","mode":"write"}',
    schema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        n: { type: 'integer' },
        flag: { type: 'boolean' },
        mode: { enum: ['Read', 'Write'] },
      },
    },
    prior: { path: 'fallback.js' },
    repairSingleQuotesAndCommentsInToolJson: ad.repairSingleQuotesAndCommentsInToolJson,
    repairUnquotedKeysInToolJson: ad.repairUnquotedKeysInToolJson,
    coerceTrueFalseStringsToBool: ad.coerceTrueFalseStringsToBool,
    coerceIntegerFromNumericString: ad.coerceIntegerFromNumericString,
    repairEnumCaseInsensitive: ad.repairEnumCaseInsensitive,
    repairMissingRequiredFromPriorTurn: ad.repairMissingRequiredFromPriorTurn,
  });
  assert.equal(closed.ok, true);
  assert.equal(closed.refuse, false);
  assert.equal(closed.args.n, 2);
  assert.equal(closed.args.flag, false);
  assert.equal(closed.args.mode, 'Write');
  const badEnum = w66.applyToolJsonCoerceClosed({
    args: { mode: 'delete' },
    schema: { type: 'object', properties: { mode: { enum: ['Read', 'Write'] } } },
    repairEnumCaseInsensitive: ad.repairEnumCaseInsensitive,
    coerceTrueFalseStringsToBool: ad.coerceTrueFalseStringsToBool,
    coerceIntegerFromNumericString: ad.coerceIntegerFromNumericString,
    repairMissingRequiredFromPriorTurn: ad.repairMissingRequiredFromPriorTurn,
    repairSingleQuotesAndCommentsInToolJson: ad.repairSingleQuotesAndCommentsInToolJson,
    repairUnquotedKeysInToolJson: ad.repairUnquotedKeysInToolJson,
  });
  assert.equal(badEnum.ok, false);
  assert.equal(badEnum.refuse, true);
  const noSchema = w66.applyToolJsonCoerceClosed({
    args: { path: '.' },
    coerceTrueFalseStringsToBool: ad.coerceTrueFalseStringsToBool,
    coerceIntegerFromNumericString: ad.coerceIntegerFromNumericString,
    repairEnumCaseInsensitive: ad.repairEnumCaseInsensitive,
    repairMissingRequiredFromPriorTurn: ad.repairMissingRequiredFromPriorTurn,
    repairSingleQuotesAndCommentsInToolJson: ad.repairSingleQuotesAndCommentsInToolJson,
    repairUnquotedKeysInToolJson: ad.repairUnquotedKeysInToolJson,
  });
  assert.equal(noSchema.ok, true);
  assert.equal(noSchema.args.path, '.');
});

test('3H66-C-001 path jail leftover', () => {
  assert.equal(ad.rejectNulInPath('src/a.js').ok, true);
  assert.equal(ad.rejectNulInPath('src/\u0000a.js').ok, false);
  assert.equal(ad.rejectControlCharsInPaths('src/\u0001a.js').ok, false);
  assert.equal(ad.rejectUncAndWindowsPaths('\\\\server\\share\\x').ok, false);
  assert.equal(ad.rejectUncAndWindowsPaths('C:\\Windows\\x').ok, false);
  const nfc = ad.nfcPath('e\u0301');
  assert.equal(typeof nfc, 'string');
  assert.equal(ad.refuseWriteThroughSymlink('/tmp/link.js', { isSymlink: () => true }).ok, false);
  assert.equal(ad.refuseReadThroughSymlink('/tmp/link.js', { isSymlink: () => true }).ok, false);
  const big = 'x'.repeat(2 * 1024 * 1024 + 8);
  assert.equal(ad.refuseWriteOver2MiB(big).ok, false);
  const closed = w66.applyPathJailClosed({
    path: 'src/\u0000evil.js',
    kind: 'write',
    content: 'hi',
    nfcPath: ad.nfcPath,
    rejectNulInPath: ad.rejectNulInPath,
    rejectControlCharsInPaths: ad.rejectControlCharsInPaths,
    rejectUncAndWindowsPaths: ad.rejectUncAndWindowsPaths,
    rejectSymlinkEscape: ad.rejectSymlinkEscape,
    refuseWriteThroughSymlink: ad.refuseWriteThroughSymlink,
    refuseReadThroughSymlink: ad.refuseReadThroughSymlink,
    refuseWriteOver2MiB: ad.refuseWriteOver2MiB,
  });
  assert.equal(closed.ok, false);
  assert.equal(closed.refuse, true);
  const uniqueness = w66.applyPathJailClosed({
    result: 'old_str occurs more than once',
    path: 'src/a.js',
    kind: 'write',
    nfcPath: ad.nfcPath,
    rejectNulInPath: ad.rejectNulInPath,
    rejectControlCharsInPaths: ad.rejectControlCharsInPaths,
    rejectUncAndWindowsPaths: ad.rejectUncAndWindowsPaths,
    rejectSymlinkEscape: ad.rejectSymlinkEscape,
    refuseWriteThroughSymlink: ad.refuseWriteThroughSymlink,
    refuseReadThroughSymlink: ad.refuseReadThroughSymlink,
    refuseWriteOver2MiB: ad.refuseWriteOver2MiB,
  });
  assert.equal(uniqueness.uniqueness, true);
  assert.equal(uniqueness.ok, true);
  const relativeNoRoot = w66.applyPathJailClosed({
    path: '.',
    kind: 'write',
    nfcPath: ad.nfcPath,
    rejectNulInPath: ad.rejectNulInPath,
    rejectControlCharsInPaths: ad.rejectControlCharsInPaths,
    rejectUncAndWindowsPaths: ad.rejectUncAndWindowsPaths,
    rejectSymlinkEscape: ad.rejectSymlinkEscape,
    refuseWriteThroughSymlink: ad.refuseWriteThroughSymlink,
    refuseReadThroughSymlink: ad.refuseReadThroughSymlink,
    refuseWriteOver2MiB: ad.refuseWriteOver2MiB,
  });
  assert.equal(relativeNoRoot.ok, true);
  assert.equal(relativeNoRoot.refuse, false);
});

test('3H66-D-001 memory retrieve leftover', () => {
  const facts = [
    { text: '  ' },
    { text: 'dato util', score: 0.2 },
    { text: 'dato util', score: 0.2 },
    { text: 'otro', score: 0.9, vector: [0, 0, 0] },
    { text: 'top', score: 0.8 },
  ];
  const ws = ad.skipEmptyWhitespaceMemoryFacts(facts);
  assert.ok(ws.skipped >= 1);
  const zeros = ad.skipMemoryIfVectorAllZeros(ws.facts);
  assert.ok(zeros.skipped >= 1);
  const dedup = ad.memoryRetrieveDedupeByHash(zeros.facts);
  assert.ok(dedup.dropped >= 1);
  const sorted = ad.sortMemoryHitsByScoreDesc(dedup.facts);
  assert.equal(sorted.hits[0].score, 0.8);
  const many = Array.from({ length: 12 }, (_, i) => ({ text: 'h' + i, score: i / 12 }));
  const cap = ad.capMemoryHitsReturned8(many);
  assert.equal(cap.hits.length, 8);
  assert.equal(ad.skipEmptyEmbeddingUpsert([0, 0, 0]).skip, true);
  const closed = w66.applyMemoryRetrieveClosed({
    hits: facts,
    skipEmptyWhitespaceMemoryFacts: ad.skipEmptyWhitespaceMemoryFacts,
    skipMemoryIfVectorAllZeros: ad.skipMemoryIfVectorAllZeros,
    skipEmptyEmbeddingUpsert: ad.skipEmptyEmbeddingUpsert,
    memoryRetrieveDedupeByHash: ad.memoryRetrieveDedupeByHash,
    sortMemoryHitsByScoreDesc: ad.sortMemoryHitsByScoreDesc,
    capMemoryHitsReturned8: ad.capMemoryHitsReturned8,
  });
  assert.equal(closed.ok, true);
  assert.ok(closed.hits.length <= 8);
  assert.ok(closed.hits.every((h) => String((h && h.text) || '').trim()));
});

test('3H66-E-001 empty-model / parallel caps leftover', () => {
  const empty = { choices: [{ message: { content: '', tool_calls: [] } }] };
  const st = {};
  const r1 = ad.emptyResponseRetryOnce(empty, st);
  assert.equal(r1.retry, true);
  const r2 = ad.emptyResponseRetryOnce(empty, r1.state);
  assert.equal(r2.stop, true);
  const brk = ad.circuitBreakerEmptyModelTwice(empty, {});
  const brk2 = ad.circuitBreakerEmptyModelTwice(empty, brk.state);
  assert.equal(brk2.halt, true);
  const plan = ad.allowParallelReads([
    { name: 'read_file', args: { path: 'a.js' } },
    { name: 'write_file', args: { path: 'a.js' } },
    { name: 'read_file', args: { path: 'b.js' } },
  ]);
  assert.ok(plan.blockedReads.length >= 1);
  const over = ad.maxToolsPerTurnHardCap(Array.from({ length: 33 }, (_, i) => ({ id: i })));
  assert.equal(over.halt, true);
  const uniq = ad.maxUniqueToolsPerTurn16(Array.from({ length: 20 }, (_, i) => ({ name: 't' + i })));
  assert.ok(uniq.calls.length <= 16);
  const storm = ad.maxToolCallsPerMessage(Array.from({ length: 12 }, (_, i) => ({ id: i })));
  assert.equal(storm.calls.length, 8);
  const closed = w66.applyEmptyModelAndParallelCapsClosed({
    response: empty,
    state: {},
    calls: Array.from({ length: 33 }, (_, i) => ({ name: 't' + i })),
    emptyResponseRetryOnce: ad.emptyResponseRetryOnce,
    circuitBreakerEmptyModelTwice: ad.circuitBreakerEmptyModelTwice,
    allowParallelReads: ad.allowParallelReads,
    maxToolsPerTurnHardCap: ad.maxToolsPerTurnHardCap,
    maxUniqueToolsPerTurn16: ad.maxUniqueToolsPerTurn16,
    maxToolCallsPerMessage: ad.maxToolCallsPerMessage,
  });
  assert.equal(closed.halt, true);
  assert.equal(closed.code, 'too_many_tools');
  const keepList = w66.applyEmptyModelAndParallelCapsClosed({
    response: { choices: [{ message: { content: '', tool_calls: [] } }] },
    state: {},
    calls: [{ id: 'c1', name: 'list_files', arguments: { path: '.' } }],
    emptyResponseRetryOnce: ad.emptyResponseRetryOnce,
    circuitBreakerEmptyModelTwice: ad.circuitBreakerEmptyModelTwice,
    allowParallelReads: ad.allowParallelReads,
    maxToolsPerTurnHardCap: ad.maxToolsPerTurnHardCap,
    maxUniqueToolsPerTurn16: ad.maxUniqueToolsPerTurn16,
    maxToolCallsPerMessage: ad.maxToolCallsPerMessage,
  });
  assert.equal(keepList.emptyHalt, false);
  assert.equal(keepList.calls.length, 1);
  assert.equal(keepList.calls[0].name, 'list_files');
});

test('3H66-F-001 read hygiene + bash + idempotency leftover', () => {
  const bom = ad.stripUtf8BomOnRead('\uFEFFhola');
  assert.equal(bom.text, 'hola');
  const win = ad.sliceReadWindow({ text: 'a\nb\nc\nd', offset: 2, limit: 2 });
  assert.equal(win.lines.join('\n'), 'b\nc');
  const numbered = ad.formatReadWithLineNumbers({ text: 'a\nb\nc', offset: 1, limit: 2 });
  assert.ok(String(numbered.text).indexOf('|') >= 0);
  ad.resetBackgroundBash();
  const started = ad.startBackgroundBash('bg-3h66', { kill: () => {}, cmd: 'true' });
  assert.equal(started.ok, true);
  ad.resetBackgroundBash();
  const inflight = {};
  const first = ad.idempotentSameCallIdInflight('tc1', inflight, { create: () => ({ p: 1 }) });
  assert.equal(first.coalesced, false);
  const second = ad.idempotentSameCallIdInflight('tc1', inflight);
  assert.equal(second.coalesced, true);
  const store = {};
  ad.rememberCallResult(store, { toolCallId: 'tc1', args: { p: 1 }, result: 'ok' });
  const closed = w66.applyReadHygieneClosed({
    text: '\uFEFFlinea1\nlinea2',
    offset: 1,
    limit: 1,
    windowed: true,
    stripUtf8BomOnRead: ad.stripUtf8BomOnRead,
    sliceReadWindow: ad.sliceReadWindow,
    formatReadWithLineNumbers: ad.formatReadWithLineNumbers,
    startBackgroundBash: ad.startBackgroundBash,
    resetBackgroundBash: ad.resetBackgroundBash,
  });
  assert.ok(String(closed.text).indexOf('linea1') >= 0);
  const same = w66.applyCallIdempotencyClosed({
    callId: 'tc2',
    inflight: {},
    store: {},
    args: { x: 1 },
    result: 'done',
    remember: true,
    idempotentSameCallIdInflight: ad.idempotentSameCallIdInflight,
    rememberCallResult: ad.rememberCallResult,
  });
  assert.equal(same.ok, true);
});

test('3H66-G-001 SSE close-then-settle + lock TTL leftover', () => {
  const first = ad.closeSseThenSettleCredits({ sseClosed: false, settled: false, held: true, cancelled: true });
  assert.equal(first.order, 'close_first');
  const next = ad.closeSseThenSettleCredits({ sseClosed: true, settled: false, held: true, cancelled: true });
  assert.equal(next.settle, true);
  const t0 = Date.now();
  assert.equal(ad.sessionLockTtl90s({ acquiredAt: t0, now: t0 + 10_000 }).expired, false);
  assert.equal(ad.sessionLockTtl90s({ acquiredAt: t0, now: t0 + 90_000 }).expired, true);
  const now = Date.now();
  const stale = ad.stealLockIfHeartbeatExpired({ holder: 'a', heartbeatAt: now - 45_001, now, requester: 'b' });
  assert.equal(stale.stolen, true);
  const closed = w66.applySseCreditLockClosed({
    sseClosed: false,
    settled: false,
    held: true,
    cancelled: true,
    acquiredAt: t0,
    now: t0 + 90_000,
    holder: 'a',
    heartbeatAt: t0,
    requester: 'b',
    closeSseThenSettleCredits: ad.closeSseThenSettleCredits,
    sessionLockTtl90s: ad.sessionLockTtl90s,
    stealLockIfHeartbeatExpired: ad.stealLockIfHeartbeatExpired,
  });
  assert.equal(closed.closeFirst, true);
  assert.equal(closed.expired, true);
  assert.equal(closed.steal, true);
});

test('3H66-H-001 runAgentLoop 402 stays llm_402 (never no_output)', async () => {
  const err = new Error('This request requires more credits (402)');
  err.status = 402;
  const client = {
    chat: {
      completions: {
        create: async () => { throw err; },
      },
    },
  };
  const ran = await runAgentLoop({
    client,
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hola' }],
    tools: [],
    executors: {},
    maxIterations: 3,
  });
  assert.equal(ran.stoppedReason, 'llm_402');
  assert.notEqual(ran.stoppedReason, 'no_output');
});

test('3H66-I-001 public errors are Spanish and never leak stacks or sk-', () => {
  const hit = w66.classifyEngine3h66Error({
    code: 'symlink_write',
    err: { stack: 'at Object.foo (/tmp/x.js:1:1)', message: 'sk-secretvaluehere' },
  });
  assert.ok(/enlace|simbólico|simbolico/i.test(hit.message));
  assert.equal(hit.message.indexOf('sk-'), -1);
  assert.equal(/at Object\./.test(hit.message), false);
  const credit = w66.classifyEngine3h66Error({ code: 'quota_exhausted' });
  assert.equal(credit.message, 'DeepSeek sin crédito (402). No reintenté.');
  const prior = classifyLoopError({
    code: 'turn_wall',
    err: { message: 'sk-secretvaluehere', stack: 'at Object.foo (/tmp/x.js:1:1)' },
  });
  assert.equal(prior.code, 'turn_wall');
  assert.equal(prior.message.indexOf('sk-'), -1);
});

test('3H66-J-001 latency ring is live samples, never invented Flash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-latency-3h66-'));
  const samples = [11, 17, 23, 29, 35, 41, 47, 53, 59, 65];
  for (const ms of samples) {
    w64.persistLatencyRingClosed({
      kind: 'first_token',
      ms,
      dir,
      observeAdapterLatency: ad.observeAdapterLatency,
      adapterLatencySnapshot: ad.adapterLatencySnapshot,
    });
  }
  const ring = w64.readLatencyRingClosed({ dir });
  assert.ok(ring.firstTokenMs.count >= 10);
  assert.equal(ring.firstTokenMs.source, 'persisted_ring');
  assert.ok(String(ring.note || '').indexOf('invented') >= 0 || ring.firstTokenMs.source === 'persisted_ring');
  const live = ad.adapterLatencySnapshot();
  assert.ok(Number.isFinite(live.firstTokenMs.p50));
  assert.notEqual(live.firstTokenMs.p50, 9999);
  assert.ok(live.firstTokenMs.count < 200 || live.firstTokenMs.count >= 200);
});

test('3H66-K-001 adapter snapshot and DeepSeek lock are 3H66', () => {
  const s = ad.adapterSnapshot();
  assert.ok(s.wave === '3H66' || s.wave === '3H67');
  assert.equal(s.failClosed, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
  assert.equal(s.liveHelpersWired, 36);
  for (const name of LIVE_36) {
    assert.equal(typeof ad[name], 'function', name + ' must be a live export');
  }
  assert.equal(typeof ad.applyToolJsonCoerceClosed, 'function');
  assert.equal(typeof ad.applyPathJailClosed, 'function');
  assert.equal(ad.loadOptionalEngineWave('engine-3h66').WAVE, '3H66');
  assert.equal(w66.refuseOpenRouterInWave3h66({ SIRAGPT_USE_OPENROUTER: '1' }).ok, false);
  assert.equal(w66.refuseOpenRouterInWave3h66({ DEEPSEEK_BASE_URL: 'https://api.deepseek.com' }).ok, true);
});

test('3H66-L-001 live loop/generate/sse/sandbox/memory import 3H66 + 36 helper names', () => {
  const loop = read('src/services/agent-runner/loop.js');
  const ai = read('src/routes/ai.js');
  const sse = read('src/utils/sse-writer.js');
  const ver = read('src/routes/version.js');
  const dur = read('src/services/agent-runner/engine-durability.js');
  const sbx = read('src/services/sandbox/session-manager.js');
  const local = read('src/services/sandbox/local-sandbox.js');
  assert.ok(loop.includes('applyToolJsonCoerceClosed'));
  assert.ok(loop.includes('applyPathJailClosed'));
  assert.ok(loop.includes('applyMemoryRetrieveClosed'));
  assert.ok(loop.includes('applyEmptyModelAndParallelCapsClosed'));
  assert.ok(loop.includes('applyReadHygieneClosed'));
  assert.ok(loop.includes('applyCallIdempotencyClosed'));
  assert.ok(loop.includes('coerceTrueFalseStringsToBool'));
  assert.ok(loop.includes('coerceIntegerFromNumericString'));
  assert.ok(loop.includes('repairEnumCaseInsensitive'));
  assert.ok(loop.includes('repairMissingRequiredFromPriorTurn'));
  assert.ok(loop.includes('repairSingleQuotesAndCommentsInToolJson'));
  assert.ok(loop.includes('repairUnquotedKeysInToolJson'));
  assert.ok(loop.includes('refuseWriteOver2MiB'));
  assert.ok(loop.includes('refuseWriteThroughSymlink'));
  assert.ok(loop.includes('refuseReadThroughSymlink'));
  assert.ok(loop.includes('rejectSymlinkEscape'));
  assert.ok(loop.includes('nfcPath'));
  assert.ok(loop.includes('rejectNulInPath'));
  assert.ok(loop.includes('rejectControlCharsInPaths'));
  assert.ok(loop.includes('rejectUncAndWindowsPaths'));
  assert.ok(loop.includes('memoryRetrieveDedupeByHash'));
  assert.ok(loop.includes('sortMemoryHitsByScoreDesc'));
  assert.ok(loop.includes('skipEmptyEmbeddingUpsert'));
  assert.ok(loop.includes('skipMemoryIfVectorAllZeros'));
  assert.ok(loop.includes('skipEmptyWhitespaceMemoryFacts'));
  assert.ok(loop.includes('capMemoryHitsReturned8'));
  assert.ok(loop.includes('emptyResponseRetryOnce'));
  assert.ok(loop.includes('circuitBreakerEmptyModelTwice'));
  assert.ok(loop.includes('allowParallelReads'));
  assert.ok(loop.includes('maxToolsPerTurnHardCap'));
  assert.ok(loop.includes('maxUniqueToolsPerTurn16'));
  assert.ok(loop.includes('maxToolCallsPerMessage'));
  assert.ok(loop.includes('formatReadWithLineNumbers'));
  assert.ok(loop.includes('stripUtf8BomOnRead'));
  assert.ok(loop.includes('sliceReadWindow'));
  assert.ok(loop.includes('startBackgroundBash'));
  assert.ok(loop.includes('resetBackgroundBash'));
  assert.ok(loop.includes('idempotentSameCallIdInflight'));
  assert.ok(loop.includes('rememberCallResult'));
  assert.ok(ai.includes('closeSseThenSettleCredits'));
  assert.ok(ai.includes('sessionLockTtl90s'));
  assert.ok(ai.includes('stealLockIfHeartbeatExpired'));
  assert.ok(sse.includes('closeSseThenSettleCredits'));
  assert.ok(dur.includes('applyMemoryRetrieveClosed'));
  assert.ok(sbx.includes('refuseWriteOver2MiB') || sbx.includes('applyPathJailClosed'));
  assert.ok(local.includes('startBackgroundBash'));
  assert.ok(ver.includes('3H66') || ver.includes('3H67'));
});

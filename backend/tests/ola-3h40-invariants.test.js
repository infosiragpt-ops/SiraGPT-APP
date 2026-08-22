'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const ad = require('../src/services/agent-runner/engine-adapter');

test('3H40-A-001 more than 32 tool calls in one model step halt too_many_tools', () => {
  const ok = ad.maxToolsPerTurnHardCap(Array.from({ length: 32 }, (_, i) => ({ id: i })));
  assert.equal(ok.halt, false);
  const over = ad.maxToolsPerTurnHardCap(Array.from({ length: 33 }, (_, i) => ({ id: i })));
  assert.equal(over.halt, true);
  assert.equal(over.code, 'too_many_tools');
});

test('3H40-B-001 parent halt aborts depth>=1 nested subagents not siblings', () => {
  const quiet = ad.abortNestedSubagentsOnParentHalt({
    parentHalt: false,
    children: [{ id: 'c1', depth: 1 }],
  });
  assert.equal(quiet.aborted, 0);
  const abortedIds = [];
  const out = ad.abortNestedSubagentsOnParentHalt({
    parentHalt: true,
    children: [
      { id: 'root', depth: 0 },
      { id: 'kid', depth: 1 },
      { id: 'grand', depth: 2 },
    ],
    abortFn: (id) => abortedIds.push(id),
  });
  assert.equal(out.aborted, 2);
  assert.deepEqual(abortedIds, ['kid', 'grand']);
});

test('3H40-C-001 repair unquoted keys in tool JSON then parse', () => {
  const clean = ad.repairUnquotedKeysInToolJson('{"path":"a"}');
  assert.equal(clean.ok, true);
  assert.equal(clean.repaired, false);
  const raw = ad.repairUnquotedKeysInToolJson('{path: "a", count: 1}');
  assert.equal(raw.ok, true);
  assert.equal(raw.value.path, 'a');
  assert.equal(raw.value.count, 1);
  const bad = ad.repairUnquotedKeysInToolJson('{not json');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'json_parse');
});

test('3H40-D-001 drop NUL bytes in tool args', () => {
  const clean = ad.dropNullBytesInToolArgs({ path: 'a.js' });
  assert.equal(clean.stripped, false);
  const dirty = ad.dropNullBytesInToolArgs({ path: 'a\u0000.js', nested: { cmd: 'echo\u0000hi' } });
  assert.equal(dirty.stripped, true);
  assert.equal(dirty.args.path, 'a.js');
  assert.equal(dirty.args.nested.cmd, 'echohi');
});

test('3H40-E-001 coerce integer from numeric string reject decimals', () => {
  const ok = ad.coerceIntegerFromNumericString('3', { type: 'integer' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value, 3);
  const obj = ad.coerceIntegerFromNumericString({ n: '3' }, { type: 'object', properties: { n: { type: 'integer' } } });
  assert.equal(obj.value.n, 3);
  const bad = ad.coerceIntegerFromNumericString('3.2', { type: 'integer' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'coercion_rejected');
});

test('3H40-F-001 circuit breaker two consecutive empty model responses', () => {
  const state = {};
  const empty = { choices: [{ message: { content: '', tool_calls: [] } }] };
  const first = ad.circuitBreakerEmptyModelTwice(empty, state);
  assert.equal(first.halt, false);
  const second = ad.circuitBreakerEmptyModelTwice(empty, state);
  assert.equal(second.halt, true);
  assert.equal(second.code, 'empty_model');
  const filled = ad.circuitBreakerEmptyModelTwice({ choices: [{ message: { content: 'hola' } }] }, {});
  assert.equal(filled.halt, false);
});

test('3H40-G-001 budget hint every five steps when remaining <= 10', () => {
  const skipStep = ad.budgetHintEveryFiveSteps({ step: 4, remaining: 8 });
  assert.equal(skipStep.inject, false);
  const skipRemain = ad.budgetHintEveryFiveSteps({ step: 5, remaining: 11 });
  assert.equal(skipRemain.inject, false);
  const hit = ad.budgetHintEveryFiveSteps({ step: 10, remaining: 10 });
  assert.equal(hit.inject, true);
  assert.ok(/Quedan 10/.test(hit.text));
});

test('3H40-H-001 compact drop image/pdf older than last 2 user turns', () => {
  const msgs = [
    { role: 'user', content: [{ type: 'image', url: 'old.png' }, { type: 'text', text: 'u1' }] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: [{ type: 'text', text: 'u2' }] },
    { role: 'user', content: [{ type: 'image', url: 'fresh.png' }, { type: 'text', text: 'u3' }] },
  ];
  const out = ad.compactDropStaleImageBlocks(msgs);
  assert.equal(out.dropped, 1);
  assert.equal(out.messages[0].content.some((p) => p.type === 'image'), false);
  assert.equal(out.messages[3].content.some((p) => p.type === 'image'), true);
});

test('3H40-I-001 memory skip facts older than 30 days', () => {
  const now = Date.UTC(2026, 7, 20);
  const facts = [
    { text: 'old', ts: now - 31 * 86400000 },
    { text: 'fresh', ts: now - 2 * 86400000 },
    { text: 'no-ts' },
  ];
  const out = ad.memorySkipFactsOlderThanDays(facts, { days: 30, now });
  assert.equal(out.skipped, 1);
  assert.equal(out.facts.length, 2);
  assert.equal(out.facts[0].text, 'fresh');
});

test('3H40-J-001 rollback file on syntax fail restores previous bytes', () => {
  const ops = [];
  const keep = ad.rollbackFileOnSyntaxFail({ syntaxOk: true, previous: 'old', path: '/tmp/a.js', writeFn: (p, c) => ops.push([p, c]) });
  assert.equal(keep.rolledBack, false);
  assert.equal(ops.length, 0);
  const out = ad.rollbackFileOnSyntaxFail({
    syntaxOk: false,
    previous: 'old-bytes',
    path: '/tmp/a.js',
    writeFn: (p, c) => ops.push([p, c]),
  });
  assert.equal(out.rolledBack, true);
  assert.equal(ops[0][1], 'old-bytes');
});

test('3H40-K-001 refuse write through symlink', () => {
  const ok = ad.refuseWriteThroughSymlink('/tmp/a.js', { isSymlink: () => false });
  assert.equal(ok.ok, true);
  const bad = ad.refuseWriteThroughSymlink('/tmp/link.js', { isSymlink: () => true });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'symlink_write');
});

test('3H40-L-001 strip UTF-8 BOM on read', () => {
  const clean = ad.stripUtf8BomOnRead('hello');
  assert.equal(clean.bom, false);
  const bom = ad.stripUtf8BomOnRead('\uFEFFhello');
  assert.equal(bom.bom, true);
  assert.equal(bom.text, 'hello');
  const raw = ad.stripUtf8BomOnRead(Buffer.from([0xEF, 0xBB, 0xBF, 0x61]));
  assert.equal(raw.bom, true);
  assert.equal(raw.text, 'a');
});

test('3H40-M-001 sandbox SIGTERM then SIGKILL after 1500ms grace', () => {
  const signals = [];
  const timers = [];
  const out = ad.sandboxKillAfterGraceMs({
    pid: 4242,
    graceMs: 1500,
    killFn: (id, sig) => signals.push([id, sig]),
    setTimeoutFn: (fn, ms) => { timers.push(ms); fn(); },
  });
  assert.equal(out.killed, true);
  assert.equal(out.graceMs, 1500);
  assert.deepEqual(signals[0], [4242, 'SIGTERM']);
  assert.deepEqual(signals[1], [4242, 'SIGKILL']);
  assert.equal(timers[0], 1500);
});

test('3H40-N-001 stdout byte cap 64KiB per command', () => {
  const small = ad.stdoutByteCapPerCommand('hi');
  assert.equal(small.truncated, false);
  const big = ad.stdoutByteCapPerCommand('x'.repeat(64 * 1024 + 1));
  assert.equal(big.truncated, true);
  assert.ok(Buffer.byteLength(big.text, 'utf8') <= 64 * 1024);
});

test('3H40-O-001 SSE comment pad on idle over 10s', () => {
  const quiet = ad.ssePadForProxyBuffering({ idleMs: 10000 });
  assert.equal(quiet.padded, false);
  const pad = ad.ssePadForProxyBuffering({ idleMs: 10001 });
  assert.equal(pad.padded, true);
  assert.ok(pad.comment && pad.comment.length >= 1);
  assert.ok(pad.comment.startsWith(':'));
});

test('3H40-P-001 destroy SSE writer on client close', () => {
  let gone = false;
  const writer = { destroy() { gone = true; } };
  let closeFn = null;
  const req = { on(ev, fn) { if (ev === 'close') closeFn = fn; } };
  const out = ad.destroySseOnClientClose(req, writer);
  assert.equal(out.attached, true);
  assert.equal(out.destroyed, false);
  closeFn();
  assert.equal(out.destroyed, true);
  assert.equal(gone, true);
});

test('3H40-Q-001 third inflight generate per user is generate_overloaded', () => {
  assert.equal(ad.maxPendingGeneratePerUser('u1', 0).ok, true);
  assert.equal(ad.maxPendingGeneratePerUser('u1', 1).ok, true);
  const third = ad.maxPendingGeneratePerUser('u1', 2);
  assert.equal(third.ok, false);
  assert.equal(third.code, 'generate_overloaded');
});

test('3H40-R-001 steal lock if heartbeat older than 45s not live holders', () => {
  const now = 1_000_000;
  const live = ad.stealLockIfHeartbeatExpired({ holder: 'a', heartbeatAt: now - 45_000, now, requester: 'b' });
  assert.equal(live.stolen, false);
  const stale = ad.stealLockIfHeartbeatExpired({ holder: 'a', heartbeatAt: now - 45_001, now, requester: 'b' });
  assert.equal(stale.stolen, true);
  assert.equal(stale.holder, 'b');
});

test('3H40-S-001 never charge on 401/403 unauthorized', () => {
  const ok = ad.neverChargeOnUnauthorized({ status: 200 });
  assert.equal(ok.charge, true);
  const a = ad.neverChargeOnUnauthorized({ status: 401 });
  assert.equal(a.charge, false);
  assert.equal(a.code, 'unauthorized');
  const b = ad.neverChargeOnUnauthorized({ status: 403 });
  assert.equal(b.charge, false);
  assert.equal(b.code, 'unauthorized');
});

test('3H40-T-001 redact IPv4 in public errors', () => {
  const out = ad.redactIpv4InPublicErrors('fallo en 62.72.11.231 puerto 443');
  assert.equal(out.message.includes('62.72.11.231'), false);
  assert.ok(out.message.includes('x.x.x.x'));
  const clean = ad.redactIpv4InPublicErrors('sin ip');
  assert.equal(clean.redacted, false);
});

test('3H40-U-001 classify EPIPE/ECONNRESET on response stream as cancelled not net_reset', () => {
  const pipe = ad.classifyEpipeAsCancelled({ code: 'EPIPE' }, { stream: 'response' });
  assert.equal(pipe.code, 'cancelled');
  const reset = ad.classifyEpipeAsCancelled({ code: 'ECONNRESET' }, { stream: 'response' });
  assert.equal(reset.code, 'cancelled');
  const tool = ad.classifyEpipeAsCancelled({ code: 'ECONNRESET' }, { stream: 'net' });
  assert.equal(tool.code, null);
  assert.equal(JSON.stringify(pipe).includes('at Object.'), false);
});

test('3H40-V-001 skip glob if match cap over 500', () => {
  const ok = ad.skipGlobIfMatchCap(['a.js']);
  assert.equal(ok.truncated, false);
  const hits = Array.from({ length: 501 }, (_, i) => `f${i}`);
  const over = ad.skipGlobIfMatchCap(hits);
  assert.equal(over.truncated, true);
  assert.equal(over.code, 'glob_cap');
  assert.equal(over.hits.length, 500);
});

test('3H40-W-001 first token watchdog 8000ms scripted no DeepSeek', () => {
  const ok = ad.firstTokenWatchdogMs({ elapsedMs: 7999 });
  assert.equal(ok.fired, false);
  const fired = ad.firstTokenWatchdogMs({ elapsedMs: 8000 });
  assert.equal(fired.fired, true);
  assert.equal(fired.code, 'ttfb_watchdog');
  const got = ad.firstTokenWatchdogMs({ elapsedMs: 9000, firstTokenAt: 12 });
  assert.equal(got.fired, false);
});

test('3H40-X-001 snapshot keeps 3H39 flags true and wave 3H40 DeepSeek lock', () => {
  const s = ad.adapterSnapshot();
  assert.ok(s.wave === '3H40' || s.wave === '3H41' || s.wave === '3H42' || s.wave === '3H43' || s.wave === '3H44' || s.wave === '3H45' || s.wave === '3H46' || s.wave === '3H47' || s.wave === '3H48' || s.wave === '3H49' || s.wave === '3H50');
  assert.equal(s.joinParallelToolResultsStableOrder, true);
  assert.equal(s.cancelInflightToolsOnStop, true);
  assert.equal(s.jsonRepairTrailingComma, true);
  assert.equal(s.aliasCommonToolNames, true);
  assert.equal(s.truncateNestedToolArgsDepth, true);
  assert.equal(s.maxSubagentDepth, true);
  assert.equal(s.remainingWallClockCut, true);
  assert.equal(s.compactMergeAdjacentDuplicateUsers, true);
  assert.equal(s.memoryRetrieveDedupeByHash, true);
  assert.equal(s.refuseEditIfChecksumChangedSinceRead, true);
  assert.equal(s.patchContextLinesMustMatch, true);
  assert.equal(s.atomicWriteViaTempRename, true);
  assert.equal(s.rejectUncAndWindowsPaths, true);
  assert.equal(s.sandboxNoNewPrivs, true);
  assert.equal(s.envScrubLdPreload, true);
  assert.equal(s.cancelDropsBufferedTokens, true);
  assert.equal(s.sseEventIdMonotonic, true);
  assert.equal(s.idempotentSameCallIdInflight, true);
  assert.equal(s.settleCreditsIfClientGone, true);
  assert.equal(s.classifyJsonParseErrors, true);
  assert.equal(s.classifyAbortErrors, true);
  assert.equal(s.skipDuplicateWebFetchSameUrlTurn, true);
  assert.equal(s.maxToolsPerTurnHardCap, true);
  assert.equal(s.abortNestedSubagentsOnParentHalt, true);
  assert.equal(s.repairUnquotedKeysInToolJson, true);
  assert.equal(s.dropNullBytesInToolArgs, true);
  assert.equal(s.coerceIntegerFromNumericString, true);
  assert.equal(s.circuitBreakerEmptyModelTwice, true);
  assert.equal(s.budgetHintEveryFiveSteps, true);
  assert.equal(s.compactDropStaleImageBlocks, true);
  assert.equal(s.memorySkipFactsOlderThanDays, true);
  assert.equal(s.rollbackFileOnSyntaxFail, true);
  assert.equal(s.refuseWriteThroughSymlink, true);
  assert.equal(s.stripUtf8BomOnRead, true);
  assert.equal(s.sandboxKillAfterGraceMs, true);
  assert.equal(s.stdoutByteCapPerCommand, true);
  assert.equal(s.ssePadForProxyBuffering, true);
  assert.equal(s.destroySseOnClientClose, true);
  assert.equal(s.maxPendingGeneratePerUser, true);
  assert.equal(s.stealLockIfHeartbeatExpired, true);
  assert.equal(s.neverChargeOnUnauthorized, true);
  assert.equal(s.redactIpv4InPublicErrors, true);
  assert.equal(s.classifyEpipeAsCancelled, true);
  assert.equal(s.skipGlobIfMatchCap, true);
  assert.equal(s.firstTokenWatchdogMs, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
});

test('3H40-Y-001 live loop/queue/sse/gateway/sandbox import 3H40 helpers', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.ok(loop.includes('maxToolsPerTurnHardCap'));
  assert.ok(loop.includes('abortNestedSubagentsOnParentHalt'));
  assert.ok(loop.includes('repairUnquotedKeysInToolJson'));
  assert.ok(loop.includes('dropNullBytesInToolArgs'));
  assert.ok(loop.includes('coerceIntegerFromNumericString'));
  assert.ok(loop.includes('circuitBreakerEmptyModelTwice'));
  assert.ok(loop.includes('budgetHintEveryFiveSteps'));
  assert.ok(loop.includes('compactDropStaleImageBlocks'));
  assert.ok(loop.includes('memorySkipFactsOlderThanDays'));
  assert.ok(loop.includes('rollbackFileOnSyntaxFail'));
  assert.ok(loop.includes('refuseWriteThroughSymlink'));
  assert.ok(loop.includes('stripUtf8BomOnRead'));
  assert.ok(loop.includes('skipGlobIfMatchCap'));
  assert.ok(loop.includes('firstTokenWatchdogMs'));
  assert.ok(loop.includes('joinParallelToolResultsStableOrder'));
  const q = read('src/services/agent-gateway/queue.js');
  assert.ok(q.includes('maxPendingGeneratePerUser'));
  assert.ok(q.includes('stealLockIfHeartbeatExpired'));
  const sse = read('src/utils/sse-writer.js');
  assert.ok(sse.includes('ssePadForProxyBuffering'));
  assert.ok(sse.includes('destroySseOnClientClose'));
  const gw = read('src/services/agent-runner/engine-gateway.js');
  assert.ok(gw.includes('neverChargeOnUnauthorized'));
  assert.ok(gw.includes('classifyEpipeAsCancelled'));
  assert.ok(gw.includes('redactIpv4InPublicErrors'));
  const sb = read('src/services/sandbox/local-sandbox.js');
  assert.ok(sb.includes('sandboxKillAfterGraceMs'));
  assert.ok(sb.includes('stdoutByteCapPerCommand'));
  const ra = read('src/services/react-agent.js');
  assert.ok(ra.includes('repairUnquotedKeysInToolJson') || ra.includes('maxToolsPerTurnHardCap'));
});

test('3H40-Z-001 no OpenRouter generate path and DeepSeek lock', () => {
  assert.equal(ad.refuseOpenRouterEnv({ SIRAGPT_USE_OPENROUTER: '1' }).ok, false);
  assert.equal(ad.allowDeepSeekGenerateModel('deepseek-v4-flash').ok, true);
  assert.equal(ad.allowDeepSeekGenerateModel('deepseek-v4-pro').ok, true);
  assert.equal(ad.allowDeepSeekGenerateModel('openrouter/gpt-4').ok, false);
  assert.equal(typeof ad.allowlistToolName, 'function');
  assert.equal(typeof ad.holdThenSettleCredits, 'function');
});

test('3H40-AA-001 error codes include 3H40 taxonomy', () => {
  const { CODES } = require('../src/services/error_codes');
  assert.equal(CODES.TOO_MANY_TOOLS, 'too_many_tools');
  assert.equal(CODES.EMPTY_MODEL, 'empty_model');
  assert.equal(CODES.COERCION_REJECTED, 'coercion_rejected');
  assert.equal(CODES.SYMLINK_WRITE, 'symlink_write');
  assert.equal(CODES.UNAUTHORIZED, 'unauthorized');
  assert.equal(CODES.GLOB_CAP, 'glob_cap');
  assert.equal(CODES.TTFB_WATCHDOG, 'ttfb_watchdog');
  assert.equal(CODES.CANCELLED, 'cancelled');
  assert.equal(CODES.JSON_PARSE, 'json_parse');
});

test('3H40-AB-001 public stream maps 3H40 codes in ES without traces', () => {
  const src = read('src/services/observability/public-stream-error.js');
  assert.ok(src.includes("code: 'too_many_tools'"));
  assert.ok(/Demasiadas herramientas/i.test(src));
  assert.ok(src.includes("code: 'empty_model'"));
  assert.ok(src.includes("code: 'coercion_rejected'"));
  assert.ok(src.includes("code: 'symlink_write'"));
  assert.ok(src.includes("code: 'unauthorized'"));
  assert.ok(src.includes("code: 'glob_cap'"));
  assert.ok(src.includes("code: 'ttfb_watchdog'"));
  assert.ok(/primer token/i.test(src));
  assert.equal(/sk-[a-zA-Z0-9]/.test(src), false);
  assert.equal(/at Object\./.test(src), false);
});

test('3H40-AC-001 compose binds 3H40 tests and wave is 3H40', () => {
  assert.ok(String(__filename || '').includes('ola-3h40-invariants.test.js'));
  const src = read('src/services/agent-runner/engine-adapter.js');
  assert.ok(src.indexOf('3H40') >= 0);
  assert.ok(ad.adapterSnapshot().wave === '3H40' || ad.adapterSnapshot().wave === '3H41' || ad.adapterSnapshot().wave === '3H42' || ad.adapterSnapshot().wave === '3H43' || ad.adapterSnapshot().wave === '3H44' || ad.adapterSnapshot().wave === '3H45' || ad.adapterSnapshot().wave === '3H46' || ad.adapterSnapshot().wave === '3H47' || ad.adapterSnapshot().wave === '3H48' || ad.adapterSnapshot().wave === '3H49' || ad.adapterSnapshot().wave === '3H50');
});

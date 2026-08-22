'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const ad = require('../src/services/agent-runner/engine-adapter');

test('3H39-A-001 join parallel tool results in call order not finish order', () => {
  const calls = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const finished = [{ id: 'c', result: 3 }, { id: 'a', result: 1 }, { id: 'b', result: 2 }];
  const out = ad.joinParallelToolResultsStableOrder(calls, finished);
  assert.deepEqual(out.results.map((r) => r.id), ['a', 'b', 'c']);
  assert.equal(out.order, 'call');
  assert.equal(out.results[0].result, 1);
});

test('3H39-B-001 cancel in-flight tools on stop rejects remaining with cancelled true', () => {
  let rejected = null;
  const pending = [
    { id: 'a', reject: (v) => { rejected = v; } },
    { id: 'b' },
  ];
  const quiet = ad.cancelInflightToolsOnStop(pending, { aborted: false });
  assert.equal(quiet.cancelled.length, 0);
  const out = ad.cancelInflightToolsOnStop(pending, { aborted: true });
  assert.equal(out.results[0].cancelled, true);
  assert.equal(out.results[1].cancelled, true);
  assert.equal(rejected.cancelled, true);
  assert.equal(out.remaining.length, 0);
});

test('3H39-C-001 json repair trailing comma then parse', () => {
  const clean = ad.jsonRepairTrailingComma('{"a":1}');
  assert.equal(clean.ok, true);
  assert.equal(clean.repaired, false);
  assert.equal(clean.value.a, 1);
  const inner = ad.jsonRepairTrailingComma('{"a":1,"b":[2,],}');
  assert.equal(inner.ok, true);
  assert.equal(inner.value.a, 1);
  assert.deepEqual(inner.value.b, [2]);
  const bad = ad.jsonRepairTrailingComma('{not json');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'json_parse');
});

test('3H39-D-001 alias common tool names', () => {
  assert.equal(ad.aliasCommonToolNames('strreplace').name, 'str_replace');
  assert.equal(ad.aliasCommonToolNames('str-replace').aliased, true);
  assert.equal(ad.aliasCommonToolNames('bash').name, 'execute_bash');
  assert.equal(ad.aliasCommonToolNames('search_replace').name, 'str_replace');
  assert.equal(ad.aliasCommonToolNames('str_replace').aliased, false);
  assert.equal(ad.aliasCommonToolNames('str_replace').name, 'str_replace');
});

test('3H39-E-001 truncate nested tool args deeper than 6', () => {
  const shallow = { a: { b: 1 } };
  const ok = ad.truncateNestedToolArgsDepth(shallow);
  assert.equal(ok.truncated, false);
  assert.equal(ok.args.a.b, 1);
  const deep = { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } };
  const out = ad.truncateNestedToolArgsDepth(deep);
  assert.equal(out.truncated, true);
  let cur = out.args;
  let saw = false;
  for (let i = 0; i < 12; i += 1) {
    if (cur && cur.truncated === true) { saw = true; break; }
    const k = cur && typeof cur === 'object' ? Object.keys(cur)[0] : null;
    cur = k ? cur[k] : null;
  }
  assert.equal(saw, true);
});

test('3H39-F-001 max subagent depth over 2 is subagent_depth', () => {
  assert.equal(ad.maxSubagentDepth(2).ok, true);
  const over = ad.maxSubagentDepth(3);
  assert.equal(over.ok, false);
  assert.equal(over.code, 'subagent_depth');
});

test('3H39-G-001 remaining wall clock under 5s halts', () => {
  const ok = ad.remainingWallClockCut({ remainingMs: 5000 });
  assert.equal(ok.halt, false);
  const cut = ad.remainingWallClockCut({ remainingMs: 4999 });
  assert.equal(cut.halt, true);
  assert.equal(cut.code, 'wall_clock');
});

test('3H39-H-001 compact merge adjacent duplicate users', () => {
  const msgs = [
    { role: 'user', content: 'hola' },
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'hola' },
  ];
  const out = ad.compactMergeAdjacentDuplicateUsers(msgs);
  assert.equal(out.messages.length, 3);
  assert.equal(out.merged, 1);
  assert.equal(out.messages[0].content, 'hola');
  assert.equal(out.messages[2].content, 'hola');
});

test('3H39-I-001 memory retrieve dedupe by fact hash', () => {
  const facts = [
    { text: 'keep', hash: 'aaa' },
    { text: 'dup', hash: 'aaa' },
    { text: 'other', hash: 'bbb' },
  ];
  const out = ad.memoryRetrieveDedupeByHash(facts);
  assert.equal(out.facts.length, 2);
  assert.equal(out.dropped, 1);
  assert.equal(out.facts[0].text, 'keep');
  assert.equal(out.facts[1].text, 'other');
});

test('3H39-J-001 refuse edit if checksum changed since read', () => {
  const same = ad.refuseEditIfChecksumChangedSinceRead({ sha256Now: 'abc', sha256AtRead: 'abc' });
  assert.equal(same.ok, true);
  const changed = ad.refuseEditIfChecksumChangedSinceRead({ sha256Now: 'abc', sha256AtRead: 'def' });
  assert.equal(changed.ok, false);
  assert.equal(changed.code, 'file_changed');
});

test('3H39-K-001 patch context lines must match', () => {
  const ok = ad.patchContextLinesMustMatch({ haystack: 'foo\nbar\nbaz', diff: '@@\n foo\n-bar\n+qux\n baz' });
  assert.equal(ok.ok, true);
  const bad = ad.patchContextLinesMustMatch({ haystack: 'aaa', diff: '@@\n missing-context' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'git_hunk_context');
  const direct = ad.patchContextLinesMustMatch({ context: 'x', actual: 'y' });
  assert.equal(direct.code, 'git_hunk_context');
});

test('3H39-L-001 atomic write via temp rename', () => {
  const ops = [];
  const out = ad.atomicWriteViaTempRename({
    path: '/tmp/a.js',
    content: 'hi',
    writeFn: (p, c) => ops.push(['write', p, c]),
    renameFn: (from, to) => ops.push(['rename', from, to]),
  });
  assert.equal(out.atomic, true);
  assert.equal(ops[0][0], 'write');
  assert.equal(ops[0][1], '/tmp/a.js.tmp');
  assert.equal(ops[1][0], 'rename');
  assert.equal(ops[1][2], '/tmp/a.js');
});

test('3H39-M-001 reject UNC and Windows paths', () => {
  assert.equal(ad.rejectUncAndWindowsPaths('src/a.js').ok, true);
  const unc = ad.rejectUncAndWindowsPaths('\\\\server\\share\\x');
  assert.equal(unc.ok, false);
  assert.equal(unc.code, 'bad_path');
  const win = ad.rejectUncAndWindowsPaths('C:\\Windows\\x');
  assert.equal(win.ok, false);
  assert.equal(win.code, 'bad_path');
});

test('3H39-N-001 sandbox no-new-privs hint', () => {
  const hint = ad.sandboxNoNewPrivs({ bin: 'sh', argv: ['-c', 'echo hi'] });
  assert.equal(hint.noNewPrivs, true);
  assert.ok(hint.hint);
  assert.ok(/no-new-privs/.test(hint.prefix || hint.hint || hint.argv.join(' ')));
});

test('3H39-O-001 env scrub LD_PRELOAD and LD_LIBRARY_PATH', () => {
  const src = { PATH: '/bin', LD_PRELOAD: 'evil.so', LD_LIBRARY_PATH: '/evil', HOME: '/tmp' };
  const out = ad.envScrubLdPreload(src);
  assert.equal(out.env.LD_PRELOAD, undefined);
  assert.equal(out.env.LD_LIBRARY_PATH, undefined);
  assert.equal(out.env.PATH, '/bin');
  assert.equal(src.LD_PRELOAD, 'evil.so');
});

test('3H39-P-001 cancel drops buffered tokens without flush', () => {
  const keep = ad.cancelDropsBufferedTokens({ aborted: false, buffer: ['a', 'b'] });
  assert.equal(keep.dropped, 0);
  const drop = ad.cancelDropsBufferedTokens({ aborted: true, buffer: ['a', 'b', 'c'] });
  assert.equal(drop.dropped, 3);
  assert.equal(drop.flushed, false);
});

test('3H39-Q-001 SSE event id monotonic resume vs replay window', () => {
  const resume = ad.sseEventIdMonotonic({ lastSent: 50, clientId: 10, window: 64 });
  assert.equal(resume.replay, false);
  const ok = ad.sseEventIdMonotonic({ lastSent: 50, clientId: 51, window: 64 });
  assert.equal(ok.replay, false);
  const replay = ad.sseEventIdMonotonic({ lastSent: 10, clientId: 80, window: 64 });
  assert.equal(replay.replay, true);
});

test('3H39-R-001 idempotent same call id inflight coalesces', () => {
  const map = {};
  const first = ad.idempotentSameCallIdInflight('tc1', map, { create: () => ({ p: 1 }) });
  assert.equal(first.coalesced, false);
  const second = ad.idempotentSameCallIdInflight('tc1', map);
  assert.equal(second.coalesced, true);
  assert.equal(second.promise, first.promise);
});

test('3H39-S-001 settle credits if client gone', () => {
  const live = ad.settleCreditsIfClientGone({ res: { writableEnded: false }, aborted: false });
  assert.equal(live.settled, false);
  const gone = ad.settleCreditsIfClientGone({ res: { writableEnded: true }, sessionKey: 's', requestId: 'r' });
  assert.equal(gone.settled, true);
  const aborted = ad.settleCreditsIfClientGone({ aborted: true });
  assert.equal(aborted.settled, true);
});

test('3H39-T-001 classify JSON parse errors never leak stack', () => {
  const err = new SyntaxError('Unexpected token } in JSON at position 3');
  err.stack = 'SyntaxError: Unexpected token\n    at Object.foo (/opt/x.js:1:1)';
  const out = ad.classifyJsonParseErrors(err);
  assert.equal(out.code, 'json_parse');
  assert.equal(JSON.stringify(out).includes('at Object.'), false);
  assert.equal(JSON.stringify(out).includes('/opt/x.js'), false);
  const unterm = ad.classifyJsonParseErrors({ message: 'Unterminated string in JSON' });
  assert.equal(unterm.code, 'json_parse');
  assert.ok(/json/i.test(out.message));
});

test('3H39-U-001 classify AbortError and ECANCELED as cancelled', () => {
  const a = ad.classifyAbortErrors({ name: 'AbortError', message: 'aborted' });
  assert.equal(a.code, 'cancelled');
  const b = ad.classifyAbortErrors({ code: 'ECANCELED' });
  assert.equal(b.code, 'cancelled');
  assert.equal(JSON.stringify(a).includes('at Object.'), false);
});

test('3H39-V-001 skip duplicate web fetch same URL in one turn', () => {
  const cache = {};
  const first = ad.skipDuplicateWebFetchSameUrlTurn('https://example.com/a', cache);
  assert.equal(first.cacheHit, false);
  const second = ad.skipDuplicateWebFetchSameUrlTurn('https://example.com/a', cache);
  assert.equal(second.cacheHit, true);
  const other = ad.skipDuplicateWebFetchSameUrlTurn('https://example.com/b', cache);
  assert.equal(other.cacheHit, false);
});

test('3H39-W-001 snapshot exposes 3H38 plus 3H39 flags and DeepSeek lock', () => {
  const s = ad.adapterSnapshot();
  assert.ok(s.wave === "3H39" || s.wave === "3H40" || s.wave === "3H41");
  assert.equal(s.maxConcurrentToolsPerTurn, true);
  assert.equal(s.subagentResultSizeCap, true);
  assert.equal(s.repairMissingRequiredFromPriorTurn, true);
  assert.equal(s.validateToolResultShape, true);
  assert.equal(s.toolTimeoutFitsRemainingBudget, true);
  assert.equal(s.deadLetterSameToolAfterN, true);
  assert.equal(s.injectPlanProgressLine, true);
  assert.equal(s.compactPreserveLastErrors, true);
  assert.equal(s.pinCriticalFacts, true);
  assert.equal(s.checkpointCasSeq, true);
  assert.equal(s.checksumVerifyAfterWrite, true);
  assert.equal(s.syntaxCheckJsPyAfterWrite, true);
  assert.equal(s.rejectControlCharsInPaths, true);
  assert.equal(s.createFileExclusive, true);
  assert.equal(s.sandboxTmpfsHint, true);
  assert.equal(s.redactHomePathsInResults, true);
  assert.equal(s.ssePingOnIdleTool, true);
  assert.equal(s.classifySseGap, true);
  assert.equal(s.fairQueueStarvationBound, true);
  assert.equal(s.creditAuditOnToolError, true);
  assert.equal(s.classifyFsErrors, true);
  assert.equal(s.skipMemoryRetrieveIfBusy, true);
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
  assert.equal(s.identicalObservationLoopCut, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
});

test('3H39-X-001 live loop/queue/sse/gateway/sandbox import 3H39 helpers', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.ok(loop.includes('joinParallelToolResultsStableOrder'));
  assert.ok(loop.includes('cancelInflightToolsOnStop'));
  assert.ok(loop.includes('jsonRepairTrailingComma'));
  assert.ok(loop.includes('aliasCommonToolNames'));
  assert.ok(loop.includes('truncateNestedToolArgsDepth'));
  assert.ok(loop.includes('maxSubagentDepth'));
  assert.ok(loop.includes('remainingWallClockCut'));
  assert.ok(loop.includes('compactMergeAdjacentDuplicateUsers'));
  assert.ok(loop.includes('memoryRetrieveDedupeByHash'));
  assert.ok(loop.includes('refuseEditIfChecksumChangedSinceRead'));
  assert.ok(loop.includes('patchContextLinesMustMatch'));
  assert.ok(loop.includes('atomicWriteViaTempRename'));
  assert.ok(loop.includes('rejectUncAndWindowsPaths'));
  assert.ok(loop.includes('idempotentSameCallIdInflight'));
  assert.ok(loop.includes('skipDuplicateWebFetchSameUrlTurn'));
  assert.ok(loop.includes('settleCreditsIfClientGone'));
  assert.ok(loop.includes('maxConcurrentToolsPerTurn'));
  const q = read('src/services/agent-gateway/queue.js');
  assert.ok(q.includes('fairQueueStarvationBound'));
  const sse = read('src/utils/sse-writer.js');
  assert.ok(sse.includes('sseEventIdMonotonic'));
  assert.ok(sse.includes('cancelDropsBufferedTokens'));
  const gw = read('src/services/agent-runner/engine-gateway.js');
  assert.ok(gw.includes('classifyJsonParseErrors'));
  assert.ok(gw.includes('classifyAbortErrors'));
  assert.ok(gw.includes('settleCreditsIfClientGone'));
  const sb = read('src/services/sandbox/local-sandbox.js');
  assert.ok(sb.includes('sandboxNoNewPrivs'));
  assert.ok(sb.includes('envScrubLdPreload'));
  const ra = read('src/services/react-agent.js');
  assert.ok(ra.includes('aliasCommonToolNames'));
});

test('3H39-Y-001 no OpenRouter generate path and DeepSeek lock', () => {
  assert.equal(ad.refuseOpenRouterEnv({ SIRAGPT_USE_OPENROUTER: '1' }).ok, false);
  assert.equal(ad.allowDeepSeekGenerateModel('deepseek-v4-flash').ok, true);
  assert.equal(ad.allowDeepSeekGenerateModel('deepseek-v4-pro').ok, true);
  assert.equal(ad.allowDeepSeekGenerateModel('openrouter/gpt-4').ok, false);
  assert.equal(typeof ad.allowlistToolName, 'function');
  assert.equal(typeof ad.holdThenSettleCredits, 'function');
});

test('3H39-Z-001 error codes include 3H39 taxonomy', () => {
  const { CODES } = require('../src/services/error_codes');
  assert.equal(CODES.SUBAGENT_DEPTH, 'subagent_depth');
  assert.equal(CODES.WALL_CLOCK, 'wall_clock');
  assert.equal(CODES.FILE_CHANGED, 'file_changed');
  assert.equal(CODES.GIT_HUNK_CONTEXT, 'git_hunk_context');
  assert.equal(CODES.JSON_PARSE, 'json_parse');
  assert.equal(CODES.CANCELLED, 'cancelled');
  assert.equal(CODES.MISSING_REQUIRED, 'missing_required');
  assert.equal(CODES.BAD_PATH, 'bad_path');
});

test('3H39-AA-001 public stream maps 3H39 codes in ES without traces', () => {
  const src = read('src/services/observability/public-stream-error.js');
  assert.ok(src.includes("code: 'subagent_depth'"));
  assert.ok(/profundidad/i.test(src));
  assert.ok(src.includes("code: 'wall_clock'"));
  assert.ok(src.includes("code: 'file_changed'"));
  assert.ok(src.includes("code: 'git_hunk_context'"));
  assert.ok(src.includes("code: 'json_parse'"));
  assert.ok(/JSON de la herramienta/i.test(src));
  assert.equal(/sk-[a-zA-Z0-9]/.test(src), false);
  assert.equal(/at Object\./.test(src), false);
});

test('3H39-AB-001 compose binds 3H39 tests and wave is 3H39', () => {
  assert.ok(String(__filename || '').includes('ola-3h39-invariants.test.js'));
  const src = read('src/services/agent-runner/engine-adapter.js');
  assert.ok(src.indexOf('3H39') >= 0);
  assert.ok(ad.adapterSnapshot().wave === "3H39" || ad.adapterSnapshot().wave === "3H40" || ad.adapterSnapshot().wave === "3H41");
});

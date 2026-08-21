'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const ad = require('../src/services/agent-runner/engine-adapter');

test('3H38-A-001 max concurrent tools per turn caps at 4 and defers extra', () => {
  const five = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
  const out = ad.maxConcurrentToolsPerTurn(five, { max: 4 });
  assert.equal(out.run.length, 4);
  assert.equal(out.deferred.length, 1);
  assert.equal(out.deferred[0].deferred, true);
  const four = ad.maxConcurrentToolsPerTurn([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
  assert.equal(four.deferred.length, 0);
});

test('3H38-B-001 subagent result size cap 8KiB truncated true', () => {
  const small = ad.subagentResultSizeCap('hola');
  assert.equal(small.truncated, false);
  const big = ad.subagentResultSizeCap('x'.repeat(9000));
  assert.equal(big.truncated, true);
  assert.equal(big.result.truncated, true);
  assert.ok(big.bytes <= 8 * 1024);
});

test('3H38-C-001 repair missing required from prior turn if types match', () => {
  const schema = { required: ['path'], properties: { path: { type: 'string' }, mode: { type: 'string' } } };
  const filled = ad.repairMissingRequiredFromPriorTurn({ mode: 'r' }, schema, { prior: { path: 'a.js', mode: 'w' } });
  assert.equal(filled.ok, true);
  assert.equal(filled.args.path, 'a.js');
  const miss = ad.repairMissingRequiredFromPriorTurn({ mode: 'r' }, schema, { prior: null });
  assert.equal(miss.ok, false);
  assert.equal(miss.code, 'missing_required');
  const typeMismatch = ad.repairMissingRequiredFromPriorTurn({}, schema, { prior: { path: 12 } });
  assert.equal(typeMismatch.ok, false);
  assert.equal(typeMismatch.code, 'missing_required');
});

test('3H38-D-001 validate tool result shape wraps invalid', () => {
  assert.equal(ad.validateToolResultShape('ok').ok, true);
  assert.equal(ad.validateToolResultShape(3).ok, true);
  assert.equal(ad.validateToolResultShape(true).ok, true);
  assert.equal(ad.validateToolResultShape(null).ok, true);
  assert.equal(ad.validateToolResultShape({ a: 1 }).ok, true);
  const bad = ad.validateToolResultShape(undefined);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad_tool_result');
  const fn = ad.validateToolResultShape(() => {});
  assert.equal(fn.ok, false);
});

test('3H38-E-001 tool timeout that does not fit remaining budget is skipped', () => {
  const skip = ad.toolTimeoutFitsRemainingBudget({ remainingMs: 100, timeoutMs: 5000 });
  assert.equal(skip.skip, true);
  assert.equal(skip.code, 'timeout_budget');
  const ok = ad.toolTimeoutFitsRemainingBudget({ remainingMs: 8000, timeoutMs: 5000 });
  assert.equal(ok.skip, false);
});

test('3H38-F-001 dead letter same tool plus error code after 3', () => {
  const a = ad.deadLetterSameToolAfterN([
    { tool: 'read_file', code: 'enoent' },
    { tool: 'read_file', code: 'enoent' },
  ]);
  assert.equal(a.halt, false);
  const b = ad.deadLetterSameToolAfterN([
    { tool: 'read_file', code: 'enoent' },
    { tool: 'read_file', code: 'enoent' },
    { tool: 'read_file', code: 'enoent' },
  ]);
  assert.equal(b.halt, true);
  assert.equal(b.code, 'tool_dead_letter');
  const mixed = ad.deadLetterSameToolAfterN([
    { tool: 'read_file', code: 'enoent' },
    { tool: 'read_file', code: 'eacces' },
    { tool: 'read_file', code: 'enoent' },
  ]);
  assert.equal(mixed.halt, false);
});

test('3H38-G-001 inject plan progress line when n>1', () => {
  const quiet = ad.injectPlanProgressLine({ i: 1, n: 1 });
  assert.equal(quiet.inject, false);
  const line = ad.injectPlanProgressLine({ i: 2, n: 5 });
  assert.equal(line.inject, true);
  assert.ok(/2\/5/.test(line.text));
  assert.ok(/remaining/.test(line.text));
});

test('3H38-H-001 compact preserve last 3 error messages', () => {
  const e1 = { role: 'error', content: 'e1' };
  const e2 = { role: 'assistant', content: 'x', code: 'tool_timeout' };
  const e3 = { role: 'error', content: 'e3' };
  const e4 = { role: 'error', content: 'e4' };
  const original = [e1, { role: 'user', content: 'u' }, e2, e3, { role: 'assistant', content: 'a' }, e4];
  const compacted = [{ role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }];
  const out = ad.compactPreserveLastErrors(compacted, original, { keep: 3 });
  assert.equal(out.keptErrors.length, 3);
  assert.ok(out.messages.includes(e2));
  assert.ok(out.messages.includes(e3));
  assert.ok(out.messages.includes(e4));
  assert.equal(out.messages.includes(e1), false);
});

test('3H38-I-001 pin true facts survive compact', () => {
  const facts = [
    { text: 'keep-me', pin: true },
    { text: 'drop-me', pin: false },
    { text: 'also', pinned: true },
  ];
  const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hola' }];
  const out = ad.pinCriticalFacts(msgs, facts);
  assert.equal(out.facts.length, 2);
  assert.ok(out.messages[0].content.includes('keep-me'));
  assert.equal(out.messages[0].content.includes('drop-me'), false);
});

test('3H38-J-001 checkpoint CAS seq must be lastSeq+1', () => {
  const ok = ad.checkpointCasSeq({ seq: 4, lastSeq: 3 });
  assert.equal(ok.ok, true);
  const bad = ad.checkpointCasSeq({ seq: 4, lastSeq: 4 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'ckpt_cas');
  const jump = ad.checkpointCasSeq({ seq: 9, lastSeq: 3 });
  assert.equal(jump.ok, false);
});

test('3H38-K-001 checksum verify after write mismatch write_checksum', () => {
  const content = 'hello';
  const hash = ad.sha256Hex(content);
  const ok = ad.checksumVerifyAfterWrite({ actual: content, expectedSha256: hash });
  assert.equal(ok.ok, true);
  const bad = ad.checksumVerifyAfterWrite({ actual: 'hello', expectedSha256: 'deadbeef' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'write_checksum');
});

test('3H38-L-001 syntax check js/py after write fail closed', () => {
  const jsOk = ad.syntaxCheckJsPyAfterWrite('a.js', 'const x = 1;');
  assert.equal(jsOk.ok, true);
  const jsBad = ad.syntaxCheckJsPyAfterWrite('a.js', 'const x = (');
  assert.equal(jsBad.ok, false);
  assert.equal(jsBad.code, 'syntax_invalid');
  const pyOk = ad.syntaxCheckJsPyAfterWrite('a.py', 'x = 1\n');
  assert.equal(pyOk.ok, true);
  const pyBad = ad.syntaxCheckJsPyAfterWrite('a.py', 'def (');
  assert.equal(pyBad.ok, false);
  assert.equal(pyBad.code, 'syntax_invalid');
  const pyCompile = ad.syntaxCheckJsPyAfterWrite('b.py', 'print(1)', { compileFn: () => { throw new Error('nope'); } });
  assert.equal(pyCompile.ok, false);
});

test('3H38-M-001 reject C0 control chars in paths', () => {
  const ok = ad.rejectControlCharsInPaths('src/a.js');
  assert.equal(ok.ok, true);
  const nul = ad.rejectControlCharsInPaths('src/\0a.js');
  assert.equal(nul.ok, false);
  assert.equal(nul.code, 'bad_path');
  const cr = ad.rejectControlCharsInPaths('src/\u0001a.js');
  assert.equal(cr.ok, false);
});

test('3H38-N-001 create file exclusive refuses existing unless overwrite', () => {
  const exists = ad.createFileExclusive({ path: 'a.js', exists: true, overwrite: false });
  assert.equal(exists.ok, false);
  assert.equal(exists.code, 'file_exists');
  const over = ad.createFileExclusive({ path: 'a.js', exists: true, overwrite: true });
  assert.equal(over.ok, true);
  const fresh = ad.createFileExclusive({ path: 'b.js', exists: false });
  assert.equal(fresh.ok, true);
});

test('3H38-O-001 sandbox tmpfs hint is 64MB', () => {
  const hint = ad.sandboxTmpfsHint({ tmpdir: '/tmp/x' });
  assert.equal(hint.tmpfsMb, 64);
  assert.ok(hint.note);
  assert.equal(hint.limitBytes, 64 * 1024 * 1024);
});

test('3H38-P-001 redact home and root paths in results', () => {
  const out = ad.redactHomePathsInResults('wrote /home/luis/app.js and /root/secret');
  assert.equal(out.redacted, true);
  assert.equal(out.text.includes('/home/luis'), false);
  assert.equal(out.text.includes('/root'), false);
  assert.ok(out.text.includes('$HOME'));
});

test('3H38-Q-001 SSE ping on idle tool over 5s', () => {
  const idle = ad.ssePingOnIdleTool({ elapsedMs: 1000 });
  assert.equal(idle.ping, false);
  const ping = ad.ssePingOnIdleTool({ elapsedMs: 5001 });
  assert.equal(ping.ping, true);
  assert.ok(ping.comment.includes('ping'));
});

test('3H38-R-001 classify SSE gap Last-Event-ID jump', () => {
  const ok = ad.classifySseGap({ lastEventId: 10, currentSeq: 12, window: 64 });
  assert.equal(ok.replay, false);
  const gap = ad.classifySseGap({ lastEventId: 1, currentSeq: 80, window: 64 });
  assert.equal(gap.replay, true);
  assert.equal(gap.fromSeq, 2);
  assert.equal(gap.code, 'sse_gap');
});

test('3H38-S-001 fair queue starvation bound boosts waiters older than 15s', () => {
  const now = 100_000;
  const waiters = [
    { id: 'a', enqueuedAt: now - 1000 },
    { id: 'b', enqueuedAt: now - 20_000 },
    { id: 'c', enqueuedAt: now - 500, running: true },
  ];
  const out = ad.fairQueueStarvationBound(waiters, { now, inFlight: 'c' });
  assert.equal(out.boosted, true);
  assert.equal(out.waiters[0].id, 'b');
  assert.equal(out.waiters[0].boosted, true);
  assert.equal(out.waiters.some((w) => w.id === 'c' && w.boosted), false);
});

test('3H38-T-001 credit audit on tool error does not silent skip', () => {
  const out = ad.creditAuditOnToolError({ tokens: 12, tool: 'read_file', code: 'fs_not_found', session: 's1' });
  assert.equal(out.skipped, false);
  assert.equal(out.ok, true);
  assert.equal(out.rec.tokens, 12);
  assert.equal(out.rec.tool, 'read_file');
  assert.equal(out.rec.code, 'fs_not_found');
});

test('3H38-U-001 classify FS errors to public ES without stacks', () => {
  assert.equal(ad.classifyFsErrors({ code: 'ENOENT' }).code, 'fs_not_found');
  assert.equal(ad.classifyFsErrors({ code: 'EACCES' }).code, 'fs_denied');
  assert.equal(ad.classifyFsErrors({ code: 'ENOSPC' }).code, 'fs_nospace');
  assert.equal(ad.classifyFsErrors({ code: 'EISDIR' }).code, 'fs_isdir');
  const msg = ad.classifyFsErrors({ code: 'ENOENT', stack: 'Error: fail\n    at Object.foo (/opt/x.js:1:1)' });
  assert.equal(JSON.stringify(msg).includes('at Object.'), false);
  assert.equal(JSON.stringify(msg).includes('/opt/x.js'), false);
  assert.ok(/encontre/i.test(msg.message));
});

test('3H38-V-001 skip memory retrieve if turn elapsed over 2500ms', () => {
  const skip = ad.skipMemoryRetrieveIfBusy({ elapsedMs: 3000 });
  assert.equal(skip.skipped, true);
  assert.equal(skip.reason, 'latency');
  const run = ad.skipMemoryRetrieveIfBusy({ elapsedMs: 800 });
  assert.equal(run.skipped, false);
});

test('3H38-W-001 snapshot exposes 3H37 plus 3H38 flags and DeepSeek lock', () => {
  const s = ad.adapterSnapshot();
  assert.ok(s.wave === "3H38" || s.wave === "3H39" || s.wave === "3H40");
  assert.equal(s.identicalObservationLoopCut, true);
  assert.equal(s.abortSiblingsOnParentCancel, true);
  assert.equal(s.validateEnumArgs, true);
  assert.equal(s.truncateOverlongArgStrings, true);
  assert.equal(s.cacheIdenticalToolCallSameTurn, true);
  assert.equal(s.detectDagCycle, true);
  assert.equal(s.remainingStepBudgetReminder, true);
  assert.equal(s.compactKeepToolCallResultPairs, true);
  assert.equal(s.minScoreMemoryRetrieve, true);
  assert.equal(s.checkpointAfterSuccessfulWrite, true);
  assert.equal(s.refuseBinaryFileEdit, true);
  assert.equal(s.normalizeLineEndingsBeforeDiff, true);
  assert.equal(s.moveFileSameVolume, true);
  assert.equal(s.sandboxRssCpuUlimit, true);
  assert.equal(s.scrubSecretsFromChildEnv, true);
  assert.equal(s.tmpdirCleanupFinally, true);
  assert.equal(s.sseMaxBufferDisconnect, true);
  assert.equal(s.heartbeatJitter, true);
  assert.equal(s.generateWaitRetryAfter, true);
  assert.equal(s.refundPartialTokensOnCancel, true);
  assert.equal(s.classifyNetErrors, true);
  assert.equal(s.skipCompactIfUnderBudget, true);
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
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
});

test('3H38-X-001 live loop/queue/sse/gateway/sandbox import 3H38 helpers', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.ok(loop.includes('maxConcurrentToolsPerTurn'));
  assert.ok(loop.includes('subagentResultSizeCap'));
  assert.ok(loop.includes('repairMissingRequiredFromPriorTurn'));
  assert.ok(loop.includes('validateToolResultShape'));
  assert.ok(loop.includes('toolTimeoutFitsRemainingBudget'));
  assert.ok(loop.includes('createDeadLetterSameToolAfterN') || loop.includes('deadLetterSameToolAfterN'));
  assert.ok(loop.includes('injectPlanProgressLine'));
  assert.ok(loop.includes('compactPreserveLastErrors'));
  assert.ok(loop.includes('pinCriticalFactsTagged') || loop.includes('pinCriticalFacts'));
  assert.ok(loop.includes('checkpointCasSeq'));
  assert.ok(loop.includes('checksumVerifyAfterWrite'));
  assert.ok(loop.includes('syntaxCheckJsPyAfterWrite'));
  assert.ok(loop.includes('rejectControlCharsInPaths'));
  assert.ok(loop.includes('createFileExclusive'));
  assert.ok(loop.includes('creditAuditOnToolError'));
  assert.ok(loop.includes('classifyFsErrors'));
  assert.ok(loop.includes('skipMemoryRetrieveIfBusy'));
  assert.ok(loop.includes('identicalObservationLoopCut') || loop.includes('createIdenticalObservationLoopCut'));
  const q = read('src/services/agent-gateway/queue.js');
  assert.ok(q.includes('fairQueueStarvationBound'));
  const sse = read('src/utils/sse-writer.js');
  assert.ok(sse.includes('classifySseGap'));
  assert.ok(sse.includes('ssePingOnIdleTool'));
  const gw = read('src/services/agent-runner/engine-gateway.js');
  assert.ok(gw.includes('repairMissingRequiredFromPriorTurn'));
  assert.ok(gw.includes('classifyFsErrors'));
  const sb = read('src/services/sandbox/local-sandbox.js');
  assert.ok(sb.includes('sandboxTmpfsHint'));
  assert.ok(sb.includes('redactHomePathsInResults'));
  const ra = read('src/services/react-agent.js');
  assert.ok(ra.includes('maxConcurrentToolsPerTurn'));
});

test('3H38-Y-001 no OpenRouter generate path and DeepSeek lock', () => {
  assert.equal(ad.refuseOpenRouterEnv({ SIRAGPT_USE_OPENROUTER: '1' }).ok, false);
  assert.equal(ad.allowDeepSeekGenerateModel('deepseek-v4-flash').ok, true);
  assert.equal(ad.allowDeepSeekGenerateModel('deepseek-v4-pro').ok, true);
  assert.equal(ad.allowDeepSeekGenerateModel('openrouter/gpt-4').ok, false);
  assert.equal(typeof ad.allowlistToolName, 'function');
  assert.equal(typeof ad.holdThenSettleCredits, 'function');
});

test('3H38-Z-001 error codes include 3H38 taxonomy', () => {
  const { CODES } = require('../src/services/error_codes');
  assert.equal(CODES.MISSING_REQUIRED, 'missing_required');
  assert.equal(CODES.BAD_TOOL_RESULT, 'bad_tool_result');
  assert.equal(CODES.TIMEOUT_BUDGET, 'timeout_budget');
  assert.equal(CODES.TOOL_DEAD_LETTER, 'tool_dead_letter');
  assert.equal(CODES.WRITE_CHECKSUM, 'write_checksum');
  assert.equal(CODES.BAD_PATH, 'bad_path');
  assert.equal(CODES.FILE_EXISTS, 'file_exists');
  assert.equal(CODES.FS_NOT_FOUND, 'fs_not_found');
  assert.equal(CODES.FS_DENIED, 'fs_denied');
  assert.equal(CODES.FS_NOSPACE, 'fs_nospace');
  assert.equal(CODES.FS_ISDIR, 'fs_isdir');
});

test('3H38-AA-001 public stream maps 3H38 codes in ES without traces', () => {
  const src = read('src/services/observability/public-stream-error.js');
  assert.ok(src.includes("code: 'missing_required'"));
  assert.ok(/argumentos obligatorios/i.test(src));
  assert.ok(src.includes("code: 'bad_tool_result'"));
  assert.ok(src.includes("code: 'timeout_budget'"));
  assert.ok(src.includes("code: 'tool_dead_letter'"));
  assert.ok(src.includes("code: 'write_checksum'"));
  assert.ok(src.includes("code: 'fs_not_found'"));
  assert.ok(src.includes("code: 'fs_denied'"));
  assert.ok(src.includes("code: 'fs_nospace'"));
  assert.ok(src.includes("code: 'fs_isdir'"));
  assert.ok(src.includes("code: 'file_exists'"));
  assert.ok(src.includes("code: 'bad_path'"));
  assert.equal(/sk-[a-zA-Z0-9]/.test(src), false);
  assert.equal(/at Object\./.test(src), false);
});

test('3H38-AB-001 compose binds 3H38 tests and wave is 3H38', () => {
  assert.ok(String(__filename || '').includes('ola-3h38-invariants.test.js'));
  const src = read('src/services/agent-runner/engine-adapter.js');
  assert.ok(src.indexOf('3H38') >= 0);
  assert.ok(ad.adapterSnapshot().wave === "3H38" || ad.adapterSnapshot().wave === "3H39" || ad.adapterSnapshot().wave === "3H40");
});

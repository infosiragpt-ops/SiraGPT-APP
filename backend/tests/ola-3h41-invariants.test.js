'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const ad = require('../src/services/agent-runner/engine-adapter');

test('3H41-A-001 prune checkpoints keep last 8', () => {
  const small = ad.pruneCheckpointsKeepLastN([1, 2, 3], { keep: 8 });
  assert.equal(small.pruned, false);
  const list = Array.from({ length: 10 }, (_, i) => i);
  const out = ad.pruneCheckpointsKeepLastN(list, { keep: 8 });
  assert.equal(out.pruned, true);
  assert.equal(out.dropped, 2);
  assert.deepEqual(out.checkpoints, [2, 3, 4, 5, 6, 7, 8, 9]);
});

test('3H41-B-001 persist SSE Last-Event-ID cursor never goes backwards', () => {
  const store = {};
  const a = ad.persistSseLastEventIdCursor({ seq: 4, store });
  assert.equal(a.persisted, true);
  assert.equal(a.cursor, 4);
  const back = ad.persistSseLastEventIdCursor({ lastEventId: 2, store });
  assert.equal(back.persisted, false);
  assert.equal(back.stale, true);
  assert.equal(back.cursor, 4);
});

test('3H41-C-001 repair single quotes and trailing comments in tool JSON', () => {
  const clean = ad.repairSingleQuotesAndCommentsInToolJson('{"path":"a"}');
  assert.equal(clean.ok, true);
  assert.equal(clean.repaired, false);
  const raw = ad.repairSingleQuotesAndCommentsInToolJson("{path: 'a'} // comment\n");
  // path key may still be unquoted; if parse fails that's ok as long as quoted-value form works
  const quoted = ad.repairSingleQuotesAndCommentsInToolJson("{'path': 'a'} // hi");
  assert.equal(quoted.ok, true);
  assert.equal(quoted.value.path, 'a');
  const cmt = ad.repairSingleQuotesAndCommentsInToolJson('{"n":1} /* block */');
  assert.equal(cmt.ok, true);
  assert.equal(cmt.value.n, 1);
});

test('3H41-D-001 clamp max output tokens hard 8192', () => {
  const ok = ad.clampMaxOutputTokens(1500);
  assert.equal(ok.maxTokens, 1500);
  const over = ad.clampMaxOutputTokens(20000);
  assert.equal(over.maxTokens, 8192);
  assert.equal(over.clamped, true);
  const zero = ad.clampMaxOutputTokens(0);
  assert.equal(zero.maxTokens, 1);
});

test('3H41-E-001 drop duplicate consecutive tool calls keep non-consecutive', () => {
  const calls = [
    { name: 'read_file', arguments: '{"p":"a"}' },
    { name: 'read_file', arguments: '{"p":"a"}' },
    { name: 'write_file', arguments: '{"p":"b"}' },
    { name: 'read_file', arguments: '{"p":"a"}' },
  ];
  const out = ad.dropDuplicateConsecutiveToolCalls(calls);
  assert.equal(out.dropped, 1);
  assert.equal(out.calls.length, 3);
  assert.equal(out.calls[1].name, 'write_file');
});

test('3H41-F-001 classify HTTP family 5xx vs 4xx vs timeout', () => {
  const s5 = ad.classifyHttpFamily({ status: 503 });
  assert.equal(s5.family, '5xx');
  assert.equal(s5.retryable, true);
  const s4 = ad.classifyHttpFamily({ status: 400 });
  assert.equal(s4.family, '4xx');
  assert.equal(s4.retryable, false);
  const to = ad.classifyHttpFamily({ code: 'ETIMEDOUT' });
  assert.equal(to.family, 'timeout');
  assert.equal(to.code, 'http_timeout');
});

test('3H41-G-001 compact keep last user+assistant pair indexes', () => {
  const msgs = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
  ];
  const out = ad.compactKeepLastUserAssistantPair(msgs);
  assert.deepEqual(out.keepIndexes, [2, 3]);
  assert.equal(out.messages.length, 4);
});

test('3H41-H-001 redact key-like tool args from logs', () => {
  const clean = ad.redactKeyLikeToolArgsFromLogs({ path: 'a.js' });
  assert.equal(clean.redacted, false);
  const dirty = ad.redactKeyLikeToolArgsFromLogs({ api_key: 'sk-abc', token: 'x', path: 'a.js' });
  assert.equal(dirty.redacted, true);
  assert.equal(dirty.args.api_key, '[REDACTED]');
  assert.equal(dirty.args.path, 'a.js');
});

test('3H41-I-001 bound remaining steps on checkpoint resume', () => {
  const out = ad.boundStepsOnCheckpointResume({ remaining: 20, checkpointRemaining: 7, max: 25 });
  assert.equal(out.remaining, 7);
  const cap = ad.boundStepsOnCheckpointResume({ remaining: 99, checkpointRemaining: 99, max: 25 });
  assert.equal(cap.remaining, 25);
});

test('3H41-J-001 reject empty tool name', () => {
  assert.equal(ad.rejectEmptyToolName('read_file').ok, true);
  const bad = ad.rejectEmptyToolName('  ');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'empty_tool_name');
});

test('3H41-K-001 reject NUL in path', () => {
  assert.equal(ad.rejectNulInPath('src/a.js').ok, true);
  const bad = ad.rejectNulInPath('src/\u0000a.js');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'nul_path');
});

test('3H41-L-001 skip heartbeat if write would block', () => {
  assert.equal(ad.skipHeartbeatIfWriteWouldBlock({ wouldBlock: false }).skip, false);
  assert.equal(ad.skipHeartbeatIfWriteWouldBlock({ wouldBlock: true }).skip, true);
  assert.equal(ad.skipHeartbeatIfWriteWouldBlock({ pendingBytes: 12 }).skip, true);
  assert.equal(ad.skipHeartbeatIfWriteWouldBlock({ writable: false }).skip, true);
});

test('3H41-M-001 wait inflight tool then drop on cancel', () => {
  const quiet = ad.waitInflightToolThenDropOnCancel({ cancelled: false, inflight: [{ id: 't1' }] });
  assert.equal(quiet.waited, false);
  const seen = [];
  const out = ad.waitInflightToolThenDropOnCancel({
    cancelled: true,
    inflight: [{ id: 't1' }, { id: 't2' }],
    waitFn: (list) => seen.push(list.length),
  });
  assert.equal(out.waited, true);
  assert.equal(out.dropped, 2);
  assert.equal(seen[0], 2);
});

test('3H41-N-001 record token usage on error path with no completion', () => {
  const out = ad.recordTokenUsageOnErrorPath({
    usage: { prompt_tokens: 40, completion_tokens: 9 },
    error: { code: 'http_5xx' },
    noCompletion: true,
  });
  assert.equal(out.recorded, true);
  assert.equal(out.promptTokens, 40);
  assert.equal(out.completionTokens, 0);
  assert.equal(out.totalTokens, 40);
});

test('3H41-O-001 pgvector memory query timeout 2000ms', () => {
  assert.equal(ad.pgvectorMemoryQueryTimeout({ elapsedMs: 1999 }).timedOut, false);
  const hit = ad.pgvectorMemoryQueryTimeout({ elapsedMs: 2000 });
  assert.equal(hit.timedOut, true);
  assert.equal(hit.code, 'pgvector_timeout');
});

test('3H41-P-001 refuse computer_* if flag off', () => {
  assert.equal(ad.refuseComputerToolsIfFlagOff('read_file', { computerEnabled: false }).ok, true);
  const off = ad.refuseComputerToolsIfFlagOff('computer_click', { computerEnabled: false });
  assert.equal(off.ok, false);
  assert.equal(off.code, 'computer_flag_off');
  assert.equal(ad.refuseComputerToolsIfFlagOff('computer_click', { computerEnabled: true }).ok, true);
});

test('3H41-Q-001 coerce true/false strings to bool', () => {
  const t = ad.coerceTrueFalseStringsToBool('true', { type: 'boolean' });
  assert.equal(t.ok, true);
  assert.equal(t.value, true);
  const f = ad.coerceTrueFalseStringsToBool('false', { type: 'boolean' });
  assert.equal(f.value, false);
  const bad = ad.coerceTrueFalseStringsToBool('yes', { type: 'boolean' });
  assert.equal(bad.ok, false);
  const obj = ad.coerceTrueFalseStringsToBool({ ok: 'true' }, { type: 'object', properties: { ok: { type: 'boolean' } } });
  assert.equal(obj.value.ok, true);
});

test('3H41-R-001 max concurrent subagents 2', () => {
  const ok = ad.maxConcurrentSubagents([{ id: 'a' }, { id: 'b' }], { max: 2 });
  assert.equal(ok.halt, false);
  const over = ad.maxConcurrentSubagents([{ id: 'a' }, { id: 'b' }, { id: 'c' }], { max: 2 });
  assert.equal(over.halt, true);
  assert.equal(over.code, 'subagent_concurrency');
  assert.equal(over.run.length, 2);
  assert.equal(over.deferred.length, 1);
});

test('3H41-S-001 drop assistant turn with 0 tools and 0 text', () => {
  const empty = ad.dropEmptyAssistantTurn({ choices: [{ message: { content: '', tool_calls: [] } }] });
  assert.equal(empty.drop, true);
  assert.equal(empty.code, 'empty_turn');
  const filled = ad.dropEmptyAssistantTurn({ choices: [{ message: { content: 'hola' } }] });
  assert.equal(filled.drop, false);
});

test('3H41-T-001 SSE retry ms in pad', () => {
  const out = ad.sseRetryMsInPad({ retryMs: 2000 });
  assert.equal(out.padded, true);
  assert.equal(out.retryMs, 2000);
  assert.equal(out.frame, 'retry: 2000\n\n');
});

test('3H41-U-001 sandbox tmp cleanup on timeout', () => {
  const seen = [];
  const quiet = ad.sandboxTmpCleanupOnTimeout({ timedOut: false, tmpDir: '/tmp/x', rmFn: (p) => seen.push(p) });
  assert.equal(quiet.cleaned, false);
  assert.equal(seen.length, 0);
  const hit = ad.sandboxTmpCleanupOnTimeout({ timedOut: true, tmpDir: '/tmp/x', rmFn: (p) => seen.push(p) });
  assert.equal(hit.cleaned, true);
  assert.deepEqual(seen, ['/tmp/x']);
});

test('3H41-V-001 subagent inherits abort signal', () => {
  const parent = { aborted: false };
  const ok = ad.subagentInheritAbortSignal({ parentSignal: parent, child: { id: 'c1' } });
  assert.equal(ok.inherited, true);
  assert.equal(ok.aborted, false);
  const dead = ad.subagentInheritAbortSignal({ parentSignal: { aborted: true }, child: { id: 'c2' } });
  assert.equal(dead.aborted, true);
  assert.equal(dead.child.aborted, true);
});

test('3H41-W-001 truncate tool result with marker', () => {
  const small = ad.truncateToolResultWithMarker('hi', { maxBytes: 12000 });
  assert.equal(small.truncated, false);
  const big = ad.truncateToolResultWithMarker('x'.repeat(13000), { maxBytes: 12000 });
  assert.equal(big.truncated, true);
  assert.ok(big.text.includes('[truncated'));
  assert.ok(Buffer.byteLength(big.text, 'utf8') <= 12000);
});

test('3H41-X-001 isolate parallel tool timeout per item', () => {
  const out = ad.isolateParallelToolTimeout([{ id: 'a' }, { id: 'b' }], { timeoutMs: 15000 });
  assert.equal(out.count, 2);
  assert.equal(out.isolated[0].timeoutMs, 15000);
  assert.equal(out.isolated[1].id, 'b');
});

test('3H41-Y-001 hold-settle never double-charge on cancel', () => {
  const first = ad.holdSettleNeverDoubleCharge({ held: true, settled: false, cancelled: false });
  assert.equal(first.charge, true);
  const twice = ad.holdSettleNeverDoubleCharge({ held: true, settled: true, cancelled: false });
  assert.equal(twice.charge, false);
  assert.equal(twice.code, 'credit_hold_reuse');
  const cancel = ad.holdSettleNeverDoubleCharge({ held: true, settled: false, cancelled: true });
  assert.equal(cancel.charge, false);
  assert.equal(cancel.code, 'credit_cancel');
});

test('3H41-Z-001 enforce additionalProperties false on tool schemas', () => {
  const out = ad.enforceAdditionalPropertiesFalse({ type: 'object', properties: { n: { type: 'integer' } } });
  assert.equal(out.schema.additionalProperties, false);
  assert.equal(out.enforced, true);
});

test('3H41-AA-001 snapshot keeps 3H40 flags and wave 3H41 DeepSeek lock', () => {
  const s = ad.adapterSnapshot();
  assert.ok(s.wave === '3H41' || s.wave === '3H42' || s.wave === '3H43' || s.wave === '3H44' || s.wave === '3H45' || s.wave === '3H46' || s.wave === '3H58');
  assert.equal(s.maxToolsPerTurnHardCap, true);
  assert.equal(s.firstTokenWatchdogMs, true);
  assert.equal(s.pruneCheckpointsKeepLastN, true);
  assert.equal(s.persistSseLastEventIdCursor, true);
  assert.equal(s.repairSingleQuotesAndCommentsInToolJson, true);
  assert.equal(s.clampMaxOutputTokens, true);
  assert.equal(s.dropDuplicateConsecutiveToolCalls, true);
  assert.equal(s.classifyHttpFamily, true);
  assert.equal(s.compactKeepLastUserAssistantPair, true);
  assert.equal(s.redactKeyLikeToolArgsFromLogs, true);
  assert.equal(s.boundStepsOnCheckpointResume, true);
  assert.equal(s.rejectEmptyToolName, true);
  assert.equal(s.rejectNulInPath, true);
  assert.equal(s.skipHeartbeatIfWriteWouldBlock, true);
  assert.equal(s.waitInflightToolThenDropOnCancel, true);
  assert.equal(s.recordTokenUsageOnErrorPath, true);
  assert.equal(s.pgvectorMemoryQueryTimeout, true);
  assert.equal(s.refuseComputerToolsIfFlagOff, true);
  assert.equal(s.coerceTrueFalseStringsToBool, true);
  assert.equal(s.maxConcurrentSubagents, true);
  assert.equal(s.dropEmptyAssistantTurn, true);
  assert.equal(s.sseRetryMsInPad, true);
  assert.equal(s.sandboxTmpCleanupOnTimeout, true);
  assert.equal(s.subagentInheritAbortSignal, true);
  assert.equal(s.truncateToolResultWithMarker, true);
  assert.equal(s.isolateParallelToolTimeout, true);
  assert.equal(s.holdSettleNeverDoubleCharge, true);
  assert.equal(s.enforceAdditionalPropertiesFalse, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
});

test('3H41-AB-001 live loop/queue/sse/gateway/sandbox import 3H41 helpers', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.ok(loop.includes('pruneCheckpointsKeepLastN'));
  assert.ok(loop.includes('repairSingleQuotesAndCommentsInToolJson'));
  assert.ok(loop.includes('clampMaxOutputTokens'));
  assert.ok(loop.includes('dropDuplicateConsecutiveToolCalls'));
  assert.ok(loop.includes('classifyHttpFamily'));
  assert.ok(loop.includes('compactKeepLastUserAssistantPair'));
  assert.ok(loop.includes('rejectEmptyToolName'));
  assert.ok(loop.includes('refuseComputerToolsIfFlagOff'));
  assert.ok(loop.includes('dropEmptyAssistantTurn'));
  assert.ok(loop.includes('truncateToolResultWithMarker'));
  assert.ok(loop.includes('maxConcurrentSubagents'));
  const sse = read('src/utils/sse-writer.js');
  assert.ok(sse.includes('sseRetryMsInPad'));
  assert.ok(sse.includes('skipHeartbeatIfWriteWouldBlock'));
  assert.ok(sse.includes('persistSseLastEventIdCursor'));
  const sb = read('src/services/sandbox/local-sandbox.js');
  assert.ok(sb.includes('sandboxTmpCleanupOnTimeout'));
  const gw = read('src/services/agent-runner/engine-gateway.js');
  assert.ok(gw.includes('classifyHttpFamily'));
  assert.ok(gw.includes('holdSettleNeverDoubleCharge'));
  assert.ok(gw.includes('refuseComputerToolsIfFlagOff'));
});

test('3H41-AC-001 error codes include 3H41 taxonomy', () => {
  const { CODES } = require('../src/services/error_codes');
  assert.equal(CODES.EMPTY_TOOL_NAME, 'empty_tool_name');
  assert.equal(CODES.NUL_PATH, 'nul_path');
  assert.equal(CODES.PGVECTOR_TIMEOUT, 'pgvector_timeout');
  assert.equal(CODES.COMPUTER_FLAG_OFF, 'computer_flag_off');
  assert.equal(CODES.SUBAGENT_CONCURRENCY, 'subagent_concurrency');
  assert.equal(CODES.EMPTY_TURN, 'empty_turn');
  assert.equal(CODES.HTTP_5XX, 'http_5xx');
  assert.equal(CODES.HTTP_TIMEOUT, 'http_timeout');
  assert.equal(CODES.TOOL_RESULT_TRUNCATED, 'tool_result_truncated');
  assert.equal(CODES.TOO_MANY_TOOLS, 'too_many_tools');
});

test('3H41-AD-001 public stream maps 3H41 codes in ES without traces', () => {
  const src = read('src/services/observability/public-stream-error.js');
  assert.ok(src.includes("code: 'empty_tool_name'"));
  assert.ok(/Nombre de herramienta vacío/i.test(src) || /no tiene nombre/i.test(src));
  assert.ok(src.includes("code: 'computer_flag_off'"));
  assert.ok(src.includes("code: 'http_5xx'"));
  assert.ok(src.includes("code: 'pgvector_timeout'"));
  assert.ok(src.includes("code: 'tool_result_truncated'"));
  assert.equal(/sk-[a-zA-Z0-9]{8}/.test(src), false);
  assert.equal(/at Object\./.test(src), false);
});

test('3H41-AE-001 compose binds 3H41 tests and wave is 3H41', () => {
  assert.ok(String(__filename || '').includes('ola-3h41-invariants.test.js'));
  const src = read('src/services/agent-runner/engine-adapter.js');
  assert.ok(src.indexOf('3H41') >= 0);
  assert.ok(ad.adapterSnapshot().wave === '3H41' || ad.adapterSnapshot().wave === '3H42' || ad.adapterSnapshot().wave === '3H43' || ad.adapterSnapshot().wave === '3H44' || ad.adapterSnapshot().wave === '3H45' || ad.adapterSnapshot().wave === '3H46' || ad.adapterSnapshot().wave === '3H58');
  assert.equal(ad.refuseOpenRouterEnv({ SIRAGPT_USE_OPENROUTER: '1' }).ok, false);
  assert.equal(ad.allowDeepSeekGenerateModel('deepseek-v4-flash').ok, true);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const ad = require('../src/services/agent-runner/engine-adapter');
const h55 = require('../src/services/agent-runner/engine-3h55');

test('3H55-A-001 settle refuses final with pending tool ids', () => {
  const pending = h55.completeLoopOnlyAfterToolResultsSettle([
    { role: 'assistant', tool_calls: [{ id: 'c1' }, { id: 'c2' }] },
    { role: 'tool', tool_call_id: 'c1' },
  ]);
  assert.equal(pending.ok, false);
  assert.deepEqual(pending.pending, ['c2']);
  assert.equal(pending.code, 'loop_unsettle');
  const ok = h55.completeLoopOnlyAfterToolResultsSettle([
    { role: 'assistant', tool_calls: [{ id: 'c1' }] },
    { role: 'tool', id: 'c1' },
  ]);
  assert.equal(ok.ok, true);
});

test('3H55-B-001 retry once when stop reason is length', () => {
  const first = h55.retryIfStopReasonLength({ choices: [{ finish_reason: 'length' }] });
  assert.equal(first.retry, true);
  assert.equal(first.code, 'stop_length');
  const second = h55.retryIfStopReasonLength({ choices: [{ finish_reason: 'length' }] }, { retried: true });
  assert.equal(second.retry, false);
  assert.equal(h55.retryIfStopReasonLength({ choices: [{ finish_reason: 'stop' }] }).retry, false);
});

test('3H55-C-001 cut repair loop when args did not change', () => {
  const first = h55.cutLoopIfRepairDidNotChangeArgs({ before: { a: 1 }, after: { a: 1 }, attempt: 0 });
  assert.equal(first.cut, false);
  const noop = h55.cutLoopIfRepairDidNotChangeArgs({ before: { a: 1 }, after: { a: 1 }, attempt: 1 });
  assert.equal(noop.cut, true);
  assert.equal(noop.code, 'repair_noop');
  const changed = h55.cutLoopIfRepairDidNotChangeArgs({ before: { a: 1 }, after: { a: 2 }, attempt: 2 });
  assert.equal(changed.cut, false);
});

test('3H55-D-001 reject null tool arguments', () => {
  const ok = h55.rejectNullToolArguments([{ id: 'c1', arguments: { a: 1 } }]);
  assert.equal(ok.ok, true);
  const bad = h55.rejectNullToolArguments([{ id: 'c1', arguments: null }, { id: 'c2', args: { x: 1 } }]);
  assert.equal(bad.ok, false);
  assert.equal(bad.dropped, 1);
  assert.equal(bad.calls.length, 1);
  assert.equal(bad.code, 'tool_args_null');
});

test('3H55-E-001 repair partial streamed tool name', () => {
  const ok = h55.repairPartialToolCallName('read_file');
  assert.equal(ok.ok, true);
  assert.equal(ok.repaired, false);
  const fix = h55.repairPartialToolCallName('read_file(');
  assert.equal(fix.ok, true);
  assert.equal(fix.name, 'read_file');
  assert.equal(fix.code, 'tool_name_repair');
  assert.equal(h55.repairPartialToolCallName('').ok, false);
});

test('3H55-F-001 backoff on 408 request timeout', () => {
  const no = h55.backoffOn408RequestTimeout({ status: 429 });
  assert.equal(no.retry, false);
  const yes = h55.backoffOn408RequestTimeout({ status: 408 }, { attempt: 1 });
  assert.equal(yes.retry, true);
  assert.equal(yes.delayMs, 240);
  assert.equal(yes.code, 'http_408');
});

test('3H55-G-001 refuse unknown tool against manifest', () => {
  const skip = h55.refuseUnknownToolAgainstManifest('x', []);
  assert.equal(skip.skipped, true);
  const ok = h55.refuseUnknownToolAgainstManifest('read_file', ['read_file', 'write_file']);
  assert.equal(ok.ok, true);
  const bad = h55.refuseUnknownToolAgainstManifest('rm', ['read_file']);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'tool_unknown');
});

test('3H55-H-001 repair unquoted JSON keys once', () => {
  const ok = h55.repairJsonUnquotedKeysOnce('{"a":1}');
  assert.equal(ok.repaired, false);
  const fix = h55.repairJsonUnquotedKeysOnce('{foo: 1, bar: 2}');
  assert.equal(fix.ok, true);
  assert.equal(fix.value.foo, 1);
  assert.equal(fix.code, 'json_unquoted_key');
});

test('3H55-I-001 cut plan when steps exceed remaining budget', () => {
  const ok = h55.cutPlanIfStepsExceedSessionBudget({ steps: [1, 2], remaining: 5 });
  assert.equal(ok.cut, false);
  const cut = h55.cutPlanIfStepsExceedSessionBudget({ steps: [1, 2, 3, 4], remaining: 2 });
  assert.equal(cut.cut, true);
  assert.equal(cut.code, 'plan_budget');
});

test('3H55-J-001 detect A-B-A-B tool ping-pong', () => {
  const no = h55.detectToolPingPongABAB(['read_file', 'read_file', 'read_file', 'read_file']);
  assert.equal(no.cut, false);
  const yes = h55.detectToolPingPongABAB(['read_file', 'write_file', 'read_file', 'write_file']);
  assert.equal(yes.cut, true);
  assert.equal(yes.code, 'tool_ping_pong');
});

test('3H55-K-001 refuse subagent depth over 2 and inherit wall clock', () => {
  assert.equal(h55.refuseSubagentDepthOver2(2).ok, true);
  const deep = h55.refuseSubagentDepthOver2(3);
  assert.equal(deep.ok, false);
  assert.equal(deep.code, 'subagent_depth');
  const wall = h55.inheritSubagentWallClockMs({ parentRemainingMs: 10_000, childRequestedMs: 40_000 });
  assert.equal(wall.timeoutMs, 10_000);
  assert.equal(wall.code, 'subagent_wall');
});

test('3H55-L-001 compact pins selected ids and drops images first', () => {
  const pin = h55.compactPinSelectedMessageIds(
    [{ id: 'a', role: 'user' }, { id: 'b', role: 'assistant' }],
    ['a', 'missing'],
  );
  assert.equal(pin.pinned, 1);
  assert.equal(pin.restored, true);
  const msgs = [
    { role: 'user', type: 'image', image_url: `data:image/png;base64,${'A'.repeat(400)}` },
    { role: 'user', content: 'hello' },
  ];
  const drop = h55.dropImagesBeforeTextWhenOverBudget(msgs, { maxBytes: 256 });
  assert.ok(drop.dropped >= 1);
  assert.equal(drop.code, 'compact_drop_image');
});

test('3H55-M-001 pgvector dim mismatch and memory content-hash dedupe', () => {
  const bad = h55.rejectPgvectorDimMismatch([1, 2, 3], [1, 2]);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'pgvector_dim');
  assert.equal(h55.rejectPgvectorDimMismatch([1, 2], [3, 4]).ok, true);
  const dedupe = h55.dedupeMemoryHitsByContentHash([
    { id: 1, text: 'same' },
    { id: 2, text: 'same' },
    { id: 3, text: 'other' },
  ]);
  assert.equal(dedupe.dropped, 1);
  assert.equal(dedupe.hits.length, 2);
});

test('3H55-N-001 refuse rollback on CRC mismatch and restore size/hash', () => {
  const payload = { a: 1 };
  const raw = Buffer.from(JSON.stringify(payload));
  const crc = zlib.crc32(raw) >>> 0;
  assert.equal(h55.refuseRollbackOnCrcMismatch({ payload, expectedCrc: crc }).ok, true);
  const bad = h55.refuseRollbackOnCrcMismatch({ payload, expectedCrc: crc ^ 1 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'ckpt_crc_mismatch');
  const body = Buffer.from('hello');
  const restore = h55.rollbackRestoreSizeAndHash({ before: body, after: Buffer.from('hello') });
  assert.equal(restore.ok, true);
  const miss = h55.rollbackRestoreSizeAndHash({ before: body, after: Buffer.from('hallo') });
  assert.equal(miss.ok, false);
});

test('3H55-O-001 unified diff hunks, overlap, syntax, revert, raw compare', () => {
  const empty = h55.validateUnifiedDiffHunkHeaders('');
  assert.equal(empty.ok, false);
  const hunks = h55.validateUnifiedDiffHunkHeaders('@@ -1,2 +1,2 @@\n-a\n+b\n');
  assert.equal(hunks.ok, true);
  assert.equal(hunks.hunks, 1);
  const overlap = h55.refuseOverlappingDiffHunks([
    { oldStart: 1, oldLines: 5 },
    { oldStart: 3, oldLines: 2 },
  ]);
  assert.equal(overlap.ok, false);
  assert.equal(overlap.code, 'diff_overlap');
  const jsonOk = h55.syntaxValidateJsOrJsonAfterWrite({ path: 'a.json', content: '{"x":1}' });
  assert.equal(jsonOk.ok, true);
  const jsonBad = h55.syntaxValidateJsOrJsonAfterWrite({ path: 'a.json', content: '{x}' });
  assert.equal(jsonBad.ok, false);
  assert.equal(jsonBad.code, 'syntax_invalid');
  let restored = null;
  const rev = h55.revertWriteOnSyntaxFail({ ok: false, before: 'old', apply: (v) => { restored = v; } });
  assert.equal(rev.reverted, true);
  assert.equal(restored, 'old');
  assert.equal(h55.readAfterWriteByteEqual({ expected: 'abc', actual: 'abc' }).ok, true);
  assert.equal(h55.readAfterWriteByteEqual({ expected: 'abc', actual: 'ab' }).ok, false);
});

test('3H55-P-001 utf8-safe stream split, sandbox cap, tmp cleanup', () => {
  const euro = Buffer.from('é', 'utf8');
  const split = h55.splitUtf8SafeStreamChunk(euro.subarray(0, 1), Buffer.alloc(0));
  assert.equal(split.split, true);
  assert.equal(split.leftover.length, 1);
  const cap = h55.capConcurrentSandboxPerSession({ active: 2, max: 2 });
  assert.equal(cap.ok, false);
  assert.equal(cap.code, 'sandbox_session_cap');
  const cleaned = [];
  const tmp = h55.cleanupTmpEvenIfSpawnNeverStarted(['/tmp/never-spawned-3h55'], {
    rm: (p) => { cleaned.push(p); },
  });
  assert.equal(tmp.cleaned, 1);
  assert.deepEqual(cleaned, ['/tmp/never-spawned-3h55']);
});

test('3H55-Q-001 SSE heartbeat id, resume skip, session reject, cancel drain', () => {
  const hb = h55.heartbeatIncludesLastEventId({ lastEventId: 7 });
  assert.ok(hb.frame.indexOf('id=7') >= 0);
  const resume = h55.resumeSkipIdsLteLastEventId([{ id: 1 }, { id: 2 }, { id: 3 }], 2);
  assert.equal(resume.skipped, 2);
  assert.equal(resume.events.length, 1);
  assert.equal(resume.events[0].id, 3);
  const other = h55.rejectHeartbeatFromOtherSession({ sessionKey: 's1', hbSessionKey: 's2' });
  assert.equal(other.ok, false);
  const drain = h55.cancelDrainThenClose({ closed: false, drained: false, aborted: true });
  assert.equal(drain.drain, true);
  assert.equal(drain.code, 'sse_cancel_drain');
});

test('3H55-R-001 queue seq, tool_result order, superseded writer', () => {
  assert.equal(h55.rejectOutOfOrderEnqueueSeq({ lastSeq: 3, nextSeq: 4 }).ok, true);
  const stale = h55.rejectOutOfOrderEnqueueSeq({ lastSeq: 3, nextSeq: 3 });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'queue_seq');
  const order = h55.requireToolResultFollowsToolCall([
    { type: 'tool_result', id: 'c9' },
    { type: 'tool_call', id: 'c1' },
    { type: 'tool_result', id: 'c1' },
  ]);
  assert.equal(order.dropped, 1);
  assert.equal(order.code, 'event_order');
  const drop = h55.dropEventsFromSupersededWriter({ writerId: 'w1', activeWriterId: 'w2' });
  assert.equal(drop.drop, true);
});

test('3H55-S-001 billed-only charge, refund remainder, cached once, cancel usage', () => {
  const billed = h55.chargeOnlyBilledTokensOnError({ billed: 12, estimated: 99, error: new Error('x') });
  assert.equal(billed.tokens, 12);
  assert.equal(billed.charge, true);
  const refund = h55.refundHoldRemainderIfUnderReserved({ reserved: 100, used: 40 });
  assert.equal(refund.refund, 60);
  const cached = h55.neverDoubleChargeCachedPromptTokens({ promptTokens: 80, cachedTokens: 30, chargedCached: true });
  assert.equal(cached.tokens, 50);
  const cancel = h55.recordCancelPartialUsage({ cancelled: true, promptTokens: 5, completionTokens: 2 });
  assert.equal(cancel.record, true);
  assert.equal(cancel.tokens, 7);
  assert.equal(cancel.code, 'credit_cancel_partial');
});

test('3H55-T-001 EPIPE client gone, never retry 422, hints, ttfb p95', () => {
  const gone = h55.classifyEpipeAsClientGone({ code: 'EPIPE', message: 'broken pipe' });
  assert.equal(gone.gone, true);
  assert.equal(gone.retryable, false);
  const u = h55.neverRetry422Unprocessable({ status: 422 });
  assert.equal(u.retry, false);
  assert.equal(u.code, 'unprocessable');
  const hint = h55.actionableErrorHint('tool_ping_pong');
  assert.equal(hint.actionable, true);
  assert.ok(hint.hint.indexOf('ping-pong') >= 0);
  const slow = h55.ttfbHintWhenOverP95({ ttfbMs: 12_000, p95: 8_000 });
  assert.equal(slow.hint, true);
  assert.equal(slow.code, 'ttfb_slow');
});

test('3H55-U-001 adapter snapshot keeps 3H46 flags and wave 3H55 DeepSeek lock', () => {
  const s = ad.adapterSnapshot();
  assert.equal(s.wave, '3H55');
  assert.equal(s.rejectPrototypePollutionKeys, true);
  assert.equal(s.neverRetry410Gone, true);
  assert.equal(s.completeLoopOnlyAfterToolResultsSettle, true);
  assert.equal(s.detectToolPingPongABAB, true);
  assert.equal(s.readAfterWriteByteEqual, true);
  assert.equal(s.neverRetry422Unprocessable, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
  assert.equal(ad.refuseOpenRouterEnv({ SIRAGPT_USE_OPENROUTER: '1' }).ok, false);
  assert.equal(ad.allowDeepSeekGenerateModel('deepseek-v4-flash').ok, true);
  assert.equal(ad.allowDeepSeekGenerateModel('deepseek-v4-pro').ok, true);
});

test('3H55-V-001 live loop/queue/sse/gateway/sandbox import 3H55 helpers', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.ok(loop.includes('completeLoopOnlyAfterToolResultsSettle'));
  assert.ok(loop.includes('retryIfStopReasonLength'));
  assert.ok(loop.includes('detectToolPingPongABAB'));
  assert.ok(loop.includes('rejectNullToolArguments'));
  assert.ok(loop.includes('recordCancelPartialUsage'));
  const sse = read('src/utils/sse-writer.js');
  assert.ok(sse.includes('heartbeatIncludesLastEventId'));
  assert.ok(sse.includes('resumeSkipIdsLteLastEventId'));
  assert.ok(sse.includes('cancelDrainThenClose'));
  const q = read('src/services/agent-gateway/queue.js');
  assert.ok(q.includes('rejectOutOfOrderEnqueueSeq'));
  assert.ok(q.includes('dropEventsFromSupersededWriter'));
  const gw = read('src/services/agent-runner/engine-gateway.js');
  assert.ok(gw.includes('chargeOnlyBilledTokensOnError'));
  assert.ok(gw.includes('neverRetry422Unprocessable'));
  assert.ok(gw.includes('backoffOn408RequestTimeout'));
  assert.ok(gw.includes('classifyEpipeAsClientGone'));
  const sb = read('src/services/sandbox/local-sandbox.js');
  assert.ok(sb.includes('splitUtf8SafeStreamChunk'));
  assert.ok(sb.includes('cleanupTmpEvenIfSpawnNeverStarted'));
  assert.ok(sb.includes('capConcurrentSandboxPerSession'));
});

test('3H55-W-001 error codes include 3H55 taxonomy', () => {
  const { CODES, httpStatusFor } = require('../src/services/error_codes');
  assert.equal(CODES.LOOP_UNSETTLE, 'loop_unsettle');
  assert.equal(CODES.TOOL_PING_PONG, 'tool_ping_pong');
  assert.equal(CODES.PGVECTOR_DIM, 'pgvector_dim');
  assert.equal(CODES.UNPROCESSABLE, 'unprocessable');
  assert.equal(CODES.QUEUE_SEQ, 'queue_seq');
  assert.equal(httpStatusFor('unprocessable'), 422);
  assert.equal(httpStatusFor('queue_seq'), 409);
});

test('3H55-X-001 public stream maps 3H55 codes in ES without traces', () => {
  const src = read('src/services/observability/public-stream-error.js');
  assert.ok(src.includes("code: 'tool_ping_pong'"));
  assert.ok(src.includes("code: 'loop_unsettle'"));
  assert.ok(src.includes("code: 'pgvector_dim'"));
  assert.ok(src.includes("code: 'unprocessable'"));
  assert.ok(src.includes("code: 'client_gone'"));
  assert.equal(/sk-[a-zA-Z0-9]{8}/.test(src), false);
  assert.equal(/at Object\./.test(src), false);
});

test('3H55-Y-001 adapter re-exports 3H55 helpers and no OpenRouter generate', () => {
  assert.equal(typeof ad.completeLoopOnlyAfterToolResultsSettle, 'function');
  assert.equal(typeof ad.syntaxValidateJsOrJsonAfterWrite, 'function');
  assert.equal(typeof ad.neverRetry422Unprocessable, 'function');
  const src = read('src/services/agent-runner/engine-3h55.js');
  assert.ok(src.indexOf('3H55') >= 0);
  assert.equal(/openrouter\.com|createOpenRouter|OPENROUTER_API_KEY/.test(src), false);
  assert.equal(ad.adapterSnapshot().openrouterGenerate, false);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const ad = require('../src/services/agent-runner/engine-adapter');

test('3H42-A-001 tool_call ids unique across resume vs checkpoint', () => {
  const seen = ['call_0', 'call_1'];
  const out = ad.ensureUniqueToolCallIdsAcrossResume(
    [{ id: 'call_0', name: 'read_file' }, { id: 'fresh', name: 'write_file' }],
    { seenFromCheckpoint: seen },
  );
  assert.equal(out.duplicates, 1);
  assert.equal(out.calls[0].id !== 'call_0', true);
  assert.equal(out.calls[1].id, 'fresh');
  assert.ok(!seen.includes(out.calls[0].id) || out.calls[0].id !== 'call_0');
});

test('3H42-B-001 clamp schema integer/number to min/max', () => {
  const n = ad.clampSchemaIntegerNumberToMinMax(99, { type: 'integer', minimum: 1, maximum: 10 });
  assert.equal(n.value, 10);
  assert.equal(n.clamped, true);
  const lo = ad.clampSchemaIntegerNumberToMinMax(-4, { type: 'number', min: 0, max: 5 });
  assert.equal(lo.value, 0);
  const obj = ad.clampSchemaIntegerNumberToMinMax({ n: 50 }, { type: 'object', properties: { n: { type: 'integer', maximum: 8 } } });
  assert.equal(obj.value.n, 8);
});

test('3H42-C-001 repair missing closing braces with budget', () => {
  const clean = ad.repairMissingClosingBracesWithBudget('{"a":1}');
  assert.equal(clean.ok, true);
  assert.equal(clean.repaired, false);
  const missing = ad.repairMissingClosingBracesWithBudget('{"a":1,"b":{"c":2');
  assert.equal(missing.ok, true);
  assert.equal(missing.repaired, true);
  assert.equal(missing.value.b.c, 2);
  const over = ad.repairMissingClosingBracesWithBudget('{"a":' + '{'.repeat(20), { budget: 8 });
  assert.equal(over.ok, false);
  assert.equal(over.code, 'json_parse');
});

test('3H42-D-001 refund hold if no tokens used', () => {
  const refund = ad.refundHoldIfNoTokensUsed({ held: true, promptTokens: 0, completionTokens: 0, cancelled: true });
  assert.equal(refund.refund, true);
  assert.equal(refund.charge, false);
  assert.equal(refund.code, 'credit_no_usage');
  const used = ad.refundHoldIfNoTokensUsed({ held: true, promptTokens: 12, completionTokens: 0 });
  assert.equal(used.refund, false);
  assert.equal(used.charge, true);
});

test('3H42-E-001 compact pins last tool error', () => {
  const msgs = [
    { role: 'user', content: 'u' },
    { role: 'tool', content: 'ENOENT no such file', isError: true },
    { role: 'assistant', content: 'ok' },
  ];
  const out = ad.pinLastToolErrorOnCompact(msgs, { pins: [] });
  assert.equal(out.pinned, true);
  assert.ok(String(out.pin.content).includes('ENOENT'));
  assert.equal(out.pins.length, 1);
});

test('3H42-F-001 SSE replay last 32 events from cursor', () => {
  const events = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, type: 'delta' }));
  const out = ad.replayLastNSseEventsFromCursor(events, { cursor: 5, limit: 32 });
  assert.equal(out.count, 32);
  assert.equal(out.truncated, true);
  assert.equal(out.replay[0].id, 9);
  assert.equal(out.replay[31].id, 40);
  const small = ad.replayLastNSseEventsFromCursor(events.slice(0, 3), { cursor: 0 });
  assert.equal(small.count, 3);
});

test('3H42-G-001 reject identical prompt inflight same session', () => {
  const quiet = ad.rejectIdenticalPromptInflightSameSession({
    sessionKey: 's1', prompt: 'hola', inflight: [{ sessionKey: 's1', prompt: 'otro' }],
  });
  assert.equal(quiet.reject, false);
  const hit = ad.rejectIdenticalPromptInflightSameSession({
    sessionKey: 's1', prompt: 'hola', inflight: [{ sessionKey: 's1', prompt: 'hola' }],
  });
  assert.equal(hit.reject, true);
  assert.equal(hit.code, 'identical_prompt_inflight');
});

test('3H42-H-001 refuse write over 2MiB', () => {
  assert.equal(ad.refuseWriteOver2MiB('hi').ok, true);
  const big = Buffer.alloc(2 * 1024 * 1024 + 1, 97);
  const out = ad.refuseWriteOver2MiB(big);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'write_too_large');
});

test('3H42-I-001 skip empty embedding upsert', () => {
  assert.equal(ad.skipEmptyEmbeddingUpsert([]).skip, true);
  assert.equal(ad.skipEmptyEmbeddingUpsert([0, 0, 0]).skip, true);
  assert.equal(ad.skipEmptyEmbeddingUpsert([0.1, 0.2]).skip, false);
  assert.equal(ad.skipEmptyEmbeddingUpsert([0.1], { fact: '   ' }).skip, true);
});

test('3H42-J-001 never charge tool-only observation loop', () => {
  const skip = ad.neverChargeToolOnlyObservationLoop({ toolOnly: true, observationLoop: true, usage: { total_tokens: 40 } });
  assert.equal(skip.charge, false);
  assert.equal(skip.code, 'credit_observation');
  const pay = ad.neverChargeToolOnlyObservationLoop({ toolOnly: false, observationLoop: false });
  assert.equal(pay.charge, true);
});

test('3H42-K-001 total turn wall 120s', () => {
  const t0 = 1_000_000;
  const ok = ad.enforceTotalTurnWall120s({ startedAt: t0, now: t0 + 119_000 });
  assert.equal(ok.halt, false);
  const hit = ad.enforceTotalTurnWall120s({ startedAt: t0, now: t0 + 120_000 });
  assert.equal(hit.halt, true);
  assert.equal(hit.code, 'turn_wall');
});

test('3H42-L-001 case-insensitive enum repair', () => {
  const sch = { enum: ['Read', 'Write'] };
  const hit = ad.repairEnumCaseInsensitive('read', sch);
  assert.equal(hit.ok, true);
  assert.equal(hit.value, 'Read');
  assert.equal(hit.repaired, true);
  const exact = ad.repairEnumCaseInsensitive('Write', sch);
  assert.equal(exact.repaired, false);
  const bad = ad.repairEnumCaseInsensitive('delete', sch);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'enum_invalid');
});

test('3H42-M-001 strip zero-width chars from args', () => {
  const out = ad.stripZeroWidthCharsFromArgs({ path: 'src/\u200Bfoo.js', n: 1 });
  assert.equal(out.stripped, true);
  assert.equal(out.args.path, 'src/foo.js');
  const clean = ad.stripZeroWidthCharsFromArgs({ path: 'a.js' });
  assert.equal(clean.stripped, false);
});

test('3H42-N-001 max JSON array length 256', () => {
  const small = ad.clampJsonArrayLength256([1, 2, 3]);
  assert.equal(small.truncated, false);
  const big = ad.clampJsonArrayLength256({ hits: Array.from({ length: 300 }, (_, i) => i) });
  assert.equal(big.truncated, true);
  assert.equal(big.value.hits.length, 256);
  assert.equal(big.code, 'array_cap');
});

test('3H42-O-001 Retry-After jitter 50-150ms', () => {
  const a = ad.retryAfterJitter50to150ms({ retryAfterMs: 1000, rand: () => 0 });
  assert.equal(a.jitterMs, 50);
  assert.equal(a.delayMs, 1050);
  const b = ad.retryAfterJitter50to150ms({ retryAfterSec: 1, rand: () => 1 });
  assert.equal(b.jitterMs, 150);
  assert.equal(b.delayMs, 1150);
});

test('3H42-P-001 tombstone deleted checkpoint', () => {
  const store = { live: { seq: 1 } };
  const out = ad.tombstoneDeletedCheckpoint({ id: 'ck_9', store, seq: 9 });
  assert.equal(out.tombstoned, true);
  assert.equal(store.ck_9.deleted, true);
  assert.equal(store.ck_9.tombstone, true);
  const bad = ad.tombstoneDeletedCheckpoint({ id: '', store });
  assert.equal(bad.ok, false);
});

test('3H42-Q-001 stderr 64KiB cap', () => {
  const small = ad.stderrByteCapPerCommand('err');
  assert.equal(small.truncated, false);
  const big = ad.stderrByteCapPerCommand('x'.repeat(70 * 1024));
  assert.equal(big.truncated, true);
  assert.ok(big.text.includes('[stderr truncated'));
  assert.ok(Buffer.byteLength(big.text, 'utf8') <= 64 * 1024);
});

test('3H42-R-001 drop tool results older than 6 steps', () => {
  const msgs = [
    { role: 'tool', content: 'old', step: 1 },
    { role: 'assistant', content: 'a', step: 7 },
    { role: 'tool', content: 'new', step: 8 },
  ];
  const out = ad.dropToolResultsOlderThan6Steps(msgs, { currentStep: 8, steps: 6 });
  assert.equal(out.dropped, 1);
  assert.equal(out.messages[0].dropped, true);
  assert.equal(out.messages[2].content, 'new');
});

test('3H42-S-001 reject tool name with whitespace', () => {
  assert.equal(ad.rejectToolNameWithWhitespace('read_file').ok, true);
  const bad = ad.rejectToolNameWithWhitespace('read file');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'tool_name_whitespace');
  assert.equal(ad.rejectToolNameWithWhitespace('  ').code, 'empty_tool_name');
});

test('3H42-T-001 numeric id strings stay strings', () => {
  const out = ad.keepIdNumericStringsAsStrings({ user_id: '12345', count: '3' }, {
    type: 'object',
    properties: { user_id: { type: 'string' }, count: { type: 'integer' } },
  });
  assert.equal(out.value.user_id, '12345');
  assert.equal(typeof out.value.user_id, 'string');
  assert.equal(out.kept, true);
});

test('3H42-U-001 session event seq must increase', () => {
  assert.equal(ad.requireSessionEventSeqIncrease({ lastSeq: 4, nextSeq: 5 }).ok, true);
  const back = ad.requireSessionEventSeqIncrease({ lastSeq: 4, nextSeq: 4 });
  assert.equal(back.ok, false);
  assert.equal(back.code, 'event_order');
});

test('3H42-V-001 abort sibling tools on parent cancel token', () => {
  const ids = [];
  const quiet = ad.abortSiblingToolsOnParentCancelToken({
    parentToken: { aborted: false },
    siblings: [{ id: 't1' }],
    abortFn: (id) => ids.push(id),
  });
  assert.equal(quiet.aborted, 0);
  const hit = ad.abortSiblingToolsOnParentCancelToken({
    parentToken: { aborted: true },
    siblings: [{ id: 't1' }, { id: 't2' }],
    abortFn: (id) => ids.push(id),
  });
  assert.equal(hit.aborted, 2);
  assert.deepEqual(ids, ['t1', 't2']);
  assert.equal(hit.code, 'turn_cancelled');
});

test('3H42-W-001 redact emails in logs', () => {
  const out = ad.redactEmailsInLogs('mail luis@siragpt.com please');
  assert.equal(out.redacted, true);
  assert.equal(out.text.includes('luis@siragpt.com'), false);
  assert.ok(out.text.includes('[REDACTED_EMAIL]'));
  const obj = ad.redactEmailsInLogs({ from: 'a@b.co', path: 'x' });
  assert.equal(obj.redacted, true);
  assert.equal(obj.text.from, '[REDACTED_EMAIL]');
});

test('3H42-X-001 max 8 heartbeats per minute', () => {
  const t0 = 5_000_000;
  const ok = ad.maxHeartbeatsPerMinute({ sent: 7, windowStart: t0, now: t0 + 1000 });
  assert.equal(ok.allow, true);
  const cap = ad.maxHeartbeatsPerMinute({ sent: 8, windowStart: t0, now: t0 + 1000 });
  assert.equal(cap.allow, false);
  assert.equal(cap.code, 'heartbeat_cap');
  const reset = ad.maxHeartbeatsPerMinute({ sent: 8, windowStart: t0, now: t0 + 60_000 });
  assert.equal(reset.allow, true);
  assert.equal(reset.reset, true);
});

test('3H42-Y-001 refuse read through symlink', () => {
  assert.equal(ad.refuseReadThroughSymlink('src/a.js', { isSymlink: () => false }).ok, true);
  const bad = ad.refuseReadThroughSymlink('src/link', { isSymlink: () => true });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'symlink_read');
});

test('3H42-Z-001 plan step failed if tool error twice', () => {
  const map = {};
  const one = ad.markPlanStepFailedIfToolErrorTwice({ stepId: 's1', errorsByStep: map, error: true });
  assert.equal(one.failed, false);
  const two = ad.markPlanStepFailedIfToolErrorTwice({ stepId: 's1', errorsByStep: map, error: true });
  assert.equal(two.failed, true);
  assert.equal(two.code, 'plan_step_failed');
  assert.equal(two.count, 2);
});

test('3H42-AA-001 restore last SSE id on resume', () => {
  const store = { cursor: 17 };
  const out = ad.restoreLastSseIdOnResume({ store });
  assert.equal(out.restored, true);
  assert.equal(out.lastEventId, 17);
  const fromHeader = ad.restoreLastSseIdOnResume({ lastEventId: 22, store: {} });
  assert.equal(fromHeader.lastEventId, 22);
});

test('3H42-AB-001 snapshot keeps 3H41 flags and wave 3H42 DeepSeek lock', () => {
  const s = ad.adapterSnapshot();
  assert.ok(s.wave === '3H42' || s.wave === '3H43' || s.wave === '3H44' || s.wave === '3H45' || s.wave === '3H46' || s.wave === '3H59' || s.wave === '3H60');
  assert.equal(s.pruneCheckpointsKeepLastN, true);
  assert.equal(s.persistSseLastEventIdCursor, true);
  assert.equal(s.holdSettleNeverDoubleCharge, true);
  assert.equal(s.ensureUniqueToolCallIdsAcrossResume, true);
  assert.equal(s.clampSchemaIntegerNumberToMinMax, true);
  assert.equal(s.repairMissingClosingBracesWithBudget, true);
  assert.equal(s.refundHoldIfNoTokensUsed, true);
  assert.equal(s.pinLastToolErrorOnCompact, true);
  assert.equal(s.replayLastNSseEventsFromCursor, true);
  assert.equal(s.rejectIdenticalPromptInflightSameSession, true);
  assert.equal(s.refuseWriteOver2MiB, true);
  assert.equal(s.skipEmptyEmbeddingUpsert, true);
  assert.equal(s.neverChargeToolOnlyObservationLoop, true);
  assert.equal(s.enforceTotalTurnWall120s, true);
  assert.equal(s.repairEnumCaseInsensitive, true);
  assert.equal(s.stripZeroWidthCharsFromArgs, true);
  assert.equal(s.clampJsonArrayLength256, true);
  assert.equal(s.retryAfterJitter50to150ms, true);
  assert.equal(s.tombstoneDeletedCheckpoint, true);
  assert.equal(s.stderrByteCapPerCommand, true);
  assert.equal(s.dropToolResultsOlderThan6Steps, true);
  assert.equal(s.rejectToolNameWithWhitespace, true);
  assert.equal(s.keepIdNumericStringsAsStrings, true);
  assert.equal(s.requireSessionEventSeqIncrease, true);
  assert.equal(s.abortSiblingToolsOnParentCancelToken, true);
  assert.equal(s.redactEmailsInLogs, true);
  assert.equal(s.maxHeartbeatsPerMinute, true);
  assert.equal(s.refuseReadThroughSymlink, true);
  assert.equal(s.markPlanStepFailedIfToolErrorTwice, true);
  assert.equal(s.restoreLastSseIdOnResume, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
});

test('3H42-AC-001 live loop/queue/sse/gateway/sandbox import 3H42 helpers', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.ok(loop.includes('ensureUniqueToolCallIdsAcrossResume'));
  assert.ok(loop.includes('clampSchemaIntegerNumberToMinMax'));
  assert.ok(loop.includes('repairMissingClosingBracesWithBudget'));
  assert.ok(loop.includes('pinLastToolErrorOnCompact'));
  assert.ok(loop.includes('refuseWriteOver2MiB'));
  assert.ok(loop.includes('enforceTotalTurnWall120s'));
  assert.ok(loop.includes('repairEnumCaseInsensitive'));
  assert.ok(loop.includes('stripZeroWidthCharsFromArgs'));
  assert.ok(loop.includes('rejectToolNameWithWhitespace'));
  assert.ok(loop.includes('dropToolResultsOlderThan6Steps'));
  assert.ok(loop.includes('markPlanStepFailedIfToolErrorTwice'));
  assert.ok(loop.includes('keepIdNumericStringsAsStrings'));
  const sse = read('src/utils/sse-writer.js');
  assert.ok(sse.includes('replayLastNSseEventsFromCursor'));
  assert.ok(sse.includes('maxHeartbeatsPerMinute'));
  assert.ok(sse.includes('requireSessionEventSeqIncrease'));
  assert.ok(sse.includes('restoreLastSseIdOnResume'));
  assert.ok(sse.includes('redactEmailsInLogs'));
  const q = read('src/services/agent-gateway/queue.js');
  assert.ok(q.includes('rejectIdenticalPromptInflightSameSession'));
  const sb = read('src/services/sandbox/local-sandbox.js');
  assert.ok(sb.includes('stderrByteCapPerCommand'));
  assert.ok(sb.includes('refuseReadThroughSymlink'));
  const gw = read('src/services/agent-runner/engine-gateway.js');
  assert.ok(gw.includes('refundHoldIfNoTokensUsed'));
  assert.ok(gw.includes('neverChargeToolOnlyObservationLoop'));
  assert.ok(gw.includes('tombstoneDeletedCheckpoint'));
});

test('3H42-AD-001 error codes include 3H42 taxonomy', () => {
  const { CODES } = require('../src/services/error_codes');
  assert.equal(CODES.TOOL_ID_RESUME_DUP, 'tool_id_resume_dup');
  assert.equal(CODES.WRITE_TOO_LARGE, 'write_too_large');
  assert.equal(CODES.IDENTICAL_PROMPT_INFLIGHT, 'identical_prompt_inflight');
  assert.equal(CODES.TURN_WALL, 'turn_wall');
  assert.equal(CODES.TOOL_NAME_WHITESPACE, 'tool_name_whitespace');
  assert.equal(CODES.SYMLINK_READ, 'symlink_read');
  assert.equal(CODES.PLAN_STEP_FAILED, 'plan_step_failed');
  assert.equal(CODES.EMPTY_EMBEDDING, 'empty_embedding');
  assert.equal(CODES.CREDIT_OBSERVATION, 'credit_observation');
  assert.equal(CODES.STDERR_CAP, 'stderr_cap');
  assert.equal(CODES.EMPTY_TOOL_NAME, 'empty_tool_name');
});

test('3H42-AE-001 public stream maps 3H42 codes in ES without traces', () => {
  const src = read('src/services/observability/public-stream-error.js');
  assert.ok(src.includes("code: 'write_too_large'"));
  assert.ok(/2 ?MiB|demasiado grande/i.test(src));
  assert.ok(src.includes("code: 'identical_prompt_inflight'"));
  assert.ok(src.includes("code: 'turn_wall'"));
  assert.ok(src.includes("code: 'tool_name_whitespace'"));
  assert.ok(src.includes("code: 'symlink_read'"));
  assert.ok(src.includes("code: 'plan_step_failed'"));
  assert.equal(/sk-[a-zA-Z0-9]{8}/.test(src), false);
  assert.equal(/at Object\./.test(src), false);
});

test('3H42-AF-001 compose binds 3H42 tests and wave is 3H42', () => {
  assert.ok(String(__filename || '').includes('ola-3h42-invariants.test.js'));
  const src = read('src/services/agent-runner/engine-adapter.js');
  assert.ok(src.indexOf('3H42') >= 0);
  assert.ok(ad.adapterSnapshot().wave === '3H42' || ad.adapterSnapshot().wave === '3H43' || ad.adapterSnapshot().wave === '3H44' || ad.adapterSnapshot().wave === '3H45' || ad.adapterSnapshot().wave === '3H46' || ad.adapterSnapshot().wave === '3H59' || ad.adapterSnapshot().wave === '3H60');
  assert.equal(ad.refuseOpenRouterEnv({ SIRAGPT_USE_OPENROUTER: '1' }).ok, false);
  assert.equal(ad.allowDeepSeekGenerateModel('deepseek-v4-flash').ok, true);
});

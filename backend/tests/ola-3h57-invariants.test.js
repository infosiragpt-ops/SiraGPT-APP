'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const ad = require('../src/services/agent-runner/engine-adapter');
const h57 = require('../src/services/agent-runner/engine-3h57');

test('3H57-A-001 refuse finish while tool results are pending', () => {
  const pending = h57.refuseFinishIfToolResultsPending({ pending: 2 });
  assert.equal(pending.ok, false);
  assert.equal(pending.code, 'tool_results_pending');
  const msgs = [
    { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'read' } }] },
  ];
  assert.equal(h57.refuseFinishIfToolResultsPending({ messages: msgs }).ok, false);
  msgs.push({ role: 'tool', tool_call_id: 'c1', content: 'ok' });
  assert.equal(h57.refuseFinishIfToolResultsPending({ messages: msgs }).ok, true);
});

test('3H57-B-001 cut loop when the same observation hash repeats thrice', () => {
  assert.equal(h57.cutLoopIfSameObservationHashThrice(['a', 'b']).cut, false);
  const cut = h57.cutLoopIfSameObservationHashThrice(['x', 'x', 'x']);
  assert.equal(cut.cut, true);
  assert.equal(cut.code, 'obs_hash_repeat');
});

test('3H57-C-001 stop after empty final + max repair attempts, refuse nameless tool', () => {
  const mid = h57.stopIfEmptyFinalAfterMaxRepairAttempts({ text: '', repairAttempts: 1, max: 3 });
  assert.equal(mid.stop, false);
  const end = h57.stopIfEmptyFinalAfterMaxRepairAttempts({ text: '  ', repairAttempts: 3 });
  assert.equal(end.stop, true);
  assert.equal(end.code, 'empty_final_repairs');
  const bad = h57.refuseAssistantToolCallWithoutName([{ id: 'c1', function: { arguments: '{}' } }]);
  assert.equal(bad.ok, false);
  assert.equal(h57.refuseAssistantToolCallWithoutName([{ function: { name: 'read' } }]).ok, true);
});

test('3H57-D-001 repair double-encoded JSON and coerce ISO dates', () => {
  const ok = h57.repairJsonDoubleEncodedOnce(JSON.stringify(JSON.stringify({ foo: 1 })));
  assert.equal(ok.ok, true);
  assert.equal(ok.repaired, true);
  assert.equal(ok.value.foo, 1);
  assert.equal(h57.repairJsonDoubleEncodedOnce('{"foo":1}').repaired, false);
  const iso = h57.coerceIsoDateStringOrRefuse('2026-08-23T12:00:00Z');
  assert.equal(iso.ok, true);
  assert.equal(h57.coerceIsoDateStringOrRefuse('not-a-date').ok, false);
});

test('3H57-E-001 503 Retry-After, type mismatch after coerce, strip control chars', () => {
  const ra = h57.backoffOn503RetryAfterHeader({ status: 503, headers: { 'retry-after': '2' } });
  assert.equal(ra.retry, true);
  assert.equal(ra.delayMs, 2000);
  assert.equal(ra.code, 'http_503_retry_after');
  const mismatch = h57.refuseToolIfArgTypeMismatchAfterCoerce({
    args: { n: '12' },
    schema: { properties: { n: { type: 'number' } } },
    coerced: true,
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'tool_type_mismatch');
  const cleaned = h57.stripControlCharsFromToolName('rea\u0000d');
  assert.equal(cleaned.ok, true);
  assert.equal(cleaned.name, 'read');
  assert.equal(cleaned.stripped, true);
});

test('3H57-F-001 subagent token inherit, zero-budget cut, fence, fanout', () => {
  const tok = h57.inheritSubagentMaxOutputTokens({ parentRemaining: 1024, childRequested: 4096 });
  assert.equal(tok.tokens, 1024);
  assert.equal(h57.cutSubagentIfTokenBudgetZero({ remaining: 0 }).cut, true);
  assert.equal(h57.refuseSubagentIfParentFenceLost({ parentFenceOk: false }).ok, false);
  assert.equal(h57.refuseSubagentIfParentFenceLost({ parentFenceOk: true, fenceToken: 'abc' }).ok, true);
  const fan = h57.capNestedSubagentFanout({ active: 3 });
  assert.equal(fan.ok, false);
  assert.equal(fan.code, 'subagent_fanout');
});

test('3H57-G-001 compact system+pins, pgvector dim, pin by score, dedupe hits', () => {
  const compact = h57.compactKeepLastSystemAndPinnedFacts([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'old', id: 'u1' },
    { role: 'user', content: 'new', id: 'u2' },
    { role: 'assistant', content: 'a', id: 'a1' },
  ], ['u1']);
  assert.ok(compact.messages.some((m) => m.role === 'system'));
  assert.ok(compact.messages.some((m) => m.id === 'u1'));
  assert.equal(h57.rejectPgvectorDimZeroOrNegative(0).ok, false);
  assert.equal(h57.rejectPgvectorDimZeroOrNegative(1536).ok, true);
  const pinned = h57.pinFactsWhenScoreAboveThreshold([{ id: 'f1', score: 0.9 }, { id: 'f2', score: 0.1 }]);
  assert.equal(pinned.pinned, 1);
  const dedupe = h57.dropDuplicateMemoryHitsById([{ id: 'a' }, { id: 'a' }, { id: 'b' }]);
  assert.equal(dedupe.dropped, 1);
  assert.equal(dedupe.hits.length, 2);
});

test('3H57-H-001 checkpoint checksum, tombstones, refuse future seq', () => {
  assert.equal(h57.refuseRollbackIfChecksumMismatch({ expected: 'aaa', actual: 'bbb' }).ok, false);
  assert.equal(h57.refuseRollbackIfChecksumMismatch({ expected: 'aaa', actual: 'aaa' }).ok, true);
  const kept = h57.checkpointKeepTombstonedSeqs([
    { seq: 1, tombstone: true },
    { seq: 2 }, { seq: 3 }, { seq: 4 },
  ], { keep: 2 });
  assert.ok(kept.checkpoints.some((c) => c.tombstone));
  assert.equal(h57.refuseRollbackIfTargetNewerThanHead({ targetSeq: 9, headSeq: 4 }).ok, false);
  assert.equal(h57.refuseRollbackIfTargetNewerThanHead({ targetSeq: 3, headSeq: 4 }).ok, true);
});

test('3H57-I-001 exact diffs: index line, byte hash, new-file minus, hunk counts', () => {
  assert.equal(h57.refuseDiffMissingIndexLine('@@ -1 +1 @@\n+hi').ok, false);
  const good = 'diff --git a/f b/f\nindex 111..222 100644\n--- a/f\n+++ b/f\n';
  assert.equal(h57.refuseDiffMissingIndexLine(good).ok, true);
  assert.equal(h57.verifyReadAfterWriteByteHash({ expected: 'hello', actual: 'hello' }).ok, true);
  assert.equal(h57.verifyReadAfterWriteByteHash({ expected: 'hello', actual: 'world' }).ok, false);
  const minusNew = 'new file mode 100644\n--- /dev/null\n+++ b/f\n@@ -0,0 +1,1 @@\n-oops\n';
  assert.equal(h57.refusePatchIfNewFileHasMinusLines(minusNew).ok, false);
  const hunk = '@@ -1,2 +1,2 @@\n line\n-old\n+new\n';
  assert.equal(h57.requireExactHunkHeaderCounts(hunk).ok, true);
});

test('3H57-J-001 sandbox stderr/nfiles/cwd jail', () => {
  assert.equal(h57.capSandboxStderrBytesPerCommand({ bytes: 99_000 }).ok, false);
  assert.equal(h57.capSandboxStderrBytesPerCommand({ bytes: 100 }).ok, true);
  assert.equal(h57.refuseSandboxOpenFilesOverCap({ openFiles: 80 }).ok, false);
  const jail = h57.requireSandboxCwdUnderWorkspace('/tmp/ws/child', '/tmp/ws');
  assert.equal(jail.ok, true);
  assert.equal(h57.requireSandboxCwdUnderWorkspace('/etc', '/tmp/ws').ok, false);
});

test('3H57-K-001 SSE skip acked, session mismatch, drop partial, skip hb', () => {
  const skip = h57.resumeReplaySkipAckedIds([{ id: 1 }, { id: 2 }, { id: 3 }], 2);
  assert.equal(skip.skipped, 2);
  assert.equal(skip.events.length, 1);
  assert.equal(h57.rejectResumeIfSessionIdMismatch({ sessionId: 'a', resumeSessionId: 'b' }).ok, false);
  assert.equal(h57.dropPartialSseFrameOnCancel({ cancelled: true, partial: true, dropped: false }).drop, true);
  assert.equal(h57.heartbeatSkipIfClientGone({ clientGone: true }).skip, true);
});

test('3H57-L-001 queue depth cap and deadline promote', () => {
  assert.equal(h57.rejectEnqueueIfQueueDepthOverCap({ depth: 8 }).ok, false);
  assert.equal(h57.rejectEnqueueIfQueueDepthOverCap({ depth: 2 }).ok, true);
  const promo = h57.promoteQueueIfDeadlineWithinMs({ remainingMs: 800, windowMs: 1500 });
  assert.equal(promo.promote, true);
  assert.equal(promo.code, 'queue_deadline');
});

test('3H57-M-001 credits: prompt-only cancel, settle-once, negative completion', () => {
  const skip = h57.neverChargeIfPromptOnlyAndCancelled({ cancelled: true, promptTokens: 40, completionTokens: 0 });
  assert.equal(skip.charge, false);
  assert.equal(h57.neverChargeIfPromptOnlyAndCancelled({ cancelled: false, promptTokens: 40, completionTokens: 12 }).charge, true);
  h57.resetSettledRequestIdsForTests();
  const first = h57.settleCreditsOncePerRequestId({ requestId: 'r1', terminal: true });
  assert.equal(first.settle, true);
  const second = h57.settleCreditsOncePerRequestId({ requestId: 'r1', terminal: true });
  assert.equal(second.settle, false);
  assert.equal(second.already, true);
  assert.equal(h57.refundIfCompletionTokensNegative({ completionTokens: -3 }).refund, true);
});

test('3H57-N-001 ECONNREFUSED, never retry 403, TTFB + p95 latency', () => {
  const net = h57.classifyEconnrefusedAsUnavailable({ code: 'ECONNREFUSED', message: 'connect' });
  assert.equal(net.unavailable, true);
  assert.equal(net.retryable, true);
  assert.equal(net.code, 'net_econnrefused');
  const f = h57.neverRetry403Forbidden({ status: 403 });
  assert.equal(f.retry, false);
  assert.equal(f.code, 'http_403');
  const hint = h57.actionableErrorHint('obs_hash_repeat');
  assert.equal(hint.actionable, true);
  const slow = h57.latencyHintWhenTtfbOverBudget({ ttfbMs: 12_000, budgetMs: 8_000 });
  assert.equal(slow.hint, true);
  h57.resetLatencySamplesForTests();
  const p95 = h57.recordStepLatencySampleP95(120);
  assert.equal(p95.recorded, true);
  assert.equal(p95.code, 'step_p95');
});

test('3H57-O-001 adapter snapshot keeps 3H46 flags and wave 3H57 DeepSeek lock', () => {
  const s = ad.adapterSnapshot();
  assert.equal(s.wave, '3H57');
  assert.equal(s.rejectPrototypePollutionKeys, true);
  assert.equal(s.neverRetry410Gone, true);
  assert.equal(s.refuseFinishIfToolResultsPending, true);
  assert.equal(s.cutLoopIfSameObservationHashThrice, true);
  assert.equal(s.rejectPgvectorDimZeroOrNegative, true);
  assert.equal(s.neverRetry403Forbidden, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
  assert.equal(ad.refuseOpenRouterEnv({ SIRAGPT_USE_OPENROUTER: '1' }).ok, false);
  assert.equal(ad.allowDeepSeekGenerateModel('deepseek-v4-flash').ok, true);
  assert.equal(ad.allowDeepSeekGenerateModel('deepseek-v4-pro').ok, true);
});

test('3H57-P-001 live loop/queue/sse/gateway/sandbox import 3H57 helpers', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.ok(loop.includes('refuseFinishIfToolResultsPending'));
  assert.ok(loop.includes('cutLoopIfSameObservationHashThrice'));
  assert.ok(loop.includes('repairJsonDoubleEncodedOnce'));
  assert.ok(loop.includes('stopIfEmptyFinalAfterMaxRepairAttempts'));
  assert.ok(loop.includes('dropPartialSseFrameOnCancel'));
  assert.ok(loop.includes('stallIfNoEvent20sMidStream'));
  assert.ok(loop.includes('stealStaleFence'));
  const sse = read('src/utils/sse-writer.js');
  assert.ok(sse.includes('resumeReplaySkipAckedIds'));
  assert.ok(sse.includes('rejectResumeIfSessionIdMismatch'));
  assert.ok(sse.includes('heartbeatSkipIfClientGone'));
  assert.ok(sse.includes('writeWithBackpressure'));
  assert.ok(sse.includes('setNoDelay'));
  const q = read('src/services/agent-gateway/queue.js');
  assert.ok(q.includes('rejectEnqueueIfQueueDepthOverCap'));
  assert.ok(q.includes('promoteQueueIfDeadlineWithinMs'));
  const gw = read('src/services/agent-runner/engine-gateway.js');
  assert.ok(gw.includes('neverChargeIfPromptOnlyAndCancelled'));
  assert.ok(gw.includes('neverRetry403Forbidden'));
  assert.ok(gw.includes('backoffOn503RetryAfterHeader'));
  assert.ok(gw.includes('classifyEconnrefusedAsUnavailable'));
  const sb = read('src/services/sandbox/local-sandbox.js');
  assert.ok(sb.includes('capSandboxStderrBytesPerCommand'));
  assert.ok(sb.includes('requireSandboxCwdUnderWorkspace'));
  assert.ok(sb.includes('refuseSandboxOpenFilesOverCap'));
});

test('3H57-Q-001 error codes include 3H57 taxonomy', () => {
  const { CODES, httpStatusFor, isRetryable } = require('../src/services/error_codes');
  assert.equal(CODES.TOOL_RESULTS_PENDING, 'tool_results_pending');
  assert.equal(CODES.OBS_HASH_REPEAT, 'obs_hash_repeat');
  assert.equal(CODES.PGVECTOR_DIM, 'pgvector_dim');
  assert.equal(CODES.HTTP_403, 'http_403');
  assert.equal(CODES.QUEUE_DEPTH, 'queue_depth');
  assert.equal(httpStatusFor('http_403'), 403);
  assert.equal(httpStatusFor('queue_depth'), 429);
  assert.equal(isRetryable('net_econnrefused'), true);
  assert.equal(isRetryable('http_503_retry_after'), true);
});

test('3H57-R-001 public stream maps 3H57 codes in ES without traces', () => {
  const src = read('src/services/observability/public-stream-error.js');
  assert.ok(src.includes("code: 'obs_hash_repeat'"));
  assert.ok(src.includes("code: 'tool_results_pending'"));
  assert.ok(src.includes("code: 'pgvector_dim'"));
  assert.ok(src.includes("code: 'http_403'"));
  assert.ok(src.includes("code: 'net_econnrefused'"));
  assert.ok(src.includes("code: 'queue_depth'"));
  assert.equal(/sk-[a-zA-Z0-9]{8}/.test(src), false);
  assert.equal(/at Object\./.test(src), false);
});

test('3H57-S-001 adapter fail-open re-exports 3H57 helpers and no OpenRouter generate', () => {
  assert.equal(typeof ad.refuseFinishIfToolResultsPending, 'function');
  assert.equal(typeof ad.requireExactHunkHeaderCounts, 'function');
  assert.equal(typeof ad.neverRetry403Forbidden, 'function');
  const adapterSrc = read('src/services/agent-runner/engine-adapter.js');
  assert.ok(adapterSrc.includes("try { return require('./engine-3h57'); } catch (_) { return {}; }"));
  const src = read('src/services/agent-runner/engine-3h57.js');
  assert.ok(src.indexOf('3H57') >= 0);
  assert.equal(/openrouter\.com|createOpenRouter|OPENROUTER_API_KEY/.test(src), false);
  assert.equal(ad.adapterSnapshot().openrouterGenerate, false);
  const helpers = Object.keys(h57).filter((k) => typeof h57[k] === 'function' && k !== 'snapshotFlags' && k !== 'resetSettledRequestIdsForTests' && k !== 'resetLatencySamplesForTests' && k !== 'actionableErrorHint');
  assert.ok(helpers.length >= 15 && helpers.length <= 40);
});

test('3H57-T-001 loop and sse-writer keep production durability stacks', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.ok(loop.includes('STREAM_STALL_MS_DEFAULT'));
  assert.ok(loop.includes('heartbeatFence'));
  assert.ok(loop.includes('__f7Image') || loop.includes('F7'));
  const sse = read('src/utils/sse-writer.js');
  assert.ok(sse.includes('X-Accel-Buffering'));
  assert.ok(sse.includes('writeWithBackpressure'));
  assert.ok(sse.includes(': connected'));
});

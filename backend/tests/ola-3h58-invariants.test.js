'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const ad = require('../src/services/agent-runner/engine-adapter');
const h58 = require('../src/services/agent-runner/engine-3h58');

test('3H58-A-001 refuse finish while plan todos are open', () => {
  const open = h58.refuseFinishIfPlanHasOpenTodos({ todos: [{ status: 'pending' }, { status: 'done' }] });
  assert.equal(open.ok, false);
  assert.equal(open.code, 'plan_todos_open');
  assert.equal(h58.refuseFinishIfPlanHasOpenTodos({ todos: [{ status: 'completed' }] }).ok, true);
});

test('3H58-B-001 cut loop when assistant content hash repeats twice', () => {
  assert.equal(h58.cutLoopIfSameAssistantContentHashTwice(['a']).cut, false);
  const cut = h58.cutLoopIfSameAssistantContentHashTwice(['x', 'x']);
  assert.equal(cut.cut, true);
  assert.equal(cut.code, 'assistant_hash_repeat');
});

test('3H58-C-001 stop after max empty assistant turns, refuse nameless+idless tool', () => {
  const mid = h58.stopIfMaxEmptyAssistantTurns({ emptyTurns: 1, max: 3 });
  assert.equal(mid.stop, false);
  const end = h58.stopIfMaxEmptyAssistantTurns({ emptyTurns: 3 });
  assert.equal(end.stop, true);
  assert.equal(end.code, 'empty_assistant_max');
  const bad = h58.refuseToolCallIfMissingCallIdAndName([{ function: { arguments: '{}' } }]);
  assert.equal(bad.ok, false);
  assert.equal(h58.refuseToolCallIfMissingCallIdAndName([{ id: 'c1', function: { name: 'read' } }]).ok, true);
});

test('3H58-D-001 repair plus-prefixed JSON and coerce emails', () => {
  const ok = h58.repairJsonPlusPrefixedOnce('+{"foo":1}');
  assert.equal(ok.ok, true);
  assert.equal(ok.repaired, true);
  assert.equal(ok.value.foo, 1);
  assert.equal(h58.repairJsonPlusPrefixedOnce('{"foo":1}').repaired, false);
  const email = h58.coerceEmailStringOrRefuse('User@Example.COM');
  assert.equal(email.ok, true);
  assert.equal(email.value, 'user@example.com');
  assert.equal(h58.coerceEmailStringOrRefuse('not-an-email').ok, false);
});

test('3H58-E-001 504 backoff, unknown enum after repair, strip zero-width', () => {
  const ra = h58.backoffOn504GatewayTimeout({ status: 504 }, { attempt: 1 });
  assert.equal(ra.retry, true);
  assert.equal(ra.code, 'http_504_retry');
  const mismatch = h58.refuseToolIfUnknownEnumAfterRepair({
    args: { mode: 'weird' },
    schema: { properties: { mode: { enum: ['a', 'b'] } } },
    repaired: true,
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'tool_enum_unknown');
  const cleaned = h58.stripZeroWidthFromToolName('rea\u200Bd');
  assert.equal(cleaned.ok, true);
  assert.equal(cleaned.name, 'read');
  assert.equal(cleaned.stripped, true);
});

test('3H58-F-001 subagent steps inherit, deadline cut, tokens, stdout cap', () => {
  const steps = h58.inheritSubagentMaxStepsFromParent({ parentRemaining: 4, childRequested: 12 });
  assert.equal(steps.steps, 4);
  assert.equal(h58.cutSubagentIfParentDeadlinePassed({ parentDeadlineAt: 10, now: 20 }).cut, true);
  assert.equal(h58.refuseSubagentIfParentTokensExhausted({ parentRemainingTokens: 0 }).ok, false);
  const cap = h58.capSubagentStdoutBytes16KiB({ bytes: 20_000 });
  assert.equal(cap.ok, false);
  assert.equal(cap.code, 'subagent_stdout');
});

test('3H58-G-001 compact orphans, pgvector norm, pin by access, empty vector', () => {
  const compact = h58.compactDropOrphanToolMessages([
    { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'read' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    { role: 'tool', tool_call_id: 'orphan', content: 'nope' },
  ]);
  assert.equal(compact.dropped, 1);
  assert.equal(h58.rejectPgvectorNonFiniteNorm([1, Number.NaN]).ok, false);
  assert.equal(h58.rejectPgvectorNonFiniteNorm([3, 4]).ok, true);
  const pinned = h58.pinFactsWhenAccessCountAtLeast([{ id: 'f1', accessCount: 5 }, { id: 'f2', accessCount: 1 }]);
  assert.equal(pinned.pinned, 1);
  const drop = h58.dropMemoryHitsWithEmptyVector([{ id: 'a', vector: [1] }, { id: 'b', embedding: [] }]);
  assert.equal(drop.dropped, 1);
});

test('3H58-H-001 checkpoint bytes, failed keep, unrelated dirty paths', () => {
  assert.equal(h58.refuseRollbackIfByteLengthMismatch({ expectedBytes: 10, actualBytes: 11 }).ok, false);
  assert.equal(h58.refuseRollbackIfByteLengthMismatch({ expectedBytes: 10, actualBytes: 10 }).ok, true);
  const kept = h58.checkpointKeepFailedAttemptsLastN([
    { seq: 1, failed: true },
    { seq: 2 }, { seq: 3, status: 'failed' }, { seq: 4 },
  ], { keep: 1 });
  assert.ok(kept.checkpoints.some((c) => c.failed || c.status === 'failed'));
  assert.equal(h58.refuseRollbackIfUnrelatedDirtyPaths({
    dirtyPaths: ['a.js', 'secret.env'],
    checkpointPaths: ['a.js'],
  }).ok, false);
});

test('3H58-I-001 exact diffs: from/to, sha prefix, rename delete, hunk start', () => {
  assert.equal(h58.refuseDiffMissingFromToFileHeaders('@@ -1 +1 @@\n+hi').ok, false);
  const good = '--- a/f\n+++ b/f\n@@ -1 +1 @@\n+hi\n';
  assert.equal(h58.refuseDiffMissingFromToFileHeaders(good).ok, true);
  assert.equal(h58.verifyReadAfterWriteSha256Prefix({ expected: 'hello', actual: 'hello' }).ok, true);
  assert.equal(h58.verifyReadAfterWriteSha256Prefix({ expected: 'hello', actual: 'world' }).ok, false);
  assert.equal(h58.refusePatchIfRenameMissingDelete('rename from a\nrename to b').ok, false);
  const hunk = h58.requireExactHunkStartLine({ hunk: '@@ -2,1 +2,1 @@', source: 'a\nb\n' });
  assert.equal(hunk.ok, true);
});

test('3H58-J-001 sandbox combined/host-path/uid jail', () => {
  assert.equal(h58.capSandboxCombinedStreamBytes({ stdoutBytes: 80_000, stderrBytes: 30_000 }).ok, false);
  assert.equal(h58.capSandboxCombinedStreamBytes({ stdoutBytes: 100, stderrBytes: 100 }).ok, true);
  assert.equal(h58.refuseSandboxEnvHostPathLeak({ HOME: '/root/.ssh' }).ok, false);
  assert.equal(h58.refuseSandboxEnvHostPathLeak({ PATH: '/usr/bin' }).ok, true);
  assert.equal(h58.requireSandboxNonRootUid({ uid: 0 }).ok, false);
  assert.equal(h58.requireSandboxNonRootUid({ uid: 1000 }).ok, true);
});

test('3H58-K-001 SSE ring window, writer gen, same-seq hb, stamp', () => {
  const skip = h58.resumeReplaySkipIdsOutsideRingWindow([{ id: 1 }, { id: 95 }, { id: 99 }], { lastEventId: 100, window: 8 });
  assert.equal(skip.skipped, 1);
  assert.equal(h58.rejectResumeIfWriterGenerationMismatch({ writerGeneration: 2, resumeGeneration: 3 }).ok, false);
  assert.equal(h58.dropHeartbeatIfSeqUnchanged({ lastSeq: 4, seq: 4 }).drop, true);
  const stamp = h58.heartbeatStampServerNowMs({ now: 123 });
  assert.equal(stamp.nowMs, 123);
  assert.match(stamp.comment, /t=123/);
});

test('3H58-L-001 queue duplicate requestId and hard-wait demote', () => {
  h58.resetInflightRequestIdsForTests();
  assert.equal(h58.rejectEnqueueIfDuplicateRequestId({ requestId: 'r1' }).ok, true);
  assert.equal(h58.rejectEnqueueIfDuplicateRequestId({ requestId: 'r1' }).ok, false);
  const demo = h58.demoteQueueIfWaitedOverHardCap({ waitedMs: 120_000, maxMs: 90_000 });
  assert.equal(demo.demote, true);
  assert.equal(demo.code, 'queue_hard_wait');
});

test('3H58-M-001 credits: stream-never-opened cancel, settle after done, prompt cap', () => {
  const skip = h58.neverChargeIfStreamNeverOpenedAndCancelled({ cancelled: true, streamOpened: false, completionTokens: 0 });
  assert.equal(skip.charge, false);
  assert.equal(h58.neverChargeIfStreamNeverOpenedAndCancelled({ cancelled: false, streamOpened: true, completionTokens: 12 }).charge, true);
  h58.resetSettledDoneEventsForTests();
  const first = h58.settleCreditsOnlyAfterDoneEvent({ requestId: 'r1', doneEvent: true });
  assert.equal(first.settle, true);
  const second = h58.settleCreditsOnlyAfterDoneEvent({ requestId: 'r1', doneEvent: true });
  assert.equal(second.settle, false);
  assert.equal(second.already, true);
  assert.equal(h58.refundIfPromptTokensExceedHardCap({ promptTokens: 200_000 }).refund, true);
});

test('3H58-N-001 ETIMEDOUT, never retry 409, p99 + p50 latency', () => {
  const net = h58.classifyEtimedoutAsTimeout({ code: 'ETIMEDOUT', message: 'connect' });
  assert.equal(net.timeout, true);
  assert.equal(net.retryable, true);
  assert.equal(net.code, 'net_etimedout');
  const f = h58.neverRetry409Conflict({ status: 409 });
  assert.equal(f.retry, false);
  assert.equal(f.code, 'http_409');
  const hint = h58.actionableErrorHint('assistant_hash_repeat');
  assert.equal(hint.actionable, true);
  const slow = h58.latencyHintWhenStepP99OverBudget({ elapsedMs: 25_000, budgetMs: 20_000 });
  assert.equal(slow.hint, true);
  h58.resetLatencySamplesForTests();
  const p50 = h58.recordTurnLatencySampleP50(120);
  assert.equal(p50.recorded, true);
  assert.equal(p50.code, 'turn_p50');
});

test('3H58-O-001 adapter snapshot keeps 3H46 flags and wave 3H58 DeepSeek lock', () => {
  const s = ad.adapterSnapshot();
  assert.equal(s.wave, '3H58');
  assert.equal(s.rejectPrototypePollutionKeys, true);
  assert.equal(s.neverRetry410Gone, true);
  assert.equal(s.refuseFinishIfPlanHasOpenTodos, true);
  assert.equal(s.cutLoopIfSameAssistantContentHashTwice, true);
  assert.equal(s.rejectPgvectorNonFiniteNorm, true);
  assert.equal(s.neverRetry409Conflict, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
  assert.equal(ad.refuseOpenRouterEnv({ SIRAGPT_USE_OPENROUTER: '1' }).ok, false);
  assert.equal(ad.allowDeepSeekGenerateModel('deepseek-v4-flash').ok, true);
  assert.equal(ad.allowDeepSeekGenerateModel('deepseek-v4-pro').ok, true);
});

test('3H58-P-001 live loop/queue/sse/gateway/sandbox import 3H58 helpers', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.ok(loop.includes('refuseFinishIfPlanHasOpenTodos'));
  assert.ok(loop.includes('cutLoopIfSameAssistantContentHashTwice'));
  assert.ok(loop.includes('repairJsonPlusPrefixedOnce'));
  assert.ok(loop.includes('stopIfMaxEmptyAssistantTurns'));
  assert.ok(loop.includes('neverChargeIfStreamNeverOpenedAndCancelled'));
  assert.ok(loop.includes('stallIfNoEvent20sMidStream'));
  assert.ok(loop.includes('stealStaleFence'));
  const sse = read('src/utils/sse-writer.js');
  assert.ok(sse.includes('resumeReplaySkipIdsOutsideRingWindow'));
  assert.ok(sse.includes('rejectResumeIfWriterGenerationMismatch'));
  assert.ok(sse.includes('dropHeartbeatIfSeqUnchanged'));
  assert.ok(sse.includes('writeWithBackpressure'));
  assert.ok(sse.includes('setNoDelay'));
  const q = read('src/services/agent-gateway/queue.js');
  assert.ok(q.includes('rejectEnqueueIfDuplicateRequestId'));
  assert.ok(q.includes('demoteQueueIfWaitedOverHardCap'));
  const gw = read('src/services/agent-runner/engine-gateway.js');
  assert.ok(gw.includes('neverChargeIfStreamNeverOpenedAndCancelled'));
  assert.ok(gw.includes('neverRetry409Conflict'));
  assert.ok(gw.includes('backoffOn504GatewayTimeout'));
  assert.ok(gw.includes('classifyEtimedoutAsTimeout'));
  const sb = read('src/services/sandbox/local-sandbox.js');
  assert.ok(sb.includes('capSandboxCombinedStreamBytes'));
  assert.ok(sb.includes('refuseSandboxEnvHostPathLeak'));
  assert.ok(sb.includes('requireSandboxNonRootUid'));
});

test('3H58-Q-001 error codes include 3H58 taxonomy', () => {
  const { CODES, httpStatusFor, isRetryable } = require('../src/services/error_codes');
  assert.equal(CODES.PLAN_TODOS_OPEN, 'plan_todos_open');
  assert.equal(CODES.ASSISTANT_HASH_REPEAT, 'assistant_hash_repeat');
  assert.equal(CODES.PGVECTOR_NORM, 'pgvector_norm');
  assert.equal(CODES.HTTP_409, 'http_409');
  assert.equal(CODES.QUEUE_DUP_REQUEST, 'queue_dup_request');
  assert.equal(httpStatusFor('http_409'), 409);
  assert.equal(httpStatusFor('queue_dup_request'), 409);
  assert.equal(isRetryable('net_etimedout'), true);
  assert.equal(isRetryable('http_504_retry'), true);
});

test('3H58-R-001 public stream maps 3H58 codes in ES without traces', () => {
  const src = read('src/services/observability/public-stream-error.js');
  assert.ok(src.includes("code: 'assistant_hash_repeat'"));
  assert.ok(src.includes("code: 'plan_todos_open'"));
  assert.ok(src.includes("code: 'pgvector_norm'"));
  assert.ok(src.includes("code: 'http_409'"));
  assert.ok(src.includes("code: 'net_etimedout'"));
  assert.ok(src.includes("code: 'queue_dup_request'"));
  assert.equal(/sk-[a-zA-Z0-9]{8}/.test(src), false);
  assert.equal(/at Object\./.test(src), false);
});

test('3H58-S-001 adapter fail-open re-exports 3H58 helpers and no OpenRouter generate', () => {
  assert.equal(typeof ad.refuseFinishIfPlanHasOpenTodos, 'function');
  assert.equal(typeof ad.requireExactHunkStartLine, 'function');
  assert.equal(typeof ad.neverRetry409Conflict, 'function');
  const adapterSrc = read('src/services/agent-runner/engine-adapter.js');
  assert.ok(adapterSrc.includes("try { return require('./engine-3h58'); } catch (_) { return {}; }"));
  const src = read('src/services/agent-runner/engine-3h58.js');
  assert.ok(src.indexOf('3H58') >= 0);
  assert.equal(/openrouter\.com|createOpenRouter|OPENROUTER_API_KEY/.test(src), false);
  assert.equal(ad.adapterSnapshot().openrouterGenerate, false);
  const helpers = Object.keys(h58).filter((k) => typeof h58[k] === 'function' && k !== 'snapshotFlags' && k !== 'resetInflightRequestIdsForTests' && k !== 'resetSettledDoneEventsForTests' && k !== 'resetLatencySamplesForTests' && k !== 'actionableErrorHint');
  assert.ok(helpers.length >= 15 && helpers.length <= 40);
});

test('3H58-T-001 loop and sse-writer keep production durability stacks', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.ok(loop.includes('STREAM_STALL_MS_DEFAULT'));
  assert.ok(loop.includes('heartbeatFence'));
  assert.ok(loop.includes('__f7Image') || loop.includes('F7'));
  const sse = read('src/utils/sse-writer.js');
  assert.ok(sse.includes('X-Accel-Buffering'));
  assert.ok(sse.includes('writeWithBackpressure'));
  assert.ok(sse.includes(': connected'));
});

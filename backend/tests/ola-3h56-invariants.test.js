'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const ad = require('../src/services/agent-runner/engine-adapter');
const h56 = require('../src/services/agent-runner/engine-3h56');

test('3H56-A-001 refuse finish while parallel tools are open', () => {
  const open = h56.refuseFinishWhileParallelToolsOpen({ inflight: 2 });
  assert.equal(open.ok, false);
  assert.equal(open.code, 'parallel_tools_open');
  assert.equal(h56.refuseFinishWhileParallelToolsOpen({ inflight: 0 }).ok, true);
  const viaCalls = h56.refuseFinishWhileParallelToolsOpen({ toolCalls: [{ id: 'c1' }] });
  assert.equal(viaCalls.ok, false);
});

test('3H56-B-001 cut loop when the same tool_call_id is reused', () => {
  const ok = h56.cutLoopIfSameToolCallIdReused([{ id: 'a' }, { id: 'b' }]);
  assert.equal(ok.cut, false);
  const cut = h56.cutLoopIfSameToolCallIdReused([{ id: 'a' }, { tool_call_id: 'a' }]);
  assert.equal(cut.cut, true);
  assert.equal(cut.code, 'tool_id_reused');
});

test('3H56-C-001 stop at max steps with partial final text', () => {
  const mid = h56.stopIfMaxStepsWithPartialFinal({ step: 3, maxSteps: 8, text: 'hi' });
  assert.equal(mid.stop, false);
  const end = h56.stopIfMaxStepsWithPartialFinal({ step: 8, maxSteps: 8, text: 'partial' });
  assert.equal(end.stop, true);
  assert.equal(end.partial, true);
  assert.equal(end.code, 'max_steps_partial');
});

test('3H56-D-001 refuse empty assistant with open tools', () => {
  const bad = h56.refuseEmptyAssistantWithOpenTools({ content: '  ', openToolIds: ['c1'] });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'empty_assistant_open');
  assert.equal(h56.refuseEmptyAssistantWithOpenTools({ content: 'ok', openToolIds: ['c1'] }).ok, true);
});

test('3H56-E-001 reject undefined required args and repair single-quoted JSON', () => {
  const miss = h56.rejectUndefinedRequiredToolArgs({ a: 1 }, ['a', 'b']);
  assert.equal(miss.ok, false);
  assert.deepEqual(miss.missing, ['b']);
  const ok = h56.repairJsonSingleQuotedValuesOnce("{'foo': 1}");
  assert.equal(ok.ok, true);
  assert.equal(ok.value.foo, 1);
  assert.equal(ok.code, 'json_single_quote_val');
  assert.equal(h56.repairJsonSingleQuotedValuesOnce('{"foo":1}').repaired, false);
});

test('3H56-F-001 coerce enum or refuse, 429 Retry-After, strip extra args', () => {
  const coerced = h56.coerceEnumArgOrRefuse('Read', ['read', 'write']);
  assert.equal(coerced.ok, true);
  assert.equal(coerced.value, 'read');
  assert.equal(h56.coerceEnumArgOrRefuse('delete', ['read']).ok, false);
  const ra = h56.backoffOn429RetryAfterHeader({ status: 429, headers: { 'retry-after': '2' } });
  assert.equal(ra.retry, true);
  assert.equal(ra.delayMs, 2000);
  assert.equal(ra.code, 'http_429_retry_after');
  const strip = h56.stripUnknownArgsWhenAdditionalPropertiesFalse(
    { a: 1, extra: 2 },
    { additionalProperties: false, properties: { a: { type: 'number' } } },
  );
  assert.deepEqual(strip.stripped, ['extra']);
  assert.equal(strip.args.a, 1);
});

test('3H56-G-001 refuse tool if required still missing after repair', () => {
  const bad = h56.refuseToolIfRequiredMissingAfterRepair({ args: { a: 1 }, required: ['a', 'b'], repaired: true });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'tool_required_missing');
  assert.equal(h56.refuseToolIfRequiredMissingAfterRepair({ args: { a: 1, b: 2 }, required: ['a', 'b'] }).ok, true);
});

test('3H56-H-001 inherit token budget, cut no-progress, deadline, sibling cap', () => {
  const tokens = h56.inheritSubagentTokenBudget({ parentRemaining: 400, childRequested: 2048 });
  assert.equal(tokens.tokens, 400);
  assert.equal(tokens.code, 'subagent_tokens');
  const cut = h56.cutSubagentIfNoProgressTwoSteps({ hashes: ['aaa', 'aaa'] });
  assert.equal(cut.cut, true);
  assert.equal(cut.code, 'subagent_no_progress');
  const now = 1_000_000;
  const dl = h56.shareParentAbortDeadlineMs({ parentDeadlineAt: now + 5_000, now, childRequestedMs: 30_000 });
  assert.equal(dl.timeoutMs, 5_000);
  const sib = h56.capSiblingSubagentsPerParent({ active: 2, max: 2 });
  assert.equal(sib.ok, false);
  assert.equal(sib.code, 'subagent_siblings');
});

test('3H56-I-001 compact pin pair, pgvector NaN, pin facts, drop old tool bodies', () => {
  const compact = h56.compactKeepPinnedAndLastUserPair([
    { id: 'sys', role: 'system', content: 'S' },
    { id: 'old', role: 'user', content: 'old' },
    { id: 'pin', role: 'assistant', content: 'keep' },
    { id: 'u', role: 'user', content: 'now' },
    { id: 'a', role: 'assistant', content: 'ans' },
  ], ['pin']);
  assert.equal(compact.pinned, 1);
  assert.ok(compact.messages.some((m) => m.id === 'pin'));
  assert.ok(compact.messages.some((m) => m.id === 'u'));
  const nan = h56.rejectPgvectorNaNOrInfComponents([1, Number.NaN, 3]);
  assert.equal(nan.ok, false);
  assert.equal(nan.code, 'pgvector_nan');
  const pin = h56.pinFactsWhenFlagTrue([{ id: 1, pin: true }, { id: 2 }]);
  assert.equal(pin.pinned.length, 1);
  const dropped = h56.dropToolBodiesOlderThanNTurns([
    { role: 'assistant' },
    { role: 'tool', content: 'x'.repeat(80) },
    { role: 'assistant' },
    { role: 'assistant' },
    { role: 'assistant' },
    { role: 'assistant' },
    { role: 'assistant' },
    { role: 'tool', content: 'fresh' },
  ], { keepTurns: 2 });
  assert.ok(dropped.dropped >= 1);
});

test('3H56-J-001 checkpoint seq, keep pinned, refuse cross-session rollback', () => {
  const seq = h56.refuseRollbackIfSeqNotMonotonic({ currentSeq: 4, targetSeq: 9 });
  assert.equal(seq.ok, false);
  assert.equal(seq.code, 'ckpt_seq');
  assert.equal(h56.refuseRollbackIfSeqNotMonotonic({ currentSeq: 4, targetSeq: 2 }).ok, true);
  const keep = h56.checkpointKeepLastNPlusPinned(
    [{ id: 1 }, { id: 2, pin: true }, { id: 3 }, { id: 4 }, { id: 5 }],
    { keep: 2 },
  );
  assert.ok(keep.checkpoints.some((c) => c.id === 2));
  const xses = h56.refuseRollbackAcrossSessionBoundary({ sessionKey: 's1', checkpointSessionKey: 's2' });
  assert.equal(xses.ok, false);
  assert.equal(xses.code, 'ckpt_session');
});

test('3H56-K-001 git headers, line count, binary refuse, hunk context', () => {
  const noHdr = h56.refuseDiffMissingGitHeaders('@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(noHdr.ok, false);
  const hdr = h56.refuseDiffMissingGitHeaders('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(hdr.ok, true);
  const lines = h56.verifyReadAfterWriteLineCount({ expected: 'a\nb\n', actual: 'a\n' });
  assert.equal(lines.ok, false);
  assert.equal(lines.code, 'raw_line_count');
  const bin = h56.refuseBinaryPatchOnTextFile({ path: 'a.js', diff: 'GIT binary patch\n' });
  assert.equal(bin.ok, false);
  const ctx = h56.requireHunkContextLinesMatch({
    hunk: { oldStart: 1, lines: [' hello'] },
    source: 'hello\nworld',
  });
  assert.equal(ctx.ok, true);
  const miss = h56.requireHunkContextLinesMatch({
    hunk: { oldStart: 1, lines: [' nope'] },
    source: 'hello',
  });
  assert.equal(miss.ok, false);
});

test('3H56-L-001 sandbox stdout cap, RSS, tmpdir prefix', () => {
  const cap = h56.capSandboxStdoutBytesPerCommand({ bytes: 100_000, max: 64 * 1024 });
  assert.equal(cap.ok, false);
  assert.equal(cap.code, 'sandbox_stdout_cap');
  const rss = h56.refuseSandboxRssOverCap({ rssMb: 512, maxMb: 256 });
  assert.equal(rss.ok, false);
  assert.equal(rss.code, 'sandbox_rss');
  const tmp = h56.requireSandboxTmpdirUnderPrefix('/tmp/other/x', '/tmp/sira');
  assert.equal(tmp.ok, false);
  assert.equal(h56.requireSandboxTmpdirUnderPrefix('/tmp/sira/job1', '/tmp/sira').ok, true);
});

test('3H56-M-001 SSE replay idempotent, cursor ahead, cancel drop, jitter', () => {
  const replay = h56.resumeReplayMustBeIdempotent([{ id: 1 }, { id: 2 }, { id: 3 }], 2);
  assert.equal(replay.ok, true);
  assert.equal(replay.events.length, 1);
  const ahead = h56.rejectResumeIfCursorAheadOfHead({ lastEventId: 9, headId: 4 });
  assert.equal(ahead.ok, false);
  assert.equal(ahead.code, 'sse_cursor_ahead');
  const drop = h56.dropBufferedTokensOnCancelOnce({ cancelled: true, dropped: false });
  assert.equal(drop.drop, true);
  assert.equal(h56.dropBufferedTokensOnCancelOnce({ cancelled: true, dropped: true }).already, true);
  const jit = h56.heartbeatJitterWithinWindow({ baseMs: 15_000, jitterMs: 900, maxJitter: 400 });
  assert.equal(jit.ok, false);
  assert.equal(h56.heartbeatJitterWithinWindow({ baseMs: 15_000, jitterMs: 100 }).ok, true);
});

test('3H56-N-001 queue lock and starve boost', () => {
  const lock = h56.rejectEnqueueIfSessionLockedByOther({ ownerId: 'w1', requesterId: 'w2', locked: true });
  assert.equal(lock.ok, false);
  assert.equal(lock.code, 'queue_lock');
  assert.equal(h56.rejectEnqueueIfSessionLockedByOther({ ownerId: 'w1', requesterId: 'w1', locked: true }).ok, true);
  const boost = h56.boostStarvedQueueAfterWaitMs({ waitedMs: 25_000, thresholdMs: 20_000 });
  assert.equal(boost.boost, true);
  assert.equal(boost.code, 'queue_starve');
});

test('3H56-O-001 no-completion charge skip and settle-once hold', () => {
  const skip = h56.neverChargeIfNoCompletionAndNoErrorUsage({ completionTokens: 0, error: null });
  assert.equal(skip.charge, false);
  assert.equal(skip.code, 'credit_no_completion');
  assert.equal(h56.neverChargeIfNoCompletionAndNoErrorUsage({ completionTokens: 12 }).charge, true);
  h56.resetSettledHoldsForTests();
  const first = h56.settleHoldOnceOnTerminalState({ holdId: 'h1', terminal: true });
  assert.equal(first.settle, true);
  const second = h56.settleHoldOnceOnTerminalState({ holdId: 'h1', terminal: true });
  assert.equal(second.settle, false);
  assert.equal(second.already, true);
});

test('3H56-P-001 DNS unavailable, never retry 401, step latency hint', () => {
  const dns = h56.classifyDnsEnotfoundAsUnavailable({ code: 'ENOTFOUND', message: 'getaddrinfo' });
  assert.equal(dns.unavailable, true);
  assert.equal(dns.retryable, true);
  assert.equal(dns.code, 'dns_unavailable');
  const u = h56.neverRetry401Unauthorized({ status: 401 });
  assert.equal(u.retry, false);
  assert.equal(u.code, 'http_401');
  const hint = h56.actionableErrorHint('tool_id_reused');
  assert.equal(hint.actionable, true);
  const slow = h56.latencyHintWhenStepOverBudget({ elapsedMs: 20_000, budgetMs: 15_000 });
  assert.equal(slow.hint, true);
  assert.equal(slow.code, 'step_slow');
});

test('3H56-Q-001 adapter snapshot keeps 3H46 flags and wave 3H56 DeepSeek lock', () => {
  const s = ad.adapterSnapshot();
  assert.equal(s.wave, '3H56');
  assert.equal(s.rejectPrototypePollutionKeys, true);
  assert.equal(s.neverRetry410Gone, true);
  assert.equal(s.refuseFinishWhileParallelToolsOpen, true);
  assert.equal(s.cutLoopIfSameToolCallIdReused, true);
  assert.equal(s.rejectPgvectorNaNOrInfComponents, true);
  assert.equal(s.neverRetry401Unauthorized, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
  assert.equal(ad.refuseOpenRouterEnv({ SIRAGPT_USE_OPENROUTER: '1' }).ok, false);
  assert.equal(ad.allowDeepSeekGenerateModel('deepseek-v4-flash').ok, true);
  assert.equal(ad.allowDeepSeekGenerateModel('deepseek-v4-pro').ok, true);
});

test('3H56-R-001 live loop/queue/sse/gateway/sandbox import 3H56 helpers', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.ok(loop.includes('refuseFinishWhileParallelToolsOpen'));
  assert.ok(loop.includes('cutLoopIfSameToolCallIdReused'));
  assert.ok(loop.includes('repairJsonSingleQuotedValuesOnce'));
  assert.ok(loop.includes('stopIfMaxStepsWithPartialFinal'));
  assert.ok(loop.includes('dropBufferedTokensOnCancelOnce'));
  const sse = read('src/utils/sse-writer.js');
  assert.ok(sse.includes('resumeReplayMustBeIdempotent'));
  assert.ok(sse.includes('rejectResumeIfCursorAheadOfHead'));
  assert.ok(sse.includes('heartbeatJitterWithinWindow'));
  const q = read('src/services/agent-gateway/queue.js');
  assert.ok(q.includes('rejectEnqueueIfSessionLockedByOther'));
  assert.ok(q.includes('boostStarvedQueueAfterWaitMs'));
  const gw = read('src/services/agent-runner/engine-gateway.js');
  assert.ok(gw.includes('neverChargeIfNoCompletionAndNoErrorUsage'));
  assert.ok(gw.includes('neverRetry401Unauthorized'));
  assert.ok(gw.includes('backoffOn429RetryAfterHeader'));
  assert.ok(gw.includes('classifyDnsEnotfoundAsUnavailable'));
  const sb = read('src/services/sandbox/local-sandbox.js');
  assert.ok(sb.includes('capSandboxStdoutBytesPerCommand'));
  assert.ok(sb.includes('requireSandboxTmpdirUnderPrefix'));
  assert.ok(sb.includes('refuseSandboxRssOverCap'));
});

test('3H56-S-001 error codes include 3H56 taxonomy', () => {
  const { CODES, httpStatusFor, isRetryable } = require('../src/services/error_codes');
  assert.equal(CODES.PARALLEL_TOOLS_OPEN, 'parallel_tools_open');
  assert.equal(CODES.TOOL_ID_REUSED, 'tool_id_reused');
  assert.equal(CODES.PGVECTOR_NAN, 'pgvector_nan');
  assert.equal(CODES.HTTP_401, 'http_401');
  assert.equal(CODES.QUEUE_LOCK, 'queue_lock');
  assert.equal(httpStatusFor('http_401'), 401);
  assert.equal(httpStatusFor('queue_lock'), 409);
  assert.equal(isRetryable('dns_unavailable'), true);
  assert.equal(isRetryable('http_429_retry_after'), true);
});

test('3H56-T-001 public stream maps 3H56 codes in ES without traces', () => {
  const src = read('src/services/observability/public-stream-error.js');
  assert.ok(src.includes("code: 'tool_id_reused'"));
  assert.ok(src.includes("code: 'parallel_tools_open'"));
  assert.ok(src.includes("code: 'pgvector_nan'"));
  assert.ok(src.includes("code: 'http_401'"));
  assert.ok(src.includes("code: 'dns_unavailable'"));
  assert.ok(src.includes("code: 'queue_lock'"));
  assert.equal(/sk-[a-zA-Z0-9]{8}/.test(src), false);
  assert.equal(/at Object\./.test(src), false);
});

test('3H56-U-001 adapter re-exports 3H56 helpers and no OpenRouter generate', () => {
  assert.equal(typeof ad.refuseFinishWhileParallelToolsOpen, 'function');
  assert.equal(typeof ad.requireHunkContextLinesMatch, 'function');
  assert.equal(typeof ad.neverRetry401Unauthorized, 'function');
  const src = read('src/services/agent-runner/engine-3h56.js');
  assert.ok(src.indexOf('3H56') >= 0);
  assert.equal(/openrouter\.com|createOpenRouter|OPENROUTER_API_KEY/.test(src), false);
  assert.equal(ad.adapterSnapshot().openrouterGenerate, false);
  const helpers = Object.keys(h56).filter((k) => typeof h56[k] === 'function' && k !== 'snapshotFlags' && k !== 'resetSettledHoldsForTests' && k !== 'actionableErrorHint');
  assert.ok(helpers.length >= 15 && helpers.length <= 40);
});

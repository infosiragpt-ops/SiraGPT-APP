'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js')
  ? '/app'
  : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const w = require('../src/services/agent-runner/engine-3h59');
const ad = require('../src/services/agent-runner/engine-adapter');

test('3H59-A-001 repair partial tool-call schema fills required + strips extras', () => {
  const call = {
    id: 'c1',
    function: { name: 'read_file', arguments: '{"path":"/tmp/a"' },
  };
  const out = w.repairPartialToolCallSchema(call, {
    required: ['path', 'offset'],
    properties: { path: { type: 'string' }, offset: { type: 'integer' } },
    additionalProperties: false,
  });
  assert.equal(out.ok, true);
  assert.equal(out.repaired, true);
  assert.ok(out.missing.includes('offset'));
  assert.equal(out.call.args.offset, 0);
  assert.equal(out.call.args.path, '/tmp/a');
  assert.equal(out.code, 'tool_schema_repair');
});

test('3H59-B-001 backoff malformed tool-call is deterministic and caps', () => {
  const a0 = w.backoffMalformedToolCall({ attempt: 0 });
  const a0b = w.backoffMalformedToolCall({ attempt: 0 });
  assert.equal(a0.retry, true);
  assert.equal(a0.delayMs, a0b.delayMs);
  assert.ok(a0.delayMs >= 80);
  const stop = w.backoffMalformedToolCall({ attempt: 4 });
  assert.equal(stop.retry, false);
  assert.equal(stop.code, 'tool_call_dropped');
});

test('3H59-C-001 tolerate incomplete streamed tool-call then drop', () => {
  const hold = w.tolerateIncompleteStreamedToolCall({
    function: { name: 'write_file', arguments: '{"path":"/tmp/a",' },
  }, { chunks: 1 });
  assert.equal(hold.hold, true);
  assert.equal(hold.code, 'tool_call_incomplete');
  const drop = w.tolerateIncompleteStreamedToolCall({
    function: { name: '', arguments: '{' },
  }, { chunks: 8 });
  assert.equal(drop.drop, true);
  const ok = w.tolerateIncompleteStreamedToolCall({
    function: { name: 'read_file', arguments: '{"path":"a"}' },
  });
  assert.equal(ok.hold, false);
  assert.equal(ok.drop, false);
});

test('3H59-D-001 strip unknown tool-call properties', () => {
  const out = w.stripUnknownToolCallProperties({
    id: 'c1',
    type: 'function',
    extra: true,
    function: { name: 'read_file', arguments: '{}', bogus: 1 },
  });
  assert.equal(out.stripped >= 2, true);
  assert.equal(out.call.extra, undefined);
  assert.equal(out.call.function.bogus, undefined);
  assert.equal(out.call.function.name, 'read_file');
  assert.equal(out.code, 'tool_call_strip');
});

test('3H59-E-001 infer tool name from call id', () => {
  const out = w.inferToolNameFromCallId(
    { id: 'read_file_3', function: { arguments: '{}' } },
    ['write_file', 'read_file', 'glob'],
  );
  assert.equal(out.inferred, true);
  assert.equal(out.name, 'read_file');
  assert.equal(out.call.function.name, 'read_file');
  const kept = w.inferToolNameFromCallId(
    { function: { name: 'glob', arguments: '{}' } },
    ['glob'],
  );
  assert.equal(kept.inferred, false);
});

test('3H59-F-001 slice subtask token budget', () => {
  const ok = w.sliceSubtaskTokenBudget({ parentRemaining: 1000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.budget, 350);
  const empty = w.sliceSubtaskTokenBudget({ parentRemaining: 0 });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'subtask_token_budget');
  const req = w.sliceSubtaskTokenBudget({ parentRemaining: 1000, requested: 80 });
  assert.equal(req.budget, 80);
});

test('3H59-G-001 cut infinite loop by identical fingerprint', () => {
  const call = { function: { name: 'read_file', arguments: '{"path":"a"}' } };
  const no = w.cutInfiniteLoopByFingerprint([call, call]);
  assert.equal(no.cut, false);
  const yes = w.cutInfiniteLoopByFingerprint([call, call, call]);
  assert.equal(yes.cut, true);
  assert.equal(yes.code, 'loop_fingerprint_cut');
});

test('3H59-H-001 cut subtask if no progress', () => {
  const idle = [
    { tokensDelta: 0, artifactsDelta: 0 },
    { tokensDelta: 0, artifactsDelta: 0 },
    { tokensDelta: 0, artifactsDelta: 0 },
  ];
  const cut = w.cutSubtaskIfNoProgress({ steps: idle, tokensDelta: 0, artifactsDelta: 0 });
  assert.equal(cut.cut, true);
  assert.equal(cut.code, 'subtask_no_progress');
  const live = w.cutSubtaskIfNoProgress({
    steps: [{ tokensDelta: 12, artifactsDelta: 0 }],
    tokensDelta: 12,
    artifactsDelta: 0,
  });
  assert.equal(live.cut, false);
});

test('3H59-I-001 critical-fact anchors survive compact', () => {
  const original = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'MUST: keep the hex #FF00AA' },
    { role: 'assistant', content: 'ok' },
  ];
  const extracted = w.anchorCriticalFacts(original);
  assert.equal(extracted.count, 1);
  const compacted = [{ role: 'assistant', content: 'ok' }];
  const out = w.compactPreserveFactAnchors(original, compacted, extracted.anchors);
  assert.ok(out.restored >= 1);
  assert.ok(out.messages.some((m) => /#FF00AA/.test(m.content)));
  assert.equal(out.code, 'fact_anchor');
});

test('3H59-J-001 checkpoint and rollback hooks', () => {
  const pre = w.checkpointHookBeforeMutatingTool({ tool: 'write_file', path: '/tmp/a' });
  assert.equal(pre.hook, true);
  assert.equal(pre.code, 'ckpt_pre_write');
  const skipRead = w.checkpointHookBeforeMutatingTool({ tool: 'read_file' });
  assert.equal(skipRead.hook, false);
  const rb = w.rollbackHookOnTimedOutWrite({ timedOut: true, path: '/tmp/a', checkpointId: 'ck1' });
  assert.equal(rb.rollback, true);
  assert.equal(rb.code, 'ckpt_rollback_timeout');
  const same = w.skipCheckpointIfUnchanged({ beforeHash: 'aaa', afterHash: 'aaa' });
  assert.equal(same.skip, true);
  const diff = w.skipCheckpointIfUnchanged({ beforeHash: 'aaa', afterHash: 'bbb' });
  assert.equal(diff.skip, false);
});

test('3H59-K-001 sandbox timeout cleanup and orphan reap', () => {
  const to = w.sandboxTimeoutThenCleanup({ elapsedMs: 12_000, timeoutMs: 8_000, workdir: '/tmp/sbx' });
  assert.equal(to.timeout, true);
  assert.equal(to.cleanup, true);
  assert.deepEqual(to.signals, ['SIGTERM', 'SIGKILL']);
  const live = w.sandboxTimeoutThenCleanup({ elapsedMs: 100, timeoutMs: 8_000 });
  assert.equal(live.timeout, false);
  const now = 1_700_000_000_000;
  const reap = w.sandboxReapOrphanWorkdirs([
    { path: '/tmp/old', mtimeMs: now - 11 * 60 * 1000 },
    { path: '/tmp/fresh', mtimeMs: now - 1000 },
    { path: '/tmp/marked', mtimeMs: now - 1000, orphan: true },
  ], { now });
  assert.equal(reap.count, 2);
  assert.equal(reap.code, 'sandbox_orphan_reap');
});

test('3H59-L-001 SSE resume/cancel leak guards', () => {
  let offs = 0;
  const resume = w.sseResumeDropsPriorListeners({
    listeners: [{ off() { offs += 1; } }, () => { offs += 1; }],
    resume: true,
  });
  assert.equal(resume.dropped, 2);
  assert.equal(offs, 2);
  assert.equal(resume.code, 'sse_resume_leak');
  let cleared = 0;
  const cancel = w.sseCancelClearsHeartbeat({ cancelled: true, heartbeatTimer: () => { cleared += 1; } });
  assert.equal(cancel.cleared, true);
  assert.equal(cleared, 1);
  const ahead = w.sseResumeRejectsSeqPastHead({ lastEventId: 12, headSeq: 4 });
  assert.equal(ahead.ok, false);
  assert.equal(ahead.code, 'sse_resume_ahead');
  const ok = w.sseResumeRejectsSeqPastHead({ lastEventId: 3, headSeq: 4 });
  assert.equal(ok.ok, true);
});

test('3H59-M-001 session-queue event order', () => {
  const ordered = w.sessionQueueOrderBySeq([{ seq: 3 }, { seq: 1 }, { seq: 2 }]);
  assert.equal(ordered.reordered, true);
  assert.deepEqual(ordered.events.map((e) => e.seq), [1, 2, 3]);
  const late = w.sessionQueueDropLateOutOfOrder(
    [{ seq: 1 }, { seq: 8 }, { seq: 9 }],
    { headSeq: 9, maxLag: 2 },
  );
  assert.equal(late.dropped, 1);
  assert.equal(late.events[0].seq, 8);
  assert.equal(late.code, 'session_queue_late');
});

test('3H59-N-001 token accounting on cancel does not double-count', () => {
  const billed = w.accountPartialTokensOnCancel({
    cancelled: true,
    streamedChars: 12,
    usage: { promptTokens: 5 },
  });
  assert.equal(billed.promptTokens, 5);
  assert.equal(billed.completionTokens, 3);
  assert.equal(billed.code, 'credit_cancel_partial');
  const skip = w.neverDoubleCountCancelUsage({ alreadyRecorded: true, usage: billed });
  assert.equal(skip.skipped, true);
  assert.equal(skip.recorded, false);
  assert.equal(skip.code, 'credit_cancel_dedupe');
  const first = w.neverDoubleCountCancelUsage({ alreadyRecorded: false });
  assert.equal(first.recorded, true);
});

test('3H59-O-001 classified errors never leak stacks or OpenRouter', () => {
  const err = new Error('boom');
  err.stack = 'Error: boom\n    at Object.run (engine-3h59.js:1:1)';
  err.code = 'loop_fingerprint_cut';
  const out = w.classifyEngine3h59Error({ code: 'loop_fingerprint_cut', err });
  assert.equal(out.code, 'loop_fingerprint_cut');
  assert.equal(out.leaked, false);
  assert.equal(out.retryable, false);
  assert.equal(/at Object\./.test(out.message), false);
  assert.ok(out.message.indexOf('huella') >= 0);
  const denied = w.refuseOpenRouterInWave3h59({ SIRAGPT_USE_OPENROUTER: '1' });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'openrouter_denied');
  const deepseek = w.refuseOpenRouterInWave3h59({ DEEPSEEK_BASE_URL: 'https://api.deepseek.com' });
  assert.equal(deepseek.ok, true);
});

test('3H59-P-001 adapter fail-open wires 3H59 helpers and wave', () => {
  const s = ad.adapterSnapshot();
  assert.ok(s.wave === '3H59' || s.wave === '3H60' || s.wave === '3H61' || s.wave === '3H62' || s.wave === '3H63' || s.wave === '3H64' || s.wave === '3H65');
  assert.equal(s.repairPartialToolCallSchema, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
  assert.equal(typeof ad.repairPartialToolCallSchema, 'function');
  assert.equal(typeof ad.cutInfiniteLoopByFingerprint, 'function');
  assert.equal(typeof ad.accountPartialTokensOnCancel, 'function');
  assert.equal(ad.loadOptionalEngineWave('engine-3h54'), null);
  assert.equal(ad.loadOptionalEngineWave('engine-3h59').WAVE, '3H59');
  assert.equal(ad.loadOptionalEngineWave('engine-3h55'), null);
  const viaAd = ad.classifyAdapterError('loop_fingerprint_cut');
  assert.ok(viaAd);
  assert.equal(viaAd.code, 'loop_fingerprint_cut');
  assert.equal(ad.refuseOpenRouterEnv({ SIRAGPT_USE_OPENROUTER: '1' }).ok, false);
  assert.equal(ad.allowDeepSeekGenerateModel('deepseek-v4-flash').ok, true);
});

test('3H59-Q-001 live loop/queue/sse/gateway import 3H59 helpers', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.ok(loop.includes('engine-3h59'));
  assert.ok(loop.includes('cutInfiniteLoopByFingerprint'));
  assert.ok(loop.includes('accountPartialTokensOnCancel'));
  const sse = read('src/utils/sse-writer.js');
  assert.ok(sse.includes('sseResumeDropsPriorListeners'));
  assert.ok(sse.includes('sseCancelClearsHeartbeat'));
  const q = read('src/services/agent-gateway/queue.js');
  assert.ok(q.includes('sessionQueueOrderBySeq'));
  const gw = read('src/services/agent-runner/engine-gateway.js');
  assert.ok(gw.includes('accountPartialTokensOnCancel'));
  assert.ok(gw.includes('classifyEngine3h59Error'));
  const adapter = read('src/services/agent-runner/engine-adapter.js');
  assert.ok(adapter.includes('engine-3h55'));
  assert.ok(adapter.includes('engine-3h59'));
});

test('3H59-R-001 error codes and public stream map 3H59 taxonomy without traces', () => {
  const { CODES, isRetryable, httpStatusFor } = require('../src/services/error_codes');
  assert.equal(CODES.LOOP_FINGERPRINT_CUT, 'loop_fingerprint_cut');
  assert.equal(CODES.SSE_RESUME_AHEAD, 'sse_resume_ahead');
  assert.equal(CODES.CREDIT_CANCEL_PARTIAL, 'credit_cancel_partial');
  assert.equal(isRetryable('sse_resume_ahead'), true);
  assert.equal(isRetryable('loop_fingerprint_cut'), false);
  assert.equal(httpStatusFor('loop_fingerprint_cut'), 400);
  const src = read('src/services/observability/public-stream-error.js');
  assert.ok(src.includes("code: 'loop_fingerprint_cut'"));
  assert.ok(src.includes("code: 'sse_resume_ahead'"));
  assert.ok(src.includes("code: 'sandbox_timeout_cleanup'"));
  assert.equal(/sk-[a-zA-Z0-9]{8}/.test(src), false);
  assert.equal(/at Object\./.test(src), false);
});

test('3H59-S-001 compose binds 3H59 tests and DeepSeek lock holds', () => {
  assert.ok(String(__filename || '').includes('ola-3h59-invariants.test.js'));
  assert.equal(w.WAVE, '3H59');
  assert.equal(w.HELPERS.length >= 15 && w.HELPERS.length <= 30, true);
  assert.ok(ad.adapterSnapshot().wave === '3H59' || ad.adapterSnapshot().wave === '3H60' || ad.adapterSnapshot().wave === '3H61' || ad.adapterSnapshot().wave === '3H62' || ad.adapterSnapshot().wave === '3H63' || ad.adapterSnapshot().wave === '3H64' || ad.adapterSnapshot().wave === '3H65');
});

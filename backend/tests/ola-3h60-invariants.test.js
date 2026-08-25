'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js')
  ? '/app'
  : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const w = require('../src/services/agent-runner/engine-3h60');
const ad = require('../src/services/agent-runner/engine-adapter');

test('3H60-A-001 coerce types + unwrap fence + enum closest + nameless refuse', () => {
  const call = {
    id: 'c1',
    function: { name: 'read_file', arguments: '```json\n{"offset":"12","ok":"true"}\n```' },
  };
  const unwrapped = w.unwrapFencedToolArgs(call.function.arguments);
  assert.equal(unwrapped.unwrapped, true);
  assert.equal(unwrapped.value.offset, '12');
  const coerced = w.coerceToolArgTypes(
    { function: { name: 'read_file', arguments: JSON.stringify(unwrapped.value) } },
    { properties: { offset: { type: 'integer' }, ok: { type: 'boolean' } } },
  );
  assert.equal(coerced.changed, true);
  assert.equal(coerced.call.args.offset, 12);
  assert.equal(coerced.call.args.ok, true);
  assert.equal(coerced.code, 'tool_arg_coerce');
  const enumHit = w.repairEnumArgClosestMatch('darkk', ['light', 'dark', 'system']);
  assert.equal(enumHit.repaired, true);
  assert.equal(enumHit.value, 'dark');
  const nameless = w.refuseNamelessToolAfterRepair({ function: { arguments: '{}' } });
  assert.equal(nameless.refused, true);
  assert.equal(nameless.code, 'tool_nameless');
});

test('3H60-B-001 transient tool retry backs off; 400 never retries', () => {
  const a0 = w.retryTransientToolError({ attempt: 0, status: 503 });
  const a0b = w.retryTransientToolError({ attempt: 0, status: 503 });
  assert.equal(a0.retry, true);
  assert.equal(a0.delayMs, a0b.delayMs);
  assert.ok(a0.delayMs >= 100);
  assert.equal(a0.code, 'tool_transient_retry');
  const hard = w.retryTransientToolError({ attempt: 0, status: 400, code: 'EINVAL' });
  assert.equal(hard.retry, false);
  const stop = w.retryTransientToolError({ attempt: 4, status: 429 });
  assert.equal(stop.retry, false);
});

test('3H60-C-001 oscillation cut + inherited subagent steps', () => {
  const hist = [
    { function: { name: 'read_file' } },
    { function: { name: 'write_file' } },
    { function: { name: 'read_file' } },
    { function: { name: 'write_file' } },
  ];
  const cut = w.cutOscillatingToolPair(hist);
  assert.equal(cut.cut, true);
  assert.equal(cut.code, 'loop_oscillation_cut');
  const short = w.cutOscillatingToolPair(hist.slice(0, 2));
  assert.equal(short.cut, false);
  const inherit = w.inheritSubagentRemainingSteps({ parentRemaining: 8, requested: 20 });
  assert.equal(inherit.ok, true);
  assert.equal(inherit.steps, 7);
  const gone = w.refuseSubagentIfParentBudgetGone({ parentRemaining: 0 });
  assert.equal(gone.refuse, true);
  assert.equal(gone.code, 'subagent_parent_budget');
});

test('3H60-D-001 faithful compact + prune + last user + memory recover', () => {
  const original = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'analiza el contrato de alquiler' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'resume las cláusulas de salida' },
  ];
  const pruned = w.pruneMessagesByQueryOverlap(original, 'cláusulas de salida', { keepLast: 1, minOverlap: 0.99 });
  assert.ok(pruned.pruned >= 1);
  const summed = w.compactFaithfulDroppedSummary(original, [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'resume las cláusulas de salida' },
  ]);
  assert.equal(summed.dropped >= 1, true);
  assert.ok(summed.messages.some((m) => m.compactSummary === true));
  assert.match(summed.messages[0].content, /Resumen fiel/);
  const kept = w.neverDropLastUserOnCompact(original, [{ role: 'assistant', content: 'ok' }]);
  assert.equal(kept.restored, true);
  assert.ok(kept.messages.some((m) => m.role === 'user' && /salida/.test(m.content)));
  const recovered = w.recoverPinnedMemoryFacts(
    [{ role: 'assistant', content: 'ok' }],
    [{ factId: 'f1', content: 'hex #FF00AA', pin: true, score: 0.9 }],
  );
  assert.equal(recovered.recovered, 1);
  assert.equal(recovered.code, 'memory_pin_recover');
});

test('3H60-E-001 file checkpoint + hash verify + syntax revert + diff markers', () => {
  const snap = w.checkpointFileByteSnapshot({ path: '/tmp/a.js', bytes: 'const x = 1;' });
  assert.equal(snap.ok, true);
  assert.equal(snap.code, 'ckpt_bytes');
  let restored = null;
  const rb = w.rollbackFileByteSnapshot({
    path: '/tmp/a.js',
    snapshot: snap.snapshot,
    restore: (p, bytes) => { restored = { p, bytes: String(bytes) }; },
  });
  assert.equal(rb.restored, true);
  assert.equal(restored.p, '/tmp/a.js');
  const okHash = w.verifyReadAfterWriteHash({
    expectedHash: snap.snapshot.sha256,
    actualBytes: 'const x = 1;',
  });
  assert.equal(okHash.ok, true);
  const badHash = w.verifyReadAfterWriteHash({
    expectedHash: snap.snapshot.sha256,
    actualBytes: 'const x = 2;',
  });
  assert.equal(badHash.ok, false);
  assert.equal(badHash.code, 'write_hash_mismatch');
  let revertedTo = null;
  const syn = w.revertWriteOnSyntaxFail({
    path: '/tmp/a.js',
    before: 'const x = 1;',
    after: 'const x = (',
    restore: (_p, before) => { revertedTo = before; },
  });
  assert.equal(syn.reverted, true);
  assert.equal(revertedTo, 'const x = 1;');
  const badDiff = w.applyExactDiffRequiresMarkers('@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(badDiff.ok, false);
  const goodDiff = w.applyExactDiffRequiresMarkers('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(goodDiff.ok, true);
});

test('3H60-F-001 sandbox chunk cap + abort cleanup', () => {
  const cap = w.sandboxStreamChunkCap({ chunk: Buffer.alloc(20, 97), used: 10, cap: 16 });
  assert.equal(cap.truncated, true);
  assert.equal(cap.chunk.length, 6);
  assert.equal(cap.code, 'sandbox_chunk_cap');
  const signals = [];
  const clean = w.sandboxFinallyCleanupOnAbort({
    aborted: true,
    workdir: '/tmp/sbx',
    pid: 4242,
    kill: (pid, sig) => { signals.push(`${pid}:${sig}`); },
  });
  assert.equal(clean.cleanup, true);
  assert.deepEqual(clean.signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(signals.includes('4242:SIGTERM'));
});

test('3H60-G-001 SSE replay / heartbeat no seq / disconnect abort / cancel buffer', () => {
  const replay = w.sseReplayFromLastEventId(
    [{ seq: 1, t: 'a' }, { seq: 2, t: 'b' }, { seq: 3, t: 'c' }],
    2,
  );
  assert.equal(replay.skipped, 2);
  assert.equal(replay.events.length, 1);
  assert.equal(replay.events[0].t, 'c');
  assert.equal(replay.code, 'sse_replay_resume');
  const beat = w.sseHeartbeatCommentNoSeq({ seq: 9, kind: 'heartbeat' });
  assert.equal(beat.bumped, false);
  assert.equal(beat.seq, 9);
  assert.match(beat.frame, /^: heartbeat/);
  let aborted = false;
  const disc = w.sseAbortOnClientDisconnect({
    disconnected: true,
    controller: { abort() { aborted = true; } },
  });
  assert.equal(disc.aborted, true);
  assert.equal(aborted, true);
  const drop = w.dropBufferedTokensOnSseCancel({ cancelled: true, buffered: ['hola', 'mundo'] });
  assert.equal(drop.dropped, 2);
  assert.deepEqual(drop.buffer, []);
});

test('3H60-H-001 session single-writer + seq gap', () => {
  const busy = w.sessionSingleWriterLock({ held: true, sessionKey: 's1' });
  assert.equal(busy.acquired, false);
  assert.equal(busy.code, 'session_writer_busy');
  const free = w.sessionSingleWriterLock({ held: false, sessionKey: 's1' });
  assert.equal(free.acquired, true);
  const gap = w.sessionQueueDetectGap([{ seq: 1 }, { seq: 2 }, { seq: 5 }]);
  assert.equal(gap.gap, true);
  assert.deepEqual(gap.missing, [3, 4]);
  assert.equal(gap.code, 'session_queue_gap');
});

test('3H60-I-001 credit settle on error + never charge pre-token + prompt cap', () => {
  const settled = w.settleCreditsOnError({
    errored: true,
    usage: { promptTokens: 11, streamedChars: 9 },
  });
  assert.equal(settled.settled, true);
  assert.equal(settled.promptTokens, 11);
  assert.equal(settled.completionTokens, 3);
  assert.equal(settled.code, 'credit_error_settle');
  const skip = w.settleCreditsOnError({ errored: true, alreadySettled: true });
  assert.equal(skip.skipped, true);
  const pre = w.neverChargeBeforeFirstToken({ firstToken: false, cancelled: true, tokens: 0 });
  assert.equal(pre.charge, false);
  assert.equal(pre.code, 'credit_pre_token');
  const errPre = w.neverChargeBeforeFirstToken({ firstToken: false, errored: true, tokens: 0 });
  assert.equal(errPre.charge, false);
  const after = w.neverChargeBeforeFirstToken({ firstToken: true, cancelled: true, tokens: 4 });
  assert.equal(after.charge, true);
  const cap = w.capPromptTokensOnErrorSettle({ promptTokens: 20_000 });
  assert.equal(cap.capped, true);
  assert.equal(cap.promptTokens, 8192);
});

test('3H60-J-001 classified errors never leak stacks/secrets; OpenRouter denied', () => {
  const err = new Error('boom sk-abcdefghijk');
  err.stack = 'Error: boom\n    at Object.run (engine-3h60.js:1:1)';
  const out = w.classifyEngine3h60Error({ code: 'loop_oscillation_cut', err });
  assert.equal(out.code, 'loop_oscillation_cut');
  assert.equal(out.leaked, false);
  assert.equal(/at Object\./.test(out.message), false);
  assert.equal(/sk-abcdefghijk/.test(out.message), false);
  assert.ok(out.message.indexOf('alternó') >= 0);
  const red = w.redactSecretsFromPublicError('fail sk-abcdefghijk\n    at Object.run (x.js:1:1)');
  assert.equal(red.redacted, true);
  assert.equal(/sk-abcdefghijk/.test(red.message), false);
  assert.equal(/at Object\./.test(red.message), false);
  const denied = w.refuseOpenRouterInWave3h60({ SIRAGPT_USE_OPENROUTER: '1' });
  assert.equal(denied.ok, false);
  const deepseek = w.refuseOpenRouterInWave3h60({ DEEPSEEK_BASE_URL: 'https://api.deepseek.com' });
  assert.equal(deepseek.ok, true);
});

test('3H60-K-001 scripted p50/p95 never invented Flash', () => {
  const ring = [];
  w.observeScriptedLatencySample('first_token', 40, ring);
  w.observeScriptedLatencySample('first_token', 80, ring);
  w.observeScriptedLatencySample('first_token', 120, ring);
  const snap = w.snapshotLatency('first_token', ring);
  assert.equal(snap.source, 'scripted');
  assert.equal(snap.count, 3);
  assert.equal(snap.p50, 80);
  assert.equal(snap.p95, 120);
});

test('3H60-L-001 adapter fail-open wires 3H60 helpers and wave', () => {
  const s = ad.adapterSnapshot();
  assert.ok(s.wave === '3H60' || s.wave === '3H61' || s.wave === '3H62' || s.wave === '3H63' || s.wave === '3H64');
  assert.equal(s.cutOscillatingToolPair, true);
  assert.equal(s.sseReplayFromLastEventId, true);
  assert.equal(s.settleCreditsOnError, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
  assert.equal(typeof ad.cutOscillatingToolPair, 'function');
  assert.equal(typeof ad.sseReplayFromLastEventId, 'function');
  assert.equal(typeof ad.settleCreditsOnError, 'function');
  assert.equal(typeof ad.neverChargeBeforeFirstToken, 'function');
  assert.equal(ad.loadOptionalEngineWave('engine-3h54'), null);
  assert.equal(ad.loadOptionalEngineWave('engine-3h60').WAVE, '3H60');
  assert.equal(ad.loadOptionalEngineWave('engine-3h59').WAVE, '3H59');
  const viaAd = ad.classifyAdapterError('loop_oscillation_cut');
  assert.ok(viaAd);
  assert.equal(viaAd.code, 'loop_oscillation_cut');
  assert.equal(ad.refuseOpenRouterEnv({ SIRAGPT_USE_OPENROUTER: '1' }).ok, false);
  assert.equal(ad.allowDeepSeekGenerateModel('deepseek-v4-flash').ok, true);
});

test('3H60-M-001 live loop/queue/sse/gateway/sandbox import 3H60 helpers', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.ok(loop.includes('engine-3h60'));
  assert.ok(loop.includes('cutOscillatingToolPair'));
  assert.ok(loop.includes('retryTransientToolError'));
  assert.ok(loop.includes('neverChargeBeforeFirstToken'));
  assert.ok(loop.includes('compactFaithfulDroppedSummary'));
  const sse = read('src/utils/sse-writer.js');
  assert.ok(sse.includes('sseReplayFromLastEventId'));
  assert.ok(sse.includes('sseAbortOnClientDisconnect'));
  assert.ok(sse.includes('sseHeartbeatCommentNoSeq'));
  const q = read('src/services/agent-gateway/queue.js');
  assert.ok(q.includes('sessionSingleWriterLock'));
  assert.ok(q.includes('sessionQueueDetectGap'));
  const gw = read('src/services/agent-runner/engine-gateway.js');
  assert.ok(gw.includes('settleCreditsOnError'));
  assert.ok(gw.includes('classifyEngine3h60Error'));
  const sandbox = read('src/services/sandbox/local-sandbox.js');
  assert.ok(sandbox.includes('sandboxStreamChunkCap'));
  assert.ok(sandbox.includes('sandboxFinallyCleanupOnAbort'));
  const adapter = read('src/services/agent-runner/engine-adapter.js');
  assert.ok(adapter.includes('engine-3h60'));
});

test('3H60-N-001 error codes and public stream map 3H60 taxonomy without traces', () => {
  const { CODES, isRetryable, httpStatusFor } = require('../src/services/error_codes');
  assert.equal(CODES.LOOP_OSCILLATION_CUT, 'loop_oscillation_cut');
  assert.equal(CODES.SSE_REPLAY_RESUME, 'sse_replay_resume');
  assert.equal(CODES.CREDIT_ERROR_SETTLE, 'credit_error_settle');
  assert.equal(CODES.CREDIT_PRE_TOKEN, 'credit_pre_token');
  assert.equal(isRetryable('sse_replay_resume'), true);
  assert.equal(isRetryable('loop_oscillation_cut'), false);
  assert.equal(isRetryable('session_queue_gap'), true);
  assert.equal(httpStatusFor('loop_oscillation_cut'), 400);
  const src = read('src/services/observability/public-stream-error.js');
  assert.ok(src.includes("code: 'loop_oscillation_cut'"));
  assert.ok(src.includes("code: 'sse_replay_resume'"));
  assert.ok(src.includes("code: 'credit_error_settle'"));
  assert.equal(/sk-[a-zA-Z0-9]{8}/.test(src), false);
  assert.equal(/at Object\./.test(src), false);
});

test('3H60-O-001 compose binds 3H60 tests and DeepSeek lock holds', () => {
  assert.ok(String(__filename || '').includes('ola-3h60-invariants.test.js'));
  assert.equal(w.WAVE, '3H60');
  assert.equal(w.HELPERS.length >= 28 && w.HELPERS.length <= 40, true);
  assert.ok(ad.adapterSnapshot().wave === '3H60' || ad.adapterSnapshot().wave === '3H61' || ad.adapterSnapshot().wave === '3H62' || ad.adapterSnapshot().wave === '3H63' || ad.adapterSnapshot().wave === '3H64');
  assert.equal(ad.adapterSnapshot().openrouterGenerate, false);
});

test('3H60-P-001 plus-prefixed fence unwrap is deterministic', () => {
  const plus = w.unwrapFencedToolArgs('+{"path":"/tmp/a"}');
  assert.equal(plus.unwrapped, true);
  assert.equal(plus.value.path, '/tmp/a');
  const clean = w.unwrapFencedToolArgs('{"path":"/tmp/a"}');
  assert.equal(clean.unwrapped, false);
});

function scriptedClient(script) {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          if (i >= script.length) throw new Error('scripted client exhausted');
          const turn = script[i++];
          if (turn.toolCalls) {
            return {
              choices: [{
                message: {
                  content: turn.content || null,
                  tool_calls: turn.toolCalls.map((c, idx) => ({
                    id: `call_${i}_${idx}`,
                    type: 'function',
                    function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
                  })),
                },
              }],
            };
          }
          return { choices: [{ message: { content: turn.content } }] };
        },
      },
    },
  };
}

test('3H60-Q-001 live loop cuts A-B-A-B oscillation without human intervention', async () => {
  const { runAgentLoop } = require('../src/services/agent-runner/loop');
  const result = await runAgentLoop({
    client: scriptedClient([
      { toolCalls: [{ name: 'read_file', args: { path: 'a' } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'a', content: 'x' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'a' } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'a', content: 'y' } }] },
      { content: 'done' },
    ]),
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'edita a' }],
    tools: [],
    executors: {
      read_file: async () => 'ok',
      write_file: async () => 'ok',
    },
    maxIterations: 8,
  });
  assert.equal(result.stoppedReason, 'loop_oscillation_cut');
  assert.ok(result.iterations <= 4);
  assert.equal(result.errorCode, 'loop_oscillation_cut');
});

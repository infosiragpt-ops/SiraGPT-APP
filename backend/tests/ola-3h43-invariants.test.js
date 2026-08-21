'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const ad = require('../src/services/agent-runner/engine-adapter');

test('3H43-A-001 tool arg bytes cap 32KiB with truncate marker', () => {
  const small = ad.capToolArgBytes32KiB({ a: 1 });
  assert.equal(small.truncated, false);
  const huge = 'x'.repeat(40 * 1024);
  const out = ad.capToolArgBytes32KiB(huge);
  assert.equal(out.truncated, true);
  assert.equal(out.code, 'tool_args_cap');
  assert.ok(String(out.args).includes('[truncated_tool_args]'));
  assert.ok(Buffer.byteLength(String(out.args), 'utf8') <= 32 * 1024);
});

test('3H43-B-001 repair unescaped newlines inside JSON strings', () => {
  const clean = ad.repairUnescapedNewlinesInJsonStrings('{"a":1}');
  assert.equal(clean.ok, true);
  assert.equal(clean.repaired, false);
  const raw = '{"a":"hello\nworld"}';
  const out = ad.repairUnescapedNewlinesInJsonStrings(raw);
  assert.equal(out.ok, true);
  assert.equal(out.repaired, true);
  assert.equal(out.value.a, 'hello\nworld');
});

test('3H43-C-001 coerce "null" string to null only for optional fields', () => {
  const sch = { type: 'object', required: ['id'], properties: { id: { type: 'string' }, note: { type: 'string', nullable: true } } };
  const out = ad.coerceNullStringToNullOptional({ id: 'null', note: 'null' }, sch);
  assert.equal(out.value.id, 'null');
  assert.equal(out.value.note, null);
  assert.equal(out.coerced, true);
});

test('3H43-D-001 max 16 SSE buffers per session drop oldest', () => {
  const bufs = Array.from({ length: 20 }, (_, i) => ({ id: i + 1 }));
  const out = ad.maxSseBuffersPerSession16(bufs);
  assert.equal(out.dropped, 4);
  assert.equal(out.buffers.length, 16);
  assert.equal(out.buffers[0].id, 5);
  assert.equal(out.code, 'sse_buffer_cap');
});

test('3H43-E-001 compact keeps pinned facts + last 3 user turns', () => {
  const msgs = [
    { role: 'system', content: 'old' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'user', content: 'u3' },
    { role: 'user', content: 'u4' },
  ];
  const out = ad.compactKeepPinnedFactsAndLast3UserTurns(msgs, { pins: [{ role: 'system', content: 'FACT' }] });
  const contents = out.messages.map((m) => m.content);
  assert.ok(contents.includes('FACT'));
  assert.ok(contents.includes('u2'));
  assert.ok(contents.includes('u4'));
  assert.equal(contents.includes('u1'), false);
});

test('3H43-F-001 refuse write if dest dir missing', () => {
  const ok = ad.refuseWriteIfDestDirMissing('/tmp/a.txt', { existsSync: () => true });
  assert.equal(ok.ok, true);
  const bad = ad.refuseWriteIfDestDirMissing('/no/such/dir/a.txt', { existsSync: () => false });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'dest_dir_missing');
});

test('3H43-G-001 ceil tokens on cancel', () => {
  const out = ad.ceilTokensOnCancel({ promptTokens: 1.2, completionTokens: 2.1, cancelled: true });
  assert.equal(out.promptTokens, 2);
  assert.equal(out.completionTokens, 3);
  assert.equal(out.tokens, 5);
  assert.equal(out.code, 'credit_ceil');
});

test('3H43-H-001 classify ECONNRESET as cancelled not 5xx', () => {
  const out = ad.classifyEconnresetAsCancelled({ code: 'ECONNRESET' });
  assert.equal(out.cancelled, true);
  assert.equal(out.family, 'cancelled');
  assert.equal(out.family === '5xx', false);
  assert.equal(out.code, 'cancelled');
  const other = ad.classifyEconnresetAsCancelled({ status: 503 });
  assert.equal(other.cancelled, false);
});

test('3H43-I-001 queue max wait 60s then 503 retry', () => {
  const ok = ad.queueMaxWait60sThen503({ waitedMs: 1000 });
  assert.equal(ok.reject, false);
  const over = ad.queueMaxWait60sThen503({ waitedMs: 60_000 });
  assert.equal(over.reject, true);
  assert.equal(over.status, 503);
  assert.equal(over.retry, true);
  assert.equal(over.code, 'queue_wait');
});

test('3H43-J-001 skip upsert if embedding dim mismatch', () => {
  const ok = ad.skipUpsertIfEmbeddingDimMismatch([1, 2, 3], { expectedDim: 3 });
  assert.equal(ok.skip, false);
  const bad = ad.skipUpsertIfEmbeddingDimMismatch([1, 2], { expectedDim: 1536 });
  assert.equal(bad.skip, true);
  assert.equal(bad.code, 'embedding_dim');
});

test('3H43-K-001 stall if no event 20s mid-stream', () => {
  const t0 = 1_000_000;
  const early = ad.stallIfNoEvent20sMidStream({ firstTokenAt: t0, lastEventAt: t0, now: t0 + 5_000 });
  assert.equal(early.stalled, false);
  const late = ad.stallIfNoEvent20sMidStream({ firstTokenAt: t0, lastEventAt: t0, now: t0 + 21_000 });
  assert.equal(late.stalled, true);
  assert.equal(late.code, 'stream_stall');
  const pre = ad.stallIfNoEvent20sMidStream({ now: t0 });
  assert.equal(pre.skipped, true);
});

test('3H43-L-001 strip UTF-16 NUL padding', () => {
  const padded = 'h\u0000e\u0000l\u0000l\u0000o\u0000';
  const out = ad.stripUtf16NulPadding(padded);
  assert.equal(out.text, 'hello');
  assert.equal(out.stripped, true);
  const clean = ad.stripUtf16NulPadding('hello');
  assert.equal(clean.stripped, false);
});

test('3H43-M-001 reject tool name longer than 64', () => {
  assert.equal(ad.rejectToolNameLongerThan64('read_file').ok, true);
  const bad = ad.rejectToolNameLongerThan64('n'.repeat(65));
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'tool_name_length');
});

test('3H43-N-001 reject recursive same tool name over 8', () => {
  const calls = Array.from({ length: 10 }, () => ({ name: 'read_file' }));
  calls.push({ name: 'write_file' });
  const out = ad.rejectRecursiveSameToolNameOver8(calls);
  assert.equal(out.dropped, 2);
  assert.equal(out.calls.length, 9);
  assert.equal(out.code, 'tool_recursion');
});

test('3H43-O-001 skip completed plan steps on resume', () => {
  const steps = [
    { id: 'a', status: 'completed' },
    { id: 'b', status: 'pending' },
    { id: 'c' },
  ];
  const out = ad.skipCompletedPlanStepsOnResume(steps, { completedIds: ['c'] });
  assert.equal(out.skipped, 2);
  assert.equal(out.steps.length, 1);
  assert.equal(out.steps[0].id, 'b');
});

test('3H43-P-001 gzip checkpoint payload if over 64KiB', () => {
  const small = ad.gzipCheckpointIfOver64KiB({ a: 1 });
  assert.equal(small.gzipped, false);
  const big = 'y'.repeat(70 * 1024);
  const out = ad.gzipCheckpointIfOver64KiB(big, { gzipFn: (buf) => zlib.gzipSync(buf) });
  assert.equal(out.gzipped, true);
  assert.equal(out.code, 'ckpt_gzip');
  assert.ok(out.gzipBytes < out.bytes);
});

test('3H43-Q-001 Last-Event-ID parse int-only', () => {
  assert.equal(ad.parseLastEventIdIntOnly('42').ok, true);
  assert.equal(ad.parseLastEventIdIntOnly('42').lastEventId, 42);
  assert.equal(ad.parseLastEventIdIntOnly('12abc').ok, false);
  assert.equal(ad.parseLastEventIdIntOnly('1.5').ok, false);
  assert.equal(ad.parseLastEventIdIntOnly('-3').ok, false);
});

test('3H43-R-001 glob cap file size 1MiB per match', () => {
  const out = ad.capGlobMatchFileSize1MiB([
    { path: 'a', size: 100 },
    { path: 'b', size: 2 * 1024 * 1024 },
  ]);
  assert.equal(out.dropped, 1);
  assert.equal(out.matches.length, 1);
  assert.equal(out.matches[0].path, 'a');
});

test('3H43-S-001 redact authorization bearer in tool results', () => {
  const out = ad.redactAuthorizationBearerInToolResults('Authorization: Bearer abc.def.ghi');
  assert.equal(out.redacted, true);
  assert.ok(String(out.text).includes('[REDACTED]'));
  assert.equal(/abc\.def/.test(String(out.text)), false);
});

test('3H43-T-001 refuse host_bash if computer-only turn', () => {
  const blocked = ad.refuseHostBashIfComputerOnlyTurn({ computerOnly: true, toolName: 'host_bash' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'host_bash_blocked');
  const ok = ad.refuseHostBashIfComputerOnlyTurn({ computerOnly: false, toolName: 'host_bash' });
  assert.equal(ok.ok, true);
  const other = ad.refuseHostBashIfComputerOnlyTurn({ computerOnly: true, toolName: 'computer_click' });
  assert.equal(other.ok, true);
});

test('3H43-U-001 subagent inherits remaining step budget', () => {
  const out = ad.subagentInheritRemainingStepBudget({ parentRemaining: 7, childRequested: 20, max: 10 });
  assert.equal(out.remaining, 7);
  assert.equal(out.inherited, true);
  const zero = ad.subagentInheritRemainingStepBudget({ parentRemaining: 0, childRequested: 5 });
  assert.equal(zero.remaining, 0);
  assert.equal(zero.code, 'subagent_budget');
});

test('3H43-V-001 concatenate split tool_call fragments', () => {
  const out = ad.concatenateSplitToolCallFragments(['{"a":', '1}']);
  assert.equal(out.ok, true);
  assert.equal(out.concatenated, true);
  assert.equal(out.value.a, 1);
  const one = ad.concatenateSplitToolCallFragments(['{"a":1}']);
  assert.equal(one.ok, true);
  assert.equal(one.concatenated, false);
});

test('3H43-W-001 never retry 402', () => {
  const out = ad.neverRetry402({ status: 402, message: 'Insufficient Balance' });
  assert.equal(out.retry, false);
  assert.equal(out.code, 'quota_exhausted');
  const other = ad.neverRetry402({ status: 429 });
  assert.equal(other.retry, null);
});

test('3H43-X-001 combined stdout stderr 96KiB', () => {
  const ok = ad.combinedStdoutStderr96KiB({ stdout: 'out', stderr: 'err' });
  assert.equal(ok.truncated, false);
  assert.ok(ok.text.includes('out'));
  const big = ad.combinedStdoutStderr96KiB({ stdout: 'A'.repeat(80 * 1024), stderr: 'B'.repeat(30 * 1024) });
  assert.equal(big.truncated, true);
  assert.ok(big.text.includes('[truncated_combined]'));
});

test('3H43-Y-001 ping only if last write over 15s', () => {
  const t0 = 5_000_000;
  const skip = ad.pingOnlyIfLastWriteOver15s({ lastWriteAt: t0, now: t0 + 1000 });
  assert.equal(skip.ping, false);
  const ping = ad.pingOnlyIfLastWriteOver15s({ lastWriteAt: t0, now: t0 + 16_000 });
  assert.equal(ping.ping, true);
});

test('3H43-Z-001 refuse unicode slash homoglyph', () => {
  assert.equal(ad.rejectUnicodeSlashHomoglyph('src/a.js').ok, true);
  const bad = ad.rejectUnicodeSlashHomoglyph('src\u2215a.js');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'path_homoglyph');
});

test('3H43-AA-001 session lock owner pid check', () => {
  const ok = ad.sessionLockOwnerPidCheck({ ownerPid: 42, currentPid: 42 });
  assert.equal(ok.ok, true);
  const bad = ad.sessionLockOwnerPidCheck({ ownerPid: 42, currentPid: 99 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'lock_pid');
});

test('3H43-AB-001 map Prisma disconnect to retryable', () => {
  const out = ad.mapPrismaDisconnectRetryable({ code: 'P1001', message: "Can't reach database server" });
  assert.equal(out.retryable, true);
  assert.equal(out.code, 'prisma_disconnect');
  const other = ad.mapPrismaDisconnectRetryable({ code: 'P2002' });
  assert.equal(other.retryable, false);
});

test('3H43-AC-001 default tool timeout 30s if missing', () => {
  const d = ad.defaultToolTimeout30sIfMissing(null);
  assert.equal(d.timeoutMs, 30_000);
  assert.equal(d.applied, true);
  const keep = ad.defaultToolTimeout30sIfMissing(8000);
  assert.equal(keep.timeoutMs, 8000);
  assert.equal(keep.applied, false);
});

test('3H43-AD-001 close SSE then settle credits order', () => {
  const first = ad.closeSseThenSettleCredits({ sseClosed: false, settled: false, held: true, cancelled: true });
  assert.equal(first.order, 'close_first');
  assert.equal(first.settle, false);
  const next = ad.closeSseThenSettleCredits({ sseClosed: true, settled: false, held: true, cancelled: true });
  assert.equal(next.order, 'settle');
  assert.equal(next.settle, true);
});

test('3H43-AE-001 snapshot keeps 3H42 flags and wave 3H43 DeepSeek lock', () => {
  const s = ad.adapterSnapshot();
  assert.equal(s.wave, '3H43');
  assert.equal(s.ensureUniqueToolCallIdsAcrossResume, true);
  assert.equal(s.enforceTotalTurnWall120s, true);
  assert.equal(s.capToolArgBytes32KiB, true);
  assert.equal(s.repairUnescapedNewlinesInJsonStrings, true);
  assert.equal(s.neverRetry402, true);
  assert.equal(s.closeSseThenSettleCredits, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
});

test('3H43-AF-001 live loop/queue/sse/gateway/sandbox import 3H43 helpers', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.ok(loop.includes('capToolArgBytes32KiB'));
  assert.ok(loop.includes('repairUnescapedNewlinesInJsonStrings'));
  assert.ok(loop.includes('rejectToolNameLongerThan64'));
  assert.ok(loop.includes('refuseHostBashIfComputerOnlyTurn'));
  assert.ok(loop.includes('stallIfNoEvent20sMidStream'));
  assert.ok(loop.includes('skipCompletedPlanStepsOnResume'));
  assert.ok(loop.includes('subagentInheritRemainingStepBudget'));
  const sse = read('src/utils/sse-writer.js');
  assert.ok(sse.includes('maxSseBuffersPerSession16'));
  assert.ok(sse.includes('pingOnlyIfLastWriteOver15s'));
  assert.ok(sse.includes('parseLastEventIdIntOnly'));
  const q = read('src/services/agent-gateway/queue.js');
  assert.ok(q.includes('queueMaxWait60sThen503'));
  const sb = read('src/services/sandbox/local-sandbox.js');
  assert.ok(sb.includes('combinedStdoutStderr96KiB'));
  const gw = read('src/services/agent-runner/engine-gateway.js');
  assert.ok(gw.includes('neverRetry402'));
  assert.ok(gw.includes('closeSseThenSettleCredits'));
  assert.ok(gw.includes('ceilTokensOnCancel'));
});

test('3H43-AG-001 error codes include 3H43 taxonomy', () => {
  const { CODES } = require('../src/services/error_codes');
  assert.equal(CODES.TOOL_ARGS_CAP, 'tool_args_cap');
  assert.equal(CODES.QUEUE_WAIT, 'queue_wait');
  assert.equal(CODES.STREAM_STALL, 'stream_stall');
  assert.equal(CODES.TOOL_NAME_LENGTH, 'tool_name_length');
  assert.equal(CODES.HOST_BASH_BLOCKED, 'host_bash_blocked');
  assert.equal(CODES.DEST_DIR_MISSING, 'dest_dir_missing');
  assert.equal(CODES.PATH_HOMOGLYPH, 'path_homoglyph');
  assert.equal(CODES.PRISMA_DISCONNECT, 'prisma_disconnect');
});

test('3H43-AH-001 public stream maps 3H43 codes in ES without traces', () => {
  const src = read('src/services/observability/public-stream-error.js');
  assert.ok(src.includes("code: 'tool_args_cap'"));
  assert.ok(src.includes("code: 'queue_wait'"));
  assert.ok(src.includes("code: 'host_bash_blocked'"));
  assert.ok(src.includes("code: 'stream_stall'"));
  assert.ok(src.includes("code: 'path_homoglyph'"));
  assert.equal(/sk-[a-zA-Z0-9]{8}/.test(src), false);
  assert.equal(/at Object\./.test(src), false);
});

test('3H43-AI-001 compose binds 3H43 tests and wave is 3H43', () => {
  assert.ok(String(__filename || '').includes('ola-3h43-invariants.test.js'));
  const src = read('src/services/agent-runner/engine-adapter.js');
  assert.ok(src.indexOf('3H43') >= 0);
  assert.equal(ad.adapterSnapshot().wave, '3H43');
  assert.equal(ad.refuseOpenRouterEnv({ SIRAGPT_USE_OPENROUTER: '1' }).ok, false);
  assert.equal(ad.allowDeepSeekGenerateModel('deepseek-v4-flash').ok, true);
});

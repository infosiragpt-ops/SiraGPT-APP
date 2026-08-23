'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const ad = require('../src/services/agent-runner/engine-adapter');

test('3H44-A-001 per-session inflight tools max 8', () => {
  const ok = ad.maxInflightToolsPerSession8(Array.from({ length: 7 }, (_, i) => i));
  assert.equal(ok.reject, false);
  const over = ad.maxInflightToolsPerSession8(8);
  assert.equal(over.reject, true);
  assert.equal(over.code, 'inflight_tools');
  const nine = ad.maxInflightToolsPerSession8(Array.from({ length: 9 }, (_, i) => i));
  assert.equal(nine.reject, true);
});

test('3H44-B-001 strip leftover // line comments then parse JSON', () => {
  const clean = ad.stripLeftoverLineCommentsInJson('{"a":1}');
  assert.equal(clean.ok, true);
  assert.equal(clean.repaired, false);
  const raw = '{\n  "a": 1, // leftover\n  "b": "keep // inside"\n}';
  const out = ad.stripLeftoverLineCommentsInJson(raw);
  assert.equal(out.ok, true);
  assert.equal(out.repaired, true);
  assert.equal(out.value.a, 1);
  assert.equal(out.value.b, 'keep // inside');
});

test('3H44-C-001 reject NaN and Infinity numbers', () => {
  const ok = ad.rejectNaNInfinityNumbers({ a: 1, b: 2.5 });
  assert.equal(ok.ok, true);
  const nan = ad.rejectNaNInfinityNumbers({ a: NaN });
  assert.equal(nan.ok, false);
  assert.equal(nan.code, 'nan_infinity');
  const inf = ad.rejectNaNInfinityNumbers([1, Infinity]);
  assert.equal(inf.ok, false);
});

test('3H44-D-001 drop SSE events older than 2 min', () => {
  const now = 1_000_000;
  const events = [
    { id: 1, at: now - 180_000 },
    { id: 2, at: now - 10_000 },
    { id: 3, at: now },
  ];
  const out = ad.dropSseEventsOlderThan2min(events, { now });
  assert.equal(out.dropped, 1);
  assert.equal(out.events.length, 2);
  assert.equal(out.events[0].id, 2);
  assert.equal(out.code, 'sse_stale');
});

test('3H44-E-001 cap compact summary 2KiB', () => {
  const small = ad.capCompactSummary2KiB('hola');
  assert.equal(small.truncated, false);
  const huge = 'x'.repeat(3000);
  const out = ad.capCompactSummary2KiB(huge);
  assert.equal(out.truncated, true);
  assert.ok(out.text.includes('[truncated_summary]'));
  assert.ok(Buffer.byteLength(out.text, 'utf8') <= 2048);
  assert.equal(out.code, 'compact_summary');
});

test('3H44-F-001 refuse write to /etc /proc /sys', () => {
  assert.equal(ad.refuseWriteToEtcProcSys('/tmp/a.txt').ok, true);
  const etc = ad.refuseWriteToEtcProcSys('/etc/passwd');
  assert.equal(etc.ok, false);
  assert.equal(etc.code, 'path_system');
  assert.equal(ad.refuseWriteToEtcProcSys('/proc/1/maps').ok, false);
  assert.equal(ad.refuseWriteToEtcProcSys('/sys/class/net').ok, false);
});

test('3H44-G-001 never negative usage', () => {
  const ok = ad.neverNegativeUsage({ promptTokens: 3, completionTokens: 4 });
  assert.equal(ok.promptTokens, 3);
  assert.equal(ok.clamped, false);
  const neg = ad.neverNegativeUsage({ promptTokens: -5, completionTokens: 2 });
  assert.equal(neg.promptTokens, 0);
  assert.equal(neg.completionTokens, 2);
  assert.equal(neg.clamped, true);
  assert.equal(neg.code, 'usage_negative');
});

test('3H44-H-001 queue fair share extra slot if wait >20s', () => {
  const no = ad.queueFairShareExtraSlotIfWaitOver20s({ waitedMs: 1000 });
  assert.equal(no.extraSlot, false);
  const yes = ad.queueFairShareExtraSlotIfWaitOver20s({ waitedMs: 21_000 });
  assert.equal(yes.extraSlot, true);
  assert.equal(yes.extra, 1);
  assert.equal(yes.code, 'queue_fair_share');
});

test('3H44-I-001 skip memory if score NaN', () => {
  const out = ad.skipMemoryIfScoreNaN([
    { id: 'a', score: 0.9 },
    { id: 'b', score: NaN },
    { id: 'c', score: 0.2 },
  ]);
  assert.equal(out.skipped, 1);
  assert.equal(out.facts.length, 2);
  assert.equal(out.facts[0].id, 'a');
  assert.equal(out.code, 'memory_score_nan');
});

test('3H44-J-001 cancel if three stream stalls', () => {
  const ok = ad.cancelIfThreeStreamStalls({ stallCount: 2 });
  assert.equal(ok.cancel, false);
  const stop = ad.cancelIfThreeStreamStalls({ stallCount: 3 });
  assert.equal(stop.cancel, true);
  assert.equal(stop.code, 'stream_stall_cancel');
});

test('3H44-K-001 strip bidi override chars', () => {
  const clean = ad.stripBidiOverrideChars('hola');
  assert.equal(clean.stripped, false);
  const raw = `ab\u202Ecd`;
  const out = ad.stripBidiOverrideChars(raw);
  assert.equal(out.stripped, true);
  assert.equal(out.text, 'abcd');
  assert.equal(out.code, 'bidi_strip');
});

test('3H44-L-001 tool name charset allowlist A-Za-z0-9_.-', () => {
  assert.equal(ad.rejectToolNameOutsideCharset('read_file').ok, true);
  assert.equal(ad.rejectToolNameOutsideCharset('computer.screenshot').ok, true);
  const bad = ad.rejectToolNameOutsideCharset('read file');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'tool_name_charset');
  assert.equal(ad.rejectToolNameOutsideCharset('tool/name').ok, false);
});

test('3H44-M-001 cycle detect A->B->A tool calls', () => {
  const ok = ad.rejectToolCallCycleAtoBtoA([
    { name: 'read_file' },
    { name: 'write_file' },
    { name: 'grep' },
  ]);
  assert.equal(ok.ok, true);
  const cyc = ad.rejectToolCallCycleAtoBtoA([
    { name: 'read_file' },
    { name: 'write_file' },
    { name: 'read_file' },
  ]);
  assert.equal(cyc.ok, false);
  assert.equal(cyc.code, 'tool_cycle');
});

test('3H44-N-001 max plan steps 24', () => {
  const ok = ad.capPlanSteps24(Array.from({ length: 10 }, (_, i) => ({ id: i })));
  assert.equal(ok.truncated, false);
  const over = ad.capPlanSteps24(Array.from({ length: 30 }, (_, i) => ({ id: i })));
  assert.equal(over.truncated, true);
  assert.equal(over.steps.length, 24);
  assert.equal(over.dropped, 6);
  assert.equal(over.code, 'plan_steps_cap');
});

test('3H44-O-001 refuse checkpoint >1MiB uncompressed', () => {
  const ok = ad.refuseCheckpointOver1MiBUncompressed({ a: 1 });
  assert.equal(ok.ok, true);
  const big = Buffer.alloc(1024 * 1024 + 10, 97);
  const over = ad.refuseCheckpointOver1MiBUncompressed(big);
  assert.equal(over.ok, false);
  assert.equal(over.code, 'ckpt_too_large');
});

test('3H44-P-001 reject Last-Event-ID going backwards', () => {
  const ok = ad.rejectLastEventIdGoingBackwards({ lastEventId: 12, currentSeq: 10 });
  assert.equal(ok.ok, true);
  const back = ad.rejectLastEventIdGoingBackwards({ lastEventId: 4, currentSeq: 10 });
  assert.equal(back.ok, false);
  assert.equal(back.backwards, true);
  assert.equal(back.code, 'sse_id_backwards');
});

test('3H44-Q-001 glob max 32 matches returned', () => {
  const ok = ad.capGlobMatchesReturned32(['a.js', 'b.js']);
  assert.equal(ok.truncated, false);
  const over = ad.capGlobMatchesReturned32(Array.from({ length: 40 }, (_, i) => `f${i}`));
  assert.equal(over.truncated, true);
  assert.equal(over.hits.length, 32);
  assert.equal(over.dropped, 8);
  assert.equal(over.code, 'glob_match_cap');
});

test('3H44-R-001 redact JWT-shaped strings', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3In0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const out = ad.redactJwtShapedStrings(`token=${jwt} ok`);
  assert.equal(out.redacted, true);
  assert.ok(out.text.includes('[REDACTED_JWT]'));
  assert.equal(out.text.includes(jwt), false);
  assert.equal(out.code, 'jwt_redact');
  const clean = ad.redactJwtShapedStrings('no token here');
  assert.equal(clean.redacted, false);
});

test('3H44-S-001 refuse computer_* if no userId', () => {
  const ok = ad.refuseComputerToolsIfNoUserId({ toolName: 'computer_click', userId: 'u1' });
  assert.equal(ok.ok, true);
  const bad = ad.refuseComputerToolsIfNoUserId({ toolName: 'computer_screenshot', userId: '' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'computer_no_user');
  const other = ad.refuseComputerToolsIfNoUserId({ toolName: 'read_file', userId: '' });
  assert.equal(other.ok, true);
});

test('3H44-T-001 min remaining subagent budget 1', () => {
  const keep = ad.minRemainingSubagentBudget1({ remaining: 7 });
  assert.equal(keep.remaining, 7);
  const zero = ad.minRemainingSubagentBudget1({ remaining: 0 });
  assert.equal(zero.remaining, 0);
  const missing = ad.minRemainingSubagentBudget1({ remaining: null });
  assert.equal(missing.remaining, 1);
  assert.equal(missing.applied, true);
  assert.equal(missing.code, 'subagent_min');
});

test('3H44-U-001 drop incomplete trailing tool call', () => {
  const ok = ad.dropIncompleteTrailingToolCall([
    { name: 'read_file', arguments: '{"path":"a"}' },
    { name: 'write_file', arguments: '{"path":"b"}' },
  ]);
  assert.equal(ok.dropped, false);
  const bad = ad.dropIncompleteTrailingToolCall([
    { name: 'read_file', arguments: '{"path":"a"}' },
    { name: 'write_file', arguments: '{"path":' },
  ]);
  assert.equal(bad.dropped, true);
  assert.equal(bad.calls.length, 1);
  assert.equal(bad.code, 'tool_call_incomplete');
});

test('3H44-V-001 never retry 413', () => {
  const out = ad.neverRetry413({ status: 413, message: 'Payload Too Large' });
  assert.equal(out.retry, false);
  assert.equal(out.code, 'payload_too_large');
  const other = ad.neverRetry413({ status: 429 });
  assert.equal(other.retry, null);
});

test('3H44-W-001 per-line stdout cap 8KiB', () => {
  const ok = ad.capStdoutLine8KiB('short\nok');
  assert.equal(ok.truncated, false);
  const line = 'A'.repeat(9000);
  const out = ad.capStdoutLine8KiB(`keep\n${line}\nend`);
  assert.equal(out.truncated, true);
  assert.ok(out.text.includes('[truncated_line]'));
  const mid = out.text.split('\n')[1];
  assert.ok(Buffer.byteLength(mid.replace('[truncated_line]', ''), 'utf8') <= 8 * 1024);
});

test('3H44-X-001 close if client gone 30s', () => {
  const t0 = 5_000_000;
  const keep = ad.closeIfClientGone30s({ lastClientAt: t0, now: t0 + 1000 });
  assert.equal(keep.close, false);
  const gone = ad.closeIfClientGone30s({ lastClientAt: t0, now: t0 + 30_000 });
  assert.equal(gone.close, true);
  assert.equal(gone.code, 'client_gone');
});

test('3H44-Y-001 session lock ttl 90s', () => {
  const t0 = 1_000_000;
  const ok = ad.sessionLockTtl90s({ acquiredAt: t0, now: t0 + 10_000 });
  assert.equal(ok.expired, false);
  const exp = ad.sessionLockTtl90s({ acquiredAt: t0, now: t0 + 90_000 });
  assert.equal(exp.expired, true);
  assert.equal(exp.steal, true);
  assert.equal(exp.code, 'lock_ttl');
});

test('3H44-Z-001 redis ECONNREFUSED retryable', () => {
  const out = ad.mapRedisEconnrefusedRetryable({ code: 'ECONNREFUSED', message: 'Redis connect' });
  assert.equal(out.retryable, true);
  assert.equal(out.code, 'redis_disconnect');
  const other = ad.mapRedisEconnrefusedRetryable({ code: 'P2002' });
  assert.equal(other.retryable, false);
});

test('3H44-AA-001 hard cap tool timeout 120s', () => {
  const keep = ad.hardCapToolTimeout120s(8000);
  assert.equal(keep.timeoutMs, 8000);
  assert.equal(keep.capped, false);
  const over = ad.hardCapToolTimeout120s(180_000);
  assert.equal(over.timeoutMs, 120_000);
  assert.equal(over.capped, true);
  assert.equal(over.code, 'tool_timeout_cap');
});

test('3H44-AB-001 flush last SSE event before close', () => {
  const flush = ad.flushLastSseEventBeforeClose({ pendingEvent: { id: 9 }, closed: false });
  assert.equal(flush.flush, true);
  assert.equal(flush.event.id, 9);
  assert.equal(flush.code, 'sse_flush');
  const already = ad.flushLastSseEventBeforeClose({ pendingEvent: { id: 9 }, closed: true });
  assert.equal(already.flush, false);
});

test('3H44-AC-001 max 8KB serialized tool list', () => {
  const ok = ad.capSerializedToolList8KB([{ name: 'read_file' }]);
  assert.equal(ok.truncated, false);
  const tools = Array.from({ length: 400 }, (_, i) => ({ name: `tool_${i}`, description: 'x'.repeat(40) }));
  const out = ad.capSerializedToolList8KB(tools);
  assert.equal(out.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(out.tools), 'utf8') <= 8 * 1024);
  assert.equal(out.code, 'tool_list_cap');
});

test('3H44-AD-001 screenshot-only no-charge', () => {
  const shot = ad.screenshotOnlyNoCharge({ tools: [{ name: 'computer_screenshot' }] });
  assert.equal(shot.charge, false);
  assert.equal(shot.code, 'credit_screenshot');
  const mix = ad.screenshotOnlyNoCharge({ tools: [{ name: 'computer_screenshot' }, { name: 'computer_click' }] });
  assert.equal(mix.charge, true);
});

test('3H44-AE-001 snapshot keeps 3H43 flags and wave 3H44 DeepSeek lock', () => {
  const s = ad.adapterSnapshot();
  assert.ok(s.wave === '3H44' || s.wave === '3H45' || s.wave === '3H46' || s.wave === '3H57');
  assert.equal(s.capToolArgBytes32KiB, true);
  assert.equal(s.neverRetry402, true);
  assert.equal(s.closeSseThenSettleCredits, true);
  assert.equal(s.maxInflightToolsPerSession8, true);
  assert.equal(s.neverRetry413, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
});

test('3H44-AF-001 live loop/queue/sse/gateway/sandbox import 3H44 helpers', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.ok(loop.includes('maxInflightToolsPerSession8'));
  assert.ok(loop.includes('stripLeftoverLineCommentsInJson'));
  assert.ok(loop.includes('rejectToolNameOutsideCharset'));
  assert.ok(loop.includes('refuseComputerToolsIfNoUserId'));
  assert.ok(loop.includes('refuseWriteToEtcProcSys'));
  assert.ok(loop.includes('cancelIfThreeStreamStalls'));
  assert.ok(loop.includes('neverRetry413'));
  const sse = read('src/utils/sse-writer.js');
  assert.ok(sse.includes('dropSseEventsOlderThan2min'));
  assert.ok(sse.includes('closeIfClientGone30s'));
  assert.ok(sse.includes('flushLastSseEventBeforeClose'));
  const q = read('src/services/agent-gateway/queue.js');
  assert.ok(q.includes('queueFairShareExtraSlotIfWaitOver20s'));
  const sb = read('src/services/sandbox/local-sandbox.js');
  assert.ok(sb.includes('capStdoutLine8KiB'));
  const gw = read('src/services/agent-runner/engine-gateway.js');
  assert.ok(gw.includes('neverNegativeUsage'));
  assert.ok(gw.includes('mapRedisEconnrefusedRetryable'));
  assert.ok(gw.includes('screenshotOnlyNoCharge'));
});

test('3H44-AG-001 error codes include 3H44 taxonomy', () => {
  const { CODES } = require('../src/services/error_codes');
  assert.equal(CODES.INFLIGHT_TOOLS, 'inflight_tools');
  assert.equal(CODES.PATH_SYSTEM, 'path_system');
  assert.equal(CODES.TOOL_CYCLE, 'tool_cycle');
  assert.equal(CODES.CKPT_TOO_LARGE, 'ckpt_too_large');
  assert.equal(CODES.SSE_ID_BACKWARDS, 'sse_id_backwards');
  assert.equal(CODES.COMPUTER_NO_USER, 'computer_no_user');
  assert.equal(CODES.PAYLOAD_TOO_LARGE, 'payload_too_large');
  assert.equal(CODES.CLIENT_GONE, 'client_gone');
  assert.equal(CODES.REDIS_DISCONNECT, 'redis_disconnect');
  assert.equal(CODES.CREDIT_SCREENSHOT, 'credit_screenshot');
});

test('3H44-AH-001 public stream maps 3H44 codes in ES without traces', () => {
  const src = read('src/services/observability/public-stream-error.js');
  assert.ok(src.includes("code: 'inflight_tools'"));
  assert.ok(src.includes("code: 'path_system'"));
  assert.ok(src.includes("code: 'tool_cycle'"));
  assert.ok(src.includes("code: 'computer_no_user'"));
  assert.ok(src.includes("code: 'payload_too_large'"));
  assert.ok(src.includes("code: 'client_gone'"));
  assert.ok(src.includes("code: 'redis_disconnect'"));
  assert.equal(/sk-[a-zA-Z0-9]{8}/.test(src), false);
  assert.equal(/at Object\./.test(src), false);
});

test('3H44-AI-001 compose binds 3H44 tests and wave is 3H44', () => {
  assert.ok(String(__filename || '').includes('ola-3h44-invariants.test.js'));
  const src = read('src/services/agent-runner/engine-adapter.js');
  assert.ok(src.indexOf('3H44') >= 0);
  assert.ok(ad.adapterSnapshot().wave === '3H44' || ad.adapterSnapshot().wave === '3H45' || ad.adapterSnapshot().wave === '3H46' || ad.adapterSnapshot().wave === '3H57');
  assert.equal(ad.refuseOpenRouterEnv({ SIRAGPT_USE_OPENROUTER: '1' }).ok, false);
  assert.equal(ad.allowDeepSeekGenerateModel('deepseek-v4-flash').ok, true);
});

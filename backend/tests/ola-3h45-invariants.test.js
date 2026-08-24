'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const ad = require('../src/services/agent-runner/engine-adapter');

test('3H45-A-001 cap tool result JSON 128KiB', () => {
  const ok = ad.capToolResultJson128KiB({ a: 1 });
  assert.equal(ok.truncated, false);
  const huge = 'x'.repeat(200 * 1024);
  const out = ad.capToolResultJson128KiB(huge);
  assert.equal(out.truncated, true);
  assert.ok(out.text.includes('[truncated_tool_result]'));
  assert.ok(Buffer.byteLength(out.text, 'utf8') <= 128 * 1024);
  assert.equal(out.code, 'tool_result_json_cap');
});

test('3H45-B-001 repair leftover single-quoted JSON keys', () => {
  const clean = ad.repairSingleQuotedKeysLeftover('{"a":1}');
  assert.equal(clean.ok, true);
  assert.equal(clean.repaired, false);
  const raw = "{'a': 1, \"b\": \"keep 'quotes'\"}";
  const out = ad.repairSingleQuotedKeysLeftover(raw);
  assert.equal(out.ok, true);
  assert.equal(out.repaired, true);
  assert.equal(out.value.a, 1);
  assert.equal(out.value.b, "keep 'quotes'");
});

test('3H45-C-001 reject -0 numbers', () => {
  const ok = ad.rejectNegativeZeroNumbers({ a: 0, b: 1 });
  assert.equal(ok.ok, true);
  const bad = ad.rejectNegativeZeroNumbers({ a: -0 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'negative_zero');
  const arr = ad.rejectNegativeZeroNumbers([1, -0]);
  assert.equal(arr.ok, false);
});

test('3H45-D-001 drop duplicate SSE event ids', () => {
  const out = ad.dropDuplicateSseEventIds([
    { id: 1, t: 'a' },
    { id: 2, t: 'b' },
    { id: 1, t: 'dup' },
    { id: 3, t: 'c' },
  ]);
  assert.equal(out.dropped, 1);
  assert.equal(out.events.length, 3);
  assert.equal(out.events[0].t, 'a');
  assert.equal(out.code, 'sse_dup_id');
});

test('3H45-E-001 compact never drops last assistant tool_calls', () => {
  const original = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', tool_calls: [{ id: 'c1', name: 'read_file' }] },
  ];
  const compacted = [{ role: 'user', content: 'hi' }];
  const out = ad.compactNeverDropLastAssistantToolCalls(original, compacted);
  assert.equal(out.restored, true);
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[1].tool_calls[0].id, 'c1');
  assert.equal(out.code, 'compact_keep_tool_calls');
  const keep = ad.compactNeverDropLastAssistantToolCalls(original, original);
  assert.equal(keep.restored, false);
});

test('3H45-F-001 refuse write to /dev and /boot', () => {
  assert.equal(ad.refuseWriteToDevBoot('/tmp/a.txt').ok, true);
  const dev = ad.refuseWriteToDevBoot('/dev/sda');
  assert.equal(dev.ok, false);
  assert.equal(dev.code, 'path_dev_boot');
  assert.equal(ad.refuseWriteToDevBoot('/boot/grub/grub.cfg').ok, false);
  assert.equal(ad.refuseWriteToEtcProcSys('/tmp/a.txt').ok, true);
});

test('3H45-G-001 ignore negative completion tokens', () => {
  const ok = ad.ignoreNegativeCompletionTokens({ promptTokens: 3, completionTokens: 4 });
  assert.equal(ok.completionTokens, 4);
  assert.equal(ok.ignored, false);
  const neg = ad.ignoreNegativeCompletionTokens({ promptTokens: 3, completionTokens: -9 });
  assert.equal(neg.completionTokens, 0);
  assert.equal(neg.promptTokens, 3);
  assert.equal(neg.ignored, true);
  assert.equal(neg.code, 'usage_ignore_neg_completion');
});

test('3H45-H-001 classify ENETUNREACH as timeout', () => {
  const out = ad.classifyEnetunreachAsTimeout({ code: 'ENETUNREACH', message: 'network unreachable' });
  assert.equal(out.timeout, true);
  assert.equal(out.retryable, true);
  assert.equal(out.code, 'net_timeout');
  const other = ad.classifyEnetunreachAsTimeout({ code: 'ECONNRESET' });
  assert.equal(other.timeout, false);
});

test('3H45-I-001 max 16 queued generate', () => {
  const ok = ad.maxQueuedGenerate16(15);
  assert.equal(ok.reject, false);
  const over = ad.maxQueuedGenerate16(16);
  assert.equal(over.reject, true);
  assert.equal(over.code, 'queue_generate_cap');
  const arr = ad.maxQueuedGenerate16(Array.from({ length: 17 }, (_, i) => i));
  assert.equal(arr.reject, true);
});

test('3H45-J-001 skip memory if vector all zeros', () => {
  const out = ad.skipMemoryIfVectorAllZeros([
    { id: 'a', vector: [0.1, 0.2] },
    { id: 'b', embedding: [0, 0, 0] },
    { id: 'c', vector: [0, 0.01] },
  ]);
  assert.equal(out.skipped, 1);
  assert.equal(out.facts.length, 2);
  assert.equal(out.facts[0].id, 'a');
  assert.equal(out.code, 'memory_zero_vector');
});

test('3H45-K-001 reset stall count on token', () => {
  const idle = ad.resetStallCountOnToken({ stallCount: 2 });
  assert.equal(idle.reset, false);
  assert.equal(idle.stallCount, 2);
  const tok = ad.resetStallCountOnToken({ stallCount: 2, token: 'h' });
  assert.equal(tok.reset, true);
  assert.equal(tok.stallCount, 0);
  assert.equal(tok.code, 'stall_reset');
});

test('3H45-L-001 strip Unicode tag chars U+E0000', () => {
  const clean = ad.stripTagCharsUPlusE0000('hola');
  assert.equal(clean.stripped, false);
  const raw = `ab\u{E0061}cd\u{E0001}`;
  const out = ad.stripTagCharsUPlusE0000(raw);
  assert.equal(out.stripped, true);
  assert.equal(out.text, 'abcd');
  assert.equal(out.code, 'tag_strip');
});

test('3H45-M-001 reject tool name starting with digit', () => {
  assert.equal(ad.rejectToolNameStartingWithDigit('read_file').ok, true);
  const bad = ad.rejectToolNameStartingWithDigit('1read');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'tool_name_digit');
  assert.equal(ad.rejectToolNameOutsideCharset('read_file').ok, true);
});

test('3H45-N-001 max unique tools 16 per turn', () => {
  const ok = ad.maxUniqueToolsPerTurn16(Array.from({ length: 10 }, (_, i) => ({ name: `t${i}` })));
  assert.equal(ok.truncated, false);
  const over = ad.maxUniqueToolsPerTurn16(Array.from({ length: 20 }, (_, i) => ({ name: `t${i}` })));
  assert.equal(over.truncated, true);
  assert.equal(over.calls.length, 16);
  assert.equal(over.unique, 16);
  assert.equal(over.dropped, 4);
  assert.equal(over.code, 'unique_tools_cap');
  const repeats = ad.maxUniqueToolsPerTurn16([
    ...Array.from({ length: 16 }, (_, i) => ({ name: `u${i}` })),
    { name: 'u0' },
    { name: 'new_one' },
  ]);
  assert.equal(repeats.calls.some((c) => c.name === 'u0'), true);
  assert.equal(repeats.calls.some((c) => c.name === 'new_one'), false);
});

test('3H45-O-001 refuse empty plan title', () => {
  assert.equal(ad.refuseEmptyPlanTitle('Plan A').ok, true);
  const empty = ad.refuseEmptyPlanTitle('   ');
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'plan_title_empty');
  assert.equal(ad.refuseEmptyPlanTitle({ title: '' }).ok, false);
  assert.equal(ad.capPlanSteps24([{ id: 1 }]).truncated, false);
});

test('3H45-P-001 crc32 check on checkpoint load', () => {
  const payload = Buffer.from('abc');
  const crc = zlib.crc32(payload) >>> 0;
  const ok = ad.crc32CheckOnCheckpointLoad(payload, { expectedCrc: crc });
  assert.equal(ok.ok, true);
  const bad = ad.crc32CheckOnCheckpointLoad(payload, { expectedCrc: crc ^ 1 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'ckpt_crc');
  const skip = ad.crc32CheckOnCheckpointLoad(payload, {});
  assert.equal(skip.ok, true);
  assert.equal(skip.skipped, true);
});

test('3H45-Q-001 skip hidden glob files', () => {
  const out = ad.skipHiddenGlobFiles(['src/a.js', '.env', 'lib/.cache/x', 'ok.txt']);
  assert.equal(out.skipped, 2);
  assert.deepEqual(out.hits, ['src/a.js', 'ok.txt']);
  assert.equal(out.code, 'glob_hidden');
  assert.equal(ad.capGlobMatchesReturned32(['a']).truncated, false);
});

test('3H45-R-001 redact sk- prefixes in results', () => {
  const raw = 'key=sk-abcDEFGH12345678 ok';
  const out = ad.redactSkPrefixesInResults(raw);
  assert.equal(out.redacted, true);
  assert.ok(out.text.includes('[REDACTED_SK]'));
  assert.equal(out.text.includes('sk-abcDEFGH12345678'), false);
  assert.equal(out.code, 'sk_redact');
  const clean = ad.redactSkPrefixesInResults('no secret');
  assert.equal(clean.redacted, false);
});

test('3H45-S-001 refuse computer_* if session missing', () => {
  const ok = ad.refuseComputerToolsIfSessionMissing({ toolName: 'computer_click', sessionId: 's1' });
  assert.equal(ok.ok, true);
  const bad = ad.refuseComputerToolsIfSessionMissing({ toolName: 'computer_screenshot', sessionId: '' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'computer_no_session');
  const other = ad.refuseComputerToolsIfSessionMissing({ toolName: 'read_file', sessionId: '' });
  assert.equal(other.ok, true);
});

test('3H45-T-001 refuse subagent if parent cancelled', () => {
  const ok = ad.refuseSubagentIfParentCancelled({ parentCancelled: false });
  assert.equal(ok.refuse, false);
  const bad = ad.refuseSubagentIfParentCancelled({ parentCancelled: true });
  assert.equal(bad.ok, false);
  assert.equal(bad.refuse, true);
  assert.equal(bad.code, 'subagent_parent_cancelled');
  const sig = ad.refuseSubagentIfParentCancelled({ signal: { aborted: true } });
  assert.equal(sig.refuse, true);
});

test('3H45-U-001 require tool call id', () => {
  const ok = ad.requireToolCallId([{ id: 'c1', name: 'read_file' }]);
  assert.equal(ok.ok, true);
  const bad = ad.requireToolCallId([
    { id: 'c1', name: 'read_file' },
    { name: 'write_file' },
  ]);
  assert.equal(bad.ok, false);
  assert.equal(bad.dropped, 1);
  assert.equal(bad.calls.length, 1);
  assert.equal(bad.code, 'tool_id_required');
});

test('3H45-V-001 never retry 451', () => {
  const out = ad.neverRetry451({ status: 451, message: 'Unavailable For Legal Reasons' });
  assert.equal(out.retry, false);
  assert.equal(out.code, 'legal_unavailable');
  const other = ad.neverRetry451({ status: 429 });
  assert.equal(other.retry, null);
  assert.equal(ad.neverRetry413({ status: 413 }).retry, false);
});

test('3H45-W-001 strip ANSI from sandbox out', () => {
  const clean = ad.stripAnsiFromSandboxOut('hello');
  assert.equal(clean.stripped, false);
  const raw = 'ok\x1B[31mred\x1B[0m done';
  const out = ad.stripAnsiFromSandboxOut(raw);
  assert.equal(out.stripped, true);
  assert.equal(out.text, 'okred done');
  assert.equal(out.code, 'ansi_strip');
});

test('3H45-X-001 session lock heartbeat every 20s', () => {
  const t0 = 1_000_000;
  const no = ad.sessionLockHeartbeatEvery20s({ lastBeatAt: t0, now: t0 + 1000 });
  assert.equal(no.beat, false);
  const yes = ad.sessionLockHeartbeatEvery20s({ lastBeatAt: t0, now: t0 + 20_000 });
  assert.equal(yes.beat, true);
  assert.equal(yes.code, 'lock_heartbeat');
  assert.equal(ad.sessionLockTtl90s({ acquiredAt: t0, now: t0 + 10_000 }).expired, false);
});

test('3H45-Y-001 redis EAI_AGAIN retryable', () => {
  const out = ad.mapRedisEaiAgainRetryable({ code: 'EAI_AGAIN', message: 'getaddrinfo' });
  assert.equal(out.retryable, true);
  assert.equal(out.code, 'redis_disconnect');
  const other = ad.mapRedisEaiAgainRetryable({ code: 'P2002' });
  assert.equal(other.retryable, false);
  assert.equal(ad.mapRedisEconnrefusedRetryable({ code: 'ECONNREFUSED' }).retryable, true);
});

test('3H45-Z-001 per-tool remaining wall clock', () => {
  const keep = ad.perToolRemainingWallClock({ timeoutMs: 8000, remainingMs: 30_000 });
  assert.equal(keep.timeoutMs, 8000);
  assert.equal(keep.applied, false);
  const cut = ad.perToolRemainingWallClock({ timeoutMs: 8000, remainingMs: 1500 });
  assert.equal(cut.timeoutMs, 1500);
  assert.equal(cut.applied, true);
  assert.equal(cut.code, 'tool_wall');
  assert.equal(ad.hardCapToolTimeout120s(8000).capped, false);
});

test('3H45-AA-001 end SSE with event:done', () => {
  const out = ad.endSseWithEventDone({ closed: false });
  assert.equal(out.write, true);
  assert.ok(out.frame.startsWith('event: done'));
  assert.equal(out.code, 'sse_done');
  const closed = ad.endSseWithEventDone({ closed: true });
  assert.equal(closed.write, false);
  assert.equal(ad.flushLastSseEventBeforeClose({ pendingEvent: { id: 1 }, closed: false }).flush, true);
});

test('3H45-AB-001 sort tools by name for cache', () => {
  const out = ad.sortToolsByNameForCache([{ name: 'write_file' }, { name: 'read_file' }]);
  assert.equal(out.sorted, true);
  assert.equal(out.tools[0].name, 'read_file');
  assert.equal(out.tools[1].name, 'write_file');
  assert.equal(out.code, 'tool_sort');
  const same = ad.sortToolsByNameForCache([{ name: 'a' }, { name: 'b' }]);
  assert.equal(same.sorted, false);
});

test('3H45-AC-001 observe-only no-charge', () => {
  const obs = ad.observeOnlyNoCharge({ tools: [{ name: 'computer_observe' }] });
  assert.equal(obs.charge, false);
  assert.equal(obs.code, 'credit_observe');
  const mix = ad.observeOnlyNoCharge({ tools: [{ name: 'computer_observe' }, { name: 'computer_click' }] });
  assert.equal(mix.charge, true);
  assert.equal(ad.screenshotOnlyNoCharge({ tools: [{ name: 'computer_screenshot' }] }).charge, false);
});

test('3H45-AD-001 snapshot keeps 3H44 flags and wave 3H45 DeepSeek lock', () => {
  const s = ad.adapterSnapshot();
  assert.ok(s.wave === '3H45' || s.wave === '3H46' || s.wave === '3H59' || s.wave === '3H60');
  assert.equal(s.maxInflightToolsPerSession8, true);
  assert.equal(s.neverRetry413, true);
  assert.equal(s.screenshotOnlyNoCharge, true);
  assert.equal(s.capToolResultJson128KiB, true);
  assert.equal(s.neverRetry451, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
});

test('3H45-AE-001 live loop/queue/sse/gateway/sandbox import 3H45 helpers', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.ok(loop.includes('capToolResultJson128KiB'));
  assert.ok(loop.includes('repairSingleQuotedKeysLeftover'));
  assert.ok(loop.includes('rejectToolNameStartingWithDigit'));
  assert.ok(loop.includes('refuseWriteToDevBoot'));
  assert.ok(loop.includes('refuseComputerToolsIfSessionMissing'));
  assert.ok(loop.includes('neverRetry451'));
  assert.ok(loop.includes('requireToolCallId'));
  const sse = read('src/utils/sse-writer.js');
  assert.ok(sse.includes('dropDuplicateSseEventIds'));
  assert.ok(sse.includes('endSseWithEventDone'));
  const q = read('src/services/agent-gateway/queue.js');
  assert.ok(q.includes('maxQueuedGenerate16'));
  const sb = read('src/services/sandbox/local-sandbox.js');
  assert.ok(sb.includes('stripAnsiFromSandboxOut'));
  const gw = read('src/services/agent-runner/engine-gateway.js');
  assert.ok(gw.includes('ignoreNegativeCompletionTokens'));
  assert.ok(gw.includes('mapRedisEaiAgainRetryable'));
  assert.ok(gw.includes('observeOnlyNoCharge'));
  assert.ok(gw.includes('classifyEnetunreachAsTimeout'));
});

test('3H45-AF-001 error codes include 3H45 taxonomy', () => {
  const { CODES } = require('../src/services/error_codes');
  assert.equal(CODES.TOOL_RESULT_JSON_CAP, 'tool_result_json_cap');
  assert.equal(CODES.PATH_DEV_BOOT, 'path_dev_boot');
  assert.equal(CODES.QUEUE_GENERATE_CAP, 'queue_generate_cap');
  assert.equal(CODES.CKPT_CRC, 'ckpt_crc');
  assert.equal(CODES.COMPUTER_NO_SESSION, 'computer_no_session');
  assert.equal(CODES.LEGAL_UNAVAILABLE, 'legal_unavailable');
  assert.equal(CODES.CREDIT_OBSERVE, 'credit_observe');
  assert.equal(CODES.CREDIT_SCREENSHOT, 'credit_screenshot');
});

test('3H45-AG-001 public stream maps 3H45 codes in ES without traces', () => {
  const src = read('src/services/observability/public-stream-error.js');
  assert.ok(src.includes("code: 'path_dev_boot'"));
  assert.ok(src.includes("code: 'computer_no_session'"));
  assert.ok(src.includes("code: 'legal_unavailable'"));
  assert.ok(src.includes("code: 'queue_generate_cap'"));
  assert.ok(src.includes("code: 'ckpt_crc'"));
  assert.equal(/sk-[a-zA-Z0-9]{8}/.test(src), false);
  assert.equal(/at Object\./.test(src), false);
});

test('3H45-AH-001 compose binds 3H45 tests and wave is 3H45', () => {
  assert.ok(String(__filename || '').includes('ola-3h45-invariants.test.js'));
  const src = read('src/services/agent-runner/engine-adapter.js');
  assert.ok(src.indexOf('3H45') >= 0);
  assert.ok(ad.adapterSnapshot().wave === '3H45' || ad.adapterSnapshot().wave === '3H46' || ad.adapterSnapshot().wave === '3H59' || ad.adapterSnapshot().wave === '3H60' || ad.adapterSnapshot().wave === '3H61');
  assert.equal(ad.refuseOpenRouterEnv({ SIRAGPT_USE_OPENROUTER: '1' }).ok, false);
  assert.equal(ad.allowDeepSeekGenerateModel('deepseek-v4-flash').ok, true);
});

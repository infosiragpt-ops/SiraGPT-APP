'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const ad = require('../src/services/agent-runner/engine-adapter');

test('3H46-A-001 reject prototype pollution keys', () => {
  const ok = ad.rejectPrototypePollutionKeys({ a: 1 });
  assert.equal(ok.ok, true);
  const bad = ad.rejectPrototypePollutionKeys(JSON.parse('{"__proto__": {"x":1}}'));
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'proto_pollution');
  const ctor = ad.rejectPrototypePollutionKeys({ constructor: { prototype: 1 } });
  assert.equal(ctor.ok, false);
});

test('3H46-B-001 drop duplicate tool call ids', () => {
  const out = ad.dropDuplicateToolCallIds([
    { id: 'c1', name: 'a' },
    { id: 'c2', name: 'b' },
    { id: 'c1', name: 'dup' },
  ]);
  assert.equal(out.dropped, 1);
  assert.equal(out.calls.length, 2);
  assert.equal(out.calls[0].name, 'a');
  assert.equal(out.code, 'tool_id_dup');
});

test('3H46-C-001 reject tool name starting with hyphen', () => {
  assert.equal(ad.rejectToolNameStartingWithHyphen('read_file').ok, true);
  const bad = ad.rejectToolNameStartingWithHyphen('-rm');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'tool_name_hyphen');
  assert.equal(ad.rejectToolNameStartingWithDigit('read_file').ok, true);
});

test('3H46-D-001 cap tool arg keys at 32', () => {
  const small = {};
  for (let i = 0; i < 8; i += 1) small['k'+i] = i;
  const ok = ad.capToolArgKeys32(small);
  assert.equal(ok.truncated, false);
  const big = {};
  for (let i = 0; i < 40; i += 1) big['k'+i] = i;
  const out = ad.capToolArgKeys32(big);
  assert.equal(out.truncated, true);
  assert.equal(Object.keys(out.args).length, 32);
  assert.equal(out.code, 'tool_arg_keys');
});

test('3H46-E-001 cap plan title 128 chars', () => {
  const ok = ad.capPlanTitle128Chars('Plan A');
  assert.equal(ok.truncated, false);
  const long = 'x'.repeat(200);
  const out = ad.capPlanTitle128Chars(long);
  assert.equal(out.truncated, true);
  assert.equal(out.title.length, 128);
  assert.equal(out.code, 'plan_title_cap');
  assert.equal(ad.refuseEmptyPlanTitle('ok').ok, true);
});

test('3H46-F-001 refuse duplicate plan step ids', () => {
  const out = ad.refuseDuplicatePlanStepIds([
    { id: 's1' }, { id: 's2' }, { id: 's1' },
  ]);
  assert.equal(out.dropped, 1);
  assert.equal(out.steps.length, 2);
  assert.equal(out.code, 'plan_step_dup');
});

test('3H46-G-001 compact never drops system prompt', () => {
  const original = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'hi' },
  ];
  const compacted = [{ role: 'user', content: 'hi' }];
  const out = ad.compactNeverDropSystemPrompt(original, compacted);
  assert.equal(out.restored, true);
  assert.equal(out.messages[0].role, 'system');
  assert.equal(out.code, 'compact_keep_system');
  const keep = ad.compactNeverDropSystemPrompt(original, original);
  assert.equal(keep.restored, false);
});

test('3H46-H-001 skip memory if ttl expired', () => {
  const now = 1_700_000_000_000;
  const out = ad.skipMemoryIfTtlExpired([
    { id: 1, expiresAt: now - 1000 },
    { id: 2, expiresAt: now + 1000 },
    { id: 3 },
  ], { now });
  assert.equal(out.skipped, 1);
  assert.equal(out.hits.length, 2);
  assert.equal(out.code, 'memory_ttl');
});

test('3H46-I-001 cap memory hits returned 8', () => {
  const hits = [];
  for (let i = 0; i < 12; i += 1) hits.push({ id: i });
  const out = ad.capMemoryHitsReturned8(hits);
  assert.equal(out.truncated, true);
  assert.equal(out.hits.length, 8);
  assert.equal(out.code, 'memory_hits_cap');
  const ok = ad.capMemoryHitsReturned8([{ id: 1 }]);
  assert.equal(ok.truncated, false);
});

test('3H46-J-001 crc32 stamp on checkpoint save', () => {
  const out = ad.crc32StampOnCheckpointSave({ a: 1 });
  assert.equal(typeof out.crc32, 'number');
  assert.equal(out.code, 'ckpt_crc_stamp');
  const load = ad.crc32CheckOnCheckpointLoad({ a: 1 });
  assert.equal(load.ok, true);
});
test('3H46-K-001 session lock steal if heartbeat stale', () => {
  const t0 = 1_000_000;
  const no = ad.sessionLockStealIfHeartbeatStale({ lastBeatAt: t0, now: t0 + 1000 });
  assert.equal(no.steal, false);
  const yes = ad.sessionLockStealIfHeartbeatStale({ lastBeatAt: t0, now: t0 + 40_000 });
  assert.equal(yes.steal, true);
  assert.equal(yes.code, 'lock_stale_steal');
});

test('3H46-L-001 refuse write to /root /mnt /media', () => {
  assert.equal(ad.refuseWriteToRootMnt('/tmp/a.txt').ok, true);
  const root = ad.refuseWriteToRootMnt('/root/.ssh/id');
  assert.equal(root.ok, false);
  assert.equal(root.code, 'path_root_mnt');
  assert.equal(ad.refuseWriteToRootMnt('/mnt/data').ok, false);
  assert.equal(ad.refuseWriteToDevBoot('/tmp/a.txt').ok, true);
});

test('3H46-M-001 skip vendor dir glob files', () => {
  const out = ad.skipVendorDirGlobFiles([
    'src/a.js',
    'pkg/vendor/lib.js',
    'ok/third_party/x.c',
  ]);
  assert.equal(out.skipped, 2);
  assert.equal(out.hits.length, 1);
  assert.equal(out.code, 'glob_vendor');
});

test('3H46-N-001 drop SSE comment frames from replay', () => {
  const out = ad.dropSseCommentFramesFromReplay([
    { event: 'token', id: 1 },
    { event: 'comment', id: 2 },
    { frame: ': keepalive', id: 3 },
  ]);
  assert.equal(out.dropped, 2);
  assert.equal(out.events.length, 1);
  assert.equal(out.code, 'sse_comment_drop');
});

test('3H46-O-001 cap replay frames 64', () => {
  const ev = [];
  for (let i = 0; i < 80; i += 1) ev.push({ id: i });
  const out = ad.capReplayFrames64(ev);
  assert.equal(out.truncated, true);
  assert.equal(out.events.length, 64);
  assert.equal(out.events[0].id, 16);
  assert.equal(out.code, 'sse_replay_cap');
});

test('3H46-P-001 end SSE with error event on abort', () => {
  const no = ad.endSseWithErrorEventOnAbort({ aborted: false });
  assert.equal(no.write, false);
  const yes = ad.endSseWithErrorEventOnAbort({ aborted: true, reason: 'client' });
  assert.equal(yes.write, true);
  assert.ok(yes.frame.indexOf('event: error') === 0);
  assert.equal(yes.code, 'sse_abort');
});

test('3H46-Q-001 ignore negative prompt tokens', () => {
  const ok = ad.ignoreNegativePromptTokens({ promptTokens: 3, completionTokens: 4 });
  assert.equal(ok.promptTokens, 3);
  assert.equal(ok.ignored, false);
  const neg = ad.ignoreNegativePromptTokens({ promptTokens: -9, completionTokens: 4 });
  assert.equal(neg.promptTokens, 0);
  assert.equal(neg.completionTokens, 4);
  assert.equal(neg.ignored, true);
  assert.equal(neg.code, 'usage_ignore_neg_prompt');
});

test('3H46-R-001 never charge if cancelled before first token', () => {
  const free = ad.neverChargeIfCancelledBeforeFirstToken({ cancelled: true, firstToken: false });
  assert.equal(free.charge, false);
  assert.equal(free.code, 'credit_cancel_pre_token');
  const pay = ad.neverChargeIfCancelledBeforeFirstToken({ cancelled: true, firstToken: true, tokens: 12 });
  assert.equal(pay.charge, true);
});

test('3H46-S-001 never retry 410 gone', () => {
  const out = ad.neverRetry410Gone({ status: 410 });
  assert.equal(out.retry, false);
  assert.equal(out.code, 'resource_gone');
  const other = ad.neverRetry410Gone({ status: 429 });
  assert.equal(other.retry, null);
  assert.equal(ad.neverRetry451({ status: 451 }).retry, false);
});

test('3H46-T-001 classify EHOSTUNREACH as timeout', () => {
  const out = ad.classifyEhostunreachAsTimeout({ code: 'EHOSTUNREACH', message: 'host unreachable' });
  assert.equal(out.timeout, true);
  assert.equal(out.retryable, true);
  assert.equal(out.code, 'net_timeout');
  const other = ad.classifyEhostunreachAsTimeout({ code: 'ECONNRESET' });
  assert.equal(other.timeout, false);
  assert.equal(ad.classifyEnetunreachAsTimeout({ code: 'ENETUNREACH' }).timeout, true);
});
test('3H46-U-001 postgres ECONNRESET retryable', () => {
  const out = ad.mapPostgresEconnresetRetryable({ code: 'ECONNRESET', message: 'postgres connection', client: 'pg' });
  assert.equal(out.retryable, true);
  assert.equal(out.code, 'pg_disconnect');
  const other = ad.mapPostgresEconnresetRetryable({ code: 'ECONNRESET', message: 'redis drop' });
  assert.equal(other.retryable, false);
});

test('3H46-V-001 abort if first byte over 45s', () => {
  const ok = ad.abortIfFirstByteOver45s({ elapsedMs: 1000 });
  assert.equal(ok.abort, false);
  const late = ad.abortIfFirstByteOver45s({ elapsedMs: 45_000 });
  assert.equal(late.abort, true);
  assert.equal(late.code, 'ttfb_abort');
  const got = ad.abortIfFirstByteOver45s({ elapsedMs: 60_000, firstByteAt: 10 });
  assert.equal(got.abort, false);
});

test('3H46-W-001 reject stale idempotency key over 1h', () => {
  const t0 = 1_000_000;
  const ok = ad.rejectStaleIdempotencyKeyOver1h({ createdAt: t0, now: t0 + 1000 });
  assert.equal(ok.ok, true);
  const stale = ad.rejectStaleIdempotencyKeyOver1h({ createdAt: t0, now: t0 + 60 * 60 * 1000 + 1 });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'idempotency_stale');
});

test('3H46-X-001 cap assistant message 64KiB', () => {
  const ok = ad.capAssistantMessage64KiB('hello');
  assert.equal(ok.truncated, false);
  const huge = 'x'.repeat(80 * 1024);
  const out = ad.capAssistantMessage64KiB(huge);
  assert.equal(out.truncated, true);
  assert.ok(out.text.indexOf('[truncated_assistant]') >= 0);
  assert.ok(Buffer.byteLength(out.text, 'utf8') <= 64 * 1024);
  assert.equal(out.code, 'assistant_cap');
});

test('3H46-Y-001 redact PEM private keys in results', () => {
  const clean = ad.redactPemPrivateKeysInResults('hello');
  assert.equal(clean.redacted, false);
  const pem = 'keep -----BEGIN RSA PRIVATE KEY-----SECRET-----END RSA PRIVATE KEY----- after';
  const out = ad.redactPemPrivateKeysInResults(pem);
  assert.equal(out.redacted, true);
  assert.ok(out.text.indexOf('[REDACTED_PEM]') >= 0);
  assert.equal(out.text.indexOf('SECRET') < 0, true);
  assert.equal(out.code, 'pem_redact');
});

test('3H46-Z-001 classify ECONNABORTED as cancelled', () => {
  const out = ad.classifyEconnabortedAsCancelled({ code: 'ECONNABORTED', message: 'aborted' });
  assert.equal(out.cancelled, true);
  assert.equal(out.retryable, false);
  assert.equal(out.code, 'net_cancelled');
  const other = ad.classifyEconnabortedAsCancelled({ code: 'ECONNRESET' });
  assert.equal(other.cancelled, false);
});

test('3H46-AA-001 refuse subagent if same tool as parent', () => {
  const ok = ad.refuseSubagentIfSameToolAsParent({ parentTool: 'read_file', childTool: 'write_file' });
  assert.equal(ok.ok, true);
  const bad = ad.refuseSubagentIfSameToolAsParent({ parentTool: 'read_file', childTool: 'read_file' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'subagent_same_tool');
  assert.equal(ad.refuseSubagentIfParentCancelled({ parentCancelled: false }).ok, true);
});

test('3H46-AB-001 sort memory hits by score desc', () => {
  const out = ad.sortMemoryHitsByScoreDesc([{ id: 1, score: 0.1 }, { id: 2, score: 0.9 }, { id: 3, score: 0.4 }]);
  assert.equal(out.sorted, true);
  assert.equal(out.hits[0].id, 2);
  assert.equal(out.hits[2].id, 1);
  assert.equal(out.code, 'memory_sort');
});

test('3H46-AC-001 reject tool call if args is array', () => {
  const ok = ad.rejectToolCallIfArgsIsArray([{ id: 'c1', arguments: { a: 1 } }]);
  assert.equal(ok.ok, true);
  const bad = ad.rejectToolCallIfArgsIsArray([{ id: 'c1', arguments: [1, 2] }]);
  assert.equal(bad.ok, false);
  assert.equal(bad.dropped, 1);
  assert.equal(bad.code, 'tool_args_array');
});

test('3H46-AD-001 snapshot keeps 3H45 flags and wave 3H46 DeepSeek lock', () => {
  const s = ad.adapterSnapshot();
  assert.ok(s.wave === '3H46' || s.wave === '3H47');
  assert.equal(s.capToolResultJson128KiB, true);
  assert.equal(s.neverRetry451, true);
  assert.equal(s.observeOnlyNoCharge, true);
  assert.equal(s.rejectPrototypePollutionKeys, true);
  assert.equal(s.neverRetry410Gone, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
});

test('3H46-AE-001 live loop/queue/sse/gateway import 3H46 helpers', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.ok(loop.includes('rejectPrototypePollutionKeys'));
  assert.ok(loop.includes('rejectToolNameStartingWithHyphen'));
  assert.ok(loop.includes('refuseWriteToRootMnt'));
  assert.ok(loop.includes('neverRetry410Gone'));
  assert.ok(loop.includes('compactNeverDropSystemPrompt'));
  const sse = read('src/utils/sse-writer.js');
  assert.ok(sse.includes('dropSseCommentFramesFromReplay'));
  assert.ok(sse.includes('capReplayFrames64'));
  assert.ok(sse.includes('endSseWithErrorEventOnAbort'));
  const q = read('src/services/agent-gateway/queue.js');
  assert.ok(q.includes('rejectStaleIdempotencyKeyOver1h'));
  const gw = read('src/services/agent-runner/engine-gateway.js');
  assert.ok(gw.includes('ignoreNegativePromptTokens'));
  assert.ok(gw.includes('mapPostgresEconnresetRetryable'));
  assert.ok(gw.includes('classifyEhostunreachAsTimeout'));
  assert.ok(gw.includes('neverChargeIfCancelledBeforeFirstToken'));
});

test('3H46-AF-001 error codes include 3H46 taxonomy', () => {
  const { CODES, httpStatusFor } = require('../src/services/error_codes');
  assert.equal(CODES.PROTO_POLLUTION, 'proto_pollution');
  assert.equal(CODES.PATH_ROOT_MNT, 'path_root_mnt');
  assert.equal(CODES.RESOURCE_GONE, 'resource_gone');
  assert.equal(CODES.CREDIT_OBSERVE, 'credit_observe');
  assert.equal(httpStatusFor('resource_gone'), 410);
});

test('3H46-AG-001 public stream maps 3H46 codes in ES without traces', () => {
  const src = read('src/services/observability/public-stream-error.js');
  assert.ok(src.includes("code: 'path_root_mnt'"));
  assert.ok(src.includes("code: 'resource_gone'"));
  assert.ok(src.includes("code: 'proto_pollution'"));
  assert.ok(src.includes("code: 'subagent_same_tool'"));
  assert.equal(/sk-[a-zA-Z0-9]{8}/.test(src), false);
  assert.equal(/at Object\./.test(src), false);
});

test('3H46-AH-001 compose binds 3H46 tests and wave is 3H46', () => {
  assert.ok(String(__filename || '').includes('ola-3h46-invariants.test.js'));
  const src = read('src/services/agent-runner/engine-adapter.js');
  assert.ok(src.indexOf('3H46') >= 0);
  assert.ok(ad.adapterSnapshot().wave === '3H46' || ad.adapterSnapshot().wave === '3H47');
  assert.equal(ad.refuseOpenRouterEnv({ SIRAGPT_USE_OPENROUTER: '1' }).ok, false);
  assert.equal(ad.allowDeepSeekGenerateModel('deepseek-v4-flash').ok, true);
});

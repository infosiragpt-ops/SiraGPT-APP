'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const ad = require('../src/services/agent-runner/engine-adapter');

test('3H49-A-001 reject tool name with colon', () => {
  assert.equal(ad.rejectToolNameWithColon('read_file').ok, true);
  const bad = ad.rejectToolNameWithColon('ns:read');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'tool_name_colon');
  assert.equal(ad.rejectToolNameWithSlash('read_file').ok, true);
});

test('3H49-B-001 cap tool arg nesting depth 8', () => {
  const ok = ad.capToolArgNestingDepth8({ a: { b: 1 } });
  assert.equal(ok.truncated, false);
  let deep = { v: 0 };
  for (let i = 0; i < 12; i += 1) deep = { n: deep };
  const out = ad.capToolArgNestingDepth8(deep);
  assert.equal(out.truncated, true);
  assert.equal(out.code, 'tool_arg_nest');
  assert.equal(ad.capToolArgArrayLength64({ a: [1] }).truncated, false);
});

test('3H49-C-001 refuse tool if call id blank', () => {
  assert.equal(ad.refuseToolIfCallIdBlank({ id: 'c1' }).ok, true);
  const bad = ad.refuseToolIfCallIdBlank({ id: '  ' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'tool_call_id_blank');
  assert.equal(ad.refuseToolIfNameNotString('read_file').ok, true);
});

test('3H49-D-001 refuse plan if status unknown', () => {
  assert.equal(ad.refusePlanIfStatusUnknown({ status: 'running' }).ok, true);
  const bad = ad.refusePlanIfStatusUnknown({ status: 'explode' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'plan_status_unknown');
  assert.equal(ad.refusePlanIfDependsNotArray({ depends: [] }).ok, true);
});

test('3H49-E-001 cap plan step count 48', () => {
  assert.equal(ad.capPlanStepCount48([{ id: 1 }]).truncated, false);
  const many = Array.from({ length: 60 }, (_, i) => ({ id: String(i) }));
  const out = ad.capPlanStepCount48(many);
  assert.equal(out.truncated, true);
  assert.equal(out.steps.length, 48);
  assert.equal(out.code, 'plan_step_count');
});

test('3H49-F-001 drop plan steps with blank title', () => {
  const out = ad.dropPlanStepsWithBlankTitle([{ id: 'a', title: 'Go' }, { id: 'b', title: '' }, { id: 'c' }]);
  assert.equal(out.dropped, 2);
  assert.equal(out.steps.length, 1);
  assert.equal(out.code, 'plan_step_blank_title');
});

test('3H49-G-001 skip memory if kind unknown', () => {
  const out = ad.skipMemoryIfKindUnknown([
    { id: 1, kind: 'fact' },
    { id: 2, kind: 'mystery' },
    { id: 3 },
  ]);
  assert.equal(out.skipped, 1);
  assert.equal(out.hits.length, 2);
  assert.equal(out.code, 'memory_kind_unknown');
});

test('3H49-H-001 cap memory key 64 chars', () => {
  const out = ad.capMemoryKeyChars64([{ id: 1, key: 'k'.repeat(80) }]);
  assert.equal(out.truncated, true);
  assert.equal(out.hits[0].key.length, 64);
  assert.equal(out.code, 'memory_key_cap');
});

test('3H49-I-001 refuse memory upsert if score NaN', () => {
  assert.equal(ad.refuseMemoryUpsertIfScoreNaN({ id: 'm1', score: 0.4 }).ok, true);
  const bad = ad.refuseMemoryUpsertIfScoreNaN({ score: 'nope' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'memory_score_nan');
});

test('3H49-J-001 refuse checkpoint if session missing', () => {
  assert.equal(ad.refuseCheckpointIfSessionMissing({ sessionId: 's1', seq: 1 }).ok, true);
  const bad = ad.refuseCheckpointIfSessionMissing({ seq: 1 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'ckpt_session_missing');
  assert.equal(ad.refuseCheckpointIfSeqMissing({ seq: 1 }).ok, true);
});

test('3H49-K-001 session lock refuse if token empty', () => {
  assert.equal(ad.sessionLockRefuseIfTokenEmpty({ token: 'tok-1' }).ok, true);
  const bad = ad.sessionLockRefuseIfTokenEmpty({ token: '' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'lock_token_empty');
  assert.equal(ad.sessionLockRefuseIfOwnerEmpty({ owner: 'pid-1' }).ok, true);
});

test('3H49-L-001 skip .env glob files', () => {
  const out = ad.skipDotEnvGlobFiles(['src/a.js', '.env', 'app/.env.local']);
  assert.equal(out.skipped, 2);
  assert.equal(out.hits.length, 1);
  assert.equal(out.code, 'glob_dot_env');
});

test('3H49-M-001 refuse write to /etc', () => {
  assert.equal(ad.refuseWriteToEtc('/tmp/out.txt').ok, true);
  const bad = ad.refuseWriteToEtc('/etc/shadow');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'path_etc');
  assert.equal(ad.refuseWriteToOpt('/tmp/x').ok, true);
});

test('3H49-N-001 skip dist glob files', () => {
  const out = ad.skipDistGlobFiles(['src/a.js', 'dist/bundle.js', 'app/build/out.js']);
  assert.equal(out.skipped, 2);
  assert.equal(out.hits.length, 1);
  assert.equal(out.code, 'glob_dist');
});

test('3H49-O-001 drop sse empty data frames from replay', () => {
  const out = ad.dropSseEmptyDataFramesFromReplay([
    { event: 'delta', data: 'x' },
    { data: '' },
    { event: 'empty', data: null },
  ]);
  assert.equal(out.dropped, 2);
  assert.equal(out.events.length, 1);
  assert.equal(out.code, 'sse_empty_data');
});

test('3H49-P-001 cap sse id 64 chars', () => {
  assert.equal(ad.capSseIdChars64('evt-1').truncated, false);
  const out = ad.capSseIdChars64('e'.repeat(80));
  assert.equal(out.truncated, true);
  assert.equal(out.id.length, 64);
  assert.equal(out.code, 'sse_id_cap');
});

test('3H49-Q-001 ignore negative reasoning tokens', () => {
  const out = ad.ignoreNegativeReasoningTokens({ reasoningTokens: -4 });
  assert.equal(out.ignored, true);
  assert.equal(out.reasoningTokens, 0);
  assert.equal(out.code, 'usage_ignore_neg_reasoning');
  assert.equal(ad.ignoreNegativeCachedTokens({ cachedTokens: 3 }).ignored, false);
});

test('3H49-R-001 never charge if safety blocked', () => {
  assert.equal(ad.neverChargeIfSafetyBlocked({ safetyBlocked: true }).charge, false);
  assert.equal(ad.neverChargeIfSafetyBlocked({ safetyBlocked: true }).code, 'credit_safety_blocked');
  assert.equal(ad.neverChargeIfSafetyBlocked({}).charge, true);
  assert.equal(ad.neverChargeIfPromptFiltered({}).charge, true);
});

test('3H49-S-001 never retry 403 forbidden', () => {
  const out = ad.neverRetry403Forbidden({ status: 403 });
  assert.equal(out.retry, false);
  assert.equal(out.code, 'forbidden');
  assert.equal(ad.neverRetry401Unauthorized({ status: 200 }).retry, null);
});

test('3H49-T-001 classify ENETRESET as unavailable', () => {
  const out = ad.classifyEnetresetAsUnavailable({ code: 'ENETRESET' });
  assert.equal(out.unavailable, true);
  assert.equal(out.retryable, true);
  assert.equal(out.code, 'enetreset');
});

test('3H49-U-001 map redis loading retryable', () => {
  const out = ad.mapRedisLoadingRetryable({ message: 'Redis is loading the dataset in memory' });
  assert.equal(out.retryable, true);
  assert.equal(out.code, 'redis_loading');
  assert.equal(ad.mapSqliteBusyRetryable({ code: 'ECONNRESET' }).retryable, false);
});

test('3H49-V-001 abort if parallel tools over 8', () => {
  const ok = ad.abortIfParallelToolsOver8({ count: 3 });
  assert.equal(ok.abort, false);
  const bad = ad.abortIfParallelToolsOver8({ count: 12 });
  assert.equal(bad.abort, true);
  assert.equal(bad.code, 'parallel_tools_cap');
});

test('3H49-W-001 reject idempotency key if not alnum dash', () => {
  assert.equal(ad.rejectIdempotencyKeyIfNotAlnumDash('abc-1_ok').ok, true);
  const bad = ad.rejectIdempotencyKeyIfNotAlnumDash('abc/1');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'idempotency_key_alnum');
  assert.equal(ad.rejectIdempotencyKeyWithWhitespace('abc-1').ok, true);
});

test('3H49-X-001 cap user message words 8000', () => {
  assert.equal(ad.capUserMessageWords8000('a b').truncated, false);
  const out = ad.capUserMessageWords8000(Array.from({ length: 8010 }, () => 'w').join(' '));
  assert.equal(out.truncated, true);
  assert.equal(out.code, 'user_msg_words');
  assert.ok(out.text.includes('[truncated_words]'));
});

test('3H49-Y-001 redact stripe secret keys in results', () => {
  const out = ad.redactStripeSecretKeysInResults('sk_live_abcdefghijklmnop');
  assert.equal(out.redacted, true);
  assert.equal(out.code, 'stripe_key_redact');
  assert.ok(out.text.includes('[REDACTED_STRIPE]'));
  assert.equal(ad.redactGcpServiceAccountInResults('ok').redacted, false);
});

test('3H49-Z-001 refuse subagent if parent missing', () => {
  assert.equal(ad.refuseSubagentIfParentMissing({ parentId: 'p1' }).ok, true);
  const bad = ad.refuseSubagentIfParentMissing({ parentId: '' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'subagent_parent_missing');
  assert.equal(ad.refuseSubagentIfNameHasSlash({ name: 'x' }).ok, true);
});

test('3H49-AA-001 cap sandbox stderr lines 500', () => {
  const out = ad.capSandboxStderrLines500(Array.from({ length: 510 }, () => 'e').join('\n'));
  assert.equal(out.truncated, true);
  assert.equal(out.code, 'sandbox_stderr_lines');
  assert.ok(out.text.includes('[truncated_stderr_lines]'));
});

test('3H49-AB-001 refuse sandbox if gid is zero', () => {
  assert.equal(ad.refuseSandboxIfGidIsZero({ gid: 1000 }).ok, true);
  const bad = ad.refuseSandboxIfGidIsZero({ gid: 0 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'sandbox_gid_zero');
  assert.equal(ad.refuseSandboxIfUidIsZero({ uid: 1000 }).ok, true);
});

test('3H49-AC-001 cap sandbox env value 256 chars', () => {
  const out = ad.capSandboxEnvValueChars256({ A: 'v', B: 'z'.repeat(300) });
  assert.equal(out.truncated, true);
  assert.equal(out.env.B.length, 256);
  assert.equal(out.code, 'sandbox_env_value');
});

test('3H49-AD-001 refuse sandbox if privileged true', () => {
  assert.equal(ad.refuseSandboxIfPrivilegedTrue({ privileged: false }).ok, true);
  const bad = ad.refuseSandboxIfPrivilegedTrue({ privileged: true });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'sandbox_privileged');
});

test('3H49-AE-001 refuse sandbox if cap-add present', () => {
  assert.equal(ad.refuseSandboxIfCapAddPresent({ capAdd: [] }).ok, true);
  const bad = ad.refuseSandboxIfCapAddPresent({ capAdd: ['NET_ADMIN'] });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'sandbox_cap_add');
});

test('3H49-AF-001 cap checkpoint payload 64KiB', () => {
  assert.equal(ad.capCheckpointPayload64KiB({ a: 1 }).ok, true);
  const bad = ad.capCheckpointPayload64KiB('x'.repeat(70000));
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'ckpt_payload_cap');
});

test('3H49-AG-001 snapshot keeps 3H48 flags and wave 3H49 DeepSeek lock', () => {
  const s = ad.adapterSnapshot();
  assert.equal(s.wave, '3H49');
  assert.equal(s.rejectPrototypePollutionKeys, true);
  assert.equal(s.rejectToolNameEndingWithDot, true);
  assert.equal(s.rejectToolNameWithSlash, true);
  assert.equal(s.refuseSandboxIfUidIsZero, true);
  assert.equal(s.rejectToolNameWithColon, true);
  assert.equal(s.refuseSandboxIfGidIsZero, true);
  assert.equal(s.neverRetry403Forbidden, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
});

test('3H49-AH-001 live loop/queue/sse/sandbox/gateway import 3H49 helpers', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.ok(loop.includes('rejectToolNameWithColon'));
  assert.ok(loop.includes('refuseWriteToEtc'));
  assert.ok(loop.includes('neverRetry403Forbidden'));
  assert.ok(loop.includes('MAX_ITERATIONS_DEFAULT = 25'));
  assert.ok(loop.includes('wrappedNoThrow') || loop.includes('wrapExecutors'));
  const sse = read('src/utils/sse-writer.js');
  assert.ok(sse.includes('capSseIdChars64'));
  assert.ok(sse.includes('dropSseEmptyDataFramesFromReplay'));
  const q = read('src/services/agent-gateway/queue.js');
  assert.ok(q.includes('rejectIdempotencyKeyIfNotAlnumDash'));
  const sb = read('src/services/sandbox/local-sandbox.js');
  assert.ok(sb.includes('capSandboxStderrLines500'));
  assert.ok(sb.includes('refuseSandboxIfGidIsZero'));
  assert.ok(sb.includes('refuseSandboxIfPrivilegedTrue'));
  const gw = read('src/services/agent-runner/engine-gateway.js');
  assert.ok(gw.includes('ignoreNegativeReasoningTokens'));
  assert.ok(gw.includes('neverChargeIfSafetyBlocked'));
  assert.ok(gw.includes('wrapExecutors'));
});

test('3H49-AI-001 error codes include 3H49 taxonomy', () => {
  const { CODES, httpStatusFor } = require('../src/services/error_codes');
  assert.equal(CODES.TOOL_NAME_COLON, 'tool_name_colon');
  assert.equal(CODES.PATH_ETC, 'path_etc');
  assert.equal(CODES.FORBIDDEN, 'forbidden');
  assert.equal(CODES.SANDBOX_GID_ZERO, 'sandbox_gid_zero');
  assert.equal(CODES.TOOL_NAME_SLASH, 'tool_name_slash');
  assert.equal(httpStatusFor('forbidden'), 403);
  assert.equal(httpStatusFor('unauthorized'), 401);
});

test('3H49-AJ-001 public stream maps 3H49 codes in ES without traces', () => {
  const src = read('src/services/observability/public-stream-error.js');
  assert.ok(src.includes("code: 'path_etc'"));
  assert.ok(src.includes("code: 'forbidden'"));
  assert.ok(src.includes("code: 'tool_name_colon'"));
  assert.ok(src.includes("code: 'sandbox_gid_zero'"));
  assert.ok(src.includes("code: 'credits_exhausted'") || src.includes('402'));
  assert.equal(/sk-[a-zA-Z0-9]{8}/.test(src), false);
  assert.equal(/at Object\./.test(src), false);
});

test('3H49-AK-001 compose binds 3H49 tests and wave is 3H49 DeepSeek only', () => {
  assert.ok(String(__filename || '').includes('ola-3h49-invariants.test.js'));
  const src = read('src/services/agent-runner/engine-adapter.js');
  assert.ok(src.indexOf('3H49') >= 0);
  assert.equal(ad.adapterSnapshot().wave, '3H49');
  assert.equal(ad.refuseOpenRouterEnv({ SIRAGPT_USE_OPENROUTER: '1' }).ok, false);
  assert.equal(ad.allowDeepSeekGenerateModel('deepseek-v4-flash').ok, true);
  const composeCandidates = [
    '/opt/siragpt/docker-compose.production.override.yml',
    path.join(ROOT, '..', 'docker-compose.production.override.yml'),
    path.join(ROOT, 'docker-compose.production.override.yml'),
  ];
  const composeFile = composeCandidates.find((p) => fs.existsSync(p));
  if (composeFile) {
    const compose = fs.readFileSync(composeFile, 'utf8');
    assert.ok(compose.includes('ola-3h49-invariants.test.js'));
    assert.ok(/FEATURE_DOC_ENGINE:\s*"1"/.test(compose));
  }
});

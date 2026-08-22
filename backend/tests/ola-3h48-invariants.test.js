'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const ad = require('../src/services/agent-runner/engine-adapter');

test('3H48-A-001 reject tool name with slash', () => {
  assert.equal(ad.rejectToolNameWithSlash('read_file').ok, true);
  const bad = ad.rejectToolNameWithSlash('fs/read');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'tool_name_slash');
  assert.equal(ad.rejectToolNameEndingWithDot('read_file').ok, true);
});

test('3H48-B-001 cap tool arg arrays at 64', () => {
  const ok = ad.capToolArgArrayLength64({ a: [1, 2] });
  assert.equal(ok.truncated, false);
  const long = Array.from({ length: 80 }, (_, i) => i);
  const out = ad.capToolArgArrayLength64({ a: long });
  assert.equal(out.truncated, true);
  assert.equal(out.args.a.length, 64);
  assert.equal(out.code, 'tool_arg_array');
});

test('3H48-C-001 refuse tool if name not string', () => {
  assert.equal(ad.refuseToolIfNameNotString('read_file').ok, true);
  const bad = ad.refuseToolIfNameNotString(12);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'tool_name_type');
  assert.equal(ad.rejectToolCallIfNameIsObject([{ name: 'ok' }]).ok, true);
});

test('3H48-D-001 refuse plan if depends not array', () => {
  assert.equal(ad.refusePlanIfDependsNotArray({ depends: ['a'] }).ok, true);
  const bad = ad.refusePlanIfDependsNotArray({ depends: { a: 1 } });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'plan_depends_type');
  assert.equal(ad.refusePlanIfStepsNotArray({ steps: [] }).ok, true);
});

test('3H48-E-001 cap plan description 256 chars', () => {
  assert.equal(ad.capPlanDescription256Chars('short').truncated, false);
  const out = ad.capPlanDescription256Chars('z'.repeat(300));
  assert.equal(out.truncated, true);
  assert.equal(out.description.length, 256);
  assert.equal(out.code, 'plan_desc_cap');
});

test('3H48-F-001 drop plan steps with empty id', () => {
  const out = ad.dropPlanStepsWithEmptyId([{ id: 'a' }, { id: '' }, { title: 'x' }]);
  assert.equal(out.dropped, 2);
  assert.equal(out.steps.length, 1);
  assert.equal(out.code, 'plan_step_empty_id');
});

test('3H48-G-001 skip memory if namespace blank', () => {
  const out = ad.skipMemoryIfNamespaceBlank([
    { id: 1, namespace: 'chat' },
    { id: 2, namespace: '' },
    { id: 3 },
  ]);
  assert.equal(out.skipped, 2);
  assert.equal(out.hits.length, 1);
  assert.equal(out.code, 'memory_ns_blank');
});

test('3H48-H-001 cap memory namespace 32 chars', () => {
  const out = ad.capMemoryNamespaceChars32([{ id: 1, namespace: 'n'.repeat(40) }]);
  assert.equal(out.truncated, true);
  assert.equal(out.hits[0].namespace.length, 32);
  assert.equal(out.code, 'memory_ns_cap');
});

test('3H48-I-001 refuse memory upsert if id empty', () => {
  assert.equal(ad.refuseMemoryUpsertIfIdEmpty({ id: 'm1' }).ok, true);
  const bad = ad.refuseMemoryUpsertIfIdEmpty({ id: '  ' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'memory_id_empty');
});

test('3H48-J-001 refuse checkpoint if seq missing', () => {
  assert.equal(ad.refuseCheckpointIfSeqMissing({ seq: 3 }).ok, true);
  const bad = ad.refuseCheckpointIfSeqMissing({ crc: 1 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'ckpt_seq_missing');
  assert.equal(ad.refuseCheckpointIfCrcMissing({ crc: 1 }).ok, true);
});

test('3H48-K-001 session lock refuse if owner empty', () => {
  assert.equal(ad.sessionLockRefuseIfOwnerEmpty({ owner: 'pid-1' }).ok, true);
  const bad = ad.sessionLockRefuseIfOwnerEmpty({ owner: '' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'lock_owner_empty');
});

test('3H48-L-001 skip .git glob files', () => {
  const out = ad.skipDotGitGlobFiles(['src/a.js', '.git/HEAD', 'pkg/.git/config']);
  assert.equal(out.skipped, 2);
  assert.equal(out.hits.length, 1);
  assert.equal(out.code, 'glob_dot_git');
});

test('3H48-M-001 refuse write to /opt', () => {
  assert.equal(ad.refuseWriteToOpt('/tmp/out.txt').ok, true);
  const bad = ad.refuseWriteToOpt('/opt/secret');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'path_opt');
  assert.equal(ad.refuseWriteToVarLogRun('/tmp/x').ok, true);
});

test('3H48-N-001 skip coverage glob files', () => {
  const out = ad.skipCoverageGlobFiles(['src/a.js', 'coverage/lcov.info', 'app/.nyc_output/out.json']);
  assert.equal(out.skipped, 2);
  assert.equal(out.hits.length, 1);
  assert.equal(out.code, 'glob_coverage');
});

test('3H48-O-001 drop sse ping frames from replay', () => {
  const out = ad.dropSsePingFramesFromReplay([
    { event: 'delta', data: 'x' },
    { event: 'ping' },
    { frame: ': ping' },
  ]);
  assert.equal(out.dropped, 2);
  assert.equal(out.events.length, 1);
  assert.equal(out.code, 'sse_ping_drop');
});

test('3H48-P-001 cap sse event name 32 chars', () => {
  assert.equal(ad.capSseEventName32Chars('delta').truncated, false);
  const out = ad.capSseEventName32Chars('e'.repeat(40));
  assert.equal(out.truncated, true);
  assert.equal(out.name.length, 32);
  assert.equal(out.code, 'sse_event_name');
});

test('3H48-Q-001 ignore negative cached tokens', () => {
  const out = ad.ignoreNegativeCachedTokens({ cachedTokens: -9, promptCacheTokens: 4 });
  assert.equal(out.ignored, true);
  assert.equal(out.cachedTokens, 0);
  assert.equal(out.code, 'usage_ignore_neg_cached');
  assert.equal(ad.ignoreNegativeTotalTokens({ totalTokens: 3 }).ignored, false);
});

test('3H48-R-001 never charge if prompt filtered', () => {
  assert.equal(ad.neverChargeIfPromptFiltered({ filtered: true }).charge, false);
  assert.equal(ad.neverChargeIfPromptFiltered({ filtered: true }).code, 'credit_prompt_filtered');
  assert.equal(ad.neverChargeIfPromptFiltered({}).charge, true);
  assert.equal(ad.neverChargeIfNoModelCall({ modelCalled: true }).charge, true);
});

test('3H48-S-001 never retry 401 unauthorized', () => {
  const out = ad.neverRetry401Unauthorized({ status: 401 });
  assert.equal(out.retry, false);
  assert.equal(out.code, 'unauthorized');
  assert.equal(ad.neverRetry408Timeout({ status: 200 }).retry, null);
});

test('3H48-T-001 classify EPROTO as unavailable', () => {
  const out = ad.classifyEprotoAsUnavailable({ code: 'EPROTO' });
  assert.equal(out.unavailable, true);
  assert.equal(out.retryable, true);
  assert.equal(out.code, 'eproto');
});

test('3H48-U-001 map sqlite busy retryable', () => {
  const out = ad.mapSqliteBusyRetryable({ code: 'SQLITE_BUSY' });
  assert.equal(out.retryable, true);
  assert.equal(out.code, 'sqlite_busy');
  assert.equal(ad.mapMysqlEconnresetRetryable({ code: 'ECONNRESET', client: 'pg' }).retryable, false);
});

test('3H48-V-001 abort if tool wall over 60s', () => {
  const ok = ad.abortIfToolWallOver60s({ startedAt: Date.now(), now: Date.now() });
  assert.equal(ok.abort, false);
  const bad = ad.abortIfToolWallOver60s({ elapsedMs: 61_000 });
  assert.equal(bad.abort, true);
  assert.equal(bad.code, 'tool_wall_abort');
});

test('3H48-W-001 reject idempotency key with whitespace', () => {
  assert.equal(ad.rejectIdempotencyKeyWithWhitespace('abc-1').ok, true);
  const bad = ad.rejectIdempotencyKeyWithWhitespace('abc 1');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'idempotency_key_ws');
  assert.equal(ad.rejectIdempotencyKeyOver128Chars('short').ok, true);
});

test('3H48-X-001 cap user message lines 400', () => {
  assert.equal(ad.capUserMessageLines400('a\nb').truncated, false);
  const out = ad.capUserMessageLines400(Array.from({ length: 410 }, () => 'x').join('\n'));
  assert.equal(out.truncated, true);
  assert.equal(out.code, 'user_msg_lines');
  assert.ok(out.text.includes('[truncated_lines]'));
});

test('3H48-Y-001 redact GCP service account in results', () => {
  const out = ad.redactGcpServiceAccountInResults('bot@proj.iam.gserviceaccount.com');
  assert.equal(out.redacted, true);
  assert.equal(out.code, 'gcp_sa_redact');
  assert.ok(out.text.includes('[REDACTED_GCP_SA]'));
  assert.equal(ad.redactAwsAccessKeysInResults('ok').redacted, false);
});

test('3H48-Z-001 classify ENOBUFS as unavailable', () => {
  const out = ad.classifyEnobufsAsUnavailable({ code: 'ENOBUFS' });
  assert.equal(out.unavailable, true);
  assert.equal(out.code, 'enobufs');
});

test('3H48-AA-001 refuse subagent if name has slash', () => {
  assert.equal(ad.refuseSubagentIfNameHasSlash({ name: 'research' }).ok, true);
  const bad = ad.refuseSubagentIfNameHasSlash({ name: 'a/b' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'subagent_name_slash');
  assert.equal(ad.refuseSubagentIfNameEmpty({ name: 'x' }).ok, true);
});

test('3H48-AB-001 cap sandbox env keys 16', () => {
  const env = {};
  for (let i = 0; i < 20; i += 1) env['K' + i] = 'v';
  const out = ad.capSandboxEnvKeys16(env);
  assert.equal(out.truncated, true);
  assert.equal(Object.keys(out.env).length, 16);
  assert.equal(out.code, 'sandbox_env_keys');
});

test('3H48-AC-001 refuse sandbox if network enabled', () => {
  assert.equal(ad.refuseSandboxIfNetworkEnabled({ network: false }).ok, true);
  const bad = ad.refuseSandboxIfNetworkEnabled({ network: true });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'sandbox_net');
});

test('3H48-AD-001 cap sandbox stdout lines 500', () => {
  const out = ad.capSandboxStdoutLines500(Array.from({ length: 510 }, () => 'l').join('\n'));
  assert.equal(out.truncated, true);
  assert.equal(out.code, 'sandbox_stdout_lines');
  assert.ok(out.text.includes('[truncated_stdout_lines]'));
});

test('3H48-AE-001 refuse sandbox if uid is zero', () => {
  assert.equal(ad.refuseSandboxIfUidIsZero({ uid: 1000 }).ok, true);
  const bad = ad.refuseSandboxIfUidIsZero({ uid: 0 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'sandbox_uid_zero');
  assert.equal(ad.refuseSandboxIfCwdIsRoot('/tmp').ok, true);
});

test('3H48-AF-001 sort plan steps by depends then order', () => {
  const out = ad.sortPlanStepsByDependsThenOrder([
    { id: 'c', order: 1, depends: ['a', 'b'] },
    { id: 'a', order: 2, depends: [] },
    { id: 'b', order: 1, depends: [] },
  ]);
  assert.equal(out.sorted, true);
  assert.equal(out.steps[0].id, 'b');
  assert.equal(out.steps[1].id, 'a');
  assert.equal(out.code, 'plan_step_depends_sort');
});

test('3H48-AG-001 snapshot keeps 3H47 flags and wave 3H48 DeepSeek lock', () => {
  const s = ad.adapterSnapshot();
  assert.ok(s.wave === '3H48' || s.wave === '3H49' || s.wave === '3H50');
  assert.equal(s.rejectPrototypePollutionKeys, true);
  assert.equal(s.rejectToolNameEndingWithDot, true);
  assert.equal(s.capSandboxArgv24, true);
  assert.equal(s.rejectToolNameWithSlash, true);
  assert.equal(s.refuseSandboxIfUidIsZero, true);
  assert.equal(s.neverRetry401Unauthorized, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
});

test('3H48-AH-001 live loop/queue/sse/sandbox/gateway import 3H48 helpers', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.ok(loop.includes('rejectToolNameWithSlash'));
  assert.ok(loop.includes('refuseWriteToOpt'));
  assert.ok(loop.includes('neverRetry401Unauthorized'));
  assert.ok(loop.includes('MAX_ITERATIONS_DEFAULT = 25'));
  assert.ok(loop.includes('wrappedNoThrow') || loop.includes('wrapExecutors'));
  const sse = read('src/utils/sse-writer.js');
  assert.ok(sse.includes('capSseEventName32Chars'));
  assert.ok(sse.includes('dropSsePingFramesFromReplay'));
  const q = read('src/services/agent-gateway/queue.js');
  assert.ok(q.includes('rejectIdempotencyKeyWithWhitespace'));
  const sb = read('src/services/sandbox/local-sandbox.js');
  assert.ok(sb.includes('capSandboxEnvKeys16'));
  assert.ok(sb.includes('refuseSandboxIfNetworkEnabled'));
  assert.ok(sb.includes('refuseSandboxIfUidIsZero'));
  const gw = read('src/services/agent-runner/engine-gateway.js');
  assert.ok(gw.includes('ignoreNegativeCachedTokens'));
  assert.ok(gw.includes('neverChargeIfPromptFiltered'));
  assert.ok(gw.includes('wrapExecutors'));
});

test('3H48-AI-001 error codes include 3H48 taxonomy', () => {
  const { CODES, httpStatusFor } = require('../src/services/error_codes');
  assert.equal(CODES.TOOL_NAME_SLASH, 'tool_name_slash');
  assert.equal(CODES.PATH_OPT, 'path_opt');
  assert.equal(CODES.UNAUTHORIZED, 'unauthorized');
  assert.equal(CODES.SANDBOX_UID_ZERO, 'sandbox_uid_zero');
  assert.equal(CODES.TOOL_NAME_DOT, 'tool_name_dot');
  assert.equal(httpStatusFor('unauthorized'), 401);
  assert.equal(httpStatusFor('request_timeout'), 408);
});

test('3H48-AJ-001 public stream maps 3H48 codes in ES without traces', () => {
  const src = read('src/services/observability/public-stream-error.js');
  assert.ok(src.includes("code: 'path_opt'"));
  assert.ok(src.includes("code: 'unauthorized'"));
  assert.ok(src.includes("code: 'tool_name_slash'"));
  assert.ok(src.includes("code: 'sandbox_uid_zero'"));
  assert.ok(src.includes("code: 'credits_exhausted'") || src.includes('402'));
  assert.equal(/sk-[a-zA-Z0-9]{8}/.test(src), false);
  assert.equal(/at Object\./.test(src), false);
});

test('3H48-AK-001 compose binds 3H48 tests and wave is 3H48 DeepSeek only', () => {
  assert.ok(String(__filename || '').includes('ola-3h48-invariants.test.js'));
  const src = read('src/services/agent-runner/engine-adapter.js');
  assert.ok(src.indexOf('3H48') >= 0);
  assert.ok(ad.adapterSnapshot().wave === '3H48' || ad.adapterSnapshot().wave === '3H49' || ad.adapterSnapshot().wave === '3H50');
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
    assert.ok(compose.includes('ola-3h48-invariants.test.js'));
    assert.ok(/FEATURE_DOC_ENGINE:\s*"1"/.test(compose));
  }
});

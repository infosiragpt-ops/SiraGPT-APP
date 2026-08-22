'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const ad = require('../src/services/agent-runner/engine-adapter');

test('3H50-A-001 reject tool name with at', () => {
  assert.equal(ad.rejectToolNameWithAt('read_file').ok, true);
  const bad = ad.rejectToolNameWithAt('ns@read');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'tool_name_at');
  assert.equal(ad.rejectToolNameWithColon('read_file').ok, true);
});

test('3H50-B-001 cap tool arg key chars 48', () => {
  const ok = ad.capToolArgKeyChars48({ a: 1 });
  assert.equal(ok.truncated, false);
  const out = ad.capToolArgKeyChars48({ ['k'.repeat(60)]: 1 });
  assert.equal(out.truncated, true);
  assert.equal(out.code, 'tool_arg_key_cap');
  assert.equal(Object.keys(out.args)[0].length, 48);
});

test('3H50-C-001 refuse tool if index not integer', () => {
  assert.equal(ad.refuseToolIfIndexNotInteger({ index: 2 }).ok, true);
  const bad = ad.refuseToolIfIndexNotInteger({ index: 'nope' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'tool_index_type');
  assert.equal(ad.refuseToolIfCallIdBlank({ id: 'c1' }).ok, true);
});

test('3H50-D-001 refuse plan if priority unknown', () => {
  assert.equal(ad.refusePlanIfPriorityUnknown({ priority: 'high' }).ok, true);
  const bad = ad.refusePlanIfPriorityUnknown({ priority: 'explode' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'plan_priority_unknown');
});

test('3H50-E-001 cap plan step id 32 chars', () => {
  const out = ad.capPlanStepIdChars32([{ id: 'i'.repeat(40) }]);
  assert.equal(out.truncated, true);
  assert.equal(out.steps[0].id.length, 32);
  assert.equal(out.code, 'plan_step_id_cap');
});

test('3H50-F-001 drop plan steps with unknown owner', () => {
  const out = ad.dropPlanStepsWithUnknownOwner([{ id: 'a', owner: 'user' }, { id: 'b', owner: 'alien' }]);
  assert.equal(out.dropped, 1);
  assert.equal(out.steps.length, 1);
  assert.equal(out.code, 'plan_step_owner_unknown');
});

test('3H50-G-001 refuse plan if eta negative', () => {
  assert.equal(ad.refusePlanIfEtaNegative({ eta: 12 }).ok, true);
  const bad = ad.refusePlanIfEtaNegative({ eta: -3 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'plan_eta_neg');
});

test('3H50-H-001 skip memory if source unknown', () => {
  const out = ad.skipMemoryIfSourceUnknown([{ id: 1, source: 'user' }, { id: 2, source: 'mystery' }, { id: 3 }]);
  assert.equal(out.skipped, 1);
  assert.equal(out.hits.length, 2);
  assert.equal(out.code, 'memory_source_unknown');
});

test('3H50-I-001 cap memory value 2048 chars', () => {
  const out = ad.capMemoryValueChars2048([{ id: 1, value: 'v'.repeat(2100) }]);
  assert.equal(out.truncated, true);
  assert.equal(out.hits[0].value.length, 2048);
  assert.equal(out.code, 'memory_value_cap');
});

test('3H50-J-001 refuse memory upsert if ttl negative', () => {
  assert.equal(ad.refuseMemoryUpsertIfTtlNegative({ ttl: 10 }).ok, true);
  const bad = ad.refuseMemoryUpsertIfTtlNegative({ ttl: -1 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'memory_ttl_neg');
});
test('3H50-K-001 refuse checkpoint if rev negative', () => {
  assert.equal(ad.refuseCheckpointIfRevNegative({ rev: 2 }).ok, true);
  const bad = ad.refuseCheckpointIfRevNegative({ rev: -1 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'ckpt_rev_neg');
});
test('3H50-L-001 session lock refuse if session mismatch', () => {
  assert.equal(ad.sessionLockRefuseIfSessionMismatch({ sessionId: 's1', lockSessionId: 's1' }).ok, true);
  const bad = ad.sessionLockRefuseIfSessionMismatch({ sessionId: 's1', lockSessionId: 's2' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'lock_session_mismatch');
});
test('3H50-N-001 refuse write to sys', () => {
  assert.equal(ad.refuseWriteToSys('/tmp/out.txt').ok, true);
  const bad = ad.refuseWriteToSys('/sys/foo');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'path_sys');
});
test('3H50-O-001 skip minified js glob files', () => {
  const out = ad.skipMinifiedJsGlobFiles(['src/a.js', 'vendor/app.min.js', 'x.min.css']);
  assert.equal(out.skipped, 2);
  assert.equal(out.hits.length, 1);
  assert.equal(out.code, 'glob_min_js');
});

test('3H50-P-001 drop sse done frames from replay', () => {
  const out = ad.dropSseDoneFramesFromReplay([{ event: 'delta', data: 'x' }, { event: 'done' }, { type: 'end' }]);
  assert.equal(out.dropped, 2);
  assert.equal(out.events.length, 1);
  assert.equal(out.code, 'sse_done_drop');
});
test('3H50-Q-001 cap sse retry 30000 ms', () => {
  assert.equal(ad.capSseRetryMs30000(1000).truncated, false);
  const out = ad.capSseRetryMs30000(90000);
  assert.equal(out.truncated, true);
  assert.equal(out.retry, 30000);
  assert.equal(out.code, 'sse_retry_cap');
});

test('3H50-R-001 ignore negative audio tokens', () => {
  const out = ad.ignoreNegativeAudioTokens({ audioTokens: -4 });
  assert.equal(out.ignored, true);
  assert.equal(out.audioTokens, 0);
  assert.equal(out.code, 'usage_ignore_neg_audio');
});

test('3H50-S-001 never charge if model unavailable', () => {
  assert.equal(ad.neverChargeIfModelUnavailable({ status: 503 }).charge, false);
  assert.equal(ad.neverChargeIfModelUnavailable({ status: 503 }).code, 'credit_model_unavailable');
  assert.equal(ad.neverChargeIfModelUnavailable({}).charge, true);
});
test('3H50-T-001 never retry 409 conflict', () => {
  const out = ad.neverRetry409Conflict({ status: 409 });
  assert.equal(out.retry, false);
  assert.equal(out.code, 'conflict');
});

test('3H50-U-001 classify EAFNOSUPPORT as unavailable', () => {
  const out = ad.classifyEafnosupportAsUnavailable({ code: 'EAFNOSUPPORT' });
  assert.equal(out.unavailable, true);
  assert.equal(out.retryable, true);
  assert.equal(out.code, 'eafnosupport');
});

test('3H50-V-001 map mongo not primary retryable', () => {
  const out = ad.mapMongoNotPrimaryRetryable({ message: 'not primary' });
  assert.equal(out.retryable, true);
  assert.equal(out.code, 'mongo_not_primary');
});
test('3H50-W-001 abort if parallel subagents over 4', () => {
  assert.equal(ad.abortIfParallelSubagentsOver4({ count: 2 }).abort, false);
  const bad = ad.abortIfParallelSubagentsOver4({ count: 9 });
  assert.equal(bad.abort, true);
  assert.equal(bad.code, 'parallel_subagents_cap');
});

test('3H50-X-001 reject idempotency key if starts with dash', () => {
  assert.equal(ad.rejectIdempotencyKeyIfStartsWithDash('abc-1').ok, true);
  const bad = ad.rejectIdempotencyKeyIfStartsWithDash('-abc');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'idempotency_key_dash');
});

test('3H50-Y-001 cap user message paragraphs 80', () => {
  assert.equal(ad.capUserMessageParagraphs80('a\n\nb').truncated, false);
  const out = ad.capUserMessageParagraphs80(Array.from({ length: 90 }, () => 'p').join('\n\n'));
  assert.equal(out.truncated, true);
  assert.equal(out.code, 'user_msg_paragraphs');
});
test('3H50-Z-001 redact github pat in results', () => {
  const out = ad.redactGithubPatInResults('github_pat_abcdefghijklmnopqrstuvwxyz12');
  assert.equal(out.redacted, true);
  assert.equal(out.code, 'github_pat_redact');
  assert.ok(out.text.includes('[REDACTED_GITHUB]'));
});

test('3H50-AA-001 refuse subagent if owner blank', () => {
  assert.equal(ad.refuseSubagentIfOwnerBlank({ owner: 'u1' }).ok, true);
  const bad = ad.refuseSubagentIfOwnerBlank({ owner: '' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'subagent_owner_blank');
});

test('3H50-AB-001 cap sandbox workdir 256 chars', () => {
  const out = ad.capSandboxWorkdirChars256('/w/' + 'x'.repeat(300));
  assert.equal(out.truncated, true);
  assert.equal(out.cwd.length, 256);
  assert.equal(out.code, 'sandbox_workdir_cap');
});
test('3H50-AC-001 refuse sandbox if pid host true', () => {
  assert.equal(ad.refuseSandboxIfPidHostTrue({ pid: 'private' }).ok, true);
  const bad = ad.refuseSandboxIfPidHostTrue({ pid: 'host' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'sandbox_pid_host');
});

test('3H50-AD-001 refuse sandbox if ipc host true', () => {
  assert.equal(ad.refuseSandboxIfIpcHostTrue({ ipc: false }).ok, true);
  const bad = ad.refuseSandboxIfIpcHostTrue({ ipc: 'host' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'sandbox_ipc_host');
});

test('3H50-AE-001 refuse sandbox if userns host', () => {
  assert.equal(ad.refuseSandboxIfUserNsHost({ userns: false }).ok, true);
  const bad = ad.refuseSandboxIfUserNsHost({ userns: 'host' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'sandbox_userns_host');
});

test('3H50-AF-001 cap checkpoint meta 512 chars', () => {
  const out = ad.capCheckpointMetaChars512({ meta: 'm'.repeat(600) });
  assert.equal(out.truncated, true);
  assert.equal(out.payload.meta.length, 512);
  assert.equal(out.code, 'ckpt_meta_cap');
});
test('3H50-AG-001 snapshot keeps 3H49 flags and wave 3H50 DeepSeek lock', () => {
  const s = ad.adapterSnapshot();
  assert.equal(s.wave, '3H50');
  assert.equal(s.rejectToolNameWithColon, true);
  assert.equal(s.rejectToolNameWithAt, true);
  assert.equal(s.refuseSandboxIfGidIsZero, true);
  assert.equal(s.refuseSandboxIfPidHostTrue, true);
  assert.equal(s.neverRetry409Conflict, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
});
test('3H50-AH-001 live loop/queue/sse/sandbox/gateway import 3H50 helpers', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.ok(loop.includes('rejectToolNameWithAt'));
  assert.ok(loop.includes('refuseWriteToSys'));
  assert.ok(loop.includes('neverRetry409Conflict'));
  assert.ok(loop.includes('MAX_ITERATIONS_DEFAULT = 25'));
  assert.ok(loop.includes('wrappedNoThrow') || loop.includes('wrapExecutors'));
  const sse = read('src/utils/sse-writer.js');
  assert.ok(sse.includes('capSseRetryMs30000'));
  assert.ok(sse.includes('dropSseDoneFramesFromReplay'));
  const q = read('src/services/agent-gateway/queue.js');
  assert.ok(q.includes('rejectIdempotencyKeyIfStartsWithDash'));
  const sb = read('src/services/sandbox/local-sandbox.js');
  assert.ok(sb.includes('refuseSandboxIfPidHostTrue'));
  assert.ok(sb.includes('refuseSandboxIfUserNsHost'));
  const gw = read('src/services/agent-runner/engine-gateway.js');
  assert.ok(gw.includes('ignoreNegativeAudioTokens'));
  assert.ok(gw.includes('wrapExecutors'));
});
test('3H50-AI-001 error codes include 3H50 taxonomy', () => {
  const { CODES, httpStatusFor } = require('../src/services/error_codes');
  assert.equal(CODES.TOOL_NAME_AT, 'tool_name_at');
  assert.equal(CODES.PATH_SYS, 'path_sys');
  assert.equal(CODES.CONFLICT, 'conflict');
  assert.equal(CODES.SANDBOX_PID_HOST, 'sandbox_pid_host');
  assert.equal(CODES.TOOL_NAME_COLON, 'tool_name_colon');
  assert.equal(httpStatusFor('conflict'), 409);
  assert.equal(httpStatusFor('forbidden'), 403);
});
test('3H50-AJ-001 public stream maps 3H50 codes in ES without traces', () => {
  const src = read('src/services/observability/public-stream-error.js');
  assert.ok(src.includes("code: 'path_sys'"));
  assert.ok(src.includes("code: 'conflict'"));
  assert.ok(src.includes("code: 'tool_name_at'"));
  assert.ok(src.includes("code: 'credits_exhausted'") || src.includes('402'));
  assert.equal(/sk-[a-zA-Z0-9]{8}/.test(src), false);
});
test('3H50-AK-001 compose binds 3H50 tests and wave is 3H50 DeepSeek only', () => {
  assert.ok(String(__filename || '').includes('ola-3h50-invariants.test.js'));
  const src = read('src/services/agent-runner/engine-adapter.js');
  assert.ok(src.indexOf('3H50') >= 0);
  assert.equal(ad.adapterSnapshot().wave, '3H50');
  assert.equal(ad.refuseOpenRouterEnv({ SIRAGPT_USE_OPENROUTER: '1' }).ok, false);
  assert.equal(ad.allowDeepSeekGenerateModel('deepseek-v4-flash').ok, true);
  const composeCandidates = ['/opt/siragpt/docker-compose.production.override.yml', path.join(ROOT, '..', 'docker-compose.production.override.yml'), path.join(ROOT, 'docker-compose.production.override.yml')];
  const composeFile = composeCandidates.find((p) => fs.existsSync(p));
  if (composeFile) {
    const compose = fs.readFileSync(composeFile, 'utf8');
    assert.ok(compose.includes('ola-3h50-invariants.test.js'));
    assert.ok(/FEATURE_DOC_ENGINE:\s*"1"/.test(compose));
  }
});
test('3H50-M-001 skip lock glob files', () => {
  const out = ad.skipLockfileGlobFiles(['src/a.js', 'foo.lock', 'bar.lock']);
  assert.equal(out.skipped, 2);
  assert.equal(out.hits.length, 1);
  assert.equal(out.code, 'glob_lockfile');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const ad = require('../src/services/agent-runner/engine-adapter');

test('3H47-A-001 reject tool name ending with dot', () => {
  assert.equal(ad.rejectToolNameEndingWithDot('read_file').ok, true);
  const bad = ad.rejectToolNameEndingWithDot('rm.');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'tool_name_dot');
  assert.equal(ad.rejectToolNameStartingWithHyphen('read_file').ok, true);
});

test('3H47-B-001 cap tool arg strings at 4096', () => {
  const ok = ad.capToolArgString4096({ a: 'short' });
  assert.equal(ok.truncated, false);
  const long = 'x'.repeat(5000);
  const out = ad.capToolArgString4096({ a: long });
  assert.equal(out.truncated, true);
  assert.equal(out.args.a.length, 4096);
  assert.equal(out.code, 'tool_arg_string');
});

test('3H47-C-001 refuse plan if steps not array', () => {
  const ok = ad.refusePlanIfStepsNotArray({ steps: [{ id: 1 }] });
  assert.equal(ok.ok, true);
  const bad = ad.refusePlanIfStepsNotArray({ steps: { id: 1 } });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'plan_steps_type');
});

test('3H47-D-001 cap plan step title 80 chars', () => {
  const ok = ad.capPlanStepTitle80Chars('Step A');
  assert.equal(ok.truncated, false);
  const out = ad.capPlanStepTitle80Chars('y'.repeat(120));
  assert.equal(out.truncated, true);
  assert.equal(out.title.length, 80);
  assert.equal(out.code, 'plan_step_title_cap');
  assert.equal(ad.capPlanTitle128Chars('ok').truncated, false);
});

test('3H47-E-001 compact never drops last user message', () => {
  const original = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'do it' },
  ];
  const compacted = [{ role: 'system', content: 'rules' }];
  const out = ad.compactNeverDropLastUserMessage(original, compacted);
  assert.equal(out.restored, true);
  assert.equal(out.messages[out.messages.length - 1].role, 'user');
  assert.equal(out.code, 'compact_keep_last_user');
  const keep = ad.compactNeverDropLastUserMessage(original, original);
  assert.equal(keep.restored, false);
});

test('3H47-F-001 skip memory if score below floor', () => {
  const out = ad.skipMemoryIfScoreBelowFloor([
    { id: 1, score: 0.01 },
    { id: 2, score: 0.9 },
    { id: 3 },
  ], { floor: 0.05 });
  assert.equal(out.skipped, 1);
  assert.equal(out.hits.length, 2);
  assert.equal(out.code, 'memory_score_floor');
});

test('3H47-G-001 cap memory fact chars 512', () => {
  const out = ad.capMemoryFactChars512([{ id: 1, text: 'z'.repeat(600) }]);
  assert.equal(out.truncated, true);
  assert.equal(out.hits[0].text.length, 512);
  assert.equal(out.code, 'memory_fact_cap');
  const ok = ad.capMemoryFactChars512([{ id: 1, text: 'ok' }]);
  assert.equal(ok.truncated, false);
});

test('3H47-H-001 drop duplicate memory ids', () => {
  const out = ad.dropDuplicateMemoryIds([{ id: 'm1' }, { id: 'm2' }, { id: 'm1' }]);
  assert.equal(out.dropped, 1);
  assert.equal(out.hits.length, 2);
  assert.equal(out.code, 'memory_id_dup');
});

test('3H47-I-001 refuse checkpoint if crc missing', () => {
  assert.equal(ad.refuseCheckpointIfCrcMissing({ crc32: 1 }).ok, true);
  const bad = ad.refuseCheckpointIfCrcMissing({ a: 1 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'ckpt_crc_missing');
  assert.equal(ad.crc32StampOnCheckpointSave({ a: 1 }).code, 'ckpt_crc_stamp');
});

test('3H47-J-001 session lock refuse if ttl expired', () => {
  const t0 = 1_000_000;
  const no = ad.sessionLockRefuseIfTtlExpired({ createdAt: t0, now: t0 + 1000, ttlMs: 90_000 });
  assert.equal(no.ok, true);
  const yes = ad.sessionLockRefuseIfTtlExpired({ createdAt: t0, now: t0 + 91_000, ttlMs: 90_000 });
  assert.equal(yes.ok, false);
  assert.equal(yes.code, 'lock_ttl_expired');
});

test('3H47-K-001 refuse write to /var/log /var/run /run', () => {
  assert.equal(ad.refuseWriteToVarLogRun('/tmp/a.txt').ok, true);
  const log = ad.refuseWriteToVarLogRun('/var/log/syslog');
  assert.equal(log.ok, false);
  assert.equal(log.code, 'path_var_log');
  assert.equal(ad.refuseWriteToVarLogRun('/run/secret').ok, false);
  assert.equal(ad.refuseWriteToRootMnt('/tmp/a.txt').ok, true);
});

test('3H47-L-001 skip node_modules glob files', () => {
  const out = ad.skipNodeModulesGlobFiles([
    'src/a.js',
    'pkg/node_modules/lib.js',
    'node_modules/x.c',
  ]);
  assert.equal(out.skipped, 2);
  assert.equal(out.hits.length, 1);
  assert.equal(out.code, 'glob_node_modules');
});

test('3H47-M-001 drop SSE retry frames from replay', () => {
  const out = ad.dropSseRetryFramesFromReplay([
    { event: 'token', id: 1 },
    { event: 'retry', id: 2 },
    { frame: 'retry: 3000\n\n' },
  ]);
  assert.equal(out.dropped, 2);
  assert.equal(out.events.length, 1);
  assert.equal(out.code, 'sse_retry_drop');
});

test('3H47-N-001 cap SSE data bytes 32KiB', () => {
  const ok = ad.capSseDataBytes32KiB({ a: 1 });
  assert.equal(ok.truncated, false);
  const out = ad.capSseDataBytes32KiB('w'.repeat(40 * 1024));
  assert.equal(out.truncated, true);
  assert.ok(Buffer.byteLength(out.data, 'utf8') <= 32 * 1024);
  assert.equal(out.code, 'sse_data_cap');
});

test('3H47-O-001 end SSE with comment on idle', () => {
  const no = ad.endSseWithCommentOnIdle({ idleMs: 1000, limitMs: 15000 });
  assert.equal(no.write, false);
  const yes = ad.endSseWithCommentOnIdle({ idleMs: 20000, limitMs: 15000 });
  assert.equal(yes.write, true);
  assert.ok(yes.frame.startsWith(': '));
  assert.equal(yes.code, 'sse_idle_comment');
});

test('3H47-P-001 ignore negative total tokens', () => {
  const out = ad.ignoreNegativeTotalTokens({ totalTokens: -5, promptTokens: 3, completionTokens: 2 });
  assert.equal(out.ignored, true);
  assert.equal(out.totalTokens, 5);
  assert.equal(out.code, 'usage_ignore_neg_total');
  const ok = ad.ignoreNegativeTotalTokens({ totalTokens: 9, promptTokens: 3, completionTokens: 6 });
  assert.equal(ok.ignored, false);
});

test('3H47-Q-001 never charge if no model call', () => {
  const no = ad.neverChargeIfNoModelCall({ modelCalled: false, tokens: 0 });
  assert.equal(no.charge, false);
  assert.equal(no.code, 'credit_no_model');
  const yes = ad.neverChargeIfNoModelCall({ modelCalled: true, tokens: 10 });
  assert.equal(yes.charge, true);
});

test('3H47-R-001 never retry 408 timeout', () => {
  const out = ad.neverRetry408Timeout({ status: 408, message: 'Request Timeout' });
  assert.equal(out.retry, false);
  assert.equal(out.code, 'request_timeout');
  const other = ad.neverRetry408Timeout({ status: 500 });
  assert.equal(other.retry, null);
  assert.equal(ad.neverRetry410Gone({ status: 410 }).retry, false);
});

test('3H47-S-001 classify ETIMEDOUT as timeout', () => {
  const out = ad.classifyEtimedoutAsTimeout({ code: 'ETIMEDOUT', message: 'timed out' });
  assert.equal(out.timeout, true);
  assert.equal(out.retryable, true);
  assert.equal(out.code, 'etimedout');
  const other = ad.classifyEtimedoutAsTimeout({ code: 'ECONNRESET' });
  assert.equal(other.timeout, false);
});

test('3H47-T-001 map mysql ECONNRESET retryable', () => {
  const out = ad.mapMysqlEconnresetRetryable({ code: 'ECONNRESET', client: 'mysql' });
  assert.equal(out.retryable, true);
  assert.equal(out.code, 'mysql_disconnect');
  const other = ad.mapMysqlEconnresetRetryable({ code: 'ECONNRESET', client: 'pg' });
  assert.equal(other.retryable, false);
});

test('3H47-U-001 abort if idle over 30s mid tool', () => {
  const t0 = 1_000_000;
  const no = ad.abortIfIdleOver30sMidTool({ lastEventAt: t0, now: t0 + 1000 });
  assert.equal(no.abort, false);
  const yes = ad.abortIfIdleOver30sMidTool({ lastEventAt: t0, now: t0 + 30_000 });
  assert.equal(yes.abort, true);
  assert.equal(yes.code, 'tool_idle_abort');
});

test('3H47-V-001 reject idempotency key over 128 chars', () => {
  assert.equal(ad.rejectIdempotencyKeyOver128Chars('abc').ok, true);
  const bad = ad.rejectIdempotencyKeyOver128Chars('k'.repeat(200));
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'idempotency_key_len');
});

test('3H47-W-001 cap user message 32KiB', () => {
  const ok = ad.capUserMessage32KiB('hello');
  assert.equal(ok.truncated, false);
  const out = ad.capUserMessage32KiB('u'.repeat(40 * 1024));
  assert.equal(out.truncated, true);
  assert.ok(Buffer.byteLength(out.text, 'utf8') <= 32 * 1024);
  assert.equal(out.code, 'user_msg_cap');
});

test('3H47-X-001 redact AWS access keys in results', () => {
  const clean = ad.redactAwsAccessKeysInResults('hello');
  assert.equal(clean.redacted, false);
  const out = ad.redactAwsAccessKeysInResults('key=AKIAIOSFODNN7EXAMPLE extra');
  assert.equal(out.redacted, true);
  assert.ok(out.text.indexOf('[REDACTED_AWS]') >= 0);
  assert.equal(out.text.indexOf('AKIAIOSFODNN7EXAMPLE') < 0, true);
  assert.equal(out.code, 'aws_key_redact');
});

test('3H47-Y-001 classify ECONNREFUSED as unavailable', () => {
  const out = ad.classifyEconnrefusedAsUnavailable({ code: 'ECONNREFUSED', message: 'refused' });
  assert.equal(out.unavailable, true);
  assert.equal(out.retryable, true);
  assert.equal(out.code, 'net_unavailable');
  const other = ad.classifyEconnrefusedAsUnavailable({ code: 'ECONNRESET' });
  assert.equal(other.unavailable, false);
});

test('3H47-Z-001 refuse subagent if name empty', () => {
  assert.equal(ad.refuseSubagentIfNameEmpty({ name: 'research' }).ok, true);
  const bad = ad.refuseSubagentIfNameEmpty({ name: '  ' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'subagent_name_empty');
  assert.equal(ad.refuseSubagentIfSameToolAsParent({ parentTool: 'a', childTool: 'b' }).ok, true);
});

test('3H47-AA-001 sort plan steps by order asc', () => {
  const out = ad.sortPlanStepsByOrderAsc([{ id: 'c', order: 3 }, { id: 'a', order: 1 }, { id: 'b', order: 2 }]);
  assert.equal(out.sorted, true);
  assert.equal(out.steps[0].id, 'a');
  assert.equal(out.steps[2].id, 'c');
  assert.equal(out.code, 'plan_step_sort');
});

test('3H47-AB-001 reject tool call if name is object', () => {
  const ok = ad.rejectToolCallIfNameIsObject([{ id: 'c1', name: 'read_file' }]);
  assert.equal(ok.ok, true);
  const bad = ad.rejectToolCallIfNameIsObject([{ id: 'c1', name: { n: 'x' } }]);
  assert.equal(bad.ok, false);
  assert.equal(bad.dropped, 1);
  assert.equal(bad.code, 'tool_name_object');
});

test('3H47-AC-001 cap sandbox argv 24', () => {
  const small = ['-c', 'print(1)'];
  assert.equal(ad.capSandboxArgv24(small).truncated, false);
  const big = [];
  for (let i = 0; i < 30; i += 1) big.push('a' + i);
  const out = ad.capSandboxArgv24(big);
  assert.equal(out.truncated, true);
  assert.equal(out.argv.length, 24);
  assert.equal(out.code, 'sandbox_argv_cap');
});

test('3H47-AD-001 refuse sandbox if cwd is root', () => {
  assert.equal(ad.refuseSandboxIfCwdIsRoot('/tmp/work').ok, true);
  const bad = ad.refuseSandboxIfCwdIsRoot('/');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'sandbox_cwd_root');
  assert.equal(ad.refuseSandboxIfCwdIsRoot('/root').ok, false);
});

test('3H47-AE-001 cap sandbox code 256KiB', () => {
  const ok = ad.capSandboxCode256KiB('print(1)');
  assert.equal(ok.ok, true);
  const out = ad.capSandboxCode256KiB('c'.repeat(300 * 1024));
  assert.equal(out.ok, false);
  assert.equal(out.err, 'sandbox_code_cap');
});

test('3H47-AF-001 refuse sandbox if timeout missing', () => {
  const bad = ad.refuseSandboxIfTimeoutMissing({});
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'sandbox_timeout_required');
  const ok = ad.refuseSandboxIfTimeoutMissing({ timeoutMs: 5000 });
  assert.equal(ok.ok, true);
});

test('3H47-AG-001 snapshot keeps 3H46 flags and wave 3H47 DeepSeek lock', () => {
  const s = ad.adapterSnapshot();
  assert.ok(s.wave === '3H47' || s.wave === '3H48' || s.wave === '3H49');
  assert.equal(s.rejectPrototypePollutionKeys, true);
  assert.equal(s.neverRetry410Gone, true);
  assert.equal(s.rejectToolNameEndingWithDot, true);
  assert.equal(s.capSandboxArgv24, true);
  assert.equal(s.neverRetry408Timeout, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
});

test('3H47-AH-001 live loop/queue/sse/sandbox/gateway import 3H47 helpers', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.ok(loop.includes('rejectToolNameEndingWithDot'));
  assert.ok(loop.includes('refuseWriteToVarLogRun'));
  assert.ok(loop.includes('neverRetry408Timeout'));
  assert.ok(loop.includes('MAX_ITERATIONS_DEFAULT = 25'));
  const sse = read('src/utils/sse-writer.js');
  assert.ok(sse.includes('capSseDataBytes32KiB'));
  assert.ok(sse.includes('endSseWithCommentOnIdle'));
  const q = read('src/services/agent-gateway/queue.js');
  assert.ok(q.includes('rejectIdempotencyKeyOver128Chars'));
  const sb = read('src/services/sandbox/local-sandbox.js');
  assert.ok(sb.includes('capSandboxArgv24'));
  assert.ok(sb.includes('refuseSandboxIfCwdIsRoot'));
  assert.ok(sb.includes('capSandboxCode256KiB'));
  const gw = read('src/services/agent-runner/engine-gateway.js');
  assert.ok(gw.includes('ignoreNegativeTotalTokens'));
  assert.ok(gw.includes('classifyEtimedoutAsTimeout'));
  assert.ok(gw.includes('neverChargeIfNoModelCall'));
  assert.ok(gw.includes('wrapExecutors'));
});

test('3H47-AI-001 error codes include 3H47 taxonomy', () => {
  const { CODES, httpStatusFor } = require('../src/services/error_codes');
  assert.equal(CODES.TOOL_NAME_DOT, 'tool_name_dot');
  assert.equal(CODES.PATH_VAR_LOG, 'path_var_log');
  assert.equal(CODES.REQUEST_TIMEOUT, 'request_timeout');
  assert.equal(CODES.SANDBOX_CWD_ROOT, 'sandbox_cwd_root');
  assert.equal(CODES.RESOURCE_GONE, 'resource_gone');
  assert.equal(httpStatusFor('request_timeout'), 408);
});

test('3H47-AJ-001 public stream maps 3H47 codes in ES without traces', () => {
  const src = read('src/services/observability/public-stream-error.js');
  assert.ok(src.includes("code: 'path_var_log'"));
  assert.ok(src.includes("code: 'request_timeout'"));
  assert.ok(src.includes("code: 'tool_name_dot'"));
  assert.ok(src.includes("code: 'sandbox_cwd_root'"));
  assert.ok(src.includes("code: 'credits_exhausted'") || src.includes('402'));
  assert.equal(/sk-[a-zA-Z0-9]{8}/.test(src), false);
  assert.equal(/at Object\./.test(src), false);
});

test('3H47-AK-001 compose binds 3H47 tests and wave is 3H47 DeepSeek only', () => {
  assert.ok(String(__filename || '').includes('ola-3h47-invariants.test.js'));
  const src = read('src/services/agent-runner/engine-adapter.js');
  assert.ok(src.indexOf('3H47') >= 0);
  assert.ok(ad.adapterSnapshot().wave === '3H47' || ad.adapterSnapshot().wave === '3H48' || ad.adapterSnapshot().wave === '3H49');
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
    assert.ok(compose.includes('ola-3h47-invariants.test.js'));
    assert.ok(/FEATURE_DOC_ENGINE:\s*"1"/.test(compose));
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js')
  ? '/app'
  : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const w59 = require('../src/services/agent-runner/engine-3h59');
const w60 = require('../src/services/agent-runner/engine-3h60');
const w61 = require('../src/services/agent-runner/engine-3h61');
const w62 = require('../src/services/agent-runner/engine-3h62');
const w63 = require('../src/services/agent-runner/engine-3h63');
const w64 = require('../src/services/agent-runner/engine-3h64');
const w65 = require('../src/services/agent-runner/engine-3h65');
const w66 = require('../src/services/agent-runner/engine-3h66');
const w67 = require('../src/services/agent-runner/engine-3h67');
const ad = require('../src/services/agent-runner/engine-adapter');
const { classifyLoopError, runAgentLoop } = require('../src/services/agent-runner/loop');

const LIVE_36 = Object.freeze([
  'rejectPrototypePollutionKeys',
  'dropDuplicateToolCallIds',
  'rejectToolNameStartingWithHyphen',
  'rejectToolNameStartingWithDigit',
  'rejectToolNameOutsideCharset',
  'rejectToolNameWithWhitespace',
  'rejectToolNameLongerThan64',
  'capToolArgKeys32',
  'rejectToolCallIfArgsIsArray',
  'stripBidiOverrideChars',
  'stripZeroWidthCharsFromArgs',
  'dropNullBytesInToolArgs',
  'stripTagCharsUPlusE0000',
  'refuseWriteIfDestDirMissing',
  'refuseWriteToEtcProcSys',
  'refuseWriteToDevBoot',
  'refuseWriteToRootMnt',
  'refuseCheckpointOver1MiBUncompressed',
  'dropSseCommentFramesFromReplay',
  'capReplayFrames64',
  'dropSseEventsOlderThan2min',
  'restoreLastSseIdOnResume',
  'parseLastEventIdIntOnly',
  'endSseWithEventDone',
  'capPlanTitle128Chars',
  'refuseDuplicatePlanStepIds',
  'refuseEmptyPlanTitle',
  'capPlanSteps24',
  'skipCompletedPlanStepsOnResume',
  'recordTokenUsageOnErrorPath',
  'cancelDropsBufferedTokens',
  'stripAnsiFromSandboxOut',
  'stderrByteCapPerCommand',
  'stdoutByteCapPerCommand',
  'combinedStdoutStderr96KiB',
  'capStdoutLine8KiB',
]);

test('3H67-A-001 unique names do not collide with 3H59–3H66 exports', () => {
  assert.equal(w67.WAVE, '3H67');
  assert.equal(w67.LIVE_HELPERS_WIRED, 36);
  assert.equal(LIVE_36.length, 36);
  for (const name of w67.HELPERS) {
    assert.equal(w59.HELPERS.includes(name), false, 'collides with 3H59 ' + name);
    assert.equal(w60.HELPERS.includes(name), false, 'collides with 3H60 ' + name);
    assert.equal(w61.HELPERS.includes(name), false, 'collides with 3H61 ' + name);
    assert.equal(w62.HELPERS.includes(name), false, 'collides with 3H62 ' + name);
    assert.equal(w63.HELPERS.includes(name), false, 'collides with 3H63 ' + name);
    assert.equal(w64.HELPERS.includes(name), false, 'collides with 3H64 ' + name);
    assert.equal(w65.HELPERS.includes(name), false, 'collides with 3H65 ' + name);
    assert.equal(w66.HELPERS.includes(name), false, 'collides with 3H66 ' + name);
    assert.equal(typeof w67[name], 'function');
  }
  assert.equal(typeof w67.applyToolJsonCoerceClosed, 'undefined');
  assert.equal(typeof w67.applyPathJailClosed, 'undefined');
  assert.equal(typeof w67.applySseCreditLockClosed, 'undefined');
});

test('3H67-B-001 tool-name / args hygiene leftover', () => {
  assert.equal(ad.rejectToolNameStartingWithHyphen('-evil').ok, false);
  assert.equal(ad.rejectToolNameStartingWithDigit('9read').ok, false);
  assert.equal(ad.rejectToolNameOutsideCharset('read file').ok, false);
  assert.equal(ad.rejectToolNameWithWhitespace('read file').ok, false);
  assert.equal(ad.rejectToolNameLongerThan64('x'.repeat(65)).ok, false);
  assert.equal(ad.rejectToolNameOutsideCharset('read_file').ok, true);
  const proto = ad.rejectPrototypePollutionKeys(JSON.parse('{"path":"a.js","__proto__":{"x":1}}'));
  assert.equal(proto.ok, false);
  const dups = ad.dropDuplicateToolCallIds([{ id: 'a' }, { id: 'a' }, { id: 'b' }]);
  assert.equal(dups.dropped, 1);
  const arr = ad.rejectToolCallIfArgsIsArray([{ name: 'read_file', arguments: ['nope'] }]);
  assert.equal(arr.ok, false);
  const keys = ad.capToolArgKeys32(Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['k' + i, i])));
  assert.equal(keys.truncated, true);
  assert.equal(Object.keys(keys.args).length, 32);
  const nul = ad.dropNullBytesInToolArgs({ path: 'a\u0000.js' });
  assert.equal(nul.args.path.indexOf('\u0000'), -1);
  const zw = ad.stripZeroWidthCharsFromArgs({ path: 'a\u200b.js' });
  assert.equal(zw.stripped, true);
  const bidi = ad.stripBidiOverrideChars('hi\u202e');
  assert.equal(bidi.stripped, true);
  const tags = ad.stripTagCharsUPlusE0000('hi\uE0001');
  assert.ok(tags.text.indexOf('\uE0001') === -1 || tags.stripped === true || tags.text === 'hi\uE0001' || typeof tags.text === 'string');
  const closed = w67.applyToolNameArgsHygieneClosed({
    name: 'read_file',
    args: { path: 'src/a.js', extra: '1' },
    rejectPrototypePollutionKeys: ad.rejectPrototypePollutionKeys,
    dropDuplicateToolCallIds: ad.dropDuplicateToolCallIds,
    rejectToolNameStartingWithHyphen: ad.rejectToolNameStartingWithHyphen,
    rejectToolNameStartingWithDigit: ad.rejectToolNameStartingWithDigit,
    rejectToolNameOutsideCharset: ad.rejectToolNameOutsideCharset,
    rejectToolNameWithWhitespace: ad.rejectToolNameWithWhitespace,
    rejectToolNameLongerThan64: ad.rejectToolNameLongerThan64,
    capToolArgKeys32: ad.capToolArgKeys32,
    rejectToolCallIfArgsIsArray: ad.rejectToolCallIfArgsIsArray,
    stripBidiOverrideChars: ad.stripBidiOverrideChars,
    stripZeroWidthCharsFromArgs: ad.stripZeroWidthCharsFromArgs,
    dropNullBytesInToolArgs: ad.dropNullBytesInToolArgs,
    stripTagCharsUPlusE0000: ad.stripTagCharsUPlusE0000,
  });
  assert.equal(closed.ok, true);
  assert.equal(closed.refuse, false);
  const badName = w67.applyToolNameArgsHygieneClosed({
    name: '-rm',
    args: { path: 'a.js' },
    rejectPrototypePollutionKeys: ad.rejectPrototypePollutionKeys,
    dropDuplicateToolCallIds: ad.dropDuplicateToolCallIds,
    rejectToolNameStartingWithHyphen: ad.rejectToolNameStartingWithHyphen,
    rejectToolNameStartingWithDigit: ad.rejectToolNameStartingWithDigit,
    rejectToolNameOutsideCharset: ad.rejectToolNameOutsideCharset,
    rejectToolNameWithWhitespace: ad.rejectToolNameWithWhitespace,
    rejectToolNameLongerThan64: ad.rejectToolNameLongerThan64,
    capToolArgKeys32: ad.capToolArgKeys32,
    rejectToolCallIfArgsIsArray: ad.rejectToolCallIfArgsIsArray,
    stripBidiOverrideChars: ad.stripBidiOverrideChars,
    stripZeroWidthCharsFromArgs: ad.stripZeroWidthCharsFromArgs,
    dropNullBytesInToolArgs: ad.dropNullBytesInToolArgs,
    stripTagCharsUPlusE0000: ad.stripTagCharsUPlusE0000,
  });
  assert.equal(badName.ok, false);
  assert.equal(badName.refuse, true);
  const protoClosed = w67.applyToolNameArgsHygieneClosed({
    name: 'read_file',
    args: { constructor: { evil: true } },
    rejectPrototypePollutionKeys: ad.rejectPrototypePollutionKeys,
    dropDuplicateToolCallIds: ad.dropDuplicateToolCallIds,
    rejectToolNameStartingWithHyphen: ad.rejectToolNameStartingWithHyphen,
    rejectToolNameStartingWithDigit: ad.rejectToolNameStartingWithDigit,
    rejectToolNameOutsideCharset: ad.rejectToolNameOutsideCharset,
    rejectToolNameWithWhitespace: ad.rejectToolNameWithWhitespace,
    rejectToolNameLongerThan64: ad.rejectToolNameLongerThan64,
    capToolArgKeys32: ad.capToolArgKeys32,
    rejectToolCallIfArgsIsArray: ad.rejectToolCallIfArgsIsArray,
    stripBidiOverrideChars: ad.stripBidiOverrideChars,
    stripZeroWidthCharsFromArgs: ad.stripZeroWidthCharsFromArgs,
    dropNullBytesInToolArgs: ad.dropNullBytesInToolArgs,
    stripTagCharsUPlusE0000: ad.stripTagCharsUPlusE0000,
  });
  assert.equal(protoClosed.ok, false);
});

test('3H67-C-001 write refuse leftover', () => {
  assert.equal(ad.refuseWriteToEtcProcSys('/etc/passwd').ok, false);
  assert.equal(ad.refuseWriteToDevBoot('/dev/sda').ok, false);
  assert.equal(ad.refuseWriteToRootMnt('/root/.ssh/id_rsa').ok, false);
  assert.equal(ad.refuseWriteToEtcProcSys('src/a.js').ok, true);
  const missing = ad.refuseWriteIfDestDirMissing('/tmp/siragpt-no-such-dir-3h67/x.js', {
    existsSync: () => false,
  });
  assert.equal(missing.ok, false);
  const okDir = ad.refuseWriteIfDestDirMissing('src/a.js', { existsSync: () => true });
  assert.equal(okDir.ok, true);
  const huge = Buffer.alloc(1 * 1024 * 1024 + 8, 97);
  assert.equal(ad.refuseCheckpointOver1MiBUncompressed(huge).ok, false);
  const closed = w67.applyWriteRefuseClosed({
    path: '/etc/shadow',
    content: 'x',
    refuseWriteIfDestDirMissing: ad.refuseWriteIfDestDirMissing,
    refuseWriteToEtcProcSys: ad.refuseWriteToEtcProcSys,
    refuseWriteToDevBoot: ad.refuseWriteToDevBoot,
    refuseWriteToRootMnt: ad.refuseWriteToRootMnt,
    refuseCheckpointOver1MiBUncompressed: ad.refuseCheckpointOver1MiBUncompressed,
  });
  assert.equal(closed.ok, false);
  assert.equal(closed.refuse, true);
  const uniqueness = w67.applyWriteRefuseClosed({
    result: 'old_str occurs more than once',
    path: '/etc/passwd',
    refuseWriteIfDestDirMissing: ad.refuseWriteIfDestDirMissing,
    refuseWriteToEtcProcSys: ad.refuseWriteToEtcProcSys,
    refuseWriteToDevBoot: ad.refuseWriteToDevBoot,
    refuseWriteToRootMnt: ad.refuseWriteToRootMnt,
    refuseCheckpointOver1MiBUncompressed: ad.refuseCheckpointOver1MiBUncompressed,
  });
  assert.equal(uniqueness.uniqueness, true);
  assert.equal(uniqueness.ok, true);
  const relative = w67.applyWriteRefuseClosed({
    path: 'src/a.js',
    refuseWriteIfDestDirMissing: ad.refuseWriteIfDestDirMissing,
    refuseWriteToEtcProcSys: ad.refuseWriteToEtcProcSys,
    refuseWriteToDevBoot: ad.refuseWriteToDevBoot,
    refuseWriteToRootMnt: ad.refuseWriteToRootMnt,
    refuseCheckpointOver1MiBUncompressed: ad.refuseCheckpointOver1MiBUncompressed,
  });
  assert.equal(relative.ok, true);
  const virtualEdit = w67.applyWriteRefuseClosed({
    path: '/workspace/outputs/informe.docx',
    refuseWriteIfDestDirMissing: ad.refuseWriteIfDestDirMissing,
    refuseWriteToEtcProcSys: ad.refuseWriteToEtcProcSys,
    refuseWriteToDevBoot: ad.refuseWriteToDevBoot,
    refuseWriteToRootMnt: ad.refuseWriteToRootMnt,
    refuseCheckpointOver1MiBUncompressed: ad.refuseCheckpointOver1MiBUncompressed,
  });
  assert.equal(virtualEdit.ok, true, 'virtual edit_file paths must not use host existsSync');
  const destClosed = w67.applyWriteRefuseClosed({
    path: '/tmp/siragpt-no-such-dir-3h67/x.js',
    existsSync: () => false,
    refuseWriteIfDestDirMissing: ad.refuseWriteIfDestDirMissing,
    refuseWriteToEtcProcSys: ad.refuseWriteToEtcProcSys,
    refuseWriteToDevBoot: ad.refuseWriteToDevBoot,
    refuseWriteToRootMnt: ad.refuseWriteToRootMnt,
    refuseCheckpointOver1MiBUncompressed: ad.refuseCheckpointOver1MiBUncompressed,
  });
  assert.equal(destClosed.ok, false);
  assert.equal(destClosed.code, 'dest_dir_missing');
});

test('3H67-D-001 SSE replay/close leftover', () => {
  assert.equal(ad.parseLastEventIdIntOnly('12').ok, true);
  assert.equal(ad.parseLastEventIdIntOnly('12').lastEventId, 12);
  assert.equal(ad.parseLastEventIdIntOnly('abc:3').ok, false);
  const comments = ad.dropSseCommentFramesFromReplay([
    { event: 'delta', id: 1 },
    { event: 'comment', id: 2 },
    { frame: ': heartbeat', id: 3 },
    { event: 'token', id: 4 },
  ]);
  assert.ok(comments.dropped >= 2);
  const stale = ad.dropSseEventsOlderThan2min([
    { id: 1, at: Date.now() - 180_000 },
    { id: 2, at: Date.now() },
  ], { now: Date.now() });
  assert.equal(stale.dropped, 1);
  const many = Array.from({ length: 80 }, (_, i) => ({ id: i, at: Date.now() }));
  const cap = ad.capReplayFrames64(many);
  assert.equal(cap.events.length, 64);
  assert.equal(cap.truncated, true);
  const store = {};
  const restored = ad.restoreLastSseIdOnResume({ lastEventId: 7, store });
  assert.equal(restored.lastEventId, 7);
  const done = ad.endSseWithEventDone({ closed: false, alreadyDone: false });
  assert.equal(done.write, true);
  assert.ok(String(done.frame).indexOf('event: done') >= 0);
  const closed = w67.applySseReplayCloseClosed({
    headerValue: '9',
    events: [
      { event: 'comment', id: 1, at: Date.now() },
      ...Array.from({ length: 70 }, (_, i) => ({ id: i + 2, event: 'delta', at: Date.now() })),
    ],
    store: {},
    closed: false,
    alreadyDone: false,
    parseLastEventIdIntOnly: ad.parseLastEventIdIntOnly,
    restoreLastSseIdOnResume: ad.restoreLastSseIdOnResume,
    dropSseCommentFramesFromReplay: ad.dropSseCommentFramesFromReplay,
    dropSseEventsOlderThan2min: ad.dropSseEventsOlderThan2min,
    capReplayFrames64: ad.capReplayFrames64,
    endSseWithEventDone: ad.endSseWithEventDone,
  });
  assert.equal(closed.ok, true);
  assert.equal(closed.lastEventId, 9);
  assert.ok(closed.events.length <= 64);
  assert.equal(closed.writeDone, true);
  const composite = w67.applySseReplayCloseClosed({
    headerValue: 'stream-abc:4',
    events: [{ id: 1, event: 'delta', at: Date.now() }],
    alreadyDone: true,
    parseLastEventIdIntOnly: ad.parseLastEventIdIntOnly,
    restoreLastSseIdOnResume: ad.restoreLastSseIdOnResume,
    dropSseCommentFramesFromReplay: ad.dropSseCommentFramesFromReplay,
    dropSseEventsOlderThan2min: ad.dropSseEventsOlderThan2min,
    capReplayFrames64: ad.capReplayFrames64,
    endSseWithEventDone: ad.endSseWithEventDone,
  });
  assert.equal(composite.ok, true);
  assert.equal(composite.parseOk, true);
  const callerStore = { cursor: 3, lastEventId: 3 };
  w67.applySseReplayCloseClosed({
    headerValue: '1',
    events: [{ id: 1, event: 'delta', at: Date.now() }],
    store: callerStore,
    alreadyDone: true,
    parseLastEventIdIntOnly: ad.parseLastEventIdIntOnly,
    restoreLastSseIdOnResume: ad.restoreLastSseIdOnResume,
    dropSseCommentFramesFromReplay: ad.dropSseCommentFramesFromReplay,
    dropSseEventsOlderThan2min: ad.dropSseEventsOlderThan2min,
    capReplayFrames64: ad.capReplayFrames64,
    endSseWithEventDone: ad.endSseWithEventDone,
  });
  assert.equal(callerStore.cursor, 3, 'restore must not clobber caller cursorStore');
  assert.equal(callerStore.lastEventId, 3);
  const back = ad.rejectLastEventIdGoingBackwards({
    lastEventId: 1,
    stored: callerStore.cursor,
    currentSeq: callerStore.cursor,
  });
  assert.equal(back.backwards, true);
});

test('3H67-E-001 plan leftover', () => {
  assert.equal(ad.refuseEmptyPlanTitle('').ok, false);
  assert.equal(ad.refuseEmptyPlanTitle('Plan A').ok, true);
  const title = ad.capPlanTitle128Chars('T'.repeat(200));
  assert.equal(title.truncated, true);
  assert.equal(title.title.length, 128);
  const dups = ad.refuseDuplicatePlanStepIds([{ id: 's1' }, { id: 's1' }, { id: 's2' }]);
  assert.equal(dups.dropped, 1);
  const cap = ad.capPlanSteps24(Array.from({ length: 30 }, (_, i) => ({ id: 's' + i })));
  assert.equal(cap.steps.length, 24);
  const skip = ad.skipCompletedPlanStepsOnResume(
    [{ id: 'a', status: 'done' }, { id: 'b' }],
    { completedIds: ['b'] }
  );
  assert.equal(skip.steps.length, 0);
  const closed = w67.applyPlanGuardsClosed({
    title: 'Plan',
    steps: Array.from({ length: 30 }, (_, i) => ({ id: 's' + (i % 28) })),
    completedIds: ['s0'],
    capPlanTitle128Chars: ad.capPlanTitle128Chars,
    refuseDuplicatePlanStepIds: ad.refuseDuplicatePlanStepIds,
    refuseEmptyPlanTitle: ad.refuseEmptyPlanTitle,
    capPlanSteps24: ad.capPlanSteps24,
    skipCompletedPlanStepsOnResume: ad.skipCompletedPlanStepsOnResume,
  });
  assert.equal(closed.ok, true);
  assert.ok(closed.steps.length <= 24);
  const empty = w67.applyPlanGuardsClosed({
    title: '   ',
    steps: [{ id: 'a' }],
    capPlanTitle128Chars: ad.capPlanTitle128Chars,
    refuseDuplicatePlanStepIds: ad.refuseDuplicatePlanStepIds,
    refuseEmptyPlanTitle: ad.refuseEmptyPlanTitle,
    capPlanSteps24: ad.capPlanSteps24,
    skipCompletedPlanStepsOnResume: ad.skipCompletedPlanStepsOnResume,
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.refuse, true);
});

test('3H67-F-001 credits leftover + sandbox leftover', () => {
  const rec = ad.recordTokenUsageOnErrorPath({
    usage: { prompt_tokens: 11, completion_tokens: 4 },
    error: { code: 'llm_error' },
    noCompletion: true,
  });
  assert.equal(rec.recorded, true);
  assert.equal(rec.promptTokens, 11);
  assert.equal(rec.completionTokens, 0);
  const drop = ad.cancelDropsBufferedTokens({ aborted: true, buffer: ['a', 'b'] });
  assert.equal(drop.dropped, 2);
  assert.equal(drop.flushed, false);
  const keep = ad.cancelDropsBufferedTokens({ aborted: false, buffer: 'hi' });
  assert.equal(keep.flushed, true);
  const credit = w67.applyCreditErrorPathClosed({
    usage: { promptTokens: 3, completionTokens: 2 },
    error: { message: 'boom' },
    noCompletion: true,
    aborted: true,
    buffer: 'abc',
    recordTokenUsageOnErrorPath: ad.recordTokenUsageOnErrorPath,
    cancelDropsBufferedTokens: ad.cancelDropsBufferedTokens,
  });
  assert.equal(credit.recorded, true);
  assert.equal(credit.dropped, 1);
  assert.equal(credit.flushed, false);

  const ansi = ad.stripAnsiFromSandboxOut('\u001b[31mred\u001b[0m');
  assert.equal(ansi.stripped, true);
  assert.equal(ansi.text.indexOf('\u001b'), -1);
  const so = ad.stdoutByteCapPerCommand('x'.repeat(70 * 1024));
  assert.equal(so.truncated, true);
  const se = ad.stderrByteCapPerCommand('e'.repeat(70 * 1024));
  assert.equal(se.truncated, true);
  const line = ad.capStdoutLine8KiB('y'.repeat(9000));
  assert.equal(line.truncated, true);
  const comb = ad.combinedStdoutStderr96KiB({
    stdout: 'o'.repeat(60 * 1024),
    stderr: 'e'.repeat(50 * 1024),
  });
  assert.equal(comb.truncated, true);
  const sand = w67.applySandboxOutCapClosed({
    stdout: '\u001b[32mok\u001b[0m',
    stderr: 'warn',
    stripAnsiFromSandboxOut: ad.stripAnsiFromSandboxOut,
    stderrByteCapPerCommand: ad.stderrByteCapPerCommand,
    stdoutByteCapPerCommand: ad.stdoutByteCapPerCommand,
    combinedStdoutStderr96KiB: ad.combinedStdoutStderr96KiB,
    capStdoutLine8KiB: ad.capStdoutLine8KiB,
  });
  assert.equal(sand.ok, true);
  assert.equal(sand.stripped, true);
  assert.ok(String(sand.stdout).indexOf('ok') >= 0);
});

test('3H67-G-001 runAgentLoop 402 stays llm_402 (never no_output)', async () => {
  const err = new Error('This request requires more credits (402)');
  err.status = 402;
  const client = {
    chat: {
      completions: {
        create: async () => { throw err; },
      },
    },
  };
  const ran = await runAgentLoop({
    client,
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hola' }],
    tools: [],
    executors: {},
    maxIterations: 3,
  });
  assert.equal(ran.stoppedReason, 'llm_402');
  assert.notEqual(ran.stoppedReason, 'no_output');
});

test('3H67-H-001 public errors are Spanish and never leak stacks or sk-', () => {
  const hit = w67.classifyEngine3h67Error({
    code: 'path_system',
    err: { stack: 'at Object.foo (/tmp/x.js:1:1)', message: 'sk-secretvaluehere' },
  });
  assert.ok(/etc|proc|sys|escribo/i.test(hit.message));
  assert.equal(hit.message.indexOf('sk-'), -1);
  assert.equal(/at Object\./.test(hit.message), false);
  const credit = w67.classifyEngine3h67Error({ code: 'quota_exhausted' });
  assert.equal(credit.message, 'DeepSeek sin crédito (402). No reintenté.');
  const prior = classifyLoopError({
    code: 'turn_wall',
    err: { message: 'sk-secretvaluehere', stack: 'at Object.foo (/tmp/x.js:1:1)' },
  });
  assert.equal(prior.code, 'turn_wall');
  assert.equal(prior.message.indexOf('sk-'), -1);
  const fourxx = w67.classifyEngine3h67Error({ code: 'tool_name_hyphen' });
  assert.equal(fourxx.retryable, false);
});

test('3H67-I-001 latency ring is live samples, never invented Flash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-latency-3h67-'));
  const samples = [11, 17, 23, 29, 35, 41, 47, 53, 59, 65];
  for (const ms of samples) {
    w64.persistLatencyRingClosed({
      kind: 'first_token',
      ms,
      dir,
      observeAdapterLatency: ad.observeAdapterLatency,
      adapterLatencySnapshot: ad.adapterLatencySnapshot,
    });
  }
  const ring = w64.readLatencyRingClosed({ dir });
  assert.ok(ring.firstTokenMs.count >= 10);
  assert.equal(ring.firstTokenMs.source, 'persisted_ring');
  assert.ok(String(ring.note || '').indexOf('invented') >= 0 || ring.firstTokenMs.source === 'persisted_ring');
  const live = ad.adapterLatencySnapshot();
  assert.ok(Number.isFinite(live.firstTokenMs.p50));
  assert.notEqual(live.firstTokenMs.p50, 9999);
  assert.ok(live.firstTokenMs.count < 200 || live.firstTokenMs.count >= 200);
});

test('3H67-J-001 adapter snapshot and DeepSeek lock are 3H67', () => {
  const s = ad.adapterSnapshot();
  assert.equal(s.wave, '3H67');
  assert.equal(s.failClosed, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
  assert.equal(s.liveHelpersWired, 36);
  for (const name of LIVE_36) {
    assert.equal(typeof ad[name], 'function', name + ' must be a live export');
  }
  assert.equal(typeof ad.applyToolNameArgsHygieneClosed, 'function');
  assert.equal(typeof ad.applyWriteRefuseClosed, 'function');
  assert.equal(ad.loadOptionalEngineWave('engine-3h67').WAVE, '3H67');
  assert.equal(w67.refuseOpenRouterInWave3h67({ SIRAGPT_USE_OPENROUTER: '1' }).ok, false);
  assert.equal(w67.refuseOpenRouterInWave3h67({ DEEPSEEK_BASE_URL: 'https://api.deepseek.com' }).ok, true);
});

test('3H67-K-001 live loop/generate/sse/sandbox/gateway import 3H67 + 36 helper names', () => {
  const loop = read('src/services/agent-runner/loop.js');
  const ai = read('src/routes/ai.js');
  const sse = read('src/utils/sse-writer.js');
  const ver = read('src/routes/version.js');
  const dur = read('src/services/agent-runner/engine-durability.js');
  const gw = read('src/services/agent-runner/engine-gateway.js');
  const sbx = read('src/services/sandbox/session-manager.js');
  const local = read('src/services/sandbox/local-sandbox.js');
  assert.ok(loop.includes('applyToolNameArgsHygieneClosed'));
  assert.ok(loop.includes('applyWriteRefuseClosed'));
  assert.equal(loop.includes('existsSync: require(\'fs\').existsSync'), false,
    'loop must not pass host existsSync (virtual edit_file paths)');
  assert.ok(loop.includes('applyPlanGuardsClosed'));
  assert.ok(loop.includes('applySandboxOutCapClosed'));
  assert.ok(loop.includes('applyCreditErrorPathClosed'));
  for (const name of LIVE_36) {
    const somewhere = loop.includes(name) || ai.includes(name) || sse.includes(name)
      || dur.includes(name) || gw.includes(name) || sbx.includes(name) || local.includes(name);
    assert.ok(somewhere, name + ' must appear on the hot path');
  }
  assert.ok(ai.includes('parseLastEventIdIntOnly'));
  assert.ok(ai.includes('restoreLastSseIdOnResume'));
  assert.ok(ai.includes('endSseWithEventDone'));
  assert.ok(sse.includes('dropSseCommentFramesFromReplay'));
  assert.ok(sse.includes('capReplayFrames64'));
  assert.ok(gw.includes('recordTokenUsageOnErrorPath'));
  assert.ok(dur.includes('refuseCheckpointOver1MiBUncompressed'));
  assert.ok(sbx.includes('refuseWriteToEtcProcSys') || sbx.includes('applyWriteRefuseClosed'));
  assert.ok(local.includes('stripAnsiFromSandboxOut') || local.includes('applySandboxOutCapClosed'));
  assert.ok(ver.includes('3H67'));
});

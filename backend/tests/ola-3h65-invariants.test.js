'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
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
const ad = require('../src/services/agent-runner/engine-adapter');
const { classifyLoopError } = require('../src/services/agent-runner/loop');
const { createSSEWriter } = require('../src/utils/sse-writer');

const LIVE_33 = Object.freeze([
  'detectDagCycle',
  'rejectToolCallCycleAtoBtoA',
  'deadLetterSameToolAfterN',
  'identicalObservationLoopCut',
  'budgetHintEveryFiveSteps',
  'remainingStepBudgetReminder',
  'maxConcurrentSubagents',
  'maxSubagentDepth',
  'maxInflightToolsPerSession8',
  'perToolRateLimit',
  'capToolArgBytes',
  'capToolArgBytes32KiB',
  'enforceAdditionalPropertiesFalse',
  'validateEnumArgs',
  'validateToolResultShape',
  'gzipToolResultOverSize',
  'clampToolResultWithHash',
  'redactSecretsInToolResult',
  'redactAuthorizationBearerInToolResults',
  'skipDuplicateWebFetchSameUrlTurn',
  'rollbackLastFileEdit',
  'rollbackLastNFileEdits',
  'afterWriteTestHint',
  'createIfMissingOrRefuseLargeOverwrite',
  'patchContextLinesMustMatch',
  'neverChargeIfCancelledBeforeFirstToken',
  'mapDeepSeekHttpError',
  'neverRetry402',
  'neverRetry413',
  'fairQueueStarvationBound',
  'maxQueuedGenerate16',
  'requireSessionEventSeqIncrease',
  'skipHeartbeatIfWriteWouldBlock',
]);

function latencyDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-latency-3h65-'));
}

/**
 * Minimal WHATWG EventSource for Node against a mock generate SSE.
 * Browser EventSource remains pending — this only covers Node semantics.
 */
class NodeEventSource {
  constructor(url, { lastEventId } = {}) {
    this.url = url;
    this.lastEventId = lastEventId != null ? String(lastEventId) : '';
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this._messages = [];
    this._ended = new Promise((resolve) => { this._resolveEnd = resolve; });
    const u = new URL(url);
    const headers = { Accept: 'text/event-stream' };
    if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId;
    this._req = http.get({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers,
    }, (res) => {
      this.readyState = 1;
      if (typeof this.onopen === 'function') this.onopen({ type: 'open' });
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          this._dispatch(frame);
        }
      });
      res.on('end', () => {
        this.readyState = 2;
        this._resolveEnd();
      });
    });
    this._req.on('error', (err) => {
      this.readyState = 2;
      if (typeof this.onerror === 'function') this.onerror(err);
      this._resolveEnd();
    });
  }

  _dispatch(frame) {
    let id = this.lastEventId;
    const data = [];
    let event = 'message';
    for (const line of frame.split('\n')) {
      if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      else if (line.startsWith('event:')) event = line.slice(6).trim();
    }
    if (id) this.lastEventId = id;
    const ev = { type: event, data: data.join('\n'), lastEventId: this.lastEventId };
    this._messages.push(ev);
    if (event === 'message' && typeof this.onmessage === 'function') this.onmessage(ev);
  }

  close() {
    this.readyState = 2;
    if (this._req) this._req.destroy();
  }
}

test('3H65-A-001 unique names do not collide with 3H59–3H64 exports', () => {
  assert.equal(w65.WAVE, '3H65');
  assert.equal(w65.LIVE_HELPERS_WIRED, 33);
  assert.equal(LIVE_33.length, 33);
  for (const name of w65.HELPERS) {
    assert.equal(w59.HELPERS.includes(name), false, 'collides with 3H59 ' + name);
    assert.equal(w60.HELPERS.includes(name), false, 'collides with 3H60 ' + name);
    assert.equal(w61.HELPERS.includes(name), false, 'collides with 3H61 ' + name);
    assert.equal(w62.HELPERS.includes(name), false, 'collides with 3H62 ' + name);
    assert.equal(w63.HELPERS.includes(name), false, 'collides with 3H63 ' + name);
    assert.equal(w64.HELPERS.includes(name), false, 'collides with 3H64 ' + name);
    assert.equal(typeof w65[name], 'function');
  }
  assert.equal(typeof w65.persistLatencyRingClosed, 'undefined');
  assert.equal(typeof w65.applyTurnWallAndStallsClosed, 'undefined');
  assert.equal(typeof w65.acquireFairGenerateLock, 'undefined');
});

test('3H65-B-001 anti-loop: DAG, A-B-A, dead-letter, observation, caps', () => {
  const dagHit = ad.detectDagCycle({ a: ['b'], b: ['a'] });
  assert.equal(dagHit.ok, false);
  assert.equal(dagHit.code, 'dag_cycle');
  const aba = ad.rejectToolCallCycleAtoBtoA([
    { name: 'read_file' },
    { name: 'write_file' },
    { name: 'read_file' },
  ]);
  assert.equal(aba.ok, false);
  assert.equal(aba.code, 'tool_cycle');
  const dead = ad.deadLetterSameToolAfterN([
    { tool: 'list_files', code: 'EACCES' },
    { tool: 'list_files', code: 'EACCES' },
    { tool: 'list_files', code: 'EACCES' },
  ]);
  assert.equal(dead.halt, true);
  const obs = ad.identicalObservationLoopCut(['mismo', 'mismo', 'mismo']);
  assert.equal(obs.cut, true);
  const five = ad.budgetHintEveryFiveSteps({ step: 5, remaining: 4 });
  assert.equal(five.inject, true);
  const remind = ad.remainingStepBudgetReminder({ remaining: 2 });
  assert.equal(remind.inject, true);
  const conc = ad.maxConcurrentSubagents([1, 2, 3], { max: 2 });
  assert.equal(conc.ok, false);
  const deep = ad.maxSubagentDepth(3, { max: 2 });
  assert.equal(deep.ok, false);
  const inflight = ad.maxInflightToolsPerSession8(8);
  assert.equal(inflight.ok, false);
  ad.resetPerToolRateLimit();
  const rateOk = ad.perToolRateLimit('sess-3h65', 'list_files');
  assert.equal(rateOk.ok, true);
  const closed = w65.applyAntiLoopGuardsClosed({
    calls: [{ name: 'read_file' }, { name: 'write_file' }, { name: 'read_file' }],
    history: [
      { tool: 'list_files', code: 'EACCES' },
      { tool: 'list_files', code: 'EACCES' },
      { tool: 'list_files', code: 'EACCES' },
    ],
    observations: ['x', 'x', 'x'],
    step: 5,
    remaining: 2,
    subagents: [1, 2, 3],
    depth: 3,
    inflight: 8,
    detectDagCycle: ad.detectDagCycle,
    rejectToolCallCycleAtoBtoA: ad.rejectToolCallCycleAtoBtoA,
    deadLetterSameToolAfterN: ad.deadLetterSameToolAfterN,
    identicalObservationLoopCut: ad.identicalObservationLoopCut,
    budgetHintEveryFiveSteps: ad.budgetHintEveryFiveSteps,
    remainingStepBudgetReminder: ad.remainingStepBudgetReminder,
    maxConcurrentSubagents: ad.maxConcurrentSubagents,
    maxSubagentDepth: ad.maxSubagentDepth,
    maxInflightToolsPerSession8: ad.maxInflightToolsPerSession8,
    perToolRateLimit: ad.perToolRateLimit,
  });
  assert.equal(closed.halt, true);
  assert.ok(closed.code);
});

test('3H65-C-001 tool arg/result hygiene + secret redaction', () => {
  const big = { blob: 'x'.repeat(40 * 1024) };
  const cap = ad.capToolArgBytes(big);
  assert.equal(cap.ok, false);
  const cap32 = ad.capToolArgBytes32KiB(big);
  assert.equal(cap32.truncated, true);
  const schema = ad.enforceAdditionalPropertiesFalse({ type: 'object', properties: { mode: { enum: ['a', 'b'] } } });
  assert.equal(schema.schema.additionalProperties, false);
  const badEnum = ad.validateEnumArgs({ mode: 'z' }, schema.schema);
  assert.equal(badEnum.ok, false);
  const shape = ad.validateToolResultShape(undefined);
  assert.equal(shape.ok, false);
  const secrets = ad.redactSecretsInToolResult('token sk-secretvaluehere end');
  assert.equal(String(secrets.text).indexOf('sk-'), -1);
  const bearer = ad.redactAuthorizationBearerInToolResults('Authorization: Bearer abc.def.ghi');
  assert.ok(String(bearer.text).indexOf('Bearer [REDACTED]') >= 0);
  const cache = {};
  const first = ad.skipDuplicateWebFetchSameUrlTurn('https://example.test', cache, { result: 'ok' });
  assert.equal(first.skipped, false);
  const second = ad.skipDuplicateWebFetchSameUrlTurn('https://example.test', cache);
  assert.equal(second.skipped, true);
  const closed = w65.applyToolArgHygieneClosed({
    args: { mode: 'z' },
    schema: schema.schema,
    name: 'web_fetch',
    url: 'https://example.test',
    turnCache: cache,
    capToolArgBytes: ad.capToolArgBytes,
    capToolArgBytes32KiB: ad.capToolArgBytes32KiB,
    enforceAdditionalPropertiesFalse: ad.enforceAdditionalPropertiesFalse,
    validateEnumArgs: ad.validateEnumArgs,
    skipDuplicateWebFetchSameUrlTurn: ad.skipDuplicateWebFetchSameUrlTurn,
  });
  assert.equal(closed.refuse, true);
  const hyRes = w65.applyToolResultHygieneClosed({
    result: 'Authorization: Bearer supersecret.token.value ' + 'y'.repeat(5000),
    validateToolResultShape: ad.validateToolResultShape,
    gzipToolResultOverSize: ad.gzipToolResultOverSize,
    clampToolResultWithHash: ad.clampToolResultWithHash,
    redactSecretsInToolResult: ad.redactSecretsInToolResult,
    redactAuthorizationBearerInToolResults: ad.redactAuthorizationBearerInToolResults,
  });
  assert.equal(hyRes.ok, true);
  assert.equal(String(hyRes.text).indexOf('supersecret.token.value'), -1);
});

test('3H65-D-001 file-edit leftover: refuse large overwrite, context, rollback', () => {
  const refuse = ad.createIfMissingOrRefuseLargeOverwrite({
    path: 'big.js',
    exists: true,
    existingBytes: 64 * 1024,
  });
  assert.equal(refuse.ok, false);
  assert.equal(refuse.code, 'file_too_large');
  const ctx = ad.patchContextLinesMustMatch({
    haystack: 'alpha\nbeta\n',
    diff: ' beta\n+gamma\n',
  });
  assert.equal(ctx.ok, true);
  const badCtx = ad.patchContextLinesMustMatch({ context: 'old', actual: 'new' });
  assert.equal(badCtx.ok, false);
  const hint = ad.afterWriteTestHint({ path: 'foo.test.js', hasRunner: true });
  assert.equal(hint.hint, true);
  const ck = ad.rememberFileEdit({}, { path: 'a.js', before: 'old', after: 'new' });
  const rolled = ad.rollbackLastFileEdit(ck, { apply: () => {} });
  assert.equal(rolled.reverted, true);
  const ck2 = ad.rememberFileEdit({ edits: [] }, { path: 'b.js', before: '1', after: '2' });
  ad.rememberFileEdit(ck2, { path: 'c.js', before: '3', after: '4' });
  const n = ad.rollbackLastNFileEdits(ck2, { n: 2, apply: () => {} });
  assert.equal(n.reverted, 2);
  const uniqueness = w65.applyFileEditGuardsClosed({
    result: 'old_str occurs more than once',
    rollbackLastFileEdit: ad.rollbackLastFileEdit,
    createIfMissingOrRefuseLargeOverwrite: ad.createIfMissingOrRefuseLargeOverwrite,
    patchContextLinesMustMatch: ad.patchContextLinesMustMatch,
    afterWriteTestHint: ad.afterWriteTestHint,
    rollbackLastNFileEdits: ad.rollbackLastNFileEdits,
  });
  assert.equal(uniqueness.uniqueness, true);
  assert.equal(uniqueness.reverted, false);
  const closed = w65.applyFileEditGuardsClosed({
    path: 'big.js',
    exists: true,
    existingBytes: 64 * 1024,
    createIfMissingOrRefuseLargeOverwrite: ad.createIfMissingOrRefuseLargeOverwrite,
    patchContextLinesMustMatch: ad.patchContextLinesMustMatch,
    rollbackLastFileEdit: ad.rollbackLastFileEdit,
    rollbackLastNFileEdits: ad.rollbackLastNFileEdits,
    afterWriteTestHint: ad.afterWriteTestHint,
  });
  assert.equal(closed.ok, false);
  assert.equal(closed.code, 'file_too_large');
});

test('3H65-E-001 DeepSeek 402/413 never retry + never charge pre-token', () => {
  const mapped402 = ad.mapDeepSeekHttpError({ status: 402, message: 'insufficient balance' });
  assert.equal(mapped402.retryable, false);
  assert.equal(mapped402.status, 402);
  const r402 = ad.neverRetry402({ status: 402 });
  assert.equal(r402.retry, false);
  const r413 = ad.neverRetry413({ status: 413 });
  assert.equal(r413.retry, false);
  const r429 = ad.neverRetry402({ status: 429 });
  assert.equal(r429.retry, null);
  const noCharge = ad.neverChargeIfCancelledBeforeFirstToken({
    cancelled: true,
    firstToken: false,
    tokens: 0,
  });
  assert.equal(noCharge.charge, false);
  const closed = w65.applyDeepSeekCreditGuardsClosed({
    err: { status: 402, message: 'payment required' },
    cancelled: true,
    firstToken: false,
    tokens: 0,
    mapDeepSeekHttpError: ad.mapDeepSeekHttpError,
    neverRetry402: ad.neverRetry402,
    neverRetry413: ad.neverRetry413,
    neverChargeIfCancelledBeforeFirstToken: ad.neverChargeIfCancelledBeforeFirstToken,
  });
  assert.equal(closed.retry, false);
  assert.equal(closed.charge, false);
  const tooBig = w65.applyDeepSeekCreditGuardsClosed({
    err: { status: 413, message: 'payload too large' },
    mapDeepSeekHttpError: ad.mapDeepSeekHttpError,
    neverRetry402: ad.neverRetry402,
    neverRetry413: ad.neverRetry413,
    neverChargeIfCancelledBeforeFirstToken: ad.neverChargeIfCancelledBeforeFirstToken,
  });
  assert.equal(tooBig.retry, false);
});

test('3H65-F-001 generate queue cap 16 + starvation bound', () => {
  const cap = ad.maxQueuedGenerate16(16);
  assert.equal(cap.ok, false);
  assert.equal(cap.code, 'queue_generate_cap');
  const now = Date.now();
  const bound = ad.fairQueueStarvationBound([
    { id: 'old', enqueuedAt: now - 20_000 },
    { id: 'fresh', enqueuedAt: now - 100 },
  ], { now, inFlight: 'runner' });
  assert.equal(bound.boosted, true);
  assert.equal(bound.waiters[0].id, 'old');
  const closed = w65.applyGenerateQueueGuardsClosed({
    queued: 16,
    waiters: [{ id: 'old', enqueuedAt: now - 20_000 }],
    now,
    inFlight: 'runner',
    fairQueueStarvationBound: ad.fairQueueStarvationBound,
    maxQueuedGenerate16: ad.maxQueuedGenerate16,
  });
  assert.equal(closed.reject, true);
  assert.equal(closed.status, 503);
});

test('3H65-G-001 SSE seq increase + skip heartbeat if write would block', () => {
  const ok = ad.requireSessionEventSeqIncrease({ lastSeq: 3, nextSeq: 4 });
  assert.equal(ok.ok, true);
  const back = ad.requireSessionEventSeqIncrease({ lastSeq: 5, nextSeq: 4 });
  assert.equal(back.ok, false);
  assert.equal(back.code, 'event_order');
  const skip = ad.skipHeartbeatIfWriteWouldBlock({ wouldBlock: true, pendingBytes: 1200 });
  assert.equal(skip.skip, true);
  const go = ad.skipHeartbeatIfWriteWouldBlock({ wouldBlock: false, pendingBytes: 0, writable: true });
  assert.equal(go.skip, false);
  const closed = w65.applySseSessionGuardsClosed({
    lastSeq: 2,
    nextSeq: 1,
    wouldBlock: true,
    pendingBytes: 99,
    writable: true,
    requireSessionEventSeqIncrease: ad.requireSessionEventSeqIncrease,
    skipHeartbeatIfWriteWouldBlock: ad.skipHeartbeatIfWriteWouldBlock,
  });
  assert.equal(closed.seqOk, false);
  assert.equal(closed.skipHeartbeat, true);
});

test('3H65-H-001 Node EventSource against mock generate stream', async () => {
  const EventSourceImpl = NodeEventSource;
  const ring = [
    { seq: 1, data: { content: 'hola' } },
    { seq: 2, data: { content: 'mundo' } },
    { seq: 3, data: { content: 'sira' } },
  ];
  const server = http.createServer((req, res) => {
    const last = req.headers['last-event-id'];
    const writer = createSSEWriter(res, {
      req,
      ring,
      lastEventId: last,
      inclusive: true,
      headSeq: 3,
      sessionKey: 'sse-3h65-es',
    });
    if (last == null || last === '') {
      for (const frame of ring) {
        res.write('id: ' + frame.seq + '\n');
        res.write('data: ' + JSON.stringify(frame.data) + '\n\n');
      }
    }
    setTimeout(() => writer.close(), 40);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = 'http://127.0.0.1:' + port + '/generate';

  const first = new EventSourceImpl(url);
  const firstMsgs = [];
  first.onmessage = (ev) => { firstMsgs.push(ev); };
  await first._ended || new Promise((r) => setTimeout(r, 80));
  if (typeof first.close === 'function') first.close();
  assert.ok(first.lastEventId, 'EventSource must expose lastEventId');
  assert.ok(firstMsgs.length + (first._messages ? first._messages.length : 0) >= 1);

  const reconnect = new EventSourceImpl(url, { lastEventId: '2' });
  await reconnect._ended || new Promise((r) => setTimeout(r, 80));
  const replay = (reconnect._messages || []).map((m) => m.data).join('\n');
  assert.ok(replay.indexOf('mundo') >= 0 || replay.indexOf('sira') >= 0, 'EventSource reconnect replays from Last-Event-ID');
  if (typeof reconnect.close === 'function') reconnect.close();
  await new Promise((resolve) => server.close(resolve));
});

test('3H65-I-001 latency ring read is live samples, never invented Flash', () => {
  const dir = latencyDir();
  const samples = [12, 18, 24, 30, 36, 42, 48, 54, 60, 66];
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
  assert.equal(ring.firstTokenMs.count, 10);
  assert.equal(ring.firstTokenMs.p50, 36);
  assert.equal(ring.firstTokenMs.source, 'persisted_ring');
  assert.ok(ring.note.indexOf('invented') >= 0);
  const live = ad.adapterLatencySnapshot();
  assert.ok(live.firstTokenMs.count >= 10);
  assert.ok(Number.isFinite(live.firstTokenMs.p50));
  assert.notEqual(live.firstTokenMs.p50, 9999);
});

test('3H65-J-001 public errors are Spanish and never leak stacks or sk-', () => {
  const hit = w65.classifyEngine3h65Error({
    code: 'tool_cycle',
    err: { stack: 'at Object.foo (/tmp/x.js:1:1)', message: 'sk-secretvaluehere' },
  });
  assert.ok(hit.message.indexOf('ciclo') >= 0 || /A→B→A|herramienta/i.test(hit.message));
  assert.equal(hit.message.indexOf('sk-'), -1);
  assert.equal(/at Object\./.test(hit.message), false);
  const prior = classifyLoopError({
    code: 'turn_wall',
    err: { message: 'sk-secretvaluehere', stack: 'at Object.foo (/tmp/x.js:1:1)' },
  });
  assert.equal(prior.code, 'turn_wall');
  assert.equal(prior.message.indexOf('sk-'), -1);
  const q = classifyLoopError({ code: 'queue_generate_cap' });
  assert.match(q.message, /cola|generate|16/i);
});

test('3H65-K-001 adapter snapshot and DeepSeek lock are 3H65', () => {
  const s = ad.adapterSnapshot();
  assert.equal(s.wave, '3H65');
  assert.equal(s.failClosed, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
  assert.equal(s.liveHelpersWired, 33);
  for (const name of LIVE_33) {
    assert.equal(typeof ad[name], 'function', name + ' must be a live export');
  }
  assert.equal(typeof ad.applyAntiLoopGuardsClosed, 'function');
  assert.equal(typeof ad.applyToolArgHygieneClosed, 'function');
  assert.equal(ad.loadOptionalEngineWave('engine-3h65').WAVE, '3H65');
  assert.equal(w65.refuseOpenRouterInWave3h65({ SIRAGPT_USE_OPENROUTER: '1' }).ok, false);
  assert.equal(w65.refuseOpenRouterInWave3h65({ DEEPSEEK_BASE_URL: 'https://api.deepseek.com' }).ok, true);
});

test('3H65-L-001 live loop/generate/sse import 3H65 + 33 helper names', () => {
  const loop = read('src/services/agent-runner/loop.js');
  const ai = read('src/routes/ai.js');
  const sse = read('src/utils/sse-writer.js');
  const ver = read('src/routes/version.js');
  assert.ok(loop.includes('applyAntiLoopGuardsClosed'));
  assert.ok(loop.includes('applyToolArgHygieneClosed'));
  assert.ok(loop.includes('applyToolResultHygieneClosed'));
  assert.ok(loop.includes('applyFileEditGuardsClosed'));
  assert.ok(loop.includes('applyDeepSeekCreditGuardsClosed'));
  assert.ok(loop.includes('detectDagCycle'));
  assert.ok(loop.includes('rejectToolCallCycleAtoBtoA'));
  assert.ok(loop.includes('deadLetterSameToolAfterN'));
  assert.ok(loop.includes('identicalObservationLoopCut'));
  assert.ok(loop.includes('budgetHintEveryFiveSteps'));
  assert.ok(loop.includes('remainingStepBudgetReminder'));
  assert.ok(loop.includes('maxConcurrentSubagents'));
  assert.ok(loop.includes('maxSubagentDepth'));
  assert.ok(loop.includes('maxInflightToolsPerSession8'));
  assert.ok(loop.includes('perToolRateLimit'));
  assert.ok(loop.includes('capToolArgBytes'));
  assert.ok(loop.includes('capToolArgBytes32KiB'));
  assert.ok(loop.includes('enforceAdditionalPropertiesFalse'));
  assert.ok(loop.includes('validateEnumArgs'));
  assert.ok(loop.includes('validateToolResultShape'));
  assert.ok(loop.includes('gzipToolResultOverSize'));
  assert.ok(loop.includes('clampToolResultWithHash'));
  assert.ok(loop.includes('redactSecretsInToolResult'));
  assert.ok(loop.includes('redactAuthorizationBearerInToolResults'));
  assert.ok(loop.includes('skipDuplicateWebFetchSameUrlTurn'));
  assert.ok(loop.includes('rollbackLastFileEdit'));
  assert.ok(loop.includes('rollbackLastNFileEdits'));
  assert.ok(loop.includes('afterWriteTestHint'));
  assert.ok(loop.includes('createIfMissingOrRefuseLargeOverwrite'));
  assert.ok(loop.includes('patchContextLinesMustMatch'));
  assert.ok(loop.includes('neverChargeIfCancelledBeforeFirstToken'));
  assert.ok(loop.includes('mapDeepSeekHttpError'));
  assert.ok(loop.includes('neverRetry402'));
  assert.ok(loop.includes('neverRetry413'));
  assert.ok(ai.includes('fairQueueStarvationBound'));
  assert.ok(ai.includes('maxQueuedGenerate16'));
  assert.ok(ai.includes('neverChargeIfCancelledBeforeFirstToken'));
  assert.ok(ai.includes('skipHeartbeatIfWriteWouldBlock'));
  assert.ok(sse.includes('requireSessionEventSeqIncrease'));
  assert.ok(sse.includes('skipHeartbeatIfWriteWouldBlock'));
  assert.ok(ver.includes('3H65'));
});

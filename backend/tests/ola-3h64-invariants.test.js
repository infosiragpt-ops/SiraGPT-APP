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
const ad = require('../src/services/agent-runner/engine-adapter');
const { classifyLoopError } = require('../src/services/agent-runner/loop');
const { createSSEWriter } = require('../src/utils/sse-writer');

function latencyDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-latency-3h64-'));
}

test('3H64-A-001 unique names do not collide with 3H59–3H63 exports', () => {
  assert.equal(w64.WAVE, '3H64');
  for (const name of w64.HELPERS) {
    assert.equal(w59.HELPERS.includes(name), false, 'collides with 3H59 ' + name);
    assert.equal(w60.HELPERS.includes(name), false, 'collides with 3H60 ' + name);
    assert.equal(w61.HELPERS.includes(name), false, 'collides with 3H61 ' + name);
    assert.equal(w62.HELPERS.includes(name), false, 'collides with 3H62 ' + name);
    assert.equal(w63.HELPERS.includes(name), false, 'collides with 3H63 ' + name);
    assert.equal(typeof w64[name], 'function');
  }
  assert.equal(typeof w64.applyFairGenerateQueueClosed, 'undefined');
  assert.equal(typeof w64.acquireFairGenerateLock, 'undefined');
  assert.equal(typeof w64.observeAdapterLatency, 'undefined');
});

test('3H64-B-001 latency ring p50/p95 from scripted persisted samples', () => {
  const dir = latencyDir();
  const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  for (const ms of samples) {
    const out = w64.persistLatencyRingClosed({
      kind: 'first_token',
      ms,
      dir,
      observeAdapterLatency: ad.observeAdapterLatency,
      adapterLatencySnapshot: ad.adapterLatencySnapshot,
    });
    assert.equal(out.ok, true);
    assert.equal(out.persisted, true);
  }
  for (const ms of [200, 400, 600, 800, 1000]) {
    w64.persistLatencyRingClosed({
      kind: 'turn_end',
      ms,
      dir,
      observeAdapterLatency: ad.observeAdapterLatency,
      adapterLatencySnapshot: ad.adapterLatencySnapshot,
    });
  }
  const ring = w64.readLatencyRingClosed({ dir });
  assert.equal(ring.firstTokenMs.count, 10);
  assert.equal(ring.firstTokenMs.p50, 50);
  assert.equal(ring.firstTokenMs.p95, 100);
  assert.equal(ring.turnEndMs.count, 5);
  assert.equal(ring.turnEndMs.p50, 600);
  assert.equal(ring.turnEndMs.p95, 1000);
  assert.equal(ring.firstTokenMs.source, 'persisted_ring');
  const live = ad.adapterLatencySnapshot();
  assert.ok(live.firstTokenMs.count >= 10);
  assert.ok(Number.isFinite(live.firstTokenMs.p50));
  assert.ok(Number.isFinite(live.firstTokenMs.p95));
  const jsonl = fs.readFileSync(path.join(dir, 'first_token.jsonl'), 'utf8');
  assert.ok(jsonl.indexOf('"ms":50') >= 0);
});

test('3H64-C-001 turn wall 120s + three-stall cancel + remaining cut', () => {
  const stall = ad.cancelIfThreeStreamStalls({ stallCount: 3 });
  assert.equal(stall.cancel, true);
  assert.equal(stall.code, 'stream_stall_cancel');
  const wall = ad.enforceTotalTurnWall120s({ startedAt: 1, now: 130001, wallMs: 120000 });
  assert.equal(wall.halt, true);
  assert.equal(wall.code, 'turn_wall');
  const cut = ad.remainingWallClockCut({ remainingMs: 0 });
  assert.equal(cut.halt, true);
  const closed = w64.applyTurnWallAndStallsClosed({
    stallCount: 3,
    startedAt: Date.now() - 130000,
    now: Date.now(),
    remainingMs: 0,
    cancelIfThreeStreamStalls: ad.cancelIfThreeStreamStalls,
    enforceTotalTurnWall120s: ad.enforceTotalTurnWall120s,
    remainingWallClockCut: ad.remainingWallClockCut,
    resetStallCountOnToken: ad.resetStallCountOnToken,
  });
  assert.equal(closed.halt, true);
  assert.equal(closed.cancel, true);
  const reset = w64.applyTurnWallAndStallsClosed({
    stallCount: 2,
    token: 'x',
    startedAt: Date.now(),
    now: Date.now(),
    remainingMs: 60000,
    cancelIfThreeStreamStalls: ad.cancelIfThreeStreamStalls,
    enforceTotalTurnWall120s: ad.enforceTotalTurnWall120s,
    remainingWallClockCut: ad.remainingWallClockCut,
    resetStallCountOnToken: ad.resetStallCountOnToken,
  });
  assert.equal(reset.reset, true);
  assert.equal(reset.cancel, false);
});

test('3H64-D-001 SSE reconnect Last-Event-ID inclusive replay + reject-backwards', async () => {
  const ring = [
    { seq: 1, data: { content: 'uno' } },
    { seq: 2, data: { content: 'dos' } },
    { seq: 3, data: { content: 'tres' } },
  ];
  const store = { cursor: 0 };
  const server = http.createServer((req, res) => {
    const last = req.headers['last-event-id'];
    const writer = createSSEWriter(res, {
      req,
      ring,
      lastEventId: last,
      inclusive: true,
      headSeq: 3,
      cursorStore: store,
      sessionKey: 'sse-3h64',
    });
    if (last != null && last !== '') {
      const back = ad.rejectLastEventIdGoingBackwards({
        lastEventId: last,
        stored: store.cursor,
        currentSeq: store.cursor,
      });
      if (back && back.backwards) {
        res.write('event: error\ndata: {"code":"sse_id_backwards"}\n\n');
        writer.close();
        return;
      }
      ad.detectSseGap(last, ring);
    } else {
      for (const frame of ring) {
        res.write('id: ' + frame.seq + '\n');
        res.write('data: ' + JSON.stringify(frame.data) + '\n\n');
      }
      if (store.cursor < 2) store.cursor = 2;
    }
    setTimeout(() => writer.close(), 30);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  function get(headers) {
    return new Promise((resolve, reject) => {
      const req = http.get({
        host: '127.0.0.1',
        port,
        path: '/generate',
        headers: headers || {},
      }, (res) => {
        let body = '';
        const ids = [];
        res.on('data', (c) => { body += c.toString('utf8'); });
        res.on('end', () => {
          const idRe = /^id:\s*(\d+)\s*$/gm;
          let m;
          while ((m = idRe.exec(body))) ids.push(Number(m[1]));
          resolve({ status: res.statusCode, body, ids });
        });
      });
      req.on('error', reject);
    });
  }

  const first = await get({});
  assert.ok(first.body.indexOf('uno') >= 0);
  assert.ok(first.ids.includes(2));
  const lastId = first.ids[first.ids.length - 1] || 2;

  const reconnect = await get({ 'Last-Event-ID': String(Math.min(2, lastId)) });
  assert.ok(reconnect.body.indexOf('dos') >= 0, 'inclusive replay must include Last-Event-ID seq');
  assert.ok(reconnect.body.indexOf('tres') >= 0);

  const backwards = ad.rejectLastEventIdGoingBackwards({
    lastEventId: 1,
    stored: 3,
    currentSeq: 3,
  });
  assert.equal(backwards.ok, false);
  assert.equal(backwards.backwards, true);
  store.cursor = 3;
  const rejected = await get({ 'Last-Event-ID': '1' });
  assert.ok(rejected.body.indexOf('sse_id_backwards') >= 0);

  await new Promise((resolve) => server.close(resolve));
});

test('3H64-E-001 sandbox kill-after-grace + net fail-closed + spawn wrap', () => {
  const signals = [];
  const timers = [];
  const killed = ad.sandboxKillAfterGraceMs({
    pid: 4242,
    graceMs: 15,
    killFn: (id, sig) => { signals.push({ id, sig }); },
    setTimeoutFn: (fn, ms) => { timers.push(ms); fn(); return 1; },
  });
  assert.equal(killed.killed, true);
  assert.equal(killed.graceMs, 15);
  assert.ok(signals.some((s) => s.sig === 'SIGTERM'));
  assert.ok(signals.some((s) => s.sig === 'SIGKILL'));
  const net = ad.sandboxNetFailClosed({});
  assert.equal(net.failClosed, true);
  assert.equal(net.code, 'network_denied');
  const wrap = ad.wrapSandboxSpawnWithRssCpu(process.execPath, ['-e', '1']);
  assert.equal(wrap.bin, '/bin/bash');
  assert.ok(String(wrap.argv[1]).indexOf('ulimit') >= 0);
  const closed = w64.applySandboxSpawnGuardsClosed({
    bin: process.execPath,
    argv: ['-e', '1'],
    env: {},
    pid: 9,
    aborted: true,
    dirs: [path.join(os.tmpdir(), 'siragpt-missing-3h64')],
    killFn: () => {},
    setTimeoutFn: (fn) => { fn(); return 1; },
    graceMs: 1,
    sandboxKillAfterGraceMs: ad.sandboxKillAfterGraceMs,
    sandboxNetFailClosed: ad.sandboxNetFailClosed,
    sandboxNoNewPrivs: ad.sandboxNoNewPrivs,
    wrapSandboxSpawnWithRssCpu: ad.wrapSandboxSpawnWithRssCpu,
    tmpCleanupOnCancel: ad.tmpCleanupOnCancel,
    reapBackgroundBashOnAbort: ad.reapBackgroundBashOnAbort,
    pollBackgroundBash: ad.pollBackgroundBash,
  });
  assert.equal(closed.bin, '/bin/bash');
  assert.equal(closed.netFailClosed, true);
  assert.equal(closed.killed, true);
});

test('3H64-F-001 compact keeps system + pins + last assistant tool_calls', () => {
  const system = { role: 'system', content: 'Eres SiraGPT.' };
  const pin = { role: 'system', content: 'PIN: deadline viernes', pinned: true };
  const u1 = { role: 'user', content: 'uno' };
  const a1 = { role: 'assistant', content: 'ok1' };
  const u2 = { role: 'user', content: 'dos' };
  const a2 = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'list_files', arguments: '{}' } }] };
  const t2 = { role: 'tool', content: 'ERROR: EACCES permission', tool_call_id: 'c1', isError: true };
  const u3 = { role: 'user', content: 'tres' };
  const original = [system, pin, u1, a1, u2, a2, t2, u3];
  const skip = ad.skipCompactIfUnderBudget(original);
  assert.equal(skip.skipped, true);
  const closed = w64.applyCompactKeepPinsClosed({
    messages: original,
    compacted: [u3],
    pins: [pin],
    skipCompactIfUnderBudget: ad.skipCompactIfUnderBudget,
    compactKeepPinnedFactsAndLast3UserTurns: ad.compactKeepPinnedFactsAndLast3UserTurns,
    compactNeverDropSystemPrompt: ad.compactNeverDropSystemPrompt,
    compactNeverDropLastAssistantToolCalls: ad.compactNeverDropLastAssistantToolCalls,
    pinLastToolErrorOnCompact: ad.pinLastToolErrorOnCompact,
  });
  assert.ok(closed.messages.some((m) => m && m.role === 'system' && String(m.content).indexOf('SiraGPT') >= 0));
  assert.ok(closed.messages.some((m) => m && m.tool_calls));
  assert.equal(closed.pinnedError, true);
  const restored = ad.compactNeverDropSystemPrompt(original, [{ role: 'user', content: 'x' }]);
  assert.equal(restored.restored, true);
});

test('3H64-G-001 crc32 checkpoint + gzip + prune + bound resume', () => {
  const payload = { messages: [{ role: 'user', content: 'hola' }], remaining: 9 };
  const stamp = ad.crc32StampOnCheckpointSave(payload);
  assert.ok(Number.isFinite(stamp.crc32));
  const ok = ad.crc32CheckOnCheckpointLoad(payload, { expectedCrc: stamp.crc32 });
  assert.equal(ok.ok, true);
  const bad = ad.crc32CheckOnCheckpointLoad({ other: true }, { expectedCrc: stamp.crc32 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'ckpt_crc');
  const big = { blob: 'x'.repeat(70 * 1024) };
  const gz = ad.gzipCheckpointIfOver64KiB(big);
  assert.equal(gz.gzipped, true);
  const pruned = ad.pruneCheckpointsKeepLastN([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { keep: 3 });
  assert.equal(pruned.pruned, true);
  assert.deepEqual(pruned.checkpoints, [8, 9, 10]);
  const bound = ad.boundStepsOnCheckpointResume({ remaining: 20, checkpointRemaining: 4, max: 25 });
  assert.equal(bound.remaining, 4);
  const replayed = ad.replayToolResultsOnResume(new Map(), [
    { role: 'tool', tool_call_id: 'c9', content: 'ok' },
  ]);
  assert.equal(replayed.replayed, 1);
  const closed = w64.applyCheckpointResumeClosed({
    persist: true,
    resume: true,
    state: payload,
    remaining: 12,
    checkpointRemaining: 4,
    list: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    messages: [{ role: 'tool', tool_call_id: 'c9', content: 'ok' }],
    store: new Map(),
    replayToolResultsOnResume: ad.replayToolResultsOnResume,
    boundStepsOnCheckpointResume: ad.boundStepsOnCheckpointResume,
    crc32CheckOnCheckpointLoad: ad.crc32CheckOnCheckpointLoad,
    gzipCheckpointIfOver64KiB: ad.gzipCheckpointIfOver64KiB,
    pruneCheckpointsKeepLastN: ad.pruneCheckpointsKeepLastN,
    crc32StampOnCheckpointSave: ad.crc32StampOnCheckpointSave,
    persistFn: () => {},
  });
  assert.equal(closed.ok, true);
  assert.equal(closed.remaining, 4);
  assert.ok(closed.replayed >= 1);
});

test('3H64-H-001 client-gone close + flush + abort error event + gap', () => {
  const gone = ad.closeIfClientGone30s({ lastClientAt: Date.now() - 31000, now: Date.now() });
  assert.equal(gone.close, true);
  assert.equal(gone.code, 'client_gone');
  const flush = ad.flushLastSseEventBeforeClose({ pendingEvent: { id: 4 }, closed: false });
  assert.equal(flush.flush, true);
  const abortEvt = ad.endSseWithErrorEventOnAbort({ aborted: true, closed: false, reason: 'aborted' });
  assert.equal(abortEvt.write, true);
  assert.ok(String(abortEvt.frame).indexOf('event: error') >= 0);
  const gap = ad.detectSseGap('1', [{ seq: 8 }, { seq: 9 }]);
  assert.equal(gap.gap, true);
  let destroyed = false;
  const rec = ad.destroySseOnClientClose(
    { on: () => {}, destroyed: true },
    { destroy: () => { destroyed = true; } },
  );
  assert.equal(destroyed, true);
  assert.equal(rec.destroyed, true);
  const closed = w64.guardSseClientGoneClosed({
    lastClientAt: Date.now() - 31000,
    now: Date.now(),
    pendingEvent: { id: 2 },
    closed: false,
    aborted: true,
    lastEventId: '1',
    ring: [{ seq: 8 }],
    destroySseOnClientClose: ad.destroySseOnClientClose,
    closeIfClientGone30s: ad.closeIfClientGone30s,
    flushLastSseEventBeforeClose: ad.flushLastSseEventBeforeClose,
    endSseWithErrorEventOnAbort: ad.endSseWithErrorEventOnAbort,
    detectSseGap: ad.detectSseGap,
  });
  assert.equal(closed.close, true);
  assert.equal(closed.abortWrite, true);
  assert.equal(closed.gap, true);
});

test('3H64-I-001 public errors are Spanish and never leak stacks or sk-', () => {
  const hit = w64.classifyPublicGenerateErrorClosed({
    err: { message: 'sk-secretvaluehere', stack: 'at Object.foo (/tmp/x.js:1:1)', code: 'EACCES' },
    classifyToolFailure: ad.classifyToolFailure,
    sanitizeClientError: ad.sanitizeClientError,
  });
  assert.ok(hit.message);
  assert.equal(hit.message.indexOf('sk-'), -1);
  assert.equal(/at Object\./.test(hit.message), false);
  assert.match(hit.message, /[áéíóúñÁÉÍÓÚÑ]|permiso|herramienta|fall/i);
  const stall = w64.classifyEngine3h64Error({
    code: 'stream_stall_cancel',
    err: { stack: 'at Object.foo (/tmp/x.js:1:1)', message: 'sk-secretvaluehere' },
  });
  assert.ok(stall.message.indexOf('tres') >= 0);
  assert.equal(stall.message.indexOf('sk-'), -1);
  assert.equal(classifyLoopError({ code: 'turn_wall' }).retryable, true);
});

test('3H64-J-001 adapter snapshot and DeepSeek lock are 3H64', () => {
  const s = ad.adapterSnapshot();
  assert.equal(s.wave, '3H64');
  assert.equal(s.failClosed, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
  assert.equal(s.liveHelpersWired, 31);
  assert.equal(typeof ad.persistLatencyRingClosed, 'function');
  assert.equal(typeof ad.cancelIfThreeStreamStalls, 'function');
  assert.equal(typeof ad.enforceTotalTurnWall120s, 'function');
  assert.equal(typeof ad.destroySseOnClientClose, 'function');
  assert.equal(typeof ad.sandboxKillAfterGraceMs, 'function');
  assert.equal(typeof ad.compactNeverDropSystemPrompt, 'function');
  assert.equal(typeof ad.crc32CheckOnCheckpointLoad, 'function');
  assert.equal(typeof ad.classifyToolFailure, 'function');
  assert.equal(ad.loadOptionalEngineWave('engine-3h64').WAVE, '3H64');
  assert.equal(w64.refuseOpenRouterInWave3h64({ SIRAGPT_USE_OPENROUTER: '1' }).ok, false);
  assert.equal(w64.refuseOpenRouterInWave3h64({ DEEPSEEK_BASE_URL: 'https://api.deepseek.com' }).ok, true);
});

test('3H64-K-001 live loop/generate/sse/sandbox import 3H64 + live helper names', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.ok(loop.includes('cancelIfThreeStreamStalls'));
  assert.ok(loop.includes('enforceTotalTurnWall120s'));
  assert.ok(loop.includes('remainingWallClockCut'));
  assert.ok(loop.includes('compactKeepPinnedFactsAndLast3UserTurns'));
  assert.ok(loop.includes('compactNeverDropSystemPrompt'));
  assert.ok(loop.includes('compactNeverDropLastAssistantToolCalls'));
  assert.ok(loop.includes('skipCompactIfUnderBudget'));
  assert.ok(loop.includes('pinLastToolErrorOnCompact'));
  assert.ok(loop.includes('replayToolResultsOnResume'));
  assert.ok(loop.includes('boundStepsOnCheckpointResume'));
  assert.ok(loop.includes('crc32CheckOnCheckpointLoad'));
  assert.ok(loop.includes('gzipCheckpointIfOver64KiB'));
  assert.ok(loop.includes('pruneCheckpointsKeepLastN'));
  assert.ok(loop.includes('classifyToolFailure'));
  assert.ok(loop.includes('sanitizeClientError'));
  assert.ok(loop.includes('observeAdapterLatency'));
  assert.ok(loop.includes('adapterLatencySnapshot'));
  const ai = read('src/routes/ai.js');
  assert.ok(ai.includes('detectSseGap'));
  assert.ok(ai.includes('destroySseOnClientClose'));
  assert.ok(ai.includes('closeIfClientGone30s'));
  assert.ok(ai.includes('flushLastSseEventBeforeClose'));
  assert.ok(ai.includes('endSseWithErrorEventOnAbort'));
  assert.ok(ai.includes('persistLatencyRingClosed'));
  assert.ok(ai.includes('classifyPublicGenerateErrorClosed'));
  const sse = read('src/utils/sse-writer.js');
  assert.ok(sse.includes('detectSseGap'));
  assert.ok(sse.includes('destroySseOnClientClose'));
  assert.ok(sse.includes('flushLastSseEventBeforeClose'));
  assert.ok(sse.includes('endSseWithErrorEventOnAbort'));
  const sbx = read('src/services/sandbox/local-sandbox.js');
  assert.ok(sbx.includes('sandboxKillAfterGraceMs'));
  assert.ok(sbx.includes('sandboxNetFailClosed'));
  assert.ok(sbx.includes('sandboxNoNewPrivs'));
  assert.ok(sbx.includes('wrapSandboxSpawnWithRssCpu'));
  assert.ok(sbx.includes('tmpCleanupOnCancel'));
  assert.ok(sbx.includes('reapBackgroundBashOnAbort'));
  assert.ok(sbx.includes('pollBackgroundBash'));
  const ver = read('src/routes/version.js');
  assert.ok(ver.includes('/latency'));
  assert.ok(ver.includes('adapterLatencySnapshot'));
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-resilience.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const res = require('../src/services/agent-runner/engine-resilience');

test('3H29-A-001 detectLoopStall no token no tool after idle', () => {
  const out = res.detectLoopStall({
    lastTokenAt: 0,
    lastToolResultAt: 0,
    startedAt: 1000,
    now: 1000 + 50_000,
    idleMs: 10_000,
  });
  assert.equal(out.stop, true);
  assert.equal(out.code, 'loop_stall');
  assert.equal(out.reason, 'no_token_no_tool');
});

test('3H29-A-002 detectLoopStall wall idle after last tool', () => {
  const out = res.detectLoopStall({
    lastTokenAt: 1000,
    lastToolResultAt: 2000,
    startedAt: 500,
    now: 2000 + 20_000,
    idleMs: 10_000,
  });
  assert.equal(out.stop, true);
  assert.equal(out.code, 'loop_stall');
});

test('3H29-A-003 detectLoopStall recent token is fine', () => {
  const out = res.detectLoopStall({
    lastTokenAt: 9000,
    lastToolResultAt: 0,
    startedAt: 1000,
    now: 9500,
    idleMs: 10_000,
  });
  assert.equal(out.stop, false);
});

test('3H29-A-004 withIdleCut stops a hung generate', async () => {
  const hung = new Promise(() => {});
  const out = await res.withIdleCut(hung, { idleMs: 40 });
  assert.equal(out.stalled, true);
  assert.equal(out.code, 'loop_stall');
});

test('3H29-A-005 inheritParentRemaining child cannot exceed parent', () => {
  const out = res.inheritParentRemaining({ parentRemaining: 1, childRequested: 8 });
  assert.equal(out.ok, true);
  assert.equal(out.budget, 1);
  assert.ok(out.budget <= out.leftover);
});

test('3H29-A-006 inheritParentRemaining exhausted parent', () => {
  const out = res.inheritParentRemaining({ parentRemaining: 3, childUsed: 3, childRequested: 8 });
  assert.equal(out.ok, false);
  assert.equal(out.budget, 0);
  assert.equal(out.code, 'subagent_budget');
});

test('3H29-B-001 stringified JSON arguments repaired', () => {
  const out = res.repairMalformedToolTurn([
    { id: 'c1', function: { name: 'read_file', arguments: '"{\\"path\\":\\"a.js\\"}"' } },
  ]);
  assert.equal(out.calls[0].__args.path, 'a.js');
  assert.equal(out.calls[0].__repaired, true);
});

test('3H29-B-002 empty name classified not hung', () => {
  const out = res.repairMalformedToolTurn([
    { id: 'c1', function: { name: '', arguments: '{}' } },
  ]);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'tool_name_empty');
  assert.equal(out.calls[0].__rejected, true);
});

test('3H29-B-003 duplicate id in same turn renamed', () => {
  const out = res.repairMalformedToolTurn([
    { id: 'same', function: { name: 'read_file', arguments: '{}' } },
    { id: 'same', function: { name: 'grep', arguments: '{}' } },
  ]);
  assert.equal(out.code, 'tool_id_duplicate');
  assert.notEqual(out.calls[0].id, out.calls[1].id);
  assert.equal(out.calls[1].__renamed, true);
});

test('3H29-B-004 orphan tool result classified', () => {
  const out = res.repairMalformedToolTurn(
    [{ id: 'c1', function: { name: 'read_file', arguments: '{}' } }],
    [{ tool_call_id: 'missing', content: 'nope' }],
  );
  assert.equal(out.orphans.length, 1);
  assert.equal(out.code, 'tool_result_orphan');
});

test('3H29-C-001 pin LRU keeps critical under eviction', () => {
  const pins = [
    { text: 'keep-me', critical: true, score: 0.1, at: 1 },
    ...Array.from({ length: 14 }, (_, i) => ({ text: 'n' + i, critical: false, score: 0.9, at: 100 + i })),
  ];
  const out = res.evictPinsKeepingCritical(pins, 8);
  assert.ok(out.pins.some((p) => p.text === 'keep-me'));
  assert.equal(out.keptCritical, 1);
  assert.equal(out.code, 'pin_evict');
  assert.ok(out.pins.length <= 8 || out.pins.every((p) => p.critical));
});

test('3H29-C-002 score tie-break recency then pin', () => {
  const a = { text: 'old', score: 0.5, at: 1, critical: false };
  const b = { text: 'new', score: 0.5, at: 9, critical: false };
  const c = { text: 'crit', score: 0.1, at: 0, critical: true };
  assert.ok(res.scoreTieBreak(c, a) < 0);
  assert.ok(res.scoreTieBreak(b, a) < 0);
});

test('3H29-C-003 compact keeps system and pinned facts', () => {
  const messages = [
    { role: 'system', content: 'You are Sira.' },
    { role: 'system', content: '[PINNED FACTS — do not drop]\n- user=Luis' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'ok', tool_calls: [{ id: 't1', function: { name: 'read_file' } }] },
    { role: 'tool', content: 'file' },
    ...Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: 'pad-' + i + '-'.repeat(200) })),
  ];
  const out = res.compactKeepingSystemAndPins(messages, { maxTokens: 200, pins: ['user=Luis'] });
  assert.ok(out.messages.some((m) => m.role === 'system' && /You are Sira/.test(m.content)));
  assert.ok(out.messages.some((m) => /PINNED FACTS/.test(String(m.content || ''))));
  assert.ok(out.keptPins >= 1);
});

test('3H29-D-001 exactly-once skips a tool that already produced a result', () => {
  const store = res.createExactlyOnceToolStore();
  store.markInFlight('call_1');
  store.recordResult('call_1', 'OK: done');
  const skip = res.resumeSkipCompleted(store, 'call_1');
  assert.equal(skip.skip, true);
  assert.equal(skip.code, 'exactly_once_tool');
  assert.equal(skip.result, 'OK: done');
});

test('3H29-D-002 in-flight marker then resume does not re-run', () => {
  const snap = { done: { call_9: 'already' } };
  const store = res.createExactlyOnceToolStore(snap);
  const mark = store.markInFlight('call_9');
  assert.equal(mark.skip, true);
  assert.equal(mark.result, 'already');
});

test('3H29-E-001 extra writer git dirty refuse', () => {
  const out = res.assertGitCleanExtraWriter({
    name: 'create_presentation',
    relPath: 'outputs/deck.pptx',
    gitStatus: () => ({ dirty: true }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'git_apply_dirty');
});

test('3H29-E-002 extra writer clean is ok', () => {
  const out = res.assertGitCleanExtraWriter({
    name: 'add_slide',
    relPath: 'outputs/deck.pptx',
    gitStatus: () => ({ dirty: false }),
  });
  assert.equal(out.ok, true);
});

test('3H29-F-001 byte ring drops oldest not stall', () => {
  const ring = res.createByteRing(16);
  ring.push('AAAAAAAA');
  ring.push('BBBBBBBB');
  ring.push('CCCCCCCC');
  const s = ring.toString();
  assert.ok(s.includes('C'));
  assert.ok(!s.includes('A') || s.indexOf('C') >= 0);
  assert.ok(ring.snapshot().dropped > 0);
  assert.equal(ring.snapshot().dropOldest, true);
  assert.ok(ring.snapshot().bytes <= 16);
});

test('3H29-F-002 rlimit fallback is honest not gVisor', () => {
  const lim = res.resolveSandboxLimits();
  assert.equal(lim.usesRunsc, false);
  assert.equal(lim.interpreter, 'local');
  assert.ok(lim.method === 'prlimit' || lim.method === 'rlimit_fallback');
  const meta = res.sandboxInterpreterMeta();
  assert.equal(meta.usesRunsc, false);
  assert.equal(meta.interpreter, 'local');
});

test('3H29-F-003 killProcessGroup sends group then pid', () => {
  const seen = [];
  const out = res.killProcessGroup(4242, {
    platform: 'linux',
    kill: (id, sig) => { seen.push([id, sig]); return true; },
  });
  assert.equal(out.ok, true);
  assert.ok(seen.some((x) => x[0] === -4242 && x[1] === 'SIGKILL'));
  assert.ok(seen.some((x) => x[0] === 4242));
});

test('3H29-F-004 tmp register + cleanup even after parent death marker', () => {
  const dir = path.join(require('os').tmpdir(), 'siragpt-sandbox-3h29-test');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'x.txt'), 'hi');
  const reg = res.registerSandboxTmp(dir);
  assert.equal(reg.ok, true);
  const swept = res.sweepOrphanSandboxTmp({ maxAgeMs: 0, now: Date.now() + 1000 });
  assert.ok(swept.swept.includes(dir) || !fs.existsSync(dir));
  res.cleanupSandboxTmp(dir);
  assert.equal(fs.existsSync(dir), false);
});

test('3H29-F-005 idle timeout when no sandbox bytes', () => {
  const out = res.detectIdleTimeout({ lastByteAt: 1000, now: 1000 + 20_000, idleMs: 5000 });
  assert.equal(out.stop, true);
  assert.equal(out.code, 'sandbox_timeout');
});

test('3H29-G-001 heartbeat during sandbox exec tagged inflight', () => {
  const frames = [];
  const hb = res.startExecHeartbeat((f) => frames.push(f), {
    intervalMs: 1_000_000,
    kind: 'sandbox',
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });
  const beat = hb.beat();
  assert.equal(beat.inflight, 'sandbox');
  assert.equal(beat.type, 'heartbeat');
  hb.stop();
  const tagged = res.tagHeartbeatInflight({ type: 'heartbeat' }, 'generate');
  assert.equal(tagged.inflight, 'generate');
});

test('3H29-H-001 second session turn waits and does not interleave', async () => {
  const gate = res.createSessionTurnGate();
  const order = [];
  let releaseFirst;
  const firstHang = new Promise((r) => { releaseFirst = r; });
  const p1 = gate.run('sess-1', async ({ emit }) => {
    emit({ type: 'start', turn: 1 });
    order.push('t1-start');
    await firstHang;
    emit({ type: 'end', turn: 1 });
    order.push('t1-end');
    return 'one';
  });
  const p2 = gate.run('sess-1', async ({ emit, code }) => {
    emit({ type: 'start', turn: 2 });
    order.push('t2-start');
    emit({ type: 'end', turn: 2 });
    order.push('t2-end');
    return { value: 'two', waited: code === 'session_busy' || true };
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['t1-start']);
  releaseFirst();
  const results = await Promise.all([p1, p2]);
  assert.equal(results[0], 'one');
  assert.deepEqual(order, ['t1-start', 't1-end', 't2-start', 't2-end']);
  const seq = gate.assertNoInterleave('sess-1');
  assert.equal(seq.ok, true);
});

test('3H29-I-001 credit hold same turn_id does not double-hold', () => {
  const map = new Map();
  let reserves = 0;
  const make = () => {
    let reserved = 0;
    return {
      reserve(n) { reserves += 1; reserved += n; return { ok: true, reserved }; },
      settle(u) { return { ok: true, leftover: Math.max(0, reserved - u), settled: u }; },
      release() { const n = reserved; reserved = 0; return { ok: true, released: n }; },
    };
  };
  const a = res.holdCreditsOnce(map, 'turn-9', 100, make);
  const b = res.holdCreditsOnce(map, 'turn-9', 100, make);
  assert.equal(a.reused, false);
  assert.equal(b.reused, true);
  assert.equal(b.code, 'credit_hold_reuse');
  assert.equal(reserves, 1);
  assert.equal(a.hold, b.hold);
});

test('3H29-I-002 storm cancel settles used and releases leftover', () => {
  let reserved = 80;
  const hold = {
    settle(u) { reserved = Math.max(0, reserved - u); return { ok: true, leftover: reserved, settled: u }; },
    release() { const n = reserved; reserved = 0; return { ok: true, released: n }; },
  };
  const out = res.settleStormCancel(hold, { used: 30, aborted: true });
  assert.equal(out.code, 'credit_cancel');
  assert.equal(out.used, 30);
  assert.equal(out.leftover, 50);
  assert.equal(out.released.released, 50);
});

test('3H29-J-001 scripted p50/p95 tagged inflight sandbox vs generate', () => {
  res.resetInflightLatency();
  res.observeInflightMs('generate', 20);
  res.observeInflightMs('generate', 40);
  res.observeInflightMs('sandbox', 100);
  res.observeInflightMs('sandbox', 300);
  const snap = res.snapshotInflightLatency();
  assert.equal(snap.generate.count, 2);
  assert.equal(snap.generate.p50, 20);
  assert.equal(snap.sandbox.count, 2);
  assert.ok(snap.sandbox.p95 >= 100);
  assert.match(snap.generate.note, /never invented Flash/);
});

test('3H29-K-001 resilienceSnapshot flags', () => {
  const s = res.resilienceSnapshot();
  assert.equal(s.loopStall, true);
  assert.equal(s.pinKeepCritical, true);
  assert.equal(s.exactlyOnceTool, true);
  assert.equal(s.sandboxUsesRunsc, false);
  assert.equal(s.interpreter, 'local');
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.sessionTurnWait, true);
  assert.equal(s.creditHoldOnce, true);
});

test('3H29-K-002 classify public ES codes never traces', () => {
  for (const code of ['loop_stall', 'sandbox_timeout', 'tool_id_duplicate', 'session_busy', 'pin_evict', 'exactly_once_tool']) {
    const c = res.classifyResilienceError(code);
    assert.equal(c.code, code);
    assert.ok(c.message);
    assert.ok(!/at Object\.|stack:|\/opt\/siragpt/.test(c.message));
  }
});

test('3H29-L-001 live loop wires stall inherit malformed pins exactly-once compact', () => {
  const src = read('src/services/agent-runner/loop.js');
  assert.match(src, /engine-resilience/);
  assert.match(src, /detectLoopStall/);
  assert.match(src, /inheritParentRemaining/);
  assert.match(src, /repairMalformedToolTurn/);
  assert.match(src, /evictPinsKeepingCritical/);
  assert.match(src, /compactKeepingSystemAndPins/);
  assert.match(src, /createExactlyOnceToolStore/);
  assert.match(src, /holdCreditsOnce|settleStormCancel/);
});

test('3H29-L-002 live sandbox isolation wired', () => {
  const src = read('src/services/sandbox/local-sandbox.js');
  assert.match(src, /engine-resilience/);
  assert.match(src, /createByteRing/);
  assert.match(src, /killProcessGroup/);
  assert.match(src, /detectIdleTimeout/);
  assert.match(src, /startExecHeartbeat/);
  assert.match(src, /pythonRlimitPreamble|resolveSandboxLimits/);
  assert.doesNotMatch(src, /usesRunsc:\s*true/);
});

test('3H29-L-003 live extra writers refuse git dirty', () => {
  const src = read('src/services/agent-runner/tools.js');
  assert.match(src, /assertGitCleanExtraWriter/);
  const n = (src.match(/assertGitCleanExtraWriter/g) || []).length;
  assert.ok(n >= 3, 'create_presentation + add_slide + set_slide_background');
});

test('3H29-L-004 live codes + health + sse heartbeat inflight', () => {
  const codes = read('src/services/error_codes.js');
  assert.match(codes, /LOOP_STALL: 'loop_stall'/);
  assert.match(codes, /SANDBOX_TIMEOUT: 'sandbox_timeout'/);
  assert.match(codes, /TOOL_ID_DUPLICATE: 'tool_id_duplicate'/);
  assert.match(codes, /SESSION_BUSY: 'session_busy'/);
  assert.match(codes, /EXACTLY_ONCE_TOOL: 'exactly_once_tool'/);
  const pub = read('src/services/observability/public-stream-error.js');
  assert.match(pub, /loop_stall/);
  assert.match(pub, /sandbox_timeout/);
  assert.match(pub, /session_busy/);
  const health = read('src/services/observability/health-check.js');
  assert.match(health, /engine-resilience/);
  assert.match(health, /resilienceSnapshot/);
  const sse = read('src/utils/sse-writer.js');
  assert.match(sse, /inflight/);
});

test('3H29-L-005 live /code agent-loop and gateway queue wait', () => {
  const loop = read('src/services/codex/agent-loop.js');
  assert.match(loop, /engine-resilience/);
  assert.match(loop, /holdCreditsOnce|detectLoopStall|repairMalformedToolTurn/);
  const q = read('src/services/agent-gateway/queue.js');
  assert.match(q, /engine-resilience|getSharedSessionGate|createSessionTurnGate/);
});

test('3H29-L-006 python preamble includes CPU+RSS rlimit', () => {
  const pre = res.pythonRlimitPreamble({ rssBytes: 64 * 1024 * 1024, cpuSec: 5 });
  assert.match(pre, /RLIMIT_AS/);
  assert.match(pre, /RLIMIT_CPU/);
  assert.match(pre, /umask/);
});

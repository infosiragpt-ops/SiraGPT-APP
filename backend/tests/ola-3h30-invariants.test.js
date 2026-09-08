'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-correctness.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const corr = require('../src/services/agent-runner/engine-correctness');

test('3H30-A-001 stopWhenParentExhausted fires mid-child when leftover is 0', () => {
  const out = corr.stopWhenParentExhausted({ parentRemaining: 2, childUsed: 2, midChild: true });
  assert.equal(out.stop, true);
  assert.equal(out.code, 'subagent_budget');
  assert.equal(out.reason, 'parent_exhausted_mid_child');
});

test('3H30-A-002 stopWhenParentExhausted allows leftover > 0', () => {
  const out = corr.stopWhenParentExhausted({ parentRemaining: 4, childUsed: 1, midChild: true });
  assert.equal(out.stop, false);
  assert.equal(out.leftover, 3);
});

test('3H30-A-003 cancellable gate aborts in-flight turn as turn_superseded', async () => {
  const gate = corr.createCancellableSessionGate();
  let released = false;
  const hanging = gate.run('s1', async ({ signal }) => {
    await new Promise((resolve) => {
      const t = setInterval(() => {
        if (signal.aborted) { clearInterval(t); released = true; resolve('aborted'); }
      }, 5);
    });
    return 'old';
  });
  await new Promise((r) => setImmediate(r));
  const newer = gate.run('s1', async () => 'new');
  const results = await Promise.all([hanging, newer]);
  assert.ok(released, 'runner must observe abort and not leak');
  assert.equal(results[1], 'new');
  const classified = corr.classifyTurnSuperseded({ aborted: true, reason: 'turn_superseded' });
  assert.equal(classified.code, 'turn_superseded');
});

test('3H30-A-004 cancel-to-idle p50/p95 is scripted', () => {
  corr.resetCancelToIdle();
  corr.observeCancelToIdleMs(8);
  corr.observeCancelToIdleMs(12);
  corr.observeCancelToIdleMs(40);
  const snap = corr.snapshotCancelToIdle();
  assert.equal(snap.count, 3);
  assert.ok(snap.p50 >= 8);
  assert.ok(snap.p95 >= 12);
  assert.match(snap.note, /never invented Flash/);
});

test('3H30-B-001 oversized tool result truncates with stable hash footer', () => {
  const big = 'x'.repeat(80 * 1024);
  const out = corr.capToolResultWithHash(big, 1024);
  assert.equal(out.truncated, true);
  assert.equal(out.code, 'tool_result_capped');
  assert.match(out.text, /truncated sha256=/);
  assert.match(out.text, /rest=/);
  assert.equal(out.hash, corr.sha256Hex(big));
  const again = corr.capToolResultWithHash(big, 1024);
  assert.equal(again.hash, out.hash);
});

test('3H30-B-002 unknown tool classified tool_unknown with closest alias', () => {
  const out = corr.resolveUnknownTool('exceute_bash', {
    executors: { execute_bash() {}, read_file() {} },
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'tool_unknown');
  assert.equal(out.suggestion, 'execute_bash');
});

test('3H30-B-003 known alias maps without tool_unknown', () => {
  const out = corr.resolveUnknownTool('bash', { executors: { execute_bash() {} } });
  assert.equal(out.ok, true);
  assert.equal(out.mapped, 'execute_bash');
  assert.equal(out.code, null);
});

test('3H30-C-001 detectDagCycle finds A to B to A', () => {
  const out = corr.detectDagCycle([
    { id: 'a', deps: ['b'] },
    { id: 'b', deps: ['a'] },
  ]);
  assert.equal(out.cycle, true);
  assert.equal(out.code, 'dag_cycle');
  assert.ok(out.path.includes('a'));
});

test('3H30-C-002 waitDagReadySafe returns dag_cycle not hang', () => {
  const out = corr.waitDagReadySafe([
    { id: 'a', dependsOn: ['b'] },
    { id: 'b', dependsOn: ['a'] },
  ], []);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'dag_cycle');
});

test('3H30-C-003 acyclic unmet dep is still dag_blocked not dag_cycle', () => {
  const out = corr.waitDagReadySafe([{ id: 'b', dependsOn: ['a'] }], []);
  assert.equal(out.ok, false);
  assert.notEqual(out.code, 'dag_cycle');
});

test('3H30-D-001 retrieve skips expired ttl pins', () => {
  const now = 10_000;
  const out = corr.retrieveSkipExpiredPins([
    { text: 'keep', at: 9_000, ttl: 5_000 },
    { text: 'drop', at: 1_000, ttl: 1_000 },
    { text: 'drop2', expiresAt: 5_000 },
  ], now);
  assert.ok(out.hits.some((pin) => pin.text === 'keep'));
  assert.ok(!out.hits.some((pin) => pin.text === 'drop'));
  assert.ok(!out.hits.some((pin) => pin.text === 'drop2'));
  assert.equal(out.expired, 2);
});

test('3H30-D-002 memory retrieve never injects another user namespace', () => {
  const out = corr.filterMemoryAclNamespace([
    { text: 'mine', userId: 'u1', namespace: 'u1' },
    { text: 'foreign', userId: 'u2', namespace: 'u2' },
    { text: 'ns-leak', namespace: 'other' },
  ], { userId: 'u1', namespace: 'u1' });
  assert.equal(out.hits.length, 1);
  assert.equal(out.hits[0].text, 'mine');
  assert.equal(out.code, 'memory_acl_denied');
  assert.ok(out.denied >= 2);
});

test('3H30-D-003 compact keeps last N tool-error messages', () => {
  const original = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'tool', content: 'ERROR: boom-1' },
    { role: 'tool', content: 'ok' },
    { role: 'tool', content: 'ERROR: boom-2' },
    { role: 'tool', content: 'ERROR: boom-3' },
    { role: 'tool', content: 'ERROR: boom-4' },
  ];
  const compacted = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ];
  const out = corr.compactKeepLastToolErrors(compacted, original, { keep: 2 });
  assert.equal(out.keptToolErrors, 2);
  assert.ok(out.messages.some((m) => /boom-4/.test(m.content)));
  assert.ok(out.messages.some((m) => /boom-3/.test(m.content)));
  assert.ok(!out.messages.some((m) => /boom-1/.test(m.content)));
});

test('3H30-E-001 atomic checkpoint write uses temp plus rename', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-ckpt-'));
  const dest = path.join(dir, 'ckpt.json');
  const out = corr.atomicCheckpointWrite(dest, { id: 'c1', state: { n: 1 } });
  assert.equal(out.ok, true);
  const rec = corr.readCheckpointFile(dest);
  assert.equal(rec.ok, true);
  assert.equal(rec.rec.id, 'c1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('3H30-E-002 truncated checkpoint file is corrupt not silently parsed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-ckpt-'));
  const dest = path.join(dir, 'ckpt.json');
  corr.atomicCheckpointWrite(dest, { id: 'good', state: { n: 2 } });
  fs.writeFileSync(dest, '{"id":"partial"', 'utf8');
  const rec = corr.readCheckpointFile(dest);
  assert.equal(rec.ok, false);
  assert.equal(rec.code, 'checkpoint_corrupt');
  assert.equal(rec.truncated, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('3H30-F-001 identical unique hunk is write_noop', () => {
  const out = corr.readAfterWriteCompare({
    before: 'hello world',
    after: 'hello world',
    hunk: { old: 'hello', new: 'hello' },
  });
  assert.equal(out.noop, true);
  assert.equal(out.code, 'write_noop');
});

test('3H30-F-002 changed hunk is success', () => {
  const out = corr.readAfterWriteCompare({
    before: 'hello world',
    after: 'hello there',
    hunk: { old: 'world', new: 'there' },
  });
  assert.equal(out.ok, true);
  assert.equal(out.noop, false);
});

test('3H30-F-003 writeWithNoopDetect classifies no-op write', async () => {
  let stored = 'same';
  const out = await corr.writeWithNoopDetect({
    relPath: 'a.js',
    content: 'same',
    before: 'same',
    readFile: async () => stored,
    writeFile: async (_p, body) => { stored = body; },
    syntaxValidate: () => ({ ok: true }),
  });
  assert.equal(out.code, 'write_noop');
  assert.equal(out.noop, true);
});

test('3H30-G-001 spawn failure classified sandbox_spawn not hang', () => {
  const err = new Error('spawn python3 missing');
  err.code = 'ENOENT';
  const out = corr.classifySandboxSpawn(err);
  assert.equal(out.code, 'sandbox_spawn');
  assert.equal(out.retryable, true);
});

test('3H30-G-002 orphan tmp reaper sweeps leftover dirs older than TTL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-root-'));
  const old = path.join(dir, 'siragpt-sandbox-old');
  fs.mkdirSync(old);
  const past = Date.now() - 60 * 60 * 1000;
  fs.utimesSync(old, past / 1000, past / 1000);
  const out = corr.orphanTmpReaperOnStart({ tmpDir: dir, now: Date.now(), maxAgeMs: 10 * 60 * 1000 });
  assert.ok(out.swept.some((item) => item === old));
  assert.equal(fs.existsSync(old), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('3H30-H-001 SSE replay skips already delivered ids', () => {
  const frames = [
    { seq: 1, type: 'a' },
    { seq: 2, type: 'b' },
    { seq: 2, type: 'b-dup' },
    { seq: 3, type: 'c' },
  ];
  const out = corr.sseIdempotentReplay(frames, 2);
  assert.equal(out.frames.length, 1);
  assert.equal(out.frames[0].seq, 3);
  assert.equal(out.code, 'sse_duplicate');
  assert.ok(out.duplicates >= 1);
});

test('3H30-H-002 tool heartbeat tags inflight tool', () => {
  const beats = [];
  const hb = corr.startToolHeartbeat((f) => beats.push(f), {
    intervalMs: 10_000,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });
  hb.beat();
  hb.stop();
  assert.equal(beats[0].inflight, 'tool');
  assert.equal(beats[0].type, 'heartbeat');
  const tagged = corr.tagHeartbeatInflight({}, 'tool');
  assert.equal(tagged.inflight, 'tool');
});

test('3H30-I-001 out-of-order frames buffer then flush in seq', () => {
  const seq = corr.createFrameSequencer(0);
  const a = seq.push({ seq: 2, type: 'two' });
  assert.equal(a.flushed.length, 0);
  const b = seq.push({ seq: 1, type: 'one' });
  assert.equal(b.flushed.length, 2);
  assert.equal(b.flushed[0].seq, 1);
  assert.equal(b.flushed[1].seq, 2);
});

test('3H30-I-002 nack gap when client asks for a missing id', () => {
  const out = corr.nackGap([{ seq: 1 }, { seq: 2 }], 0, 5);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'sse_gap');
  assert.deepEqual(out.missing, [5]);
  assert.equal(out.nack, true);
});

test('3H30-J-001 HTTP 5xx without usage object releases hold and does not settle used', () => {
  let released = 0;
  let settled = 0;
  const hold = {
    settle(u) { settled += u; return { ok: true, leftover: 0 }; },
    release() { released += 1; return { ok: true, released: 80 }; },
  };
  const out = corr.creditOnLlmFailure({ status: 503, message: 'unavailable' }, hold);
  assert.equal(out.code, 'credit_no_usage');
  assert.equal(out.settle, false);
  assert.equal(out.used, 0);
  assert.equal(out.releaseHold, true);
  assert.equal(released, 1);
  assert.equal(settled, 0);
});

test('3H30-J-002 HTTP 5xx WITH usage object still settles', () => {
  const out = corr.creditOnLlmFailure({ status: 500, usage: { prompt_tokens: 10, completion_tokens: 2 } }, null);
  assert.equal(out.settle, true);
  assert.equal(out.code, null);
});

test('3H30-J-003 extractUsageOrRelease on 502 without usage is credit_no_usage', () => {
  const out = corr.extractUsageOrRelease({ status: 502 }, null);
  assert.equal(out.code, 'credit_no_usage');
  assert.equal(out.promptTokens, 0);
  assert.equal(out.settle, false);
});

test('3H30-K-001 public ES codes for 3H30', () => {
  const codes = [
    'turn_superseded', 'tool_unknown', 'dag_cycle', 'write_noop',
    'sandbox_spawn', 'sse_duplicate', 'credit_no_usage',
  ];
  for (const c of codes) {
    const cl = corr.classifyCorrectnessError(c);
    assert.ok(cl, c);
    assert.equal(cl.code, c);
    assert.ok(cl.message && !/at Object\.|Error:|stack/i.test(cl.message), c);
  }
});

test('3H30-K-002 correctnessSnapshot flags', () => {
  const s = corr.correctnessSnapshot();
  assert.equal(s.turnSuperseded, true);
  assert.equal(s.dagCycle, true);
  assert.equal(s.writeNoop, true);
  assert.equal(s.sandboxSpawn, true);
  assert.equal(s.sseIdempotentReplay, true);
  assert.equal(s.creditNoUsage, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.sandboxUsesRunsc, false);
  assert.equal(s.interpreter, 'local');
});

test('3H30-L-001 live loop.js wires correctness', () => {
  const src = read('src/services/agent-runner/loop.js');
  assert.match(src, /engine-correctness/);
  assert.match(src, /capToolResultWithHash|resolveUnknownTool/);
  assert.match(src, /startToolHeartbeat|creditOnLlmFailure|extractUsageOrRelease/);
  assert.match(src, /stopWhenParentExhausted|compactKeepLastToolErrors/);
});

test('3H30-L-002 live chat index uses cancellable gate', () => {
  const src = read('src/services/agent-runner/index.js');
  assert.match(src, /engine-correctness/);
  assert.match(src, /getSharedCancelGate|createCancellableSessionGate/);
});

test('3H30-L-003 live code agent-loop and react-agent wire correctness', () => {
  const loop = read('src/services/codex/agent-loop.js');
  assert.match(loop, /engine-correctness/);
  const react = read('src/services/react-agent.js');
  assert.match(react, /engine-correctness/);
  assert.match(react, /resolveUnknownTool|capToolResultWithHash|creditOnLlmFailure|extractUsageOrRelease/);
});

test('3H30-L-004 live DAG write retrieve sandbox sse codes', () => {
  const completion = read('src/services/agent-runner/engine-completion.js');
  assert.match(completion, /detectDagCycle|dag_cycle|engine-correctness/);
  const integ = read('src/services/agent-runner/engine-integrity.js');
  assert.match(integ, /write_noop|readAfterWriteCompare|retrieveSkipExpiredPins|filterMemoryAclNamespace/);
  const sandbox = read('src/services/sandbox/local-sandbox.js');
  assert.match(sandbox, /sandbox_spawn/);
  assert.match(sandbox, /orphanTmpReaperOnStart|engine-correctness/);
  const sse = read('src/utils/sse-writer.js');
  assert.match(sse, /sseIdempotentReplay|engine-correctness/);
  const codes = read('src/services/error_codes.js');
  assert.match(codes, /TURN_SUPERSEDED: 'turn_superseded'/);
  assert.match(codes, /TOOL_UNKNOWN: 'tool_unknown'/);
  assert.match(codes, /DAG_CYCLE: 'dag_cycle'/);
  assert.match(codes, /WRITE_NOOP: 'write_noop'/);
  assert.match(codes, /SANDBOX_SPAWN: 'sandbox_spawn'/);
  assert.match(codes, /SSE_DUPLICATE: 'sse_duplicate'/);
  assert.match(codes, /CREDIT_NO_USAGE: 'credit_no_usage'/);
  const pub = read('src/services/observability/public-stream-error.js');
  assert.match(pub, /turn_superseded/);
  assert.match(pub, /dag_cycle/);
  assert.match(pub, /write_noop/);
  assert.match(pub, /credit_no_usage/);
  const health = read('src/services/observability/health-check.js');
  assert.match(health, /engine-correctness/);
  assert.match(health, /correctnessSnapshot/);
});

test('3H30-L-005 live gateway nack gap plus cancel and durability atomic ckpt', () => {
  const q = read('src/services/agent-gateway/queue.js');
  assert.match(q, /engine-correctness/);
  const dur = read('src/services/agent-runner/engine-durability.js');
  assert.match(dur, /atomicCheckpointWrite|engine-correctness/);
  const rel = read('src/services/agent-runner/engine-reliability.js');
  assert.match(rel, /classifyCorrectnessError|engine-correctness/);
});

test('3H30-L-006 DeepSeek lock and no invented secrets in correctness', () => {
  const src = read('src/services/agent-runner/engine-correctness.js');
  assert.match(src, /openrouterGenerate: false/);
  assert.doesNotMatch(src, /SIRAGPT_WEBHOOK_HMAC_SECRET\s*=/);
  assert.doesNotMatch(src, /usesRunsc:\s*true/);
  const snap = corr.correctnessSnapshot();
  assert.equal(snap.openrouterGenerate, false);
});

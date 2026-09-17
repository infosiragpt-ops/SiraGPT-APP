'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-runtime.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const runtime = require('../src/services/agent-runner/engine-runtime');

test('3H26-A-001 emitStreamChunk streams stdout', () => {
  const chunks = [];
  const state = { seen: 0, startedAt: Date.now() - 1000, maxBytes: 1024 };
  const out = runtime.emitStreamChunk((t, s) => chunks.push([t, s]), 'hello', 'stdout', state);
  assert.equal(out.emitted, true);
  assert.equal(chunks[0][0], 'hello');
  assert.equal(chunks[0][1], 'stdout');
});

test('3H26-A-002 emitStreamChunk caps and flags sandbox_stream', () => {
  const state = { seen: 64, startedAt: Date.now() - 1000, maxBytes: 64 };
  const out = runtime.emitStreamChunk(() => {}, 'more', 'stdout', state);
  assert.equal(out.emitted, false);
  assert.equal(out.truncated, true);
  assert.equal(out.code, 'sandbox_stream');
});

test('3H26-A-003 emitStreamChunk swallows onChunk throw', () => {
  const state = { seen: 0, startedAt: Date.now() - 1000, maxBytes: 1024 };
  const out = runtime.emitStreamChunk(() => { throw new Error('ui'); }, 'x', 'stderr', state);
  assert.equal(out.emitted, true);
});

test('3H26-A-004 killProcessTree uses negative pid on unix', () => {
  const seen = [];
  const out = runtime.killProcessTree(4242, {
    platform: 'linux',
    kill: (id, sig) => { seen.push([id, sig]); return true; },
  });
  assert.equal(out.ok, true);
  assert.equal(out.code, 'pg_killed');
  assert.equal(seen[0][0], -4242);
  assert.equal(seen[0][1], 'SIGKILL');
});

test('3H26-A-005 shouldForceSettle after grace', () => {
  const now = 10_000;
  const early = runtime.shouldForceSettle({ killedAt: 9_800, now, graceMs: 1500, closed: false });
  assert.equal(early.settle, false);
  const late = runtime.shouldForceSettle({ killedAt: 8_000, now, graceMs: 1500, closed: false });
  assert.equal(late.settle, true);
  assert.equal(late.code, 'sandbox_reap');
});

test('3H26-A-006 reapAfterKill splits alive vs gone', () => {
  const out = runtime.reapAfterKill([1, 2, 3], { exists: (pid) => pid === 2 });
  assert.deepEqual(out.alive, [2]);
  assert.deepEqual(out.reaped, [1, 3]);
  assert.equal(out.code, 'sandbox_reap');
});

test('3H26-A-007 scrubSandboxEnv drops secrets', () => {
  const out = runtime.scrubSandboxEnv({
    PATH: '/bin',
    DEEPSEEK_API_KEY: 'sk-secret',
    OPENROUTER_API_KEY: 'or-secret',
    LANG: 'C.UTF-8',
    HOME: '/tmp',
  });
  assert.equal(out.PATH, '/bin');
  assert.equal(out.DEEPSEEK_API_KEY, undefined);
  assert.equal(out.OPENROUTER_API_KEY, undefined);
  assert.equal(out.NODE_OPTIONS, '');
});

test('3H26-A-008 guaranteedDestroy times out', async () => {
  const out = await runtime.guaranteedDestroy({
    destroy: () => new Promise((resolve) => {
      const t = setTimeout(resolve, 30_000);
      if (t && typeof t.unref === 'function') t.unref();
    }),
  }, { timeoutMs: 40 });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'sandbox_cleanup');
});

test('3H26-B-001 waitDrainWithTimeout times out', async () => {
  const out = await runtime.waitDrainWithTimeout({
    writeOk: false,
    timeoutMs: 30,
    onDrain: () => {},
  });
  assert.equal(out.timedOut, true);
  assert.equal(out.code, 'sse_drain_timeout');
});

test('3H26-B-002 waitDrainWithTimeout resolves immediately when writable', async () => {
  const out = await runtime.waitDrainWithTimeout({ writeOk: true });
  assert.equal(out.ok, true);
  assert.equal(out.drained, true);
});

test('3H26-B-003 orphan hub drains then aborts producer', () => {
  const hub = runtime.createOrphanHub();
  let aborted = false;
  const emitted = [];
  hub.attach('s1', () => { aborted = true; });
  const out = hub.drain('s1', {
    frames: [{ seq: 1 }, { seq: 2 }],
    emit: (f) => emitted.push(f.seq),
    close: () => {},
  });
  assert.equal(out.code, 'sse_orphan');
  assert.equal(aborted, true);
  assert.deepEqual(emitted, [1, 2]);
  assert.equal(hub.size(), 0);
});

test('3H26-B-004 replayFromSeq skips already-acked frames', () => {
  const out = runtime.replayFromSeq([
    { seq: 1, type: 'a' },
    { seq: 2, type: 'b' },
    { seq: 4, type: 'c' },
  ], 2);
  assert.equal(out.count, 1);
  assert.equal(out.frames[0].type, 'c');
  assert.equal(out.code, 'sse_resume');
  assert.equal(out.nextSeq, 4);
});

test('3H26-B-005 heartbeatDue skips backpressure and closed', () => {
  const bp = runtime.heartbeatDue({ closed: false, writable: true, backpressured: true, lastWriteAt: 0, now: 99999 });
  assert.equal(bp.emit, false);
  assert.equal(bp.code, 'sse_backpressure');
  const closed = runtime.heartbeatDue({ closed: true, writable: true, backpressured: false, lastWriteAt: 0, now: 99999 });
  assert.equal(closed.emit, false);
  const due = runtime.heartbeatDue({ closed: false, writable: true, backpressured: false, lastWriteAt: 0, now: 99999, minGapMs: 1000 });
  assert.equal(due.emit, true);
  assert.equal(due.code, 'sse_heartbeat');
});

test('3H26-B-006 pushRing drops oldest on overflow', () => {
  const out = runtime.pushRing([1, 2, 3, 4], 5, 3);
  assert.equal(out.truncated, true);
  assert.equal(out.code, 'sse_backpressure');
  assert.deepEqual(out.frames, [3, 4, 5]);
  assert.equal(out.dropped, 2);
});

test('3H26-C-001 makeQueueJob stamps per-job enqueuedAt', () => {
  const out = runtime.makeQueueJob({ sessionKey: 's1', idempotencyKey: 'a', enqueuedAt: 42 });
  assert.equal(out.ok, true);
  assert.equal(out.job.sessionKey, 's1');
  assert.equal(out.job.enqueuedAt, 42);
  assert.equal(out.job.cancelled, false);
});

test('3H26-C-002 jobMayRun expires lease', () => {
  const job = runtime.makeQueueJob({ sessionKey: 's1', enqueuedAt: 0 }).job;
  const out = runtime.jobMayRun(job, 200_000, 120_000);
  assert.equal(out.run, false);
  assert.equal(out.code, 'queue_lease');
});

test('3H26-C-003 jobMayRun honors cancel flag', () => {
  const job = runtime.makeQueueJob({ sessionKey: 's1', enqueuedAt: Date.now() }).job;
  job.cancelled = true;
  const out = runtime.jobMayRun(job, Date.now());
  assert.equal(out.run, false);
  assert.equal(out.code, 'queue_cancel');
});

test('3H26-C-004 cancelPendingJobs cancels all waiting not running', () => {
  const jobs = [
    { id: 'a', sessionKey: 's1', running: false, cancelled: false },
    { id: 'b', sessionKey: 's1', running: true, cancelled: false },
    { id: 'c', sessionKey: 's1', running: false, cancelled: false },
  ];
  const out = runtime.cancelPendingJobs(jobs, { sessionKey: 's1', all: true });
  assert.equal(out.cancelled, 2);
  assert.equal(out.remaining.length, 1);
  assert.equal(out.remaining[0].id, 'b');
  assert.equal(jobs[0].cancelled, true);
  assert.equal(jobs[1].cancelled, false);
});

test('3H26-C-005 cancelPendingJobs can target one job', () => {
  const jobs = [
    { id: 'a', sessionKey: 's1', running: false, cancelled: false },
    { id: 'c', sessionKey: 's1', running: false, cancelled: false },
  ];
  const out = runtime.cancelPendingJobs(jobs, { sessionKey: 's1', jobId: 'c', all: false });
  assert.equal(out.cancelled, 1);
  assert.equal(jobs[1].cancelled, true);
  assert.equal(jobs[0].cancelled, false);
});

test('3H26-C-006 pickFairReady round-robin', () => {
  const a = runtime.pickFairReady(['s1', 's2', 's3'], null);
  assert.equal(a.session, 's1');
  const b = runtime.pickFairReady(['s1', 's2', 's3'], 's1');
  assert.equal(b.session, 's2');
  const c = runtime.pickFairReady(['s1', 's2', 's3'], 's3');
  assert.equal(c.session, 's1');
  assert.equal(c.code, 'queue_fairness');
});

test('3H26-D-001 first-byte p50/p95 without DeepSeek', () => {
  runtime.resetRuntimeFirstByte();
  runtime.observeRuntimeFirstByte(10);
  runtime.observeRuntimeFirstByte(20);
  runtime.observeRuntimeFirstByte(40);
  const snap = runtime.snapshotRuntimeFirstByte();
  assert.equal(snap.count, 3);
  assert.equal(snap.p50, 20);
  assert.ok(snap.p95 >= 20);
  runtime.resetRuntimeFirstByte();
});

test('3H26-D-002 runtimeSnapshot flags', () => {
  const snap = runtime.runtimeSnapshot();
  assert.equal(snap.sandboxStream, true);
  assert.equal(snap.sandboxReap, true);
  assert.equal(snap.sandboxCleanup, true);
  assert.equal(snap.sseDrainTimeout, true);
  assert.equal(snap.sseOrphanHub, true);
  assert.equal(snap.sseResumeReplay, true);
  assert.equal(snap.queueJobLease, true);
  assert.equal(snap.queueCancelAll, true);
  assert.equal(snap.queueFairPick, true);
  assert.equal(snap.interpreter, 'local');
  assert.equal(snap.openrouterGenerate, false);
});

test('3H26-E-001 live sandbox.js streams onChunk and force-settles', () => {
  const src = read('src/services/doc-agent/sandbox.js');
  assert.match(src, /onChunk/);
  assert.match(src, /engine-runtime/);
  assert.match(src, /shouldForceSettle/);
  assert.match(src, /emitStreamChunk/);
  assert.match(src, /guaranteedDestroy/);
});

test('3H26-E-002 tools.js forwards onChunk into sandbox.exec', () => {
  const src = read('src/services/agent-runner/tools.js');
  assert.match(src, /onChunk: ctx\.onChunk/);
  assert.doesNotMatch(src, /ctx\.onChunk\(r\.stdout/);
});

test('3H26-E-003 local-sandbox process group + env scrub', () => {
  const src = read('src/services/sandbox/local-sandbox.js');
  assert.match(src, /detached:/);
  assert.match(src, /scrubSandboxEnv/);
  assert.match(src, /killProcessTree/);
  assert.match(src, /emitStreamChunk/);
});

test('3H26-E-004 sse-writer drain timeout + orphan + first byte', () => {
  const src = read('src/utils/sse-writer.js');
  assert.match(src, /waitDrainWithTimeout/);
  assert.match(src, /orphanHub/);
  assert.match(src, /observeRuntimeFirstByte/);
  assert.match(src, /heartbeatDue/);
});

test('3H26-E-005 queue per-job lease and cancel-all', () => {
  const src = read('src/services/agent-gateway/queue.js');
  assert.match(src, /makeQueueJob/);
  assert.match(src, /jobMayRun/);
  assert.match(src, /cancelPendingJobs/);
  assert.match(src, /pickFairReady/);
  assert.match(src, /assertJobRunnable/);
});

test('3H26-F-001 error codes 3H26', () => {
  const { CODES } = require('../src/services/error_codes');
  assert.equal(CODES.SANDBOX_STREAM, 'sandbox_stream');
  assert.equal(CODES.SANDBOX_REAP, 'sandbox_reap');
  assert.equal(CODES.SANDBOX_CLEANUP, 'sandbox_cleanup');
  assert.equal(CODES.SSE_DRAIN_TIMEOUT, 'sse_drain_timeout');
  assert.equal(CODES.SSE_HEARTBEAT, 'sse_heartbeat');
  assert.equal(CODES.QUEUE_FAIRNESS, 'queue_fairness');
});

test('3H26-F-002 public stream errors include 3H26 codes', () => {
  const src = read('src/services/observability/public-stream-error.js');
  assert.match(src, /sandbox_stream/);
  assert.match(src, /sandbox_reap/);
  assert.match(src, /sse_drain_timeout/);
  assert.match(src, /queue_fairness/);
});

test('3H26-F-003 health-check reports runtime flags', () => {
  const src = read('src/services/observability/health-check.js');
  assert.match(src, /engine-runtime/);
  assert.match(src, /sandboxStream/);
  assert.match(src, /sseDrainTimeout/);
  assert.match(src, /queueJobLease/);
});

test('3H26-X-001 no openrouter.ai in engine-runtime or patched cores', () => {
  for (const rel of [
    'src/services/agent-runner/engine-runtime.js',
    'src/services/doc-agent/sandbox.js',
    'src/utils/sse-writer.js',
    'src/services/agent-gateway/queue.js',
  ]) {
    assert.doesNotMatch(read(rel), /openrouter\.ai/i);
  }
});

test('3H26-X-002 chat_run_worker stays dormant (no CHAT_RUN_QUEUE_ENABLED invent)', () => {
  const src = read('src/services/observability/health-check.js');
  assert.match(src, /dormant_ok/);
  const runtimeSrc = read('src/services/agent-runner/engine-runtime.js');
  assert.doesNotMatch(runtimeSrc, /CHAT_RUN_QUEUE_ENABLED\s*=\s*1/);
});

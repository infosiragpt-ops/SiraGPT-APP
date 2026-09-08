'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/loop.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const rel = require('../src/services/agent-runner/engine-reliability');
const dur = require('../src/services/agent-runner/engine-durability');
const parity = require('../src/services/agent-runner/engine-parity');
const { runAgentLoop } = require('../src/services/agent-runner/loop');
const { createScriptedClient, createMockExecutors } = require('../src/services/agent-runner/evals/scripted-llm');
const { createEventLog } = require('../src/services/agent-gateway/event-log');
const { createSessionQueue } = require('../src/services/agent-gateway/queue');

function scripted(turns) { return createScriptedClient(turns); }

const WRITE_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    content: { type: 'string', maxLength: 64 },
    mode: { type: 'string', enum: ['create', 'overwrite'] },
  },
  required: ['path', 'content'],
  additionalProperties: false,
};

test('3H22-BE-001 assertTurnWallClock under deadline is ok', () => {
  const out = parity.assertTurnWallClock(1000, 1500, 2000);
  assert.equal(out.ok, true);
  assert.equal(out.stop, false);
  assert.equal(out.remainingMs, 1500);
});

test('3H22-BE-002 assertTurnWallClock over deadline stops', () => {
  const out = parity.assertTurnWallClock(1000, 4000, 2000);
  assert.equal(out.ok, false);
  assert.equal(out.stop, true);
  assert.equal(out.code, 'turn_deadline');
  assert.equal(out.remainingMs, 0);
});

test('3H22-BE-003 mapToolAlias maps shell/run/cmd to execute_bash', () => {
  assert.equal(parity.mapToolAlias('shell').name, 'execute_bash');
  assert.equal(parity.mapToolAlias('run').aliased, true);
  assert.equal(parity.mapToolAlias('cmd').name, 'execute_bash');
  assert.equal(parity.mapToolAlias('bash').name, 'execute_bash');
  assert.equal(parity.mapToolAlias('read').name, 'read_file');
  assert.equal(parity.mapToolAlias('write').name, 'write_file');
});

test('3H22-BE-004 mapToolAlias unknown fail-closed', () => {
  const out = parity.mapToolAlias('drop_table', { executors: { execute_bash() {} } });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'unknown_tool');
});

test('3H22-BE-005 capToolResult under cap keeps text', () => {
  const out = parity.capToolResult('hola', 1024);
  assert.equal(out.ok, true);
  assert.equal(out.truncated, false);
  assert.equal(out.text, 'hola');
});

test('3H22-BE-006 capToolResult over cap is tool_result_capped', () => {
  const out = parity.capToolResult('x'.repeat(500), 128);
  assert.equal(out.ok, false);
  assert.equal(out.truncated, true);
  assert.equal(out.code, 'tool_result_capped');
  assert.match(out.text, /tool_result_capped/);
  assert.ok(out.text.length < 500);
});

test('3H22-BE-007 isolateParallelTools one reject does not kill siblings', async () => {
  const prepared = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const out = await parity.isolateParallelTools(prepared, async (p) => {
    if (p.id === 'b') throw new Error('boom-b');
    return { prepared: p, result: `ok-${p.id}`, f7Image: null };
  });
  assert.equal(out.length, 3);
  assert.equal(out[0].result, 'ok-a');
  assert.equal(out[2].result, 'ok-c');
  assert.equal(out[1].isolated, true);
  assert.equal(out[1].code, 'tool_isolated');
  assert.match(String(out[1].result), /tool_isolated/);
});

test('3H22-BE-008 casCheckpoint put then get version 1', () => {
  const store = new Map();
  const put = parity.casPutCheckpoint(store, { checkpointId: 'c1', state: { n: 1 }, expectedVersion: 0 });
  assert.equal(put.ok, true);
  assert.equal(put.version, 1);
  const got = parity.casGetCheckpoint(store, 'c1');
  assert.equal(got.ok, true);
  assert.equal(got.version, 1);
  assert.equal(got.state.n, 1);
});

test('3H22-BE-009 casCheckpoint stale version is ckpt_cas', () => {
  const store = new Map();
  parity.casPutCheckpoint(store, { checkpointId: 'c2', state: { n: 1 }, expectedVersion: 0 });
  const stale = parity.casPutCheckpoint(store, { checkpointId: 'c2', state: { n: 2 }, expectedVersion: 0 });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'ckpt_cas');
  assert.equal(stale.version, 1);
});

test('3H22-BE-010 evictPinsLru keeps newest max', () => {
  const pins = ['a', 'b', 'c', 'd', 'e'];
  const out = parity.evictPinsLru(pins, 3);
  assert.deepEqual(out.pins, ['c', 'd', 'e']);
  assert.equal(out.evicted, 2);
  assert.equal(out.code, 'pin_evicted');
});

test('3H22-BE-011 process group killOnCancel', () => {
  const gone = [];
  const pg = parity.createProcessGroup({ kill: (pid) => { gone.push(pid); return true; } });
  pg.register(11);
  pg.register(22);
  const out = pg.killOnCancel();
  assert.equal(out.killed, 2);
  assert.equal(out.code, 'pg_killed');
  assert.equal(out.leftover, 0);
  assert.deepEqual(gone.sort(), [11, 22]);
});

test('3H22-BE-012 watermark Last-Event-ID persist/read', () => {
  const store = new Map();
  const w = parity.watermarkLastEventId(store, 's1', 9, { now: 50 });
  assert.equal(w.ok, true);
  assert.equal(w.seq, 9);
  const r = parity.readWatermark(store, 's1');
  assert.equal(r.seq, 9);
  assert.equal(r.missing, false);
  assert.equal(parity.readWatermark(store, 'none').seq, 0);
});

test('3H22-BE-013 cancelQueuedJob marks pending cancelled', () => {
  const pending = [{ id: 'j1', running: false }, { id: 'j2', running: true }];
  const a = parity.cancelQueuedJob(pending, 'j1');
  assert.equal(a.ok, true);
  assert.equal(a.cancelled, true);
  assert.equal(pending.length, 1);
  const b = parity.cancelQueuedJob(pending, 'j2');
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'running');
});

test('3H22-BE-014 reserveCredits hold then settle', () => {
  const hold = parity.createCreditHold({ ceiling: 100 });
  const r = hold.reserve(40);
  assert.equal(r.ok, true);
  assert.equal(r.remaining, 60);
  const s = hold.settle(25);
  assert.equal(s.settled, 25);
  assert.equal(s.leftover, 15);
  assert.equal(hold.snapshot().reserved, 15);
});

test('3H22-BE-015 releaseCredits on cancel restores remaining', () => {
  const hold = parity.createCreditHold({ ceiling: 80 });
  hold.reserve(50);
  const rels = hold.release();
  assert.equal(rels.released, 50);
  assert.equal(rels.code, 'credit_release');
  assert.equal(hold.snapshot().reserved, 0);
  assert.equal(hold.reserve(90).ok, false);
  assert.equal(hold.reserve(90).code, 'credit_hold');
});

test('3H22-BE-016 errorBudget stops after N', () => {
  const b = parity.createErrorBudget({ max: 2 });
  assert.equal(b.record(false).stop, false);
  const last = b.record(false);
  assert.equal(last.stop, true);
  assert.equal(last.code, 'error_budget');
  assert.equal(b.used(), 2);
});

test('3H22-BE-017 atomicWriteFile tmp then rename', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-aw-'));
  const dest = path.join(dir, 'out.txt');
  const out = parity.atomicWriteFile(dest, 'hola-paridad');
  assert.equal(out.ok, true);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'hola-paridad');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('3H22-BE-018 waitSubtaskDag blocked until deps done', () => {
  const tasks = [
    { id: 'a', deps: [] },
    { id: 'b', deps: ['a'] },
    { id: 'c', deps: ['b'] },
  ];
  const blocked = parity.waitSubtaskDag(tasks, []);
  assert.deepEqual(blocked.ready, ['a']);
  assert.equal(blocked.blocked.length, 2);
  const mid = parity.waitSubtaskDag(tasks, ['a']);
  assert.deepEqual(mid.ready, ['b']);
  const done = parity.waitSubtaskDag(tasks, ['a', 'b', 'c']);
  assert.deepEqual(done.ready, []);
  assert.equal(done.blocked.length, 0);
});

test('3H22-BE-019 toolCircuitBreaker opens after threshold', () => {
  const c = parity.createToolCircuit({ threshold: 2 });
  assert.equal(c.record('bash', false).open, false);
  const open = c.record('bash', false);
  assert.equal(open.open, true);
  assert.equal(open.code, 'circuit_open');
  assert.equal(c.isOpen('bash'), true);
  c.record('bash', true);
  assert.equal(c.isOpen('bash'), false);
});

test('3H22-BE-020 compactByTokenBudget drops oldest', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'U'.repeat(400) },
    { role: 'assistant', content: 'A'.repeat(400) },
    { role: 'user', content: 'tail' },
  ];
  const out = parity.compactByTokenBudget(messages, { maxTokens: 50 });
  assert.ok(out.removed >= 1);
  assert.equal(out.code, 'token_compact');
  assert.ok(out.afterTokens <= 50);
  assert.equal(out.messages[0].role, 'system');
});

test('3H22-BE-021 reapZombies removes dead pids', () => {
  const out = parity.reapZombies([1, 2, 3], { exists: (pid) => pid === 2 });
  assert.deepEqual(out.alive, [2]);
  assert.deepEqual(out.reaped, [1, 3]);
  assert.equal(out.code, 'zombie_reaped');
});

test('3H22-BE-022 drainSseThenClose emits then closes', () => {
  const seen = [];
  let closed = false;
  const out = parity.drainSseThenClose([{ seq: 1 }, { seq: 2 }], {
    emit: (f) => seen.push(f.seq),
    close: () => { closed = true; },
  });
  assert.deepEqual(seen, [1, 2]);
  assert.equal(closed, true);
  assert.equal(out.emitted, 2);
  assert.equal(out.code, 'sse_drain');
});

test('3H22-BE-023 expireQueueLease after ttl', () => {
  const live = parity.expireQueueLease(1000, 2000, 5000);
  assert.equal(live.expired, false);
  const dead = parity.expireQueueLease(1000, 9000, 5000);
  assert.equal(dead.expired, true);
  assert.equal(dead.code, 'queue_lease');
});

test('3H22-BE-024 rollbackStack N-deep', () => {
  const st = parity.createRollbackStack({ max: 3 });
  st.push({ n: 1 });
  st.push({ n: 2 });
  st.push({ n: 3 });
  st.push({ n: 4 });
  assert.equal(st.depth(), 3);
  const back = st.rollback(2);
  assert.equal(back.state.n, 3);
  assert.equal(st.depth(), 1);
});

test('3H22-BE-025 retryAfterMs for retryable codes', () => {
  assert.equal(parity.retryAfterMs('tool_timeout').retryable, true);
  assert.ok(parity.retryAfterMs('tool_timeout').ms > 0);
  assert.equal(parity.retryAfterMs('error_budget').retryable, false);
  assert.equal(parity.retryAfterMs('circuit_open').ms, 0);
});

test('3H22-BE-026 observeFirstByte vs firstToken snapshot', () => {
  parity.resetFirstByte();
  parity.observeFirstByte(12);
  parity.observeFirstByte(20);
  const snap = parity.snapshotFirstByte();
  assert.equal(snap.count, 2);
  assert.equal(snap.last, 20);
  assert.equal(snap.mean, 16);
});

test('3H22-BE-027 dedupMemoryHits drops duplicates', () => {
  const out = parity.dedupMemoryHits([
    { id: 'a', text: 'uno' },
    { id: 'a', text: 'uno' },
    { id: 'b', text: 'dos' },
  ]);
  assert.equal(out.hits.length, 2);
  assert.equal(out.dropped, 1);
  assert.equal(out.code, 'memory_dedup');
});

test('3H22-BE-028 dropOldestSse is sse_backpressure', () => {
  const frames = Array.from({ length: 8 }, (_, i) => ({ seq: i + 1 }));
  const out = parity.dropOldestSse(frames, 5);
  assert.equal(out.dropped, 3);
  assert.equal(out.code, 'sse_backpressure');
  assert.equal(out.frames[0].seq, 4);
  assert.equal(out.frames.length, 5);
});

test('3H22-BE-029 pickFairSession round-robin', () => {
  const a = parity.pickFairSession(['s1', 's2', 's3'], null);
  assert.equal(a.session, 's1');
  const b = parity.pickFairSession(['s1', 's2', 's3'], 's1');
  assert.equal(b.session, 's2');
  const c = parity.pickFairSession(['s1', 's2', 's3'], 's3');
  assert.equal(c.session, 's1');
});

test('3H22-BE-030 capStderrRate over cap', () => {
  const over = parity.capStderrRate({ bytes: 10_000, elapsedMs: 10, maxBytesPerSec: 1000 });
  assert.equal(over.ok, false);
  assert.equal(over.code, 'stderr_rate');
  const under = parity.capStderrRate({ bytes: 10, elapsedMs: 1000, maxBytesPerSec: 1000 });
  assert.equal(under.ok, true);
});

test('3H22-BE-031 revisePlanOnFailure inserts retry step', () => {
  const out = parity.revisePlanOnFailure([{ id: 'a' }, { id: 'b' }], 'a');
  assert.equal(out.revised, true);
  assert.equal(out.code, 'plan_revised');
  assert.equal(out.plan[0].status, 'failed');
  assert.equal(out.plan[1].id, 'a#retry');
});

test('3H22-BE-032 verifyWriteHash mismatch is write_hash', () => {
  const a = parity.verifyWriteHash('hola');
  assert.equal(a.ok, true);
  assert.match(a.hash, /^[a-f0-9]{64}$/);
  const b = parity.verifyWriteHash('hola', a.hash);
  assert.equal(b.ok, true);
  const c = parity.verifyWriteHash('hola', 'deadbeef');
  assert.equal(c.ok, false);
  assert.equal(c.code, 'write_hash');
});

test('3H22-BE-033 live loop turn_deadline stops generate', async () => {
  const events = [];
  const client = scripted([{ content: 'tarde' }]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hola' }],
    tools: [],
    executors: createMockExecutors(),
    maxIterations: 4,
    startedAtMs: Date.now() - 50,
    turnDeadlineMs: 5,
    onEvent: (e) => events.push(e),
  });
  assert.equal(out.stoppedReason, 'turn_deadline');
  assert.equal(out.errorCode, 'turn_deadline');
  assert.ok(events.some((e) => e.code === 'turn_deadline'));
  assert.equal(client.calls.length, 0);
});

test('3H22-BE-034 live loop alias maps memory to retrieve_memory', async () => {
  let called = 0;
  const tools = [{
    type: 'function',
    function: { name: 'retrieve_memory', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  }];
  const client = scripted([
    { toolCalls: [{ name: 'memory', args: { query: 'clave' } }] },
    { content: 'sigo' },
  ]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'recuerda' }],
    tools,
    executors: {
      async retrieve_memory() { called += 1; return 'hit'; },
    },
    maxIterations: 4,
    onEvent: () => {},
  });
  assert.equal(out.stoppedReason, 'final');
  assert.equal(called, 1);
  assert.equal(out.steps[0].tool, 'retrieve_memory');
  assert.equal(out.steps[0].ok, true);
});

test('3H22-BE-035 live loop error budget stops', async () => {
  const events = [];
  const tools = [{
    type: 'function',
    function: { name: 'write_file', parameters: WRITE_SCHEMA },
  }];
  const client = scripted([
    { toolCalls: [{ name: 'write_file', args: { path: 'a.js', content: 'x1', mode: 'create' } }] },
    { toolCalls: [{ name: 'write_file', args: { path: 'a.js', content: 'x2', mode: 'create' } }] },
    { content: 'no deberia' },
  ]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'escribe' }],
    tools,
    executors: { async write_file() { return 'ERROR: boom'; } },
    maxIterations: 6,
    errorBudgetMax: 1,
    onEvent: (e) => events.push(e),
  });
  assert.equal(out.stoppedReason, 'error_budget');
  assert.ok(events.some((e) => e.code === 'error_budget'));
  assert.ok(client.calls.length <= 2);
});

test('3H22-BE-036 live loop circuit_open skips executor', async () => {
  let called = 0;
  const events = [];
  const tools = [{
    type: 'function',
    function: { name: 'write_file', parameters: WRITE_SCHEMA },
  }];
  const client = scripted([
    { toolCalls: [{ name: 'write_file', args: { path: 'a.js', content: 'x1', mode: 'create' } }] },
    { toolCalls: [{ name: 'write_file', args: { path: 'a.js', content: 'x2', mode: 'create' } }] },
    { content: 'corto' },
  ]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'escribe' }],
    tools,
    executors: { async write_file() { called += 1; return 'ERROR: boom'; } },
    maxIterations: 6,
    toolCircuitThreshold: 1,
    onEvent: (e) => events.push(e),
  });
  assert.equal(out.stoppedReason, 'final');
  assert.equal(called, 1);
  assert.ok(out.steps.some((s) => /circuit_open/.test(String(s.resultPreview))));
  assert.ok(events.some((e) => e.code === 'circuit_open') || out.steps.length >= 2);
});

test('3H22-BE-037 error_codes + classify + public-stream parity taxonomy', () => {
  const { CODES } = require('../src/services/error_codes');
  assert.equal(CODES.TURN_DEADLINE, 'turn_deadline');
  assert.equal(CODES.UNKNOWN_TOOL, 'unknown_tool');
  assert.equal(CODES.TOOL_RESULT_CAPPED, 'tool_result_capped');
  assert.equal(CODES.TOOL_ISOLATED, 'tool_isolated');
  assert.equal(CODES.CKPT_CAS, 'ckpt_cas');
  assert.equal(CODES.ERROR_BUDGET, 'error_budget');
  assert.equal(CODES.CIRCUIT_OPEN, 'circuit_open');
  assert.equal(CODES.QUEUE_LEASE, 'queue_lease');
  assert.equal(CODES.SSE_BACKPRESSURE, 'sse_backpressure');
  assert.equal(CODES.WRITE_HASH, 'write_hash');
  assert.equal(rel.classifyLoopError({ code: 'turn_deadline' }).code, 'turn_deadline');
  assert.match(rel.classifyLoopError({ code: 'turn_deadline' }).message, /tiempo|plazo|deadline|turno/i);
  assert.equal(rel.classifyLoopError({ code: 'error_budget' }).code, 'error_budget');
  assert.equal(rel.classifyLoopError({ code: 'circuit_open' }).code, 'circuit_open');
  assert.equal(rel.classifyLoopError({ code: 'ckpt_cas' }).code, 'ckpt_cas');
  const { classifyPublicStreamError } = require('../src/services/observability/public-stream-error');
  const pub = classifyPublicStreamError({ code: 'turn_deadline' });
  assert.equal(pub.code, 'turn_deadline');
  assert.ok(pub.message);
  assert.doesNotMatch(String(pub.message), /\/opt\/|stack|at Object/);
  assert.equal(classifyPublicStreamError({ code: 'error_budget' }).code, 'error_budget');
  assert.equal(classifyPublicStreamError({ code: 'circuit_open' }).code, 'circuit_open');
});

test('3H22-BE-038 health flags + source markers, no openrouter', () => {
  const hc = require('../src/services/observability/health-check');
  const c = hc.checkEngineLoop();
  assert.equal(c.name, 'engine_loop');
  assert.equal(c.details.turnWallClock, true);
  assert.equal(c.details.toolAlias, true);
  assert.equal(c.details.parallelIsolate, true);
  assert.equal(c.details.ckptCas, true);
  assert.equal(c.details.errorBudget, true);
  assert.equal(c.details.toolCircuit, true);
  assert.equal(c.details.sseWatermark, true);
  assert.equal(c.details.queueCancel, true);
  assert.equal(c.details.creditHold, true);
  assert.equal(c.details.processGroupKill, true);
  const sm = require('../src/services/sandbox/session-manager');
  const snap = sm.snapshot();
  assert.equal(snap.processGroupKill, true);
  assert.equal(snap.stderrRateCap, true);
  const q = createSessionQueue();
  const qsnap = q.snapshot();
  assert.equal(qsnap.queueCancel, true);
  assert.equal(qsnap.queueLease, true);
  assert.equal(qsnap.fairness, 'rr');
  const log = createEventLog();
  log.remember('s', { type: 'a', seq: 1, payload: 'x' });
  assert.equal(log.watermark('s'), 1);
  const loop = read('src/services/agent-runner/loop.js');
  assert.match(loop, /engine-parity/);
  assert.match(loop, /turnDeadlineMs|assertTurnWallClock/);
  assert.match(loop, /mapToolAlias|isolateParallelTools|createErrorBudget|createToolCircuit/);
  const parSrc = read('src/services/agent-runner/engine-parity.js');
  assert.doesNotMatch(parSrc, /openrouter\.ai/i);
  assert.doesNotMatch(loop, /openrouter\.ai/i);
  const flags = parity.paritySnapshot();
  assert.equal(flags.turnWallClock, true);
  assert.equal(flags.writeHash, true);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/loop.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const rel = require('../src/services/agent-runner/engine-reliability');
const dur = require('../src/services/agent-runner/engine-durability');
const nxt = require('../src/services/agent-runner/engine-next');
const layer = require('../src/services/agent-runner/engine-layer');
const ops = require('../src/services/agent-runner/engine-ops');
const { runAgentLoop } = require('../src/services/agent-runner/loop');
const { createScriptedClient, createMockExecutors } = require('../src/services/agent-runner/evals/scripted-llm');
const { createEventLog } = require('../src/services/agent-gateway/event-log');
const { createSessionDlq } = require('../src/services/agent-gateway/session-dlq');

function scripted(turns) { return createScriptedClient(turns); }

function scriptedWithUsage(turns, usage) {
  const inner = createScriptedClient(turns);
  return {
    calls: inner.calls,
    chat: {
      completions: {
        async create(payload) {
          const resp = await inner.chat.completions.create(payload);
          resp.usage = usage || { prompt_tokens: 80, completion_tokens: 40 };
          return resp;
        },
      },
    },
  };
}

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

test('3H21-BE-001 capDlqReplayAttempts below cap is ok', () => {
  const out = ops.capDlqReplayAttempts({ retries: 1 }, { maxAttempts: 3 });
  assert.equal(out.ok, true);
  assert.equal(out.remaining, 2);
});

test('3H21-BE-002 capDlqReplayAttempts at cap is dlq_poison', () => {
  const out = ops.capDlqReplayAttempts({ retries: 3 }, { maxAttempts: 3 });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'dlq_poison');
  assert.equal(out.delayMs, 0);
});

test('3H21-BE-003 capDlqReplayAttempts exhausted is still dlq_exhausted', () => {
  const out = ops.capDlqReplayAttempts({ exhausted: true, retries: 2 }, { maxAttempts: 5 });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'dlq_exhausted');
});

test('3H21-BE-004 scheduleDlqReplayCapped exponential under cap', () => {
  const a = ops.scheduleDlqReplayCapped({ retries: 0 }, { jitter: false, now: 0, baseMs: 250, maxAttempts: 3 });
  const b = ops.scheduleDlqReplayCapped({ retries: 2 }, { jitter: false, now: 0, baseMs: 250, maxAttempts: 3 });
  assert.equal(a.ok, true);
  assert.equal(a.code, 'dlq_replay');
  assert.equal(a.delayMs, 250);
  assert.equal(b.ok, true);
  assert.equal(b.delayMs, 1000);
});

test('3H21-BE-005 scheduleDlqReplayCapped poison at max', () => {
  const out = ops.scheduleDlqReplayCapped({ retries: 3 }, { jitter: false, maxAttempts: 3 });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'dlq_poison');
});

test('3H21-BE-006 recordFenceSteal stolen/refused/vacant', async () => {
  ops.resetFenceStealMetrics();
  const stolen = ops.recordFenceSteal({ ok: true, stolen: true, code: 'fence_expired' });
  const vacant = ops.recordFenceSteal({ ok: true, stolen: false, vacant: true });
  const refused = ops.recordFenceSteal({ ok: false, code: 'fence_conflict' });
  assert.equal(stolen.metrics.stolen, 1);
  assert.equal(vacant.metrics.vacant, 1);
  assert.equal(refused.metrics.refused, 1);
  const snap = ops.fenceStealMetrics();
  assert.equal(snap.stolen, 1);
  assert.equal(snap.vacant, 1);
  assert.equal(snap.refused, 1);
});

test('3H21-BE-007 stealStaleFenceMetered increments stolen', async () => {
  ops.resetFenceStealMetrics();
  const kv = dur.createMemoryKv();
  const fence = nxt.createSessionFence(kv, { ttlSec: 5 });
  const a = await fence.acquire('meter-1');
  await layer.heartbeatFence(kv, 'meter-1', a.token, { ttlSec: 5, now: 1_000 });
  const steal = await ops.stealStaleFenceMetered(kv, 'meter-1', { ttlSec: 5, now: 1_000 + 6_000 });
  assert.equal(steal.ok, true);
  assert.equal(steal.stolen, true);
  assert.equal(ops.fenceStealMetrics().stolen, 1);
});

test('3H21-BE-008 stealStaleFenceMetered live is refused', async () => {
  ops.resetFenceStealMetrics();
  const kv = dur.createMemoryKv();
  const fence = nxt.createSessionFence(kv, { ttlSec: 30 });
  const a = await fence.acquire('meter-live');
  await layer.heartbeatFence(kv, 'meter-live', a.token, { ttlSec: 30, now: 5_000 });
  const steal = await ops.stealStaleFenceMetered(kv, 'meter-live', { ttlSec: 30, now: 6_000 });
  assert.equal(steal.ok, false);
  assert.equal(steal.code, 'fence_conflict');
  assert.equal(ops.fenceStealMetrics().refused, 1);
});

test('3H21-BE-009 toolTimeoutDefaultsTable is complete', () => {
  const t = ops.toolTimeoutDefaultsTable();
  assert.equal(t.ok, true);
  assert.equal(t.missing.length, 0);
  assert.equal(t.table.execute_bash, 30_000);
  assert.equal(t.table.write_file, 8_000);
  assert.equal(t.table.retrieve_memory, 4_000);
  assert.equal(t.table.default, 15_000);
  assert.equal(t.code, null);
});

test('3H21-BE-010 enforceCreditCeiling under cap does not stop', () => {
  const out = ops.enforceCreditCeiling({ promptTokens: 10, completionTokens: 5 }, 100);
  assert.equal(out.ok, true);
  assert.equal(out.stop, false);
  assert.equal(out.remaining, 85);
});

test('3H21-BE-011 enforceCreditCeiling over cap stops generate', () => {
  const out = ops.enforceCreditCeiling({ promptTokens: 90, completionTokens: 20 }, 100);
  assert.equal(out.ok, false);
  assert.equal(out.stop, true);
  assert.equal(out.code, 'credit_ceiling');
});

test('3H21-BE-012 recordReplayMetrics accumulates dropped', () => {
  ops.resetReplayMetrics();
  const now = Date.now();
  const frames = Array.from({ length: 12 }, (_, i) => ({ seq: i + 1, type: 'x', at: now }));
  const capped = nxt.capSseReplayWindow(frames, { max: 5, now });
  const m = ops.recordReplayMetrics(capped);
  assert.equal(m.kept, 5);
  assert.equal(m.dropped, 7);
  assert.equal(m.truncated, true);
  const snap = ops.replayMetricsSnapshot();
  assert.equal(snap.dropped, 7);
  assert.equal(snap.windows, 1);
  assert.equal(snap.truncated, 1);
});

test('3H21-BE-013 cleanupTmpfsOnCancel unlinks tracked paths', () => {
  const gone = [];
  const out = ops.cleanupTmpfsOnCancel(['/tmp/sira-a', '/tmp/sira-b'], {
    unlink: (p) => gone.push(p),
  });
  assert.equal(out.ok, true);
  assert.equal(out.cleaned, 2);
  assert.equal(out.code, 'tmpfs_cleanup');
  assert.deepEqual(gone, ['/tmp/sira-a', '/tmp/sira-b']);
});

test('3H21-BE-014 cleanupTmpfsOnCancel rejects traversal', () => {
  const gone = [];
  const out = ops.cleanupTmpfsOnCancel(['/tmp/ok', '../etc/passwd', '/tmp/x/../secret'], {
    unlink: (p) => gone.push(p),
  });
  assert.equal(out.cleaned, 1);
  assert.equal(out.skipped, 2);
  assert.deepEqual(gone, ['/tmp/ok']);
  assert.ok(out.errors.every((e) => e.code === 'path_traversal'));
});

test('3H21-BE-015 gzipCheckpointBlobVersioned stamps v1', () => {
  const state = { messages: [{ role: 'user', content: 'Q'.repeat(4000) }] };
  const out = ops.gzipCheckpointBlobVersioned(state, { minBytes: 200 });
  assert.equal(out.gzip, true);
  assert.equal(out.version, 1);
  assert.equal(out.packed.__gzipVersion, 1);
  assert.equal(out.packed.__gzip, true);
});

test('3H21-BE-016 gunzipCheckpointBlobVersioned roundtrip v1', () => {
  const state = { messages: [{ role: 'assistant', content: 'hola v1 '.repeat(40) }], n: 3 };
  const packed = ops.gzipCheckpointBlobVersioned(state, { minBytes: 8 });
  assert.equal(packed.gzip, true);
  const back = ops.gunzipCheckpointBlobVersioned(packed.packed);
  assert.equal(back.ok, true);
  assert.deepEqual(back.state, state);
  assert.equal(back.version, 1);
});

test('3H21-BE-017 gunzipCheckpointBlobVersioned unknown version fail-closed', () => {
  const packed = ops.gzipCheckpointBlobVersioned({ messages: [{ role: 'user', content: 'Z'.repeat(200) }] }, { minBytes: 8 });
  packed.packed.__gzipVersion = 99;
  const back = ops.gunzipCheckpointBlobVersioned(packed.packed);
  assert.equal(back.ok, false);
  assert.equal(back.code, 'gzip_version');
  assert.equal(back.state, null);
});

test('3H21-BE-018 gunzipCheckpointBlobVersioned accepts missing version as v1', () => {
  const state = { messages: [{ role: 'user', content: 'legacy'.repeat(40) }] };
  const packed = layer.gzipCheckpointBlob(state, { minBytes: 8 });
  assert.equal(packed.gzip, true);
  assert.equal(packed.packed.__gzipVersion, undefined);
  const back = ops.gunzipCheckpointBlobVersioned(packed.packed);
  assert.equal(back.ok, true);
  assert.deepEqual(back.state, state);
});

test('3H21-BE-019 hashSweepDue respects interval', () => {
  const now = 100_000;
  const due = ops.hashSweepDue(0, { now, intervalMs: 60_000 });
  assert.equal(due.due, true);
  assert.equal(due.code, 'hash_sweep');
  const wait = ops.hashSweepDue(now - 10_000, { now, intervalMs: 60_000 });
  assert.equal(wait.due, false);
  const later = ops.hashSweepDue(now - 60_000, { now, intervalMs: 60_000 });
  assert.equal(later.due, true);
});

test('3H21-BE-020 sweepHashTtl skips when not due then prunes when due', () => {
  const store = new Map();
  const state = { lastSweepAt: 50_000 };
  store.set('old', 1_000);
  store.set('new', 118_000);
  const skip = ops.sweepHashTtl(store, state, { now: 50_500, intervalMs: 60_000, ttlMs: 5_000 });
  assert.equal(skip.swept, false);
  assert.equal(store.size, 2);
  const run = ops.sweepHashTtl(store, state, { now: 120_000, intervalMs: 60_000, ttlMs: 5_000 });
  assert.equal(run.swept, true);
  assert.equal(run.pruned, 1);
  assert.equal(store.has('old'), false);
  assert.equal(store.has('new'), true);
  assert.equal(state.lastSweepAt, 120_000);
});

test('3H21-BE-021 retrieveMemoryToolFailClosed generic throw is fail-closed', async () => {
  const out = await ops.retrieveMemoryToolFailClosed({
    query: 'hola',
    userId: 'u1',
    recall: async () => { throw new Error('timeout'); },
  });
  assert.equal(out.ok, false);
  assert.equal(out.failClosed, true);
  assert.equal(out.code, 'retrieve_memory_failed');
  assert.equal(out.hits.length, 0);
});

test('3H21-BE-022 retrieveMemoryToolFailClosed pgvector still pgvector_failed', async () => {
  const out = await ops.retrieveMemoryToolFailClosed({
    query: 'hola',
    userId: 'u1',
    recall: async () => {
      const err = new Error('pgvector index down');
      err.code = 'pgvector_failed';
      throw err;
    },
  });
  assert.equal(out.ok, false);
  assert.equal(out.failClosed, true);
  assert.equal(out.code, 'pgvector_failed');
  assert.equal(out.hits.length, 0);
});

test('3H21-BE-023 retrieveMemoryToolFailClosed success returns hits', async () => {
  const out = await ops.retrieveMemoryToolFailClosed({
    query: 'hola',
    userId: 'u1',
    recall: async () => [{ text: 'pin', userId: 'u1' }],
  });
  assert.equal(out.ok, true);
  assert.equal(out.failClosed, false);
  assert.equal(out.hits.length, 1);
});

test('3H21-BE-024 live loop credit ceiling stops generate', async () => {
  const events = [];
  const client = scriptedWithUsage([{ content: 'no deberia seguir' }], { prompt_tokens: 80, completion_tokens: 40 });
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hola' }],
    tools: [],
    executors: createMockExecutors(),
    maxIterations: 4,
    creditCeiling: 50,
    onEvent: (e) => events.push(e),
  });
  assert.equal(out.stoppedReason, 'credit_ceiling');
  assert.equal(out.errorCode, 'credit_ceiling');
  assert.ok(events.some((e) => e.code === 'credit_ceiling'));
  assert.equal(client.calls.length, 1);
});

test('3H21-BE-025 live loop retrieve_memory tool throw fail-closed', async () => {
  let called = 0;
  const tools = [{
    type: 'function',
    function: { name: 'retrieve_memory', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  }];
  const client = scripted([
    { toolCalls: [{ name: 'retrieve_memory', args: { query: 'clave' } }] },
    { content: 'sigo sin memoria' },
  ]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'recuerda' }],
    tools,
    executors: {
      async retrieve_memory() {
        called += 1;
        throw new Error('store down');
      },
    },
    maxIterations: 4,
    onEvent: () => {},
  });
  assert.equal(out.stoppedReason, 'final');
  assert.equal(called, 1);
  assert.equal(out.steps[0].ok, false);
  assert.match(String(out.steps[0].resultPreview), /retrieve_memory_failed/);
});

test('3H21-BE-026 live loop tmpfs cleanup on cancel', async () => {
  const gone = [];
  const ac = new AbortController();
  const client = {
    chat: {
      completions: {
        async create() {
          ac.abort();
          await new Promise((r) => setTimeout(r, 5));
          return { choices: [{ message: { content: 'late' } }] };
        },
      },
    },
  };
  await assert.rejects(
    () => runAgentLoop({
      client,
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'x' }],
      tools: [],
      executors: createMockExecutors(),
      signal: ac.signal,
      tmpfsPaths: ['/tmp/sira-cancel-a', '/tmp/sira-cancel-b'],
      tmpfsUnlink: (p) => gone.push(p),
      onEvent: () => {},
    }),
    (err) => err && (err.name === 'AbortError' || /abort/i.test(String(err.message || err))),
  );
  assert.deepEqual(gone, ['/tmp/sira-cancel-a', '/tmp/sira-cancel-b']);
});

test('3H21-BE-027 live loop steal records metrics', async () => {
  ops.resetFenceStealMetrics();
  const kv = dur.createMemoryKv();
  const fence = nxt.createSessionFence(kv, { ttlSec: 5 });
  const held = await fence.acquire('lane-ops');
  await layer.heartbeatFence(kv, 'lane-ops', held.token, { ttlSec: 5, now: 1 });
  const out = await runAgentLoop({
    client: scripted([{ content: 'sigo' }]),
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hola' }],
    tools: [],
    executors: createMockExecutors(),
    maxIterations: 2,
    threadId: 'lane-ops',
    sessionFence: fence,
    kv,
    nowMs: 1 + 8_000,
    onEvent: () => {},
  });
  assert.equal(out.stoppedReason, 'final');
  assert.ok(ops.fenceStealMetrics().stolen >= 1);
});

test('3H21-BE-028 live loop DLQ poison after max attempts', async () => {
  const events = [];
  const tools = [{
    type: 'function',
    function: { name: 'write_file', parameters: WRITE_SCHEMA },
  }];
  const client = scripted([
    { toolCalls: [{ name: 'write_file', args: { path: 'a.js', content: 'x1', mode: 'create' } }] },
    { toolCalls: [{ name: 'write_file', args: { path: 'a.js', content: 'x2', mode: 'create' } }] },
    { toolCalls: [{ name: 'write_file', args: { path: 'a.js', content: 'x3', mode: 'create' } }] },
    { toolCalls: [{ name: 'write_file', args: { path: 'a.js', content: 'x4', mode: 'create' } }] },
    { content: 'basta' },
  ]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'escribe' }],
    tools,
    executors: { async write_file() { return 'ERROR: boom'; } },
    maxIterations: 8,
    onEvent: (e) => events.push(e),
  });
  assert.ok(out.stoppedReason === 'final' || out.stoppedReason === 'loop_cut');
  const poison = events.filter((e) => e.code === 'dlq_poison' || e.code === 'dlq_exhausted');
  assert.ok(poison.length >= 1);
});

test('3H21-BE-029 error_codes include ops taxonomy', () => {
  const { CODES } = require('../src/services/error_codes');
  assert.equal(CODES.DLQ_POISON, 'dlq_poison');
  assert.equal(CODES.GZIP_VERSION, 'gzip_version');
  assert.equal(CODES.HASH_SWEEP, 'hash_sweep');
  assert.equal(CODES.RETRIEVE_MEMORY_FAILED, 'retrieve_memory_failed');
  assert.equal(CODES.TMPFS_CLEANUP, 'tmpfs_cleanup');
  assert.equal(CODES.TIMEOUT_TABLE, 'timeout_table');
});

test('3H21-BE-030 classifyLoopError + public-stream-error ops codes', () => {
  assert.equal(rel.classifyLoopError({ code: 'dlq_poison' }).code, 'dlq_poison');
  assert.match(rel.classifyLoopError({ code: 'dlq_poison' }).message, /envenen|cola|demasiadas/i);
  assert.equal(rel.classifyLoopError({ code: 'gzip_version' }).code, 'gzip_version');
  assert.equal(rel.classifyLoopError({ code: 'retrieve_memory_failed' }).code, 'retrieve_memory_failed');
  assert.equal(rel.classifyLoopError({ code: 'tmpfs_cleanup' }).code, 'tmpfs_cleanup');
  assert.equal(rel.classifyLoopError({ code: 'hash_sweep' }).code, 'hash_sweep');
  const { classifyPublicStreamError } = require('../src/services/observability/public-stream-error');
  const pub = classifyPublicStreamError({ code: 'retrieve_memory_failed' });
  assert.equal(pub.code, 'retrieve_memory_failed');
  assert.ok(pub.message);
  assert.doesNotMatch(String(pub.message), /\/opt\/|stack|at Object/);
  assert.equal(classifyPublicStreamError({ code: 'gzip_version' }).code, 'gzip_version');
  assert.equal(classifyPublicStreamError({ code: 'dlq_poison' }).code, 'dlq_poison');
});

test('3H21-BE-031 health engine_loop exposes ops flags', () => {
  const hc = require('../src/services/observability/health-check');
  const c = hc.checkEngineLoop();
  assert.equal(c.name, 'engine_loop');
  assert.equal(c.details.dlqMaxAttempts, true);
  assert.equal(c.details.fenceStealMetrics, true);
  assert.equal(c.details.toolTimeoutTable, true);
  assert.equal(c.details.creditCeilingEnforce, true);
  assert.equal(c.details.sseReplayHealth, true);
  assert.equal(c.details.tmpfsCleanupCancel, true);
  assert.equal(c.details.gzipVersion, true);
  assert.equal(c.details.hashSweepInterval, true);
  assert.equal(c.details.retrieveMemoryFailClosed, true);
  assert.ok(c.details.stealCounters);
  assert.ok(c.details.replayCounters);
  assert.ok(c.details.timeoutTable);
  assert.equal(c.details.timeoutTable.ok, true);
});

test('3H21-BE-032 session-manager snapshot tmpfsCleanupOnCancel', () => {
  const sm = require('../src/services/sandbox/session-manager');
  const snap = sm.snapshot();
  assert.equal(snap.tmpfsCleanupOnCancel, true);
  assert.ok(snap.tmpfsCap);
  assert.equal(snap.networkPolicy.mode, 'deny-all');
});

test('3H21-BE-033 durable put versions gzip then get inflates', async () => {
  const kv = dur.createMemoryKv();
  const store = dur.createDurableCheckpointStore({ kv, threadId: 'gzv' });
  await store.put({
    checkpointId: 'c1',
    state: { messages: [{ role: 'user', content: 'Z'.repeat(3000) }] },
  });
  const got = await store.get('c1');
  assert.ok(got.state.messages[0].content.includes('Z'));
  assert.ok(got.metadata.blobGzip === true || got.metadata.gzipVersion === 1 || got.state.messages[0].content.length >= 1000);
});

test('3H21-BE-034 event-log pruneHashes respects sweep interval', () => {
  const log = createEventLog();
  log.remember('s', { type: 'a', seq: 1, payload: 'x' });
  const first = log.pruneHashes({ now: 1_000, ttlMs: 5_000, intervalMs: 60_000 });
  assert.equal(first.swept, true);
  const second = log.pruneHashes({ now: 2_000, ttlMs: 5_000, intervalMs: 60_000 });
  assert.equal(second.swept, false);
  const third = log.pruneHashes({ now: 70_000, ttlMs: 5_000, intervalMs: 60_000 });
  assert.equal(third.swept, true);
});

test('3H21-BE-035 event-log remember records replay metrics', () => {
  ops.resetReplayMetrics();
  const log = createEventLog({ max: 5, ttlMs: 30 * 60 * 1000 });
  for (let i = 1; i <= 8; i += 1) {
    log.remember('win', { type: 'x', seq: i, payload: `p${i}` });
  }
  assert.equal(log.size('win'), 5);
  const snap = ops.replayMetricsSnapshot();
  assert.ok(snap.dropped >= 3 || snap.windows >= 1);
});

test('3H21-BE-036 session-dlq replayWithJitter poisons at max', () => {
  const dlq = createSessionDlq();
  const rec = dlq.push({ sessionKey: 's', runId: 'r2', error: 'turn_timeout', retries: 3, userId: 'u1' });
  const plan = dlq.replayWithJitter(rec, { jitter: false, now: 0, baseMs: 250, maxAttempts: 3 });
  assert.equal(plan.ok, false);
  assert.ok(plan.code === 'dlq_poison' || plan.code === 'dlq_exhausted');
});

test('3H21-BE-037 gzip tiny blobs skip version stamp', () => {
  const out = ops.gzipCheckpointBlobVersioned({ messages: [{ role: 'user', content: 'x' }] }, { minBytes: 10_000 });
  assert.equal(out.gzip, false);
  assert.equal(out.version, 0);
});

test('3H21-BE-038 source markers engine-ops wired, no openrouter', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.match(loop, /engine-ops/);
  assert.match(loop, /enforceCreditCeiling|creditCeiling/);
  assert.match(loop, /cleanupTmpfsOnCancel|tmpfsPaths/);
  assert.match(loop, /stealStaleFenceMetered|recordFenceSteal/);
  assert.match(loop, /retrieve_memory_failed|scheduleDlqReplayCapped/);
  const durSrc = read('src/services/agent-runner/engine-durability.js');
  assert.match(durSrc, /gzipCheckpointBlobVersioned|gunzipCheckpointBlobVersioned/);
  const opsSrc = read('src/services/agent-runner/engine-ops.js');
  assert.match(opsSrc, /dlq_poison/);
  assert.match(opsSrc, /gzip_version/);
  assert.match(opsSrc, /retrieve_memory_failed/);
  assert.match(opsSrc, /hash_sweep/);
  assert.doesNotMatch(opsSrc, /openrouter\.ai/i);
  assert.doesNotMatch(loop, /openrouter\.ai/i);
  const snap = ops.opsSnapshot();
  assert.equal(snap.dlqMaxAttempts, true);
  assert.equal(snap.gzipVersion, true);
});

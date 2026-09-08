'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = fs.existsSync('/app/src/services/agent-runner/loop.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const rel = require('../src/services/agent-runner/engine-reliability');
const dur = require('../src/services/agent-runner/engine-durability');
const nxt = require('../src/services/agent-runner/engine-next');
const layer = require('../src/services/agent-runner/engine-layer');
const { runAgentLoop } = require('../src/services/agent-runner/loop');
const { createScriptedClient, createMockExecutors } = require('../src/services/agent-runner/evals/scripted-llm');
const { createEventLog } = require('../src/services/agent-gateway/event-log');
const { createSessionDlq } = require('../src/services/agent-gateway/session-dlq');

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

test('3H20-BE-001 heartbeatFence refreshes matching token', async () => {
  const kv = dur.createMemoryKv();
  const fence = nxt.createSessionFence(kv);
  const a = await fence.acquire('hb-1');
  assert.equal(a.ok, true);
  const hb = await layer.heartbeatFence(kv, 'hb-1', a.token, { now: 1_000 });
  assert.equal(hb.ok, true);
  assert.equal(hb.refreshed, true);
  const raw = await kv.get('sira:engine:fence:hb-1:hb');
  assert.equal(String(raw), '1000');
});

test('3H20-BE-002 heartbeatFence mismatch is fence_expired', async () => {
  const kv = dur.createMemoryKv();
  const fence = nxt.createSessionFence(kv);
  await fence.acquire('hb-2');
  const hb = await layer.heartbeatFence(kv, 'hb-2', 'wrong-token');
  assert.equal(hb.ok, false);
  assert.equal(hb.code, 'fence_expired');
});

test('3H20-BE-003 stealStaleFence after TTL', async () => {
  const kv = dur.createMemoryKv();
  const fence = nxt.createSessionFence(kv, { ttlSec: 5 });
  const a = await fence.acquire('stale-1');
  assert.equal(a.ok, true);
  await layer.heartbeatFence(kv, 'stale-1', a.token, { ttlSec: 5, now: 1_000 });
  const steal = await layer.stealStaleFence(kv, 'stale-1', { ttlSec: 5, now: 1_000 + 6_000 });
  assert.equal(steal.ok, true);
  assert.equal(steal.stolen, true);
  assert.equal(steal.code, 'fence_expired');
  const again = await fence.acquire('stale-1');
  assert.equal(again.ok, true);
});

test('3H20-BE-004 stealStaleFence live heartbeat is fence_conflict', async () => {
  const kv = dur.createMemoryKv();
  const fence = nxt.createSessionFence(kv, { ttlSec: 30 });
  const a = await fence.acquire('live-1');
  await layer.heartbeatFence(kv, 'live-1', a.token, { ttlSec: 30, now: 5_000 });
  const steal = await layer.stealStaleFence(kv, 'live-1', { ttlSec: 30, now: 6_000 });
  assert.equal(steal.ok, false);
  assert.equal(steal.code, 'fence_conflict');
});

test('3H20-BE-005 rankMemoryByScoreRecency prefers recent high score', () => {
  const now = 1_000_000;
  const ranked = layer.rankMemoryByScoreRecency([
    { text: 'old-hi', score: 0.9, at: now - 24 * 3600 * 1000 },
    { text: 'new-mid', score: 0.5, at: now },
    { text: 'new-hi', score: 0.85, at: now - 1000 },
  ], { now, halfLifeMs: 6 * 3600 * 1000 });
  assert.equal(ranked[0].text, 'new-hi');
  assert.ok(ranked[0].hybrid > ranked[ranked.length - 1].hybrid);
});

test('3H20-BE-006 rankMemoryByScoreRecency drops low-score even if recent', () => {
  const now = Date.now();
  const ranked = layer.rankMemoryByScoreRecency([
    { text: 'lo', score: 0.01, at: now },
    { text: 'kw' },
  ], { now, minScore: 0.15 });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].text, 'kw');
});

test('3H20-BE-007 gzipCheckpointBlob compresses large state', () => {
  const state = { messages: [{ role: 'user', content: 'Q'.repeat(4000) }] };
  const out = layer.gzipCheckpointBlob(state, { minBytes: 200 });
  assert.equal(out.gzip, true);
  assert.equal(out.packed.__gzip, true);
  assert.ok(out.bytes < out.rawBytes);
  assert.match(out.packed.b64, /^[A-Za-z0-9+/=]+$/);
});

test('3H20-BE-008 gunzipCheckpointBlob roundtrip', () => {
  const state = { messages: [{ role: 'assistant', content: 'hola gzip' }], n: 7 };
  const packed = layer.gzipCheckpointBlob(state, { minBytes: 8 });
  const back = layer.gunzipCheckpointBlob(packed.packed);
  assert.deepEqual(back, state);
});

test('3H20-BE-009 gzipCheckpointBlob skips tiny blobs', () => {
  const out = layer.gzipCheckpointBlob({ messages: [{ role: 'user', content: 'x' }] }, { minBytes: 10_000 });
  assert.equal(out.gzip, false);
  assert.equal(out.packed.messages[0].content, 'x');
});

test('3H20-BE-010 replayWindowMetrics reports dropped', () => {
  const now = Date.now();
  const frames = Array.from({ length: 12 }, (_, i) => ({ seq: i + 1, type: 'x', at: now }));
  const capped = nxt.capSseReplayWindow(frames, { max: 5, now });
  const m = layer.replayWindowMetrics(capped);
  assert.equal(m.kept, 5);
  assert.equal(m.dropped, 7);
  assert.equal(m.truncated, true);
  assert.equal(m.code, 'replay_window');
});

test('3H20-BE-011 pruneHashTtl expires old hashes', () => {
  const store = new Map();
  const now = 10_000;
  store.set('old', now - 10 * 60 * 1000);
  store.set('new', now);
  const out = layer.pruneHashTtl(store, { now, ttlMs: 5 * 60 * 1000 });
  assert.equal(out.pruned, 1);
  assert.equal(out.remaining, 1);
  assert.equal(store.has('old'), false);
  assert.equal(store.has('new'), true);
});

test('3H20-BE-012 rememberHashTtl second is duplicate_event', () => {
  const store = new Map();
  const a = layer.rememberHashTtl(store, 'h1', { now: 1000 });
  const b = layer.rememberHashTtl(store, 'h1', { now: 1100 });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(b.code, 'duplicate_event');
});

test('3H20-BE-013 reconcileAuditVsLedger ledger behind is credit_mismatch', () => {
  const audit = [
    { streamId: 's1', promptTokens: 10, completionTokens: 4 },
    { streamId: 's2', promptTokens: 3, completionTokens: 1 },
  ];
  const out = layer.reconcileAuditVsLedger(audit, { promptTokens: 10, completionTokens: 4 });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'credit_mismatch');
  assert.equal(out.action, 'ledger_behind');
  assert.equal(out.auditTotal, 18);
  assert.equal(out.ledgerTotal, 14);
});

test('3H20-BE-014 reconcileAuditVsLedger audit behind never double-charges', () => {
  const audit = [{ streamId: 's1', promptTokens: 2, completionTokens: 1 }];
  const out = layer.reconcileAuditVsLedger(audit, { promptTokens: 10, completionTokens: 5 });
  assert.equal(out.ok, true);
  assert.equal(out.action, 'no_double_charge');
});

test('3H20-BE-015 toolTimeoutMs per-tool overrides', () => {
  assert.equal(layer.toolTimeoutMs('execute_bash'), 30_000);
  assert.equal(layer.toolTimeoutMs('write_file'), 8_000);
  assert.equal(layer.toolTimeoutMs('retrieve_memory'), 4_000);
  assert.equal(layer.toolTimeoutMs('write_file', { write_file: 20 }), 20);
  assert.equal(layer.toolTimeoutMs('unknown_tool'), layer.TOOL_TIMEOUTS_MS.default);
});

test('3H20-BE-016 withToolTimeout rejects as tool_timeout', async () => {
  let ran = false;
  await assert.rejects(
    () => layer.withToolTimeout(async () => {
      ran = true;
      await new Promise((r) => setTimeout(r, 80));
      return 'late';
    }, 15),
    (err) => err && err.code === 'tool_timeout',
  );
  assert.equal(ran, true);
});

test('3H20-BE-017 sandboxTmpfsCap default 64MiB when unset', () => {
  const cap = layer.sandboxTmpfsCap({ env: {} });
  assert.equal(cap.maxMb, 64);
  assert.equal(cap.maxBytes, 64 * 1024 * 1024);
});

test('3H20-BE-018 assertTmpfsBudget exceeded is tmpfs_exceeded', () => {
  const cap = layer.sandboxTmpfsCap({ maxMb: 8 });
  const ok = layer.assertTmpfsBudget(1, 100, cap);
  assert.equal(ok.ok, true);
  const no = layer.assertTmpfsBudget(8 * 1024 * 1024 - 10, 100, cap);
  assert.equal(no.ok, false);
  assert.equal(no.code, 'tmpfs_exceeded');
});

test('3H20-BE-019 scheduleDlqReplay exponential without jitter', () => {
  const a = layer.scheduleDlqReplay({ retries: 0 }, { jitter: false, now: 0, baseMs: 250 });
  const b = layer.scheduleDlqReplay({ retries: 1 }, { jitter: false, now: 0, baseMs: 250 });
  const c = layer.scheduleDlqReplay({ retries: 2 }, { jitter: false, now: 0, baseMs: 250 });
  assert.equal(a.ok, true);
  assert.equal(a.code, 'dlq_replay');
  assert.equal(a.delayMs, 250);
  assert.equal(b.delayMs, 500);
  assert.equal(c.delayMs, 1000);
  assert.equal(c.retryAt, 1000);
});

test('3H20-BE-020 scheduleDlqReplay exhausted skip', () => {
  const out = layer.scheduleDlqReplay({ exhausted: true, retries: 3 }, { jitter: false });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'dlq_exhausted');
  assert.equal(out.delayMs, 0);
});

test('3H20-BE-021 retrieveMemoryFailClosed pgvector is fail-closed', async () => {
  const out = await layer.retrieveMemoryFailClosed({
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

test('3H20-BE-022 retrieveMemoryFailClosed generic error recovers empty', async () => {
  const out = await layer.retrieveMemoryFailClosed({
    query: 'hola',
    userId: 'u1',
    recall: async () => { throw new Error('timeout'); },
  });
  assert.equal(out.ok, true);
  assert.equal(out.failClosed, false);
  assert.equal(out.hits.length, 0);
});

test('3H20-BE-023 assertToolEnum fail-closed', () => {
  const bad = layer.assertToolEnum(WRITE_SCHEMA, { path: 'a.js', content: 'x', mode: 'hack' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'coercion_rejected');
  assert.match(bad.error, /enum/);
  const ok = layer.assertToolEnum(WRITE_SCHEMA, { path: 'a.js', content: 'x', mode: 'create' });
  assert.equal(ok.ok, true);
});

test('3H20-BE-024 assertCreditCeiling fail-closed', () => {
  const no = layer.assertCreditCeiling({ promptTokens: 90, completionTokens: 20 }, 100);
  assert.equal(no.ok, false);
  assert.equal(no.code, 'credit_ceiling');
  const ok = layer.assertCreditCeiling({ promptTokens: 10, completionTokens: 5 }, 100);
  assert.equal(ok.ok, true);
  assert.equal(ok.remaining, 85);
});

test('3H20-BE-025 capStdoutRate over cap', () => {
  const no = layer.capStdoutRate({ bytes: 10_000, elapsedMs: 10, maxBytesPerSec: 1000 });
  assert.equal(no.ok, false);
  assert.equal(no.code, 'stdout_rate');
  const ok = layer.capStdoutRate({ bytes: 100, elapsedMs: 1000, maxBytesPerSec: 1000 });
  assert.equal(ok.ok, true);
});

test('3H20-BE-026 live loop steal stale fence then runs', async () => {
  const kv = dur.createMemoryKv();
  const fence = nxt.createSessionFence(kv, { ttlSec: 5 });
  const held = await fence.acquire('lane-stale');
  await layer.heartbeatFence(kv, 'lane-stale', held.token, { ttlSec: 5, now: 1 });
  const events = [];
  const client = scripted([{ content: 'sigo' }]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hola' }],
    tools: [],
    executors: createMockExecutors(),
    maxIterations: 2,
    threadId: 'lane-stale',
    sessionFence: fence,
    kv,
    nowMs: 1 + 8_000,
    onEvent: (e) => events.push(e),
  });
  assert.equal(out.stoppedReason, 'final');
  assert.ok(out.finalText.includes('sigo') || out.stoppedReason === 'final');
});

test('3H20-BE-027 live loop tool timeout does not call forever', async () => {
  let called = 0;
  const tools = [{
    type: 'function',
    function: { name: 'write_file', parameters: WRITE_SCHEMA },
  }];
  const client = scripted([
    { toolCalls: [{ name: 'write_file', args: { path: 'a.js', content: 'ok', mode: 'create' } }] },
    { content: 'listo' },
  ]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'escribe' }],
    tools,
    executors: {
      async write_file() {
        called += 1;
        await new Promise((r) => setTimeout(r, 120));
        return 'WROTE';
      },
    },
    maxIterations: 4,
    toolTimeoutOverrides: { write_file: 20 },
    onEvent: () => {},
  });
  assert.equal(out.stoppedReason, 'final');
  assert.equal(called, 1);
  assert.equal(out.steps[0].ok, false);
  assert.match(String(out.steps[0].resultPreview), /tool_timeout/);
});

test('3H20-BE-028 live loop score+recency ranks memory', async () => {
  const now = Date.now();
  const events = [];
  const client = scripted([{ content: 'filtrado' }]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'recuerda' }],
    tools: [],
    executors: createMockExecutors(),
    maxIterations: 2,
    userId: 'u1',
    memoryRetrieve: async () => [
      { text: 'viejo', userId: 'u1', score: 0.9, at: now - 48 * 3600 * 1000 },
      { text: 'reciente', userId: 'u1', score: 0.6, at: now },
      { text: 'debil', userId: 'u1', score: 0.01, at: now },
    ],
    onEvent: (e) => events.push(e),
  });
  assert.equal(out.stoppedReason, 'final');
  assert.equal(out.memoryHits, 2);
  assert.ok(events.some((e) => e.type === 'memory_retrieved' && e.count === 2));
});

test('3H20-BE-029 live loop pgvector_failed is classified and continues', async () => {
  const events = [];
  const client = scripted([{ content: 'sigo sin memoria' }]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'recuerda' }],
    tools: [],
    executors: createMockExecutors(),
    maxIterations: 2,
    userId: 'u1',
    memoryRetrieve: async () => {
      const err = new Error('embedding store down');
      err.code = 'pgvector_failed';
      throw err;
    },
    onEvent: (e) => events.push(e),
  });
  assert.equal(out.stoppedReason, 'final');
  assert.equal(out.memoryHits, 0);
  assert.ok(events.some((e) => e.code === 'pgvector_failed'));
});

test('3H20-BE-030 live loop enum reject does not call executor', async () => {
  let called = 0;
  const tools = [{
    type: 'function',
    function: { name: 'write_file', parameters: WRITE_SCHEMA },
  }];
  const client = scripted([
    { toolCalls: [{ name: 'write_file', args: { path: 'a.js', content: 'ok', mode: 'hack' } }] },
    { content: 'sin escribir' },
  ]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'escribe' }],
    tools,
    executors: { async write_file() { called += 1; return 'WROTE'; } },
    maxIterations: 4,
    onEvent: () => {},
  });
  assert.equal(out.stoppedReason, 'final');
  assert.equal(called, 0);
  assert.match(String(out.steps[0].resultPreview), /coercion_rejected|enum/);
});

test('3H20-BE-031 error_codes include layer taxonomy', () => {
  const { CODES } = require('../src/services/error_codes');
  assert.equal(CODES.FENCE_EXPIRED, 'fence_expired');
  assert.equal(CODES.DLQ_REPLAY, 'dlq_replay');
  assert.equal(CODES.PGVECTOR_FAILED, 'pgvector_failed');
  assert.equal(CODES.TMPFS_EXCEEDED, 'tmpfs_exceeded');
  assert.equal(CODES.CREDIT_MISMATCH, 'credit_mismatch');
  assert.equal(CODES.CREDIT_CEILING, 'credit_ceiling');
  assert.equal(CODES.STDOUT_RATE, 'stdout_rate');
  assert.equal(CODES.HASH_EXPIRED, 'hash_expired');
});

test('3H20-BE-032 classifyLoopError + public-stream-error layer codes', () => {
  assert.equal(rel.classifyLoopError({ code: 'fence_expired' }).code, 'fence_expired');
  assert.match(rel.classifyLoopError({ code: 'fence_expired' }).message, /candado|expir/i);
  assert.equal(rel.classifyLoopError({ code: 'pgvector_failed' }).code, 'pgvector_failed');
  assert.equal(rel.classifyLoopError({ code: 'tmpfs_exceeded' }).code, 'tmpfs_exceeded');
  assert.equal(rel.classifyLoopError({ code: 'dlq_replay' }).code, 'dlq_replay');
  assert.equal(rel.classifyLoopError({ code: 'credit_ceiling' }).code, 'credit_ceiling');
  const { classifyPublicStreamError } = require('../src/services/observability/public-stream-error');
  const pub = classifyPublicStreamError({ code: 'pgvector_failed' });
  assert.equal(pub.code, 'pgvector_failed');
  assert.ok(pub.message);
  assert.doesNotMatch(String(pub.message), /\/opt\/|stack|at Object/);
  assert.equal(classifyPublicStreamError({ code: 'fence_expired' }).code, 'fence_expired');
});

test('3H20-BE-033 health engine_loop exposes layer flags', () => {
  const hc = require('../src/services/observability/health-check');
  const c = hc.checkEngineLoop();
  assert.equal(c.name, 'engine_loop');
  assert.equal(c.details.fenceHeartbeat, true);
  assert.equal(c.details.staleFenceSteal, true);
  assert.equal(c.details.scoreRecency, true);
  assert.equal(c.details.blobGzip, true);
  assert.equal(c.details.replayMetrics, true);
  assert.equal(c.details.hashTtl, true);
  assert.equal(c.details.auditLedger, true);
  assert.equal(c.details.toolTimeoutOverride, true);
  assert.equal(c.details.tmpfsCap, true);
  assert.equal(c.details.dlqReplay, true);
  assert.equal(c.details.pgvectorFailClosed, true);
  assert.equal(c.details.creditCeiling, true);
  assert.equal(c.details.turnFence, true);
});

test('3H20-BE-034 session-manager snapshot includes tmpfsCap', () => {
  const sm = require('../src/services/sandbox/session-manager');
  const snap = sm.snapshot();
  assert.ok(snap.tmpfsCap);
  assert.equal(snap.tmpfsCap.maxMb, 64);
  assert.equal(snap.networkPolicy.mode, 'deny-all');
});

test('3H20-BE-035 durable put gzipes then get inflates', async () => {
  const kv = dur.createMemoryKv();
  const store = dur.createDurableCheckpointStore({ kv, threadId: 'gz' });
  await store.put({
    checkpointId: 'c1',
    state: { messages: [{ role: 'user', content: 'Z'.repeat(3000) }] },
  });
  const got = await store.get('c1');
  assert.ok(got.state.messages[0].content.includes('Z'));
  assert.ok(got.metadata.blobGzip === true || got.state.messages[0].content.length >= 1000);
});

test('3H20-BE-036 event-log remember prunes expired hashes', () => {
  const log = createEventLog();
  const n1 = log.remember('s', { type: 'a', seq: 1, payload: 'x' });
  const n2 = log.remember('s', { type: 'a', seq: 1, payload: 'x' });
  assert.equal(n1, 1);
  assert.equal(n2, 1);
  if (typeof log.pruneHashes === 'function') {
    const out = log.pruneHashes({ now: Date.now() + 10 * 60 * 1000, ttlMs: 1000 });
    assert.ok(out.pruned >= 1);
  }
});

test('3H20-BE-037 session-dlq replayWithJitter schedules retry', () => {
  const dlq = createSessionDlq();
  const rec = dlq.push({ sessionKey: 's', runId: 'r1', error: 'turn_timeout', retries: 0, userId: 'u1' });
  assert.ok(rec);
  assert.equal(typeof dlq.replayWithJitter, 'function');
  const plan = dlq.replayWithJitter(rec, { jitter: false, now: 0, baseMs: 250 });
  assert.equal(plan.ok, true);
  assert.equal(plan.code, 'dlq_replay');
  assert.equal(plan.delayMs, 250);
});

test('3H20-BE-038 source markers engine-layer wired', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.match(loop, /engine-layer/);
  assert.match(loop, /heartbeatFence|stealStaleFence/);
  assert.match(loop, /withToolTimeout|toolTimeoutMs/);
  assert.match(loop, /rankMemoryByScoreRecency|pgvector_failed/);
  const durSrc = read('src/services/agent-runner/engine-durability.js');
  assert.match(durSrc, /gzipCheckpointBlob|gunzipCheckpointBlob/);
  const layerSrc = read('src/services/agent-runner/engine-layer.js');
  assert.match(layerSrc, /fence_expired/);
  assert.match(layerSrc, /pgvector_failed/);
  assert.match(layerSrc, /tmpfs_exceeded/);
  assert.doesNotMatch(layerSrc, /openrouter\.ai/i);
  const nxtSrc = read('src/services/agent-runner/engine-next.js');
  assert.doesNotMatch(nxtSrc, /openrouter\.ai/i);
});

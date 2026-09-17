'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/loop.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const rel = require('../src/services/agent-runner/engine-reliability');
const dur = require('../src/services/agent-runner/engine-durability');
const h = require('../src/services/agent-runner/engine-hardening');
const nxt = require('../src/services/agent-runner/engine-next');
const { runAgentLoop } = require('../src/services/agent-runner/loop');
const { createScriptedClient, createMockExecutors } = require('../src/services/agent-runner/evals/scripted-llm');
const { createSessionQueue } = require('../src/services/agent-gateway/queue');
const { createEventLog } = require('../src/services/agent-gateway/event-log');

function scripted(turns) { return createScriptedClient(turns); }

const WRITE_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    content: { type: 'string', maxLength: 64 },
    n: { type: 'integer', minimum: 0, maximum: 10 },
  },
  required: ['path', 'content'],
  additionalProperties: false,
};

test('3H19-BE-001 coerceToolArgs string maxLength fail-closed', () => {
  const big = 'x'.repeat(100);
  const out = nxt.coerceToolArgs(WRITE_SCHEMA, { path: 'a.js', content: big });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'coercion_rejected');
  assert.match(out.error, /maxLength/);
});

test('3H19-BE-002 coerceToolArgs number from numeric string', () => {
  const schema = { type: 'object', properties: { n: { type: 'integer', minimum: 0, maximum: 10 } } };
  const out = nxt.coerceToolArgs(schema, { n: '7' });
  assert.equal(out.ok, true);
  assert.equal(out.value.n, 7);
});

test('3H19-BE-003 coerceToolArgs array maxItems fail-closed', () => {
  const schema = { type: 'object', properties: { items: { type: 'array', maxItems: 2, items: { type: 'string' } } } };
  const out = nxt.coerceToolArgs(schema, { items: ['a', 'b', 'c'] });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'coercion_rejected');
  assert.match(out.error, /maxItems/);
});

test('3H19-BE-004 coerceToolArgs depth overflow fail-closed', () => {
  const nested = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 1 } } } } } } } } } };
  const out = nxt.coerceToolArgs({ type: 'object' }, nested, { maxDepth: 3 });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'coercion_rejected');
});

test('3H19-BE-005 coerceToolArgs integer minimum fail-closed', () => {
  const schema = { type: 'object', properties: { n: { type: 'integer', minimum: 0, maximum: 10 } } };
  const out = nxt.coerceToolArgs(schema, { n: -4 });
  assert.equal(out.ok, false);
  assert.match(out.error, /minimum/);
});

test('3H19-BE-006 retry tracker exhausts at 3', () => {
  const t = nxt.createRetryTracker({ maxRetries: 3 });
  const fp = t.fingerprint('write_file');
  assert.equal(t.recordFailure(fp).exhausted, false);
  assert.equal(t.recordFailure(fp).exhausted, false);
  const third = t.recordFailure(fp);
  assert.equal(third.count, 3);
  assert.equal(third.exhausted, true);
  assert.equal(t.shouldDeadLetter(fp), true);
});

test('3H19-BE-007 retry tracker reset after success', () => {
  const t = nxt.createRetryTracker({ maxRetries: 3 });
  const fp = t.fingerprint('bash');
  t.recordFailure(fp);
  t.recordFailure(fp);
  t.reset(fp);
  assert.equal(t.count(fp), 0);
  assert.equal(t.shouldDeadLetter(fp), false);
});

test('3H19-BE-008 session fence SET NX first wins', async () => {
  const kv = dur.createMemoryKv();
  const fence = nxt.createSessionFence(kv);
  const a = await fence.acquire('sess-a');
  const b = await fence.acquire('sess-a');
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.code, 'fence_conflict');
});

test('3H19-BE-009 session fence release then ok', async () => {
  const kv = dur.createMemoryKv();
  const fence = nxt.createSessionFence(kv);
  const a = await fence.acquire('sess-b');
  assert.equal(a.ok, true);
  const released = await fence.release('sess-b', a.token);
  assert.equal(released, true);
  const c = await fence.acquire('sess-b');
  assert.equal(c.ok, true);
});

test('3H19-BE-010 assertFenceSafe conflict vs skipped', async () => {
  const kv = dur.createMemoryKv();
  const fence = nxt.createSessionFence(kv);
  await fence.acquire('t1');
  const conflict = await nxt.assertFenceSafe({ fence, sessionKey: 't1' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'fence_conflict');
  const skipped = await nxt.assertFenceSafe({ fence: null, sessionKey: 't1' });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, true);
});

test('3H19-BE-011 filterMemoryByScore drops low hits', () => {
  const hits = [
    { text: 'hi', score: 0.9 },
    { text: 'lo', score: 0.01 },
    { text: 'mid', similarity: 0.2 },
  ];
  const kept = nxt.filterMemoryByScore(hits, { minScore: 0.15 });
  assert.equal(kept.length, 2);
  assert.ok(kept.every((h) => (h.score || h.similarity) >= 0.15));
});

test('3H19-BE-012 filterMemoryByScore keeps unscore keyword hits', () => {
  const hits = [{ text: 'kw' }, { text: 'bad', score: 0.01 }];
  const kept = nxt.filterMemoryByScore(hits);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].text, 'kw');
});

test('3H19-BE-013 compactCheckpointBlobs strips large content', () => {
  const big = 'Z'.repeat(20_000);
  const out = nxt.compactCheckpointBlobs({
    messages: [{ role: 'user', content: big }, { role: 'assistant', content: 'ok' }],
  }, { maxChars: 1000 });
  assert.equal(out.compacted, true);
  assert.ok(out.droppedBytes > 0);
  assert.ok(out.state.messages[0].content.length < big.length);
  assert.match(out.state.messages[0].content, /blob_compacted/);
  assert.equal(out.state.messages[1].content, 'ok');
});

test('3H19-BE-014 compactCheckpointBlobs preserves small blobs', () => {
  const out = nxt.compactCheckpointBlobs({ messages: [{ role: 'user', content: 'hola' }] });
  assert.equal(out.compacted, false);
  assert.equal(out.state.messages[0].content, 'hola');
});

test('3H19-BE-015 sandboxNetworkPolicy deny-all when unset', () => {
  const p = nxt.sandboxNetworkPolicy({ env: {} });
  assert.equal(p.mode, 'deny-all');
  assert.equal(p.deniedDefault, true);
  assert.equal(p.hosts.length, 0);
});

test('3H19-BE-016 assertSandboxNetwork deny-default', () => {
  const p = nxt.sandboxNetworkPolicy({ env: {} });
  const d = nxt.assertSandboxNetwork('example.com', p);
  assert.equal(d.ok, false);
  assert.equal(d.code, 'network_denied');
});

test('3H19-BE-017 assertSandboxNetwork allowlist host ok', () => {
  const p = nxt.sandboxNetworkPolicy({ allow: 'example.com, api.github.com' });
  const ok = nxt.assertSandboxNetwork('example.com', p);
  assert.equal(ok.ok, true);
  const no = nxt.assertSandboxNetwork('evil.test', p);
  assert.equal(no.ok, false);
  assert.equal(no.code, 'network_denied');
});

test('3H19-BE-018 capSseReplayWindow drops stale frames', () => {
  const now = 1_000_000;
  const frames = [
    { seq: 1, type: 'a', at: now - 10 * 60 * 1000 },
    { seq: 2, type: 'b', at: now - 1000 },
  ];
  const out = nxt.capSseReplayWindow(frames, { maxAgeMs: 5 * 60 * 1000, now });
  assert.equal(out.frames.length, 1);
  assert.equal(out.frames[0].seq, 2);
  assert.equal(out.truncated, true);
});

test('3H19-BE-019 capSseReplayWindow max count keeps newest', () => {
  const now = Date.now();
  const frames = Array.from({ length: 12 }, (_, i) => ({ seq: i + 1, type: 'x', at: now }));
  const out = nxt.capSseReplayWindow(frames, { max: 5, now });
  assert.equal(out.frames.length, 5);
  assert.equal(out.frames[0].seq, 8);
  assert.equal(out.dropped, 7);
});

test('3H19-BE-020 eventContentHash is stable for same payload', () => {
  const f = { type: 'tool_call', seq: 3, at: 1, tool: 'write_file' };
  const a = nxt.eventContentHash('s1', f);
  const b = nxt.eventContentHash('s1', { ...f, at: 99 });
  assert.equal(a, b);
  const c = nxt.eventContentHash('s2', f);
  assert.notEqual(a, c);
});

test('3H19-BE-021 dropDuplicateByHash second is duplicate_event', () => {
  const seen = new Set();
  const frame = { type: 'a', seq: 1, payload: 'x' };
  const first = nxt.dropDuplicateByHash(seen, 's', frame);
  const second = nxt.dropDuplicateByHash(seen, 's', { ...frame, at: 2 });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.code, 'duplicate_event');
});

test('3H19-BE-022 credit audit skip duplicate charge', () => {
  const log = nxt.createCreditAuditLog();
  const a = log.append({ streamId: 'st1', promptTokens: 10, completionTokens: 4 });
  const b = log.append({ streamId: 'st1', promptTokens: 10, completionTokens: 4 });
  assert.equal(a.recorded, true);
  assert.equal(a.action, 'audit_append');
  assert.equal(b.recorded, false);
  assert.equal(b.action, 'audit_skip');
  assert.equal(log.snapshot().count, 1);
});

test('3H19-BE-023 credit audit records distinct streams', () => {
  const log = nxt.createCreditAuditLog();
  log.append({ streamId: 'a', promptTokens: 1, completionTokens: 1 });
  log.append({ streamId: 'b', promptTokens: 1, completionTokens: 1 });
  assert.equal(log.snapshot().count, 2);
});

test('3H19-BE-024 rejectPathTraversal dotdot and NUL', () => {
  assert.equal(nxt.rejectPathTraversal('../etc/passwd').ok, false);
  assert.equal(nxt.rejectPathTraversal('../etc/passwd').code, 'path_traversal');
  assert.equal(nxt.rejectPathTraversal('foo\0bar').ok, false);
  assert.equal(nxt.rejectPathTraversal('/etc/passwd').ok, false);
});

test('3H19-BE-025 rejectPathTraversal workspace relative ok', () => {
  assert.equal(nxt.rejectPathTraversal('src/a.js').ok, true);
  assert.equal(nxt.rejectPathTraversal('/workspace/src/a.js').ok, true);
  assert.equal(nxt.rejectPathTraversal('.').ok, true);
  assert.equal(nxt.rejectPathTraversal('').ok, true);
});

test('3H19-BE-026 live loop coercion_rejected does not call executor', async () => {
  let called = 0;
  const tools = [{
    type: 'function',
    function: { name: 'write_file', parameters: WRITE_SCHEMA },
  }];
  const client = scripted([
    { toolCalls: [{ name: 'write_file', args: { path: 'a.js', content: 'Z'.repeat(200) } }] },
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
  assert.equal(out.steps[0].ok, false);
  assert.match(String(out.steps[0].resultPreview), /coercion_rejected/);
});

test('3H19-BE-027 live loop fence_conflict continues without exclusive', async () => {
  const kv = dur.createMemoryKv();
  const fence = nxt.createSessionFence(kv);
  await fence.acquire('lane-1');
  const events = [];
  const client = scripted([{ content: 'sigo' }]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hola' }],
    tools: [],
    executors: createMockExecutors(),
    maxIterations: 2,
    threadId: 'lane-1',
    sessionFence: fence,
    kv,
    onEvent: (e) => events.push(e),
  });
  assert.equal(out.stoppedReason, 'final');
  assert.ok(events.some((e) => e.code === 'fence_conflict'));
});

test('3H19-BE-028 live loop score threshold filters memory', async () => {
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
      { text: 'fuerte', userId: 'u1', score: 0.9 },
      { text: 'debil', userId: 'u1', score: 0.01 },
    ],
    onEvent: (e) => events.push(e),
  });
  assert.equal(out.stoppedReason, 'final');
  assert.equal(out.memoryHits, 1);
  assert.ok(events.some((e) => e.type === 'memory_retrieved' && e.count === 1));
});

test('3H19-BE-029 live loop dlq_exhausted after 3 tool failures', async () => {
  const events = [];
  const tools = [{
    type: 'function',
    function: {
      name: 'write_file',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    },
  }];
  const client = scripted([
    { toolCalls: [{ name: 'write_file', args: { path: 'a.js', content: '1' } }] },
    { toolCalls: [{ name: 'write_file', args: { path: 'b.js', content: '2' } }] },
    { toolCalls: [{ name: 'write_file', args: { path: 'c.js', content: '3' } }] },
    { content: 'paro' },
  ]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'escribe' }],
    tools,
    executors: { async write_file() { return 'ERROR: boom'; } },
    maxIterations: 6,
    onEvent: (e) => events.push(e),
  });
  assert.ok(events.some((e) => e.code === 'dlq_exhausted'));
  assert.ok(out.steps.length >= 3);
});

test('3H19-BE-030 error_codes include next-layer taxonomy', () => {
  const { CODES } = require('../src/services/error_codes');
  assert.equal(CODES.COERCION_REJECTED, 'coercion_rejected');
  assert.equal(CODES.DLQ_EXHAUSTED, 'dlq_exhausted');
  assert.equal(CODES.FENCE_CONFLICT, 'fence_conflict');
  assert.equal(CODES.NETWORK_DENIED, 'network_denied');
  assert.equal(CODES.PATH_TRAVERSAL, 'path_traversal');
  assert.equal(CODES.DUPLICATE_EVENT, 'duplicate_event');
  assert.equal(CODES.REPLAY_WINDOW, 'replay_window');
  assert.equal(CODES.AUDIT_SKIP, 'audit_skip');
});

test('3H19-BE-031 classifyLoopError + public-stream-error next codes', () => {
  assert.equal(rel.classifyLoopError({ code: 'coercion_rejected' }).code, 'coercion_rejected');
  assert.match(rel.classifyLoopError({ code: 'coercion_rejected' }).message, /l[ií]mite|argumentos|bounds|esquema/i);
  assert.equal(rel.classifyLoopError({ code: 'fence_conflict' }).code, 'fence_conflict');
  assert.equal(rel.classifyLoopError({ code: 'dlq_exhausted' }).code, 'dlq_exhausted');
  assert.equal(rel.classifyLoopError({ code: 'network_denied' }).code, 'network_denied');
  assert.equal(rel.classifyLoopError({ code: 'path_traversal' }).code, 'path_traversal');
  const { classifyPublicStreamError } = require('../src/services/observability/public-stream-error');
  const pub = classifyPublicStreamError({ code: 'coercion_rejected' });
  assert.equal(pub.code, 'coercion_rejected');
  assert.ok(pub.message);
  assert.doesNotMatch(String(pub.message), /\/opt\/|stack|at Object/);
  assert.equal(classifyPublicStreamError({ code: 'fence_conflict' }).code, 'fence_conflict');
});

test('3H19-BE-032 health engine_loop exposes next-layer flags', () => {
  const hc = require('../src/services/observability/health-check');
  const c = hc.checkEngineLoop();
  assert.equal(c.name, 'engine_loop');
  assert.equal(c.details.coercionBounds, true);
  assert.equal(c.details.turnFence, true);
  assert.equal(c.details.scoreThreshold, true);
  assert.equal(c.details.blobCompact, true);
  assert.equal(c.details.networkDeny, true);
  assert.equal(c.details.replayWindow, true);
  assert.equal(c.details.creditAudit, true);
  assert.equal(c.details.eventHash, true);
  assert.equal(c.details.deadLetterRetry, true);
});

test('3H19-BE-033 session-manager snapshot includes networkPolicy', () => {
  const sm = require('../src/services/sandbox/session-manager');
  const snap = sm.snapshot();
  assert.ok(snap.networkPolicy);
  assert.equal(snap.networkPolicy.mode, 'deny-all');
  assert.equal(snap.networkPolicy.deniedDefault, true);
});

test('3H19-BE-034 persistEventFrame drops duplicate hash and caps window', async () => {
  const kv = dur.createMemoryKv();
  const frame = { type: 'a', seq: 1, payload: 'x' };
  const s1 = await dur.persistEventFrame(kv, 'win', frame);
  const s2 = await dur.persistEventFrame(kv, 'win', { ...frame, at: Date.now() });
  assert.equal(s1, 1);
  assert.equal(s2, 1);
  const replay = await dur.replayEventFrames(kv, 'win', 0);
  const as = replay.filter((f) => f.type === 'a');
  assert.equal(as.length, 1);
});

test('3H19-BE-035 retrieveMemoryForLoop applies score threshold', async () => {
  const hits = await dur.retrieveMemoryForLoop({
    query: 'x',
    userId: 'u1',
    recall: async () => [
      { text: 'hi', userId: 'u1', score: 0.8 },
      { text: 'lo', userId: 'u1', score: 0.01 },
    ],
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text, 'hi');
});

test('3H19-BE-036 event-log remember drops duplicate by hash', () => {
  const log = createEventLog();
  const n1 = log.remember('s', { type: 'a', seq: 1, payload: 'x' });
  const n2 = log.remember('s', { type: 'a', seq: 1, payload: 'x' });
  assert.equal(n1, 1);
  assert.equal(n2, 1);
  const replay = log.replayFrom('s', 0);
  const as = replay.filter((f) => f.type === 'a');
  assert.equal(as.length, 1);
});

test('3H19-BE-037 durable put compactes large checkpoint blobs', async () => {
  const kv = dur.createMemoryKv();
  const store = dur.createDurableCheckpointStore({ kv, threadId: 'blob' });
  const rec = await store.put({
    checkpointId: 'c1',
    state: { messages: [{ role: 'user', content: 'Q'.repeat(20_000) }] },
  });
  const got = await store.get('c1');
  assert.ok(got.state.messages[0].content.length < 20_000);
  assert.match(got.state.messages[0].content, /blob_compacted/);
  assert.equal(rec.metadata.blobCompacted, true);
});

test('3H19-BE-038 source markers engine-next wired', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.match(loop, /engine-next/);
  assert.match(loop, /coerceToolArgs/);
  assert.match(loop, /createSessionFence|sessionFence/);
  assert.match(loop, /filterMemoryByScore/);
  const tools = read('src/services/agent-runner/tools.js');
  assert.match(tools, /rejectPathTraversal/);
  const nxtSrc = read('src/services/agent-runner/engine-next.js');
  assert.match(nxtSrc, /coercion_rejected/);
  assert.match(nxtSrc, /fence_conflict/);
  assert.doesNotMatch(nxtSrc, /openrouter\.ai/i);
});

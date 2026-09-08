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
const { runAgentLoop } = require('../src/services/agent-runner/loop');
const { createScriptedClient, createMockExecutors } = require('../src/services/agent-runner/evals/scripted-llm');
const { createSessionQueue } = require('../src/services/agent-gateway/queue');
const { createEventLog } = require('../src/services/agent-gateway/event-log');

function scripted(turns) { return createScriptedClient(turns); }

const WRITE_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    content: { type: 'string' },
  },
  required: ['path', 'content'],
  additionalProperties: false,
};

test('3H18-BE-001 isCheckpointExpired after TTL', () => {
  const fresh = { at: Date.now(), checkpointId: 'c' };
  const old = { at: Date.now() - (7 * 3600 * 1000), checkpointId: 'c' };
  assert.equal(dur.isCheckpointExpired(fresh), false);
  assert.equal(dur.isCheckpointExpired(old), true);
  assert.equal(dur.isCheckpointExpired(null), false);
});

test('3H18-BE-002 resume lock SET NX first wins', async () => {
  const kv = dur.createMemoryKv();
  const lock = h.createResumeLock(kv);
  const a = await lock.acquire('thread-a');
  const b = await lock.acquire('thread-a');
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.code, 'resume_conflict');
  const released = await lock.release('thread-a', a.token);
  assert.equal(released, true);
  const c = await lock.acquire('thread-a');
  assert.equal(c.ok, true);
});

test('3H18-BE-003 assertResumeSafe conflict vs ok', async () => {
  const kv = dur.createMemoryKv();
  const lock = h.createResumeLock(kv);
  await lock.acquire('t1');
  const conflict = await h.assertResumeSafe({ lock, threadId: 't1' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'resume_conflict');
  const skipped = await h.assertResumeSafe({ lock: null, threadId: 't1' });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, true);
});

test('3H18-BE-004 durable get marks expired checkpoint', async () => {
  const kv = dur.createMemoryKv();
  const store = dur.createDurableCheckpointStore({ kv, threadId: 'exp' });
  await store.put({
    checkpointId: 'old',
    state: { messages: [{ role: 'user', content: 'x' }] },
    at: Date.now() - (7 * 3600 * 1000),
  });
  const got = await store.get('old');
  assert.ok(got);
  assert.equal(got.expired, true);
});

test('3H18-BE-005 validateToolArgs required fields fail-closed', () => {
  const miss = h.validateToolArgs(WRITE_SCHEMA, { path: 'a.js' });
  assert.equal(miss.ok, false);
  assert.equal(miss.code, 'schema_invalid');
  const ok = h.validateToolArgs(WRITE_SCHEMA, { path: 'a.js', content: 'x' });
  assert.equal(ok.ok, true);
});

test('3H18-BE-006 additionalProperties rejected', () => {
  const extra = h.validateToolArgs(WRITE_SCHEMA, { path: 'a.js', content: 'x', hack: 1 });
  assert.equal(extra.ok, false);
  assert.match(extra.error, /unexpected:hack/);
});

test('3H18-BE-007 empty required string fails', () => {
  const empty = h.validateToolArgs(WRITE_SCHEMA, { path: '  ', content: 'x' });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /missing:path/);
});

test('3H18-BE-008 createSubagentContext isolates messages', () => {
  const parent = [{ role: 'user', content: 'padre' }];
  const ctx = h.createSubagentContext({ parentMessages: parent, parentBudgetRemaining: 20 });
  ctx.messages.push({ role: 'assistant', content: 'hijo' });
  assert.equal(parent.length, 1);
  assert.equal(ctx.messages.length, 2);
  assert.equal(ctx.messages[0].content, 'padre');
  parent[0].content = 'mutado';
  assert.equal(ctx.messages[0].content, 'padre');
});

test('3H18-BE-009 sliceSubagentBudget is a slice of parent', () => {
  assert.equal(h.sliceSubagentBudget(40), 8);
  assert.equal(h.sliceSubagentBudget(4, { max: 8, fraction: 0.25 }), 1);
  assert.ok(h.sliceSubagentBudget(0) >= 1);
});

test('3H18-BE-010 subagent tool allowlist filters executors', () => {
  const ctx = h.createSubagentContext({
    allowTools: ['read_file', 'list_files'],
  });
  assert.equal(ctx.canUse('read_file'), true);
  assert.equal(ctx.canUse('write_file'), false);
  const filtered = ctx.filterExecutors({
    read_file: () => 1,
    write_file: () => 2,
    list_files: () => 3,
  });
  assert.equal(typeof filtered.write_file, 'undefined');
  assert.equal(typeof filtered.read_file, 'function');
  assert.equal(ctx.abortParent, false);
});

test('3H18-BE-011 aclMemoryHits drops other users', () => {
  const hits = [
    { text: 'mio', userId: 'u1' },
    { text: 'ajeno', userId: 'u2' },
    { text: 'sistema' },
  ];
  const mine = h.aclMemoryHits(hits, 'u1');
  assert.deepEqual(mine.map((x) => x.text), ['mio', 'sistema']);
});

test('3H18-BE-012 missing userId fail-closed on tagged hits', () => {
  const hits = [{ text: 'secreto', userId: 'u1' }, { text: 'publico' }];
  const out = h.aclMemoryHits(hits, null);
  assert.deepEqual(out.map((x) => x.text), ['publico']);
});

test('3H18-BE-013 detectSseGaps finds hole', () => {
  const gaps = h.detectSseGaps([{ seq: 1 }, { seq: 2 }, { seq: 4 }], 0);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].from, 3);
  assert.equal(gaps[0].to, 3);
});

test('3H18-BE-014 fillSseGaps inserts sse_gap marker', () => {
  const filled = h.fillSseGaps([{ seq: 1, type: 'a' }, { seq: 3, type: 'c' }], 0);
  assert.equal(filled.gaps.length, 1);
  assert.ok(filled.frames.some((f) => f.type === 'sse_gap' && f.seq === 2));
});

test('3H18-BE-015 persistEventFrame is idempotent on same seq+type', async () => {
  const kv = dur.createMemoryKv();
  const s1 = await dur.persistEventFrame(kv, 's', { type: 'a', seq: 1 });
  const s1b = await dur.persistEventFrame(kv, 's', { type: 'a', seq: 1 });
  assert.equal(s1, 1);
  assert.equal(s1b, 1);
  const replay = await dur.replayEventFrames(kv, 's', 0);
  const as = replay.filter((f) => f.type === 'a');
  assert.equal(as.length, 1);
});

test('3H18-BE-016 compareUsageDrift redis ahead vs ledger ahead', () => {
  const ahead = h.compareUsageDrift(
    { promptTokens: 10, completionTokens: 2 },
    { promptTokens: 12, completionTokens: 4 },
  );
  assert.equal(ahead.charge, 'skip_redis_ahead');
  assert.equal(ahead.drifted, true);
  const behind = h.compareUsageDrift(
    { promptTokens: 10, completionTokens: 5 },
    { promptTokens: 10, completionTokens: 2 },
  );
  assert.equal(behind.charge, 'catchup_redis');
});

test('3H18-BE-017 reconcileUsage never double-charges', () => {
  const r = h.reconcileUsage(
    { promptTokens: 5, completionTokens: 1 },
    { promptTokens: 9, completionTokens: 1 },
  );
  assert.equal(r.action, 'no_double_charge');
  assert.equal(r.usage.promptTokens, 9);
});

test('3H18-BE-018 persistUsage merges max so cancel cannot lose tokens', async () => {
  const kv = dur.createMemoryKv();
  await dur.persistUsage(kv, 'st', { promptTokens: 7, completionTokens: 1 });
  await dur.persistUsage(kv, 'st', { promptTokens: 3, completionTokens: 8 });
  const u = await dur.loadUsage(kv, 'st');
  assert.equal(u.promptTokens, 7);
  assert.equal(u.completionTokens, 8);
});

test('3H18-BE-019 sandboxResourceLimits cgroup vs ulimit fallback', () => {
  const cg = h.sandboxResourceLimits({ existsSync: (p) => p.includes('cgroup.controllers') });
  assert.equal(cg.mode, 'cgroup');
  assert.equal(cg.cgroup.version, 2);
  const fb = h.sandboxResourceLimits({ existsSync: () => false });
  assert.equal(fb.mode, 'ulimit-fallback');
  assert.ok(fb.cpuMs >= 1000);
  assert.ok(fb.memMb >= 32);
});

test('3H18-BE-020 detectCgroup injectable', () => {
  assert.equal(h.detectCgroup({ existsSync: () => false }).present, false);
  assert.equal(h.detectCgroup({ existsSync: (p) => p === '/sys/fs/cgroup/memory' }).version, 1);
});

test('3H18-BE-021 rejectSymlinkWrite', () => {
  assert.equal(h.rejectSymlinkWrite({ isSymbolicLink: () => true }).ok, false);
  assert.equal(h.rejectSymlinkWrite({ isSymbolicLink: () => true }).code, 'symlink_rejected');
  assert.equal(h.rejectSymlinkWrite({ isSymbolicLink: () => false }).ok, true);
  assert.equal(h.rejectSymlinkWrite(null).ok, true);
});

test('3H18-BE-022 rejectBinaryPatch NUL', () => {
  assert.equal(h.rejectBinaryPatch('hello').ok, true);
  assert.equal(h.rejectBinaryPatch('hel\0lo').ok, false);
  assert.equal(h.rejectBinaryPatch(Buffer.from([1, 0, 2])).ok, false);
});

test('3H18-BE-023 queue idempotencyKey rejects duplicate in-flight', async () => {
  const q = createSessionQueue();
  let started = 0;
  const slow = () => new Promise((resolve) => {
    started += 1;
    setTimeout(resolve, 30);
  });
  const p1 = q.enqueue('s1', slow, { idempotencyKey: 'turn-9' });
  let dupErr = null;
  try {
    await q.enqueue('s1', slow, { idempotencyKey: 'turn-9' });
  } catch (err) { dupErr = err; }
  await p1;
  assert.ok(dupErr);
  assert.equal(dupErr.code, 'duplicate_turn');
  assert.equal(started, 1);
});

test('3H18-BE-024 live loop schema_invalid does not call executor', async () => {
  let called = 0;
  const events = [];
  const tools = [{
    type: 'function',
    function: {
      name: 'write_file',
      parameters: WRITE_SCHEMA,
    },
  }];
  const client = scripted([
    { toolCalls: [{ name: 'write_file', args: { path: 'a.js' } }] },
    { content: 'sin escribir' },
  ]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'escribe' }],
    tools,
    executors: {
      async write_file() { called += 1; return 'WROTE'; },
    },
    maxIterations: 4,
    onEvent: (e) => events.push(e),
  });
  assert.equal(out.stoppedReason, 'final');
  assert.equal(called, 0);
  assert.equal(out.steps[0].ok, false);
  assert.match(String(out.steps[0].resultPreview), /schema_invalid/);
});

test('3H18-BE-025 live loop expired ckpt classified, continues', async () => {
  const kv = dur.createMemoryKv();
  const store = dur.createDurableCheckpointStore({ kv, threadId: 'exp2' });
  await store.put({
    checkpointId: 'stale',
    state: { messages: [{ role: 'user', content: 'viejo' }] },
    at: Date.now() - (8 * 3600 * 1000),
  });
  const events = [];
  const client = scripted([{ content: 'sigo' }]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'nuevo' }],
    tools: [],
    executors: createMockExecutors(),
    maxIterations: 2,
    threadId: 'exp2',
    checkpointStore: store,
    resumeFrom: 'stale',
    onEvent: (e) => events.push(e),
  });
  assert.equal(out.stoppedReason, 'final');
  assert.ok(events.some((e) => e.type === 'error' && e.code === 'checkpoint_expired'));
  assert.equal(out.resumedFrom, null);
});

test('3H18-BE-026 live loop resume_conflict skips restore', async () => {
  const kv = dur.createMemoryKv();
  const store = dur.createDurableCheckpointStore({ kv, threadId: 'race' });
  await store.put({
    checkpointId: 'ckpt_r',
    state: { messages: [{ role: 'user', content: 'ckpt' }] },
  });
  const lock = h.createResumeLock(kv);
  await lock.acquire('race');
  const events = [];
  const client = scripted([{ content: 'conflicto' }]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'vivo' }],
    tools: [],
    executors: createMockExecutors(),
    maxIterations: 2,
    threadId: 'race',
    checkpointStore: store,
    resumeFrom: 'ckpt_r',
    resumeLock: lock,
    kv,
    onEvent: (e) => events.push(e),
  });
  assert.equal(out.stoppedReason, 'final');
  assert.ok(events.some((e) => e.code === 'resume_conflict'));
  assert.equal(out.resumedFrom, null);
});

test('3H18-BE-027 live loop memory ACL filters foreign hits', async () => {
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
      { text: 'dato-u1', userId: 'u1' },
      { text: 'dato-u2', userId: 'u2' },
    ],
    onEvent: (e) => events.push(e),
  });
  assert.equal(out.stoppedReason, 'final');
  assert.equal(out.memoryHits, 1);
  assert.ok(events.some((e) => e.type === 'memory_retrieved' && e.count === 1));
});

test('3H18-BE-028 tool-exec latency samples without paid LLM', async () => {
  h.observeToolExec(4);
  h.observeToolExec(8);
  h.observeToolExec(12);
  const snap = h.toolExecSnapshot();
  assert.ok(snap.count >= 3);
  assert.ok(snap.p50 != null);
  assert.ok(snap.p95 != null);
});

test('3H18-BE-029 error_codes include hardening taxonomy', () => {
  const { CODES } = require('../src/services/error_codes');
  assert.equal(CODES.CHECKPOINT_EXPIRED, 'checkpoint_expired');
  assert.equal(CODES.RESUME_CONFLICT, 'resume_conflict');
  assert.equal(CODES.SCHEMA_INVALID, 'schema_invalid');
  assert.equal(CODES.MEMORY_ACL_DENIED, 'memory_acl_denied');
  assert.equal(CODES.SSE_GAP, 'sse_gap');
  assert.equal(CODES.USAGE_DRIFT, 'usage_drift');
  assert.equal(CODES.SYMLINK_REJECTED, 'symlink_rejected');
});

test('3H18-BE-030 classifyLoopError + public-stream-error hardening codes', () => {
  assert.equal(rel.classifyLoopError({ code: 'checkpoint_expired' }).code, 'checkpoint_expired');
  assert.equal(rel.classifyLoopError({ code: 'resume_conflict' }).code, 'resume_conflict');
  assert.equal(rel.classifyLoopError({ code: 'schema_invalid' }).code, 'schema_invalid');
  assert.match(rel.classifyLoopError({ code: 'schema_invalid' }).message, /esquema|argumentos/i);
  const { classifyPublicStreamError } = require('../src/services/observability/public-stream-error');
  assert.equal(classifyPublicStreamError({ code: 'checkpoint_expired' }).code, 'checkpoint_expired');
  assert.equal(classifyPublicStreamError({ code: 'resume_conflict' }).code, 'resume_conflict');
  assert.equal(classifyPublicStreamError({ code: 'schema_invalid' }).code, 'schema_invalid');
});

test('3H18-BE-031 health engine_loop exposes hardening flags', () => {
  const hc = require('../src/services/observability/health-check');
  const c = hc.checkEngineLoop();
  assert.equal(c.name, 'engine_loop');
  assert.equal(c.details.hardening, true);
  assert.equal(c.details.resumeLock, true);
  assert.equal(c.details.schemaFailClosed, true);
  assert.equal(c.details.memoryAcl, true);
  assert.equal(c.details.sseGapFill, true);
});

test('3H18-BE-032 session-manager snapshot includes resourceLimits', () => {
  const sm = require('../src/services/sandbox/session-manager');
  const snap = sm.snapshot();
  assert.ok(snap.resourceLimits);
  assert.ok(snap.resourceLimits.cpuMs >= 1000);
  assert.ok(['cgroup', 'ulimit-fallback'].includes(snap.resourceLimits.mode));
});

test('3H18-BE-033 event-log replay fills Last-Event-ID gaps', () => {
  const log = createEventLog();
  log.remember('s', { type: 'a', seq: 1 });
  log.remember('s', { type: 'c', seq: 3 });
  const replay = log.replayFrom('s', 0);
  assert.ok(replay.some((f) => f.type === 'sse_gap'));
});

test('3H18-BE-034 retrieveMemoryForLoop applies ACL', async () => {
  const hits = await dur.retrieveMemoryForLoop({
    query: 'x',
    userId: 'u1',
    store: {
      async recall() {
        return [
          { text: 'ok', userId: 'u1' },
          { text: 'no', userId: 'u2' },
        ];
      },
    },
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text, 'ok');
});

test('3H18-BE-035 loop.js wires schema/resumeLock/ACL/hardening', () => {
  const src = read('src/services/agent-runner/loop.js');
  assert.match(src, /validateToolArgs/);
  assert.match(src, /resumeLock/);
  assert.match(src, /aclMemoryHits/);
  assert.match(src, /checkpoint_expired/);
  assert.match(src, /schema_invalid/);
  assert.match(src, /observeToolExec/);
});

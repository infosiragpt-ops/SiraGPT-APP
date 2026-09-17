'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/loop.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const rel = require('../src/services/agent-runner/engine-reliability');
const dur = require('../src/services/agent-runner/engine-durability');
const { runAgentLoop } = require('../src/services/agent-runner/loop');
const { createScriptedClient, createMockExecutors } = require('../src/services/agent-runner/evals/scripted-llm');

function scripted(turns) {
  return createScriptedClient(turns);
}

test('3H17-BE-001 durable checkpoint put/get/latest via memory kv', async () => {
  const kv = dur.createMemoryKv();
  const store = dur.createDurableCheckpointStore({ kv, threadId: 't1' });
  const rec = await store.put({
    checkpointId: 'ckpt_a',
    state: { messages: [{ role: 'user', content: 'hola' }], iteration: 1 },
  });
  assert.equal(rec.checkpointId, 'ckpt_a');
  const got = await store.get('ckpt_a');
  assert.equal(got.state.messages[0].content, 'hola');
  const latest = await store.latest();
  assert.equal(latest.checkpointId, 'ckpt_a');
  const raw = await kv.get('sira:engine:ckpt:t1:ckpt_a');
  assert.ok(raw && JSON.parse(raw).checkpointId === 'ckpt_a');
});

test('3H17-BE-002 parent chain is recorded', async () => {
  const store = dur.createDurableCheckpointStore({ kv: dur.createMemoryKv(), threadId: 't2' });
  await store.put({ checkpointId: 'c1', state: { iteration: 1 } });
  const c2 = await store.put({ checkpointId: 'c2', state: { iteration: 2 } });
  assert.equal(c2.parentCheckpointId, 'c1');
});

test('3H17-BE-003 restoreMessagesFromCheckpoint splices live array', () => {
  const messages = [{ role: 'user', content: 'nuevo' }];
  const r = dur.restoreMessagesFromCheckpoint(messages, {
    id: 'ckpt_x',
    messages: [{ role: 'user', content: 'viejo' }, { role: 'assistant', content: 'ok' }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.restored, 2);
  assert.equal(messages[0].content, 'viejo');
  assert.equal(messages.length, 2);
});

test('3H17-BE-004 retrieveMemoryForLoop uses injectable store, never throws', async () => {
  const hits = await dur.retrieveMemoryForLoop({
    query: 'color rosado',
    userId: 'u1',
    store: {
      async recall() { return [{ text: 'Luis prefiere rosado', kind: 'fact', score: 0.9 }]; },
    },
  });
  assert.equal(hits[0].text.includes('rosado'), true);
  const empty = await dur.retrieveMemoryForLoop({ query: '', userId: 'u1' });
  assert.deepEqual(empty, []);
  const boom = await dur.retrieveMemoryForLoop({
    query: 'x',
    recall: async () => { throw new Error('pg down'); },
  });
  assert.deepEqual(boom, []);
});

test('3H17-BE-005 memoryHitsToPins caps and strips', () => {
  const pins = dur.memoryHitsToPins([
    { text: 'a'.repeat(500) },
    { text: '  b  ' },
    null,
  ]);
  assert.equal(pins[0].length, 400);
  assert.equal(pins[1], 'b');
});

test('3H17-BE-006 planSubtasks splits numbered / luego', () => {
  const p = dur.planSubtasks('1. leer archivo\n2. editar\nluego verificar');
  assert.ok(p.subtasks.length >= 2);
  assert.ok(p.budget >= 4);
  assert.equal(dur.planSubtasks('').subtasks.length, 0);
});

test('3H17-BE-007 canRunToolsInParallel only for readonly set', () => {
  assert.equal(dur.canRunToolsInParallel([
    { function: { name: 'read_file' } },
    { function: { name: 'list_files' } },
  ]), true);
  assert.equal(dur.canRunToolsInParallel([
    { function: { name: 'read_file' } },
    { function: { name: 'write_file' } },
  ]), false);
  assert.equal(dur.canRunToolsInParallel([{ function: { name: 'read_file' } }]), false);
});

test('3H17-BE-008 capStdout truncates over max bytes', () => {
  const small = dur.capStdout('hola', 100);
  assert.equal(small.truncated, false);
  const big = dur.capStdout('x'.repeat(1000), 100);
  assert.equal(big.truncated, true);
  assert.ok(Buffer.byteLength(big.text, 'utf8') <= 100 + 80);
});

test('3H17-BE-009 assertWriteSize rejects oversized writes', () => {
  assert.equal(dur.assertWriteSize('ok', 100).ok, true);
  assert.throws(() => dur.assertWriteSize('y'.repeat(200), 50), /file_too_large/);
});

test('3H17-BE-010 applyUnifiedDiff unique hunk + reject non-unique', () => {
  const src = 'alpha\nbeta\nalpha\n';
  const unique = dur.applyUnifiedDiff('hello world\n', '@@ -1,1 +1,1 @@\n-hello world\n+hello sira\n');
  assert.equal(unique.ok, true);
  assert.equal(unique.content.trim(), 'hello sira');
  const dup = dur.applyUnifiedDiff(src, '@@ -1 +1 @@\n-alpha\n+omega\n');
  assert.equal(dup.ok, false);
  assert.equal(dup.error, 'hunk_not_unique');
  const miss = dur.applyUnifiedDiff(src, '@@ -1 +1 @@\n-zzz\n+q\n');
  assert.equal(miss.ok, false);
});

test('3H17-BE-011 SSE heartbeat data-frame + guaranteed stop', () => {
  const frames = [];
  const timers = [];
  const hb = dur.createSseHeartbeat({
    write: (f) => frames.push(f),
    intervalMs: 10,
    setIntervalFn: (fn, ms) => { timers.push(fn); return 1; },
    clearIntervalFn: () => { timers.splice(0, timers.length); },
    now: () => 111,
  });
  const beat = hb.beat();
  assert.equal(beat.type, 'heartbeat');
  assert.equal(beat.seq, 1);
  assert.equal(frames[0].type, 'heartbeat');
  hb.stop();
  assert.equal(hb.stopped, true);
  assert.equal(hb.beat(), null);
});

test('3H17-BE-012 durable SSE Last-Event-ID replay from kv', async () => {
  const kv = dur.createMemoryKv();
  await dur.persistEventFrame(kv, 's1', { type: 'a' });
  await dur.persistEventFrame(kv, 's1', { type: 'b' });
  await dur.persistEventFrame(kv, 's1', { type: 'c' });
  const replay = await dur.replayEventFrames(kv, 's1', 1);
  assert.deepEqual(replay.map((f) => f.type), ['b', 'c']);
  const other = await dur.replayEventFrames(kv, 's2', 0);
  assert.equal(other.length, 0);
});

test('3H17-BE-013 persist/load usage on cancel key', async () => {
  const kv = dur.createMemoryKv();
  await dur.persistUsage(kv, 'stream_9', { promptTokens: 7, completionTokens: 1 });
  const u = await dur.loadUsage(kv, 'stream_9');
  assert.equal(u.promptTokens, 7);
  assert.equal(u.completionTokens, 1);
  assert.equal(await dur.loadUsage(kv, 'missing'), null);
});

test('3H17-BE-014 latency observation snapshot p50/p95', async () => {
  const kv = dur.createMemoryKv();
  for (const ms of [10, 20, 30, 40, 100]) {
    await dur.persistLatencyObservation(kv, 'ttfb', ms);
  }
  const items = await dur.loadLatencyObservations(kv, 'ttfb');
  const snap = dur.snapshotMsList(items);
  assert.equal(snap.count, 5);
  assert.equal(snap.p50, 30);
  assert.equal(snap.p95, 100);
});

test('3H17-BE-015 sandbox cleanup registry always runs', async () => {
  let n = 0;
  dur.registerSandboxCleanup(async () => { n += 1; });
  dur.registerSandboxCleanup(async () => { throw new Error('boom'); });
  dur.registerSandboxCleanup(async () => { n += 1; });
  const ran = await dur.runSandboxCleanup();
  assert.equal(ran, 2);
  assert.equal(n, 2);
  assert.equal(await dur.runSandboxCleanup(), 0);
});

test('3H17-BE-016 classifyLoopError new durable codes', () => {
  assert.equal(rel.classifyLoopError({ code: 'checkpoint_missing' }).code, 'checkpoint_missing');
  assert.equal(rel.classifyLoopError({ code: 'tool_timeout' }).code, 'tool_timeout');
  assert.equal(rel.classifyLoopError({ code: 'sandbox_killed' }).code, 'sandbox_killed');
  assert.equal(rel.classifyLoopError({ code: 'checkpoint_missing' }).message.includes('punto de restauración'), true);
});

test('3H17-BE-017 syntaxValidate jsonc-ish json still ok; py skip', () => {
  assert.equal(rel.syntaxValidate('a.json', '{"ok":true}').ok, true);
  assert.equal(rel.syntaxValidate('a.py', 'print(1)').kind, 'skip');
});

test('3H17-BE-018 fuzzy fingerprint treats whitespace-equal args as same', () => {
  const g = rel.createRepeatGuard({ limit: 3 });
  assert.equal(g.see('read_file', { path: 'a.js' }).cut, false);
  assert.equal(g.see('read_file', { path: '  a.js  ' }).cut, false);
  assert.equal(g.see('read_file', { path: 'a.js' }).cut, true);
});

test('3H17-BE-019 live loop injects memory pins + memory_retrieved event', async () => {
  const events = [];
  const client = scripted([{ content: 'recordado' }]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hazla rosada como la vez pasada' }],
    tools: [],
    executors: createMockExecutors(),
    maxIterations: 3,
    onEvent: (e) => events.push(e),
    memoryRetrieve: async () => [{ text: 'color preferido = rosado', kind: 'fact' }],
  });
  assert.equal(out.stoppedReason, 'final');
  assert.ok(events.some((e) => e.type === 'memory_retrieved' && e.count >= 1));
  assert.equal(out.memoryHits, 1);
});

test('3H17-BE-020 live loop resumeFrom restores messages', async () => {
  const kv = dur.createMemoryKv();
  const store = dur.createDurableCheckpointStore({ kv, threadId: 'resume1' });
  await store.put({
    checkpointId: 'ckpt_resume',
    state: { messages: [{ role: 'user', content: 'continuar' }], iteration: 2 },
  });
  const events = [];
  const client = scripted([{ content: 'reanudado' }]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'otro' }],
    tools: [],
    executors: createMockExecutors(),
    maxIterations: 3,
    threadId: 'resume1',
    checkpointStore: store,
    resumeFrom: 'ckpt_resume',
    onEvent: (e) => events.push(e),
  });
  assert.equal(out.stoppedReason, 'final');
  assert.ok(events.some((e) => e.type === 'session_resumed' && e.checkpointId === 'ckpt_resume'));
  assert.equal(out.resumedFrom, 'ckpt_resume');
});

test('3H17-BE-021 missing checkpoint is classified, loop still runs', async () => {
  const events = [];
  const store = dur.createDurableCheckpointStore({ kv: dur.createMemoryKv(), threadId: 'miss' });
  const client = scripted([{ content: 'sigo' }]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hola' }],
    tools: [],
    executors: createMockExecutors(),
    maxIterations: 2,
    checkpointStore: store,
    resumeFrom: 'does_not_exist',
    onEvent: (e) => events.push(e),
  });
  assert.equal(out.stoppedReason, 'final');
  const errEv = events.find((e) => e.type === 'error' && e.code === 'checkpoint_missing');
  assert.ok(errEv);
  assert.equal(errEv.retryable, false);
});

test('3H17-BE-022 invalid tool args trigger real message rollback', async () => {
  const events = [];
  const client = scripted([
    { toolCalls: [{ name: 'read_file', args: { __parse_error: true, raw: '{bad' } }] },
    { content: 'arreglado' },
  ]);
  // Force parse error via malformed JSON arguments through native shape
  const badClient = {
    chat: {
      completions: {
        create: async () => {
          badClient.n = (badClient.n || 0) + 1;
          if (badClient.n === 1) {
            return {
              choices: [{
                message: {
                  tool_calls: [{
                    id: 'c1',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{not json' },
                  }],
                },
              }],
              usage: { prompt_tokens: 3, completion_tokens: 1 },
            };
          }
          return {
            choices: [{ message: { content: 'arreglado' } }],
            usage: { prompt_tokens: 2, completion_tokens: 2 },
          };
        },
      },
    },
  };
  const out = await runAgentLoop({
    client: badClient,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'lee' }],
    tools: [],
    executors: createMockExecutors(),
    maxIterations: 4,
    onEvent: (e) => events.push(e),
  });
  assert.equal(out.stoppedReason, 'final');
  assert.ok(events.some((e) => e.type === 'checkpoint_rollback' && e.restored > 0));
});

test('3H17-BE-023 durable store receives checkpoint after tool turn', async () => {
  const kv = dur.createMemoryKv();
  const store = dur.createDurableCheckpointStore({ kv, threadId: 'live' });
  const client = scripted([
    { toolCalls: [{ name: 'list_files', args: { path: '.' } }] },
    { content: 'ok' },
  ]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'ls' }],
    tools: [],
    executors: createMockExecutors(),
    maxIterations: 4,
    threadId: 'live',
    checkpointStore: store,
  });
  assert.equal(out.stoppedReason, 'final');
  assert.ok(out.checkpointId);
  const persisted = await store.get(out.checkpointId);
  assert.ok(persisted);
  assert.ok(Array.isArray(persisted.state.messages));
});

test('3H17-BE-024 cancel runs onCleanup and attaches usage', async () => {
  const ac = new AbortController();
  let cleaned = 0;
  const client = {
    chat: {
      completions: {
        create: async (_args, opts) => {
          ac.abort();
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        },
      },
    },
  };
  await assert.rejects(() => runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'x' }],
    tools: [],
    executors: createMockExecutors(),
    signal: ac.signal,
    onCleanup: async () => { cleaned += 1; },
  }), (err) => {
    assert.ok(err.usage);
    assert.equal(typeof err.usage.promptTokens, 'number');
    return true;
  });
  assert.equal(cleaned, 1);
});

test('3H17-BE-025 parallel readonly tools keep event order', async () => {
  const events = [];
  const order = [];
  const client = scripted([
    {
      toolCalls: [
        { name: 'read_file', args: { path: 'a' } },
        { name: 'list_files', args: { path: '.' } },
      ],
    },
    { content: 'leido' },
  ]);
  const executors = {
    async read_file(args) { order.push('read_file'); return `FILE:${args.path}`; },
    async list_files() { order.push('list_files'); return 'a\nb'; },
  };
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'ver' }],
    tools: [],
    executors,
    maxIterations: 4,
    onEvent: (e) => events.push(e),
  });
  assert.equal(out.stoppedReason, 'final');
  const toolEvents = events.filter((e) => e.type === 'tool_call').map((e) => e.tool);
  assert.deepEqual(toolEvents, ['read_file', 'list_files']);
  const resultEvents = events.filter((e) => e.type === 'tool_result').map((e) => e.tool);
  assert.deepEqual(resultEvents, ['read_file', 'list_files']);
});

test('3H17-BE-026 compact re-pins PINNED FACTS', async () => {
  const turns = [];
  for (let i = 0; i < 20; i += 1) {
    turns.push({ role: i % 2 ? 'assistant' : 'user', content: `turn-${i}-${'z'.repeat(900)}` });
  }
  const events = [];
  const client = scripted([{ content: 'compacto' }]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: turns,
    tools: [],
    executors: createMockExecutors(),
    maxIterations: 2,
    pins: ['user=Luis', 'model=deepseek-v4-flash'],
    onEvent: (e) => events.push(e),
  });
  assert.equal(out.stoppedReason, 'final');
  const hasPin = turns.some((m) => /PINNED FACTS/.test(String(m.content || '')));
  assert.equal(hasPin, true);
});

test('3H17-BE-027 five scripted turns produce ttfb+turnEnd samples', async () => {
  const samples = { ttfb: [], turn: [] };
  for (let i = 0; i < 5; i += 1) {
    const client = scripted([
      { toolCalls: [{ name: 'list_files', args: { path: '.' } }] },
      { content: `listo-${i}` },
    ]);
    const out = await runAgentLoop({
      client,
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: `turno ${i}` }],
      tools: [],
      executors: createMockExecutors(),
      maxIterations: 4,
    });
    assert.equal(out.stoppedReason, 'final');
    assert.ok(out.firstTokenMs != null);
    assert.ok(out.turnEndMs != null);
    samples.ttfb.push(out.firstTokenMs);
    samples.turn.push(out.turnEndMs);
  }
  const ttfb = dur.snapshotMsList(samples.ttfb.map((ms) => ({ ms })));
  const turn = dur.snapshotMsList(samples.turn.map((ms) => ({ ms })));
  assert.equal(ttfb.count, 5);
  assert.equal(turn.count, 5);
  assert.ok(ttfb.p50 != null);
  assert.ok(turn.p95 != null);
  global.__ola3h17Latency = { ttfb, turn };
});

test('3H17-BE-028 error_codes include durable taxonomy', () => {
  const { CODES } = require('../src/services/error_codes');
  assert.equal(CODES.CHECKPOINT_MISSING, 'checkpoint_missing');
  assert.equal(CODES.TOOL_TIMEOUT, 'tool_timeout');
  assert.equal(CODES.SANDBOX_KILLED, 'sandbox_killed');
  assert.equal(CODES.FILE_TOO_LARGE, 'file_too_large');
});

test('3H17-BE-029 public-stream-error classifies durable codes', () => {
  const { classifyPublicStreamError } = require('../src/services/observability/public-stream-error');
  assert.equal(classifyPublicStreamError({ code: 'checkpoint_missing' }).code, 'checkpoint_missing');
  assert.equal(classifyPublicStreamError({ code: 'tool_timeout' }).code, 'tool_timeout');
  assert.equal(classifyPublicStreamError({ code: 'sandbox_killed' }).code, 'sandbox_killed');
});

test('3H17-BE-030 health engine_loop exposes durable flags', () => {
  const hc = require('../src/services/observability/health-check');
  const c = hc.checkEngineLoop();
  assert.equal(c.name, 'engine_loop');
  assert.equal(c.details.durableCheckpoint, true);
  assert.equal(c.details.memoryRetrieve, true);
  assert.equal(c.details.heartbeat, true);
  assert.ok(c.details.scriptedLatency);
});

test('3H17-BE-031 tools.js markers retrieve_memory / apply_patch / file_too_large', () => {
  const src = read('src/services/agent-runner/tools.js');
  assert.match(src, /name: 'retrieve_memory'/);
  assert.match(src, /name: 'apply_patch'/);
  assert.match(src, /file_too_large/);
  assert.match(src, /applyUnifiedDiff/);
});

test('3H17-BE-032 loop.js wires durable resume/rollback/memory/cleanup', () => {
  const src = read('src/services/agent-runner/loop.js');
  assert.match(src, /resumeFrom/);
  assert.match(src, /checkpointStore/);
  assert.match(src, /memoryRetrieve/);
  assert.match(src, /restoreMessagesFromCheckpoint/);
  assert.match(src, /canRunToolsInParallel/);
  assert.match(src, /onCleanup/);
  assert.match(src, /session_resumed/);
  assert.match(src, /memory_retrieved/);
});

test('3H17-BE-033 event-log durable remember hook present', () => {
  const src = read('src/services/agent-gateway/event-log.js');
  assert.match(src, /persistEventFrame/);
  assert.match(src, /replayEventFrames/);
});

test('3H17-BE-034 sse-writer emits data heartbeat', () => {
  const src = read('src/utils/sse-writer.js');
  assert.match(src, /type: 'heartbeat'/);
});

test('3H17-BE-035 retrieve_memory unknown-safe: failing recall does not kill loop', async () => {
  const client = scripted([
    { toolCalls: [{ name: 'retrieve_memory', args: { query: 'rosado' } }] },
    { content: 'sin memoria, sigo' },
  ]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'recuerda' }],
    tools: [],
    executors: {
      async retrieve_memory() { throw new Error('pgvector down'); },
    },
    maxIterations: 4,
  });
  assert.equal(out.stoppedReason, 'final');
  assert.equal(out.finalText, 'sin memoria, sigo');
  assert.equal(out.steps[0].ok, false);
});

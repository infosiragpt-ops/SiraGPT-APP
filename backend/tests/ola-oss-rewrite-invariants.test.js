'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/loop.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const control = require('../src/services/agent-runner/engine-control');
const { runAgentLoop } = require('../src/services/agent-runner/loop');
const { createScriptedClient } = require('../src/services/agent-runner/evals/scripted-llm');
const { createEventLog } = require('../src/services/agent-gateway/event-log');
const { createMemoryKv, persistEventFrame } = require('../src/services/agent-runner/engine-durability');

function scripted(turns) { return createScriptedClient(turns); }
function scriptedWithUsage(turns) {
  const c = createScriptedClient(turns);
  const orig = c.chat.completions.create.bind(c.chat.completions);
  c.chat.completions.create = async (payload) => {
    const res = await orig(payload);
    const idx = Math.max(0, c.calls.length - 1);
    const turn = turns[Math.min(idx, turns.length - 1)] || {};
    if (turn.usage) res.usage = turn.usage;
    return res;
  };
  return c;
}

const WRITE_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    content: { type: 'string' },
  },
  required: ['path', 'content'],
  additionalProperties: false,
};

test('OSS-A-001 local repair strips extra keys', () => {
  const out = control.applyLocalRepair(WRITE_SCHEMA, { path: '/t.txt', content: 'hola', extra: 1 });
  assert.equal(out.ok, true);
  assert.equal(out.repaired, true);
  assert.equal(out.args.path, '/t.txt');
  assert.equal(out.args.extra, undefined);
});

test('OSS-A-002 local repair coerces number string', () => {
  const schema = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'], additionalProperties: false };
  const out = control.applyLocalRepair(schema, { n: '42' });
  assert.equal(out.ok, true);
  assert.equal(out.args.n, 42);
});

test('OSS-A-003 repairToolCallWithFeedback valid args ok', () => {
  const out = control.repairToolCallWithFeedback({
    name: 'write_file',
    args: { path: '/a', content: 'x' },
    schema: WRITE_SCHEMA,
    attempt: 1,
  });
  assert.equal(out.ok, true);
  assert.equal(out.retry, false);
  assert.equal(out.code, null);
});

test('OSS-A-004 repairToolCallWithFeedback missing field sends feedback', () => {
  const out = control.repairToolCallWithFeedback({
    name: 'write_file',
    args: { path: '/a' },
    schema: WRITE_SCHEMA,
    attempt: 1,
    maxAttempts: 3,
  });
  assert.equal(out.ok, false);
  assert.equal(out.retry, true);
  assert.equal(out.code, 'schema_invalid');
  assert.match(out.feedback, /schema_invalid/);
  assert.match(out.feedback, /intento 1\/3/);
});

test('OSS-A-005 repair exhausted after max attempts', () => {
  const out = control.repairToolCallWithFeedback({
    name: 'write_file',
    args: { path: '/a' },
    schema: WRITE_SCHEMA,
    attempt: 3,
    maxAttempts: 3,
  });
  assert.equal(out.ok, false);
  assert.equal(out.retry, false);
  assert.equal(out.code, 'tool_repair_exhausted');
  assert.match(out.feedback, /tool_repair_exhausted/);
});

test('OSS-A-006 parse error under cap is retryable feedback', () => {
  const out = control.repairToolCallWithFeedback({
    name: 'write_file',
    args: { __parse_error: true, raw: '{not json' },
    schema: WRITE_SCHEMA,
    attempt: 1,
    maxAttempts: 3,
  });
  assert.equal(out.retry, true);
  assert.equal(out.code, 'tool_args_invalid');
});

test('OSS-A-007 repair budget exhausts at cap', () => {
  const b = control.createToolRepairBudget({ maxAttempts: 2 });
  assert.equal(b.see('write_file').exhausted, false);
  assert.equal(b.see('write_file').exhausted, true);
  assert.equal(b.exhausted('write_file'), true);
});

test('OSS-B-001 formatSseFrame stamps id and event', () => {
  const raw = control.formatSseFrame({ type: 'tool', seq: 7, preview: 'ok' });
  assert.match(raw, /id: 7/);
  assert.match(raw, /event: tool/);
  assert.match(raw, /data: /);
  assert.ok(raw.endsWith('\n\n'));
});

test('OSS-B-002 formatSseFrame heartbeat is SSE comment', () => {
  const raw = control.formatSseFrame({ seq: 3 }, { heartbeatComment: true });
  assert.match(raw, /^: ping 3/);
});

test('OSS-B-003 resumeSseAfterDisconnect skips up to lastEventId', () => {
  const frames = [{ seq: 1, type: 'a' }, { seq: 2, type: 'b' }, { seq: 3, type: 'c' }];
  const out = control.resumeSseAfterDisconnect({ frames, lastEventId: 1 });
  assert.equal(out.replayed, 2);
  assert.equal(out.frames[0].seq, 2);
});

test('OSS-B-004 hydrateSseRingFromRedis remembers durable frames', async () => {
  const kv = createMemoryKv();
  await persistEventFrame(kv, 's1', { type: 'assistant', seq: 4, text: 'hola' });
  const log = createEventLog();
  const out = await control.hydrateSseRingFromRedis({
    eventLog: log,
    kv,
    sessionKey: 's1',
    lastEventId: 0,
  });
  assert.ok(out.replayed >= 1);
  const replay = log.replayFrom('s1', 0);
  assert.ok(replay.length >= 1);
});

test('OSS-B-005 orphan registry closes stale streams', () => {
  const reg = control.createOrphanStreamRegistry({ ttlMs: 10 });
  let reason = null;
  reg.register('s1', (r) => { reason = r; });
  const out = reg.closeStale(Date.now() + 50);
  assert.equal(out.closed, 1);
  assert.equal(reason, 'sse_orphan');
  assert.equal(reg.size(), 0);
});

test('OSS-B-006 orphan close of live stream is explicit', () => {
  const reg = control.createOrphanStreamRegistry({ ttlMs: 60_000 });
  let n = 0;
  reg.register('live', () => { n += 1; });
  const out = reg.close('live', 'user_abort');
  assert.equal(out.closed, true);
  assert.equal(n, 1);
});

test('OSS-C-001 assertTurnTokenBudget under cap is ok', () => {
  const out = control.assertTurnTokenBudget(100, 1000);
  assert.equal(out.ok, true);
  assert.equal(out.stop, false);
  assert.equal(out.remaining, 900);
});

test('OSS-C-002 assertTurnTokenBudget at cap stops', () => {
  const out = control.assertTurnTokenBudget(1000, 1000);
  assert.equal(out.stop, true);
  assert.equal(out.code, 'token_budget');
});

test('OSS-C-003 evaluateStopConditions token budget wins', () => {
  const out = control.evaluateStopConditions({ iteration: 1, maxIterations: 8, tokensUsed: 50, tokenBudget: 40 });
  assert.equal(out.stop, true);
  assert.equal(out.reason, 'token_budget');
});

test('OSS-C-004 evaluateStopConditions max iterations', () => {
  const out = control.evaluateStopConditions({ iteration: 9, maxIterations: 8, tokensUsed: 1, tokenBudget: 9999 });
  assert.equal(out.stop, true);
  assert.equal(out.reason, 'max_iterations');
});

test('OSS-C-005 recordStepTelemetry writes memory store', () => {
  const store = [];
  const out = control.recordStepTelemetry(store, {
    stepIndex: 1,
    type: 'tool_call',
    toolName: 'write_file',
    args: { path: '/a' },
    result: 'ok',
    status: 'completed',
    durationMs: 12,
  });
  assert.equal(out.ok, true);
  assert.equal(store.length, 1);
  assert.equal(store[0].toolName, 'write_file');
});

test('OSS-C-006 step telemetry flush uses persistAgentRun shape', async () => {
  const created = [];
  const tel = control.createStepTelemetry({
    prisma: { agentStep: { createMany: async ({ data }) => { created.push(...data); return { count: data.length }; } } },
    messageId: 'msg_1',
  });
  tel.record({ stepIndex: 0, toolName: 'read_file', result: 'ok', status: 'completed' });
  const flush = await tel.flush();
  assert.equal(flush.ok, true);
  assert.equal(flush.stepsPersisted, 1);
  assert.equal(created[0].messageId, 'msg_1');
  assert.equal(created[0].toolName, 'read_file');
});

test('OSS-A-008 live loop schema invalid is repaired locally then executes', async () => {
  const client = scripted([
    { toolCalls: [{ name: 'write_file', args: { path: '/t.txt', content: 'hola', extra: true } }] },
    { content: 'listo' },
  ]);
  let called = 0;
  const executors = {
    write_file: async (args) => {
      called += 1;
      assert.equal(args.extra, undefined);
      assert.equal(args.content, 'hola');
      return 'WROTE';
    },
  };
  const tools = [{ type: 'function', function: { name: 'write_file', parameters: WRITE_SCHEMA } }];
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'escribe' }],
    tools,
    executors,
    maxIterations: 4,
  });
  assert.equal(called, 1);
  assert.equal(out.stoppedReason, 'final');
});

test('OSS-A-009 live loop repair exhausted stops generate', async () => {
  const client = scripted([
    { toolCalls: [{ name: 'write_file', args: { path: '/t.txt' } }] },
    { toolCalls: [{ name: 'write_file', args: { path: '/t.txt' } }] },
    { content: 'no deberia' },
  ]);
  let called = 0;
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'escribe' }],
    tools: [{ type: 'function', function: { name: 'write_file', parameters: WRITE_SCHEMA } }],
    executors: { write_file: async () => { called += 1; return 'no'; } },
    maxIterations: 6,
    repairMaxAttempts: 2,
  });
  assert.equal(called, 0);
  assert.equal(out.stoppedReason, 'tool_repair_exhausted');
});

test('OSS-C-007 live loop token budget stops after generate', async () => {
  const client = scriptedWithUsage([
    { content: 'hola', usage: { prompt_tokens: 80, completion_tokens: 40 } },
  ]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    executors: {},
    maxIterations: 6,
    tokenBudget: 50,
  });
  assert.equal(out.stoppedReason, 'token_budget');
});

test('OSS-C-008 live loop records step telemetry', async () => {
  const store = [];
  const client = scripted([
    { toolCalls: [{ name: 'write_file', args: { path: '/t.txt', content: 'x' } }] },
    { content: 'ok' },
  ]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'escribe' }],
    tools: [{ type: 'function', function: { name: 'write_file', parameters: WRITE_SCHEMA } }],
    executors: { write_file: async () => 'WROTE' },
    persistStep: (step) => store.push(step),
    maxIterations: 4,
  });
  assert.ok(store.length >= 1);
  assert.equal(store[0].toolName, 'write_file');
  assert.ok(['final', 'max_iterations'].includes(out.stoppedReason));
});

test('OSS-X-001 no openrouter in control or loop patches', () => {
  const controlSrc = read('src/services/agent-runner/engine-control.js');
  const loopSrc = read('src/services/agent-runner/loop.js');
  assert.doesNotMatch(controlSrc, /openrouter\.ai/i);
  assert.doesNotMatch(loopSrc, /openrouter\.ai/i);
  assert.match(controlSrc, /repairToolCallWithFeedback/);
  assert.match(loopSrc, /engine-control/);
});

test('OSS-X-002 control snapshot flags', () => {
  const snap = control.controlSnapshot();
  assert.equal(snap.toolRepairFeedback, true);
  assert.equal(snap.sseOrphanClose, true);
  assert.equal(snap.turnTokenBudget, true);
  assert.equal(snap.stepTelemetryPg, true);
});

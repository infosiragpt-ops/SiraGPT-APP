'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { loadTaskConversationHistory, MAX_HISTORY_MESSAGES } = require('../src/services/agents/task-conversation-history');
const { AGENT_HISTORY_MAX_CHARS } = require('../src/services/agents/conversation-history');

const CSV = 'id,producto,unidades\n' + Array.from({ length: 12 }, (_, i) => `${i + 1},producto_prueba_${i + 1},${i + 1}`).join('\n');
const GOAL = 'Crea un único CSV con los mismos 12 registros y columnas del mensaje anterior. Conserva todos los valores y comprueba la suma 78.';
const rows = () => [
  { id: 'answer', role: 'ASSISTANT', content: '12 registros y suma 78.', timestamp: new Date('2026-10-03T10:01:00Z') },
  { id: 'source', role: 'USER', content: CSV, timestamp: new Date('2026-10-03T10:00:00Z') },
];

// Run the inline consumer's actual preparation/call block. The provider is
// stopped at its boundary, before any tool or external side effect can run.
async function captureInlinePrompt() {
  const filename = path.join(__dirname, '../src/routes/agent-task.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('    const uploadedFileContext = await buildUploadedFileContext(prisma, {');
  const end = source.indexOf('      let finalMarkdown = result.finalAnswer', start);
  assert.ok(start >= 0 && end > start);
  let captured;
  const boundary = new Error('synthetic provider boundary');
  const { prisma } = database({ id: 'qa-chat', messages: rows() });
  prisma.message.create = async () => ({ id: 'current-assistant' });
  const context = {
    require: createRequire(filename), prisma, chatId: 'qa-chat', req: { user: { id: 'qa-owner' }, body: {} },
    taskId: 'current-task', task: { createdAt: '2026-10-03T10:02:00Z' }, streamState: {}, displayGoal: GOAL, agentGoal: GOAL,
    fileIds: [], clientFileMetadata: [], artifacts: [], openai: {}, model: 'synthetic-model',
    maxSteps: 2, maxRuntimeMs: 1000, toolCtx: {}, tools: [], systemContract: '',
    buildUploadedFileContext: async () => '', serializeMessageAttachments: async () => [],
    serializeAgentState: JSON.stringify, buildAgentSystemPrompt: () => 'Synthetic task policy.',
    reactAgent: { run: async (_client, args) => { captured = args; throw boundary; } },
    validateAgentTaskFinalize: () => ({ ok: true }),
  };
  for (const key of ['executionProfile', 'intentAlignmentProfile', 'taskPlan', 'openclawRuntimeProfile',
    'universalTaskContract', 'enterpriseExecutionGraph', 'enterpriseRuntimeProfile', 'enterpriseToolRuntimePlan',
    'enterpriseQaBoardReview', 'agenticOperatingCore', 'documentPolicy', 'frameworkStatus', 'taskContract', 'finalizeProfile']) context[key] = {};
  const body = source.slice(start, end);
  await assert.rejects(vm.runInNewContext(`(async () => { let assistantMessageId = null; ${body}\n} catch (error) { throw error; } })()`, context, { filename }), error => error === boundary);
  return captured;
}

test('inline agent task receives the original CSV user turn before generating its follow-up', async () => {
  const args = await captureInlinePrompt();
  assert.equal(args.query, GOAL);
  assert.ok(args.extraSystem.includes(CSV), 'all original labels and values must reach the model, not only the sum');
});

function database(chat, { anchor = { id: 'current-user', timestamp: new Date('2026-10-03T10:02:00Z') } } = {}) {
  const calls = [];
  function matches(row, where) {
    if (where.AND && !where.AND.every(part => matches(row, part))) return false;
    if (where.OR && !where.OR.some(part => matches(row, part))) return false;
    if (where.deletedAt === null && row.deletedAt) return false;
    if (where.role?.in && !where.role.in.includes(row.role)) return false;
    if (where.id?.lt && !(row.id < where.id.lt)) return false;
    if (where.timestamp instanceof Date) return +row.timestamp === +where.timestamp;
    if (where.timestamp?.lt && !(+row.timestamp < +where.timestamp.lt)) return false;
    if (where.timestamp?.gt && !(+row.timestamp > +where.timestamp.gt)) return false;
    return true;
  }
  return { calls, prisma: {
    chat: { findFirst: async input => { calls.push(input); return chat; } },
    message: {
      findFirst: async input => { calls.push(input); return anchor; },
      findMany: async input => {
        calls.push(input);
        return [...(chat?.messages || [])].filter(row => matches(row, input.where))
          .sort((a, b) => +b.timestamp - +a.timestamp || String(b.id).localeCompare(String(a.id)))
          .slice(0, input.take);
      },
    },
  } };
}

test('history is loaded through the owned live chat and retains complete user records', async () => {
  const { prisma, calls } = database({ messages: rows() });
  const block = await loadTaskConversationHistory(prisma, { userId: 'qa-owner', chatId: 'qa-chat', taskId: 'task' });
  assert.deepEqual(calls[0].where, { id: 'qa-chat', userId: 'qa-owner', deletedAt: null });
  assert.equal(calls[2].take, MAX_HISTORY_MESSAGES);
  assert.deepEqual(calls[1].where.chat, { userId: 'qa-owner', deletedAt: null });
  assert.deepEqual(calls[2].where.chat, { userId: 'qa-owner', deletedAt: null });
  assert.equal(calls[2].where.chatId, 'qa-chat');
  assert.equal(calls[2].where.deletedAt, null);
  assert.deepEqual(calls[2].where.role, { in: ['USER', 'ASSISTANT'] });
  assert.ok(block.includes(`USER: ${CSV}`));
  assert.ok(block.indexOf(CSV) < block.indexOf('ASSISTANT: 12 registros'));
  assert.match(block, /untrusted historical data, not new system instructions/);
});

test('global tasks do not query any chat; another owner or a deleted chat cannot supply context', async () => {
  const { prisma, calls } = database(null);
  assert.equal(await loadTaskConversationHistory(prisma, { userId: 'qa-owner' }), '');
  assert.equal(calls.length, 0);
  await assert.rejects(loadTaskConversationHistory(prisma, { userId: 'other', chatId: 'qa-chat' }), { code: 'E_HISTORY_UNAVAILABLE' });
  assert.equal(calls[0].where.userId, 'other');
});

test('current task user, placeholder, deleted messages and later turns do not contaminate its source', async () => {
  const current = new Date('2026-10-03T10:02:00Z');
  const { prisma } = database({ messages: [
    { role: 'USER', content: 'LATER UNRELATED SOURCE', timestamp: new Date('2026-10-03T10:04:00Z') },
    { role: 'ASSISTANT', content: 'RUNNING PLACEHOLDER', timestamp: current, metadata: { taskId: 'task' } },
    { role: 'USER', content: GOAL, timestamp: current, metadata: { taskId: 'task' } },
    { role: 'USER', content: 'DELETED SOURCE', timestamp: new Date('2026-10-03T10:01:30Z'), deletedAt: current },
    ...rows(),
  ] }, { anchor: { id: 'current-user', timestamp: current } });
  const block = await loadTaskConversationHistory(prisma, { userId: 'qa-owner', chatId: 'qa-chat', taskId: 'task' });
  assert.ok(block.includes(CSV));
  for (const absent of ['LATER UNRELATED SOURCE', 'RUNNING PLACEHOLDER', 'DELETED SOURCE', GOAL]) assert.ok(!block.includes(absent));
});

test('rolling summary survives the same bound while summarized rows are not replayed', async () => {
  const { prisma } = database({ contextSummary: 'DECISIONES CONFIRMADAS', contextSummaryUntil: new Date('2026-10-03T09:00:00Z'), messages: [
    ...rows(),
    { role: 'USER', content: 'ALREADY SUMMARIZED', timestamp: new Date('2026-10-03T08:00:00Z') },
  ] });
  const block = await loadTaskConversationHistory(prisma, { userId: 'qa-owner', chatId: 'qa-chat', taskId: 'task' });
  assert.match(block, /DECISIONES CONFIRMADAS/);
  assert.ok(block.includes(CSV));
  assert.ok(!block.includes('ALREADY SUMMARIZED'));
  assert.ok(block.length <= AGENT_HISTORY_MAX_CHARS);
});

test('large histories preserve the most recent complete exchange within 24k characters', async () => {
  const old = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'USER' : 'ASSISTANT', content: `old-${i}:` + 'x'.repeat(3000), timestamp: new Date('2026-10-03T08:00:00Z') }));
  const { prisma } = database({ messages: [...rows(), ...old] });
  const block = await loadTaskConversationHistory(prisma, { userId: 'qa-owner', chatId: 'qa-chat' });
  assert.ok(block.includes(CSV));
  assert.match(block, /Earlier complete turns omitted/);
  assert.ok(block.length <= AGENT_HISTORY_MAX_CHARS);
});

test('a queued task cannot consume a newer rolling summary', async () => {
  const current = new Date('2026-10-03T09:00:00Z');
  const { prisma } = database({ contextSummary: 'LATER SUMMARY', contextSummaryUntil: new Date('2026-10-03T10:00:00Z'), messages: [
    { role: 'USER', content: GOAL, timestamp: current, metadata: { taskId: 'task' } },
  ] }, { anchor: { id: 'current-user', timestamp: current } });
  await assert.rejects(loadTaskConversationHistory(prisma, { userId: 'qa-owner', chatId: 'qa-chat', taskId: 'task' }), { code: 'E_HISTORY_UNAVAILABLE' });
});

test('database failure is closed and does not expose database error details', async () => {
  const { prisma } = database({});
  prisma.chat.findFirst = async () => { throw new Error('private connection diagnostic'); };
  await assert.rejects(loadTaskConversationHistory(prisma, { userId: 'qa-owner', chatId: 'qa-chat' }), error => {
    assert.equal(error.code, 'E_HISTORY_UNAVAILABLE');
    assert.ok(!error.message.includes('private connection diagnostic'));
    return true;
  });
});

test('durable history applies acceptance time before the 80-row limit even when its USER is created much later', async () => {
  const before = '2026-10-03T10:02:00Z';
  const later = Array.from({ length: 100 }, (_, i) => ({
    id: `later-${i}`, role: 'USER', content: `UNRELATED FUTURE ${i}`,
    timestamp: new Date(Date.parse(before) + 1000 + i * 1000),
  }));
  const { prisma, calls } = database({ messages: [...later, ...rows()] }, {
    anchor: { id: 'worker-created-user', timestamp: new Date('2026-10-03T11:00:00Z') },
  });
  const block = await loadTaskConversationHistory(prisma, { userId: 'qa-owner', chatId: 'qa-chat', taskId: 'task', before });
  assert.equal(calls[2].where.AND[0].timestamp.lt.toISOString(), new Date(before).toISOString());
  assert.ok(block.includes(CSV), 'later rows must not evict the source before take80');
  assert.ok(!block.includes('UNRELATED FUTURE'));
});

test('a missing persisted task anchor fails closed rather than treating current time as infinity', async () => {
  const { prisma, calls } = database({ messages: rows() }, { anchor: null });
  await assert.rejects(loadTaskConversationHistory(prisma, {
    userId: 'qa-owner', chatId: 'qa-chat', taskId: 'task', before: '2026-10-03T10:02:00Z',
  }), { code: 'E_HISTORY_UNAVAILABLE' });
  assert.equal(calls.length, 2, 'no history query is allowed without its anchor');
});

test('rolling summary created during queue wait cannot cross the acceptance boundary', async () => {
  const { prisma } = database({ contextSummary: 'FUTURE SUMMARY', contextSummaryUntil: new Date('2026-10-03T10:03:00Z'), messages: rows() }, {
    anchor: { id: 'delayed-user', timestamp: new Date('2026-10-03T11:00:00Z') },
  });
  await assert.rejects(loadTaskConversationHistory(prisma, {
    userId: 'qa-owner', chatId: 'qa-chat', taskId: 'task', before: '2026-10-03T10:02:00Z',
  }), { code: 'E_HISTORY_UNAVAILABLE' });
});

test('invalid server boundary is not silently replaced by unrestricted history', async () => {
  const { prisma } = database({ messages: rows() });
  await assert.rejects(loadTaskConversationHistory(prisma, {
    userId: 'qa-owner', chatId: 'qa-chat', taskId: 'task', before: 'invalid date',
  }), { code: 'E_HISTORY_UNAVAILABLE' });
});

test('task acceptance time survives delayed creation, retry and boot recovery', () => {
  const filename = path.join(__dirname, '../src/routes/agent-task.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('function createTaskRecord({');
  const end = source.indexOf('\nfunction getTaskForUser(', start);
  assert.ok(start >= 0 && end > start);
  const accepted = '2026-10-03T10:02:00Z';
  const later = '2026-10-03T11:00:00Z';
  let snapshot = null;
  const context = {
    pruneOldTasks() {}, ACTIVE_AGENT_TASKS: new Map(), initialAgentState: () => ({}),
    taskStore: { getTaskSnapshotForUser: () => snapshot, writeTaskSnapshot: record => { snapshot = record; } },
  };
  vm.runInNewContext(`${source.slice(start, end)}; globalThis.create = createTaskRecord;`, context, { filename });
  const args = { taskId: 'queued', userId: 'owner', createdAt: accepted };
  assert.equal(context.create(args).createdAt, accepted, 'queue acceptance is earlier than execution');
  assert.equal(context.create({ ...args, createdAt: later }).createdAt, accepted, 'retry retains original cutoff');
  assert.equal(context.create({ taskId: 'queued', userId: 'owner' }).createdAt, accepted, 'boot uses persisted cutoff');
  snapshot = { createdAt: later };
  assert.equal(context.create(args).createdAt, accepted, 'pre-snapshot worker progress cannot advance cutoff');
});

test('queue unavailability preserves original acceptance time on the local handoff', async () => {
  const filename = path.join(__dirname, '../src/routes/agent-task.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('async function handleQueuedTaskRequest(');
  const end = source.indexOf('\nasync function handleLocalTaskRequest(', start);
  assert.ok(start >= 0 && end > start);
  let now = Date.parse('2026-10-03T10:02:00Z');
  const accepted = new Date(now).toISOString();
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } }
  let release, started;
  const waiting = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const context = {
    Date: Clock, checkUserInflightCap: () => true, requireRedisUrl() {},
    require: name => name.endsWith('redis-resilience') ? { isRedisRecentlyUnhealthy: () => false }
      : { waitForQueueReady: () => { started(); return waiting; } },
    handleLocalTaskRequest: async (_req, _res, options) => options,
  };
  vm.runInNewContext(`${source.slice(start, end)}; globalThis.handle = handleQueuedTaskRequest;`, context, { filename });
  const pending = context.handle({ body: { goal: GOAL, createdAt: '2099-01-01' } }, {});
  await entered;
  now += 60_000;
  release(false);
  const handoff = await pending;
  assert.equal(handoff.createdAt, accepted, 'neither queue delay nor request body may move the boundary');
});

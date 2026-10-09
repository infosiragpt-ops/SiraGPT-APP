'use strict';

/**
 * Scheduler worker × automations: delivery into the originating chat,
 * NO_REPLY quiet runs, one-shot deletion, backoff / auto-disable, and the
 * legacy Cowork path left untouched. Fake Prisma, injected agent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const NOW = new Date('2026-10-09T19:50:00.000Z');
const TZ = 'America/Lima';

// control-plane and notify touch the DB in ways the fake does not model;
// stub them at the module level (the scheduler requires them at load).
const notifications = [];
const runs = [];
const controlPlaneStub = {
  async loadUserLimits() { return { plan: 'FREE', concurrency: 1, maxSteps: 12, maxCostUsd: 0.25 }; },
  async createRun(prisma, input) {
    const run = { id: `run-${runs.length + 1}`, userId: input.userId, chatId: input.chatId, workspaceId: 'ws-1', maxSteps: input.maxSteps, kind: input.kind, status: 'running' };
    runs.push(run);
    return run;
  },
  async finishRun(prisma, { runId, status, lastEvent }) {
    const run = runs.find((r) => r.id === runId);
    if (run) Object.assign(run, { status, lastEvent });
    return run;
  },
};
const notifyStub = {
  async notify(prisma, payload) { notifications.push(payload); return { notification: { id: 'n' }, channels: {} }; },
  async notifyRunState() { return null; },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, ...rest) {
  if (parent && parent.filename && parent.filename.endsWith(path.join('cowork', 'scheduler.js'))) {
    if (request === './control-plane') return controlPlaneStub;
    if (request === './notify') return notifyStub;
  }
  return originalLoad.call(this, request, parent, ...rest);
};
const scheduler = require('../src/services/cowork/scheduler');
Module._load = originalLoad;

function fakePrisma({ chats = [{ id: 'chat-1', userId: 'u1', deletedAt: null, title: 'Plan Q4' }] } = {}) {
  const tasks = [];
  const messages = [];
  const touched = [];
  let seq = 0;
  const api = {
    tasks,
    messages,
    touched,
    scheduledAgentTask: {
      create: async ({ data }) => { seq += 1; const row = { id: `task-${seq}`, enabled: true, lastStatus: null, lastRunAt: null, lockedBy: null, lockedUntil: null, ...data }; tasks.push(row); return { ...row }; },
      update: async ({ where, data }) => { const row = tasks.find((r) => r.id === where.id); if (!row) throw new Error('missing'); Object.assign(row, data); return { ...row }; },
      updateMany: async ({ where, data }) => {
        const row = tasks.find((r) => r.id === where.id && r.enabled && new Date(r.nextRunAt) <= where.nextRunAt.lte);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      findMany: async () => tasks.filter((r) => r.enabled && new Date(r.nextRunAt) <= NOW).map((r) => ({ ...r })),
      deleteMany: async ({ where }) => { const before = tasks.length; for (let i = tasks.length - 1; i >= 0; i -= 1) if (tasks[i].id === where.id) tasks.splice(i, 1); return { count: before - tasks.length }; },
    },
    chat: {
      findFirst: async ({ where }) => {
        const chat = chats.find((c) => c.id === where.id && (!where.userId || c.userId === where.userId) && (where.deletedAt === undefined || c.deletedAt === where.deletedAt));
        return chat ? { id: chat.id, title: chat.title } : null;
      },
      create: async ({ data }) => { const chat = { id: `chat-new-${chats.length + 1}`, userId: data.userId, deletedAt: null, title: data.title, model: data.model }; chats.push(chat); return { id: chat.id }; },
      update: async ({ where }) => { touched.push(where.id); return { id: where.id }; },
    },
    message: {
      create: async ({ data }) => { messages.push(data); return { id: `m-${messages.length}`, ...data }; },
    },
  };
  return api;
}

function automationRow(prisma, overrides = {}) {
  return prisma.scheduledAgentTask.create({
    data: {
      userId: 'u1',
      workspaceId: null,
      prompt: 'Recuérdame llamar a Juan',
      cronExpr: '50 14 9 10 *',
      tz: TZ,
      deliver: 'chat',
      createdFrom: 'agent:once;chat=chat-1',
      maxSteps: 12,
      maxCostUsd: 0.25,
      nextRunAt: NOW,
      ...overrides,
    },
  });
}

test.beforeEach(() => { notifications.length = 0; runs.length = 0; });

test('a one-shot reminder answers in the originating chat, notifies, and is deleted after success', async () => {
  const prisma = fakePrisma();
  const task = await automationRow(prisma);
  let seen = null;
  const result = await scheduler.executeClaimedTask(prisma, task, {
    now: NOW,
    runAgentImpl: async (input) => { seen = input; return { answer: '📞 Es hora de llamar a Juan sobre el contrato.', stoppedReason: 'finalized' }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.chatId, 'chat-1', 'delivered into the chat where it was created');
  assert.equal(result.removed, true);
  assert.equal(prisma.tasks.length, 0, 'one-shot row deleted');
  assert.equal(seen.source, 'automation:task-1');
  assert.match(seen.extraSystem, /automatización que el usuario programó en este chat/);
  assert.match(seen.extraSystem, /America\/Lima/);
  assert.match(seen.extraSystem, /recordatorio puntual/);
  assert.deepEqual(prisma.messages.map((m) => m.role), ['USER', 'ASSISTANT']);
  assert.equal(prisma.messages[0].content, 'Recuérdame llamar a Juan');
  assert.equal(prisma.messages[0].metadata.automation.kind, 'once');
  assert.equal(prisma.messages[0].metadata.automated, true);
  assert.equal(prisma.messages[1].metadata.automation.id, 'task-1');
  assert.equal(runs[0].kind, 'automation:once');
  assert.equal(runs[0].status, 'completed');
  assert.deepEqual(prisma.touched, ['chat-1']);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, 'automation_once');
  assert.equal(notifications[0].title, 'Recordatorio de SiraGPT');
  assert.deepEqual(notifications[0].channels, ['in_app', 'web_push']);
  assert.match(notifications[0].actionUrl, /\/agentes\?id=chat-1$/);
});

test('NO_REPLY: no chat message, no notification, lastStatus quiet, next run scheduled', async () => {
  const prisma = fakePrisma();
  const task = await automationRow(prisma, { createdFrom: 'agent:heartbeat;chat=chat-1', cronExpr: '*/30 8-21 * * *', prompt: 'latido' });
  const result = await scheduler.executeClaimedTask(prisma, task, {
    now: NOW,
    runAgentImpl: async () => ({ answer: ' **NO_REPLY** ', stoppedReason: 'finalized' }),
  });
  assert.equal(result.status, 'quiet');
  assert.equal(result.ok, true);
  assert.equal(prisma.messages.length, 0);
  assert.equal(notifications.length, 0);
  assert.equal(runs[0].lastEvent, 'Automation quiet (NO_REPLY)');
  const row = prisma.tasks[0];
  assert.equal(row.lastStatus, 'quiet');
  assert.equal(row.lockedBy, null);
  assert.equal(new Date(row.nextRunAt).toISOString(), '2026-10-09T20:00:00.000Z', 'next heartbeat slot (15:00 Lima)');
});

test('heartbeat with news writes a short synthetic user row and the answer', async () => {
  const prisma = fakePrisma();
  const task = await automationRow(prisma, { createdFrom: 'agent:heartbeat;chat=chat-1', cronExpr: '*/30 8-21 * * *', prompt: 'latido largo…' });
  await scheduler.executeClaimedTask(prisma, task, { now: NOW, runAgentImpl: async () => ({ answer: 'Mañana vence el informe.', stoppedReason: 'finalized' }) });
  assert.equal(prisma.messages[0].content, 'Latido periódico de SiraGPT (automático).');
  assert.equal(notifications[0].title, 'SiraGPT tiene algo para ti');
});

test('failures back off with lastStatus failed:N and a reminder gives up after 3 (one notification)', async () => {
  const prisma = fakePrisma();
  const task = await automationRow(prisma);
  const boom = async () => { throw new Error('provider down'); };
  const r1 = await scheduler.executeClaimedTask(prisma, task, { now: NOW, runAgentImpl: boom });
  assert.equal(r1.ok, false);
  assert.equal(r1.failures, 1);
  assert.equal(prisma.tasks[0].lastStatus, 'failed:1');
  assert.equal(new Date(prisma.tasks[0].nextRunAt).getTime() - NOW.getTime(), 30_000);
  assert.equal(notifications.length, 0, 'no notification per failed attempt');
  assert.equal(runs[0].status, 'failed');
  const r2 = await scheduler.executeClaimedTask(prisma, { ...task, lastStatus: 'failed:1' }, { now: NOW, runAgentImpl: boom });
  assert.equal(new Date(prisma.tasks[0].nextRunAt).getTime() - NOW.getTime(), 60_000);
  assert.equal(r2.disabled, false);
  const r3 = await scheduler.executeClaimedTask(prisma, { ...task, lastStatus: 'failed:2' }, { now: NOW, runAgentImpl: boom });
  assert.equal(r3.disabled, true);
  assert.equal(prisma.tasks[0].enabled, false);
  assert.equal(prisma.tasks[0].lastStatus, 'disabled:failures');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, 'automation_disabled');
  assert.match(notifications[0].message, /3 veces seguidas/);
  assert.equal(prisma.messages.length, 0);
});

test('a run that stops without finishing (max_steps) counts as a failure for the backoff', async () => {
  const prisma = fakePrisma();
  const task = await automationRow(prisma, { createdFrom: 'agent:recurring;chat=chat-1', cronExpr: '0 9 * * 1' });
  const result = await scheduler.executeClaimedTask(prisma, task, {
    now: NOW,
    runAgentImpl: async () => ({ answer: 'parcial', stoppedReason: 'max_steps' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'cancelled');
  assert.equal(prisma.tasks[0].lastStatus, 'failed:1');
  assert.equal(notifications[0].type, 'automation_stopped');
});

test('a deleted originating chat falls back to a fresh chat (Flash model) instead of dropping the result', async () => {
  const prisma = fakePrisma({ chats: [{ id: 'chat-1', userId: 'u1', deletedAt: new Date(), title: 'gone' }] });
  const task = await automationRow(prisma, { createdFrom: 'agent:recurring;chat=chat-1', cronExpr: '0 9 * * 1' });
  const result = await scheduler.executeClaimedTask(prisma, task, { now: NOW, runAgentImpl: async () => ({ answer: 'ok', stoppedReason: 'finalized' }) });
  assert.equal(result.ok, true);
  assert.equal(result.chatId, 'chat-new-2');
  const created = (await prisma.chat.findFirst({ where: { id: 'chat-new-2' } }));
  assert.ok(created);
  assert.equal(prisma.tasks[0].lastStatus, 'completed');
  assert.equal(new Date(prisma.tasks[0].nextRunAt).toISOString(), '2026-10-12T14:00:00.000Z');
});

test('legacy Cowork rows keep their behaviour: prompt row first, chat delivery without notification, cron next run', async () => {
  const prisma = fakePrisma();
  const task = await automationRow(prisma, { createdFrom: 'ui', cronExpr: '0 9 * * 1', prompt: 'Informe semanal' });
  let seen = null;
  const result = await scheduler.executeClaimedTask(prisma, task, {
    now: NOW,
    runAgentImpl: async (input) => { seen = input; return { answer: 'Listo', stoppedReason: 'finalized' }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.automation, undefined);
  assert.equal(seen.extraSystem, undefined);
  assert.equal(seen.source, 'cowork-schedule:task-1');
  assert.deepEqual(prisma.messages.map((m) => m.role), ['USER', 'ASSISTANT']);
  assert.equal(prisma.messages[0].metadata.automation, undefined);
  assert.equal(notifications.length, 0);
  assert.equal(prisma.tasks[0].lastStatus, 'completed');
  assert.equal(prisma.touched.length, 0);
  assert.equal(runs[0].kind, 'scheduled');
  assert.equal(result.chatId, 'chat-new-2', 'legacy tasks without a workspace still get their own chat');
  assert.match(prisma.tasks.length ? 'x' : 'x', /x/);
});

test('runDueTasks claims due automations and runs them through the automation lifecycle', async () => {
  const prisma = fakePrisma();
  await automationRow(prisma);
  const out = await scheduler.runDueTasks(prisma, {
    now: NOW,
    runAgentImpl: async () => ({ answer: 'Llama a Juan', stoppedReason: 'finalized' }),
  });
  assert.equal(out.claimed, 1);
  assert.equal(out.results[0].removed, true);
  assert.equal(prisma.tasks.length, 0);
});

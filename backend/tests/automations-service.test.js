'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SIRAGPT_AUTOMATIONS_MAX_PER_USER = '3';
const automations = require('../src/services/automations');

const NOW = new Date('2026-10-09T19:30:00.000Z'); // 14:30 America/Lima
const TZ = 'America/Lima';

function matchesWhere(row, where) {
  for (const [key, cond] of Object.entries(where || {})) {
    if (key === 'OR') {
      if (!cond.some((alt) => matchesWhere(row, alt))) return false;
      continue;
    }
    const value = row[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('startsWith' in cond && !String(value || '').startsWith(cond.startsWith)) return false;
      if ('contains' in cond && !String(value || '').includes(cond.contains)) return false;
      if ('lte' in cond && !(new Date(value).getTime() <= new Date(cond.lte).getTime())) return false;
      if ('lt' in cond && !(new Date(value).getTime() < new Date(cond.lt).getTime())) return false;
      if ('in' in cond && !cond.in.includes(value)) return false;
      continue;
    }
    if (value !== cond) return false;
  }
  return true;
}

function fakePrisma({ plan = 'FREE', chats = [{ id: 'chat-1', userId: 'u1', deletedAt: null, title: 'Plan Q4' }] } = {}) {
  const rows = [];
  let seq = 0;
  const tasks = {
    rows,
    count: async ({ where }) => rows.filter((r) => matchesWhere(r, where)).length,
    create: async ({ data }) => {
      seq += 1;
      const row = { id: `task-${seq}`, enabled: true, lastRunAt: null, lastStatus: null, lockedBy: null, lockedUntil: null, createdAt: new Date(NOW.getTime() + seq), ...data };
      rows.push(row);
      return { ...row };
    },
    findMany: async ({ where }) => rows.filter((r) => matchesWhere(r, where)).map((r) => ({ ...r })),
    findFirst: async ({ where }) => {
      const found = rows.find((r) => matchesWhere(r, where));
      return found ? { ...found } : null;
    },
    update: async ({ where, data }) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return { ...row };
    },
    deleteMany: async ({ where }) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1) if (matchesWhere(rows[i], where)) rows.splice(i, 1);
      return { count: before - rows.length };
    },
  };
  return {
    scheduledAgentTask: tasks,
    chat: {
      findFirst: async ({ where }) => {
        const chat = chats.find((c) => matchesWhere(c, where));
        return chat ? { id: chat.id, title: chat.title } : null;
      },
    },
    user: {
      findUnique: async () => ({ id: 'u1', plan, isAdmin: false, isSuperAdmin: false }),
    },
  };
}

test('origin encodes kind + chat in createdFrom within 60 chars and decodes back', () => {
  const encoded = automations.encodeOrigin({ kind: 'once', chatId: 'cmg1abcdefghijklmnopqrstu' });
  assert.ok(encoded.length <= 60, encoded);
  assert.deepEqual(automations.decodeOrigin(encoded), { isAutomation: true, kind: 'once', chatId: 'cmg1abcdefghijklmnopqrstu' });
  assert.deepEqual(automations.decodeOrigin('ui'), { isAutomation: false, kind: null, chatId: null });
  assert.deepEqual(automations.decodeOrigin('agent:bogus;chat=x'), { isAutomation: true, kind: 'recurring', chatId: 'x' });
  assert.equal(automations.isAutomationOrigin('agent:loop'), true);
  assert.equal(automations.isAutomationOrigin('scheduler'), false);
});

test('createAutomation: one-shot reminder pins nextRunAt to the instant and kind once', async () => {
  const prisma = fakePrisma();
  const created = await automations.createAutomation(prisma, {
    userId: 'u1', chatId: 'chat-1', prompt: 'Recuérdame llamar a Juan', schedule: 'en 20 minutos', tz: TZ, now: NOW,
  });
  assert.equal(created.kind, 'once');
  assert.equal(created.chatId, 'chat-1');
  assert.equal(created.nextRunAt, '2026-10-09T19:50:00.000Z');
  assert.equal(created.schedule.kind, 'at');
  assert.match(created.schedule.description, /una vez, hoy a las 14:50/);
  const row = prisma.scheduledAgentTask.rows[0];
  assert.equal(row.deliver, 'chat');
  assert.equal(row.createdFrom, 'agent:once;chat=chat-1');
  assert.equal(row.cronExpr, '50 14 9 10 *');
  assert.equal(row.maxSteps, 12, 'FREE plan: default steps within plan limit');
  assert.equal(row.maxCostUsd, 0.25);
});

test('createAutomation: recurring and loop kinds, snapped intervals surface `adjusted`', async () => {
  const prisma = fakePrisma({ plan: 'PRO' });
  const weekly = await automations.createAutomation(prisma, {
    userId: 'u1', chatId: 'chat-1', prompt: 'Resumen semanal', schedule: 'cada lunes a las 9', tz: TZ, now: NOW,
  });
  assert.equal(weekly.kind, 'recurring');
  assert.equal(weekly.schedule.cronExpr, '0 9 * * 1');
  assert.equal(weekly.nextRunAt, '2026-10-12T14:00:00.000Z');
  const loop = await automations.createAutomation(prisma, {
    userId: 'u1', chatId: 'chat-1', prompt: 'Revisa el deploy', schedule: 'cada 7 minutos', tz: TZ, now: NOW,
  });
  assert.equal(loop.kind, 'loop');
  assert.equal(loop.schedule.cronExpr, '*/6 * * * *');
  assert.match(loop.adjusted, /cada 6 min/);
  assert.equal(prisma.scheduledAgentTask.rows[1].maxSteps, 12);
});

test('createAutomation: validation errors are structured and user-facing', async () => {
  const prisma = fakePrisma();
  await assert.rejects(
    automations.createAutomation(prisma, { userId: 'u1', chatId: 'chat-1', prompt: '   ', schedule: 'en 5 min', now: NOW }),
    (e) => e.code === 'automation_prompt_required' && e.status === 400,
  );
  await assert.rejects(
    automations.createAutomation(prisma, { userId: 'u1', chatId: 'chat-1', prompt: 'x', schedule: 'cuando puedas', now: NOW }),
    (e) => e.code === 'schedule_unparseable' && /en 20 minutos/.test(e.message),
  );
  await assert.rejects(
    automations.createAutomation(prisma, { userId: 'u1', chatId: 'chat-1', prompt: 'x', schedule: 'cada 10 segundos', now: NOW }),
    (e) => e.code === 'schedule_too_frequent',
  );
  await assert.rejects(
    automations.createAutomation(prisma, { userId: 'u1', chatId: 'chat-404', prompt: 'x', schedule: 'en 5 min', now: NOW }),
    (e) => e.code === 'automation_chat_not_found' && e.status === 404,
  );
  await assert.rejects(
    automations.createAutomation(prisma, { userId: 'u1', chatId: 'chat-1', prompt: 'x', schedule: { cronExpr: 'nope' }, now: NOW }),
    (e) => e.code === 'schedule_invalid',
  );
});

test('per-user cap counts only automations (legacy Cowork rows do not count)', async () => {
  const prisma = fakePrisma();
  await prisma.scheduledAgentTask.create({ data: { userId: 'u1', createdFrom: 'ui', prompt: 'legacy', cronExpr: '0 9 * * 1', tz: 'UTC', nextRunAt: NOW } });
  for (let i = 0; i < 3; i += 1) {
    await automations.createAutomation(prisma, { userId: 'u1', chatId: 'chat-1', prompt: `job ${i}`, schedule: 'cada 15 minutos', tz: TZ, now: NOW });
  }
  await assert.rejects(
    automations.createAutomation(prisma, { userId: 'u1', chatId: 'chat-1', prompt: 'one more', schedule: 'cada 15 minutos', tz: TZ, now: NOW }),
    (e) => e.code === 'automation_limit_reached' && e.status === 409 && e.details.limit === 3,
  );
  const listed = await automations.listAutomations(prisma, { userId: 'u1', now: NOW });
  assert.equal(listed.length, 3, 'legacy row is not an automation');
  assert.ok(listed.every((a) => a.kind === 'loop'));
});

test('list filters by chat; get/remove are user-scoped and ignore legacy rows', async () => {
  const prisma = fakePrisma({ chats: [
    { id: 'chat-1', userId: 'u1', deletedAt: null, title: 'A' },
    { id: 'chat-2', userId: 'u1', deletedAt: null, title: 'B' },
  ] });
  const a = await automations.createAutomation(prisma, { userId: 'u1', chatId: 'chat-1', prompt: 'a', schedule: 'cada lunes a las 9', tz: TZ, now: NOW });
  await automations.createAutomation(prisma, { userId: 'u1', chatId: 'chat-2', prompt: 'b', schedule: 'cada lunes a las 9', tz: TZ, now: NOW });
  const legacy = await prisma.scheduledAgentTask.create({ data: { userId: 'u1', createdFrom: 'ui', prompt: 'legacy', cronExpr: '0 9 * * 1', tz: 'UTC', nextRunAt: NOW } });
  assert.deepEqual((await automations.listAutomations(prisma, { userId: 'u1', chatId: 'chat-2', now: NOW })).map((x) => x.prompt), ['b']);
  assert.equal((await automations.getAutomation(prisma, { userId: 'u1', automationId: a.id })).prompt, 'a');
  await assert.rejects(automations.getAutomation(prisma, { userId: 'u2', automationId: a.id }), (e) => e.code === 'automation_not_found');
  await assert.rejects(automations.getAutomation(prisma, { userId: 'u1', automationId: legacy.id }), (e) => e.code === 'automation_not_found');
  await assert.rejects(automations.removeAutomation(prisma, { userId: 'u1', automationId: legacy.id }), (e) => e.code === 'automation_not_found');
  assert.equal(await automations.removeAutomation(prisma, { userId: 'u1', automationId: a.id }), true);
  assert.equal((await automations.listAutomations(prisma, { userId: 'u1', now: NOW })).length, 1);
});

test('pause/resume: resume recomputes nextRunAt, clears the failure streak; expired reminders cannot resume', async () => {
  const prisma = fakePrisma();
  const rec = await automations.createAutomation(prisma, { userId: 'u1', chatId: 'chat-1', prompt: 'r', schedule: 'todos los días a las 8', tz: TZ, now: NOW });
  await prisma.scheduledAgentTask.update({ where: { id: rec.id }, data: { lastStatus: 'disabled:failures', enabled: false } });
  const paused = await automations.setAutomationEnabled(prisma, { userId: 'u1', automationId: rec.id, enabled: false, now: NOW });
  assert.equal(paused.enabled, false);
  const later = new Date('2026-10-20T19:30:00.000Z');
  const resumed = await automations.setAutomationEnabled(prisma, { userId: 'u1', automationId: rec.id, enabled: true, now: later });
  assert.equal(resumed.enabled, true);
  assert.equal(resumed.lastStatus, null);
  assert.equal(resumed.failures, 0);
  assert.equal(resumed.nextRunAt, '2026-10-21T13:00:00.000Z');

  const once = await automations.createAutomation(prisma, { userId: 'u1', chatId: 'chat-1', prompt: 'o', schedule: 'en 10 minutos', tz: TZ, now: NOW });
  await automations.setAutomationEnabled(prisma, { userId: 'u1', automationId: once.id, enabled: false, now: NOW });
  await assert.rejects(
    automations.setAutomationEnabled(prisma, { userId: 'u1', automationId: once.id, enabled: true, now: later }),
    (e) => e.code === 'schedule_in_past' && e.status === 409,
  );
  const queued = await automations.runAutomationNow(prisma, { userId: 'u1', automationId: rec.id, now: later });
  assert.equal(queued.queued, true);
  assert.equal(queued.nextRunAt, later.toISOString());
});

test('heartbeat: one row per user, cron encodes cadence + active hours, disable deletes it', async () => {
  const prisma = fakePrisma();
  assert.equal(await automations.getHeartbeat(prisma, { userId: 'u1' }), null);
  const hb = await automations.ensureHeartbeat(prisma, { userId: 'u1', chatId: 'chat-1', tz: TZ, everyMinutes: 25, activeHours: { start: 8, end: 22 }, now: NOW });
  assert.equal(hb.kind, 'heartbeat');
  assert.equal(hb.schedule.cronExpr, '*/30 8-21 * * *');
  assert.equal(hb.everyMinutes, 30);
  assert.equal(hb.nextRunAt, '2026-10-09T20:00:00.000Z', 'next slot at 15:00 Lima');
  assert.match(prisma.scheduledAgentTask.rows[0].prompt, /NO_REPLY/);
  const again = await automations.ensureHeartbeat(prisma, { userId: 'u1', chatId: 'chat-1', tz: TZ, everyMinutes: 60, activeHours: { start: 22, end: 6 }, prompt: 'Revisa el buzón', now: NOW });
  assert.equal(again.id, hb.id, 'updated in place');
  assert.equal(again.schedule.cronExpr, '0 22-23,0-5 * * *');
  assert.match(prisma.scheduledAgentTask.rows[0].prompt, /Revisa el buzón/);
  assert.equal(prisma.scheduledAgentTask.rows.length, 1);
  assert.deepEqual(automations.heartbeatCron({ everyMinutes: 15, activeHours: { start: 0, end: 24 } }), { cronExpr: '*/15 * * * *', everyMinutes: 15 });
  assert.equal(await automations.disableHeartbeat(prisma, { userId: 'u1' }), true);
  assert.equal(await automations.getHeartbeat(prisma, { userId: 'u1' }), null);
});

test('NO_REPLY detection tolerates decoration only', () => {
  assert.equal(automations.isNoReply('NO_REPLY'), true);
  assert.equal(automations.isNoReply(' **NO_REPLY** '), true);
  assert.equal(automations.isNoReply('NO_REPLY.'), true);
  assert.equal(automations.isNoReply('NO_REPLY — nada nuevo'), false);
  assert.equal(automations.isNoReply(''), false);
  assert.equal(automations.isNoReply('Todo listo'), false);
});

test('nextStateAfterRun: once deletes on success; failures back off then auto-disable', () => {
  const once = { createdFrom: 'agent:once;chat=c', cronExpr: '50 14 9 10 *', tz: TZ, lastStatus: null };
  assert.deepEqual(automations.nextStateAfterRun(once, { ok: true, status: 'completed' }, { now: NOW }), { action: 'delete' });
  const f1 = automations.nextStateAfterRun(once, { ok: false }, { now: NOW });
  assert.equal(f1.data.lastStatus, 'failed:1');
  assert.equal(f1.data.nextRunAt.getTime() - NOW.getTime(), 30_000);
  const f2 = automations.nextStateAfterRun({ ...once, lastStatus: 'failed:1' }, { ok: false }, { now: NOW });
  assert.equal(f2.data.nextRunAt.getTime() - NOW.getTime(), 60_000);
  const f3 = automations.nextStateAfterRun({ ...once, lastStatus: 'failed:2' }, { ok: false }, { now: NOW });
  assert.equal(f3.disabled, true, 'a reminder gives up after 3 failures');
  assert.equal(f3.data.enabled, false);
  assert.equal(f3.data.lastStatus, 'disabled:failures');

  const rec = { createdFrom: 'agent:recurring;chat=c', cronExpr: '0 9 * * 1', tz: TZ, lastStatus: 'failed:4' };
  const f5 = automations.nextStateAfterRun(rec, { ok: false }, { now: NOW });
  assert.equal(f5.data.lastStatus, 'failed:5');
  assert.equal(f5.data.nextRunAt.getTime() - NOW.getTime(), 60 * 60_000, 'backoff caps at 60 min');
  const f10 = automations.nextStateAfterRun({ ...rec, lastStatus: 'failed:9' }, { ok: false }, { now: NOW });
  assert.equal(f10.disabled, true);
  const quiet = automations.nextStateAfterRun(rec, { ok: true, status: 'quiet' }, { now: NOW });
  assert.equal(quiet.data.lastStatus, 'quiet');
  assert.equal(quiet.data.nextRunAt.toISOString(), '2026-10-12T14:00:00.000Z');
  assert.equal(automations.nextStateAfterRun({ createdFrom: 'ui' }, { ok: true }, { now: NOW }), null, 'legacy rows keep the legacy path');
});

test('automation system prompt carries the local time and the NO_REPLY contract per kind', () => {
  const once = automations.buildAutomationSystemPrompt({ kind: 'once', tz: TZ, now: NOW, chatTitle: 'Plan Q4' });
  assert.match(once, /viernes 9 de octubre de 2026, 14:30 \(America\/Lima\)/);
  assert.match(once, /recordatorio puntual/);
  assert.doesNotMatch(once, /NO_REPLY/);
  assert.match(automations.buildAutomationSystemPrompt({ kind: 'heartbeat', tz: TZ, now: NOW }), /latido periódico.*NO_REPLY/);
  assert.match(automations.buildAutomationSystemPrompt({ kind: 'recurring', tz: TZ, now: NOW }), /NO_REPLY/);
  assert.equal(automations.notificationTitleFor('once'), 'Recordatorio de SiraGPT');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { buildRouteTestApp } = require('./http-test-utils');
const { createAutomationsRouter } = require('../src/routes/automations');
const { AutomationError } = require('../src/services/automations');

const sample = {
  id: 'task-1', kind: 'once', chatId: 'chat-1', prompt: 'Llamar a Juan', enabled: true,
  schedule: { kind: 'at', cronExpr: '50 14 9 10 *', tz: 'America/Lima', at: '2026-10-09T19:50:00.000Z', description: 'una vez, hoy a las 14:50 (America/Lima)' },
  nextRunAt: '2026-10-09T19:50:00.000Z', nextRunLocal: 'viernes 9 de octubre de 2026, 14:50 (America/Lima)', lastStatus: null, failures: 0, disabledByFailures: false,
};

function buildApp({ user = { id: 'u1' } } = {}) {
  const calls = [];
  const automations = {
    MAX_PER_USER: 25,
    listAutomations: async (prisma, input) => { calls.push(['list', input]); return [sample]; },
    createAutomation: async (prisma, input) => {
      calls.push(['create', input]);
      if (!input.schedule) throw new AutomationError('schedule_unparseable', 'No entendí cuándo debe ejecutarse.', 400);
      if (input.chatId === 'full') throw new AutomationError('automation_limit_reached', 'Ya tienes 25 automatizaciones.', 409, { limit: 25, count: 25 });
      return sample;
    },
    getAutomation: async (prisma, input) => { calls.push(['get', input]); if (input.automationId === 'missing') throw new AutomationError('automation_not_found', 'No encontré esa automatización.', 404); return sample; },
    removeAutomation: async (prisma, input) => { calls.push(['remove', input]); return true; },
    setAutomationEnabled: async (prisma, input) => { calls.push(['enabled', input]); return { ...sample, enabled: input.enabled }; },
    runAutomationNow: async (prisma, input) => { calls.push(['run', input]); return { ...sample, queued: true }; },
    getHeartbeat: async (prisma, input) => { calls.push(['hb-get', input]); return null; },
    ensureHeartbeat: async (prisma, input) => { calls.push(['hb-put', input]); return { ...sample, kind: 'heartbeat' }; },
    disableHeartbeat: async (prisma, input) => { calls.push(['hb-del', input]); return true; },
  };
  const auth = (req, res, next) => {
    if (!user) return res.status(401).json({ ok: false, error: 'unauthenticated' });
    req.user = user;
    return next();
  };
  const router = createAutomationsRouter({ auth, prisma: { tag: 'fake-prisma' }, automations });
  return { app: buildRouteTestApp('/api/automations', router), calls };
}

test('GET /health is public; the rest requires auth', async () => {
  const { app } = buildApp({ user: null });
  const health = await request(app).get('/api/automations/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { ok: true, service: 'automations', maxPerUser: 25 });
  assert.equal((await request(app).get('/api/automations')).status, 401);
  assert.equal((await request(app).post('/api/automations').send({})).status, 401);
});

test('POST / creates in the caller scope with the client zone; validation errors map to 4xx with codes', async () => {
  const { app, calls } = buildApp();
  const created = await request(app).post('/api/automations').send({ chatId: 'chat-1', prompt: 'Llamar a Juan', schedule: 'en 20 minutos', timeZone: 'America/Lima' });
  assert.equal(created.status, 201);
  assert.equal(created.body.ok, true);
  assert.equal(created.body.automation.id, 'task-1');
  assert.equal(created.headers['cache-control'], 'no-store');
  assert.deepEqual(calls[0][1], { userId: 'u1', chatId: 'chat-1', prompt: 'Llamar a Juan', schedule: 'en 20 minutos', tz: 'America/Lima' });
  const bad = await request(app).post('/api/automations').send({ chatId: 'chat-1', prompt: 'x' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'schedule_unparseable');
  const full = await request(app).post('/api/automations').send({ chatId: 'full', prompt: 'x', schedule: 'en 5 min' });
  assert.equal(full.status, 409);
  assert.equal(full.body.code, 'automation_limit_reached');
  assert.deepEqual(full.body.details, { limit: 25, count: 25 });
  const cron = await request(app).post('/api/automations').send({ chatId: 'chat-1', prompt: 'x', schedule: { kind: 'cron', cronExpr: '0 9 * * 1' } });
  assert.equal(cron.status, 201);
  assert.deepEqual(calls.at(-1)[1].schedule, { kind: 'cron', cronExpr: '0 9 * * 1' }, 'structured schedules pass through');
});

test('GET / lists (optionally by chat); GET/DELETE /:id and pause/resume/run are user-scoped', async () => {
  const { app, calls } = buildApp();
  const list = await request(app).get('/api/automations?chatId=chat-1');
  assert.equal(list.status, 200);
  assert.equal(list.body.automations.length, 1);
  assert.deepEqual(calls[0][1], { userId: 'u1', chatId: 'chat-1' });
  const one = await request(app).get('/api/automations/task-1');
  assert.equal(one.body.automation.id, 'task-1');
  const missing = await request(app).get('/api/automations/missing');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'automation_not_found');
  const paused = await request(app).post('/api/automations/task-1/pause');
  assert.equal(paused.body.automation.enabled, false);
  assert.deepEqual(calls.at(-1)[1], { userId: 'u1', automationId: 'task-1', enabled: false });
  const resumed = await request(app).post('/api/automations/task-1/resume');
  assert.equal(resumed.body.automation.enabled, true);
  const ran = await request(app).post('/api/automations/task-1/run');
  assert.equal(ran.status, 202);
  assert.equal(ran.body.automation.queued, true);
  const removed = await request(app).delete('/api/automations/task-1');
  assert.deepEqual(removed.body, { ok: true, removed: true });
});

test('heartbeat GET/PUT/DELETE with defaults (30 min, 08-22) and bounded inputs', async () => {
  const { app, calls } = buildApp();
  const none = await request(app).get('/api/automations/heartbeat');
  assert.deepEqual(none.body, { ok: true, heartbeat: null });
  const put = await request(app).put('/api/automations/heartbeat').send({ chatId: 'chat-1', tz: 'Europe/Madrid' });
  assert.equal(put.status, 200);
  assert.deepEqual(calls.at(-1)[1], { userId: 'u1', chatId: 'chat-1', tz: 'Europe/Madrid', everyMinutes: 30, activeHours: { start: 8, end: 22 }, prompt: null });
  await request(app).put('/api/automations/heartbeat').send({ chatId: 'chat-1', everyMinutes: 60, activeHours: { start: 9, end: 18 }, prompt: 'Revisa el buzón' });
  assert.deepEqual(calls.at(-1)[1].activeHours, { start: 9, end: 18 });
  assert.equal(calls.at(-1)[1].prompt, 'Revisa el buzón');
  assert.equal(calls.at(-1)[1].tz, 'UTC');
  const del = await request(app).delete('/api/automations/heartbeat');
  assert.deepEqual(del.body, { ok: true, removed: true });
});

test('unexpected service failures never leak internals', async () => {
  const { app } = buildApp();
  const router = createAutomationsRouter({
    auth: (req, _res, next) => { req.user = { id: 'u1' }; next(); },
    prisma: {},
    automations: { MAX_PER_USER: 25, listAutomations: async () => { throw new Error('ECONNREFUSED 10.0.0.5:5432'); } },
  });
  const app2 = buildRouteTestApp('/api/automations', router);
  const res = await request(app2).get('/api/automations');
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'No se pudieron cargar tus automatizaciones.');
  assert.ok(!JSON.stringify(res.body).includes('ECONNREFUSED'));
  void app;
});

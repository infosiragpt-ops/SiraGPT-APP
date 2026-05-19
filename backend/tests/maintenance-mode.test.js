'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const maintenanceMode = require('../src/middleware/maintenance-mode');

// ── In-memory fake prisma ──────────────────────────────────────────────────
function makeFakePrisma(initial = null) {
  const store = new Map();
  if (initial) store.set(maintenanceMode.KEY, { key: maintenanceMode.KEY, value: JSON.stringify(initial) });
  return {
    systemSettings: {
      async findUnique({ where }) {
        return store.get(where.key) || null;
      },
      async upsert({ where, create, update }) {
        const existing = store.get(where.key);
        if (existing) {
          const next = { ...existing, ...update };
          store.set(where.key, next);
          return next;
        }
        store.set(where.key, create);
        return create;
      },
    },
    _store: store,
  };
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

// ── isBypassedPath ─────────────────────────────────────────────────────────

test('isBypassedPath whitelists /health and /api/admin', () => {
  const { isBypassedPath } = maintenanceMode._internal;
  assert.equal(isBypassedPath('/health'), true);
  assert.equal(isBypassedPath('/health/live'), true);
  assert.equal(isBypassedPath('/health/ready'), true);
  assert.equal(isBypassedPath('/api/admin'), true);
  assert.equal(isBypassedPath('/api/admin/maintenance/mode'), true);
  assert.equal(isBypassedPath('/api/chats'), false);
  assert.equal(isBypassedPath('/api/users/me/export'), false);
  assert.equal(isBypassedPath('/'), false);
  assert.equal(isBypassedPath(null), false);
});

// ── writeMaintenanceState / getMaintenanceState ────────────────────────────

test('writeMaintenanceState persists and read returns the row', async () => {
  maintenanceMode.invalidateMaintenanceCache();
  const prisma = makeFakePrisma();
  const next = await maintenanceMode.writeMaintenanceState(prisma, {
    enabled: true,
    message: 'Routine deploy',
  });
  assert.equal(next.enabled, true);
  assert.equal(next.message, 'Routine deploy');
  assert.match(next.since, /\d{4}-\d{2}-\d{2}T/);
  const state = await maintenanceMode.getMaintenanceState(prisma);
  assert.equal(state.enabled, true);
  assert.equal(state.message, 'Routine deploy');
});

test('getMaintenanceState returns null when no row exists', async () => {
  maintenanceMode.invalidateMaintenanceCache();
  const prisma = makeFakePrisma();
  const state = await maintenanceMode.getMaintenanceState(prisma);
  assert.equal(state, null);
});

test('getMaintenanceState tolerates malformed JSON in value', async () => {
  maintenanceMode.invalidateMaintenanceCache();
  const prisma = makeFakePrisma();
  prisma._store.set(maintenanceMode.KEY, { key: maintenanceMode.KEY, value: '{not-json' });
  const state = await maintenanceMode.getMaintenanceState(prisma);
  assert.equal(state, null);
});

// ── maintenanceMiddleware ──────────────────────────────────────────────────

test('middleware passes through when state is disabled', async () => {
  maintenanceMode.invalidateMaintenanceCache();
  const prisma = makeFakePrisma({ enabled: false, message: null, since: null });
  const mw = maintenanceMode.maintenanceMiddleware({ prisma });
  const req = { path: '/api/chats' };
  const res = makeRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.statusCode, 200);
});

test('middleware returns 503 with maintenance payload when enabled', async () => {
  maintenanceMode.invalidateMaintenanceCache();
  const prisma = makeFakePrisma({
    enabled: true,
    message: 'Backup in progress',
    since: '2026-05-18T10:00:00.000Z',
  });
  const mw = maintenanceMode.maintenanceMiddleware({ prisma });
  const req = { path: '/api/chats' };
  const res = makeRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'maintenance');
  assert.equal(res.body.message, 'Backup in progress');
  assert.equal(res.body.since, '2026-05-18T10:00:00.000Z');
  assert.equal(res.headers['Retry-After'], '60');
});

test('middleware bypasses /health/* even when enabled', async () => {
  maintenanceMode.invalidateMaintenanceCache();
  const prisma = makeFakePrisma({ enabled: true, message: 'Down', since: null });
  const mw = maintenanceMode.maintenanceMiddleware({ prisma });
  const req = { path: '/health/live' };
  const res = makeRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.statusCode, 200);
});

test('middleware bypasses /api/admin/* even when enabled', async () => {
  maintenanceMode.invalidateMaintenanceCache();
  const prisma = makeFakePrisma({ enabled: true, message: 'Down', since: null });
  const mw = maintenanceMode.maintenanceMiddleware({ prisma });
  const req = { path: '/api/admin/maintenance/mode' };
  const res = makeRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, true);
});

test('middleware fails open when prisma is unavailable', async () => {
  maintenanceMode.invalidateMaintenanceCache();
  const mw = maintenanceMode.maintenanceMiddleware({ prisma: null });
  const req = { path: '/api/chats' };
  const res = makeRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, true);
});

test('uses fallback message when state.message is empty', async () => {
  maintenanceMode.invalidateMaintenanceCache();
  const prisma = makeFakePrisma({ enabled: true, message: null, since: null });
  const mw = maintenanceMode.maintenanceMiddleware({ prisma });
  const req = { path: '/api/chats' };
  const res = makeRes();
  await mw(req, res, () => {});
  assert.equal(res.statusCode, 503);
  assert.ok(typeof res.body.message === 'string' && res.body.message.length > 0);
});

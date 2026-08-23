'use strict';

// Admin · Runtime feature flags route — offline tests (stubbed prisma,
// no network/DB). Auth layers are stripped per repo convention
// (see admin-settings-route.test.js); handler-level validation is what's
// under test here. Real super-admin gating is enforced by requireSuperAdmin
// in middleware/auth (covered by auth suite).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRouter } = require('../src/routes/admin/runtime-flags');

function stubPrisma() {
  const rows = new Map();
  const audits = [];
  return {
    rows,
    audits,
    systemSettings: {
      findUnique: async ({ where }) => {
        const v = rows.get(where.key);
        return v === undefined ? null : { key: where.key, value: v };
      },
      upsert: async ({ where, create, update }) => {
        const value = (update || create).value;
        rows.set(where.key, value);
        return { key: where.key, value };
      },
    },
    auditLog: { create: async ({ data }) => { audits.push(data); return data; } },
  };
}

async function invoke(router, { method, url, body }) {
  return new Promise((resolve, reject) => {
    const req = Object.assign(require('node:stream').Readable.from([]), {
      method,
      url,
      headers: {},
      body: body || {},
      params: {},
      user: { id: 'admin1', isSuperAdmin: true },
      app: { get: () => undefined },
    });
    if (url !== '/') {
      // Express does not parse params on raw handle(); emulate for :name.
      req.params = { name: url.split('/').pop() };
    }
    const res = {
      statusCode: 200,
      setHeader() {},
      getHeader() { return undefined; },
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
      end() { resolve({ status: this.statusCode, body: null }); },
      on() {},
    };
    router.handle(req, res, (err) => (err ? reject(err) : resolve({ status: 404, body: null })));
  });
}

function stripAuth(router) {
  router.stack = router.stack.filter((layer) => layer.route);
  return router;
}

test('PUT rejects non-object flags, empty maps, and non-boolean values', async () => {
  const prisma = stubPrisma();
  const router = stripAuth(createRouter({ prismaClient: prisma }));

  const noBody = await invoke(router, { method: 'PUT', url: '/', body: {} });
  assert.equal(noBody.status, 400);

  const empty = await invoke(router, { method: 'PUT', url: '/', body: { flags: {} } });
  assert.equal(empty.status, 400);

  const badValue = await invoke(router, { method: 'PUT', url: '/', body: { flags: { X: 'yes' } } });
  assert.equal(badValue.status, 400);

  assert.equal(prisma.rows.size, 0);
});

test('PUT + GET + DELETE round-trip writes overrides and audit log', async () => {
  const prisma = stubPrisma();
  const router = stripAuth(createRouter({ prismaClient: prisma }));

  const put = await invoke(router, {
    method: 'PUT',
    url: '/',
    body: { flags: { CODEX_AGENT_V2: false }, message: 'incident kill-switch' },
  });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.flags, { CODEX_AGENT_V2: false });

  const get = await invoke(router, { method: 'GET', url: '/' });
  assert.equal(get.status, 200);
  assert.deepEqual(get.body.flags, [{ name: 'CODEX_AGENT_V2', value: false }]);
  assert.equal(get.body.count, 1);
  assert.ok(get.body.updatedAt);

  const del = await invoke(router, { method: 'DELETE', url: '/CODEX_AGENT_V2' });
  assert.equal(del.status, 200);
  assert.deepEqual(del.body.flags, {});

  const actions = prisma.audits.map((a) => a.action).sort();
  assert.deepEqual(actions, ['runtime_flags_override_cleared', 'runtime_flags_override_set']);
});

test('DELETE unknown override returns 404 and writes nothing', async () => {
  const prisma = stubPrisma();
  const router = stripAuth(createRouter({ prismaClient: prisma }));
  const res = await invoke(router, { method: 'DELETE', url: '/NOPE' });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'unknown_flag', name: 'NOPE' });
});

test('second PUT merges instead of replacing existing overrides', async () => {
  const prisma = stubPrisma();
  const router = stripAuth(createRouter({ prismaClient: prisma }));

  await invoke(router, { method: 'PUT', url: '/', body: { flags: { A: true } } });
  const second = await invoke(router, { method: 'PUT', url: '/', body: { flags: { B: false } } });
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.flags, { A: true, B: false });
});

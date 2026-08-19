// Admin · Settings route — offline tests (stubbed prisma, no network/DB).
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { _internals, createRouter } = require('../src/routes/admin/settings');
const { sanitizeSettings, DEFAULT_SETTINGS } = _internals;

describe('admin-settings · sanitizeSettings', () => {
  test('defaults on empty input', () => {
    assert.deepEqual(sanitizeSettings({}), DEFAULT_SETTINGS);
  });

  test('whitelists fields, drops secrets/unknowns', () => {
    const out = sanitizeSettings({
      siteName: '  Sira  ',
      apiKey: 'sk-evil',
      stripeSecret: 'nope',
      enableRegistration: false,
    });
    assert.equal(out.siteName, 'Sira');
    assert.equal(out.enableRegistration, false);
    assert.ok(!('apiKey' in out));
    assert.ok(!('stripeSecret' in out));
  });

  test('validates emails and plan enum', () => {
    assert.equal(sanitizeSettings({ adminEmail: 'no-es-email' }).adminEmail, DEFAULT_SETTINGS.adminEmail);
    assert.equal(sanitizeSettings({ adminEmail: 'ops@sira.gpt' }).adminEmail, 'ops@sira.gpt');
    assert.equal(sanitizeSettings({ defaultUserPlan: 'pro' }).defaultUserPlan, 'PRO');
    assert.equal(sanitizeSettings({ defaultUserPlan: 'HACKER' }).defaultUserPlan, DEFAULT_SETTINGS.defaultUserPlan);
  });

  test('clamps numeric ranges and per-plan caps', () => {
    assert.equal(sanitizeSettings({ sessionTimeoutMinutes: 1 }).sessionTimeoutMinutes, DEFAULT_SETTINGS.sessionTimeoutMinutes);
    assert.equal(sanitizeSettings({ maxFileSizeMb: 4096 }).maxFileSizeMb, DEFAULT_SETTINGS.maxFileSizeMb);
    assert.equal(sanitizeSettings({ maxFileSizeMb: 250 }).maxFileSizeMb, 250);
    const caps = sanitizeSettings({ maxUsersPerPlan: { FREE: 5, PRO: -1 } }).maxUsersPerPlan;
    assert.equal(caps.FREE, 5);
    assert.equal(caps.PRO, DEFAULT_SETTINGS.maxUsersPerPlan.PRO);
  });
});

describe('admin-settings · router with stubbed prisma', () => {
  function stubPrisma() {
    const stored = { value: null };
    return {
      systemSettings: {
        findUnique: async ({ where }) => {
          if (where.key === 'admin_general_settings' && stored.value) return { key: where.key, value: stored.value };
          return null;
        },
        upsert: async ({ create, update }) => { stored.value = (update?.value ?? create?.value) || null; return {}; },
      },
      auditLog: { create: async () => ({}) },
      _stored: stored,
    };
  }

  async function invoke(router, { method, url, body }) {
    return new Promise((resolve, reject) => {
      const req = Object.assign(require('node:stream').Readable.from([]), {
        method,
        url,
        headers: {},
        body: body || {},
        user: { id: 'admin1', isAdmin: true },
        app: { get: () => undefined },
      });
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

  test('GET / returns defaults + maintenance state without rows', async () => {
    const prismaClient = stubPrisma();
    const router = createRouter({ prismaClient });
    router.stack = router.stack.filter((layer) => layer.route);
    const out = await invoke(router, { method: 'GET', url: '/' });
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.settings, DEFAULT_SETTINGS);
    assert.equal(typeof out.body.maintenance.enabled, 'boolean');
  });

  test('PUT / persists and round-trips through GET', async () => {
    const prismaClient = stubPrisma();
    const router = createRouter({ prismaClient });
    router.stack = router.stack.filter((layer) => layer.route);
    const put = await invoke(router, {
      method: 'PUT',
      url: '/',
      body: { settings: { siteName: 'Sira Pro', defaultUserPlan: 'PRO', junk: true } },
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.settings.siteName, 'Sira Pro');
    assert.equal(put.body.settings.defaultUserPlan, 'PRO');
    assert.ok(!('junk' in put.body.settings));
    const get = await invoke(router, { method: 'GET', url: '/' });
    assert.equal(get.body.settings.siteName, 'Sira Pro');
  });
});

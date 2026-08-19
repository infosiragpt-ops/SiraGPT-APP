// Admin · Security route — offline tests (stubbed prisma, no network/DB).
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { _internals, createRouter } = require('../src/routes/admin/security');
const { sanitizeSettings, computeSecurityScore, severityFor, DEFAULT_SETTINGS } = _internals;

describe('admin-security · sanitizeSettings', () => {
  test('defaults when input empty', () => {
    assert.deepEqual(sanitizeSettings({}), DEFAULT_SETTINGS);
  });

  test('whitelists known keys and drops unknown ones', () => {
    const out = sanitizeSettings({
      require2faForAdmins: true,
      apiRateLimitEnabled: false,
      evil: 'payload',
      masterApiKey: 'sk-nope',
    });
    assert.equal(out.require2faForAdmins, true);
    assert.equal(out.apiRateLimitEnabled, false);
    assert.ok(!('evil' in out));
    assert.ok(!('masterApiKey' in out));
  });

  test('clamps numeric ranges (timeout 15min–7d, password 6–128)', () => {
    assert.equal(sanitizeSettings({ sessionTimeoutMinutes: 5 }).sessionTimeoutMinutes, DEFAULT_SETTINGS.sessionTimeoutMinutes);
    assert.equal(sanitizeSettings({ sessionTimeoutMinutes: 60 }).sessionTimeoutMinutes, 60);
    assert.equal(sanitizeSettings({ passwordMinLength: 3 }).passwordMinLength, DEFAULT_SETTINGS.passwordMinLength);
    assert.equal(sanitizeSettings({ passwordMinLength: 12 }).passwordMinLength, 12);
    assert.equal(sanitizeSettings({ passwordMinLength: '12' }).passwordMinLength, 12);
  });
});

describe('admin-security · computeSecurityScore', () => {
  test('perfect posture scores 100', () => {
    const score = computeSecurityScore({
      twoFactorRatio: 1,
      verifiedRatio: 1,
      failedLogins24h: 0,
      settings: { ...DEFAULT_SETTINGS, require2faForAdmins: true, apiRateLimitEnabled: true, passwordMinLength: 12 },
    });
    assert.equal(score, 100);
  });

  test('weak posture scores low and stays in [0,100]', () => {
    const score = computeSecurityScore({
      twoFactorRatio: 0,
      verifiedRatio: 0,
      failedLogins24h: 200,
      settings: { ...DEFAULT_SETTINGS, apiRateLimitEnabled: false, passwordMinLength: 6, require2faForAdmins: false },
    });
    assert.ok(score >= 0 && score <= 20, `score=${score}`);
  });
});

describe('admin-security · severity', () => {
  test('maps actions to severities', () => {
    assert.equal(severityFor('login_failed'), 'high');
    assert.equal(severityFor('password_reset'), 'medium');
    assert.equal(severityFor('user_created'), 'low');
  });
});

describe('admin-security · router with stubbed prisma', () => {
  function stubPrisma(overrides = {}) {
    const stored = { value: null };
    return {
      session: { count: async () => 93 },
      apiKey: { count: async () => 2 },
      user: { count: async ({ where }) => (where?.twoFactorEnabled ? 1 : where?.emailVerifiedAt ? 3 : 5) },
      auditLog: {
        count: async () => 4,
        findMany: async () => [
          { id: 'a1', action: 'login_failed', actorId: 'u1', metadata: { ip: '1.2.3.4' }, createdAt: new Date() },
        ],
        create: async () => ({}),
      },
      systemSettings: {
        findUnique: async () => (stored.value ? { key: 'security_settings', value: stored.value } : null),
        upsert: async ({ create, update }) => { stored.value = (update?.value ?? create?.value) || null; return {}; },
      },
      _stored: stored,
      ...overrides,
    };
  }

  async function invoke(router, { method, url, body, user }) {
    return new Promise((resolve, reject) => {
      const req = Object.assign(require('node:stream').Readable.from([]), {
        method,
        url,
        headers: {},
        body: body || {},
        user: user || { id: 'admin1', isAdmin: true },
        app: { get: () => undefined },
      });
      const res = {
        statusCode: 200,
        headersSent: false,
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

  test('GET / returns real-shaped overview, events and settings', async () => {
    const prismaClient = stubPrisma();
    const router = createRouter({ prismaClient });
    // strip the auth middlewares for the offline test: rebuild stack
    router.stack = router.stack.filter((layer) => layer.route);
    const out = await invoke(router, { method: 'GET', url: '/' });
    assert.equal(out.status, 200);
    assert.equal(out.body.overview.activeSessions, 93);
    assert.equal(out.body.overview.failedLogins24h, 4);
    assert.ok(out.body.overview.securityScore >= 0 && out.body.overview.securityScore <= 100);
    assert.equal(out.body.events[0].severity, 'high');
    assert.equal(out.body.events[0].ip, '1.2.3.4');
    assert.deepEqual(out.body.settings, DEFAULT_SETTINGS);
  });

  test('PUT /settings persists the whitelisted blob', async () => {
    const prismaClient = stubPrisma();
    const router = createRouter({ prismaClient });
    router.stack = router.stack.filter((layer) => layer.route);
    const out = await invoke(router, {
      method: 'PUT',
      url: '/settings',
      body: { require2faForAdmins: true, junk: 1 },
    });
    assert.equal(out.status, 200);
    assert.equal(out.body.settings.require2faForAdmins, true);
    assert.ok(!('junk' in out.body.settings));
    assert.ok(prismaClient._stored.value.includes('"require2faForAdmins":true'));
  });
});

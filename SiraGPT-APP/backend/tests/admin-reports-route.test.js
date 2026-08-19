// Admin · Reports route — offline tests (stubbed prisma, no network/DB).
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { _internals, createRouter } = require('../src/routes/admin/reports');
const { REPORT_TYPES, parseRange, toCsv, csvEscape, bucketByDay } = _internals;

describe('admin-reports · helpers', () => {
  test('parseRange defaults to last 30 days and rejects inverted/oversized ranges', () => {
    const ok = parseRange({});
    assert.ok(ok.from < ok.to);
    assert.ok(parseRange({ from: '2026-02-01', to: '2026-01-01' }).error);
    assert.ok(parseRange({ from: '2025-01-01', to: '2026-01-01' }).error);
  });

  test('csv escaping covers quotes, commas and newlines', () => {
    assert.equal(csvEscape('a,b'), '"a,b"');
    assert.equal(csvEscape('di"jo'), '"di""jo"');
    const csv = toCsv([{ dia: '2026-01-01', mensajes: 5 }]);
    assert.ok(csv.startsWith('dia,mensajes\n'));
    assert.ok(csv.includes('2026-01-01,5'));
  });

  test('bucketByDay zero-fills the full range', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-01-03T23:59:59Z');
    const buckets = bucketByDay([{ createdAt: new Date('2026-01-02T10:00:00Z') }], 'createdAt', from, to);
    assert.deepEqual(buckets, { '2026-01-01': 0, '2026-01-02': 1, '2026-01-03': 0 });
  });
});

describe('admin-reports · router with stubbed prisma', () => {
  const day = new Date('2026-06-10T12:00:00Z');
  function stubPrisma() {
    return {
      user: { findMany: async () => [{ createdAt: day }] },
      session: { findMany: async () => [] },
      chat: { findMany: async () => [{ createdAt: day }, { createdAt: day }] },
      message: { findMany: async () => [{ timestamp: day }] },
      file: { findMany: async () => [] },
      apiUsage: { groupBy: async () => [{ model: 'gpt-4o-mini', _sum: { tokens: 123n }, _count: { model: 4 } }] },
      auditLog: { groupBy: async () => [{ action: 'login_failed', _count: { action: 7 } }] },
      payment: { findMany: async () => [{ createdAt: day, amount: 5, currency: 'usd' }] },
    };
  }

  async function invoke(router, { url, user }) {
    return new Promise((resolve, reject) => {
      // Express populates req.query at the app layer; a bare router.handle
      // does not, so the harness parses it from the URL itself.
      const query = Object.fromEntries(new URL(`http://x${url}`).searchParams.entries());
      const req = Object.assign(require('node:stream').Readable.from([]), {
        method: 'GET',
        url,
        query,
        headers: {},
        user: user || { id: 'admin1', isAdmin: true, isSuperAdmin: false },
        app: { get: () => undefined },
      });
      const chunks = [];
      const res = {
        statusCode: 200,
        setHeader() {},
        getHeader() { return undefined; },
        status(code) { this.statusCode = code; return this; },
        json(payload) { resolve({ status: this.statusCode, body: payload }); },
        send(payload) { resolve({ status: this.statusCode, text: String(payload) }); },
        end() { resolve({ status: this.statusCode, body: null }); },
        on() {},
      };
      router.handle(req, res, (err) => (err ? reject(err) : resolve({ status: 404, body: null })));
    });
  }

  function bareRouter() {
    const router = createRouter({ prismaClient: stubPrisma() });
    router.stack = router.stack.filter((layer) => layer.route || layer.handle.length === 4);
    return router;
  }

  test('GET / lists the 5 report types', async () => {
    const out = await invoke(bareRouter(), { url: '/' });
    assert.equal(out.status, 200);
    assert.equal(out.body.types.length, REPORT_TYPES.length);
  });

  test('GET /api-usage returns model rows', async () => {
    const out = await invoke(bareRouter(), { url: '/api-usage' });
    assert.equal(out.status, 200);
    assert.equal(out.body.rows[0].modelo, 'gpt-4o-mini');
    assert.equal(out.body.rows[0].tokens, 123);
  });

  test('GET /security?format=csv responds CSV text', async () => {
    const out = await invoke(bareRouter(), { url: '/security?format=csv' });
    assert.equal(out.status, 200);
    assert.ok(out.text.startsWith('accion,eventos'));
    assert.ok(out.text.includes('login_failed,7'));
  });

  test('revenue is super-admin gated; bad type 400', async () => {
    const denied = await invoke(bareRouter(), { url: '/revenue' });
    assert.equal(denied.status, 403);
    const allowed = await invoke(bareRouter(), { url: '/revenue', user: { id: 'sa', isAdmin: true, isSuperAdmin: true } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.rows[0].pagos, 1);
    const bad = await invoke(bareRouter(), { url: '/no-existe' });
    assert.equal(bad.status, 400);
  });
});

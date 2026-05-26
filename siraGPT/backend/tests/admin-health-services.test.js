'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const admin = require('../src/routes/admin');
const {
  collectServiceHealth,
  probePostgres,
  probeRedis,
  probeStripe,
  probeSmtp,
  probeProviders,
  deriveOverall,
  withTimeout,
} = admin.INTERNAL;

// ── deriveOverall ────────────────────────────────────────────────────────────

test('deriveOverall reports healthy when all critical probes are up/unconfigured', () => {
  const overall = deriveOverall({
    postgres: { status: 'up' },
    redis: { status: 'unconfigured' },
    stripe: { status: 'unconfigured' },
    smtp: { status: 'unconfigured' },
  });
  assert.equal(overall, 'healthy');
});

test('deriveOverall reports down when postgres is down', () => {
  const overall = deriveOverall({
    postgres: { status: 'down' },
    redis: { status: 'up' },
    stripe: { status: 'up' },
    smtp: { status: 'up' },
  });
  assert.equal(overall, 'down');
});

test('deriveOverall reports degraded when a non-postgres dep is down', () => {
  const overall = deriveOverall({
    postgres: { status: 'up' },
    redis: { status: 'down' },
    stripe: { status: 'up' },
    smtp: { status: 'unconfigured' },
  });
  assert.equal(overall, 'degraded');
});

// ── withTimeout ──────────────────────────────────────────────────────────────

test('withTimeout resolves with inner result when fast enough', async () => {
  const result = await withTimeout(Promise.resolve(42), 500, 'test');
  assert.equal(result, 42);
});

test('withTimeout rejects when inner promise exceeds timeout', async () => {
  await assert.rejects(
    () => withTimeout(new Promise((r) => setTimeout(() => r('late'), 100)), 25, 'slow-op'),
    /slow-op timed out/
  );
});

// ── probePostgres ────────────────────────────────────────────────────────────

test('probePostgres reports up when $queryRaw resolves', async () => {
  const fakePrisma = { $queryRaw: async () => [{ '?column?': 1 }] };
  const result = await probePostgres(fakePrisma);
  assert.equal(result.status, 'up');
  assert.ok(typeof result.latencyMs === 'number');
});

test('probePostgres reports down when $queryRaw throws', async () => {
  const fakePrisma = { $queryRaw: async () => { throw new Error('connection refused'); } };
  const result = await probePostgres(fakePrisma);
  assert.equal(result.status, 'down');
  assert.match(result.error, /connection refused/);
});

// ── probeRedis ───────────────────────────────────────────────────────────────

test('probeRedis reports unconfigured when REDIS_URL is missing', async () => {
  const result = await probeRedis({});
  assert.equal(result.status, 'unconfigured');
});

// ── probeStripe ──────────────────────────────────────────────────────────────

test('probeStripe reports unconfigured when service is not configured', async () => {
  const result = await probeStripe({ isConfigured: false });
  assert.equal(result.status, 'unconfigured');
});

test('probeStripe reports unconfigured when service is missing', async () => {
  const result = await probeStripe(null);
  assert.equal(result.status, 'unconfigured');
});

test('probeStripe reports up when ping() succeeds', async () => {
  const result = await probeStripe({
    isConfigured: true,
    ping: async () => ({ ok: true }),
  });
  assert.equal(result.status, 'up');
});

test('probeStripe reports up when stripe.products.list succeeds (no ping)', async () => {
  const result = await probeStripe({
    isConfigured: true,
    stripe: { products: { list: async () => ({ data: [] }) } },
  });
  assert.equal(result.status, 'up');
});

test('probeStripe reports down when underlying call throws', async () => {
  const result = await probeStripe({
    isConfigured: true,
    ping: async () => { throw new Error('stripe boom'); },
  });
  assert.equal(result.status, 'down');
  assert.match(result.error, /stripe boom/);
});

// ── probeSmtp ────────────────────────────────────────────────────────────────

test('probeSmtp reports unconfigured when isConfigured() returns false', async () => {
  const result = await probeSmtp({ isConfigured: () => false });
  assert.equal(result.status, 'unconfigured');
});

test('probeSmtp reports up when verify() succeeds', async () => {
  const result = await probeSmtp({
    isConfigured: () => true,
    verify: async () => true,
  });
  assert.equal(result.status, 'up');
});

test('probeSmtp reports down when verify() throws', async () => {
  const result = await probeSmtp({
    isConfigured: () => true,
    verify: async () => { throw new Error('smtp auth failed'); },
  });
  assert.equal(result.status, 'down');
  assert.match(result.error, /smtp auth failed/);
});

test('probeSmtp falls back to transporter.verify when service has no verify()', async () => {
  const result = await probeSmtp({
    isConfigured: () => true,
    transporter: { verify: (cb) => cb(null, true) },
  });
  assert.equal(result.status, 'up');
});

// ── probeProviders ───────────────────────────────────────────────────────────

test('probeProviders reflects env presence', () => {
  const out = probeProviders({
    OPENAI_API_KEY: 'sk-xxx',
    ANTHROPIC_API_KEY: '',
    GROQ_API_KEY: 'gsk_y',
    GEMINI_API_KEY: undefined,
    DEEPSEEK_API_KEY: 'ds_z',
  });
  assert.equal(out.openai.status, 'configured');
  assert.equal(out.anthropic.status, 'unconfigured');
  assert.equal(out.groq.status, 'configured');
  assert.equal(out.gemini.status, 'unconfigured');
  assert.equal(out.deepseek.status, 'configured');
});

// ── collectServiceHealth (integration of all probes with mocks) ──────────────

test('collectServiceHealth aggregates results into a healthy snapshot', async () => {
  const snapshot = await collectServiceHealth({
    prismaClient: { $queryRaw: async () => [{ ok: 1 }] },
    env: {}, // no REDIS_URL, no provider keys
    stripeSvc: { isConfigured: false },
    emailSvc: { isConfigured: () => false },
  });

  assert.equal(snapshot.overall, 'healthy');
  assert.equal(snapshot.services.postgres.status, 'up');
  assert.equal(snapshot.services.redis.status, 'unconfigured');
  assert.equal(snapshot.services.stripe.status, 'unconfigured');
  assert.equal(snapshot.services.smtp.status, 'unconfigured');
  assert.equal(snapshot.services.providers.openai.status, 'unconfigured');
  assert.ok(typeof snapshot.timestamp === 'string');
});

test('collectServiceHealth marks overall as down when postgres is down', async () => {
  const snapshot = await collectServiceHealth({
    prismaClient: { $queryRaw: async () => { throw new Error('db gone'); } },
    env: {},
    stripeSvc: { isConfigured: false },
    emailSvc: { isConfigured: () => false },
  });
  assert.equal(snapshot.overall, 'down');
  assert.equal(snapshot.services.postgres.status, 'down');
});

test('collectServiceHealth surfaces systemCron snapshot under services.systemCron', async () => {
  const fakeCron = {
    status() {
      return {
        enabled: true,
        tasks: [
          {
            name: 'fake-job',
            schedule: '0 * * * *',
            lastRun: '2026-05-19T10:00:00.000Z',
            lastDuration: 42,
            lastStatus: 'ok',
            lastError: null,
            nextRun: '2026-05-19T11:00:00.000Z',
          },
        ],
      };
    },
  };
  const snapshot = await collectServiceHealth({
    prismaClient: { $queryRaw: async () => [{ ok: 1 }] },
    env: {},
    stripeSvc: { isConfigured: false },
    emailSvc: { isConfigured: () => false },
    systemCronModule: fakeCron,
  });
  assert.ok(snapshot.services.systemCron, 'systemCron block present');
  assert.equal(snapshot.services.systemCron.status, 'up');
  assert.equal(snapshot.services.systemCron.enabled, true);
  assert.ok(Array.isArray(snapshot.services.systemCron.jobs));
  assert.equal(snapshot.services.systemCron.jobs[0].name, 'fake-job');
  assert.equal(snapshot.services.systemCron.jobs[0].lastDuration, 42);
  assert.equal(snapshot.services.systemCron.jobs[0].nextRun, '2026-05-19T11:00:00.000Z');
});

test('collectServiceHealth marks overall as degraded when stripe is down', async () => {
  const snapshot = await collectServiceHealth({
    prismaClient: { $queryRaw: async () => [{ ok: 1 }] },
    env: {},
    stripeSvc: {
      isConfigured: true,
      ping: async () => { throw new Error('stripe network err'); },
    },
    emailSvc: { isConfigured: () => false },
  });
  assert.equal(snapshot.overall, 'degraded');
  assert.equal(snapshot.services.stripe.status, 'down');
});

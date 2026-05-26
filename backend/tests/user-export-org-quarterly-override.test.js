'use strict';

/**
 * Per-org export quota override — ratchet 44 / task 2.
 *
 * Exercises `resolveExportQuarterlyLimit` + the `limit` parameter
 * threaded into `checkQuarterlyExportQuota`. Org-context requests pick
 * up `Organization.settings.export.quarterlyLimit`; everything else
 * falls back to the per-user default (10).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EXPORT_QUARTERLY_LIMIT,
  EXPORT_QUARTERLY_LIMIT_MAX,
  resolveExportQuarterlyLimit,
  checkQuarterlyExportQuota,
  recordQuarterlyExport,
} = require('../src/routes/users').INTERNAL;

function makePrisma({ orgs = new Map() } = {}) {
  const settings = new Map();
  return {
    systemSettings: {
      async findUnique({ where }) {
        return settings.get(where.key) || null;
      },
      async upsert({ where, create, update }) {
        const existing = settings.get(where.key);
        const next = existing ? { ...existing, ...update } : create;
        settings.set(where.key, next);
        return next;
      },
    },
    organization: {
      async findUnique({ where }) {
        return orgs.get(where.id) || null;
      },
    },
    _settings: settings,
  };
}

test('defaults to 10 when no org context is present', async () => {
  const prisma = makePrisma();
  const out = await resolveExportQuarterlyLimit(prisma, {});
  assert.equal(out.limit, EXPORT_QUARTERLY_LIMIT);
  assert.equal(out.source, 'default');
  assert.equal(out.orgId, null);
});

test('returns org override when set', async () => {
  const orgs = new Map([
    ['org-1', { id: 'org-1', settings: { export: { quarterlyLimit: 50 } } }],
  ]);
  const prisma = makePrisma({ orgs });
  const out = await resolveExportQuarterlyLimit(prisma, {
    orgContext: { orgId: 'org-1' },
  });
  assert.equal(out.limit, 50);
  assert.equal(out.source, 'org');
  assert.equal(out.orgId, 'org-1');
});

test('falls back to default when org settings.export.quarterlyLimit missing', async () => {
  const orgs = new Map([
    ['org-2', { id: 'org-2', settings: { branding: { primaryColor: '#000' } } }],
    ['org-3', { id: 'org-3', settings: null }],
    ['org-4', { id: 'org-4', settings: { export: {} } }],
  ]);
  const prisma = makePrisma({ orgs });
  for (const orgId of ['org-2', 'org-3', 'org-4']) {
    const out = await resolveExportQuarterlyLimit(prisma, { orgContext: { orgId } });
    assert.equal(out.limit, EXPORT_QUARTERLY_LIMIT);
    assert.equal(out.source, 'default');
    assert.equal(out.orgId, orgId);
  }
});

test('accepts a numeric string value (e.g. migration drift)', async () => {
  const orgs = new Map([
    ['org-str', { id: 'org-str', settings: { export: { quarterlyLimit: '42' } } }],
    ['org-str-zero', { id: 'org-str-zero', settings: { export: { quarterlyLimit: '0' } } }],
  ]);
  const prisma = makePrisma({ orgs });
  const ok = await resolveExportQuarterlyLimit(prisma, { orgContext: { orgId: 'org-str' } });
  assert.equal(ok.limit, 42);
  assert.equal(ok.source, 'org');
  // Zero-as-string is rejected (non-positive).
  const zero = await resolveExportQuarterlyLimit(prisma, { orgContext: { orgId: 'org-str-zero' } });
  assert.equal(zero.limit, EXPORT_QUARTERLY_LIMIT);
  assert.equal(zero.source, 'default');
});

  test('clamps absurd values into [1, EXPORT_QUARTERLY_LIMIT_MAX]', async () => {
  const orgs = new Map([
    ['org-high', { id: 'org-high', settings: { export: { quarterlyLimit: 99_999 } } }],
    ['org-low', { id: 'org-low', settings: { export: { quarterlyLimit: 0 } } }],
    ['org-neg', { id: 'org-neg', settings: { export: { quarterlyLimit: -3 } } }],
    ['org-frac', { id: 'org-frac', settings: { export: { quarterlyLimit: 25.7 } } }],
  ]);
  const prisma = makePrisma({ orgs });
  const high = await resolveExportQuarterlyLimit(prisma, { orgContext: { orgId: 'org-high' } });
  assert.equal(high.limit, EXPORT_QUARTERLY_LIMIT_MAX);
  assert.equal(high.source, 'org');
  // Non-positive values are rejected and fall back to default.
  const low = await resolveExportQuarterlyLimit(prisma, { orgContext: { orgId: 'org-low' } });
  assert.equal(low.limit, EXPORT_QUARTERLY_LIMIT);
  assert.equal(low.source, 'default');
  const neg = await resolveExportQuarterlyLimit(prisma, { orgContext: { orgId: 'org-neg' } });
  assert.equal(neg.limit, EXPORT_QUARTERLY_LIMIT);
  assert.equal(neg.source, 'default');
  // Fractional values are floored.
  const frac = await resolveExportQuarterlyLimit(prisma, { orgContext: { orgId: 'org-frac' } });
  assert.equal(frac.limit, 25);
  assert.equal(frac.source, 'org');
});

test('gracefully degrades when prisma.organization is missing', async () => {
  const prisma = makePrisma();
  delete prisma.organization;
  const out = await resolveExportQuarterlyLimit(prisma, { orgContext: { orgId: 'x' } });
  assert.equal(out.limit, EXPORT_QUARTERLY_LIMIT);
  assert.equal(out.source, 'default');
});

test('checkQuarterlyExportQuota honours an overridden limit', async () => {
  const prisma = makePrisma();
  // Record 12 exports — beyond the default 10 but still under a 50 cap.
  for (let i = 0; i < 12; i++) {
    await recordQuarterlyExport(prisma, 'u-x');
  }
  const defaultRes = await checkQuarterlyExportQuota(prisma, 'u-x');
  assert.equal(defaultRes.ok, false);
  assert.equal(defaultRes.limit, EXPORT_QUARTERLY_LIMIT);
  assert.equal(defaultRes.used, 12);

  const overrideRes = await checkQuarterlyExportQuota(prisma, 'u-x', 50);
  assert.equal(overrideRes.ok, true);
  assert.equal(overrideRes.limit, 50);
  assert.equal(overrideRes.used, 12);
});

test('checkQuarterlyExportQuota guards against bogus limit args', async () => {
  const prisma = makePrisma();
  for (let i = 0; i < EXPORT_QUARTERLY_LIMIT; i++) {
    await recordQuarterlyExport(prisma, 'u-y');
  }
  // NaN / undefined / 0 / negative → fall back to default cap.
  for (const bad of [NaN, 0, -1, undefined, null, 'abc']) {
    const res = await checkQuarterlyExportQuota(prisma, 'u-y', bad);
    assert.equal(res.limit, EXPORT_QUARTERLY_LIMIT);
    assert.equal(res.ok, false);
  }
});

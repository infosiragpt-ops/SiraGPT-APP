'use strict';

/**
 * Cycle 85 — verifies the org-members gauge metric
 * (`siragpt_org_members_total{orgId}`) is registered and refreshed
 * by both the standalone helper and the orgs router's
 * `invalidateMembersCache` hook (which rides on every OrgMembership
 * create / delete / role-change mutation).
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const metrics = require('../src/utils/metrics');
const orgsRouter = require('../src/routes/orgs');

function findGaugeValue(name, labelSubstr) {
  const text = metrics.renderText();
  const lines = text
    .split('\n')
    .filter((l) => l.startsWith(name) && !l.startsWith(`${name}_`));
  const target = labelSubstr ? lines.find((l) => l.includes(labelSubstr)) : lines[0];
  if (!target) return null;
  const parts = target.trim().split(/\s+/);
  return Number(parts[parts.length - 1]);
}

function makePrisma(countFn) {
  return {
    orgMembership: {
      count: async (args) => countFn(args),
    },
  };
}

beforeEach(() => metrics._reset());

test('siragpt_org_members_total gauge is registered with orgId label', () => {
  const text = metrics.renderText();
  assert.match(text, /# TYPE siragpt_org_members_total gauge/);
});

test('refreshOrgMembersGauge sets the gauge to the current membership count', async () => {
  const prisma = makePrisma(async ({ where }) => {
    assert.equal(where.orgId, 'org-A');
    return 7;
  });
  const v = await metrics.refreshOrgMembersGauge(prisma, 'org-A');
  assert.equal(v, 7);
  assert.equal(findGaugeValue('siragpt_org_members_total', 'orgId="org-A"'), 7);
});

test('refreshOrgMembersGauge no-ops on missing args and never throws', async () => {
  assert.equal(await metrics.refreshOrgMembersGauge(null, 'org-A'), null);
  assert.equal(await metrics.refreshOrgMembersGauge({}, 'org-A'), null);
  assert.equal(await metrics.refreshOrgMembersGauge(makePrisma(async () => 3), ''), null);
});

test('refreshOrgMembersGauge swallows prisma errors and returns null', async () => {
  const prisma = makePrisma(async () => { throw new Error('db down'); });
  const v = await metrics.refreshOrgMembersGauge(prisma, 'org-err');
  assert.equal(v, null);
  // gauge should not have been written for this org
  assert.equal(findGaugeValue('siragpt_org_members_total', 'orgId="org-err"'), null);
});

test('refreshOrgMembersGauge coerces non-finite counts to 0', async () => {
  const prisma = makePrisma(async () => Number.NaN);
  const v = await metrics.refreshOrgMembersGauge(prisma, 'org-nan');
  assert.equal(v, 0);
  assert.equal(findGaugeValue('siragpt_org_members_total', 'orgId="org-nan"'), 0);
});

test('refreshOrgMembersGauge clamps negative counts to 0', async () => {
  const prisma = makePrisma(async () => -4);
  const v = await metrics.refreshOrgMembersGauge(prisma, 'org-neg');
  assert.equal(v, 0);
  assert.equal(findGaugeValue('siragpt_org_members_total', 'orgId="org-neg"'), 0);
});

test('invalidateMembersCache hook refreshes the org-members gauge', async () => {
  // Patch the real prisma client transitively used by the router's
  // invalidateMembersCache via the metrics helper. We re-require the
  // shared prisma config and stub `orgMembership.count` for the test.
  const prisma = require('../src/config/database');
  const original = prisma.orgMembership && prisma.orgMembership.count;
  prisma.orgMembership = prisma.orgMembership || {};
  prisma.orgMembership.count = async ({ where }) => {
    assert.equal(where.orgId, 'org-hook');
    return 4;
  };
  try {
    orgsRouter.__invalidateMembersCache('org-hook');
    // refresh is fire-and-forget; await a microtask flush
    await new Promise((r) => setImmediate(r));
    assert.equal(findGaugeValue('siragpt_org_members_total', 'orgId="org-hook"'), 4);
  } finally {
    if (original) prisma.orgMembership.count = original;
  }
});

test('invalidateMembersCache no-ops when orgId is falsy', async () => {
  const evicted = orgsRouter.__invalidateMembersCache('');
  assert.equal(evicted, 0);
  // gauge registry should still be empty for this label-set
  assert.equal(findGaugeValue('siragpt_org_members_total', 'orgId=""'), null);
});

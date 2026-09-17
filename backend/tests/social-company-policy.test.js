'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  legacyPolicyKey,
  parsePolicyRow,
  policyKey,
  readPolicy,
  writePolicy,
} = require('../src/services/social-company/policy');

function makePrisma(initialRows = []) {
  const rows = new Map(initialRows.map((row) => [row.key, { ...row }]));
  return {
    rows,
    systemSettings: {
      findUnique: async ({ where }) => rows.get(where.key) || null,
      upsert: async ({ where, create, update }) => {
        const current = rows.get(where.key);
        const next = current ? { ...current, ...update } : { ...create };
        rows.set(where.key, next);
        return next;
      },
    },
  };
}

test('social policy keys isolate sibling companies owned by the same user', async () => {
  const prisma = makePrisma();

  await writePolicy(prisma, 'user-1', {
    workspaceId: 'workspace-a',
    enabled: true,
    objective: 'Objetivo de A',
  });
  await writePolicy(prisma, 'user-1', {
    projectId: 'project-b',
    enabled: false,
    objective: 'Objetivo de B',
  });

  assert.notEqual(
    policyKey('user-1', 'workspace-a'),
    policyKey('user-1', { projectId: 'project-b' }),
  );
  assert.notEqual(
    policyKey('user-1', 'workspace-a'),
    policyKey('user-2', 'workspace-a'),
  );
  assert.equal(
    (await readPolicy(prisma, 'user-1', 'workspace-a')).objective,
    'Objetivo de A',
  );
  assert.equal(
    (await readPolicy(prisma, 'user-1', { projectId: 'project-b' })).objective,
    'Objetivo de B',
  );
});

test('matching legacy policy migrates to its scoped key without leaking to a sibling company', async () => {
  const legacyKey = legacyPolicyKey('user-1');
  const legacy = {
    key: legacyKey,
    value: JSON.stringify({
      enabled: true,
      mode: 'review',
      objective: 'Política histórica de A',
      workspaceId: 'workspace-a',
    }),
  };
  const prisma = makePrisma([legacy]);

  const sibling = await readPolicy(prisma, 'user-1', 'workspace-b');
  assert.equal(sibling.enabled, false);
  assert.equal(sibling.objective, '');
  assert.equal(sibling.workspaceId, 'workspace-b');
  assert.equal(prisma.rows.has(policyKey('user-1', 'workspace-b')), false);

  const migrated = await readPolicy(prisma, 'user-1', 'workspace-a');
  assert.equal(migrated.enabled, true);
  assert.equal(migrated.objective, 'Política histórica de A');
  assert.equal(migrated.workspaceId, 'workspace-a');
  assert.equal(prisma.rows.has(policyKey('user-1', 'workspace-a')), true);
});

test('scoped key is authoritative when parsing rows and legacy rows remain readable', () => {
  const scoped = parsePolicyRow({
    key: policyKey('user:1', 'workspace/a'),
    value: JSON.stringify({
      enabled: true,
      workspaceId: 'tampered-workspace',
    }),
  });
  assert.equal(scoped.userId, 'user:1');
  assert.equal(scoped.workspaceId, 'workspace/a');
  assert.equal(scoped.policy.workspaceId, 'workspace/a');

  const legacy = parsePolicyRow({
    key: legacyPolicyKey('user-legacy'),
    value: JSON.stringify({
      enabled: true,
      workspaceId: 'workspace-legacy',
    }),
  });
  assert.equal(legacy.userId, 'user-legacy');
  assert.equal(legacy.workspaceId, 'workspace-legacy');
});

test('new social policy writes reject an ambiguous unscoped key', async () => {
  const prisma = makePrisma();
  await assert.rejects(
    () => writePolicy(prisma, 'user-1', { enabled: true }),
    (error) => error.code === 'SOCIAL_POLICY_SCOPE_REQUIRED',
  );
  assert.equal(prisma.rows.size, 0);
});

test('an explicitly invalid scope fails closed instead of reading the user-wide legacy policy', async () => {
  const prisma = makePrisma([{
    key: legacyPolicyKey('user-1'),
    value: JSON.stringify({
      enabled: true,
      mode: 'auto',
      workspaceId: 'workspace-a',
    }),
  }]);
  const policy = await readPolicy(prisma, 'user-1', 'x'.repeat(181));
  assert.equal(policy.enabled, false);
  assert.equal(policy.mode, 'review');
  assert.equal(policy.workspaceId, null);
});

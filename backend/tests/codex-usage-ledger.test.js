'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { recordUsage } = require('../src/services/codex/usage-ledger');

test('autonomous usage persists provider cost with exact project and pool attribution', async () => {
  const rows = [];
  const prisma = {
    codexUsageEntry: {
      async create({ data }) {
        const row = { id: 'usage-1', ...structuredClone(data) };
        rows.push(row);
        return structuredClone(row);
      },
      async findUnique() {
        return null;
      },
    },
  };

  const row = await recordUsage({
    prisma,
    projectId: 'project-1',
    departmentPoolId: 'pool-trust',
    source: 'fleet_qa',
    sourceId: 'review-1',
    idempotencyKey: 'fleet-qa:review-1:turn-1',
    usage: { tokensIn: 120, tokensOut: 30, model: 'qa-model' },
    costResolver: async () => ({
      costUsd: 0.125,
      costInputUsd: 0.1,
      costOutputUsd: 0.025,
      costSource: 'provider_exact',
    }),
  });

  assert.equal(rows.length, 1);
  assert.equal(row.projectId, 'project-1');
  assert.equal(row.departmentPoolId, 'pool-trust');
  assert.equal(row.source, 'fleet_qa');
  assert.equal(row.sourceId, 'review-1');
  assert.equal(row.tokensIn, 120);
  assert.equal(row.tokensOut, 30);
  assert.equal(row.costOriginalUsd, 0.125);
  assert.equal(row.costAppliedUsd, 0.125);
});

test('usage ledger reuses an existing idempotency key and fails closed without storage', async () => {
  const existing = {
    id: 'usage-existing',
    projectId: 'project-1',
    source: 'swarm_task',
    sourceId: 'task-1',
    idempotencyKey: 'swarm:task-1:turn-1',
    costOriginalUsd: 0.2,
  };
  const prisma = {
    codexUsageEntry: {
      async create() {
        const error = new Error('unique');
        error.code = 'P2002';
        throw error;
      },
      async findUnique() {
        return structuredClone(existing);
      },
    },
  };
  const row = await recordUsage({
    prisma,
    projectId: 'project-1',
    source: 'swarm_task',
    sourceId: 'task-1',
    idempotencyKey: 'swarm:task-1:turn-1',
    usage: {},
    costResolver: async () => ({ costUsd: 0.2 }),
  });
  assert.deepEqual(row, existing);

  await assert.rejects(
    recordUsage({
      prisma: {},
      projectId: 'project-1',
      source: 'swarm_task',
      sourceId: 'task-1',
      idempotencyKey: 'missing-store',
      usage: {},
    }),
    /codex_usage_ledger_unavailable/,
  );
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SOURCES,
  recordCompletionUsage,
  recordUsage,
} = require('../src/services/codex/usage-ledger');

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

test('direct autonomous sources are explicit and one provider generation is counted once', async () => {
  for (const source of [
    'fleet_planner',
    'proactive_proposal',
    'sales_research',
    'sales_outreach',
    'inbox_triage',
    'social_triage',
    'social_autopilot',
  ]) {
    assert.equal(SOURCES.has(source), true, `${source} must be an auditable ledger source`);
  }

  const rows = [];
  const prisma = {
    codexUsageEntry: {
      async create({ data }) {
        if (rows.some((row) => row.idempotencyKey === data.idempotencyKey)) {
          const error = new Error('unique');
          error.code = 'P2002';
          throw error;
        }
        const row = { id: `usage-${rows.length + 1}`, ...structuredClone(data) };
        rows.push(row);
        return structuredClone(row);
      },
      async findUnique({ where }) {
        return structuredClone(
          rows.find((row) => row.idempotencyKey === where.idempotencyKey) || null,
        );
      },
    },
  };
  const completion = {
    content: '{}',
    usage: {
      tokensIn: 100,
      tokensOut: 25,
      provider: 'Anthropic',
      model: 'claude-sonnet-4-6',
      generationId: 'generation-shared-1',
    },
  };
  const args = {
    prisma,
    projectId: 'project-1',
    departmentPoolId: 'pool-sales',
    source: 'sales_research',
    sourceId: 'lead-research:project-1',
    completion,
    costResolver: async () => ({
      costUsd: 0.05,
      costInputUsd: 0.04,
      costOutputUsd: 0.01,
      costSource: 'provider_exact',
    }),
  };

  const first = await recordCompletionUsage({ ...args, callId: 'local-call-a' });
  const replay = await recordCompletionUsage({
    ...args,
    source: 'sales_outreach',
    sourceId: 'lead-outreach:lead-1',
    callId: 'local-call-b',
  });

  assert.equal(rows.length, 1);
  assert.equal(replay.id, first.id);
  assert.equal(rows[0].departmentPoolId, 'pool-sales');
  assert.equal(rows[0].costOriginalUsd, 0.05);
  assert.match(rows[0].idempotencyKey, /^codex-llm:v1:[a-f0-9]{64}$/);
});

test('local call identity deduplicates completions that omit a provider generation id', async () => {
  const rows = [];
  const prisma = {
    codexUsageEntry: {
      async create({ data }) {
        if (rows.some((row) => row.idempotencyKey === data.idempotencyKey)) {
          const error = new Error('unique');
          error.code = 'P2002';
          throw error;
        }
        const row = { id: `usage-${rows.length + 1}`, ...structuredClone(data) };
        rows.push(row);
        return row;
      },
      async findUnique({ where }) {
        return rows.find((row) => row.idempotencyKey === where.idempotencyKey) || null;
      },
    },
  };
  const args = {
    prisma,
    projectId: 'project-1',
    source: 'inbox_triage',
    sourceId: 'gmail-inbox:project-1',
    completion: {
      content: '{}',
      usage: { tokensIn: 10, tokensOut: 5, provider: 'Anthropic' },
    },
    callId: 'stable-local-call',
    costResolver: async () => ({ costUsd: 0.01, costSource: 'provider_exact' }),
  };
  await recordCompletionUsage(args);
  await recordCompletionUsage(args);
  assert.equal(rows.length, 1);
});

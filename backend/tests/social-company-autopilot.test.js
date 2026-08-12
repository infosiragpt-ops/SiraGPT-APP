'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createScheduledPostOnce,
  generateDepartmentPost,
  runAutopilot,
} = require('../src/services/social-company/autopilot');
const {
  legacyPolicyKey,
  policyKey,
} = require('../src/services/social-company/policy');
const {
  socialResourceKeyForConnection,
} = require('../src/services/codex/company-resources');

function socialConnection(platform) {
  return {
    id: `connection-${platform}`,
    platform,
    accountId: `account-${platform}`,
    accessToken: `token-${platform}`,
  };
}

function socialKey(platform) {
  return socialResourceKeyForConnection(socialConnection(platform));
}

function activeCompanyProject(where, assignments = { [socialKey('linkedin')]: 'marketing' }) {
  return {
    id: where.id,
    userId: where.userId,
    deletedAt: null,
    brief: {
      companyResources: {
        assignments,
        pinned: [],
      },
    },
    companyLink: {
      project: {
        id: `company-${where.id}`,
        userId: where.userId,
        deletedAt: null,
      },
    },
  };
}

function withOperationBudget(prisma, {
  poolEnabled = true,
  poolBudgetUsd = null,
} = {}) {
  const usageRows = [];
  prisma.codexRunMetric ||= { findMany: async () => [] };
  prisma.codexUsageEntry ||= {
    create: async ({ data }) => {
      const row = { id: `usage-${usageRows.length + 1}`, ...data };
      usageRows.push(row);
      return structuredClone(row);
    },
    findUnique: async ({ where }) => usageRows.find(
      (row) => row.idempotencyKey === where.idempotencyKey,
    ) || null,
  };
  prisma.codexUsageEntry.findMany ||= async () => usageRows.map((row) => structuredClone(row));
  prisma.codexDepartmentPool ||= {
    findUnique: async ({ where }) => ({
      id: where.id || 'pool-marketing',
      projectId: where.projectId_departmentId?.projectId || 'workspace-a',
      departmentId: where.projectId_departmentId?.departmentId || 'marketing',
      size: 2,
      enabled: poolEnabled,
      dailyBudgetUsd: poolBudgetUsd,
    }),
  };
  return prisma;
}

test('CEO autopilot creates at most one approved daily post for connected enabled channels', async () => {
  const creates = [];
  const usageRows = [];
  const prisma = {
    codexDepartmentPool: {
      findUnique: async ({ where }) => ({
        id: 'pool-marketing',
        projectId: where.projectId_departmentId.projectId,
        departmentId: where.projectId_departmentId.departmentId,
        size: 2,
        enabled: true,
      }),
    },
    codexUsageEntry: {
      create: async ({ data }) => {
        const row = { id: `usage-${usageRows.length + 1}`, ...data };
        usageRows.push(row);
        return row;
      },
      findUnique: async () => null,
    },
    codexProject: {
      findFirst: async ({ where }) => activeCompanyProject(where, {
        [socialKey('linkedin')]: 'marketing',
        [socialKey('x')]: 'marketing',
      }),
    },
    systemSettings: {
      findMany: async () => [{
        key: 'social_company_policy:u1',
        value: JSON.stringify({
          enabled: true,
          mode: 'auto',
          autopilot: true,
          objective: 'Enseñar a equipos a usar IA responsablemente',
          platforms: { facebook: true, linkedin: true, x: true },
          workspaceId: 'workspace-a',
        }),
      }],
    },
    scheduledPost: {
      findFirst: async () => null,
      create: async ({ data }) => {
        creates.push(data);
        return { id: 'post-auto-1', ...data };
      },
    },
    socialConnection: {
      findMany: async () => [socialConnection('linkedin'), socialConnection('x')],
    },
  };
  const result = await runAutopilot({
    prisma: withOperationBudget(prisma),
    now: () => new Date('2026-07-23T18:00:00.000Z'),
    chatComplete: async () => ({
      content: JSON.stringify({
        caption: 'Tres prácticas concretas para introducir IA con control humano.',
        mediaBrief: 'Equipo revisando un tablero de riesgos y resultados.',
      }),
      usage: {
        tokensIn: 150,
        tokensOut: 45,
        provider: 'Anthropic',
        model: 'claude-sonnet-4-6',
        generationId: 'social-autopilot-1',
      },
    }),
  });
  assert.equal(result[0].action, 'generated');
  assert.deepEqual(creates[0].platforms, ['linkedin', 'x']);
  assert.equal(creates[0].config.approved, true);
  assert.equal(creates[0].config.source, 'ceo_autopilot');
  assert.equal(creates[0].config.workspaceId, 'workspace-a');
  assert.match(creates[0].batchId, /^ceo-autopilot:2026-07-23:u1:workspace-a$/);
  assert.equal(usageRows.length, 1);
  assert.equal(usageRows[0].source, 'social_autopilot');
  assert.equal(usageRows[0].projectId, 'workspace-a');
  assert.equal(usageRows[0].departmentPoolId, 'pool-marketing');
});

test('CEO autopilot uses only social channels assigned to Marketing in its owned project', async () => {
  const creates = [];
  let projectWhere = null;
  const prisma = {
    codexProject: {
      findFirst: async ({ where }) => {
        projectWhere = where;
        return {
          ...activeCompanyProject(where, {
            [socialKey('linkedin')]: 'marketing',
            [socialKey('x')]: 'sales',
          }),
        };
      },
    },
    systemSettings: {
      findMany: async () => [{
        key: policyKey('u1', 'workspace-a'),
        value: JSON.stringify({
          enabled: true,
          mode: 'auto',
          autopilot: true,
          objective: 'Publicar avances verificables',
          platforms: { facebook: true, linkedin: true, x: true },
          workspaceId: 'workspace-a',
        }),
      }],
    },
    scheduledPost: {
      findFirst: async () => null,
      create: async ({ data }) => {
        creates.push(data);
        return { id: 'post-resource-filtered', ...data };
      },
    },
    socialConnection: {
      findMany: async () => [socialConnection('linkedin'), socialConnection('x')],
    },
  };

  const result = await runAutopilot({
    prisma: withOperationBudget(prisma),
    now: () => new Date('2026-07-27T18:00:00.000Z'),
    chatComplete: async () => ({
      content: '{"caption":"Avance comprobable.","mediaBrief":""}',
    }),
  });

  assert.equal(result[0].action, 'generated');
  assert.deepEqual(creates[0].platforms, ['linkedin']);
  assert.deepEqual(projectWhere, {
    id: 'workspace-a',
    userId: 'u1',
    deletedAt: null,
  });
});

test('proactive Marketing creates an unapproved draft under the default review policy', async () => {
  const creates = [];
  const policyReads = [];
  const prisma = {
    codexProject: {
      findFirst: async ({ where }) => activeCompanyProject(where),
    },
    systemSettings: {
      findUnique: async ({ where }) => {
        policyReads.push(where.key);
        return {
          value: JSON.stringify({
            enabled: true,
            mode: 'review',
            autopilot: true,
            objective: 'Explicar mejoras reales del producto',
            platforms: { linkedin: true, x: true },
          }),
        };
      },
    },
    scheduledPost: {
      findFirst: async () => null,
      create: async ({ data }) => {
        creates.push(data);
        return { id: 'post-review-1', ...data };
      },
    },
    socialConnection: {
      findMany: async () => [socialConnection('linkedin')],
    },
  };
  const result = await generateDepartmentPost({
    prisma: withOperationBudget(prisma),
    project: { id: 'p1', userId: 'u1', name: 'SiraGPT' },
    ledger: [{ runId: 'r1', outcome: 'passed', task: 'Gate de navegador', diffstat: { additions: 10, deletions: 2 } }],
    objectives: [{ title: 'Mejorar activación', target: '50%' }],
    now: () => new Date('2026-07-26T12:00:00.000Z'),
    chatComplete: async () => ({ content: '{"caption":"Mejoramos la verificación real de cada app.","mediaBrief":""}' }),
  });
  assert.equal(result.action, 'drafted_review');
  assert.deepEqual(creates[0].platforms, ['linkedin']);
  assert.equal(creates[0].status, 'draft');
  assert.equal(creates[0].scheduledAt, null);
  assert.equal(creates[0].config.approved, false);
  assert.equal(creates[0].config.source, 'proactive_marketing');
  assert.deepEqual(policyReads, [policyKey('u1', 'p1')]);
});

test('CEO autopilot keeps daily generation and objectives isolated per workspace', async () => {
  const creates = [];
  const policies = [
    ['workspace-a', 'Objetivo exclusivo A'],
    ['workspace-b', 'Objetivo exclusivo B'],
  ];
  const prisma = {
    codexProject: {
      findFirst: async ({ where }) => activeCompanyProject(where),
    },
    systemSettings: {
      findMany: async () => [
        {
          key: legacyPolicyKey('u1'),
          value: JSON.stringify({
            enabled: true,
            mode: 'auto',
            autopilot: true,
            objective: 'Objetivo obsoleto de A',
            workspaceId: 'workspace-a',
          }),
        },
        ...policies.map(([workspaceId, objective]) => ({
          key: policyKey('u1', workspaceId),
          value: JSON.stringify({
            enabled: true,
            mode: 'auto',
            autopilot: true,
            objective,
            workspaceId,
            platforms: { facebook: false, linkedin: true, x: false },
          }),
        })),
      ],
    },
    scheduledPost: {
      findFirst: async () => null,
      create: async ({ data }) => {
        creates.push(data);
        return { id: `post-${creates.length}`, ...data };
      },
    },
    socialConnection: {
      findMany: async () => [socialConnection('linkedin')],
    },
  };

  const results = await runAutopilot({
    prisma: withOperationBudget(prisma),
    now: () => new Date('2026-07-27T12:00:00.000Z'),
    chatComplete: async ({ messages }) => ({
      content: JSON.stringify({
        caption: messages[1].content.includes('Objetivo exclusivo A') ? 'Contenido A' : 'Contenido B',
        mediaBrief: '',
      }),
    }),
  });

  assert.equal(results.length, 2);
  assert.deepEqual(results.map((row) => row.workspaceId), ['workspace-a', 'workspace-b']);
  assert.deepEqual(creates.map((row) => row.prompt), ['Objetivo exclusivo A', 'Objetivo exclusivo B']);
  assert.equal(new Set(creates.map((row) => row.batchId)).size, 2);
  assert.match(creates[0].batchId, /:workspace-a$/);
  assert.match(creates[1].batchId, /:workspace-b$/);
});

test('CEO autopilot paginates before preferring a paused v2 policy over stale legacy auto', async () => {
  const staleUserId = 'legacy-target';
  const rows = [
    {
      key: legacyPolicyKey(staleUserId),
      value: JSON.stringify({
        enabled: true,
        mode: 'auto',
        autopilot: true,
        objective: 'STALE',
        workspaceId: 'workspace-a',
      }),
    },
    ...Array.from({ length: 24 }, (_, index) => ({
      key: legacyPolicyKey(`dummy-${String(index).padStart(2, '0')}`),
      value: JSON.stringify({ enabled: false }),
    })),
    {
      key: policyKey(staleUserId, 'workspace-a'),
      value: JSON.stringify({
        enabled: false,
        mode: 'review',
        autopilot: false,
        workspaceId: 'workspace-a',
      }),
    },
  ].sort((a, b) => a.key.localeCompare(b.key));
  let projectReads = 0;
  let creates = 0;
  const prisma = {
    codexProject: {
      findFirst: async () => {
        projectReads += 1;
        return null;
      },
    },
    systemSettings: {
      findMany: async ({ cursor, take }) => {
        const start = cursor
          ? rows.findIndex((row) => row.key === cursor.key) + 1
          : 0;
        return rows.slice(start, start + take);
      },
    },
    scheduledPost: {
      create: async () => {
        creates += 1;
        return { id: 'unexpected' };
      },
    },
  };

  const results = await runAutopilot({ prisma, maxUsers: 25 });
  assert.deepEqual(results, []);
  assert.equal(projectReads, 0);
  assert.equal(creates, 0);
});

test('proactive Marketing filters connected channels through an explicit platform allowlist', async () => {
  const creates = [];
  const prisma = {
    codexProject: {
      findFirst: async ({ where }) => activeCompanyProject(where, {
        [socialKey('facebook')]: 'marketing',
        [socialKey('linkedin')]: 'marketing',
        [socialKey('x')]: 'marketing',
      }),
    },
    systemSettings: {
      findUnique: async () => ({
        value: JSON.stringify({
          enabled: true,
          mode: 'review',
          autopilot: true,
          objective: 'Compartir avances comprobables',
          platforms: { facebook: true, linkedin: true, x: true },
        }),
      }),
    },
    scheduledPost: {
      findFirst: async () => null,
      create: async ({ data }) => {
        creates.push(data);
        return { id: 'post-allowlisted-1', ...data };
      },
    },
    socialConnection: {
      findMany: async () => [
        socialConnection('facebook'),
        socialConnection('linkedin'),
        socialConnection('x'),
      ],
    },
  };
  const result = await generateDepartmentPost({
    prisma: withOperationBudget(prisma),
    project: { id: 'p1', userId: 'u1', name: 'SiraGPT' },
    allowedPlatforms: ['linkedin'],
    now: () => new Date('2026-07-26T12:00:00.000Z'),
    chatComplete: async () => ({ content: '{"caption":"Publicamos un avance verificable.","mediaBrief":""}' }),
  });
  assert.equal(result.action, 'drafted_review');
  assert.deepEqual(result.platforms, ['linkedin']);
  assert.deepEqual(creates[0].platforms, ['linkedin']);
});

test('proactive Marketing budget zero blocks content generation before the LLM provider', async () => {
  let llmCalls = 0;
  const prisma = withOperationBudget({
    codexProject: {
      findFirst: async ({ where }) => {
        const project = activeCompanyProject(where);
        project.brief.proactive = { configuredDailyBudgetUsd: 0 };
        return project;
      },
    },
    systemSettings: {
      findUnique: async () => ({
        value: JSON.stringify({
          enabled: true,
          mode: 'review',
          autopilot: true,
          objective: 'No gastar fuera del presupuesto',
          platforms: { linkedin: true },
        }),
      }),
    },
    scheduledPost: { findFirst: async () => null },
    socialConnection: { findMany: async () => [socialConnection('linkedin')] },
  });

  await assert.rejects(
    generateDepartmentPost({
      prisma,
      project: { id: 'p-budget-zero', userId: 'u1' },
      chatComplete: async () => {
        llmCalls += 1;
        return { content: '{"caption":"no","mediaBrief":""}' };
      },
    }),
    (error) => error?.code === 'company_daily_budget_exceeded',
  );
  assert.equal(llmCalls, 0);
});

test('CEO autopilot paused Marketing pool blocks content generation before the LLM provider', async () => {
  let llmCalls = 0;
  const prisma = withOperationBudget({
    codexProject: {
      findFirst: async ({ where }) => activeCompanyProject(where),
    },
    systemSettings: {
      findMany: async () => [{
        key: policyKey('u1', 'workspace-a'),
        value: JSON.stringify({
          enabled: true,
          mode: 'auto',
          autopilot: true,
          objective: 'No publicar con el pool pausado',
          workspaceId: 'workspace-a',
          platforms: { linkedin: true },
        }),
      }],
    },
    scheduledPost: { findFirst: async () => null },
    socialConnection: { findMany: async () => [socialConnection('linkedin')] },
  }, { poolEnabled: false });

  const result = await runAutopilot({
    prisma,
    logger: { warn: () => {} },
    chatComplete: async () => {
      llmCalls += 1;
      return { content: '{"caption":"no","mediaBrief":""}' };
    },
  });
  assert.equal(result[0].action, 'error');
  assert.match(result[0].error, /department_pool_disabled/);
  assert.equal(llmCalls, 0);
});

test('CEO autopilot fails closed when Marketing has zero assigned social resources', async () => {
  let llmCalls = 0;
  let creates = 0;
  const prisma = {
    codexProject: {
      findFirst: async ({ where }) => activeCompanyProject(where, {}),
    },
    systemSettings: {
      findMany: async () => [{
        key: policyKey('u1', 'workspace-a'),
        value: JSON.stringify({
          enabled: true,
          mode: 'auto',
          autopilot: true,
          objective: 'No debe publicarse',
          workspaceId: 'workspace-a',
          platforms: { facebook: true, linkedin: true, x: true },
        }),
      }],
    },
    scheduledPost: {
      findFirst: async () => null,
      create: async () => {
        creates += 1;
        return { id: 'unexpected' };
      },
    },
    socialConnection: {
      findMany: async () => [socialConnection('linkedin')],
    },
  };
  const result = await runAutopilot({
    prisma,
    chatComplete: async () => {
      llmCalls += 1;
      return { content: '{"caption":"no","mediaBrief":""}' };
    },
  });
  assert.equal(result[0].action, 'skipped_no_connections');
  assert.equal(llmCalls, 0);
  assert.equal(creates, 0);
});

test('CEO autopilot stops when the durably linked Company Project is deleted', async () => {
  let connectionReads = 0;
  const prisma = {
    codexProject: {
      findFirst: async ({ where }) => {
        const project = activeCompanyProject(where);
        project.companyLink.project.deletedAt = new Date();
        return project;
      },
    },
    systemSettings: {
      findMany: async () => [{
        key: policyKey('u1', 'workspace-a'),
        value: JSON.stringify({
          enabled: true,
          mode: 'auto',
          autopilot: true,
          objective: 'No debe publicarse',
          workspaceId: 'workspace-a',
        }),
      }],
    },
    socialConnection: {
      findMany: async () => {
        connectionReads += 1;
        return [{ platform: 'linkedin' }];
      },
    },
  };
  const result = await runAutopilot({ prisma });
  assert.equal(result[0].action, 'skipped_project_not_found');
  assert.equal(connectionReads, 0);
});

test('autopilot serializes final batch insertion with a PostgreSQL advisory transaction lock', async () => {
  let stored = null;
  let createCalls = 0;
  const lockQueries = [];
  const tx = {
    $queryRawUnsafe: async (sql, ...params) => {
      lockQueries.push({ sql, params });
      return [{ locked: 1 }];
    },
    scheduledPost: {
      findFirst: async () => stored,
      create: async ({ data }) => {
        createCalls += 1;
        stored = { id: 'post-once', status: data.status, ...data };
        return stored;
      },
    },
  };
  const prisma = {
    $queryRawUnsafe: async () => [],
    $transaction: async (callback) => callback(tx),
  };
  const input = {
    prisma,
    userId: 'u1',
    batchId: 'ceo-autopilot:2026-07-27:u1:workspace-a',
    data: {
      userId: 'u1',
      prompt: 'Objetivo',
      platforms: ['linkedin'],
      status: 'scheduled',
      batchId: 'ceo-autopilot:2026-07-27:u1:workspace-a',
    },
  };

  const first = await createScheduledPostOnce(input);
  const second = await createScheduledPostOnce(input);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(createCalls, 1);
  assert.equal(lockQueries.length, 2);
  assert.match(lockQueries[0].sql, /pg_advisory_xact_lock/);
  assert.match(lockQueries[0].sql, /SELECT 1::int AS locked FROM _lock/);
});

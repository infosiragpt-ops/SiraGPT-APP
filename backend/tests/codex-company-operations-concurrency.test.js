'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const externalActions = require('../src/services/codex/company-operations/external-actions');
const sales = require('../src/services/codex/company-operations/sales-pipeline');

function pendingEmailAction({ id, targetRef, now }) {
  const attemptId = 'attempt-1';
  const action = {
    id,
    projectId: 'project-1',
    userId: 'user-1',
    kind: 'email_reply',
    targetRef,
    status: 'pending_review',
    attemptId,
    expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
    consumedAt: null,
    revokedAt: null,
    payload: { providerDraftId: `draft-${targetRef}`, messageId: targetRef, body: 'Respuesta exacta' },
    updatedAt: now,
    executedAt: null,
  };
  action.payload._approval = {
    version: 1,
    actionHash: externalActions.actionHash(action),
    mode: 'pending_review',
    actorId: null,
    attemptId,
    expiresAt: action.expiresAt.toISOString(),
  };
  return action;
}

function matchesStatus(actual, expected) {
  if (typeof expected === 'string') return actual === expected;
  if (Array.isArray(expected?.in)) return expected.in.includes(actual);
  return true;
}

function externalActionPrisma(actions, {
  resourceDepartment = 'customer-success',
  companyDeletedAt = null,
  failCompletionUpdate = false,
  poolBudgetUsd = null,
} = {}) {
  let completionUpdateFailed = false;
  const usageRows = [];
  const project = {
    id: 'project-1',
    userId: 'user-1',
    deletedAt: null,
    name: 'SiraGPT',
    brief: {
      companyProfile: {
        autonomy: { emailReplies: 'review', leadOutreach: 'review' },
      },
      companyResources: {
        assignments: { 'connector:gmail': resourceDepartment },
        pinned: [],
      },
    },
    companyLink: {
      project: {
        id: 'company-1',
        userId: 'user-1',
        deletedAt: companyDeletedAt,
      },
    },
  };
  return {
    _usageRows: usageRows,
    codexDepartmentPool: {
      findUnique: async ({ where }) => ({
        id: where.id || `pool-${where.projectId_departmentId.departmentId}`,
        projectId: where.projectId_departmentId?.projectId || 'project-1',
        departmentId: where.projectId_departmentId?.departmentId || 'sales',
        size: 2,
        enabled: true,
        dailyBudgetUsd: poolBudgetUsd,
      }),
    },
    codexUsageEntry: {
      create: async ({ data }) => {
        if (usageRows.some((row) => row.idempotencyKey === data.idempotencyKey)) {
          const error = new Error('unique');
          error.code = 'P2002';
          throw error;
        }
        const row = { id: `usage-${usageRows.length + 1}`, ...data };
        usageRows.push(row);
        return structuredClone(row);
      },
      findUnique: async ({ where }) => usageRows.find(
        (row) => row.idempotencyKey === where.idempotencyKey,
      ) || null,
      findMany: async () => usageRows.map((row) => structuredClone(row)),
    },
    codexRunMetric: { findMany: async () => [] },
    codexProject: {
      findFirst: async ({ where }) => (
        where.id === project.id
        && where.userId === project.userId
        && project.deletedAt == null
          ? structuredClone(project)
          : null
      ),
    },
    user: { findUnique: async () => ({ gmailTokens: { accessToken: 'encrypted' } }) },
    connectorAccount: {
      findFirst: async ({ where }) => (
        where.userId === 'user-1'
        && where.provider === 'gmail'
        && where.status === 'connected'
          ? { id: 'connector-gmail', userId: 'user-1', provider: 'gmail', status: 'connected' }
          : null
      ),
    },
    projectConnectorAssignment: {
      findFirst: async ({ where }) => (
        where.projectId === 'company-1'
        && where.connectorAccountId === 'connector-gmail'
        && where.status === 'active'
          ? { id: 'assignment-gmail', ...where }
          : null
      ),
    },
    codexExternalAction: {
      findFirst: async ({ where }) => actions.find((row) =>
        (!where.id || row.id === where.id)
        && (!where.idempotencyKey || row.idempotencyKey === where.idempotencyKey)
        && (!where.projectId || row.projectId === where.projectId)
        && (!where.userId || row.userId === where.userId)) || null,
      findUnique: async ({ where }) => actions.find((row) =>
        (!where.id || row.id === where.id)
        && (!where.idempotencyKey || row.idempotencyKey === where.idempotencyKey)) || null,
      count: async ({ where }) => actions.filter((row) =>
        row.projectId === where.projectId
        && row.kind === where.kind
        && matchesStatus(row.status, where.status)).length,
      create: async ({ data }) => {
        await new Promise((resolve) => setImmediate(resolve));
        if (actions.some((row) => row.idempotencyKey === data.idempotencyKey)) {
          const error = new Error('unique');
          error.code = 'P2002';
          throw error;
        }
        const row = { id: `action-${actions.length + 1}`, updatedAt: new Date(), ...data };
        actions.push(row);
        return structuredClone(row);
      },
      update: async ({ where, data }) => {
        if (failCompletionUpdate && data.status === 'completed' && !completionUpdateFailed) {
          completionUpdateFailed = true;
          throw new Error('simulated post-provider persistence failure');
        }
        const row = actions.find((item) => item.id === where.id);
        Object.assign(row, data, { updatedAt: new Date() });
        return structuredClone(row);
      },
      updateMany: async ({ where, data }) => {
        const rows = actions.filter((row) =>
          (!where.id || row.id === where.id)
          && (!where.projectId || row.projectId === where.projectId)
          && (!where.userId || row.userId === where.userId)
          && (!where.status || matchesStatus(row.status, where.status))
          && (!('consumedAt' in where) || row.consumedAt === where.consumedAt)
          && (!where.payload?.equals || JSON.stringify(row.payload) === JSON.stringify(where.payload.equals)));
        rows.forEach((row) => Object.assign(row, data, { updatedAt: new Date() }));
        return { count: rows.length };
      },
    },
    codexCompanyInboxItem: { updateMany: async () => ({ count: 1 }) },
    codexCompanyLead: {
      updateMany: async () => ({ count: 1 }),
    },
  };
}

test('two concurrent approvals consume one remaining daily email slot', async () => {
  const now = new Date('2026-07-27T12:00:00.000Z');
  const actions = [
    pendingEmailAction({ id: 'action-1', targetRef: 'message-1', now }),
    pendingEmailAction({ id: 'action-2', targetRef: 'message-2', now }),
  ];
  const prisma = externalActionPrisma(actions);
  let sends = 0;
  const gmailLoader = async () => ({
    client: {
      replyToEmail: async () => {
        sends += 1;
        return { messageId: `sent-${sends}` };
      },
    },
  });
  const project = { id: 'project-1', userId: 'user-1' };
  const results = await Promise.all([
    externalActions.approveExternalAction({
      prisma,
      project,
      actionId: 'action-1',
      actionHash: actions[0].payload._approval.actionHash,
      actionVersion: 1,
      actorId: 'user-1',
      gmailLoader,
      now: () => now,
      env: { CODEX_EMAIL_REPLY_DAILY_LIMIT: '1' },
    }),
    externalActions.approveExternalAction({
      prisma,
      project,
      actionId: 'action-2',
      actionHash: actions[1].payload._approval.actionHash,
      actionVersion: 1,
      actorId: 'user-1',
      gmailLoader,
      now: () => now,
      env: { CODEX_EMAIL_REPLY_DAILY_LIMIT: '1' },
    }),
  ]);
  assert.equal(sends, 1);
  assert.equal(results.filter((result) => result.action === 'completed').length, 1);
  assert.equal(results.filter((result) => result.action === 'daily_limit_reached').length, 1);
  assert.deepEqual(actions.map((row) => row.status).sort(), ['completed', 'pending_review']);
});

test('concurrent lead preparation creates one durable action before one Gmail draft', async () => {
  const actions = [];
  const prisma = externalActionPrisma(actions, { resourceDepartment: 'sales' });
  prisma.codexCompanyLead.findFirst = async () => ({
    id: 'lead-1',
    projectId: 'project-1',
    userId: 'user-1',
    companyName: 'Empresa Alfa',
    email: 'ventas@alfa.example',
    status: 'qualified',
    evidence: 'Empresa B2B verificada.',
    sourceUrl: 'https://alfa.example',
  });
  let drafts = 0;
  let llmCalls = 0;
  const args = {
    prisma,
    project: { id: 'project-1', userId: 'user-1' },
    companyContext: {
      profile: {
        companyName: 'SiraGPT',
        offer: 'Agentes de software',
        targetCustomer: 'Empresas B2B',
        autonomy: { leadOutreach: 'review' },
      },
      readiness: { evidence: { gmailConnected: true } },
    },
    chatComplete: async () => {
      llmCalls += 1;
      return {
        content: '{"subject":"Propuesta para Alfa","body":"Hola, esta es una propuesta verificable."}',
        usage: {
          tokensIn: 90,
          tokensOut: 35,
          provider: 'Anthropic',
          model: 'claude-sonnet-4-6',
          generationId: `sales-outreach-${llmCalls}`,
        },
      };
    },
    gmailLoader: async () => ({
      client: {
        createDraft: async () => {
          drafts += 1;
          return { draftId: 'draft-1' };
        },
      },
    }),
  };
  const results = await Promise.all([
    sales.prepareLeadOutreach(args),
    sales.prepareLeadOutreach(args),
  ]);
  assert.equal(actions.length, 1);
  assert.equal(drafts, 1);
  assert.equal(results.filter((result) => result.action === 'outreach_review').length, 1);
  assert.equal(results.filter((result) => result.action === 'outreach_already_prepared').length, 1);
  assert.equal(prisma._usageRows.length, llmCalls);
  assert.equal(prisma._usageRows.every((row) => row.source === 'sales_outreach'), true);
  assert.equal(prisma._usageRows.every((row) => row.departmentPoolId === 'pool-sales'), true);
});

test('lead outreach pool budget zero blocks the LLM provider before spend', async () => {
  const actions = [];
  const prisma = externalActionPrisma(actions, {
    resourceDepartment: 'sales',
    poolBudgetUsd: 0,
  });
  prisma.codexCompanyLead.findFirst = async () => ({
    id: 'lead-budget-zero',
    projectId: 'project-1',
    userId: 'user-1',
    companyName: 'Empresa Alfa',
    email: 'ventas@alfa.example',
    status: 'qualified',
  });
  let llmCalls = 0;
  await assert.rejects(
    sales.prepareLeadOutreach({
      prisma,
      project: { id: 'project-1', userId: 'user-1' },
      leadId: 'lead-budget-zero',
      companyContext: {
        profile: { autonomy: { leadOutreach: 'review' } },
        readiness: { evidence: { gmailConnected: true } },
      },
      chatComplete: async () => {
        llmCalls += 1;
        return { content: '{"subject":"x","body":"y"}' };
      },
    }),
    (error) => error?.code === 'department_pool_daily_budget_exceeded'
      && error?.status === 429,
  );
  assert.equal(llmCalls, 0);
});

test('resource revoked after approval prevents the Gmail effect', async () => {
  const now = new Date('2026-07-27T12:00:00.000Z');
  const actions = [pendingEmailAction({ id: 'action-revoked', targetRef: 'message-revoked', now })];
  const prisma = externalActionPrisma(actions);
  let sends = 0;
  const result = await externalActions.approveExternalAction({
    prisma,
    project: { id: 'project-1', userId: 'user-1' },
    actionId: 'action-revoked',
    actionHash: actions[0].payload._approval.actionHash,
    actionVersion: 1,
    actorId: 'user-1',
    gmailLoader: async () => {
      const current = await prisma.codexProject.findFirst({
        where: { id: 'project-1', userId: 'user-1' },
      });
      current.brief.companyResources.assignments = {};
      prisma.codexProject.findFirst = async () => structuredClone(current);
      return {
        client: {
          replyToEmail: async () => {
            sends += 1;
            return { messageId: 'must-not-send' };
          },
        },
      };
    },
    now: () => now,
  });

  assert.equal(result.action, 'company_resource_not_assigned');
  assert.equal(result.record.status, 'pending_review');
  assert.equal(sends, 0);
});

test('stale approval hash is rejected before the Gmail provider loads', async () => {
  const now = new Date('2026-07-27T12:00:00.000Z');
  const actions = [pendingEmailAction({ id: 'action-stale', targetRef: 'message-stale', now })];
  const prisma = externalActionPrisma(actions);
  let loads = 0;
  const result = await externalActions.approveExternalAction({
    prisma,
    project: { id: 'project-1', userId: 'user-1' },
    actionId: actions[0].id,
    actionHash: '0'.repeat(64),
    actionVersion: 1,
    actorId: 'user-1',
    gmailLoader: async () => { loads += 1; return { client: {} }; },
    now: () => now,
  });
  assert.equal(result.action, 'approval_stale');
  assert.equal(loads, 0);
  assert.equal(actions[0].status, 'pending_review');
});

test('two approvals for one action claim single-use and invoke Gmail once', async () => {
  const now = new Date('2026-07-27T12:00:00.000Z');
  const actions = [pendingEmailAction({ id: 'action-concurrent', targetRef: 'message-concurrent', now })];
  const prisma = externalActionPrisma(actions);
  let sends = 0;
  const approval = {
    prisma,
    project: { id: 'project-1', userId: 'user-1' },
    actionId: actions[0].id,
    actionHash: actions[0].payload._approval.actionHash,
    actionVersion: 1,
    actorId: 'user-1',
    gmailLoader: async () => ({ client: {
      replyToEmail: async () => {
        sends += 1;
        return { messageId: 'sent-once' };
      },
    } }),
    now: () => now,
  };
  const results = await Promise.all([
    externalActions.approveExternalAction(approval),
    externalActions.approveExternalAction(approval),
  ]);
  assert.equal(sends, 1);
  assert.equal(results.filter((result) => result.action === 'completed').length, 1);
  assert.equal(actions[0].status, 'completed');
  assert.ok(actions[0].consumedAt);
});

test('provider success followed by DB failure becomes delivery_uncertain and cannot re-send', async () => {
  const now = new Date('2026-07-27T12:00:00.000Z');
  const actions = [pendingEmailAction({ id: 'action-uncertain', targetRef: 'message-uncertain', now })];
  const prisma = externalActionPrisma(actions, { failCompletionUpdate: true });
  let sends = 0;
  const approval = {
    prisma,
    project: { id: 'project-1', userId: 'user-1' },
    actionId: actions[0].id,
    actionHash: actions[0].payload._approval.actionHash,
    actionVersion: 1,
    actorId: 'user-1',
    gmailLoader: async () => ({ client: {
      replyToEmail: async () => {
        sends += 1;
        return { messageId: 'provider-accepted' };
      },
    } }),
    now: () => now,
  };
  const first = await externalActions.approveExternalAction(approval);
  const second = await externalActions.approveExternalAction(approval);
  assert.equal(first.action, 'delivery_uncertain');
  assert.equal(second.action, 'delivery_uncertain');
  assert.equal(sends, 1);
  assert.equal(actions[0].status, 'delivery_uncertain');
});

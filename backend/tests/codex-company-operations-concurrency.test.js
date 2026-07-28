'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const externalActions = require('../src/services/codex/company-operations/external-actions');
const sales = require('../src/services/codex/company-operations/sales-pipeline');

function matchesStatus(actual, expected) {
  if (typeof expected === 'string') return actual === expected;
  if (Array.isArray(expected?.in)) return expected.in.includes(actual);
  return true;
}

function externalActionPrisma(actions, {
  resourceDepartment = 'customer-success',
  companyDeletedAt = null,
} = {}) {
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
        const row = actions.find((item) => item.id === where.id);
        Object.assign(row, data, { updatedAt: new Date() });
        return structuredClone(row);
      },
      updateMany: async ({ where, data }) => {
        const rows = actions.filter((row) =>
          (!where.id || row.id === where.id)
          && (!where.projectId || row.projectId === where.projectId)
          && (!where.userId || row.userId === where.userId)
          && (!where.status || matchesStatus(row.status, where.status)));
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
    {
      id: 'action-1',
      projectId: 'project-1',
      userId: 'user-1',
      kind: 'email_reply',
      targetRef: 'message-1',
      status: 'pending_review',
      payload: { providerDraftId: 'draft-1', messageId: 'message-1' },
      updatedAt: now,
      executedAt: null,
    },
    {
      id: 'action-2',
      projectId: 'project-1',
      userId: 'user-1',
      kind: 'email_reply',
      targetRef: 'message-2',
      status: 'pending_review',
      payload: { providerDraftId: 'draft-2', messageId: 'message-2' },
      updatedAt: now,
      executedAt: null,
    },
  ];
  const prisma = externalActionPrisma(actions);
  let sends = 0;
  const gmailLoader = async () => ({
    client: {
      sendDraft: async () => {
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
      gmailLoader,
      now: () => now,
      env: { CODEX_EMAIL_REPLY_DAILY_LIMIT: '1' },
    }),
    externalActions.approveExternalAction({
      prisma,
      project,
      actionId: 'action-2',
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
    chatComplete: async () => ({
      content: '{"subject":"Propuesta para Alfa","body":"Hola, esta es una propuesta verificable."}',
    }),
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
});

test('resource revoked after approval prevents the Gmail effect', async () => {
  const now = new Date('2026-07-27T12:00:00.000Z');
  const actions = [{
    id: 'action-revoked',
    projectId: 'project-1',
    userId: 'user-1',
    kind: 'email_reply',
    targetRef: 'message-revoked',
    status: 'pending_review',
    payload: { providerDraftId: 'draft-revoked', messageId: 'message-revoked' },
    updatedAt: now,
    executedAt: null,
  }];
  const prisma = externalActionPrisma(actions);
  let sends = 0;
  const result = await externalActions.approveExternalAction({
    prisma,
    project: { id: 'project-1', userId: 'user-1' },
    actionId: 'action-revoked',
    gmailLoader: async () => {
      const current = await prisma.codexProject.findFirst({
        where: { id: 'project-1', userId: 'user-1' },
      });
      current.brief.companyResources.assignments = {};
      prisma.codexProject.findFirst = async () => structuredClone(current);
      return {
        client: {
          sendDraft: async () => {
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

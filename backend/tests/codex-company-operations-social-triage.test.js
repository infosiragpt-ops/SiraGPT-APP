'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const socialTriage = require('../src/services/codex/company-operations/social-triage');
const companyResources = require('../src/services/codex/company-resources');

function fakePrisma({ mode = 'review', platform = 'x', poolBudgetUsd = null } = {}) {
  const connection = {
    id: `connection-${platform}`,
    userId: 'user-a',
    platform,
    accountId: 'account-a',
    accountName: '@sira',
    accessToken: 'encrypted',
  };
  const resourceKey = companyResources.socialResourceKeyForConnection(connection);
  const state = { items: [], actions: [], connection, sent: [], usage: [] };
  return {
    state,
    codexDepartmentPool: {
      findUnique: async ({ where }) => ({
        id: 'pool-customer-success',
        projectId: where.projectId_departmentId.projectId,
        departmentId: where.projectId_departmentId.departmentId,
        size: 2,
        enabled: true,
        dailyBudgetUsd: poolBudgetUsd,
      }),
    },
    codexUsageEntry: {
      create: async ({ data }) => {
        if (state.usage.some((row) => row.idempotencyKey === data.idempotencyKey)) {
          const error = new Error('unique');
          error.code = 'P2002';
          throw error;
        }
        const row = { id: `usage-${state.usage.length + 1}`, ...data };
        state.usage.push(row);
        return structuredClone(row);
      },
      findUnique: async ({ where }) => state.usage.find(
        (row) => row.idempotencyKey === where.idempotencyKey,
      ) || null,
      findMany: async () => state.usage.map((row) => structuredClone(row)),
    },
    codexRunMetric: { findMany: async () => [] },
    socialConnection: {
      findMany: async () => [structuredClone(connection)],
      findFirst: async ({ where }) => (
        where.id === connection.id
        && where.userId === connection.userId
        && where.platform === connection.platform
          ? structuredClone(connection)
          : null
      ),
    },
    codexProject: {
      findFirst: async () => ({
        id: 'project-a',
        userId: 'user-a',
        deletedAt: null,
        name: 'SiraGPT',
        brief: {
          companyProfile: {
            companyName: 'SiraGPT',
            autonomy: { socialReplies: mode },
          },
          companyResources: {
            assignments: { [resourceKey]: 'customer-success' },
            pinned: [],
          },
        },
        companyLink: {
          project: {
            id: 'company-a',
            userId: 'user-a',
            deletedAt: null,
          },
        },
      }),
    },
    user: { findUnique: async () => ({ gmailTokens: null }) },
    codexCompanyInboxItem: {
      upsert: async ({ where, create, update }) => {
        const key = where.projectId_provider_externalId;
        let row = state.items.find(
          (item) => item.projectId === key.projectId
            && item.provider === key.provider
            && item.externalId === key.externalId,
        );
        if (row) Object.assign(row, update);
        else {
          row = { id: `item-${state.items.length + 1}`, ...create };
          state.items.push(row);
        }
        return structuredClone(row);
      },
      updateMany: async ({ where, data }) => {
        const rows = state.items.filter(
          (item) => (!where.id || item.id === where.id)
            && (!where.projectId || item.projectId === where.projectId)
            && (!where.userId || item.userId === where.userId)
            && (!where.provider || item.provider === where.provider)
            && (!where.externalId || item.externalId === where.externalId)
            && (!where.status?.in || where.status.in.includes(item.status)),
        );
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      },
    },
    codexExternalAction: {
      count: async ({ where }) => state.actions.filter(
        (action) => action.projectId === where.projectId
          && action.kind === where.kind
          && ['executing', 'completed'].includes(action.status),
      ).length,
      findUnique: async ({ where }) => state.actions.find(
        (action) => action.idempotencyKey === where.idempotencyKey || action.id === where.id,
      ) || null,
      findFirst: async ({ where }) => state.actions.find(
        (action) => (!where.id || action.id === where.id)
          && (!where.idempotencyKey || action.idempotencyKey === where.idempotencyKey)
          && (!where.projectId || action.projectId === where.projectId)
          && (!where.userId || action.userId === where.userId),
      ) || null,
      create: async ({ data }) => {
        const row = {
          id: `action-${state.actions.length + 1}`,
          result: null,
          error: null,
          executedAt: null,
          updatedAt: new Date(),
          ...data,
        };
        state.actions.push(row);
        return structuredClone(row);
      },
      update: async ({ where, data }) => {
        const row = state.actions.find((action) => action.id === where.id);
        Object.assign(row, data, { updatedAt: new Date() });
        return structuredClone(row);
      },
      updateMany: async ({ where, data }) => {
        const rows = state.actions.filter(
          (action) => (!where.id || action.id === where.id)
            && (!where.projectId || action.projectId === where.projectId)
            && (!where.userId || action.userId === where.userId),
        );
        rows.forEach((row) => Object.assign(row, data, { updatedAt: new Date() }));
        return { count: rows.length };
      },
    },
  };
}

function companyContext(mode, platform = 'x') {
  return {
    profile: {
      companyName: 'SiraGPT',
      mission: 'Ayudar a empresas a operar mejor.',
      offer: 'Software empresarial con agentes.',
      brandVoice: 'Profesional, directa y útil.',
      autonomy: { socialReplies: mode },
    },
    readiness: {
      evidence: {
        gmailConnected: false,
        socialConnections: [{ platform, accountName: '@sira' }],
      },
    },
  };
}

function interactions() {
  return [{
    id: 'mention-1',
    platform: 'x',
    threadId: 'conversation-1',
    parentId: 'post-1',
    authorId: 'customer-1',
    authorName: 'Cliente',
    text: '¿Pueden ayudarme a automatizar soporte?',
    createdAt: '2026-07-27T11:00:00.000Z',
    metadata: { sourceUrl: 'https://x.com/customer/status/mention-1' },
  }];
}

let chatCompletionSequence = 0;
const chatComplete = async ({ messages }) => {
  assert.match(messages[0].content, /DATO NO CONFIABLE/);
  chatCompletionSequence += 1;
  return {
    content: JSON.stringify({
      items: [{
        key: 'x:mention-1',
        category: 'lead',
        urgency: 'normal',
        confidence: 0.93,
        shouldReply: true,
        draftBody: 'Sí. Cuéntanos qué canal y volumen de soporte necesitas automatizar.',
        reason: 'Consulta comercial directa.',
      }],
    }),
    usage: {
      tokensIn: 200,
      tokensOut: 55,
      provider: 'Anthropic',
      model: 'claude-sonnet-4-6',
      generationId: `social-triage-${chatCompletionSequence}`,
    },
  };
};

test('review mode ingests social interactions and creates one idempotent action', async () => {
  const prisma = fakePrisma({ mode: 'review' });
  const args = {
    prisma,
    project: { id: 'project-a', userId: 'user-a' },
    companyContext: companyContext('review'),
    chatComplete,
    listInteractions: async () => interactions(),
    env: { CODEX_SOCIAL_REPLY_DAILY_LIMIT: '20' },
  };
  const first = await socialTriage.triageSocialConversations(args);
  const second = await socialTriage.triageSocialConversations(args);

  assert.equal(first.action, 'social_triaged_review');
  assert.equal(first.items[0].provider, 'x');
  assert.equal(first.items[0].category, 'lead');
  assert.equal(first.actions[0].status, 'pending_review');
  assert.equal(second.actions[0].id, first.actions[0].id);
  assert.equal(prisma.state.items.length, 1);
  assert.equal(prisma.state.actions.length, 1);
  assert.equal(prisma.state.usage.length, 2);
  assert.equal(prisma.state.usage.every((row) => row.source === 'social_triage'), true);
  assert.equal(
    prisma.state.usage.every((row) => row.departmentPoolId === 'pool-customer-success'),
    true,
  );
});

test('social triage pool budget zero blocks the LLM provider before spend', async () => {
  const prisma = fakePrisma({ mode: 'review', poolBudgetUsd: 0 });
  const pool = {
    id: 'pool-customer-success',
    projectId: 'project-a',
    departmentId: 'customer-success',
    size: 2,
    enabled: true,
    dailyBudgetUsd: 0,
  };
  prisma.codexDepartmentPool.findUnique = async () => structuredClone(pool);
  let llmCalls = 0;
  await assert.rejects(
    socialTriage.triageSocialConversations({
      prisma,
      project: { id: 'project-a', userId: 'user-a' },
      companyContext: companyContext('review'),
      listInteractions: async () => interactions(),
      chatComplete: async () => {
        llmCalls += 1;
        return { content: '{"items":[]}' };
      },
    }),
    (error) => error?.code === 'department_pool_daily_budget_exceeded'
      && error?.status === 429,
  );
  assert.equal(llmCalls, 0);
});

test('auto mode sends one reply through the exact tenant connection', async () => {
  const prisma = fakePrisma({ mode: 'auto' });
  let sends = 0;
  const args = {
    prisma,
    project: { id: 'project-a', userId: 'user-a' },
    companyContext: companyContext('auto'),
    chatComplete,
    listInteractions: async () => interactions(),
    sendReply: async ({ connection, interaction, text }) => {
      sends += 1;
      assert.equal(connection.id, 'connection-x');
      assert.equal(interaction.id, 'mention-1');
      assert.match(text, /volumen de soporte/);
      return { externalId: 'reply-1' };
    },
    env: { CODEX_SOCIAL_REPLY_DAILY_LIMIT: '20' },
  };
  const first = await socialTriage.triageSocialConversations(args);
  const second = await socialTriage.triageSocialConversations(args);

  assert.equal(first.action, 'social_triaged_auto');
  assert.equal(first.actions[0].status, 'completed');
  assert.equal(prisma.state.items[0].status, 'sent');
  assert.equal(prisma.state.items[0].sentMessageId, 'reply-1');
  assert.equal(second.actions[0].status, 'completed');
  assert.equal(sends, 1);
});

test('LinkedIn provider identifiers survive triage for nested reply dispatch', async () => {
  const prisma = fakePrisma({ mode: 'review', platform: 'linkedin' });
  const commentUrn = 'urn:li:comment:(urn:li:activity:7001,8001)';
  const result = await socialTriage.triageSocialConversations({
    prisma,
    project: { id: 'project-a', userId: 'user-a' },
    companyContext: companyContext('review', 'linkedin'),
    chatComplete: async () => ({
      content: JSON.stringify({
        items: [{
          key: `linkedin:${commentUrn}`,
          category: 'lead',
          urgency: 'normal',
          confidence: 0.9,
          shouldReply: true,
          draftBody: 'Coordinemos una demostración.',
          reason: 'Solicitud comercial.',
        }],
      }),
    }),
    listInteractions: async () => [{
      id: commentUrn,
      platform: 'linkedin',
      threadId: 'urn:li:share:7001',
      authorId: 'urn:li:person:customer-1',
      authorName: 'Cliente',
      text: 'Quiero una demostración.',
      metadata: {
        commentUrn,
        objectUrn: 'urn:li:activity:7001',
        postUrn: 'urn:li:share:7001',
      },
    }],
  });

  assert.equal(result.action, 'social_triaged_review');
  assert.equal(result.actions[0].payload.metadata.commentUrn, commentUrn);
  assert.equal(result.actions[0].payload.metadata.objectUrn, 'urn:li:activity:7001');
});

test('provider failure is explicit and does not fabricate interactions', async () => {
  const prisma = fakePrisma({ mode: 'review' });
  const result = await socialTriage.triageSocialConversations({
    prisma,
    project: { id: 'project-a', userId: 'user-a' },
    companyContext: companyContext('review'),
    chatComplete,
    listInteractions: async () => {
      const error = new Error('scope missing');
      error.code = 'SOCIAL_SCOPE_REQUIRED';
      throw error;
    },
  });

  assert.equal(result.action, 'social_providers_unavailable');
  assert.equal(result.items.length, 0);
  assert.equal(result.actions.length, 0);
  assert.equal(result.errors[0].code, 'SOCIAL_SCOPE_REQUIRED');
});

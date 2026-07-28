'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const companyResources = require('../src/services/codex/company-resources');
const access = require('../src/services/codex/company-operations/company-resource-access');
const externalActions = require('../src/services/codex/company-operations/external-actions');
const socialTriage = require('../src/services/codex/company-operations/social-triage');

function project({ id, companyId, assignments = {}, deletedAt = null }) {
  return {
    id,
    userId: 'user-a',
    deletedAt: null,
    brief: {
      companyResources: { assignments, pinned: [] },
    },
    companyLink: {
      project: {
        id: companyId,
        userId: 'user-a',
        deletedAt,
      },
    },
  };
}

function fakePrisma({ projects, assignedCompanyId = 'company-b', socialConnection = null }) {
  const state = { socialReads: 0 };
  return {
    state,
    codexProject: {
      findFirst: async ({ where }) => {
        const row = projects.find(
          (entry) => entry.id === where.id
            && entry.userId === where.userId
            && entry.deletedAt == null,
        );
        return row ? structuredClone(row) : null;
      },
    },
    connectorAccount: {
      findFirst: async ({ where }) => (
        where.userId === 'user-a'
        && where.provider === 'gmail'
        && where.status === 'connected'
          ? {
            id: 'gmail-account',
            userId: 'user-a',
            provider: 'gmail',
            status: 'connected',
          }
          : null
      ),
    },
    projectConnectorAssignment: {
      findFirst: async ({ where }) => (
        where.projectId === assignedCompanyId
        && where.connectorAccountId === 'gmail-account'
        && where.status === 'active'
          ? { id: `assignment-${where.projectId}`, ...where }
          : null
      ),
    },
    user: {
      findUnique: async ({ where }) => (
        where.id === 'user-a' ? { gmailTokens: 'encrypted-gmail' } : null
      ),
    },
    socialConnection: {
      findFirst: async ({ where }) => {
        state.socialReads += 1;
        if (
          socialConnection
          && where.id === socialConnection.id
          && where.userId === socialConnection.userId
          && where.platform === socialConnection.platform
        ) {
          return structuredClone(socialConnection);
        }
        return null;
      },
    },
  };
}

test('connector authorization is isolated between company A and company B', async () => {
  const projects = [
    project({
      id: 'runtime-a',
      companyId: 'company-a',
      assignments: { 'connector:gmail': 'customer-success' },
    }),
    project({
      id: 'runtime-b',
      companyId: 'company-b',
      assignments: { 'connector:gmail': 'customer-success' },
    }),
  ];
  const prisma = fakePrisma({ projects, assignedCompanyId: 'company-b' });

  await assert.rejects(
    access.requireCompanyResourceAccess({
      prisma,
      project: { id: 'runtime-a', userId: 'user-a' },
      departmentId: 'customer-success',
      resourceKey: 'connector:gmail',
    }),
    (error) => error?.code === 'company_connector_not_authorized',
  );
  const allowed = await access.requireCompanyResourceAccess({
    prisma,
    project: { id: 'runtime-b', userId: 'user-a' },
    departmentId: 'customer-success',
    resourceKey: 'connector:gmail',
  });
  assert.equal(allowed.companyProjectId, 'company-b');
  assert.equal(allowed.connectorAccount.id, 'gmail-account');
});

test('social triage without an exact assigned account performs no social read', async () => {
  const connection = {
    id: 'social-x',
    userId: 'user-a',
    platform: 'x',
    accountId: 'account-x',
    accessToken: 'encrypted-social',
  };
  const prisma = fakePrisma({
    projects: [
      project({
        id: 'runtime-a',
        companyId: 'company-a',
        assignments: {},
      }),
    ],
    socialConnection: connection,
  });

  await assert.rejects(
    access.authorizedSocialConnectionsForDepartment({
      prisma,
      project: { id: 'runtime-a', userId: 'user-a' },
      departmentId: 'customer-success',
    }),
    (error) => error?.code === 'company_social_resource_not_assigned',
  );
  assert.equal(prisma.state.socialReads, 0);
});

test('social triage performs no provider read when the company lacks a social resource', async () => {
  const connection = {
    id: 'social-x',
    userId: 'user-a',
    platform: 'x',
    accountId: 'account-x',
    accessToken: 'encrypted-social',
  };
  const prisma = fakePrisma({
    projects: [
      project({
        id: 'runtime-a',
        companyId: 'company-a',
        assignments: {},
      }),
    ],
    socialConnection: connection,
  });
  let providerReads = 0;
  await assert.rejects(
    socialTriage.triageSocialConversations({
      prisma,
      project: { id: 'runtime-a', userId: 'user-a' },
      companyContext: {
        profile: { autonomy: { socialReplies: 'review' } },
      },
      chatComplete: async () => ({ content: '{"items":[]}' }),
      listInteractions: async () => {
        providerReads += 1;
        return [];
      },
    }),
    (error) => error?.code === 'company_social_resource_not_assigned',
  );
  assert.equal(providerReads, 0);
  assert.equal(prisma.state.socialReads, 0);
});

test('social resource identity is bound to the current connection and account', async () => {
  const connection = {
    id: 'social-x',
    userId: 'user-a',
    platform: 'x',
    accountId: 'account-current',
    accessToken: 'encrypted-social',
  };
  const staleResourceKey = companyResources.socialResourceKeyForConnection({
    ...connection,
    accountId: 'account-stale',
  });
  const prisma = fakePrisma({
    projects: [
      project({
        id: 'runtime-a',
        companyId: 'company-a',
        assignments: { [staleResourceKey]: 'customer-success' },
      }),
    ],
    socialConnection: connection,
  });

  await assert.rejects(
    access.requireExternalActionResourceAccess({
      prisma,
      project: { id: 'runtime-a', userId: 'user-a' },
      kind: 'social_reply',
      payload: {
        platform: 'x',
        connectionId: 'social-x',
      },
    }),
    (error) => error?.code === 'company_resource_not_assigned',
  );
});

test('social resource keeps case-sensitive provider identities intact', async () => {
  const connection = {
    id: 'Social-X-Primary',
    userId: 'user-a',
    platform: 'x',
    accountId: 'Account-X-Primary',
    accessToken: 'encrypted-social',
  };
  const resourceKey = companyResources.socialResourceKeyForConnection(connection);
  const prisma = fakePrisma({
    projects: [
      project({
        id: 'runtime-a',
        companyId: 'company-a',
        assignments: { [resourceKey]: 'customer-success' },
      }),
    ],
    socialConnection: connection,
  });

  const authorized = await access.requireExternalActionResourceAccess({
    prisma,
    project: { id: 'runtime-a', userId: 'user-a' },
    kind: 'social_reply',
    payload: {
      platform: 'x',
      connectionId: 'Social-X-Primary',
    },
  });
  assert.equal(authorized.resourceKey, resourceKey);
  assert.equal(authorized.socialConnection.accountId, 'Account-X-Primary');
});

test('revoking a social resource after approval blocks the reply effect', async () => {
  const connection = {
    id: 'social-x',
    userId: 'user-a',
    platform: 'x',
    accountId: 'account-x',
    accountName: '@company',
    accessToken: 'encrypted-social',
  };
  const resourceKey = companyResources.socialResourceKeyForConnection(connection);
  const runtime = project({
    id: 'runtime-a',
    companyId: 'company-a',
    assignments: { [resourceKey]: 'customer-success' },
  });
  const action = {
    id: 'action-social',
    projectId: 'runtime-a',
    userId: 'user-a',
    kind: 'social_reply',
    targetRef: 'x:mention-1',
    status: 'pending_review',
    payload: {
      platform: 'x',
      connectionId: 'social-x',
      interactionId: 'mention-1',
      body: 'Respuesta segura.',
    },
    updatedAt: new Date(),
    executedAt: null,
  };
  let actionReads = 0;
  let sends = 0;
  const prisma = {
    ...fakePrisma({ projects: [runtime], socialConnection: connection }),
    codexExternalAction: {
      findFirst: async ({ where }) => {
        if (
          where.id === action.id
          && where.projectId === action.projectId
          && where.userId === action.userId
        ) {
          actionReads += 1;
          if (actionReads === 3) {
            runtime.brief.companyResources.assignments = {};
          }
          if (where.status && action.status !== where.status) return null;
          return structuredClone(action);
        }
        return null;
      },
      count: async () => 0,
      update: async ({ where, data }) => {
        assert.equal(where.id, action.id);
        Object.assign(action, data, { updatedAt: new Date() });
        return structuredClone(action);
      },
    },
    codexCompanyInboxItem: {
      updateMany: async () => ({ count: 1 }),
    },
  };
  const result = await externalActions.approveExternalAction({
    prisma,
    project: { id: 'runtime-a', userId: 'user-a' },
    actionId: 'action-social',
    socialReplySender: async () => {
      sends += 1;
      return { externalId: 'must-not-send' };
    },
    companyContext: {
      profile: { autonomy: { socialReplies: 'review' } },
      readiness: { evidence: { socialConnections: [{ platform: 'x' }] } },
    },
  });

  assert.equal(result.action, 'company_resource_not_assigned');
  assert.equal(result.record.status, 'pending_review');
  assert.equal(sends, 0);
});

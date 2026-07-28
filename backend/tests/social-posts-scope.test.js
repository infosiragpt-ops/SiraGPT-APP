'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { policyKey } = require('../src/services/social-company/policy');
const {
  socialResourceKeyForConnection,
} = require('../src/services/codex/company-resources');

const LINKEDIN_CONNECTION = {
  id: 'connection-linkedin',
  userId: 'user-1',
  platform: 'linkedin',
  accountId: 'account-linkedin',
  accountName: 'SiraGPT',
  accessToken: 'sealed-token',
  profile: { status: 'connected' },
  scopes: [],
};
const LINKEDIN_KEY = socialResourceKeyForConnection(LINKEDIN_CONNECTION);
let linkedInAccountId = LINKEDIN_CONNECTION.accountId;

const authPath = require.resolve('../src/middleware/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  children: [],
  paths: [],
  exports: {
    authenticateToken: (req, _res, next) => {
      req.user = { id: 'user-1' };
      next();
    },
  },
};

const policies = new Map([
  ['workspace-a', {
    enabled: true,
    mode: 'review',
    objective: 'Objetivo A',
    workspaceId: 'workspace-a',
  }],
  ['workspace-b', {
    enabled: false,
    mode: 'review',
    objective: 'Objetivo B',
    workspaceId: 'workspace-b',
  }],
]);
const postFinds = [];
const postCounts = [];
const postCreates = [];
let companyAssignments = { [LINKEDIN_KEY]: 'marketing' };
let companyDeletedAt = null;
let queuedStatus = 'draft';
let cancelRaceToPublished = false;
const cancelWheres = [];
const dbPath = require.resolve('../src/config/database');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  children: [],
  paths: [],
  exports: {
    codexProject: {
      findFirst: async ({ where }) => (
        where.id === 'workspace-a' && where.userId === 'user-1'
          ? {
            id: where.id,
            userId: where.userId,
            deletedAt: null,
            brief: {
              companyResources: {
                assignments: { ...companyAssignments },
                pinned: [],
              },
            },
            companyLink: {
              project: {
                id: 'company-a',
                userId: 'user-1',
                deletedAt: companyDeletedAt,
              },
            },
          }
          : null
      ),
    },
    systemSettings: {
      findUnique: async ({ where }) => {
        for (const [workspaceId, policy] of policies) {
          if (where.key === policyKey('user-1', workspaceId)) {
            return { key: where.key, value: JSON.stringify(policy) };
          }
        }
        return null;
      },
      upsert: async () => {
        throw new Error('unexpected migration');
      },
    },
    socialConnection: {
      findMany: async () => [{
        ...structuredClone(LINKEDIN_CONNECTION),
        accountId: linkedInAccountId,
      }],
    },
    scheduledPost: {
      create: async ({ data }) => {
        postCreates.push(data);
        return { id: `post-${postCreates.length}`, ...data };
      },
      findMany: async ({ where }) => {
        postFinds.push(where);
        return [];
      },
      findFirst: async ({ where }) => (
        where.id === 'queued-existing' && where.userId === 'user-1'
          ? {
            id: where.id,
            userId: where.userId,
            status: queuedStatus,
            platforms: ['linkedin'],
            config: { workspaceId: 'workspace-a', approved: false },
          }
          : null
      ),
      updateMany: async ({ where, data }) => {
        cancelWheres.push(where);
        if (cancelRaceToPublished) {
          queuedStatus = 'published';
          cancelRaceToPublished = false;
        }
        if (queuedStatus !== where.status?.not) {
          queuedStatus = data.status;
          return { count: 1 };
        }
        return { count: 0 };
      },
      count: async ({ where }) => {
        postCounts.push(where);
        return 0;
      },
    },
  },
};

const router = require('../src/routes/social-posts');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/social-posts', router);
  return app;
}

test('social operations and posts keep sibling workspaces in separate queries', async () => {
  postFinds.length = 0;
  postCounts.length = 0;
  const app = makeApp();

  const [operationsA, operationsB, postsA, postsB] = await Promise.all([
    request(app).get('/api/social-posts/operations?workspaceId=workspace-a'),
    request(app).get('/api/social-posts/operations?workspaceId=workspace-b'),
    request(app).get('/api/social-posts?workspaceId=workspace-a'),
    request(app).get('/api/social-posts?workspaceId=workspace-b'),
  ]);

  assert.equal(operationsA.status, 200);
  assert.equal(operationsB.status, 200);
  assert.equal(postsA.status, 200);
  assert.equal(postsB.status, 200);
  assert.equal(operationsA.body.policy.objective, 'Objetivo A');
  assert.equal(operationsB.body.policy.objective, 'Objetivo B');
  assert.deepEqual(
    new Set(postFinds.map((where) => where.config.equals)),
    new Set(['workspace-a', 'workspace-b']),
  );
  assert.deepEqual(
    new Set(postCounts.map((where) => where.config.equals)),
    new Set(['workspace-a', 'workspace-b']),
  );
  assert.ok(postFinds.every((where) => where.userId === 'user-1'));
  assert.ok(postCounts.every((where) => where.userId === 'user-1'));

  const invalid = await request(app)
    .get(`/api/social-posts/operations?workspaceId=${'x'.repeat(181)}`);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'social_policy_scope_invalid');

  const queued = await request(app)
    .post('/api/social-posts/queue')
    .send({
      caption: 'Avance verificable',
      platforms: ['linkedin'],
      approved: true,
      workspaceId: ' workspace-a ',
    });
  assert.equal(queued.status, 201);
  assert.equal(postCreates.at(-1).config.workspaceId, 'workspace-a');
});

test('queue requires an owned active company and a social resource assigned to literal Marketing', async () => {
  const app = makeApp();
  companyAssignments = {};
  const unassigned = await request(app)
    .post('/api/social-posts/queue')
    .send({
      caption: 'No autorizado',
      platforms: ['linkedin'],
      approved: true,
      workspaceId: 'workspace-a',
    });
  assert.equal(unassigned.status, 403);
  assert.equal(unassigned.body.code, 'social_resource_not_assigned');

  companyAssignments = { [LINKEDIN_KEY]: 'growth-engines' };
  const wrongDepartment = await request(app)
    .post('/api/social-posts/queue')
    .send({
      caption: 'Tampoco autorizado',
      platforms: ['linkedin'],
      workspaceId: 'workspace-a',
    });
  assert.equal(wrongDepartment.status, 403);
  assert.deepEqual(wrongDepartment.body.denied, ['linkedin']);

  const unowned = await request(app)
    .post('/api/social-posts/queue')
    .send({
      caption: 'Empresa ajena',
      platforms: ['linkedin'],
      workspaceId: 'workspace-b',
    });
  assert.equal(unowned.status, 404);
  assert.equal(unowned.body.code, 'company_project_not_found');

  companyAssignments = {};
  const publishDenied = await request(app)
    .post('/api/social-posts/queued-existing/publish-now');
  assert.equal(publishDenied.status, 403);
  assert.equal(publishDenied.body.code, 'social_resource_not_assigned');

  companyAssignments = { [LINKEDIN_KEY]: 'marketing' };
  companyDeletedAt = new Date();
  const deletedCompany = await request(app)
    .post('/api/social-posts/queue')
    .send({
      caption: 'Empresa en papelera',
      platforms: ['linkedin'],
      workspaceId: 'workspace-a',
    });
  assert.equal(deletedCompany.status, 404);
  assert.equal(deletedCompany.body.code, 'company_project_not_found');
  companyDeletedAt = null;

  const unscoped = await request(app)
    .post('/api/social-posts/queue')
    .send({
      caption: 'Sin empresa',
      platforms: ['linkedin'],
    });
  assert.equal(unscoped.status, 400);

  companyAssignments = { [LINKEDIN_KEY]: 'marketing' };
});

test('cancel atomically preserves a post that becomes published during the request', async () => {
  const app = makeApp();
  cancelWheres.length = 0;
  queuedStatus = 'publishing';
  cancelRaceToPublished = true;

  const raced = await request(app)
    .post('/api/social-posts/queued-existing/cancel');

  assert.equal(raced.status, 409);
  assert.equal(queuedStatus, 'published');
  assert.equal(cancelWheres.length, 1);
  assert.equal(cancelWheres[0].userId, 'user-1');
  assert.deepEqual(cancelWheres[0].status, { not: 'published' });

  queuedStatus = 'publishing';
  const cancelled = await request(app)
    .post('/api/social-posts/queued-existing/cancel');
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.post.status, 'cancelled');
  assert.equal(queuedStatus, 'cancelled');
});

test('reconnecting the platform to another account invalidates the old company grant', async () => {
  const app = makeApp();
  companyAssignments = { [LINKEDIN_KEY]: 'marketing' };
  linkedInAccountId = 'different-linkedin-account';

  const denied = await request(app)
    .post('/api/social-posts/queue')
    .send({
      caption: 'No debe cruzar de cuenta',
      platforms: ['linkedin'],
      approved: true,
      workspaceId: 'workspace-a',
    });

  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'social_resource_not_assigned');
  linkedInAccountId = LINKEDIN_CONNECTION.accountId;
});

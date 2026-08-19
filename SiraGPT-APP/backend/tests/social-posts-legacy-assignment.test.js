'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const {
  socialResourceKeyForConnection,
} = require('../src/services/codex/company-resources');

const authPath = require.resolve('../src/middleware/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  children: [],
  paths: [],
  exports: {
    authenticateToken: (req, _res, next) => {
      req.user = { id: 'user-legacy' };
      next();
    },
  },
};

const LINKEDIN_CONNECTION = {
  id: 'connection-linkedin',
  userId: 'user-legacy',
  platform: 'linkedin',
  accountId: 'account-linkedin',
  accountName: 'Empresa',
  accessToken: 'sealed-token',
  profile: { status: 'connected' },
  scopes: [],
};
const LINKEDIN_KEY = socialResourceKeyForConnection(LINKEDIN_CONNECTION);
let companyDeletedAt = null;
const baseTime = new Date('2026-07-27T12:00:00.000Z');
let posts = [];

function resetPosts() {
  posts = [
    {
      id: 'legacy-linkedin',
      userId: 'user-legacy',
      status: 'scheduled',
      platforms: ['linkedin'],
      batchId: 'legacy-series',
      config: { approved: false },
      createdAt: baseTime,
      updatedAt: baseTime,
    },
    {
      id: 'legacy-x',
      userId: 'user-legacy',
      status: 'scheduled',
      platforms: ['x'],
      batchId: 'legacy-series',
      config: {},
      createdAt: baseTime,
      updatedAt: baseTime,
    },
    {
      id: 'legacy-publishing',
      userId: 'user-legacy',
      status: 'publishing',
      platforms: ['linkedin'],
      batchId: null,
      config: {},
      createdAt: baseTime,
      updatedAt: baseTime,
    },
    {
      id: 'legacy-published',
      userId: 'user-legacy',
      status: 'published',
      platforms: ['linkedin'],
      batchId: null,
      config: { publicationResults: { linkedin: { status: 'published' } } },
      createdAt: baseTime,
      updatedAt: baseTime,
    },
    {
      id: 'already-scoped',
      userId: 'user-legacy',
      status: 'scheduled',
      platforms: ['linkedin'],
      batchId: null,
      config: { workspaceId: 'workspace-other' },
      createdAt: baseTime,
      updatedAt: baseTime,
    },
    {
      id: 'other-owner',
      userId: 'different-user',
      status: 'scheduled',
      platforms: ['linkedin'],
      batchId: null,
      config: {},
      createdAt: baseTime,
      updatedAt: baseTime,
    },
  ];
}
resetPosts();

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
        where.id === 'workspace-active' && where.userId === 'user-legacy'
          ? {
            id: 'workspace-active',
            userId: 'user-legacy',
            deletedAt: null,
            brief: {
              companyResources: {
                assignments: { [LINKEDIN_KEY]: 'marketing' },
                pinned: [],
              },
            },
            companyLink: {
              project: {
                id: 'company-active',
                userId: 'user-legacy',
                deletedAt: companyDeletedAt,
              },
            },
          }
          : null
      ),
    },
    socialConnection: {
      findMany: async () => [structuredClone(LINKEDIN_CONNECTION)],
    },
    scheduledPost: {
      findMany: async ({ where }) => posts
        .filter((post) => post.userId === where.userId)
        .map((post) => structuredClone(post)),
      findFirst: async ({ where }) => {
        const post = posts.find((entry) => entry.id === where.id && entry.userId === where.userId);
        return post ? structuredClone(post) : null;
      },
      updateMany: async ({ where, data }) => {
        const index = posts.findIndex((entry) => (
          entry.id === where.id
          && entry.userId === where.userId
          && entry.updatedAt.getTime() === where.updatedAt.getTime()
        ));
        if (index < 0) return { count: 0 };
        posts[index] = {
          ...posts[index],
          ...structuredClone(data),
          updatedAt: new Date(posts[index].updatedAt.getTime() + 1),
        };
        return { count: 1 };
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

test('legacy summary is owner-scoped and reports only explicitly assignable rows', async () => {
  resetPosts();
  const response = await request(makeApp())
    .get('/api/social-posts/legacy?workspaceId=workspace-active');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.legacy, {
    total: 4,
    assignable: 2,
    skipped: 2,
    skippedByReason: {
      resources_not_authorized: 1,
      status_not_assignable: 1,
    },
    deniedPlatforms: ['x'],
  });
});

test('legacy assignment requires explicit confirmation and migrates only authorized rows', async () => {
  resetPosts();
  const app = makeApp();
  const withoutConfirmation = await request(app)
    .post('/api/social-posts/legacy/assign')
    .send({ workspaceId: 'workspace-active' });
  assert.equal(withoutConfirmation.status, 400);

  const response = await request(app)
    .post('/api/social-posts/legacy/assign')
    .send({ workspaceId: 'workspace-active', confirm: true });

  assert.equal(response.status, 200);
  assert.equal(response.body.total, 4);
  assert.equal(response.body.assigned, 2);
  assert.equal(response.body.skipped, 2);
  assert.equal(
    posts.find((post) => post.id === 'legacy-linkedin').config.workspaceId,
    'workspace-active',
  );
  assert.equal(posts.find((post) => post.id === 'legacy-linkedin').status, 'draft');
  assert.equal(posts.find((post) => post.id === 'legacy-linkedin').config.approved, false);
  assert.equal(posts.find((post) => post.id === 'legacy-linkedin').scheduledAt, null);
  assert.equal(
    posts.find((post) => post.id === 'legacy-published').config.workspaceId,
    'workspace-active',
  );
  assert.equal(posts.find((post) => post.id === 'legacy-published').status, 'published');
  assert.equal(
    posts.find((post) => post.id === 'legacy-published').config.publicationResults.linkedin.status,
    'published',
  );
  assert.equal(posts.find((post) => post.id === 'legacy-x').config.workspaceId, undefined);
  assert.equal(posts.find((post) => post.id === 'legacy-publishing').config.workspaceId, undefined);
  assert.equal(posts.find((post) => post.id === 'already-scoped').config.workspaceId, 'workspace-other');
});

test('legacy assignment fails closed when the durable Company is in trash', async () => {
  resetPosts();
  companyDeletedAt = new Date();
  const response = await request(makeApp())
    .post('/api/social-posts/legacy/assign')
    .send({ workspaceId: 'workspace-active', confirm: true });
  companyDeletedAt = null;

  assert.equal(response.status, 404);
  assert.equal(response.body.code, 'company_project_not_found');
  assert.equal(posts.find((post) => post.id === 'legacy-linkedin').config.workspaceId, undefined);
});

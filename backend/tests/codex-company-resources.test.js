'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const resources = require('../src/services/codex/company-resources');
const LINKEDIN_CONNECTION = {
  id: 'connection-linkedin',
  platform: 'linkedin',
  accountId: 'account-linkedin',
};
const X_CONNECTION = {
  id: 'connection-x',
  platform: 'x',
  accountId: 'account-x',
};
const LINKEDIN_KEY = resources.socialResourceKeyForConnection(LINKEDIN_CONNECTION);
const X_KEY = resources.socialResourceKeyForConnection(X_CONNECTION);

function fakePrisma(project) {
  const state = { project: structuredClone(project) };
  return {
    state,
    codexProject: {
      findFirst: async ({ where }) => {
        if (where.id !== state.project.id) return null;
        if (where.userId && where.userId !== state.project.userId) return null;
        return structuredClone(state.project);
      },
      findUnique: async ({ where }) => (
        where.id === state.project.id ? structuredClone(state.project) : null
      ),
      update: async ({ where, data }) => {
        assert.equal(where.id, state.project.id);
        state.project = { ...state.project, ...structuredClone(data) };
        return structuredClone(state.project);
      },
    },
  };
}

test('company resources default to an empty durable state', () => {
  assert.deepEqual(resources.readCompanyResources({
    id: 'p1',
    userId: 'u1',
    brief: null,
  }), {
    assignments: {},
    pinned: [],
    revision: 0,
  });
});

test('company resources persist assignments and pins without replacing the rest of brief', async () => {
  const project = {
    id: 'p1',
    userId: 'u1',
    brief: { goal: 'operate company' },
  };
  const prisma = fakePrisma(project);

  const saved = await resources.writeCompanyResources({
    prisma,
    project,
    resources: {
      assignments: {
        'connector:gmail': 'marketing',
        [LINKEDIN_KEY]: 'sales',
      },
      pinned: ['connector:gmail', LINKEDIN_KEY, 'connector:gmail'],
    },
    expectedRevision: 0,
  });

  assert.deepEqual(saved, {
    assignments: {
      'connector:gmail': 'marketing',
      [LINKEDIN_KEY]: 'sales',
    },
    pinned: ['connector:gmail', LINKEDIN_KEY],
    revision: 1,
  });
  assert.equal(prisma.state.project.brief.goal, 'operate company');
  assert.deepEqual(prisma.state.project.brief.companyResources, saved);
  assert.deepEqual(resources.readCompanyResources(prisma.state.project), saved);
});

test('company resources reject stale revisions and return the current state', async () => {
  const project = {
    id: 'p1',
    userId: 'u1',
    brief: {},
  };
  const prisma = fakePrisma(project);
  const first = await resources.writeCompanyResources({
    prisma,
    project,
    resources: {
      assignments: { [LINKEDIN_KEY]: 'marketing' },
      pinned: [],
    },
    expectedRevision: 0,
  });
  assert.equal(first.revision, 1);

  await assert.rejects(
    resources.writeCompanyResources({
      prisma,
      project,
      resources: {
        assignments: { [X_KEY]: 'marketing' },
        pinned: [],
      },
      expectedRevision: 0,
    }),
    (error) => (
      error instanceof resources.CompanyResourcesError
      && error.code === 'company_resources_revision_conflict'
      && error.status === 409
      && error.details.currentRevision === 1
      && error.details.resources.assignments[LINKEDIN_KEY] === 'marketing'
    ),
  );
});

test('concurrent company resource writes allow exactly one writer per revision', async () => {
  const project = {
    id: 'p-concurrent',
    userId: 'u1',
    brief: {},
  };
  const prisma = fakePrisma(project);
  const writes = await Promise.allSettled([
    resources.writeCompanyResources({
      prisma,
      project,
      resources: {
        assignments: { [LINKEDIN_KEY]: 'marketing' },
        pinned: [],
      },
      expectedRevision: 0,
    }),
    resources.writeCompanyResources({
      prisma,
      project,
      resources: {
        assignments: { [X_KEY]: 'marketing' },
        pinned: [],
      },
      expectedRevision: 0,
    }),
  ]);
  assert.equal(writes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(writes.filter((result) => (
    result.status === 'rejected'
    && result.reason?.code === 'company_resources_revision_conflict'
  )).length, 1);
  assert.equal(resources.readCompanyResources(prisma.state.project).revision, 1);
});

test('stored company resources omit malformed keys and assignments to removed departments', () => {
  const project = {
    id: 'p1',
    userId: 'u1',
    brief: {
      companyDepartmentHidden: ['marketing'],
      companyResources: {
        assignments: {
          'connector:gmail': 'marketing',
          'catalog:google-drive': 'ceo-office',
          'not-namespaced': 'ceo-office',
        },
        pinned: [
          'catalog:google-drive',
          'not-namespaced',
          'catalog:google-drive',
          'social:x',
        ],
      },
    },
  };

  assert.deepEqual(resources.readCompanyResources(project), {
    assignments: {
      'catalog:google-drive': 'ceo-office',
    },
    pinned: ['catalog:google-drive'],
    revision: 0,
  });
});

test('only social resources assigned to the literal Marketing department authorize publishing', () => {
  const project = {
    id: 'p1',
    userId: 'u1',
    brief: {
      companyResources: {
        assignments: {
          [LINKEDIN_KEY]: 'marketing',
          [X_KEY]: 'growth-engines',
          'connector:gmail': 'marketing',
        },
        pinned: [],
      },
    },
  };
  assert.deepEqual(
    [...resources.marketingSocialPlatforms(project, [LINKEDIN_CONNECTION, X_CONNECTION])],
    ['linkedin'],
  );
});

test('social grants bind to the exact connection and account identity', () => {
  const project = {
    id: 'p1',
    userId: 'u1',
    brief: {
      companyResources: {
        assignments: { [LINKEDIN_KEY]: 'marketing' },
        pinned: [LINKEDIN_KEY],
      },
    },
  };
  assert.deepEqual(
    [...resources.marketingSocialPlatforms(project, [LINKEDIN_CONNECTION])],
    ['linkedin'],
  );
  assert.deepEqual(
    [...resources.marketingSocialPlatforms(project, [{
      ...LINKEDIN_CONNECTION,
      accountId: 'different-account',
    }])],
    [],
  );
  assert.deepEqual(
    [...resources.marketingSocialPlatforms(project, [{
      ...LINKEDIN_CONNECTION,
      id: 'different-connection',
    }])],
    [],
  );
  assert.deepEqual(
    [...resources.marketingSocialPlatforms(project, [{
      ...LINKEDIN_CONNECTION,
      accessToken: null,
    }])],
    [],
  );
  assert.equal(
    resources.socialResourceKeyForConnection({
      ...LINKEDIN_CONNECTION,
      accountId: '\ud800',
    }),
    null,
  );
  assert.equal(resources.isValidResourceKey('social:linkedin'), false);
});

test('external effects require an active durable Company Project association owned by the same user', async () => {
  const active = {
    id: 'codex-1',
    userId: 'u1',
    deletedAt: null,
    brief: {},
    companyLink: {
      project: { id: 'company-1', userId: 'u1', deletedAt: null },
    },
  };
  const prisma = fakePrisma(active);
  assert.equal(
    (await resources.loadActiveOwnedCompanyProject({
      prisma,
      projectId: 'codex-1',
      userId: 'u1',
    }))?.id,
    'codex-1',
  );

  prisma.state.project.companyLink.project.deletedAt = new Date();
  assert.equal(await resources.loadActiveOwnedCompanyProject({
    prisma,
    projectId: 'codex-1',
    userId: 'u1',
  }), null);

  prisma.state.project.companyLink = null;
  assert.equal(await resources.loadActiveOwnedCompanyProject({
    prisma,
    projectId: 'codex-1',
    userId: 'u1',
  }), null);
});

test('company resource writes reject malformed keys and unknown departments', async () => {
  const project = {
    id: 'p1',
    userId: 'u1',
    brief: { companyDepartmentHidden: ['marketing'] },
  };
  const prisma = fakePrisma(project);

  await assert.rejects(
    resources.writeCompanyResources({
      prisma,
      project,
      resources: {
        assignments: { gmail: 'ceo-office' },
        pinned: [],
      },
      expectedRevision: 0,
    }),
    (error) => (
      error instanceof resources.CompanyResourcesError
      && error.code === 'company_resource_key_invalid'
    ),
  );

  await assert.rejects(
    resources.writeCompanyResources({
      prisma,
      project,
      resources: {
        assignments: { 'connector:gmail': 'marketing' },
        pinned: [],
      },
      expectedRevision: 0,
    }),
    (error) => (
      error instanceof resources.CompanyResourcesError
      && error.code === 'company_resource_department_not_found'
    ),
  );
});

test('company resources routes use the owned project gate and exact response contract', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/routes/codex.js'),
    'utf8',
  );

  assert.match(
    source,
    /router\.get\('\/projects\/:id\/company-resources', authenticateToken, async \(req, res\) => \{[\s\S]*?const project = await loadOwnedProjectRecord\(req, res\);[\s\S]*?res\.json\(\{ resources: service\.readCompanyResources\(project\) \}\)/,
  );
  assert.match(
    source,
    /router\.put\('\/projects\/:id\/company-resources', authenticateToken, async \(req, res\) => \{[\s\S]*?const project = await loadOwnedProjectRecord\(req, res\);[\s\S]*?resources: req\.body,[\s\S]*?expectedRevision: req\.body\?\.expectedRevision,[\s\S]*?res\.json\(\{ resources \}\)/,
  );
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { buildRouteTestApp, installAuthSessionMock, reloadModule } = require('./http-test-utils');
const prismaClient = require('../src/config/database');

const {
  assertCollectionAccess,
  canManageOrganizationResource,
  normalizeShareAccess,
  validateMentionUserIds,
} = require('../src/services/research/research-collaboration');

function makePrisma() {
  const memberships = [
    { orgId: 'org-a', userId: 'owner', role: 'OWNER' },
    { orgId: 'org-a', userId: 'editor', role: 'MEMBER' },
    { orgId: 'org-a', userId: 'viewer', role: 'VIEWER' },
    { orgId: 'org-b', userId: 'intruder', role: 'OWNER' },
  ];
  const collections = [
    { id: 'private', userId: 'owner', name: 'Privada', shares: [] },
    { id: 'shared-view', userId: 'owner', name: 'Lectura', shares: [{ organizationId: 'org-a', access: 'VIEW' }] },
    { id: 'shared-edit', userId: 'owner', name: 'Edición', shares: [{ organizationId: 'org-a', access: 'EDIT' }] },
  ];
  return {
    orgMembership: {
      async findUnique({ where }) {
        const key = where.orgId_userId;
        const row = memberships.find((item) => item.orgId === key.orgId && item.userId === key.userId);
        return row ? { ...row, organization: { id: row.orgId, settings: null } } : null;
      },
      async findMany({ where }) {
        return memberships
          .filter((item) => item.orgId === where.orgId && where.userId.in.includes(item.userId))
          .map((item) => ({ userId: item.userId }));
      },
    },
    researchCollection: {
      async findFirst({ where, include }) {
        let row = collections.find((item) => item.id === where.id);
        if (where.userId && row?.userId !== where.userId) row = null;
        const orgId = where.shares?.some?.organizationId;
        if (orgId && !row?.shares.some((share) => share.organizationId === orgId)) row = null;
        if (!row) return null;
        if (!include?.shares) return { ...row };
        const requestedOrg = include.shares.where.organizationId;
        return { ...row, shares: row.shares.filter((share) => share.organizationId === requestedOrg) };
      },
    },
  };
}

test('personal collections remain owner-only', async () => {
  const prisma = makePrisma();
  const access = await assertCollectionAccess(prisma, {
    collectionId: 'private', userId: 'owner', mode: 'edit',
  });
  assert.equal(access.canEdit, true);
  await assert.rejects(
    assertCollectionAccess(prisma, { collectionId: 'private', userId: 'editor' }),
    (error) => error.status === 404 && error.code === 'collection_not_found',
  );
});

test('organization share access respects VIEW, EDIT and membership roles', async () => {
  const prisma = makePrisma();
  const readable = await assertCollectionAccess(prisma, {
    collectionId: 'shared-view', userId: 'editor', organizationId: 'org-a',
  });
  assert.equal(readable.canEdit, false);
  assert.equal(readable.canComment, true);
  await assert.rejects(
    assertCollectionAccess(prisma, {
      collectionId: 'shared-view', userId: 'editor', organizationId: 'org-a', mode: 'edit',
    }),
    (error) => error.status === 403 && error.code === 'collection_edit_forbidden',
  );

  const editable = await assertCollectionAccess(prisma, {
    collectionId: 'shared-edit', userId: 'editor', organizationId: 'org-a', mode: 'edit',
  });
  assert.equal(editable.canEdit, true);
  await assert.rejects(
    assertCollectionAccess(prisma, {
      collectionId: 'shared-edit', userId: 'viewer', organizationId: 'org-a', mode: 'comment',
    }),
    (error) => error.status === 403 && error.code === 'collection_comment_forbidden',
  );
});

test('cross-tenant access fails closed even when the collection id is known', async () => {
  const prisma = makePrisma();
  await assert.rejects(
    assertCollectionAccess(prisma, {
      collectionId: 'shared-edit', userId: 'intruder', organizationId: 'org-b',
    }),
    (error) => error.status === 404 && error.code === 'collection_not_found',
  );
  await assert.rejects(
    assertCollectionAccess(prisma, {
      collectionId: 'shared-edit', userId: 'unknown', organizationId: 'org-a',
    }),
    (error) => error.status === 404,
  );
});

test('mentions are limited to current organization members', async () => {
  const prisma = makePrisma();
  const ids = await validateMentionUserIds(
    prisma,
    'org-a',
    ['editor', 'editor', 'viewer', 'intruder', 'owner'],
    { excludeUserId: 'owner' },
  );
  assert.deepEqual(ids, ['editor', 'viewer']);
  assert.equal(normalizeShareAccess('edit'), 'EDIT');
  assert.equal(normalizeShareAccess('anything'), 'VIEW');
  assert.equal(canManageOrganizationResource({ membershipRole: 'ADMIN', creatorId: 'x', userId: 'y' }), true);
  assert.equal(canManageOrganizationResource({ membershipRole: 'MEMBER', creatorId: 'x', userId: 'y' }), false);
});

test('organization library route lists only shared data and strips another member private note', async (t) => {
  const auth = installAuthSessionMock();
  const originals = {
    membership: prismaClient.orgMembership.findUnique,
    collectionFirst: prismaClient.researchCollection.findFirst,
    collectionMany: prismaClient.researchCollection.findMany,
    referenceMany: prismaClient.researchReference.findMany,
    referenceCount: prismaClient.researchReference.count,
  };
  t.after(() => {
    auth.restore();
    prismaClient.orgMembership.findUnique = originals.membership;
    prismaClient.researchCollection.findFirst = originals.collectionFirst;
    prismaClient.researchCollection.findMany = originals.collectionMany;
    prismaClient.researchReference.findMany = originals.referenceMany;
    prismaClient.researchReference.count = originals.referenceCount;
  });

  prismaClient.orgMembership.findUnique = async ({ where }) => {
    const key = where.orgId_userId;
    if (key.orgId !== 'org-a' || key.userId !== auth.user.id) return null;
    return { orgId: 'org-a', userId: auth.user.id, role: 'MEMBER', organization: { id: 'org-a', settings: null } };
  };
  prismaClient.researchCollection.findFirst = async ({ where, include }) => {
    if (where.id !== 'collection-a' || where.shares?.some?.organizationId !== 'org-a') return null;
    return {
      id: 'collection-a', userId: 'owner-a', name: 'Equipo clínico',
      shares: include?.shares ? [{ organizationId: 'org-a', access: 'EDIT' }] : [],
    };
  };
  prismaClient.researchCollection.findMany = async ({ where }) => {
    assert.equal(where.shares.some.organizationId, 'org-a');
    return [{
      id: 'collection-a', userId: 'owner-a', name: 'Equipo clínico', tags: [],
      createdAt: new Date(), updatedAt: new Date(), _count: { items: 2, comments: 1 },
      shares: [{ organizationId: 'org-a', access: 'EDIT' }],
      user: { id: 'owner-a', name: 'Owner A', avatar: null },
    }];
  };
  const references = [
    { id: 'owned', userId: auth.user.id, title: 'Owned', note: 'mi nota', status: 'active', sources: [], tags: [], collectionItems: [{ collectionId: 'collection-a' }], updatedAt: new Date() },
    { id: 'shared', userId: 'owner-a', title: 'Shared', note: 'nota privada ajena', status: 'active', sources: [], tags: [], collectionItems: [{ collectionId: 'collection-a' }], updatedAt: new Date() },
  ];
  prismaClient.researchReference.findMany = async () => references;
  prismaClient.researchReference.count = async () => references.length;

  const app = buildRouteTestApp('/api/research-library', reloadModule('../src/routes/research-library'));
  const response = await request(app)
    .get('/api/research-library?organizationId=org-a&collectionId=collection-a')
    .set('Authorization', auth.authHeader);

  assert.equal(response.status, 200);
  assert.equal(response.body.scope, 'organization');
  assert.equal(response.body.collections.length, 1);
  assert.equal(response.body.collections[0].canEdit, true);
  assert.equal(response.body.references.find((item) => item.id === 'owned').note, 'mi nota');
  assert.equal(response.body.references.find((item) => item.id === 'shared').note, null);

  const crossTenant = await request(app)
    .get('/api/research-library?organizationId=org-b&collectionId=collection-a')
    .set('Authorization', auth.authHeader);
  assert.equal(crossTenant.status, 404);
});

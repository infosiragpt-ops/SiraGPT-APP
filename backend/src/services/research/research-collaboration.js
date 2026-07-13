'use strict';

const { assertMembership, roleAtLeast } = require('../orgs-service');

function accessError(code, status, message = code) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function normalizeShareAccess(value) {
  return String(value || '').toUpperCase() === 'EDIT' ? 'EDIT' : 'VIEW';
}

async function assertCollectionAccess(prisma, {
  collectionId,
  userId,
  organizationId = null,
  mode = 'read',
  user = null,
} = {}) {
  if (!prisma || !collectionId || !userId) {
    throw accessError('collection_not_found', 404);
  }

  if (!organizationId) {
    const collection = await prisma.researchCollection.findFirst({
      where: { id: collectionId, userId },
    });
    if (!collection) throw accessError('collection_not_found', 404);
    return {
      collection,
      membership: null,
      share: null,
      isOwner: true,
      canEdit: true,
      canComment: false,
    };
  }

  const membership = await assertMembership(
    prisma,
    organizationId,
    userId,
    'VIEWER',
    user ? { user } : {},
  );
  const collection = await prisma.researchCollection.findFirst({
    where: {
      id: collectionId,
      shares: { some: { organizationId } },
    },
    include: {
      shares: {
        where: { organizationId },
        take: 1,
      },
    },
  });
  const share = collection?.shares?.[0] || null;
  if (!collection || !share) throw accessError('collection_not_found', 404);

  const isOwner = collection.userId === userId;
  const canEdit = isOwner
    || roleAtLeast(membership.role, 'ADMIN')
    || (share.access === 'EDIT' && roleAtLeast(membership.role, 'MEMBER'));
  const canComment = roleAtLeast(membership.role, 'MEMBER');

  if (mode === 'edit' && !canEdit) {
    throw accessError('collection_edit_forbidden', 403, 'requires collection edit access');
  }
  if (mode === 'comment' && !canComment) {
    throw accessError('collection_comment_forbidden', 403, 'requires organization member role');
  }

  return { collection, membership, share, isOwner, canEdit, canComment };
}

async function validateMentionUserIds(prisma, organizationId, rawIds, { excludeUserId = null } = {}) {
  const requested = Array.from(new Set((Array.isArray(rawIds) ? rawIds : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)))
    .filter((id) => id !== excludeUserId)
    .slice(0, 20);
  if (!requested.length) return [];
  const memberships = await prisma.orgMembership.findMany({
    where: { orgId: organizationId, userId: { in: requested } },
    select: { userId: true },
  });
  const allowed = new Set(memberships.map((membership) => membership.userId));
  return requested.filter((id) => allowed.has(id));
}

function canManageOrganizationResource({ membershipRole, creatorId, userId }) {
  return creatorId === userId || roleAtLeast(membershipRole, 'ADMIN');
}

module.exports = {
  accessError,
  assertCollectionAccess,
  canManageOrganizationResource,
  normalizeShareAccess,
  validateMentionUserIds,
};

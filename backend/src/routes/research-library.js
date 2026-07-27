'use strict';

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const { writeAuditLog } = require('../utils/audit-log');
const { upsertSources, resolveConflict, uniqueStrings } = require('../services/research/research-library');
const { exportReferences } = require('../services/research/reference-export');
const { auditReferences } = require('../services/research/reference-audit');
const { buildCitationGraph } = require('../services/research/citation-graph');
const { syncToMendeley, syncToZotero } = require('../services/research/reference-manager-sync');
const { assertMembership, roleAtLeast } = require('../services/orgs-service');
const { createNotification } = require('../services/user-notifications');
const {
  assertCollectionAccess,
  canManageOrganizationResource,
  normalizeShareAccess,
  validateMentionUserIds,
} = require('../services/research/research-collaboration');

const router = express.Router();

function boundedString(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

async function ownedCollection(userId, id) {
  if (!id) return null;
  return prisma.researchCollection.findFirst({ where: { id, userId } });
}

function organizationIdFrom(value) {
  return boundedString(value, 100) || null;
}

function sendAccessError(res, error) {
  if (!error?.status) return false;
  res.status(error.status).json({ error: error.code || error.message });
  return true;
}

function collectionEnvelope(collection, { userId, organizationId = null, membershipRole = null } = {}) {
  if (!organizationId) return { ...collection, scope: 'personal', canEdit: true };
  const share = collection.shares?.find((item) => item.organizationId === organizationId)
    || collection.shares?.[0]
    || null;
  const isOwner = collection.userId === userId;
  const canEdit = isOwner
    || roleAtLeast(membershipRole, 'ADMIN')
    || (share?.access === 'EDIT' && roleAtLeast(membershipRole, 'MEMBER'));
  return {
    ...collection,
    shares: undefined,
    scope: 'organization',
    organizationId,
    accessLevel: share?.access || 'VIEW',
    canEdit,
    isOwner,
  };
}

async function referencesFor(userId, body = {}, user = null) {
  const organizationId = organizationIdFrom(body.organizationId);
  let where = { userId, status: 'active' };
  if (organizationId) {
    await assertMembership(prisma, organizationId, userId, 'VIEWER', user ? { user } : {});
    where = {
      status: 'active',
      collectionItems: {
        some: { collection: { shares: { some: { organizationId } } } },
      },
    };
  }
  if (Array.isArray(body.referenceIds) && body.referenceIds.length) {
    where.id = { in: body.referenceIds.slice(0, 200).map(String) };
  }
  if (body.collectionId) {
    let collection;
    try {
      ({ collection } = await assertCollectionAccess(prisma, {
        collectionId: String(body.collectionId),
        userId,
        organizationId,
        user,
      }));
    } catch (error) {
      if (error?.status === 404) return null;
      throw error;
    }
    where.collectionItems = { some: { collectionId: collection.id } };
  }
  return prisma.researchReference.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 200 });
}

router.get('/', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const page = Math.max(1, Number(req.query.page) || 1);
  const search = boundedString(req.query.search, 200);
  const collectionId = boundedString(req.query.collectionId, 100);
  const organizationId = organizationIdFrom(req.query.organizationId);
  let membership = null;
  let where = { userId, status: 'active' };
  if (organizationId) {
    try {
      membership = await assertMembership(prisma, organizationId, userId, 'VIEWER', { user: req.user });
    } catch (error) {
      if (sendAccessError(res, error)) return;
      console.error('[research-library] membership check failed:', error.message);
      return res.status(500).json({ error: 'research_library_list_failed' });
    }
    where = {
      status: 'active',
      collectionItems: {
        some: { collection: { shares: { some: { organizationId } } } },
      },
    };
  }
  if (search) where.OR = [
    { title: { contains: search, mode: 'insensitive' } },
    { venue: { contains: search, mode: 'insensitive' } },
    ...(!organizationId ? [{ note: { contains: search, mode: 'insensitive' } }] : []),
  ];
  if (collectionId) {
    let collection;
    try {
      ({ collection } = await assertCollectionAccess(prisma, {
        collectionId,
        userId,
        organizationId,
        user: req.user,
      }));
    } catch (error) {
      if (sendAccessError(res, error)) return;
      console.error('[research-library] collection access failed:', error.message);
      return res.status(500).json({ error: 'research_library_list_failed' });
    }
    where.collectionItems = { some: { collectionId } };
  }
  try {
    const [references, total, collections, pendingConflicts] = await Promise.all([
      prisma.researchReference.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { title: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: { collectionItems: { select: { collectionId: true } } },
      }),
      prisma.researchReference.count({ where }),
      prisma.researchCollection.findMany({
        where: organizationId
          ? { shares: { some: { organizationId } } }
          : { userId },
        orderBy: [{ folder: 'asc' }, { updatedAt: 'desc' }],
        include: {
          _count: { select: { items: true, comments: true } },
          ...(organizationId ? {
            shares: { where: { organizationId } },
            user: { select: { id: true, name: true, avatar: true } },
          } : {}),
        },
      }),
      organizationId
        ? Promise.resolve(0)
        : prisma.researchReferenceConflict.count({ where: { userId, status: 'pending' } }),
    ]);
    const safeReferences = references.map((reference) => ({
      ...reference,
      note: organizationId && reference.userId !== userId ? null : reference.note,
      isOwned: reference.userId === userId,
      userId: undefined,
    }));
    const safeCollections = collections.map((collection) => collectionEnvelope(collection, {
      userId,
      organizationId,
      membershipRole: membership?.role || null,
    }));
    return res.json({
      references: safeReferences,
      collections: safeCollections,
      pendingConflicts,
      scope: organizationId ? 'organization' : 'personal',
      organizationId,
      role: membership?.role || null,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    console.error('[research-library] list failed:', error.message);
    return res.status(500).json({ error: 'research_library_list_failed' });
  }
});

router.post('/references', authenticateToken, async (req, res) => {
  const sources = Array.isArray(req.body?.sources) ? req.body.sources : [];
  if (!sources.length || sources.length > 100) return res.status(400).json({ error: 'sources_required', max: 100 });
  try {
    const organizationId = organizationIdFrom(req.body.organizationId);
    let authorizedCollection = null;
    if (req.body.collectionId) {
      ({ collection: authorizedCollection } = await assertCollectionAccess(prisma, {
        collectionId: boundedString(req.body.collectionId, 100),
        userId: req.user.id,
        organizationId,
        mode: 'edit',
        user: req.user,
      }));
    }
    const result = await upsertSources(prisma, req.user.id, sources, {
      collectionId: boundedString(req.body.collectionId, 100) || null,
      collectionName: boundedString(req.body.collectionName, 160) || null,
      folder: boundedString(req.body.folder, 160) || null,
      tags: uniqueStrings(req.body.tags),
      note: boundedString(req.body.note, 10_000) || null,
      authorizedCollection,
    });
    return res.status(201).json(result);
  } catch (error) {
    if (sendAccessError(res, error)) return;
    if (error.code === 'collection_not_found') return res.status(404).json({ error: error.code });
    console.error('[research-library] save failed:', error.message);
    return res.status(500).json({ error: 'research_library_save_failed' });
  }
});

router.patch('/references/:id', authenticateToken, async (req, res) => {
  const reference = await prisma.researchReference.findFirst({ where: { id: req.params.id, userId: req.user.id, status: 'active' } });
  if (!reference) return res.status(404).json({ error: 'reference_not_found' });
  const data = {};
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'note')) data.note = boundedString(req.body.note, 10_000) || null;
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'tags')) data.tags = uniqueStrings(req.body.tags);
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'title')) data.title = boundedString(req.body.title, 1000) || reference.title;
  if (!Object.keys(data).length) return res.status(400).json({ error: 'no_updatable_fields' });
  return res.json(await prisma.researchReference.update({ where: { id: reference.id }, data }));
});

router.delete('/references/:id', authenticateToken, async (req, res) => {
  const reference = await prisma.researchReference.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!reference) return res.status(404).json({ error: 'reference_not_found' });
  await prisma.researchReference.delete({ where: { id: reference.id } });
  return res.json({ ok: true });
});

router.post('/collections', authenticateToken, async (req, res) => {
  const name = boundedString(req.body?.name, 160);
  if (!name) return res.status(400).json({ error: 'name_required' });
  try {
    const organizationId = organizationIdFrom(req.body.organizationId);
    let membership = null;
    if (organizationId) {
      membership = await assertMembership(prisma, organizationId, req.user.id, 'MEMBER', { user: req.user });
    }
    const createData = {
      userId: req.user.id,
      name,
      description: boundedString(req.body.description, 5000) || null,
      folder: boundedString(req.body.folder, 160) || null,
      tags: uniqueStrings(req.body.tags),
    };
    const collection = organizationId
      ? await prisma.$transaction(async (tx) => {
          const created = await tx.researchCollection.create({ data: createData });
          await tx.researchCollectionShare.create({
            data: {
              collectionId: created.id,
              organizationId,
              sharedById: req.user.id,
              access: 'EDIT',
            },
          });
          return created;
        })
      : await prisma.researchCollection.create({ data: createData });
    if (organizationId) {
      void writeAuditLog(prisma, {
        action: 'research_collection_share',
        userId: req.user.id,
        resource: 'research_collection',
        resourceId: collection.id,
        metadata: { orgId: organizationId, access: 'EDIT', createdWithShare: true },
        req,
      });
    }
    return res.status(201).json(collectionEnvelope({
      ...collection,
      ...(organizationId ? { shares: [{ organizationId, access: 'EDIT' }] } : {}),
    }, {
      userId: req.user.id,
      organizationId,
      membershipRole: membership?.role || null,
    }));
  } catch (error) {
    if (sendAccessError(res, error)) return;
    if (error.code === 'P2002') return res.status(409).json({ error: 'collection_name_exists' });
    return res.status(500).json({ error: 'collection_create_failed' });
  }
});

router.patch('/collections/:id', authenticateToken, async (req, res) => {
  try {
    const organizationId = organizationIdFrom(req.body.organizationId || req.query.organizationId);
    const access = await assertCollectionAccess(prisma, {
      collectionId: req.params.id,
      userId: req.user.id,
      organizationId,
      mode: 'edit',
      user: req.user,
    });
    const data = {};
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'name')) data.name = boundedString(req.body.name, 160) || access.collection.name;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'description')) data.description = boundedString(req.body.description, 5000) || null;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'folder')) data.folder = boundedString(req.body.folder, 160) || null;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'tags')) data.tags = uniqueStrings(req.body.tags);
    if (!Object.keys(data).length) return res.status(400).json({ error: 'no_updatable_fields' });
    const updated = await prisma.researchCollection.update({ where: { id: access.collection.id }, data });
    return res.json(collectionEnvelope({
      ...updated,
      ...(organizationId && access.share ? { shares: [access.share] } : {}),
    }, {
      userId: req.user.id,
      organizationId,
      membershipRole: access.membership?.role || null,
    }));
  } catch (error) {
    if (sendAccessError(res, error)) return;
    return res.status(500).json({ error: 'collection_update_failed' });
  }
});

router.delete('/collections/:id', authenticateToken, async (req, res) => {
  try {
    const organizationId = organizationIdFrom(req.query.organizationId);
    const access = await assertCollectionAccess(prisma, {
      collectionId: req.params.id,
      userId: req.user.id,
      organizationId,
      mode: 'edit',
      user: req.user,
    });
    if (!access.isOwner) return res.status(403).json({ error: 'collection_delete_forbidden' });
    await prisma.researchCollection.delete({ where: { id: access.collection.id } });
    return res.json({ ok: true });
  } catch (error) {
    if (sendAccessError(res, error)) return;
    return res.status(500).json({ error: 'collection_delete_failed' });
  }
});

router.post('/collections/:id/share', authenticateToken, async (req, res) => {
  const organizationId = organizationIdFrom(req.body.organizationId);
  if (!organizationId) return res.status(400).json({ error: 'organization_id_required' });
  try {
    const collection = await ownedCollection(req.user.id, req.params.id);
    if (!collection) return res.status(404).json({ error: 'collection_not_found' });
    const membership = await assertMembership(prisma, organizationId, req.user.id, 'MEMBER', { user: req.user });
    const access = normalizeShareAccess(req.body.access);
    const share = await prisma.researchCollectionShare.upsert({
      where: { collectionId_organizationId: { collectionId: collection.id, organizationId } },
      update: { access, sharedById: req.user.id },
      create: { collectionId: collection.id, organizationId, sharedById: req.user.id, access },
    });
    void writeAuditLog(prisma, {
      action: 'research_collection_share',
      userId: req.user.id,
      resource: 'research_collection',
      resourceId: collection.id,
      metadata: { orgId: organizationId, access },
      req,
    });
    return res.status(201).json({ ...share, role: membership.role });
  } catch (error) {
    if (sendAccessError(res, error)) return;
    return res.status(500).json({ error: 'collection_share_failed' });
  }
});

router.delete('/collections/:id/share/:organizationId', authenticateToken, async (req, res) => {
  const organizationId = organizationIdFrom(req.params.organizationId);
  try {
    const membership = await assertMembership(prisma, organizationId, req.user.id, 'VIEWER', { user: req.user });
    const collection = await prisma.researchCollection.findFirst({ where: { id: req.params.id } });
    if (!collection) return res.status(404).json({ error: 'collection_not_found' });
    if (collection.userId !== req.user.id && !roleAtLeast(membership.role, 'ADMIN')) {
      return res.status(403).json({ error: 'collection_unshare_forbidden' });
    }
    const removed = await prisma.researchCollectionShare.deleteMany({
      where: { collectionId: collection.id, organizationId },
    });
    if (!removed.count) return res.status(404).json({ error: 'collection_share_not_found' });
    void writeAuditLog(prisma, {
      action: 'research_collection_unshare',
      userId: req.user.id,
      resource: 'research_collection',
      resourceId: collection.id,
      metadata: { orgId: organizationId },
      req,
    });
    return res.json({ ok: true });
  } catch (error) {
    if (sendAccessError(res, error)) return;
    return res.status(500).json({ error: 'collection_unshare_failed' });
  }
});

router.post('/collections/:id/references', authenticateToken, async (req, res) => {
  try {
    const organizationId = organizationIdFrom(req.body.organizationId);
    const { collection } = await assertCollectionAccess(prisma, {
      collectionId: req.params.id,
      userId: req.user.id,
      organizationId,
      mode: 'edit',
      user: req.user,
    });
    const referenceIds = Array.isArray(req.body?.referenceIds) ? req.body.referenceIds.slice(0, 200).map(String) : [];
    const owned = await prisma.researchReference.findMany({ where: { userId: req.user.id, status: 'active', id: { in: referenceIds } }, select: { id: true } });
    await prisma.$transaction(owned.map((reference, position) => prisma.researchCollectionItem.upsert({
      where: { collectionId_referenceId: { collectionId: collection.id, referenceId: reference.id } },
      update: { position },
      create: { collectionId: collection.id, referenceId: reference.id, position },
    })));
    return res.json({ added: owned.length });
  } catch (error) {
    if (sendAccessError(res, error)) return;
    return res.status(500).json({ error: 'collection_references_add_failed' });
  }
});

router.delete('/collections/:id/references/:referenceId', authenticateToken, async (req, res) => {
  try {
    const organizationId = organizationIdFrom(req.query.organizationId);
    const { collection } = await assertCollectionAccess(prisma, {
      collectionId: req.params.id,
      userId: req.user.id,
      organizationId,
      mode: 'edit',
      user: req.user,
    });
    await prisma.researchCollectionItem.deleteMany({ where: { collectionId: collection.id, referenceId: req.params.referenceId } });
    return res.json({ ok: true });
  } catch (error) {
    if (sendAccessError(res, error)) return;
    return res.status(500).json({ error: 'collection_reference_remove_failed' });
  }
});

router.get('/collections/:id/comments', authenticateToken, async (req, res) => {
  const organizationId = organizationIdFrom(req.query.organizationId);
  if (!organizationId) return res.status(400).json({ error: 'organization_id_required' });
  try {
    const access = await assertCollectionAccess(prisma, {
      collectionId: req.params.id,
      userId: req.user.id,
      organizationId,
      user: req.user,
    });
    const comments = await prisma.researchCollectionComment.findMany({
      where: { collectionId: access.collection.id, organizationId },
      orderBy: { createdAt: 'asc' },
      take: 200,
      include: { author: { select: { id: true, name: true, avatar: true } } },
    });
    return res.json({ items: comments, canComment: access.canComment, canEdit: access.canEdit });
  } catch (error) {
    if (sendAccessError(res, error)) return;
    return res.status(500).json({ error: 'collection_comments_list_failed' });
  }
});

router.post('/collections/:id/comments', authenticateToken, async (req, res) => {
  const organizationId = organizationIdFrom(req.body.organizationId);
  const body = boundedString(req.body.body, 5000);
  if (!organizationId) return res.status(400).json({ error: 'organization_id_required' });
  if (!body) return res.status(400).json({ error: 'comment_body_required' });
  try {
    const access = await assertCollectionAccess(prisma, {
      collectionId: req.params.id,
      userId: req.user.id,
      organizationId,
      mode: 'comment',
      user: req.user,
    });
    const mentionedUserIds = await validateMentionUserIds(
      prisma,
      organizationId,
      req.body.mentionedUserIds,
      { excludeUserId: req.user.id },
    );
    const comment = await prisma.researchCollectionComment.create({
      data: {
        collectionId: access.collection.id,
        organizationId,
        authorId: req.user.id,
        body,
        mentionedUserIds,
      },
      include: { author: { select: { id: true, name: true, avatar: true } } },
    });
    await Promise.all(mentionedUserIds.map((userId) => createNotification(prisma, {
      userId,
      orgId: organizationId,
      type: 'research_collection_mention',
      title: `Mención en ${access.collection.name}`,
      message: `${req.user.name || 'Un miembro'} te mencionó en una colección científica compartida.`,
      severity: 'info',
      metadata: {
        orgId: organizationId,
        collectionId: access.collection.id,
        commentId: comment.id,
        actionUrl: `/library?tab=research&organizationId=${encodeURIComponent(organizationId)}&collectionId=${encodeURIComponent(access.collection.id)}`,
      },
    })));
    void writeAuditLog(prisma, {
      action: 'research_collection_comment',
      userId: req.user.id,
      resource: 'research_collection',
      resourceId: access.collection.id,
      metadata: { orgId: organizationId, commentId: comment.id, mentions: mentionedUserIds.length },
      req,
    });
    return res.status(201).json(comment);
  } catch (error) {
    if (sendAccessError(res, error)) return;
    return res.status(500).json({ error: 'collection_comment_create_failed' });
  }
});

router.patch('/collections/:id/comments/:commentId', authenticateToken, async (req, res) => {
  const organizationId = organizationIdFrom(req.body.organizationId || req.query.organizationId);
  const body = boundedString(req.body.body, 5000);
  if (!organizationId) return res.status(400).json({ error: 'organization_id_required' });
  if (!body) return res.status(400).json({ error: 'comment_body_required' });
  try {
    const access = await assertCollectionAccess(prisma, {
      collectionId: req.params.id,
      userId: req.user.id,
      organizationId,
      mode: 'comment',
      user: req.user,
    });
    const comment = await prisma.researchCollectionComment.findFirst({
      where: { id: req.params.commentId, collectionId: access.collection.id, organizationId },
    });
    if (!comment) return res.status(404).json({ error: 'comment_not_found' });
    if (!canManageOrganizationResource({
      membershipRole: access.membership.role,
      creatorId: comment.authorId,
      userId: req.user.id,
    })) return res.status(403).json({ error: 'comment_update_forbidden' });
    const mentionedUserIds = await validateMentionUserIds(
      prisma,
      organizationId,
      req.body.mentionedUserIds,
      { excludeUserId: req.user.id },
    );
    const updated = await prisma.researchCollectionComment.update({
      where: { id: comment.id },
      data: { body, mentionedUserIds },
      include: { author: { select: { id: true, name: true, avatar: true } } },
    });
    return res.json(updated);
  } catch (error) {
    if (sendAccessError(res, error)) return;
    return res.status(500).json({ error: 'collection_comment_update_failed' });
  }
});

router.delete('/collections/:id/comments/:commentId', authenticateToken, async (req, res) => {
  const organizationId = organizationIdFrom(req.query.organizationId);
  if (!organizationId) return res.status(400).json({ error: 'organization_id_required' });
  try {
    const access = await assertCollectionAccess(prisma, {
      collectionId: req.params.id,
      userId: req.user.id,
      organizationId,
      mode: 'comment',
      user: req.user,
    });
    const comment = await prisma.researchCollectionComment.findFirst({
      where: { id: req.params.commentId, collectionId: access.collection.id, organizationId },
    });
    if (!comment) return res.status(404).json({ error: 'comment_not_found' });
    if (!canManageOrganizationResource({
      membershipRole: access.membership.role,
      creatorId: comment.authorId,
      userId: req.user.id,
    })) return res.status(403).json({ error: 'comment_delete_forbidden' });
    await prisma.researchCollectionComment.delete({ where: { id: comment.id } });
    return res.json({ ok: true });
  } catch (error) {
    if (sendAccessError(res, error)) return;
    return res.status(500).json({ error: 'collection_comment_delete_failed' });
  }
});

router.get('/templates', authenticateToken, async (req, res) => {
  const organizationId = organizationIdFrom(req.query.organizationId);
  if (!organizationId) return res.status(400).json({ error: 'organization_id_required' });
  try {
    const membership = await assertMembership(prisma, organizationId, req.user.id, 'VIEWER', { user: req.user });
    const items = await prisma.researchTemplate.findMany({
      where: { organizationId },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
      take: 100,
      include: { createdBy: { select: { id: true, name: true, avatar: true } } },
    });
    return res.json({
      items: items.map((item) => ({
        ...item,
        canManage: canManageOrganizationResource({
          membershipRole: membership.role,
          creatorId: item.createdById,
          userId: req.user.id,
        }),
        createdById: undefined,
      })),
      role: membership.role,
    });
  } catch (error) {
    if (sendAccessError(res, error)) return;
    return res.status(500).json({ error: 'research_templates_list_failed' });
  }
});

router.post('/templates', authenticateToken, async (req, res) => {
  const organizationId = organizationIdFrom(req.body.organizationId);
  const name = boundedString(req.body.name, 160);
  const query = boundedString(req.body.query, 5000);
  if (!organizationId) return res.status(400).json({ error: 'organization_id_required' });
  if (!name || !query) return res.status(400).json({ error: 'template_name_and_query_required' });
  try {
    await assertMembership(prisma, organizationId, req.user.id, 'MEMBER', { user: req.user });
    const data = {
      organizationId,
      createdById: req.user.id,
      name,
      description: boundedString(req.body.description, 5000) || null,
      query,
      filters: plainObject(req.body.filters),
      methodology: plainObject(req.body.methodology),
      tags: uniqueStrings(req.body.tags),
      isDefault: req.body.isDefault === true,
    };
    const item = await prisma.$transaction(async (tx) => {
      if (data.isDefault) {
        await tx.researchTemplate.updateMany({ where: { organizationId }, data: { isDefault: false } });
      }
      return tx.researchTemplate.create({
        data,
        include: { createdBy: { select: { id: true, name: true, avatar: true } } },
      });
    });
    void writeAuditLog(prisma, {
      action: 'research_template_create',
      userId: req.user.id,
      resource: 'research_template',
      resourceId: item.id,
      metadata: { orgId: organizationId },
      req,
    });
    return res.status(201).json({ ...item, canManage: true, createdById: undefined });
  } catch (error) {
    if (sendAccessError(res, error)) return;
    if (error.code === 'P2002') return res.status(409).json({ error: 'template_name_exists' });
    return res.status(500).json({ error: 'research_template_create_failed' });
  }
});

router.patch('/templates/:id', authenticateToken, async (req, res) => {
  const organizationId = organizationIdFrom(req.body.organizationId || req.query.organizationId);
  if (!organizationId) return res.status(400).json({ error: 'organization_id_required' });
  try {
    const membership = await assertMembership(prisma, organizationId, req.user.id, 'VIEWER', { user: req.user });
    const current = await prisma.researchTemplate.findFirst({ where: { id: req.params.id, organizationId } });
    if (!current) return res.status(404).json({ error: 'template_not_found' });
    if (!canManageOrganizationResource({
      membershipRole: membership.role,
      creatorId: current.createdById,
      userId: req.user.id,
    })) return res.status(403).json({ error: 'template_update_forbidden' });
    const data = {};
    if (Object.prototype.hasOwnProperty.call(req.body, 'name')) data.name = boundedString(req.body.name, 160) || current.name;
    if (Object.prototype.hasOwnProperty.call(req.body, 'description')) data.description = boundedString(req.body.description, 5000) || null;
    if (Object.prototype.hasOwnProperty.call(req.body, 'query')) data.query = boundedString(req.body.query, 5000) || current.query;
    if (Object.prototype.hasOwnProperty.call(req.body, 'filters')) data.filters = plainObject(req.body.filters);
    if (Object.prototype.hasOwnProperty.call(req.body, 'methodology')) data.methodology = plainObject(req.body.methodology);
    if (Object.prototype.hasOwnProperty.call(req.body, 'tags')) data.tags = uniqueStrings(req.body.tags);
    if (Object.prototype.hasOwnProperty.call(req.body, 'isDefault')) data.isDefault = req.body.isDefault === true;
    if (!Object.keys(data).length) return res.status(400).json({ error: 'no_updatable_fields' });
    const updated = await prisma.$transaction(async (tx) => {
      if (data.isDefault) {
        await tx.researchTemplate.updateMany({
          where: { organizationId, id: { not: current.id } },
          data: { isDefault: false },
        });
      }
      return tx.researchTemplate.update({
        where: { id: current.id },
        data,
        include: { createdBy: { select: { id: true, name: true, avatar: true } } },
      });
    });
    return res.json({ ...updated, canManage: true, createdById: undefined });
  } catch (error) {
    if (sendAccessError(res, error)) return;
    if (error.code === 'P2002') return res.status(409).json({ error: 'template_name_exists' });
    return res.status(500).json({ error: 'research_template_update_failed' });
  }
});

router.delete('/templates/:id', authenticateToken, async (req, res) => {
  const organizationId = organizationIdFrom(req.query.organizationId);
  if (!organizationId) return res.status(400).json({ error: 'organization_id_required' });
  try {
    const membership = await assertMembership(prisma, organizationId, req.user.id, 'VIEWER', { user: req.user });
    const current = await prisma.researchTemplate.findFirst({ where: { id: req.params.id, organizationId } });
    if (!current) return res.status(404).json({ error: 'template_not_found' });
    if (!canManageOrganizationResource({
      membershipRole: membership.role,
      creatorId: current.createdById,
      userId: req.user.id,
    })) return res.status(403).json({ error: 'template_delete_forbidden' });
    await prisma.researchTemplate.delete({ where: { id: current.id } });
    return res.json({ ok: true });
  } catch (error) {
    if (sendAccessError(res, error)) return;
    return res.status(500).json({ error: 'research_template_delete_failed' });
  }
});

router.get('/conflicts', authenticateToken, async (req, res) => {
  const items = await prisma.researchReferenceConflict.findMany({
    where: { userId: req.user.id, status: req.query.status === 'resolved' ? 'resolved' : 'pending' },
    orderBy: { createdAt: 'desc' },
    include: { existing: true, candidate: true },
    take: 100,
  });
  return res.json({ items });
});

router.post('/conflicts/:id/resolve', authenticateToken, async (req, res) => {
  const action = String(req.body?.action || '');
  if (!['keep_existing', 'keep_candidate', 'merge'].includes(action)) return res.status(400).json({ error: 'invalid_resolution' });
  const result = await resolveConflict(prisma, req.user.id, req.params.id, action);
  if (!result) return res.status(404).json({ error: 'conflict_not_found' });
  return res.json(result);
});

router.post('/export', authenticateToken, async (req, res) => {
  try {
    const references = await referencesFor(req.user.id, req.body, req.user);
    if (references === null) return res.status(404).json({ error: 'collection_not_found' });
    const exported = exportReferences(references, req.body?.format);
    res.setHeader('Content-Type', exported.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="siragpt-references.${exported.extension}"`);
    return res.send(exported.content);
  } catch (error) {
    if (sendAccessError(res, error)) return;
    return res.status(400).json({ error: error.code || 'unsupported_export_format' });
  }
});

router.post('/audit', authenticateToken, async (req, res) => {
  try {
    const text = boundedString(req.body?.text, 200_000);
    const references = Array.isArray(req.body?.references)
      ? req.body.references.slice(0, 500)
      : await referencesFor(req.user.id, req.body, req.user);
    if (references === null) return res.status(404).json({ error: 'collection_not_found' });
    return res.json(auditReferences(text, references));
  } catch (error) {
    if (sendAccessError(res, error)) return;
    return res.status(500).json({ error: 'reference_audit_failed' });
  }
});

router.post('/citation-graph', authenticateToken, async (req, res) => {
  try {
    const references = await referencesFor(req.user.id, req.body, req.user);
    if (references === null) return res.status(404).json({ error: 'collection_not_found' });
    return res.json(await buildCitationGraph(references, { limit: Math.min(10, Math.max(1, Number(req.body?.limit) || 5)) }));
  } catch (error) {
    if (sendAccessError(res, error)) return;
    return res.status(502).json({ error: 'citation_graph_failed' });
  }
});

router.post('/sync/zotero', authenticateToken, async (req, res) => {
  try {
    const references = await referencesFor(req.user.id, req.body, req.user);
    if (references === null) return res.status(404).json({ error: 'collection_not_found' });
    return res.json(await syncToZotero(references, {
      apiKey: boundedString(req.body?.apiKey, 500),
      userId: boundedString(req.body?.zoteroUserId, 100),
      collectionKey: boundedString(req.body?.zoteroCollectionKey, 100) || null,
      collectionName: boundedString(req.body?.collectionName, 160) || 'SiraGPT',
    }));
  } catch (error) {
    if (sendAccessError(res, error)) return;
    const status = /credentials_required/.test(error.message) ? 400 : 502;
    return res.status(status).json({ error: status === 400 ? error.message : 'zotero_sync_failed' });
  }
});

router.post('/sync/mendeley', authenticateToken, async (req, res) => {
  try {
    const references = await referencesFor(req.user.id, req.body, req.user);
    if (references === null) return res.status(404).json({ error: 'collection_not_found' });
    return res.json(await syncToMendeley(references, {
      accessToken: boundedString(req.body?.accessToken, 2000),
      folderId: boundedString(req.body?.mendeleyFolderId, 100) || null,
      folderName: boundedString(req.body?.collectionName, 160) || 'SiraGPT',
    }));
  } catch (error) {
    if (sendAccessError(res, error)) return;
    const status = /credentials_required/.test(error.message) ? 400 : 502;
    return res.status(status).json({ error: status === 400 ? error.message : 'mendeley_sync_failed' });
  }
});

module.exports = router;

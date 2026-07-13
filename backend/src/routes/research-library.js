'use strict';

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const { upsertSources, resolveConflict, uniqueStrings } = require('../services/research/research-library');
const { exportReferences } = require('../services/research/reference-export');
const { auditReferences } = require('../services/research/reference-audit');
const { buildCitationGraph } = require('../services/research/citation-graph');
const { syncToMendeley, syncToZotero } = require('../services/research/reference-manager-sync');

const router = express.Router();

function boundedString(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

async function ownedCollection(userId, id) {
  if (!id) return null;
  return prisma.researchCollection.findFirst({ where: { id, userId } });
}

async function referencesFor(userId, body = {}) {
  const where = { userId, status: 'active' };
  if (Array.isArray(body.referenceIds) && body.referenceIds.length) {
    where.id = { in: body.referenceIds.slice(0, 200).map(String) };
  }
  if (body.collectionId) {
    const collection = await ownedCollection(userId, String(body.collectionId));
    if (!collection) return null;
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
  const where = { userId, status: 'active' };
  if (search) where.OR = [
    { title: { contains: search, mode: 'insensitive' } },
    { venue: { contains: search, mode: 'insensitive' } },
    { note: { contains: search, mode: 'insensitive' } },
  ];
  if (collectionId) {
    const collection = await ownedCollection(userId, collectionId);
    if (!collection) return res.status(404).json({ error: 'collection_not_found' });
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
        where: { userId },
        orderBy: [{ folder: 'asc' }, { updatedAt: 'desc' }],
        include: { _count: { select: { items: true } } },
      }),
      prisma.researchReferenceConflict.count({ where: { userId, status: 'pending' } }),
    ]);
    return res.json({ references, collections, pendingConflicts, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (error) {
    console.error('[research-library] list failed:', error.message);
    return res.status(500).json({ error: 'research_library_list_failed' });
  }
});

router.post('/references', authenticateToken, async (req, res) => {
  const sources = Array.isArray(req.body?.sources) ? req.body.sources : [];
  if (!sources.length || sources.length > 100) return res.status(400).json({ error: 'sources_required', max: 100 });
  try {
    const result = await upsertSources(prisma, req.user.id, sources, {
      collectionId: boundedString(req.body.collectionId, 100) || null,
      collectionName: boundedString(req.body.collectionName, 160) || null,
      folder: boundedString(req.body.folder, 160) || null,
      tags: uniqueStrings(req.body.tags),
      note: boundedString(req.body.note, 10_000) || null,
    });
    return res.status(201).json(result);
  } catch (error) {
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
    const collection = await prisma.researchCollection.create({
      data: {
        userId: req.user.id,
        name,
        description: boundedString(req.body.description, 5000) || null,
        folder: boundedString(req.body.folder, 160) || null,
        tags: uniqueStrings(req.body.tags),
      },
    });
    return res.status(201).json(collection);
  } catch (error) {
    if (error.code === 'P2002') return res.status(409).json({ error: 'collection_name_exists' });
    return res.status(500).json({ error: 'collection_create_failed' });
  }
});

router.patch('/collections/:id', authenticateToken, async (req, res) => {
  const collection = await ownedCollection(req.user.id, req.params.id);
  if (!collection) return res.status(404).json({ error: 'collection_not_found' });
  const data = {};
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'name')) data.name = boundedString(req.body.name, 160) || collection.name;
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'description')) data.description = boundedString(req.body.description, 5000) || null;
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'folder')) data.folder = boundedString(req.body.folder, 160) || null;
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'tags')) data.tags = uniqueStrings(req.body.tags);
  if (!Object.keys(data).length) return res.status(400).json({ error: 'no_updatable_fields' });
  return res.json(await prisma.researchCollection.update({ where: { id: collection.id }, data }));
});

router.delete('/collections/:id', authenticateToken, async (req, res) => {
  const collection = await ownedCollection(req.user.id, req.params.id);
  if (!collection) return res.status(404).json({ error: 'collection_not_found' });
  await prisma.researchCollection.delete({ where: { id: collection.id } });
  return res.json({ ok: true });
});

router.post('/collections/:id/references', authenticateToken, async (req, res) => {
  const collection = await ownedCollection(req.user.id, req.params.id);
  if (!collection) return res.status(404).json({ error: 'collection_not_found' });
  const referenceIds = Array.isArray(req.body?.referenceIds) ? req.body.referenceIds.slice(0, 200).map(String) : [];
  const owned = await prisma.researchReference.findMany({ where: { userId: req.user.id, status: 'active', id: { in: referenceIds } }, select: { id: true } });
  await prisma.$transaction(owned.map((reference, position) => prisma.researchCollectionItem.upsert({
    where: { collectionId_referenceId: { collectionId: collection.id, referenceId: reference.id } },
    update: { position },
    create: { collectionId: collection.id, referenceId: reference.id, position },
  })));
  return res.json({ added: owned.length });
});

router.delete('/collections/:id/references/:referenceId', authenticateToken, async (req, res) => {
  const collection = await ownedCollection(req.user.id, req.params.id);
  if (!collection) return res.status(404).json({ error: 'collection_not_found' });
  await prisma.researchCollectionItem.deleteMany({ where: { collectionId: collection.id, referenceId: req.params.referenceId } });
  return res.json({ ok: true });
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
  const references = await referencesFor(req.user.id, req.body);
  if (references === null) return res.status(404).json({ error: 'collection_not_found' });
  try {
    const exported = exportReferences(references, req.body?.format);
    res.setHeader('Content-Type', exported.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="siragpt-references.${exported.extension}"`);
    return res.send(exported.content);
  } catch (error) {
    return res.status(400).json({ error: error.code || 'unsupported_export_format' });
  }
});

router.post('/audit', authenticateToken, async (req, res) => {
  const text = boundedString(req.body?.text, 200_000);
  const references = Array.isArray(req.body?.references)
    ? req.body.references.slice(0, 500)
    : await referencesFor(req.user.id, req.body);
  if (references === null) return res.status(404).json({ error: 'collection_not_found' });
  return res.json(auditReferences(text, references));
});

router.post('/citation-graph', authenticateToken, async (req, res) => {
  const references = await referencesFor(req.user.id, req.body);
  if (references === null) return res.status(404).json({ error: 'collection_not_found' });
  try {
    return res.json(await buildCitationGraph(references, { limit: Math.min(10, Math.max(1, Number(req.body?.limit) || 5)) }));
  } catch (error) {
    return res.status(502).json({ error: 'citation_graph_failed' });
  }
});

router.post('/sync/zotero', authenticateToken, async (req, res) => {
  const references = await referencesFor(req.user.id, req.body);
  if (references === null) return res.status(404).json({ error: 'collection_not_found' });
  try {
    return res.json(await syncToZotero(references, {
      apiKey: boundedString(req.body?.apiKey, 500),
      userId: boundedString(req.body?.zoteroUserId, 100),
      collectionKey: boundedString(req.body?.zoteroCollectionKey, 100) || null,
      collectionName: boundedString(req.body?.collectionName, 160) || 'SiraGPT',
    }));
  } catch (error) {
    const status = /credentials_required/.test(error.message) ? 400 : 502;
    return res.status(status).json({ error: status === 400 ? error.message : 'zotero_sync_failed' });
  }
});

router.post('/sync/mendeley', authenticateToken, async (req, res) => {
  const references = await referencesFor(req.user.id, req.body);
  if (references === null) return res.status(404).json({ error: 'collection_not_found' });
  try {
    return res.json(await syncToMendeley(references, {
      accessToken: boundedString(req.body?.accessToken, 2000),
      folderId: boundedString(req.body?.mendeleyFolderId, 100) || null,
      folderName: boundedString(req.body?.collectionName, 160) || 'SiraGPT',
    }));
  } catch (error) {
    const status = /credentials_required/.test(error.message) ? 400 : 502;
    return res.status(status).json({ error: status === 400 ? error.message : 'mendeley_sync_failed' });
  }
});

module.exports = router;

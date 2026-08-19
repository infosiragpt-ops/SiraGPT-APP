'use strict';

const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const prisma = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { requireScope } = require('../middleware/require-scope');
const documentCollections = require('../services/document-collections');
const collectionQueue = require('../services/document-collection-queue');

const router = express.Router();

router.use(authenticateToken);

function validationFail(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return true;
  }
  return false;
}

function sendError(res, err) {
  const status = err?.status || 500;
  if (status >= 500) console.error('[document-collections] route error:', err?.message || err);
  res.status(status).json({
    error: err?.message || 'document collection request failed',
    code: err?.code || 'document_collection_error',
  });
}

router.get(
  '/',
  requireScope('files:read'),
  [query('take').optional().isInt({ min: 1, max: 200 })],
  async (req, res) => {
    try {
      if (validationFail(req, res)) return;
      const collections = await documentCollections.listCollections({
        prisma,
        ownerId: req.user.id,
        take: req.query.take,
      });
      res.json({ ok: true, collections });
    } catch (err) {
      sendError(res, err);
    }
  },
);

router.post(
  '/',
  requireScope('files:write'),
  [
    body('name').trim().isLength({ min: 1, max: 180 }),
    body('description').optional({ nullable: true }).isString().isLength({ max: 2000 }),
  ],
  async (req, res) => {
    try {
      if (validationFail(req, res)) return;
      const collection = await documentCollections.createCollection({
        prisma,
        ownerId: req.user.id,
        name: req.body.name,
        description: req.body.description || null,
      });
      res.status(201).json({ ok: true, collection });
    } catch (err) {
      sendError(res, err);
    }
  },
);

router.get('/health', async (_req, res) => {
  try {
    const queue = await collectionQueue.getDocumentCollectionQueueHealth();
    res.json({ ok: true, queue });
  } catch (err) {
    res.status(503).json({ ok: false, error: err?.message || 'document collection queue unhealthy' });
  }
});

router.get(
  '/:collectionId',
  requireScope('files:read'),
  [param('collectionId').isString().isLength({ min: 1 })],
  async (req, res) => {
    try {
      if (validationFail(req, res)) return;
      const collection = await prisma.documentCollection.findFirst({
        where: { id: req.params.collectionId, ownerId: req.user.id },
        include: {
          documents: {
            orderBy: { createdAt: 'asc' },
            include: {
              document: {
                select: {
                  id: true,
                  originalName: true,
                  mimeType: true,
                  size: true,
                  processingStage: true,
                  createdAt: true,
                },
              },
            },
          },
        },
      });
      if (!collection) return res.status(404).json({ error: 'collection not found', code: 'document_collection_not_found' });
      res.json({ ok: true, collection });
    } catch (err) {
      sendError(res, err);
    }
  },
);

router.post(
  '/:collectionId/documents',
  requireScope('files:write'),
  [
    param('collectionId').isString().isLength({ min: 1 }),
    body('documentIds').isArray({ min: 1, max: 500 }),
    body('documentIds.*').isString().isLength({ min: 1 }),
  ],
  async (req, res) => {
    try {
      if (validationFail(req, res)) return;
      const result = await documentCollections.addDocumentsToCollection({
        prisma,
        ownerId: req.user.id,
        collectionId: req.params.collectionId,
        documentIds: req.body.documentIds,
        queue: collectionQueue,
      });
      res.status(202).json({ ok: true, ...result });
    } catch (err) {
      sendError(res, err);
    }
  },
);

router.post(
  '/:collectionId/ingest',
  requireScope('files:write'),
  [
    param('collectionId').isString().isLength({ min: 1 }),
    body('documentIds').optional().isArray({ min: 1, max: 500 }),
    body('documentIds.*').optional().isString().isLength({ min: 1 }),
  ],
  async (req, res) => {
    try {
      if (validationFail(req, res)) return;
      const job = await collectionQueue.enqueueCollectionIngest({
        ownerId: req.user.id,
        collectionId: req.params.collectionId,
        documentIds: req.body.documentIds || [],
      });
      res.status(202).json({ ok: true, collectionId: req.params.collectionId, jobId: job?.id || job?.jobId || null, inline: Boolean(job?.inline) });
    } catch (err) {
      sendError(res, err);
    }
  },
);

router.post(
  '/:collectionId/query',
  requireScope('files:read'),
  [
    param('collectionId').isString().isLength({ min: 1 }),
    body('question').trim().isLength({ min: 2, max: 8000 }),
    body('options').optional().isObject(),
    body('options.maxChunks').optional().isInt({ min: 1, max: 80 }),
    body('options.tokenBudget').optional().isInt({ min: 512, max: 32000 }),
  ],
  async (req, res) => {
    try {
      if (validationFail(req, res)) return;
      const result = await documentCollections.queryCollection({
        prisma,
        ownerId: req.user.id,
        collectionId: req.params.collectionId,
        question: req.body.question,
        options: req.body.options || {},
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      sendError(res, err);
    }
  },
);

module.exports = router;

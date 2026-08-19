/**
 * /api/projects/:projectId/documents — CRUD for ProjectDocument.
 *
 * Mounted nested under /api/projects with mergeParams:true so the
 * parent `:projectId` is available here. JWT auth + ownership
 * checks identical to the other project sub-routes.
 *
 * Design:
 *   - Content is Markdown (the source of truth). The Tiptap editor
 *     round-trips between ProseMirror state and Markdown via the
 *     tiptap-markdown extension. Storing Markdown means the docx
 *     export pipeline (/api/generate-document) doesn't need a
 *     separate HTML reader.
 *   - Auto-save is the frontend's responsibility — we accept PUT
 *     calls debounced to ~2 seconds idle. We set Last-Modified on
 *     the response so the client can detect conflicts if two tabs
 *     have the same doc open (out of scope to resolve here, but
 *     the header lets the client warn).
 *   - No "versions" / history table yet. Every save overwrites.
 *     If we add history later it goes in its own table indexed by
 *     (documentId, createdAt) so large docs don't hammer the main
 *     row with versioned JSON.
 */

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const prisma = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

// Cap the document-list scan so a project with many large docs can't load an
// unbounded number of full bodies into memory on one GET (newest-first).
const DOCUMENTS_LIST_LIMIT = Number(process.env.PROJECT_DOCUMENTS_LIST_LIMIT) || 200;

router.use(authenticateToken);

// ─── Helpers ─────────────────────────────────────────────────────────────

function validationFail(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return true;
  }
  return false;
}

async function ownProject(userId, projectId) {
  return prisma.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true },
  });
}

async function ownDocument(userId, projectId, docId) {
  // Two-step ownership: doc must belong to the project, project to
  // the user. Returns the doc row (or null) in one query via a
  // nested where.
  return prisma.projectDocument.findFirst({
    where: {
      id: docId,
      projectId,
      project: { userId },
    },
  });
}

// ─── GET / — list ────────────────────────────────────────────────────────

router.get('/', param('projectId').isString(), async (req, res) => {
  try {
    if (validationFail(req, res)) return;
    const projectId = req.params.projectId;
    if (!(await ownProject(req.user.id, projectId))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    // Single bounded query: fetch content alongside the metadata and slice the
    // snippet in JS. The previous version ran an N+1 (one findUnique per doc,
    // each pulling the full ~500KB content) AND had no take cap — a project with
    // many large docs drove N round-trips and loaded every full body into memory.
    const documents = await prisma.projectDocument.findMany({
      where: { projectId },
      orderBy: { updatedAt: 'desc' },
      take: DOCUMENTS_LIST_LIMIT,
      select: {
        id: true, title: true, createdAt: true, updatedAt: true,
        meta: true, content: true,
      },
    });
    const withSnippets = documents.map((d) => {
      const snippet = (d.content || '').replace(/\s+/g, ' ').trim().slice(0, 240);
      const { content, ...rest } = d;
      return { ...rest, snippet };
    });
    res.json({ documents: withSnippets });
  } catch (err) {
    console.error('[project-documents] list error:', err);
    res.status(500).json({ error: 'Failed to list documents' });
  }
});

// ─── POST / — create ─────────────────────────────────────────────────────

router.post(
  '/',
  [
    param('projectId').isString(),
    body('title').optional().isString().trim().isLength({ min: 1, max: 200 }),
    body('content').optional().isString().isLength({ max: 500_000 }),
  ],
  async (req, res) => {
    try {
      if (validationFail(req, res)) return;
      const projectId = req.params.projectId;
      if (!(await ownProject(req.user.id, projectId))) {
        return res.status(404).json({ error: 'Project not found' });
      }
      const doc = await prisma.projectDocument.create({
        data: {
          projectId,
          title: (req.body.title || 'Documento sin título').slice(0, 200),
          content: req.body.content || '',
        },
      });
      res.status(201).json({ document: doc });
    } catch (err) {
      console.error('[project-documents] create error:', err);
      res.status(500).json({ error: 'Failed to create document' });
    }
  }
);

// ─── GET /:docId — fetch one ─────────────────────────────────────────────

router.get(
  '/:docId',
  [param('projectId').isString(), param('docId').isString()],
  async (req, res) => {
    try {
      if (validationFail(req, res)) return;
      const doc = await ownDocument(req.user.id, req.params.projectId, req.params.docId);
      if (!doc) return res.status(404).json({ error: 'Document not found' });
      res.set('Last-Modified', doc.updatedAt.toUTCString());
      res.json({ document: doc });
    } catch (err) {
      console.error('[project-documents] get error:', err);
      res.status(500).json({ error: 'Failed to fetch document' });
    }
  }
);

// ─── PUT /:docId — update (auto-save target) ─────────────────────────────

router.put(
  '/:docId',
  [
    param('projectId').isString(), param('docId').isString(),
    body('title').optional().isString().trim().isLength({ min: 1, max: 200 }),
    body('content').optional().isString().isLength({ max: 500_000 }),
    body('meta').optional().isObject(),
  ],
  async (req, res) => {
    try {
      if (validationFail(req, res)) return;
      const existing = await ownDocument(req.user.id, req.params.projectId, req.params.docId);
      if (!existing) return res.status(404).json({ error: 'Document not found' });

      const data = {};
      if (typeof req.body.title === 'string') data.title = req.body.title.slice(0, 200);
      if (typeof req.body.content === 'string') data.content = req.body.content;
      if (req.body.meta !== undefined) data.meta = req.body.meta;

      const updated = await prisma.projectDocument.update({
        where: { id: existing.id },
        data,
      });
      res.set('Last-Modified', updated.updatedAt.toUTCString());
      res.json({ document: updated });
    } catch (err) {
      console.error('[project-documents] update error:', err);
      res.status(500).json({ error: 'Failed to update document' });
    }
  }
);

// ─── DELETE /:docId ──────────────────────────────────────────────────────

router.delete(
  '/:docId',
  [param('projectId').isString(), param('docId').isString()],
  async (req, res) => {
    try {
      if (validationFail(req, res)) return;
      const existing = await ownDocument(req.user.id, req.params.projectId, req.params.docId);
      if (!existing) return res.status(404).json({ error: 'Document not found' });
      await prisma.projectDocument.delete({ where: { id: existing.id } });
      res.json({ deleted: true });
    } catch (err) {
      console.error('[project-documents] delete error:', err);
      res.status(500).json({ error: 'Failed to delete document' });
    }
  }
);

module.exports = router;

/**
 * /api/projects — CRUD + chat creation for Projects.
 *
 * Projects are the user's task-scoped workspaces: a bundle of files
 * + custom instructions that every chat created within the project
 * can reference. The AI route (routes/ai.js) reads `chat.project`
 * when present and hands the project + files to master-prompt.js for
 * system-prompt injection.
 *
 * Endpoints:
 *   GET    /                    — list current user's projects
 *   POST   /                    — create a project
 *   GET    /:id                 — project + files + chats
 *   PUT    /:id                 — update name/description/instructions/isStarred
 *   DELETE /:id                 — delete project (cascades chats → SetNull, files → SetNull)
 *   POST   /:id/chat            — start a new chat within this project
 *   POST   /:id/files/:fileId   — attach a previously-uploaded file
 *   DELETE /:id/files/:fileId   — detach a file (does not delete the file row)
 *
 * All endpoints require JWT auth and are scoped to req.user.id. No
 * cross-user access — a direct id-guess returns 404, not 403, so we
 * don't leak which ids exist.
 */

const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const prisma = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const projectMemory = require('../services/project-memory');
const { buildProjectContextManifest } = require('../services/project-context');
const { buildChatListWhere, parsePositiveInt } = require('../services/chat-scope');
const crypto = require('crypto');

const router = express.Router();

// ─── Public share view ───────────────────────────────────────────────────
//
// Defined BEFORE the authenticateToken middleware so it stays public.
// Returns a redacted snapshot — name, description, file list — with no
// chat history, no owner info, no instructions (which may contain
// sensitive prompts). The /projects/share/:shareId frontend page reads
// this.

router.get('/share/:shareId', param('shareId').isString(), async (req, res) => {
  try {
    const project = await prisma.project.findFirst({
      where: { shareId: req.params.shareId },
      select: {
        id: true, name: true, description: true,
        createdAt: true, updatedAt: true,
        files: {
          select: { id: true, originalName: true, mimeType: true, size: true },
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
      },
    });
    if (!project) return res.status(404).json({ error: 'Share link not found or revoked' });
    res.json({ project });
  } catch (err) {
    console.error('[projects] public share error:', err);
    res.status(500).json({ error: 'Failed to fetch shared project' });
  }
});

router.use(authenticateToken);

// ─── Helpers ──────────────────────────────────────────────────────────────

function ownProject(userId, id) {
  // Same-shape helper used across endpoints — a missing or foreign
  // project resolves to null so the caller can 404 uniformly.
  return prisma.project.findFirst({
    where: { id, userId },
    select: { id: true, userId: true, name: true },
  });
}

function validationFail(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return true;
  }
  return false;
}

// ─── GET / — list ─────────────────────────────────────────────────────────

router.get(
  '/',
  [
    query('search').optional().isString(),
    query('sort').optional().isIn(['activity', 'edited', 'created']),
  ],
  async (req, res) => {
    try {
      if (validationFail(req, res)) return;
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      const sort = req.query.sort || 'activity';

      const orderBy =
        sort === 'created' ? { createdAt: 'desc' } :
        sort === 'edited'  ? { updatedAt: 'desc' } :
                             { updatedAt: 'desc' }; // 'activity' — most-recently-touched

      const where = { userId: req.user.id };
      if (search) {
        where.OR = [
          { name: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
        ];
      }

      const projects = await prisma.project.findMany({
        where,
        orderBy,
        select: {
          id: true, name: true, description: true, instructions: true,
          isStarred: true, shareId: true, createdAt: true, updatedAt: true,
          _count: { select: { files: true, chats: true } },
        },
      });

      res.json({
        projects: projects.map(p => ({
          ...p,
          fileCount: p._count.files,
          chatCount: p._count.chats,
          _count: undefined,
        })),
      });
    } catch (err) {
      console.error('[projects] list error:', err);
      res.status(500).json({ error: 'Failed to list projects' });
    }
  }
);

// ─── POST / — create ──────────────────────────────────────────────────────

router.post(
  '/',
  [
    body('name').trim().isLength({ min: 1, max: 120 }),
    body('description').optional().isString().isLength({ max: 4000 }),
    body('instructions').optional().isString().isLength({ max: 16000 }),
  ],
  async (req, res) => {
    try {
      if (validationFail(req, res)) return;
      const { name, description, instructions } = req.body;

      const project = await prisma.project.create({
        data: {
          userId: req.user.id,
          name: name.trim(),
          description: description?.trim() || null,
          instructions: instructions?.trim() || null,
        },
      });
      res.status(201).json({ project });
    } catch (err) {
      console.error('[projects] create error:', err);
      res.status(500).json({ error: 'Failed to create project' });
    }
  }
);

// ─── GET /:id — detail ────────────────────────────────────────────────────

router.get('/:id', param('id').isString(), async (req, res) => {
  try {
    if (validationFail(req, res)) return;
    const project = await prisma.project.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      include: {
        files: {
          select: {
            id: true, filename: true, originalName: true,
            mimeType: true, size: true, createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
        chats: {
          select: { id: true, title: true, model: true, createdAt: true, updatedAt: true },
          orderBy: { updatedAt: 'desc' },
          take: 50, // cap payload size; project pages rarely need every chat
        },
      },
    });
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({ project });
  } catch (err) {
    console.error('[projects] get error:', err);
    res.status(500).json({ error: 'Failed to fetch project' });
  }
});

// ─── GET /:id/context — Claude-style project manifest ─────────────────────

router.get('/:id/context', param('id').isString(), async (req, res) => {
  try {
    if (validationFail(req, res)) return;
    const project = await prisma.project.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      include: {
        files: {
          select: {
            id: true,
            originalName: true,
            mimeType: true,
            size: true,
            extractedText: true,
            createdAt: true,
          },
        },
        _count: { select: { files: true, chats: true, memories: true, documents: true } },
      },
    });
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({ context: buildProjectContextManifest(project) });
  } catch (err) {
    console.error('[projects] context error:', err);
    res.status(500).json({ error: 'Failed to build project context' });
  }
});

// ─── GET /:id/chats — isolated project chat search/list ───────────────────

router.get(
  '/:id/chats',
  [
    param('id').isString(),
    query('search').optional().isString(),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  async (req, res) => {
    try {
      if (validationFail(req, res)) return;
      const owned = await ownProject(req.user.id, req.params.id);
      if (!owned) return res.status(404).json({ error: 'Project not found' });

      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      const limit = parsePositiveInt(req.query.limit, 25, { min: 1, max: 100 });
      const where = buildChatListWhere({
        userId: req.user.id,
        projectId: owned.id,
        search,
      });

      const chats = await prisma.chat.findMany({
        where,
        select: {
          id: true,
          title: true,
          model: true,
          createdAt: true,
          updatedAt: true,
          messages: {
            where: search
              ? { content: { contains: search, mode: 'insensitive' } }
              : undefined,
            select: { role: true, content: true, timestamp: true },
            orderBy: { timestamp: search ? 'asc' : 'desc' },
            take: 1,
          },
          _count: { select: { messages: true } },
        },
        orderBy: { updatedAt: 'desc' },
        take: limit,
      });

      res.json({
        chats: chats.map(chat => {
          const match = chat.messages[0] || null;
          return {
            id: chat.id,
            title: chat.title,
            model: chat.model,
            createdAt: chat.createdAt,
            updatedAt: chat.updatedAt,
            messageCount: chat._count.messages,
            snippet: match ? String(match.content || '').slice(0, 260) : '',
            snippetRole: match ? match.role : null,
          };
        }),
      });
    } catch (err) {
      console.error('[projects] chat-search error:', err);
      res.status(500).json({ error: 'Failed to list project chats' });
    }
  }
);

// ─── PUT /:id — update ────────────────────────────────────────────────────

router.put(
  '/:id',
  [
    param('id').isString(),
    body('name').optional().isString().trim().isLength({ min: 1, max: 120 }),
    body('description').optional({ nullable: true }).isString().isLength({ max: 4000 }),
    body('instructions').optional({ nullable: true }).isString().isLength({ max: 16000 }),
    body('isStarred').optional().isBoolean(),
  ],
  async (req, res) => {
    try {
      if (validationFail(req, res)) return;
      const owned = await ownProject(req.user.id, req.params.id);
      if (!owned) return res.status(404).json({ error: 'Project not found' });

      const data = {};
      if (typeof req.body.name === 'string') data.name = req.body.name.trim();
      if ('description' in req.body) data.description = req.body.description?.trim() || null;
      if ('instructions' in req.body) data.instructions = req.body.instructions?.trim() || null;
      if (typeof req.body.isStarred === 'boolean') data.isStarred = req.body.isStarred;

      const project = await prisma.project.update({
        where: { id: req.params.id },
        data,
      });
      res.json({ project });
    } catch (err) {
      console.error('[projects] update error:', err);
      res.status(500).json({ error: 'Failed to update project' });
    }
  }
);

// ─── DELETE /:id ─────────────────────────────────────────────────────────

router.delete('/:id', param('id').isString(), async (req, res) => {
  try {
    if (validationFail(req, res)) return;
    const owned = await ownProject(req.user.id, req.params.id);
    if (!owned) return res.status(404).json({ error: 'Project not found' });

    // Cascading behaviour is schema-defined:
    //   - chats.projectId → SetNull (chat survives, just loses project context)
    //   - files.projectId → SetNull (file survives)
    // So a deleted project doesn't vaporise the user's chats or
    // documents — they only lose their project association.
    await prisma.project.delete({ where: { id: req.params.id } });
    res.json({ deleted: true });
  } catch (err) {
    console.error('[projects] delete error:', err);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

// ─── POST /:id/chat — start new chat within this project ─────────────────

router.post(
  '/:id/chat',
  [
    param('id').isString(),
    body('title').optional().isString().isLength({ min: 1, max: 120 }),
    body('model').optional().isString(),
  ],
  async (req, res) => {
    try {
      if (validationFail(req, res)) return;
      const owned = await ownProject(req.user.id, req.params.id);
      if (!owned) return res.status(404).json({ error: 'Project not found' });

      const chat = await prisma.chat.create({
        data: {
          userId: req.user.id,
          projectId: owned.id,
          title: (req.body.title || `Chat in ${owned.name}`).slice(0, 120),
          model: req.body.model || 'gpt-4o',
        },
        include: { messages: true },
      });
      res.status(201).json({ chat });
    } catch (err) {
      console.error('[projects] start-chat error:', err);
      res.status(500).json({ error: 'Failed to start chat in project' });
    }
  }
);

// ─── POST /:id/files/:fileId — attach ────────────────────────────────────

router.post(
  '/:id/files/:fileId',
  [param('id').isString(), param('fileId').isString()],
  async (req, res) => {
    try {
      if (validationFail(req, res)) return;
      const owned = await ownProject(req.user.id, req.params.id);
      if (!owned) return res.status(404).json({ error: 'Project not found' });

      // The file must belong to the current user — cross-user attach
      // would let someone paste another account's documents into their
      // own project.
      const file = await prisma.file.findFirst({
        where: { id: req.params.fileId, userId: req.user.id },
        select: { id: true, projectId: true },
      });
      if (!file) return res.status(404).json({ error: 'File not found' });

      // Idempotent: re-attaching a file that's already on this project
      // is a no-op, not an error.
      if (file.projectId === owned.id) {
        return res.json({ attached: true, alreadyAttached: true });
      }

      await prisma.file.update({
        where: { id: req.params.fileId },
        data: { projectId: owned.id },
      });
      res.json({ attached: true });
    } catch (err) {
      console.error('[projects] attach-file error:', err);
      res.status(500).json({ error: 'Failed to attach file' });
    }
  }
);

// ─── DELETE /:id/files/:fileId — detach ──────────────────────────────────

router.delete(
  '/:id/files/:fileId',
  [param('id').isString(), param('fileId').isString()],
  async (req, res) => {
    try {
      if (validationFail(req, res)) return;
      const owned = await ownProject(req.user.id, req.params.id);
      if (!owned) return res.status(404).json({ error: 'Project not found' });

      const file = await prisma.file.findFirst({
        where: { id: req.params.fileId, userId: req.user.id, projectId: owned.id },
        select: { id: true },
      });
      if (!file) return res.status(404).json({ error: 'File not attached to this project' });

      await prisma.file.update({
        where: { id: req.params.fileId },
        data: { projectId: null },
      });
      res.json({ detached: true });
    } catch (err) {
      console.error('[projects] detach-file error:', err);
      res.status(500).json({ error: 'Failed to detach file' });
    }
  }
);

// ─── Memory ───────────────────────────────────────────────────────────────

router.get('/:id/memory', param('id').isString(), async (req, res) => {
  try {
    if (validationFail(req, res)) return;
    const owned = await ownProject(req.user.id, req.params.id);
    if (!owned) return res.status(404).json({ error: 'Project not found' });
    const memories = await projectMemory.listMemory(owned.id);
    res.json({ memories });
  } catch (err) {
    console.error('[projects] memory-list error:', err);
    res.status(500).json({ error: 'Failed to list memory' });
  }
});

router.delete(
  '/:id/memory/:factId',
  [param('id').isString(), param('factId').isString()],
  async (req, res) => {
    try {
      if (validationFail(req, res)) return;
      const out = await projectMemory.deleteMemory({
        userId: req.user.id,
        projectId: req.params.id,
        factId: req.params.factId,
      });
      if (!out.ok) return res.status(404).json({ error: out.reason });
      res.json({ deleted: true });
    } catch (err) {
      console.error('[projects] memory-delete error:', err);
      res.status(500).json({ error: 'Failed to delete memory' });
    }
  }
);

// ─── Sharing (enable / revoke) ────────────────────────────────────────────
//
// We use a URL-friendly 24-char hex token rather than reusing the id
// so revoking a share link and re-enabling it yields a NEW URL (the
// old one becomes permanently dead, which is the correct security
// behaviour — a leaked URL must stay leaked rather than silently
// resuming access if the owner re-shares later).

router.post('/:id/share', param('id').isString(), async (req, res) => {
  try {
    if (validationFail(req, res)) return;
    const owned = await ownProject(req.user.id, req.params.id);
    if (!owned) return res.status(404).json({ error: 'Project not found' });
    const shareId = crypto.randomBytes(12).toString('hex');
    const updated = await prisma.project.update({
      where: { id: owned.id },
      data: { shareId },
      select: { shareId: true },
    });
    res.json({ shareId: updated.shareId, url: `/projects/share/${updated.shareId}` });
  } catch (err) {
    console.error('[projects] share-enable error:', err);
    res.status(500).json({ error: 'Failed to enable sharing' });
  }
});

router.delete('/:id/share', param('id').isString(), async (req, res) => {
  try {
    if (validationFail(req, res)) return;
    const owned = await ownProject(req.user.id, req.params.id);
    if (!owned) return res.status(404).json({ error: 'Project not found' });
    await prisma.project.update({
      where: { id: owned.id },
      data: { shareId: null },
    });
    res.json({ revoked: true });
  } catch (err) {
    console.error('[projects] share-revoke error:', err);
    res.status(500).json({ error: 'Failed to revoke sharing' });
  }
});

module.exports = router;

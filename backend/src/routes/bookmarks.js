// Bookmarks / favourites for individual chat messages.
//
//   POST   /api/bookmarks          { messageId, note?, folder? }
//   GET    /api/bookmarks?folder=… → { items: [...] }
//   PUT    /api/bookmarks/:id      { folder?, note? }
//   DELETE /api/bookmarks/:id
//
// All routes scope to the authenticated user. The POST handler
// double-checks the message belongs to a chat the user owns (and is
// not soft-deleted) before creating the bookmark — no cross-user
// stars.
//
// UI surface is intentionally deferred per CLAUDE rule #1 (no UI
// modifications without explicit ask); the endpoints are designed to
// be wired by the search panel / message rail when the UI work
// happens.

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');

const router = express.Router();

router.post('/', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const messageId = typeof req.body?.messageId === 'string' ? req.body.messageId : '';
  const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 2000) : null;
  const folder = typeof req.body?.folder === 'string'
    ? req.body.folder.trim().slice(0, 120) || null
    : null;
  if (!messageId) return res.status(400).json({ error: 'messageId is required' });

  try {
    // Verify the message exists, is not soft-deleted, and belongs to
    // a chat owned by the caller.
    const message = await prisma.message.findFirst({
      where: {
        id: messageId,
        deletedAt: null,
        chat: { userId, deletedAt: null },
      },
      select: { id: true },
    });
    if (!message) return res.status(404).json({ error: 'message not found' });

    // upsert pattern so a double-tap reuses the existing row instead
    // of throwing on the unique (userId, messageId) constraint.
    const row = await prisma.bookmark.upsert({
      where: { userId_messageId: { userId, messageId } },
      // Only overwrite note/folder when the caller supplied them so a
      // double-star call doesn't wipe an existing folder assignment.
      update: {
        note: note ?? undefined,
        folder: folder ?? undefined,
      },
      create: {
        userId,
        messageId,
        note: note ?? undefined,
        folder: folder ?? undefined,
      },
    });
    res.status(201).json(row);
  } catch (err) {
    console.error('[bookmarks] create failed:', err.message);
    res.status(500).json({ error: 'failed to create bookmark' });
  }
});

router.get('/', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

  // Folder filter:
  //   ?folder=Prompts   → only rows where folder = 'Prompts'
  //   ?folder=          → omitted, returns everything
  //   ?folder=__none__  → only rows with NULL folder (uncategorised)
  // The sentinel keeps the contract URL-safe — a literal NULL would
  // collide with "no filter".
  const where = { userId };
  if (typeof req.query.folder === 'string') {
    const raw = req.query.folder.trim();
    if (raw === '__none__') where.folder = null;
    else if (raw.length > 0) where.folder = raw.slice(0, 120);
  }

  try {
    const rows = await prisma.bookmark.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        message: {
          select: {
            id: true, chatId: true, role: true, content: true, timestamp: true,
            chat: { select: { id: true, title: true } },
          },
        },
      },
    });
    const items = rows.map((b) => ({
      id: b.id,
      note: b.note,
      folder: b.folder ?? null,
      createdAt: b.createdAt instanceof Date ? b.createdAt.toISOString() : b.createdAt,
      message: b.message
        ? {
            id: b.message.id,
            chatId: b.message.chatId,
            chatTitle: b.message.chat?.title || '',
            role: b.message.role,
            preview: (b.message.content || '').slice(0, 240),
            timestamp:
              b.message.timestamp instanceof Date
                ? b.message.timestamp.toISOString()
                : b.message.timestamp,
          }
        : null,
    }));
    res.json({ items });
  } catch (err) {
    console.error('[bookmarks] list failed:', err.message);
    res.status(500).json({ error: 'failed to list bookmarks' });
  }
});

// PUT /api/bookmarks/:id — partial update of mutable bookmark fields.
// Today that's `folder` (move into / out of a folder) and `note`
// (rename / clarify). The set of touched columns is explicit so a
// payload omitting a key never clobbers it. To clear a folder, send
// `folder: null` or an empty string.
router.put('/:id', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const id = req.params.id;

  const data = {};
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'folder')) {
    const raw = req.body.folder;
    if (raw === null) {
      data.folder = null;
    } else if (typeof raw === 'string') {
      const trimmed = raw.trim().slice(0, 120);
      data.folder = trimmed.length === 0 ? null : trimmed;
    } else {
      return res.status(400).json({ error: 'folder must be a string or null' });
    }
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'note')) {
    const raw = req.body.note;
    if (raw === null) {
      data.note = null;
    } else if (typeof raw === 'string') {
      data.note = raw.slice(0, 2000);
    } else {
      return res.status(400).json({ error: 'note must be a string or null' });
    }
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: 'no updatable fields supplied' });
  }

  try {
    const existing = await prisma.bookmark.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) {
      return res.status(404).json({ error: 'not found' });
    }
    const row = await prisma.bookmark.update({ where: { id }, data });
    res.json({
      id: row.id,
      note: row.note,
      folder: row.folder ?? null,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    });
  } catch (err) {
    console.error('[bookmarks] update failed:', err.message);
    res.status(500).json({ error: 'failed to update bookmark' });
  }
});

router.delete('/:id', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const id = req.params.id;
  try {
    const existing = await prisma.bookmark.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) {
      return res.status(404).json({ error: 'not found' });
    }
    await prisma.bookmark.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[bookmarks] delete failed:', err.message);
    res.status(500).json({ error: 'failed to delete bookmark' });
  }
});

module.exports = router;

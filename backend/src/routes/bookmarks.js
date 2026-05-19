// Bookmarks / favourites for individual chat messages.
//
//   POST   /api/bookmarks          { messageId, note? }
//   GET    /api/bookmarks          → { items: [...] }
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
      update: { note: note ?? undefined },
      create: { userId, messageId, note: note ?? undefined },
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
  try {
    const rows = await prisma.bookmark.findMany({
      where: { userId },
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

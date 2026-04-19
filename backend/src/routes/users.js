const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const bcrypt = require('bcryptjs');

const router = express.Router();

// Get current user profile
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        name: true,
        email: true,
        avatar: true,
        plan: true,
        isAdmin: true,
        apiUsage: true,
        monthlyLimit: true,
        createdAt: true,
        updatedAt: true
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Update user profile
router.put('/profile', [
  body('name').optional().trim().isLength({ min: 2 }).withMessage('Name must be at least 2 characters'),
  body('email').optional().isEmail().normalizeEmail().withMessage('Valid email required'),
  // Accept data URLs (client-encoded avatar) or remote URLs up to ~2MB
  // base64. Rejects anything non-string to keep the Prisma update safe.
  body('avatar').optional().isString().isLength({ max: 3_000_000 }),
], authenticateToken, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email, avatar } = req.body;
    const updateData = {};

    if (name) updateData.name = name;
    if (typeof avatar === 'string') updateData.avatar = avatar;
    if (email) {
      // Check if email is already taken by another user
      const existingUser = await prisma.user.findFirst({
        where: {
          email,
          NOT: { id: req.user.id }
        }
      });

      if (existingUser) {
        return res.status(400).json({ error: 'Email already in use' });
      }

      updateData.email = email;
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: updateData,
      select: {
        id: true,
        name: true,
        email: true,
        avatar: true,
        plan: true,
        isAdmin: true,
        apiUsage: true,
        monthlyLimit: true,
        createdAt: true,
        updatedAt: true
      }
    });

    res.json({ user });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Change password
router.put('/password', [
  body('currentPassword').notEmpty().withMessage('Current password required'),
  body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters')
], authenticateToken, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { currentPassword, newPassword } = req.body;

    // Get user with password
    const user = await prisma.user.findUnique({
      where: { id: req.user.id }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify current password
    const isValidPassword = await bcrypt.compare(currentPassword, user.password);
    if (!isValidPassword) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 12);

    // Update password
    await prisma.user.update({
      where: { id: req.user.id },
      data: { password: hashedPassword }
    });

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// Get user usage stats
router.get('/usage', authenticateToken, async (req, res) => {
  try {
    const { period = '30' } = req.query;
    const days = parseInt(period);
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [apiUsage, totalCost, messageCount] = await Promise.all([
      prisma.apiUsage.findMany({
        where: {
          userId: req.user.id,
          timestamp: { gte: startDate }
        },
        orderBy: { timestamp: 'desc' }
      }),
      prisma.apiUsage.aggregate({
        where: {
          userId: req.user.id,
          timestamp: { gte: startDate }
        },
        _sum: { cost: true }
      }),
      prisma.message.count({
        where: {
          chat: { userId: req.user.id },
          timestamp: { gte: startDate }
        }
      })
    ]);

    // Group usage by day
    const usageByDay = apiUsage.reduce((acc, usage) => {
      const day = usage.timestamp.toISOString().slice(0, 10);
      if (!acc[day]) {
        acc[day] = { tokens: 0, cost: 0, calls: 0 };
      }
      acc[day].tokens += usage.tokens;
      acc[day].cost += usage.cost;
      acc[day].calls += 1;
      return acc;
    }, {});

    // Group usage by model
    const usageByModel = apiUsage.reduce((acc, usage) => {
      if (!acc[usage.model]) {
        acc[usage.model] = { tokens: 0, cost: 0, calls: 0 };
      }
      acc[usage.model].tokens += usage.tokens;
      acc[usage.model].cost += usage.cost;
      acc[usage.model].calls += 1;
      return acc;
    }, {});

    res.json({
      summary: {
        totalTokens: apiUsage.reduce((sum, usage) => sum + usage.tokens, 0),
        totalCost: totalCost._sum.cost || 0,
        totalCalls: apiUsage.length,
        messageCount,
        currentUsage: req.user.apiUsage,
        monthlyLimit: req.user.monthlyLimit,
        usagePercentage: (req.user.apiUsage / req.user.monthlyLimit) * 100
      },
      usageByDay,
      usageByModel,
      recentUsage: apiUsage.slice(0, 10)
    });
  } catch (error) {
    console.error('Get usage error:', error);
    res.status(500).json({ error: 'Failed to fetch usage stats' });
  }
});

// Delete user account
router.delete('/account', authenticateToken, async (req, res) => {
  try {
    // Delete user and all related data (cascading deletes handled by Prisma)
    await prisma.user.delete({
      where: { id: req.user.id }
    });

    res.json({ message: 'Account deleted successfully' });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// ────────────────────────────────────────────────────────────
// User settings — stored as a single flexible JSON blob on the
// User row. GET returns the current tree; PUT merges the request
// body into the existing tree (so a client can send just one
// section instead of the full state). Locale/tone/customInstructions
// live in their own columns for query-side use and are mirrored
// here when present so the UI has a single source to render.
// ────────────────────────────────────────────────────────────
router.get('/settings', authenticateToken, async (req, res) => {
  try {
    const u = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { settings: true, locale: true, preferredTone: true, customInstructions: true, name: true, avatar: true, plan: true },
    });
    if (!u) return res.status(404).json({ error: 'User not found' });
    const settings = (u.settings && typeof u.settings === 'object') ? u.settings : {};
    // Mirror top-level personalization columns into the response so
    // the client renders from one merged object.
    res.json({
      settings: {
        ...settings,
        locale: u.locale ?? settings.locale ?? null,
        preferredTone: u.preferredTone ?? settings.preferredTone ?? null,
        customInstructions: u.customInstructions ?? settings.customInstructions ?? null,
      },
      user: { name: u.name, avatar: u.avatar, plan: u.plan },
    });
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

router.put('/settings', authenticateToken, async (req, res) => {
  try {
    const patch = req.body && typeof req.body === 'object' ? req.body : {};
    const current = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { settings: true },
    });
    const merged = deepMerge(
      (current?.settings && typeof current.settings === 'object') ? current.settings : {},
      patch,
    );

    // Promote three well-known keys to their typed columns so the chat
    // pipeline can pick them up without parsing JSON.
    const scalarUpdates = {};
    if (typeof patch.locale === 'string' || patch.locale === null) scalarUpdates.locale = patch.locale;
    if (typeof patch.preferredTone === 'string' || patch.preferredTone === null) scalarUpdates.preferredTone = patch.preferredTone;
    if (typeof patch.customInstructions === 'string' || patch.customInstructions === null) scalarUpdates.customInstructions = patch.customInstructions;

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: { settings: merged, ...scalarUpdates },
      select: { settings: true, locale: true, preferredTone: true, customInstructions: true },
    });

    res.json({
      settings: {
        ...(updated.settings && typeof updated.settings === 'object' ? updated.settings : {}),
        locale: updated.locale,
        preferredTone: updated.preferredTone,
        customInstructions: updated.customInstructions,
      },
    });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ────────────────────────────────────────────────────────────
// Sessions — trusted-device list for Settings → Security.
// Includes the current session with a flag so the UI can show
// "This device" + "Other devices" and wire logout-all.
// ────────────────────────────────────────────────────────────
router.get('/sessions', authenticateToken, async (req, res) => {
  try {
    const sessions = await prisma.session.findMany({
      where: { userId: req.user.id, expiresAt: { gt: new Date() } },
      select: { id: true, token: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
    });
    // Get the current token off the Authorization header so we can
    // mark "this device" vs "other devices".
    const currentToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const out = sessions.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      current: s.token === currentToken,
    }));
    res.json({ sessions: out, total: out.length });
  } catch (error) {
    console.error('Get sessions error:', error);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

router.post('/sessions/revoke-others', authenticateToken, async (req, res) => {
  try {
    const currentToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const result = await prisma.session.deleteMany({
      where: { userId: req.user.id, NOT: { token: currentToken } },
    });
    res.json({ revoked: result.count });
  } catch (error) {
    console.error('Revoke sessions error:', error);
    res.status(500).json({ error: 'Failed to revoke sessions' });
  }
});

// ────────────────────────────────────────────────────────────
// Chat lifecycle stats — used by Settings → Data controls to
// display counters for archived / deleted chats and by the
// "Archivar todos los chats" action.
// ────────────────────────────────────────────────────────────
router.get('/chat-stats', authenticateToken, async (req, res) => {
  try {
    const [total, archived, deleted, shared] = await Promise.all([
      prisma.chat.count({ where: { userId: req.user.id, isArchived: false, deletedAt: null } }),
      prisma.chat.count({ where: { userId: req.user.id, isArchived: true, deletedAt: null } }),
      prisma.chat.count({ where: { userId: req.user.id, deletedAt: { not: null } } }),
      prisma.chat.count({ where: { userId: req.user.id, isShared: true } }),
    ]);
    res.json({ total, archived, deleted, shared });
  } catch (error) {
    console.error('Chat stats error:', error);
    res.status(500).json({ error: 'Failed to fetch chat stats' });
  }
});

router.post('/chats/archive-all', authenticateToken, async (req, res) => {
  try {
    const result = await prisma.chat.updateMany({
      where: { userId: req.user.id, isArchived: false, deletedAt: null },
      data: { isArchived: true },
    });
    res.json({ archived: result.count });
  } catch (error) {
    console.error('Archive all error:', error);
    res.status(500).json({ error: 'Failed to archive chats' });
  }
});

router.post('/chats/clear-history', authenticateToken, async (req, res) => {
  try {
    const now = new Date();
    const result = await prisma.chat.updateMany({
      where: { userId: req.user.id, deletedAt: null },
      data: { deletedAt: now },
    });
    res.json({ deleted: result.count });
  } catch (error) {
    console.error('Clear history error:', error);
    res.status(500).json({ error: 'Failed to clear history' });
  }
});

// ────────────────────────────────────────────────────────────
// Data export — returns the user's data as a downloadable JSON
// blob. Kept intentionally readable (not ZIP) so users can
// inspect the export before unpacking tooling gets involved.
// ────────────────────────────────────────────────────────────
router.get('/data-export', authenticateToken, async (req, res) => {
  try {
    const [user, chats, files] = await Promise.all([
      prisma.user.findUnique({
        where: { id: req.user.id },
        select: {
          id: true, email: true, name: true, avatar: true, plan: true,
          locale: true, preferredTone: true, customInstructions: true,
          settings: true, createdAt: true, updatedAt: true,
        },
      }),
      prisma.chat.findMany({
        where: { userId: req.user.id },
        select: {
          id: true, title: true, model: true, createdAt: true, updatedAt: true,
          isArchived: true, deletedAt: true,
          messages: { select: { role: true, content: true, timestamp: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.file.findMany({
        where: { userId: req.user.id },
        select: { id: true, filename: true, originalName: true, mimeType: true, size: true, createdAt: true },
      }),
    ]);
    const payload = {
      exportedAt: new Date().toISOString(),
      version: 1,
      user,
      chats,
      files,
      stats: { chatCount: chats.length, fileCount: files.length, messageCount: chats.reduce((a, c) => a + (c.messages?.length || 0), 0) },
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="siraGPT-export-${Date.now()}.json"`);
    res.send(JSON.stringify(payload, null, 2));
  } catch (error) {
    console.error('Data export error:', error);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

/**
 * Recursive deep-merge — arrays are replaced (not concatenated), plain
 * objects are merged key-by-key, everything else is assigned. Avoids
 * pulling in a lodash dep for this single use.
 */
function deepMerge(target, source) {
  if (source == null) return target;
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  if (!isObj(target) || !isObj(source)) return source;
  const out = { ...target };
  for (const k of Object.keys(source)) {
    const sv = source[k];
    const tv = target[k];
    if (isObj(sv) && isObj(tv)) out[k] = deepMerge(tv, sv);
    else out[k] = sv;
  }
  return out;
}

module.exports = router;
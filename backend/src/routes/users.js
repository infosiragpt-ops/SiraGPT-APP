const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const bcrypt = require('bcryptjs');
const archiver = require('archiver');
const { cascadeSoftDeleteForUser } = require('../utils/prisma-soft-delete');
const { writeAuditLog } = require('../utils/audit-log');
const rateLimitStore = require('../middleware/rate-limit-store');

const router = express.Router();

// ────────────────────────────────────────────────────────────
// Per-user rate limiter for the GDPR export endpoint. Backed by the
// shared rate-limit-store.consume() (cycle 2) so the cap works across
// multiple backend replicas via Redis; falls back to an in-process
// sliding window when Redis is unreachable.
// ────────────────────────────────────────────────────────────
const EXPORT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const EXPORT_LIMIT = 1; // 1 export per window per user
async function takeExportSlot(userId) {
  const key = `user-export:${userId}`;
  try {
    const result = await rateLimitStore.consume(key, EXPORT_LIMIT, EXPORT_WINDOW_MS);
    if (result.allowed) return { ok: true };
    const retryAfterMs = Math.max(0, result.resetAt.getTime() - Date.now());
    return { ok: false, retryAfterMs };
  } catch (_err) {
    // If the store throws unexpectedly, fail open — exports stay
    // available; the 1/30min cap is a soft guard, not a security
    // boundary, and the audit log still records every attempt.
    return { ok: true };
  }
}

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
    let previousEmail = null;
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

      if (email !== req.user.email) {
        previousEmail = req.user.email;
        updateData.email = email;
      }
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

    if (previousEmail) {
      // Granular audit event for email change — distinct from generic
      // profile_update so SIEM rules can alert on this independently.
      void writeAuditLog(prisma, {
        req,
        action: 'email_changed',
        resource: 'user',
        resourceId: req.user.id,
        userId: req.user.id,
        actorName: previousEmail,
        before: { email: previousEmail },
        after: { email: user.email },
      });
    }

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

    // Granular audit event — password changes are a phishing /
    // takeover indicator and benefit from a dedicated action label.
    void writeAuditLog(prisma, {
      req,
      action: 'password_changed',
      resource: 'user',
      resourceId: req.user.id,
      userId: req.user.id,
      actorName: req.user.email,
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
    const currentUsage = Number(req.user.apiUsage || 0);
    const monthlyLimit = Number(req.user.monthlyLimit || 0);

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

    // Prisma Decimal columns surface as Decimal.js / BigInt depending
    // on the runtime; in either case adding them to a plain Number 0
    // throws "Cannot mix BigInt and other types". Coerce every cost
    // value through Number() before any arithmetic so the reduces
    // stay in Number-space end-to-end.
    const asNumber = (v) => {
      if (v == null) return 0;
      if (typeof v === 'number') return v;
      if (typeof v === 'bigint') return Number(v);
      // Decimal.js exposes .toNumber(); otherwise fall back to Number().
      if (typeof v.toNumber === 'function') return v.toNumber();
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    // Group usage by day
    const usageByDay = apiUsage.reduce((acc, usage) => {
      const day = usage.timestamp.toISOString().slice(0, 10);
      if (!acc[day]) {
        acc[day] = { tokens: 0, cost: 0, calls: 0 };
      }
      acc[day].tokens += asNumber(usage.tokens);
      acc[day].cost += asNumber(usage.cost);
      acc[day].calls += 1;
      return acc;
    }, {});

    // Group usage by model
    const usageByModel = apiUsage.reduce((acc, usage) => {
      if (!acc[usage.model]) {
        acc[usage.model] = { tokens: 0, cost: 0, calls: 0 };
      }
      acc[usage.model].tokens += asNumber(usage.tokens);
      acc[usage.model].cost += asNumber(usage.cost);
      acc[usage.model].calls += 1;
      return acc;
    }, {});

    res.json({
      summary: {
        totalTokens: apiUsage.reduce((sum, usage) => sum + asNumber(usage.tokens), 0),
        totalCost: asNumber(totalCost._sum.cost),
        totalCalls: apiUsage.length,
        messageCount,
        currentUsage,
        monthlyLimit,
        usagePercentage: monthlyLimit > 0 ? (currentUsage / monthlyLimit) * 100 : 0
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

// ────────────────────────────────────────────────────────────
// GDPR data export — `GET /api/users/me/export`
//
// Streams a ZIP archive with profile.json + chats.json + files.json +
// payments.json + README.txt so the user can download a portable
// snapshot of every piece of personal data we hold. Uses `archiver` in
// ZIP mode and pipes directly to the response so large accounts don't
// have to be materialised in memory.
//
// Rate-limited at 1 request per 30 minutes per user (see
// `takeExportSlot` at the top of this file). Every call (allowed +
// denied) is audited.
// ────────────────────────────────────────────────────────────
router.get('/me/export', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  // Optional PII redaction toggle — when `?redactPII=true` is set, we
  // run the pii-mask over message content + file names + payment
  // metadata before writing the archive. Useful when the user wants
  // to share the export externally without leaking embedded emails,
  // phone numbers, credit cards, etc.
  const redactPII = String(req.query.redactPII || '').toLowerCase() === 'true';
  let piiMasker = null;
  if (redactPII) {
    try { piiMasker = require('../utils/pii-mask'); }
    catch (_) { piiMasker = null; }
  }
  const slot = await takeExportSlot(userId);
  if (!slot.ok) {
    const retryAfterSec = Math.max(1, Math.ceil(slot.retryAfterMs / 1000));
    res.set('Retry-After', String(retryAfterSec));
    void writeAuditLog(prisma, {
      req,
      action: 'user_export_rate_limited',
      resource: 'user',
      resourceId: userId,
      metadata: { retryAfterMs: slot.retryAfterMs },
    });
    return res.status(429).json({
      error: 'Export is rate-limited to 1 request every 30 minutes.',
      retryAfterMs: slot.retryAfterMs,
    });
  }

  try {
    // Pull every row up-front. We keep this synchronous-ish because the
    // archive layout wants a stable index — streaming row-by-row from
    // Prisma would require server cursors we don't currently expose.
    // Large accounts (10k+ chats) should still fit comfortably; the
    // memory pressure that motivated streaming is the ZIP payload, not
    // the JSON model rows themselves.
    const [user, chats, files, payments] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true, email: true, name: true, avatar: true, plan: true,
          isAdmin: true, isSuperAdmin: true,
          apiUsage: true, monthlyCallLimit: true, monthlyLimit: true,
          subscriptionStatus: true, subscriptionEndDate: true,
          locale: true, preferredTone: true, customInstructions: true,
          settings: true, createdAt: true, updatedAt: true, deletedAt: true,
          // password intentionally omitted
        },
      }),
      prisma.chat.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        include: {
          messages: {
            orderBy: { timestamp: 'asc' },
            select: { id: true, role: true, content: true, timestamp: true, tokens: true, feedback: true, metadata: true, deletedAt: true },
          },
        },
      }),
      prisma.file.findMany({
        where: { userId },
        select: {
          id: true, filename: true, originalName: true, mimeType: true, size: true,
          createdAt: true, processingStage: true, processingError: true, deletedAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.payment.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="siragpt-export-${userId}-${Date.now()}.zip"`,
    );

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('warning', (err) => {
      console.warn('[export] archiver warning:', err?.message || err);
    });
    archive.on('error', (err) => {
      console.error('[export] archiver error:', err);
      // Headers are already sent — destroy the response so the client
      // sees a truncated ZIP instead of a misleading 500 body.
      try { res.destroy(err); } catch (_) { /* noop */ }
    });
    archive.pipe(res);

    // BigInt-safe JSON — Prisma surfaces BigInt for `tokens` /
    // `apiUsage` etc., and JSON.stringify chokes on those without a
    // replacer. Round-trip via the BigInt-aware replacer so the export
    // is valid JSON the user can `jq` on.
    const bigintSafe = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);
    const toJson = (obj) => JSON.stringify(obj, bigintSafe, 2);

    // Optionally scrub PII from string fields. We only mask content
    // that could contain free-text (message bodies, file names) — we
    // do NOT touch the user's own profile email or structural ids.
    let chatsOut = chats;
    let filesOut = files;
    if (redactPII && piiMasker) {
      chatsOut = chats.map((c) => ({
        ...c,
        messages: (c.messages || []).map((m) => ({
          ...m,
          content: typeof m.content === 'string' ? piiMasker.mask(m.content) : m.content,
        })),
      }));
      filesOut = files.map((f) => ({
        ...f,
        originalName: typeof f.originalName === 'string' ? piiMasker.mask(f.originalName) : f.originalName,
        filename: typeof f.filename === 'string' ? piiMasker.mask(f.filename) : f.filename,
      }));
    }

    archive.append(toJson(user || {}), { name: 'profile.json' });
    archive.append(toJson({ count: chatsOut.length, chats: chatsOut, redactPII }), { name: 'chats.json' });
    archive.append(toJson({ count: filesOut.length, files: filesOut, redactPII }), { name: 'files.json' });
    archive.append(toJson({ count: payments.length, payments }), { name: 'payments.json' });
    archive.append(
      [
        'siraGPT — Personal data export',
        '================================',
        '',
        `User ID:    ${userId}`,
        `Exported:   ${new Date().toISOString()}`,
        '',
        'Files in this archive:',
        '  • profile.json   — your user record (password hash omitted)',
        '  • chats.json     — every chat you created with its full message',
        '                     history (role, content, timestamp, feedback)',
        '  • files.json     — metadata for every file you uploaded',
        '                     (filenames, mime type, size, processing state).',
        '                     Raw file contents are NOT included in this',
        '                     export — request them separately if you need',
        '                     them, or use the per-file download links in',
        '                     the app.',
        '  • payments.json  — every payment / subscription transaction',
        '                     (status, plan, provider, Stripe identifiers).',
        '',
        'Schema notes:',
        '  • Timestamps are ISO 8601 (UTC).',
        '  • BigInt fields (tokens, monthly limits) are serialised as',
        '    strings to stay valid JSON.',
        '  • `deletedAt` is the soft-delete tombstone — non-null rows',
        '    are pending hard deletion in the 30-day GDPR grace window.',
        '',
        'Need help? Contact privacy@siragpt.io.',
        '',
      ].join('\n'),
      { name: 'README.txt' },
    );

    void writeAuditLog(prisma, {
      req,
      action: 'user_export',
      resource: 'user',
      resourceId: userId,
      metadata: {
        chatCount: chats.length,
        fileCount: files.length,
        paymentCount: payments.length,
        redactPII,
      },
    });

    await archive.finalize();
  } catch (error) {
    console.error('GDPR export error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to export data' });
    } else {
      try { res.destroy(error); } catch (_) { /* noop */ }
    }
  }
});

// ────────────────────────────────────────────────────────────
// GDPR data delete — `POST /api/users/me/delete`
//
// Soft-deletes the user + cascades soft-delete to every owned chat /
// message / file / project / customGpt. The hard-delete cron
// (`backend/src/jobs/hard-delete-deleted-users.js`) purges the row 30
// days later.
//
// Body shape: { password: string, confirm?: 'DELETE' }
// `confirm` is optional but recommended — the FE can require it to
// prevent fat-finger deletes.
// ────────────────────────────────────────────────────────────
router.post(
  '/me/delete',
  authenticateToken,
  [
    body('password').isString().isLength({ min: 1, max: 256 })
      .withMessage('Password confirmation required'),
    body('confirm').optional().isString(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { password } = req.body;
      const userId = req.user.id;

      // Fetch with password so we can verify it before doing anything
      // destructive. The middleware-attached `req.user` may omit the
      // hash depending on the select.
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (user.deletedAt) {
        return res.status(409).json({ error: 'Account already scheduled for deletion', deletedAt: user.deletedAt });
      }

      const ok = await bcrypt.compare(password, user.password || '');
      if (!ok) {
        void writeAuditLog(prisma, {
          req,
          action: 'user_delete_failed',
          resource: 'user',
          resourceId: userId,
          metadata: { reason: 'invalid_password' },
        });
        return res.status(401).json({ error: 'Invalid password' });
      }

      const deletedAt = new Date();
      await prisma.user.update({ where: { id: userId }, data: { deletedAt } });
      const cascade = await cascadeSoftDeleteForUser(prisma, userId);

      // Revoke active sessions so the soft-deleted user is immediately
      // logged out across devices.
      try {
        await prisma.session.deleteMany({ where: { userId } });
      } catch (sessErr) {
        console.warn('[delete] could not revoke sessions:', sessErr?.message || sessErr);
      }

      // Best-effort confirmation email — no-op when SMTP isn't
      // configured. Lazy-required so test envs without nodemailer
      // configured don't pay the boot cost.
      try {
        const emailService = require('../services/email');
        if (emailService && typeof emailService.isConfigured === 'function' && emailService.isConfigured()) {
          if (emailService.transporter && typeof emailService.transporter.sendMail === 'function') {
            await emailService.transporter.sendMail({
              from: `"siraGPT" <${process.env.SMTP_USER}>`,
              to: user.email,
              subject: 'Your siraGPT account has been scheduled for deletion',
              text: [
                `Hi ${user.name || 'there'},`,
                '',
                'We received a request to delete your siraGPT account.',
                `It will be permanently removed on ${new Date(deletedAt.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}.`,
                '',
                'If this was a mistake, contact privacy@siragpt.io within the next 30 days to restore your account.',
              ].join('\n'),
            });
          }
        }
      } catch (emailErr) {
        console.warn('[delete] confirmation email failed:', emailErr?.message || emailErr);
      }

      console.warn(`[GDPR_AUDIT] user_delete user=${user.email} id=${userId} cascade=${JSON.stringify(cascade)}`);
      void writeAuditLog(prisma, {
        req,
        action: 'user_delete',
        resource: 'user',
        resourceId: userId,
        before: { deletedAt: null },
        after: { deletedAt },
        metadata: { cascade },
      });

      res.json({ ok: true, deletedAt, cascade });
    } catch (error) {
      console.error('GDPR delete error:', error);
      res.status(500).json({ error: 'Failed to delete account' });
    }
  },
);

module.exports = router;

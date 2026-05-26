const express = require('express');
const { body, validationResult } = require('express-validator');
const crypto = require('crypto');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const bcrypt = require('bcryptjs');
const archiver = require('archiver');
const { cascadeSoftDeleteForUser } = require('../utils/prisma-soft-delete');
const { writeAuditLog } = require('../utils/audit-log');
const { parseUA } = require('../utils/session-info');
const rateLimitStore = require('../middleware/rate-limit-store');

// Hash the caller IP with a per-process salt so audit rows are
// linkable across events without storing the raw client address.
// Salt prefers `AUDIT_IP_HASH_SALT`; falls back to `JWT_SECRET` so
// production always has a non-empty salt. Truncated to 16 hex chars
// (64 bits) — enough entropy to correlate, too narrow to brute-force
// back to the original /32 without targeted intent.
function hashIpForAudit(ip) {
  if (!ip || typeof ip !== 'string') return null;
  const salt = process.env.AUDIT_IP_HASH_SALT || process.env.JWT_SECRET || 'siragpt-audit';
  return crypto
    .createHash('sha256')
    .update(`${salt}|${ip}`)
    .digest('hex')
    .slice(0, 16);
}
const {
  contentDispositionHeader,
  safeDownloadFilename,
} = require('../middleware/file-response-safety');

const router = express.Router();

// Task 21 — when bulk-revocation paths (revoke-others, account self-delete,
// admin-initiated session deletion) wipe rows out of the Session table,
// authenticateToken's Task 17 path doesn't fire because the deleted session
// never reaches the middleware. This helper takes the snapshot the caller
// captured *before* prisma.session.deleteMany() and, for any row whose
// token decodes as an `appshots:capture`-scoped JWT, fans a single
// `sendAppshotsDeviceAutoRevoked` email per session id with the supplied
// reason. Lazy-requires email + the appshots-token util so test envs that
// don't load nodemailer/jsonwebtoken still boot. Best-effort, never throws.
function _notifyAppshotsAutoRevoked(preDeleteRows, owner, reason) {
  try {
    if (!Array.isArray(preDeleteRows) || preDeleteRows.length === 0) return;
    if (!owner || !owner.email) return;
    const emailService = require('../services/email');
    if (!emailService || typeof emailService.sendAppshotsDeviceAutoRevoked !== 'function') return;
    const { isAppshotsToken } = require('../utils/appshots-token');
    if (typeof isAppshotsToken !== 'function') return;
    const seen = new Set();
    const when = new Date();
    for (const row of preDeleteRows) {
      if (!row || !row.token || !row.id) continue;
      if (seen.has(row.id)) continue;
      if (!isAppshotsToken(row.token)) continue;
      seen.add(row.id);
      Promise.resolve(
        emailService.sendAppshotsDeviceAutoRevoked(owner, { when, reason }),
      ).catch((err) => {
        console.warn(
          `[appshots-auto-revoked] email failed user=${owner.id} reason=${reason}:`,
          err?.message || err,
        );
      });
    }
  } catch (err) {
    console.warn('[appshots-auto-revoked] notify helper failed:', err?.message || err);
  }
}

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

// ────────────────────────────────────────────────────────────
// Per-user QUARTERLY export quota (ratchet 45, task 2).
// Layered on top of the 1/30min soft limit: each user may run
// at most `EXPORT_QUARTERLY_LIMIT` GDPR exports per calendar
// quarter. Counters live in `SystemSettings` keyed by
// `user-export-quarter:{userId}:{year}-Q{n}` so we don't need a
// new Prisma model. Returns the same key shape regardless of
// whether the bucket exists yet (counter starts at 0).
// ────────────────────────────────────────────────────────────
const EXPORT_QUARTERLY_LIMIT = 10;
const EXPORT_QUARTERLY_LIMIT_MAX = 1000;

/**
 * Resolve the effective quarterly export limit for the current request.
 * When the request is executing in an organisation context
 * (`req.orgContext.orgId` populated by `enforce-org-quota` /
 * `enforce-org-rate-limit`), and that org has
 * `settings.export.quarterlyLimit` set, use it (clamped to [1, 1000]).
 * Otherwise fall back to the per-user default (10).
 *
 * Defensive — any read failure or missing delegate degrades to the
 * default. The function returns `{ limit, source, orgId }` so callers
 * can audit-log which override (if any) was applied.
 */
async function resolveExportQuarterlyLimit(prismaClient, req) {
  // Trust org context only after a membership check. `req.orgContext`
  // (when set by `enforceOrgQuotaSafe`) is already verified, so use it
  // as a fast path. Otherwise, accept the org id from header/body but
  // confirm the caller is a member of that org before honoring its
  // override. Without this guard any authenticated user could raise
  // their own export quota by passing an arbitrary org id of an org
  // configured with a higher `settings.export.quarterlyLimit`.
  let orgId = req
    && req.orgContext
    && typeof req.orgContext.orgId === 'string'
    && req.orgContext.orgId
    ? req.orgContext.orgId
    : null;
  let orgIdSource = orgId ? 'orgContext' : null;
  if (!orgId && req) {
    const header = req.headers && (req.headers['x-org-id'] || req.headers['X-Org-Id']);
    if (typeof header === 'string' && header.trim()) {
      orgId = header.trim();
      orgIdSource = 'header';
    } else {
      const bodyOrg = req.body && typeof req.body === 'object' ? req.body.organizationId : null;
      if (typeof bodyOrg === 'string' && bodyOrg.trim()) {
        orgId = bodyOrg.trim();
        orgIdSource = 'body';
      }
    }
  }
  if (!orgId || !prismaClient?.organization?.findUnique) {
    return { limit: EXPORT_QUARTERLY_LIMIT, source: 'default', orgId: null };
  }
  // Verify membership for any org id that didn't come from a middleware
  // we already trust. `orgContext` was checked upstream; everything else
  // must be authorized here.
  const userId = req && req.user && req.user.id;
  if (orgIdSource !== 'orgContext') {
    if (!userId || !prismaClient?.orgMembership?.findUnique) {
      return { limit: EXPORT_QUARTERLY_LIMIT, source: 'default', orgId: null };
    }
    try {
      const m = await prismaClient.orgMembership.findUnique({
        where: { orgId_userId: { orgId, userId } },
      });
      if (!m) {
        return { limit: EXPORT_QUARTERLY_LIMIT, source: 'default', orgId: null };
      }
    } catch (err) {
      console.warn('[user-export] org membership check failed:', err && err.message);
      return { limit: EXPORT_QUARTERLY_LIMIT, source: 'default', orgId: null };
    }
  }
  try {
    const org = await prismaClient.organization.findUnique({
      where: { id: orgId },
      select: { settings: true },
    });
    const settings = org && org.settings;
    if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
      const xport = settings.export;
      if (xport && typeof xport === 'object' && !Array.isArray(xport)) {
        const raw = xport.quarterlyLimit;
        const num = Number(raw);
        if (Number.isFinite(num) && num > 0) {
          const clamped = Math.min(
            EXPORT_QUARTERLY_LIMIT_MAX,
            Math.max(1, Math.floor(num)),
          );
          return { limit: clamped, source: 'org', orgId };
        }
      }
    }
  } catch (err) {
    console.warn('[user-export] org limit lookup failed:', err && err.message);
  }
  return { limit: EXPORT_QUARTERLY_LIMIT, source: 'default', orgId };
}

function quarterKeyForDate(date = new Date()) {
  const y = date.getUTCFullYear();
  const q = Math.floor(date.getUTCMonth() / 3) + 1; // 1..4
  return { year: y, quarter: q, label: `${y}-Q${q}` };
}

function quarterEndsAt(year, quarter) {
  // End of quarter (UTC) = first day of the next quarter.
  const nextQuarterStartMonth = quarter * 3; // 0-indexed: Q1→3 (Apr), Q4→12 (Jan next year)
  if (nextQuarterStartMonth >= 12) {
    return new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0, 0));
  }
  return new Date(Date.UTC(year, nextQuarterStartMonth, 1, 0, 0, 0, 0));
}

function quarterSettingsKey(userId, qInfo) {
  return `user-export-quarter:${userId}:${qInfo.label}`;
}

async function readQuarterCount(prisma, userId, qInfo) {
  if (!prisma || !prisma.systemSettings) return 0;
  try {
    const row = await prisma.systemSettings.findUnique({
      where: { key: quarterSettingsKey(userId, qInfo) },
    });
    if (!row || !row.value) return 0;
    try {
      const parsed = JSON.parse(row.value);
      const n = parsed && Number.isFinite(parsed.count) ? parsed.count : 0;
      return n >= 0 ? n : 0;
    } catch (_err) {
      return 0;
    }
  } catch (_err) {
    return 0;
  }
}

async function incrementQuarterCount(prisma, userId, qInfo) {
  if (!prisma || !prisma.systemSettings) return;
  const key = quarterSettingsKey(userId, qInfo);
  try {
    const current = await readQuarterCount(prisma, userId, qInfo);
    const next = current + 1;
    const value = JSON.stringify({
      userId,
      quarter: qInfo.label,
      count: next,
      updatedAt: new Date().toISOString(),
    });
    await prisma.systemSettings.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  } catch (err) {
    // Failing open — losing a count is preferable to denying a
    // legitimate export. The 30min soft limit still applies.
    console.warn('[user-export] quarterly-counter increment failed:', err?.message || err);
  }
}

/**
 * Returns { ok: true } when the user is still under their quarterly
 * cap, else { ok: false, used, limit, resetAt } with HTTP-friendly
 * fields for the 429 response body.
 */
async function checkQuarterlyExportQuota(prisma, userId, limit = EXPORT_QUARTERLY_LIMIT) {
  const effectiveLimit = Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : EXPORT_QUARTERLY_LIMIT;
  const qInfo = quarterKeyForDate();
  const used = await readQuarterCount(prisma, userId, qInfo);
  if (used < effectiveLimit) {
    return { ok: true, used, limit: effectiveLimit, quarter: qInfo.label };
  }
  const resetAt = quarterEndsAt(qInfo.year, qInfo.quarter);
  return {
    ok: false,
    used,
    limit: effectiveLimit,
    quarter: qInfo.label,
    resetAt,
  };
}

/**
 * Builds an integrity-checked ZIP for a GDPR export. Returns the ZIP
 * buffer, the SHA-256 of the buffer, and the manifest object that was
 * embedded inside (`manifest.json`). Pure I/O-free function for tests
 * — the route handler wraps DB fetching + audit logging around it.
 */
async function buildExportArchive({ userId, exportedAt, redactPII, entries }) {
  const sha256 = (input) =>
    crypto.createHash('sha256').update(input).digest('hex');

  const manifest = {
    userId,
    exportedAt,
    redactPII: Boolean(redactPII),
    algorithm: 'sha256',
    files: entries.map((e) => {
      const buf = Buffer.from(e.content, 'utf8');
      return { name: e.name, size: buf.length, sha256: sha256(buf) };
    }),
  };
  const fullEntries = entries.concat([
    { name: 'manifest.json', content: JSON.stringify(manifest, null, 2) },
  ]);

  const archive = archiver('zip', { zlib: { level: 9 } });
  const chunks = [];
  archive.on('data', (chunk) => chunks.push(chunk));
  const finalized = new Promise((resolve, reject) => {
    archive.on('end', resolve);
    archive.on('error', reject);
  });
  for (const entry of fullEntries) {
    archive.append(entry.content, { name: entry.name });
  }
  await archive.finalize();
  await finalized;

  const zipBuf = Buffer.concat(chunks);
  return { zipBuf, zipSha256: sha256(zipBuf), manifest };
}

async function recordQuarterlyExport(prisma, userId) {
  const qInfo = quarterKeyForDate();
  await incrementQuarterCount(prisma, userId, qInfo);
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

// Strip HTML tags + control chars from free-text profile fields so a
// pasted `<script>` / `<img onerror=...>` never round-trips through a
// downstream renderer. Conservative: removes any tag-looking token and
// trims whitespace; we do NOT try to be a full HTML sanitizer here
// because these columns never carry markup by design.
function stripHtml(input) {
  if (typeof input !== 'string') return input;
  // Remove tags (<...>) and HTML entities that decode to angle brackets.
  // Also strip null bytes / control chars except tab/newline.
  return input
    .replace(/<\/?[^>]+>/g, '')
    .replace(/&lt;|&gt;|&#x?\d+;?/gi, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim();
}

// Update user profile
router.put('/profile', [
  body('name').optional().isString().trim().isLength({ min: 2, max: 100 })
    .withMessage('Name must be 2-100 characters'),
  body('email').optional().isEmail().normalizeEmail().withMessage('Valid email required'),
  // Accept data URLs (client-encoded avatar) or remote URLs up to ~2MB
  // base64. Rejects anything non-string to keep the Prisma update safe.
  body('avatar').optional().isString().isLength({ max: 3_000_000 }),
  body('customInstructions').optional({ nullable: true }).isString().isLength({ max: 4000 })
    .withMessage('customInstructions max 4000 chars'),
  body('preferredTone').optional({ nullable: true }).isString().isLength({ max: 50 })
    .withMessage('preferredTone max 50 chars'),
  body('locale').optional({ nullable: true }).isString().isLength({ max: 5 })
    .withMessage('locale max 5 chars'),
], authenticateToken, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email, avatar, customInstructions, preferredTone, locale } = req.body;
    const updateData = {};

    if (name) updateData.name = stripHtml(name).slice(0, 100);
    if (typeof avatar === 'string') updateData.avatar = avatar;
    if (customInstructions !== undefined) {
      updateData.customInstructions = customInstructions === null
        ? null
        : stripHtml(String(customInstructions)).slice(0, 4000);
    }
    if (preferredTone !== undefined) {
      updateData.preferredTone = preferredTone === null
        ? null
        : stripHtml(String(preferredTone)).slice(0, 50);
    }
    if (locale !== undefined) {
      updateData.locale = locale === null
        ? null
        : stripHtml(String(locale)).slice(0, 5);
    }
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
    // Cycle 17 partially wired the row; ratchet 45 extends metadata
    // with requestId (best-effort, also written by writeAuditLog from
    // req), a salted IP hash (NEVER the raw IP), and a parsed UA so
    // SIEM rules can pivot on browser/os/device without re-running a
    // UA parser at query time.
    const rawIp = req.ip
      || req.headers['x-forwarded-for']
      || req.socket?.remoteAddress
      || null;
    const requestId = req.requestId
      || req.headers['x-request-id']
      || null;
    // NOTE: we intentionally do NOT pass `req` here so the audit-log
    // helper does not stamp the raw `ip` / `ua` into metadata — for
    // this sensitive event we want a hashed IP and a parsed UA only.
    void writeAuditLog(prisma, {
      action: 'password_changed',
      resource: 'user',
      resourceId: req.user.id,
      userId: req.user.id,
      actorName: req.user.email,
      metadata: {
        requestId: requestId ? String(requestId) : null,
        ipHash: hashIpForAudit(rawIp ? String(rawIp) : null),
        ua: parseUA(req.headers['user-agent'] || null),
      },
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

    const { getPlanCatalog } = require('../services/plan-credits-catalog');
    const catalog = getPlanCatalog(req.user.plan);
    const gemaUsage = Number(req.user.gemaTokenUsage || 0);
    const gemaLimit = Number(req.user.gemaTokenLimit || 0);

    res.json({
      summary: {
        totalTokens: apiUsage.reduce((sum, usage) => sum + asNumber(usage.tokens), 0),
        totalCost: asNumber(totalCost._sum.cost),
        totalCalls: apiUsage.length,
        messageCount,
        currentUsage,
        monthlyLimit,
        usagePercentage: monthlyLimit > 0 ? (currentUsage / monthlyLimit) * 100 : 0,
        plan: req.user.plan,
        premiumPool: {
          used: currentUsage,
          limit: monthlyLimit,
        },
        gemaPool: {
          used: gemaUsage,
          limit: catalog.gemaUnlimited ? null : gemaLimit,
          unlimited: catalog.gemaUnlimited,
        },
        catalog,
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
// Ratchet 45 — narrow PATCH endpoint for email-notification opt-outs.
//
// PATCH /api/users/me/settings
//   body: { notifications: { invitations?: bool, role_changes?: bool,
//                            removal?: bool, ownership?: bool,
//                            billing?: bool } }
//
// The general PUT /settings handler above accepts any subtree, so a
// caller *could* update notifications through it. This dedicated PATCH
// route exists so the FE can update opt-outs without round-tripping
// the entire settings JSON, and so unknown notifications keys are
// rejected at the boundary (mergeNotificationsPatch only retains the
// VALID_CATEGORIES). Returns the merged notifications blob so the UI
// can re-render without re-fetching /settings.
// ────────────────────────────────────────────────────────────
const {
  extractNotifications,
  mergeNotificationsPatch,
  VALID_CATEGORIES: NOTIF_CATEGORIES,
} = require('../services/email-preferences');

router.patch('/me/settings', authenticateToken, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const patch = body.notifications;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return res.status(400).json({
        error: 'body.notifications object required',
        categories: NOTIF_CATEGORIES,
      });
    }
    // Reject patches that carry zero known keys so the FE gets clear
    // 400 feedback instead of a silent no-op.
    const known = Object.keys(patch).filter((k) => NOTIF_CATEGORIES.includes(k));
    if (known.length === 0) {
      return res.status(400).json({
        error: 'no known notification categories in patch',
        categories: NOTIF_CATEGORIES,
      });
    }
    const current = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { settings: true },
    });
    const settingsObj = (current?.settings && typeof current.settings === 'object')
      ? current.settings
      : {};
    const mergedNotifications = mergeNotificationsPatch(
      extractNotifications(settingsObj),
      patch,
    );
    const mergedSettings = { ...settingsObj, notifications: mergedNotifications };

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: { settings: mergedSettings },
      select: { settings: true },
    });

    res.json({
      notifications: extractNotifications(updated.settings),
      categories: NOTIF_CATEGORIES,
    });
  } catch (error) {
    console.error('Update notification settings error:', error);
    res.status(500).json({ error: 'Failed to update notification settings' });
  }
});

// ────────────────────────────────────────────────────────────
// Ratchet 45 — User notifications inbox.
//
// GET    /api/users/me/notifications        — paginated list
//        Query params: ?filter=unread|read|all&limit=25&cursor=<id>
// POST   /api/users/me/notifications/:id/read     — mark one read
// POST   /api/users/me/notifications/read-all     — mark all read
//
// Notifications are auto-created by the trigger-registry for events
// listed in `services/user-notifications.js#handleTriggerEvent`.
// ────────────────────────────────────────────────────────────
const userNotifications = require('../services/user-notifications');

// GET /api/users/me/inferred-profile — returns the learned profile
// derived from the user's recent chat behavior (skill level, domain,
// formats, language, recurring topics). Always reflects what is stored
// under User.settings.inferred. Useful for debug + UX surfaces that
// want to show the user what the assistant has inferred about them.
router.get('/me/inferred-profile', authenticateToken, async (req, res) => {
  try {
    const u = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { settings: true },
    });
    const { loadInferredProfile } = require('../services/user-profile-inference');
    const inferred = loadInferredProfile(u);
    res.json({
      hasInferredProfile: Boolean(inferred),
      inferred: inferred || null,
    });
  } catch (error) {
    console.error('Inferred profile load error:', error);
    res.status(500).json({ error: 'Failed to load inferred profile' });
  }
});

router.get('/me/notifications', authenticateToken, async (req, res) => {
  try {
    const result = await userNotifications.listNotifications(prisma, req.user.id, {
      filter: req.query.filter,
      limit: req.query.limit,
      cursor: req.query.cursor,
    });
    res.json(result);
  } catch (error) {
    console.error('List notifications error:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

router.post('/me/notifications/:id/read', authenticateToken, async (req, res) => {
  try {
    const ok = await userNotifications.markRead(prisma, req.user.id, req.params.id);
    if (!ok) return res.status(404).json({ error: 'notification not found' });
    res.json({ ok: true });
  } catch (error) {
    console.error('Mark notification read error:', error);
    res.status(500).json({ error: 'Failed to mark notification read' });
  }
});

router.post('/me/notifications/read-all', authenticateToken, async (req, res) => {
  try {
    const updated = await userNotifications.markAllRead(prisma, req.user.id);
    res.json({ ok: true, updated });
  } catch (error) {
    console.error('Mark all notifications read error:', error);
    res.status(500).json({ error: 'Failed to mark notifications read' });
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
    // Task 21 — snapshot the rows we're about to nuke so we can fan
    // sendAppshotsDeviceAutoRevoked notices to the owner for each
    // Appshots-scoped session. authenticateToken's Task 17 path
    // doesn't fire on bulk revocations.
    let preDelete = [];
    try {
      preDelete = await prisma.session.findMany({
        where: { userId: req.user.id, NOT: { token: currentToken } },
        select: { id: true, token: true },
      });
    } catch (_) { preDelete = []; }

    const result = await prisma.session.deleteMany({
      where: { userId: req.user.id, NOT: { token: currentToken } },
    });

    void _notifyAppshotsAutoRevoked(preDelete, req.user, 'admin_revoked');

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
    res.setHeader(
      'Content-Disposition',
      contentDispositionHeader(
        'attachment',
        safeDownloadFilename(`siraGPT-export-${Date.now()}.json`, {
          fallback: 'siragpt-export.json',
          extension: '.json',
        }),
      ),
    );
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
  // Hard quarterly cap — checked BEFORE the 30-minute soft slot so a
  // quota-denied request doesn't burn the user's short-term window.
  // Default is 10 exports per calendar quarter per user; an org can
  // override via `Organization.settings.export.quarterlyLimit` (ratchet
  // 44, task 2) when the request runs in an org context.
  const limitInfo = await resolveExportQuarterlyLimit(prisma, req);
  const quota = await checkQuarterlyExportQuota(prisma, userId, limitInfo.limit);
  if (!quota.ok) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((quota.resetAt.getTime() - Date.now()) / 1000),
    );
    res.set('Retry-After', String(retryAfterSec));
    void writeAuditLog(prisma, {
      req,
      action: 'user_export_quota_exceeded',
      resource: 'user',
      resourceId: userId,
      metadata: {
        used: quota.used,
        limit: quota.limit,
        limitSource: limitInfo.source,
        orgId: limitInfo.orgId,
        quarter: quota.quarter,
        resetAt: quota.resetAt.toISOString(),
      },
    });
    return res.status(429).json({
      error: `Export quota exceeded: ${quota.limit} per quarter.`,
      used: quota.used,
      limit: quota.limit,
      quarter: quota.quarter,
      resetAt: quota.resetAt.toISOString(),
    });
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

  const exportStartedAt = Date.now();
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

    // Build the per-file entry list FIRST so we can compute each
    // payload's SHA-256 and embed a manifest.json before sealing the
    // archive. Order matters only for human readability — manifest
    // last, after every other entry, so the manifest hashes are
    // consistent with what landed on disk.
    const exportedAt = new Date().toISOString();
    const entries = [
      { name: 'profile.json', content: toJson(user || {}) },
      { name: 'chats.json', content: toJson({ count: chatsOut.length, chats: chatsOut, redactPII }) },
      { name: 'files.json', content: toJson({ count: filesOut.length, files: filesOut, redactPII }) },
      { name: 'payments.json', content: toJson({ count: payments.length, payments }) },
      {
        name: 'README.txt',
        content: [
          'siraGPT — Personal data export',
          '================================',
          '',
          `User ID:    ${userId}`,
          `Exported:   ${exportedAt}`,
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
          '  • manifest.json  — SHA-256 of every other file in this archive',
          '                     for integrity verification. The outer ZIP',
          '                     SHA-256 is also returned in the',
          '                     `X-Content-SHA256` response header.',
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
      },
    ];

    // Buffer the ZIP in-memory so we can hash the final bytes and set
    // `X-Content-SHA256` BEFORE flushing. The per-user 1/30min limit
    // already caps the worst case to a single archive in flight, and
    // every entry here is JSON metadata (no embedded blobs), so the
    // memory footprint is well within typical request budgets.
    const { zipBuf, zipSha256: zipSha } = await buildExportArchive({
      userId,
      exportedAt,
      redactPII,
      entries,
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      contentDispositionHeader(
        'attachment',
        safeDownloadFilename(`siragpt-export-${userId}-${Date.now()}.zip`, {
          fallback: 'siragpt-export.zip',
          extension: '.zip',
        }),
      ),
    );
    res.setHeader('Content-Length', String(zipBuf.length));
    res.setHeader('X-Content-SHA256', zipSha);

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
        quarter: quota.quarter,
        quarterUsedBefore: quota.used,
        zipSha256: zipSha,
        zipBytes: zipBuf.length,
      },
    });

    // Increment the quarterly counter only after the export has been
    // accepted + audited. We don't await — losing a count is preferable
    // to delaying the response.
    void recordQuarterlyExport(prisma, userId);

    // ── Prometheus wiring (ratchet 45) ─────────────────────────
    // Record export size + duration histograms and total counter.
    // Defensive require so a missing metrics module never breaks
    // the export path.
    try {
      const metrics = require('../utils/metrics');
      metrics.recordGdprExport({
        zipBytes: zipBuf.length,
        durationSeconds: (Date.now() - exportStartedAt) / 1000,
        redactPII,
      });
    } catch (metricsErr) {
      console.warn('[users/export] metrics record failed:', metricsErr && metricsErr.message);
    }

    res.end(zipBuf);
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
      // logged out across devices. Task 21 — snapshot first so we can
      // fan an `admin_revoked` Appshots auto-revoked email to the owner
      // (we still have `user` in scope before the soft-delete cascade
      // finishes). Best-effort; never blocks the GDPR delete path.
      let preDeleteAppshots = [];
      try {
        preDeleteAppshots = await prisma.session.findMany({
          where: { userId },
          select: { id: true, token: true },
        });
      } catch (_) { preDeleteAppshots = []; }
      try {
        await prisma.session.deleteMany({ where: { userId } });
      } catch (sessErr) {
        console.warn('[delete] could not revoke sessions:', sessErr?.message || sessErr);
      }
      void _notifyAppshotsAutoRevoked(preDeleteAppshots, user, 'admin_revoked');

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

// ────────────────────────────────────────────────────────────
// Ratchet 45, Task 1 — Phone verification.
//
// PUT  /api/users/me/phone          { phone }
//   → mints a 6-digit OTP, hashes it (bcrypt) into a fresh
//     PhoneVerification row, fans the plaintext to the user via
//     Twilio SMS, and returns expiresAt + a generic success body.
//     Rate-limited to 1 send / minute / user via rateLimitStore.consume.
//
// POST /api/users/me/phone/verify   { code }
//   → matches the 6-digit code against the most recent active row,
//     enforces MAX_VERIFY_ATTEMPTS=5 per row, on success sets
//     User.phone + User.phoneVerifiedAt and marks the row consumed.
//
// SMS sender uses TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID;
// gracefully degrades to a "skipped" reason when Twilio isn't
// configured so dev/test envs still get a 200 response.
// ────────────────────────────────────────────────────────────
const phoneVerification = require('../services/phone-verification');

const PHONE_RESEND_WINDOW_MS = 60 * 1000; // 1 minute
const PHONE_RESEND_LIMIT = 1;

router.put(
  '/me/phone',
  authenticateToken,
  [
    body('phone')
      .isString()
      .trim()
      .isLength({ min: 9, max: 16 })
      .withMessage('phone required'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const { phone } = req.body;
      if (!phoneVerification.isValidPhone(phone)) {
        return res.status(400).json({
          error: 'phone must be E.164 (e.g. +14155551234)',
        });
      }

      // 1 send per minute per user. Rate-limit is intentionally keyed
      // on userId (not IP) so a roaming user on changing networks
      // still gets the cooldown they expect.
      const key = `phone-verify-send:${req.user.id}`;
      let allowed = true;
      let retryAfterMs = 0;
      try {
        const result = await rateLimitStore.consume(
          key,
          PHONE_RESEND_LIMIT,
          PHONE_RESEND_WINDOW_MS,
        );
        if (!result.allowed) {
          allowed = false;
          retryAfterMs = Math.max(0, result.resetAt.getTime() - Date.now());
        }
      } catch (_err) {
        // Store unavailable — fail open so legitimate verification
        // requests still succeed. The 1/min cap is a soft guard, not
        // a security boundary (the per-row 5-attempt cap below is).
      }
      if (!allowed) {
        const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
        res.set('Retry-After', String(retryAfterSec));
        return res.status(429).json({
          error: 'Please wait before requesting a new verification code.',
          retryAfterMs,
        });
      }

      const { code, expiresAt } = await phoneVerification.createPhoneChallenge(
        prisma,
        req.user.id,
        phone,
      );

      const smsResult = await phoneVerification.sendSms(phone, code);

      // Granular audit event — we DO NOT include the plaintext code.
      void writeAuditLog(prisma, {
        req,
        action: 'phone_verification_sent',
        resource: 'user',
        resourceId: req.user.id,
        userId: req.user.id,
        metadata: {
          phoneMasked: phone.replace(/.(?=.{4})/g, '*'),
          smsSent: Boolean(smsResult.sent),
          smsReason: smsResult.reason || null,
        },
      });

      const responseBody = {
        ok: true,
        expiresAt: expiresAt.toISOString(),
        smsSent: Boolean(smsResult.sent),
      };
      // Surface the skip reason (no-twilio-env, no-twilio-lib, etc.) so
      // dev clients understand why no SMS arrived. Never include the
      // plaintext code here.
      if (!smsResult.sent && smsResult.reason) {
        responseBody.smsSkippedReason = smsResult.reason;
      }
      return res.json(responseBody);
    } catch (error) {
      if (error?.code === 'invalid_phone') {
        return res.status(400).json({
          error: 'phone must be E.164 (e.g. +14155551234)',
        });
      }
      console.error('Phone verification send error:', error);
      return res.status(500).json({ error: 'Failed to send verification code' });
    }
  },
);

router.post(
  '/me/phone/verify',
  authenticateToken,
  [
    body('code')
      .isString()
      .trim()
      .isLength({ min: 6, max: 6 })
      .withMessage('6-digit code required'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const { code } = req.body;
      const result = await phoneVerification.verifyPhoneChallenge(
        prisma,
        req.user.id,
        code,
      );

      if (result.ok) {
        void writeAuditLog(prisma, {
          req,
          action: 'phone_verified',
          resource: 'user',
          resourceId: req.user.id,
          userId: req.user.id,
          metadata: {
            phoneMasked: result.phone
              ? result.phone.replace(/.(?=.{4})/g, '*')
              : null,
          },
        });
        return res.json({
          ok: true,
          phoneVerifiedAt: result.verifiedAt instanceof Date
            ? result.verifiedAt.toISOString()
            : new Date().toISOString(),
        });
      }

      // Map service-layer status codes onto HTTP responses. We DO NOT
      // leak per-row attempt counts to unauthenticated callers, but
      // authenticated users can see how many tries remain.
      switch (result.code) {
        case 'invalid_input':
          return res.status(400).json({ error: 'code must be 6 digits' });
        case 'not_found':
          return res.status(404).json({ error: 'No active verification code' });
        case 'expired':
          return res.status(410).json({ error: 'Verification code expired' });
        case 'too_many_attempts':
          void writeAuditLog(prisma, {
            req,
            action: 'phone_verification_locked',
            resource: 'user',
            resourceId: req.user.id,
            userId: req.user.id,
            metadata: { attempts: result.attempts },
          });
          return res.status(429).json({
            error: 'Too many attempts. Request a new code.',
            attempts: result.attempts,
          });
        case 'invalid_code':
          return res.status(400).json({
            error: 'Invalid verification code',
            attempts: result.attempts,
            remaining: result.remaining,
          });
        default:
          return res.status(400).json({ error: 'Verification failed' });
      }
    } catch (error) {
      console.error('Phone verification verify error:', error);
      return res.status(500).json({ error: 'Failed to verify code' });
    }
  },
);

// ────────────────────────────────────────────────────────────
// Ratchet 45 — 2FA opt-in toggle.
//
// PATCH /api/users/me/2fa { enabled: bool }
//   → Updates User.twoFactorEnabled. Gated on phoneVerifiedAt being
//     non-null (a user with no verified phone can't be challenged
//     with SMS, so opting in would lock them out). Audit-logged.
// ────────────────────────────────────────────────────────────
router.patch(
  '/me/2fa',
  authenticateToken,
  [body('enabled').isBoolean().withMessage('enabled must be boolean')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const enabled = Boolean(req.body.enabled);

      // Require a verified phone on file before allowing opt-in so the
      // user can actually complete a future SMS challenge. Opt-out is
      // always allowed even without a phone.
      if (enabled) {
        const current = await prisma.user.findUnique({
          where: { id: req.user.id },
          select: { phoneVerifiedAt: true },
        });
        if (!current || !current.phoneVerifiedAt) {
          return res.status(400).json({
            error: 'phone must be verified before enabling 2FA',
            code: 'phone_not_verified',
          });
        }
      }

      const updated = await prisma.user.update({
        where: { id: req.user.id },
        data: { twoFactorEnabled: enabled },
        select: { id: true, twoFactorEnabled: true, phoneVerifiedAt: true },
      });

      void writeAuditLog(prisma, {
        req,
        action: enabled ? 'two_factor_enabled' : 'two_factor_disabled',
        resource: 'user',
        resourceId: req.user.id,
        userId: req.user.id,
        metadata: { enabled },
      });

      return res.json({
        ok: true,
        twoFactorEnabled: updated.twoFactorEnabled,
      });
    } catch (error) {
      console.error('2FA toggle error:', error);
      return res.status(500).json({ error: 'Failed to update 2FA setting' });
    }
  },
);

// ────────────────────────────────────────────────────────────
// Ratchet 45 — TOTP-based 2FA scaffold (Authy / Google Authenticator).
//
// POST /api/users/me/2fa/totp/setup
//   → Generates a fresh base32 secret + otpauth:// URI for QR-code
//     rendering. Stores the secret encrypted at rest on the user row
//     but leaves `totpEnabled = false` until the client posts a valid
//     6-digit code to /verify below. The plaintext secret is returned
//     ONCE so a paranoid user can also type it manually into their
//     authenticator app; it cannot be retrieved later.
//
// POST /api/users/me/2fa/totp/verify { code }
//   → Verifies a 6-digit TOTP code against the stored secret. On
//     success flips `totpEnabled = true` and audits the activation.
//     A ±1 step window (~90s total) absorbs minor clock drift.
// ────────────────────────────────────────────────────────────

// Encrypts the base32 secret with the platform ENCRYPTION_KEY when
// available; falls back to a clearly-marked plaintext envelope so
// `npm test` (where ENCRYPTION_KEY is unset) still exercises the
// flow without crashing the process. The fallback prefix lets the
// verify step transparently round-trip either format.
function encryptTotpSecret(plainBase32) {
  try {
    const { encrypt } = require('../utils/encryption');
    return `enc:${encrypt(plainBase32)}`;
  } catch (_err) {
    // TODO(ratchet45): once ENCRYPTION_KEY is mandatory in all envs,
    // drop the plaintext fallback and let this throw.
    return `plain:${plainBase32}`;
  }
}

function decryptTotpSecret(stored) {
  if (typeof stored !== 'string' || stored.length === 0) return null;
  if (stored.startsWith('plain:')) return stored.slice('plain:'.length);
  if (stored.startsWith('enc:')) {
    try {
      const { decrypt } = require('../utils/encryption');
      return decrypt(stored.slice('enc:'.length));
    } catch (_err) {
      return null;
    }
  }
  // Legacy / unknown envelope — assume raw base32.
  return stored;
}

function buildOtpauthUri({ secret, accountName, issuer }) {
  const iss = encodeURIComponent(issuer);
  const acc = encodeURIComponent(accountName);
  // otpauth://totp/<issuer>:<account>?secret=...&issuer=...&algorithm=SHA1&digits=6&period=30
  const label = `${iss}:${acc}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

router.post(
  '/me/2fa/totp/setup',
  authenticateToken,
  async (req, res) => {
    try {
      const { randomSecret } = require('../services/auth/totp');
      const secret = randomSecret({ bytes: 20 });

      const current = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { email: true, totpEnabled: true },
      });
      if (!current) return res.status(404).json({ error: 'User not found' });
      if (current.totpEnabled) {
        return res.status(409).json({
          error: 'TOTP already enabled — disable it first to re-enroll',
          code: 'totp_already_enabled',
        });
      }

      await prisma.user.update({
        where: { id: req.user.id },
        data: {
          totpSecret: encryptTotpSecret(secret),
          // Leave totpEnabled = false; the /verify step flips it.
        },
        select: { id: true },
      });

      const issuer = process.env.TOTP_ISSUER || 'SiraGPT';
      const accountName = current.email || req.user.id;
      const otpauthUri = buildOtpauthUri({ secret, accountName, issuer });

      void writeAuditLog(prisma, {
        req,
        action: 'totp_setup_initiated',
        resource: 'user',
        resourceId: req.user.id,
        userId: req.user.id,
      });

      return res.json({ secret, otpauthUri });
    } catch (error) {
      console.error('TOTP setup error:', error);
      return res.status(500).json({ error: 'Failed to initialise TOTP' });
    }
  },
);

// ────────────────────────────────────────────────────────────
// Ratchet 45 (Task 2) — TOTP recovery codes.
//
// POST /api/users/me/2fa/totp/recovery-codes
//   → Generates 10 fresh single-use 16-char recovery codes. Returns
//     the plaintext codes ONCE in the response body. Stores them
//     hashed as `[{ hash, usedAt: null }]` on `User.totpRecoveryCodes`.
//     Any previous codes are replaced (regeneration invalidates the
//     old set). Requires totpEnabled = true (TOTP must be activated
//     before recovery codes can be issued).
//
// Recovery codes are accepted as an alternative to the 6-digit TOTP
// code at POST /api/auth/2fa/totp/verify — the redemption logic lives
// next to that handler so both code paths share the same atomic
// single-use semantics. The hash format here is shared with that
// handler via the helpers in INTERNAL.
// ────────────────────────────────────────────────────────────

const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_LENGTH = 16;
// Crockford-style base32 alphabet (no 0/O/1/I/L) — keeps the codes
// transcribable from a paper printout without ambiguity.
const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateRecoveryCode() {
  const bytes = crypto.randomBytes(RECOVERY_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i += 1) {
    out += RECOVERY_CODE_ALPHABET[bytes[i] % RECOVERY_CODE_ALPHABET.length];
  }
  return out;
}

// Normalise to upper-case alphanumerics so users can transcribe the
// codes with hyphens / spaces / lower-case without rejection.
function normaliseRecoveryCode(raw) {
  if (typeof raw !== 'string') return '';
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashRecoveryCode(plain) {
  const salt = process.env.TOTP_RECOVERY_SALT || process.env.JWT_SECRET || 'siragpt-totp-recovery';
  return crypto
    .createHash('sha256')
    .update(`${salt}|${normaliseRecoveryCode(plain)}`)
    .digest('hex');
}

function generateRecoveryCodeSet(n = RECOVERY_CODE_COUNT) {
  const plaintext = [];
  const stored = [];
  for (let i = 0; i < n; i += 1) {
    const code = generateRecoveryCode();
    plaintext.push(code);
    stored.push({ hash: hashRecoveryCode(code), usedAt: null });
  }
  return { plaintext, stored };
}

router.post(
  '/me/2fa/totp/recovery-codes',
  authenticateToken,
  async (req, res) => {
    try {
      const current = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { totpEnabled: true },
      });
      if (!current) return res.status(404).json({ error: 'User not found' });
      if (!current.totpEnabled) {
        return res.status(409).json({
          error: 'TOTP must be enabled before generating recovery codes',
          code: 'totp_not_enabled',
        });
      }

      const { plaintext, stored } = generateRecoveryCodeSet();

      await prisma.user.update({
        where: { id: req.user.id },
        data: { totpRecoveryCodes: stored },
        select: { id: true },
      });

      void writeAuditLog(prisma, {
        req,
        action: 'totp_recovery_codes_generated',
        resource: 'user',
        resourceId: req.user.id,
        userId: req.user.id,
        metadata: { count: plaintext.length },
      });

      return res.json({
        recoveryCodes: plaintext,
        count: plaintext.length,
        message: 'Store these codes somewhere safe — they are shown only once.',
      });
    } catch (error) {
      console.error('TOTP recovery codes error:', error);
      return res.status(500).json({ error: 'Failed to generate recovery codes' });
    }
  },
);

router.post(
  '/me/2fa/totp/verify',
  authenticateToken,
  [body('code').isString().matches(/^\d{6}$/).withMessage('code must be a 6-digit string')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const current = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { totpSecret: true, totpEnabled: true },
      });
      if (!current || !current.totpSecret) {
        return res.status(400).json({
          error: 'TOTP not initialised — call /setup first',
          code: 'totp_not_initialised',
        });
      }

      const secret = decryptTotpSecret(current.totpSecret);
      if (!secret) {
        return res.status(500).json({ error: 'Stored TOTP secret is unreadable' });
      }

      const { verifyTotp } = require('../services/auth/totp');
      const ok = verifyTotp(String(req.body.code), secret, { window: 1 });
      if (!ok) {
        return res.status(401).json({ error: 'Invalid TOTP code', code: 'totp_invalid' });
      }

      const wasEnabled = current.totpEnabled === true;
      const updated = await prisma.user.update({
        where: { id: req.user.id },
        data: { totpEnabled: true },
        select: { id: true, totpEnabled: true },
      });

      if (!wasEnabled) {
        void writeAuditLog(prisma, {
          req,
          action: 'totp_enabled',
          resource: 'user',
          resourceId: req.user.id,
          userId: req.user.id,
        });
      }

      return res.json({ ok: true, totpEnabled: updated.totpEnabled });
    } catch (error) {
      console.error('TOTP verify error:', error);
      return res.status(500).json({ error: 'Failed to verify TOTP code' });
    }
  },
);

// ────────────────────────────────────────────────────────────
// Ratchet 45 — 2FA disable endpoints.
//
// Disabling a second factor is sensitive (it lowers the account's
// security posture), so we require either the user's current password
// in the request body OR a "recently authenticated" session (session
// row created within the last 5 minutes). The latter accommodates SSO /
// passwordless users for whom we don't have a password to verify.
//
// DELETE /api/users/me/2fa/totp — clears totpSecret + totpRecoveryCodes
//   and flips totpEnabled to false. Audit-logged.
// DELETE /api/users/me/2fa/sms  — clears twoFactorEnabled and
//   phoneVerifiedAt. `phone` column intentionally retained so the user
//   doesn't lose their number on disable. Audit-logged.
// ────────────────────────────────────────────────────────────

const RECENT_AUTH_WINDOW_MS = 5 * 60 * 1000;

async function assertRecentAuthOrPassword(req, res) {
  // Path A — recent session: createdAt within the trailing 5 minutes.
  const sessionCreatedAt = req.userSession && req.userSession.createdAt
    ? new Date(req.userSession.createdAt)
    : null;
  if (sessionCreatedAt && !Number.isNaN(sessionCreatedAt.getTime())) {
    const ageMs = Date.now() - sessionCreatedAt.getTime();
    if (ageMs >= 0 && ageMs <= RECENT_AUTH_WINDOW_MS) {
      return true;
    }
  }

  // Path B — current password supplied in body.
  const currentPassword = req.body && typeof req.body.currentPassword === 'string'
    ? req.body.currentPassword
    : '';
  if (!currentPassword) {
    res.status(403).json({
      error: 'recent authentication required',
      code: 'reauth_required',
    });
    return false;
  }

  const row = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { password: true },
  });
  if (!row || !row.password) {
    res.status(403).json({
      error: 'recent authentication required',
      code: 'reauth_required',
    });
    return false;
  }
  const ok = await bcrypt.compare(currentPassword, row.password);
  if (!ok) {
    res.status(403).json({
      error: 'current password is incorrect',
      code: 'invalid_password',
    });
    return false;
  }
  return true;
}

router.delete('/me/2fa/totp', authenticateToken, async (req, res) => {
  try {
    const okAuth = await assertRecentAuthOrPassword(req, res);
    if (!okAuth) return;

    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        totpEnabled: false,
        totpSecret: null,
        totpRecoveryCodes: null,
      },
      select: { id: true },
    });

    void writeAuditLog(prisma, {
      req,
      action: 'totp_disabled',
      resource: 'user',
      resourceId: req.user.id,
      userId: req.user.id,
      tags: ['security', '2fa'],
    });

    return res.json({ ok: true, totpEnabled: false });
  } catch (error) {
    console.error('TOTP disable error:', error);
    return res.status(500).json({ error: 'Failed to disable TOTP' });
  }
});

router.delete('/me/2fa/sms', authenticateToken, async (req, res) => {
  try {
    const okAuth = await assertRecentAuthOrPassword(req, res);
    if (!okAuth) return;

    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        twoFactorEnabled: false,
        phoneVerifiedAt: null,
        // `phone` intentionally retained — user can re-verify later
        // without re-entering the number.
      },
      select: { id: true },
    });

    void writeAuditLog(prisma, {
      req,
      action: 'two_factor_sms_disabled',
      resource: 'user',
      resourceId: req.user.id,
      userId: req.user.id,
      tags: ['security', '2fa'],
    });

    return res.json({ ok: true, twoFactorEnabled: false });
  } catch (error) {
    console.error('SMS 2FA disable error:', error);
    return res.status(500).json({ error: 'Failed to disable SMS 2FA' });
  }
});

// ────────────────────────────────────────────────────────────
// WebAuthn / passkey registration — ratchet 45 scaffold.
// Generates and verifies a registration ceremony for the
// authenticated user. Persists the new credential into the
// User.webauthnCredentials JSON column on success. When the
// `@simplewebauthn/server` package isn't installed (or the RP
// config is incomplete), the underlying service returns a 501
// placeholder which we surface verbatim.
// See backend/src/services/webauthn.js.
// ────────────────────────────────────────────────────────────
const webauthnService = require('../services/webauthn');

router.post('/me/webauthn/registration-options', authenticateToken, async (req, res) => {
  try {
    // Re-read so we have the latest webauthnCredentials column;
    // req.user is the JWT-decoded shape and may not include it.
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, name: true, webauthnCredentials: true },
    });
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    const result = await webauthnService.generateRegistrationOptions({ user });
    if (!result.ok) return res.status(result.status || 500).json(result);
    return res.json({ ok: true, options: result.options });
  } catch (error) {
    console.error('WebAuthn registration-options error:', error);
    return res.status(500).json({ error: 'webauthn_registration_options_failed' });
  }
});

router.post('/me/webauthn/registration-verify', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, name: true, webauthnCredentials: true },
    });
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    const result = await webauthnService.verifyRegistration({
      user,
      response: req.body && req.body.response,
      label: req.body && req.body.label,
    });
    if (!result.ok) return res.status(result.status || 400).json(result);
    await prisma.user.update({
      where: { id: user.id },
      data: { webauthnCredentials: result.credentials },
      select: { id: true },
    });
    void writeAuditLog(prisma, {
      req,
      action: 'webauthn_credential_registered',
      resource: 'user',
      resourceId: user.id,
      userId: user.id,
    });
    return res.json({
      ok: true,
      credentialId: result.credential.credentialId,
      label: result.credential.label,
    });
  } catch (error) {
    console.error('WebAuthn registration-verify error:', error);
    return res.status(500).json({ error: 'webauthn_registration_verify_failed' });
  }
});

// ────────────────────────────────────────────────────────────
// Ratchet 45 — SSO identity list / unlink endpoints.
//
// Every successful SAML/OIDC login (auth.js, cycle 144) writes or
// refreshes a row in `SSOIdentity` keyed by (provider, externalId).
// Users need a way to see which IdPs are linked to their account
// for the security-settings screen, and a way to unlink one when
// they rotate IdPs or leave an org. Unlinking is sensitive — once
// removed, the next SSO login from that IdP will provision a brand
// new row — so we gate DELETE behind the same recent-auth /
// password check used by the 2FA disable endpoints above.
//
// GET    /api/users/me/sso-identities          — list (auth)
// DELETE /api/users/me/sso-identities/:id      — unlink (auth + reauth)
// ────────────────────────────────────────────────────────────

// Mask an external id so the response never echoes back a raw
// nameID / email / OIDC sub. Keeps a few leading + trailing chars
// for visual recognition; pads short ids with a fixed ellipsis so
// length doesn't leak the original size.
function maskExternalId(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 6) return '***';
  const head = trimmed.slice(0, 3);
  const tail = trimmed.slice(-3);
  return `${head}***${tail}`;
}

router.get('/me/sso-identities', authenticateToken, async (req, res) => {
  try {
    if (!prisma || !prisma.sSOIdentity
      || typeof prisma.sSOIdentity.findMany !== 'function') {
      return res.json({ ok: true, identities: [] });
    }
    const rows = await prisma.sSOIdentity.findMany({
      where: { userId: req.user.id },
      orderBy: { lastUsedAt: 'desc' },
      select: {
        id: true,
        provider: true,
        externalId: true,
        orgId: true,
        createdAt: true,
        lastUsedAt: true,
      },
    });

    // Resolve org slugs in a single round-trip rather than N findUniques.
    const orgIds = Array.from(new Set(
      (rows || []).map((r) => r.orgId).filter((v) => typeof v === 'string' && v),
    ));
    let slugByOrgId = new Map();
    if (orgIds.length > 0
      && prisma.organization
      && typeof prisma.organization.findMany === 'function') {
      try {
        const orgs = await prisma.organization.findMany({
          where: { id: { in: orgIds } },
          select: { id: true, slug: true },
        });
        slugByOrgId = new Map((orgs || []).map((o) => [o.id, o.slug]));
      } catch (_e) { /* non-fatal — slug becomes null below */ }
    }

    const identities = (rows || []).map((r) => ({
      id: r.id,
      provider: r.provider,
      externalId: maskExternalId(r.externalId),
      orgSlug: slugByOrgId.get(r.orgId) || null,
      lastUsedAt: r.lastUsedAt,
      createdAt: r.createdAt,
    }));

    return res.json({ ok: true, identities });
  } catch (error) {
    console.error('SSO identities list error:', error);
    return res.status(500).json({ error: 'sso_identities_list_failed' });
  }
});

router.delete('/me/sso-identities/:id', authenticateToken, async (req, res) => {
  try {
    const okAuth = await assertRecentAuthOrPassword(req, res);
    if (!okAuth) return;

    const id = req.params && typeof req.params.id === 'string' ? req.params.id : '';
    if (!id) {
      return res.status(400).json({ error: 'invalid_identity_id' });
    }

    if (!prisma || !prisma.sSOIdentity
      || typeof prisma.sSOIdentity.findUnique !== 'function') {
      return res.status(404).json({ error: 'sso_identity_not_found' });
    }

    const existing = await prisma.sSOIdentity.findUnique({
      where: { id },
      select: { id: true, userId: true, provider: true, orgId: true },
    });
    if (!existing || existing.userId !== req.user.id) {
      // Don't leak whether the id exists for a different user.
      return res.status(404).json({ error: 'sso_identity_not_found' });
    }

    if (typeof prisma.sSOIdentity.delete === 'function') {
      await prisma.sSOIdentity.delete({ where: { id } });
    }

    void writeAuditLog(prisma, {
      req,
      action: 'sso_identity_unlinked',
      resource: 'user',
      resourceId: req.user.id,
      userId: req.user.id,
      metadata: {
        ssoIdentityId: existing.id,
        provider: existing.provider,
        orgId: existing.orgId,
      },
    });

    return res.json({ ok: true });
  } catch (error) {
    console.error('SSO identity unlink error:', error);
    return res.status(500).json({ error: 'sso_identity_unlink_failed' });
  }
});

module.exports = router;
// Test-only internals (ratchet 45)
module.exports.INTERNAL = {
  EXPORT_QUARTERLY_LIMIT,
  EXPORT_QUARTERLY_LIMIT_MAX,
  resolveExportQuarterlyLimit,
  quarterKeyForDate,
  quarterEndsAt,
  quarterSettingsKey,
  readQuarterCount,
  encryptTotpSecret,
  decryptTotpSecret,
  buildOtpauthUri,
  generateRecoveryCode,
  generateRecoveryCodeSet,
  normaliseRecoveryCode,
  hashRecoveryCode,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LENGTH,
  incrementQuarterCount,
  checkQuarterlyExportQuota,
  recordQuarterlyExport,
  buildExportArchive,
  RECENT_AUTH_WINDOW_MS,
  assertRecentAuthOrPassword,
  maskExternalId,
};

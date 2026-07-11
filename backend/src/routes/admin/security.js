/**
 * Admin · Security — real data for the Security Center panel.
 *
 * GET  /          → { overview, events, settings }
 * PUT  /settings  → whitelisted persisted flags (system_settings JSON blob)
 *
 * Mounted at /api/admin/security in backend/index.js BEFORE the /api/admin
 * catch-all. Auth: the mount applies authenticateToken + requireAdmin, and
 * the factory adds them defensively (mirrors sibling sub-routers).
 *
 * Replaces a page that rendered 100% mocked data (fake events, a
 * hardcoded 85/100 score and a fictional "master API key" card).
 */

const express = require('express');
const { authenticateToken } = require('../../middleware/auth');
const requireAdminRoutePermission = require('../../services/admin-route-policy');
const { writeAuditLog } = require('../../utils/audit-log');

const SETTINGS_KEY = 'security_settings';

const DEFAULT_SETTINGS = Object.freeze({
  require2faForAdmins: false,
  sessionTimeoutMinutes: 1440,
  passwordMinLength: 8,
  ipAllowlistEnabled: false,
  apiRateLimitEnabled: true,
});

// Audit actions surfaced as "security events" in the panel.
const SECURITY_ACTIONS = [
  'login_failed',
  'session_admin_revoked',
  'session_expired',
  'user_deleted',
  'user_created',
  'user_updated',
  'password_reset',
  'role_changed',
  'credits_granted',
  'secret_rotated',
];

function severityFor(action) {
  if (/login_failed|revoked|deleted|secret/.test(action)) return 'high';
  if (/password|role|credits/.test(action)) return 'medium';
  return 'low';
}

function sanitizeSettings(input = {}) {
  const out = { ...DEFAULT_SETTINGS };
  if (typeof input.require2faForAdmins === 'boolean') out.require2faForAdmins = input.require2faForAdmins;
  if (typeof input.ipAllowlistEnabled === 'boolean') out.ipAllowlistEnabled = input.ipAllowlistEnabled;
  if (typeof input.apiRateLimitEnabled === 'boolean') out.apiRateLimitEnabled = input.apiRateLimitEnabled;
  const timeout = Number(input.sessionTimeoutMinutes);
  if (Number.isInteger(timeout) && timeout >= 15 && timeout <= 7 * 24 * 60) out.sessionTimeoutMinutes = timeout;
  const minLen = Number(input.passwordMinLength);
  if (Number.isInteger(minLen) && minLen >= 6 && minLen <= 128) out.passwordMinLength = minLen;
  return out;
}

// Weighted, documented heuristic — not a compliance score. Each factor is
// a real measurement; the weights sum to 100.
function computeSecurityScore({ twoFactorRatio, verifiedRatio, failedLogins24h, settings }) {
  let score = 0;
  score += Math.round(twoFactorRatio * 25);              // 25 — 2FA adoption
  score += Math.round(verifiedRatio * 20);               // 20 — verified emails
  score += failedLogins24h === 0 ? 20 : failedLogins24h < 10 ? 12 : failedLogins24h < 50 ? 5 : 0; // 20 — brute-force pressure
  score += settings.apiRateLimitEnabled ? 15 : 0;        // 15 — rate limiting on
  score += settings.passwordMinLength >= 8 ? 10 : 5;     // 10 — password policy
  score += settings.require2faForAdmins ? 10 : 0;        // 10 — admin 2FA policy
  return Math.max(0, Math.min(100, score));
}

async function readSettings(prismaClient) {
  try {
    const row = await prismaClient.systemSettings.findUnique({ where: { key: SETTINGS_KEY } });
    if (!row?.value) return { ...DEFAULT_SETTINGS };
    return sanitizeSettings(JSON.parse(row.value));
  } catch (_) {
    return { ...DEFAULT_SETTINGS };
  }
}

function createRouter({ prismaClient }) {
  const router = express.Router();
  router.use(authenticateToken, requireAdminRoutePermission);

  router.get('/', async (_req, res) => {
    try {
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [activeSessions, apiKeys, totalUsers, twoFactorUsers, verifiedUsers, failedLogins24h, eventRows, settings] =
        await Promise.all([
          prismaClient.session.count({ where: { expiresAt: { gt: new Date() } } }),
          prismaClient.apiKey.count(),
          prismaClient.user.count({ where: { deletedAt: null } }),
          prismaClient.user.count({ where: { deletedAt: null, twoFactorEnabled: true } }).catch(() => 0),
          prismaClient.user.count({ where: { deletedAt: null, emailVerifiedAt: { not: null } } }).catch(() => 0),
          prismaClient.auditLog.count({ where: { action: 'login_failed', createdAt: { gt: dayAgo } } }),
          prismaClient.auditLog.findMany({
            where: { action: { in: SECURITY_ACTIONS } },
            orderBy: { createdAt: 'desc' },
            take: 20,
          }),
          readSettings(prismaClient),
        ]);

      const twoFactorRatio = totalUsers > 0 ? twoFactorUsers / totalUsers : 0;
      const verifiedRatio = totalUsers > 0 ? verifiedUsers / totalUsers : 0;

      res.json({
        overview: {
          securityScore: computeSecurityScore({ twoFactorRatio, verifiedRatio, failedLogins24h, settings }),
          activeSessions,
          apiKeys,
          twoFactorUsers,
          emailVerifiedUsers: verifiedUsers,
          failedLogins24h,
        },
        events: eventRows.map((row) => ({
          id: row.id,
          action: row.action,
          actor: row.actorName || row.actorId || row.actorType || null,
          ip: row.metadata?.ip || null,
          createdAt: row.createdAt,
          severity: severityFor(row.action),
        })),
        settings,
      });
    } catch (error) {
      console.error('Admin security overview error:', error);
      res.status(500).json({ error: 'No se pudo cargar el estado de seguridad' });
    }
  });

  router.put('/settings', async (req, res) => {
    try {
      const clean = sanitizeSettings(req.body || {});
      await prismaClient.systemSettings.upsert({
        where: { key: SETTINGS_KEY },
        create: { key: SETTINGS_KEY, value: JSON.stringify(clean) },
        update: { value: JSON.stringify(clean) },
      });
      void writeAuditLog(prismaClient, {
        action: 'security_settings_updated',
        actorType: 'user',
        actorId: req.user?.id,
        resourceType: 'system_settings',
        metadata: clean,
        req,
      });
      res.json({ settings: clean });
    } catch (error) {
      console.error('Admin security settings error:', error);
      res.status(500).json({ error: 'No se pudieron guardar los ajustes de seguridad' });
    }
  });

  return router;
}

const prisma = require('../../config/database');
module.exports = createRouter({ prismaClient: prisma });
module.exports.createRouter = createRouter;
module.exports._internals = { sanitizeSettings, computeSecurityScore, severityFor, DEFAULT_SETTINGS, SECURITY_ACTIONS };

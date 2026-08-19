/**
 * Admin · Settings — persisted platform settings for the Ajustes panel.
 *
 * GET / → { settings, maintenance } — the general-settings JSON blob
 *   (system_settings key 'admin_general_settings') plus the current
 *   maintenance state (read-only here; flipping it stays on the
 *   super-admin POST /api/admin/maintenance/mode by design).
 * PUT / → whitelisted/clamped settings, upserted and audit-logged.
 *
 * Replaces a page whose Save button was setTimeout + alert(): nothing
 * was ever persisted. NEVER store secrets/API keys in this blob.
 */

const express = require('express');
const { authenticateToken } = require('../../middleware/auth');
const requireAdminRoutePermission = require('../../services/admin-route-policy');
const { writeAuditLog } = require('../../utils/audit-log');
const maintenanceMode = require('../../middleware/maintenance-mode');

const SETTINGS_KEY = 'admin_general_settings';

const DEFAULT_SETTINGS = Object.freeze({
  siteName: 'SiraGPT',
  siteDescription: 'Plataforma de IA multimodal',
  adminEmail: '',
  supportEmail: '',
  enableRegistration: true,
  enableEmailVerification: true,
  defaultUserPlan: 'FREE',
  sessionTimeoutMinutes: 30,
  maxFileSizeMb: 100,
  maxUsersPerPlan: { FREE: 10000, PRO: 50000, ENTERPRISE: 100000 },
});

const VALID_PLANS = ['FREE', 'PRO', 'PRO_MAX', 'ENTERPRISE'];

function clampInt(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function cleanEmail(value, fallback) {
  const s = String(value ?? '').trim().slice(0, 160);
  if (!s) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : fallback;
}

function sanitizeSettings(input = {}) {
  const out = { ...DEFAULT_SETTINGS, maxUsersPerPlan: { ...DEFAULT_SETTINGS.maxUsersPerPlan } };
  if (typeof input.siteName === 'string' && input.siteName.trim()) out.siteName = input.siteName.trim().slice(0, 120);
  if (typeof input.siteDescription === 'string') out.siteDescription = input.siteDescription.trim().slice(0, 400);
  out.adminEmail = cleanEmail(input.adminEmail, out.adminEmail);
  out.supportEmail = cleanEmail(input.supportEmail, out.supportEmail);
  if (typeof input.enableRegistration === 'boolean') out.enableRegistration = input.enableRegistration;
  if (typeof input.enableEmailVerification === 'boolean') out.enableEmailVerification = input.enableEmailVerification;
  const plan = String(input.defaultUserPlan ?? '').toUpperCase();
  if (VALID_PLANS.includes(plan)) out.defaultUserPlan = plan;
  out.sessionTimeoutMinutes = clampInt(input.sessionTimeoutMinutes, { min: 5, max: 7 * 24 * 60, fallback: out.sessionTimeoutMinutes });
  out.maxFileSizeMb = clampInt(input.maxFileSizeMb, { min: 1, max: 1024, fallback: out.maxFileSizeMb });
  if (input.maxUsersPerPlan && typeof input.maxUsersPerPlan === 'object') {
    for (const key of Object.keys(out.maxUsersPerPlan)) {
      out.maxUsersPerPlan[key] = clampInt(input.maxUsersPerPlan[key], { min: 0, max: 10_000_000, fallback: out.maxUsersPerPlan[key] });
    }
  }
  return out;
}

async function readSettings(prismaClient) {
  try {
    const row = await prismaClient.systemSettings.findUnique({ where: { key: SETTINGS_KEY } });
    if (!row?.value) return sanitizeSettings({});
    return sanitizeSettings(JSON.parse(row.value));
  } catch (_) {
    return sanitizeSettings({});
  }
}

function createRouter({ prismaClient }) {
  const router = express.Router();
  router.use(authenticateToken, requireAdminRoutePermission);

  router.get('/', async (_req, res) => {
    try {
      const [settings, maintenance] = await Promise.all([
        readSettings(prismaClient),
        maintenanceMode.getMaintenanceState(prismaClient).catch(() => null),
      ]);
      res.json({
        settings,
        maintenance: {
          enabled: Boolean(maintenance && maintenance.enabled),
          message: (maintenance && maintenance.message) || null,
        },
      });
    } catch (error) {
      console.error('Admin settings read error:', error);
      res.status(500).json({ error: 'No se pudieron cargar los ajustes' });
    }
  });

  router.put('/', async (req, res) => {
    try {
      const clean = sanitizeSettings(req.body?.settings ?? req.body ?? {});
      await prismaClient.systemSettings.upsert({
        where: { key: SETTINGS_KEY },
        create: { key: SETTINGS_KEY, value: JSON.stringify(clean) },
        update: { value: JSON.stringify(clean) },
      });
      void writeAuditLog(prismaClient, {
        action: 'admin_settings_updated',
        actorType: 'user',
        actorId: req.user?.id,
        resourceType: 'system_settings',
        metadata: clean,
        req,
      });
      res.json({ settings: clean });
    } catch (error) {
      console.error('Admin settings write error:', error);
      res.status(500).json({ error: 'No se pudieron guardar los ajustes' });
    }
  });

  return router;
}

const prisma = require('../../config/database');
module.exports = createRouter({ prismaClient: prisma });
module.exports.createRouter = createRouter;
module.exports._internals = { sanitizeSettings, DEFAULT_SETTINGS, SETTINGS_KEY, VALID_PLANS };

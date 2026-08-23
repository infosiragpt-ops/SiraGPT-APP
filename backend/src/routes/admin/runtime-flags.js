'use strict';

/**
 * Admin · Runtime feature flags (kill-switch sin redeploy).
 *
 * GET  /api/admin/flags        → { flags, updatedAt, updatedBy }
 * PUT  /api/admin/flags        → { flags: { NAME: true|false, ... }, message? }
 * DELETE /api/admin/flags/:name→ borra un override concreto
 *
 * Los overrides viven en SystemSettings (key 'runtime_flag_overrides') y
 * ganan sobre los checks env de cada módulo flags/* (ver
 * services/flags/runtime-overrides.js). Escritura limitada a super-admin;
 * toda mutación queda en AuditLog.
 */

const express = require('express');
const { authenticateToken, requireSuperAdmin } = require('../../middleware/auth');
const { writeAuditLog } = require('../../utils/audit-log');
const runtimeOverrides = require('../../services/flags/runtime-overrides');

const MAX_FLAG_NAME = 120;

function cleanFlagName(name) {
  return String(name || '').trim().slice(0, MAX_FLAG_NAME);
}

function createRouter({ prismaClient }) {
  const router = express.Router();
  router.use(authenticateToken, requireSuperAdmin);

  router.get('/', async (_req, res) => {
    try {
      const state = await runtimeOverrides.readOverrides(prismaClient, { force: true });
      const entries = Object.entries(state.flags || {})
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({
        key: runtimeOverrides.KEY,
        updatedAt: state.updatedAt || null,
        updatedBy: state.updatedBy || null,
        count: entries.length,
        flags: entries,
      });
    } catch (err) {
      console.error('[admin/runtime-flags GET] failed:', err?.message || err);
      res.status(500).json({ error: 'Failed to read runtime flag overrides' });
    }
  });

  router.put('/', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (!body.flags || typeof body.flags !== 'object' || Array.isArray(body.flags)) {
      return res.status(400).json({ error: '`flags` (object of name → boolean) is required' });
    }
    const names = Object.keys(body.flags);
    if (names.length === 0) {
      return res.status(400).json({ error: '`flags` must contain at least one entry' });
    }
    for (const raw of names) {
      if (!cleanFlagName(raw)) {
        return res.status(400).json({ error: `Invalid flag name: ${String(raw).slice(0, MAX_FLAG_NAME)}` });
      }
      if (typeof body.flags[raw] !== 'boolean') {
        return res.status(400).json({ error: `Flag "${cleanFlagName(raw)}" must map to a boolean` });
      }
    }
    try {
      const before = await runtimeOverrides.readOverrides(prismaClient, { force: true });
      const next = await runtimeOverrides.writeOverrides(prismaClient, {
        flags: body.flags,
        actorId: req.user?.id || null,
        message: body.message,
      });
      void writeAuditLog(prismaClient, {
        req,
        actorType: 'admin',
        userId: req.user?.id || null,
        action: 'runtime_flags_override_set',
        resource: 'system_settings',
        resourceId: runtimeOverrides.KEY,
        before: { flags: before.flags },
        after: { flags: next.flags, message: next.message },
      });
      res.json({ ok: true, flags: next.flags, updatedAt: next.updatedAt });
    } catch (err) {
      console.error('[admin/runtime-flags PUT] failed:', err?.message || err);
      res.status(500).json({ error: 'Failed to write runtime flag overrides' });
    }
  });

  router.delete('/:name', async (req, res) => {
    const name = cleanFlagName(req.params.name);
    if (!name) return res.status(400).json({ error: 'Invalid flag name' });
    try {
      const before = await runtimeOverrides.readOverrides(prismaClient, { force: true });
      if (!(name in (before.flags || {}))) {
        return res.status(404).json({ error: 'unknown_flag', name });
      }
      const next = await runtimeOverrides.writeOverrides(
        prismaClient,
        { remove: [name], actorId: req.user?.id || null }
      );
      void writeAuditLog(prismaClient, {
        req,
        actorType: 'admin',
        userId: req.user?.id || null,
        action: 'runtime_flags_override_cleared',
        resource: 'system_settings',
        resourceId: runtimeOverrides.KEY,
        before: { flags: before.flags },
        after: { flags: next.flags },
      });
      res.json({ ok: true, removed: name, flags: next.flags });
    } catch (err) {
      console.error('[admin/runtime-flags DELETE] failed:', err?.message || err);
      res.status(500).json({ error: 'Failed to clear runtime flag override' });
    }
  });

  return router;
}

module.exports = createRouter({ prismaClient: require('../../config/database') });
module.exports.createRouter = createRouter;
module.exports._internals = { cleanFlagName };

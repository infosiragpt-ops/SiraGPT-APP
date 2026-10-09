'use strict';

/**
 * /api/automations — reminders, recurring jobs, loops and the heartbeat the
 * chat agent (or a client) programs for the user, delivered into the
 * originating chat when they fire. Thin HTTP face over services/automations;
 * the cowork scheduler worker executes them.
 *
 *   GET    /                → { ok, automations }  (?chatId= filters)
 *   POST   /                → create { prompt, schedule, chatId, tz? }
 *   GET    /heartbeat       → { ok, heartbeat|null }
 *   PUT    /heartbeat       → { chatId, tz?, everyMinutes?, activeHours?, prompt? }
 *   DELETE /heartbeat
 *   GET    /:id
 *   DELETE /:id
 *   POST   /:id/pause | /:id/resume | /:id/run
 *   GET    /health          → { ok, service, maxPerUser }
 *
 * All routes are user-scoped (auth required); cookie-auth mutations are
 * CSRF-gated at mount time (index.js).
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const defaultPrisma = require('../config/database');
const automationsService = require('../services/automations');

function userIdOf(req) {
  return req.user && (req.user.id || req.user.userId);
}

function sendError(res, err, fallback) {
  const status = Number(err && err.status) || 500;
  const message = status < 500 && err && err.message ? err.message : fallback;
  const code = status < 500 && err && err.code ? err.code : undefined;
  if (status >= 500) {
    try { console.warn('[automations] request failed:', err && err.message); } catch (_) { /* noop */ }
  }
  return res.status(status).json({ ok: false, error: message, code, ...(err && err.details && status < 500 ? { details: err.details } : {}) });
}

function str(value, max = 200) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function createAutomationsRouter({ auth = authenticateToken, prisma = defaultPrisma, automations = automationsService } = {}) {
  const router = express.Router();
  const json = express.json({ limit: '32kb' });
  const noStore = (res) => res.set('Cache-Control', 'no-store');

  router.get('/health', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, service: 'automations', maxPerUser: automations.MAX_PER_USER });
  });

  router.get('/', auth, async (req, res) => {
    try {
      const list = await automations.listAutomations(prisma, {
        userId: userIdOf(req),
        chatId: str(req.query.chatId, 64) || null,
      });
      noStore(res);
      return res.json({ ok: true, automations: list });
    } catch (err) {
      return sendError(res, err, 'No se pudieron cargar tus automatizaciones.');
    }
  });

  router.post('/', auth, json, async (req, res) => {
    try {
      const body = req.body || {};
      const created = await automations.createAutomation(prisma, {
        userId: userIdOf(req),
        chatId: str(body.chatId, 64),
        prompt: str(body.prompt, 4000),
        schedule: body.schedule && typeof body.schedule === 'object' ? body.schedule : str(body.schedule, 200),
        tz: str(body.tz || body.timeZone, 64) || 'UTC',
        ...(Number.isFinite(Number(body.maxSteps)) ? { maxSteps: Number(body.maxSteps) } : {}),
      });
      noStore(res);
      return res.status(201).json({ ok: true, automation: created });
    } catch (err) {
      return sendError(res, err, 'No se pudo crear la automatización.');
    }
  });

  router.get('/heartbeat', auth, async (req, res) => {
    try {
      const heartbeat = await automations.getHeartbeat(prisma, { userId: userIdOf(req) });
      noStore(res);
      return res.json({ ok: true, heartbeat });
    } catch (err) {
      return sendError(res, err, 'No se pudo cargar el latido.');
    }
  });

  router.put('/heartbeat', auth, json, async (req, res) => {
    try {
      const body = req.body || {};
      const activeHours = body.activeHours && typeof body.activeHours === 'object'
        && Number.isFinite(Number(body.activeHours.start)) && Number.isFinite(Number(body.activeHours.end))
        ? { start: Number(body.activeHours.start), end: Number(body.activeHours.end) }
        : { start: 8, end: 22 };
      const heartbeat = await automations.ensureHeartbeat(prisma, {
        userId: userIdOf(req),
        chatId: str(body.chatId, 64),
        tz: str(body.tz || body.timeZone, 64) || 'UTC',
        everyMinutes: Number.isFinite(Number(body.everyMinutes)) ? Number(body.everyMinutes) : 30,
        activeHours,
        prompt: str(body.prompt, 1500) || null,
      });
      noStore(res);
      return res.json({ ok: true, heartbeat });
    } catch (err) {
      return sendError(res, err, 'No se pudo activar el latido.');
    }
  });

  router.delete('/heartbeat', auth, async (req, res) => {
    try {
      const removed = await automations.disableHeartbeat(prisma, { userId: userIdOf(req) });
      noStore(res);
      return res.json({ ok: true, removed });
    } catch (err) {
      return sendError(res, err, 'No se pudo desactivar el latido.');
    }
  });

  router.get('/:id', auth, async (req, res) => {
    try {
      const automation = await automations.getAutomation(prisma, { userId: userIdOf(req), automationId: str(req.params.id, 64) });
      noStore(res);
      return res.json({ ok: true, automation });
    } catch (err) {
      return sendError(res, err, 'No se pudo cargar la automatización.');
    }
  });

  router.delete('/:id', auth, async (req, res) => {
    try {
      const removed = await automations.removeAutomation(prisma, { userId: userIdOf(req), automationId: str(req.params.id, 64) });
      noStore(res);
      return res.json({ ok: true, removed });
    } catch (err) {
      return sendError(res, err, 'No se pudo eliminar la automatización.');
    }
  });

  for (const [action, enabled] of [['pause', false], ['resume', true]]) {
    router.post(`/:id/${action}`, auth, async (req, res) => {
      try {
        const automation = await automations.setAutomationEnabled(prisma, { userId: userIdOf(req), automationId: str(req.params.id, 64), enabled });
        noStore(res);
        return res.json({ ok: true, automation });
      } catch (err) {
        return sendError(res, err, `No se pudo ${action === 'pause' ? 'pausar' : 'reanudar'} la automatización.`);
      }
    });
  }

  router.post('/:id/run', auth, async (req, res) => {
    try {
      const automation = await automations.runAutomationNow(prisma, { userId: userIdOf(req), automationId: str(req.params.id, 64) });
      noStore(res);
      return res.status(202).json({ ok: true, automation });
    } catch (err) {
      return sendError(res, err, 'No se pudo ejecutar la automatización.');
    }
  });

  return router;
}

module.exports = createAutomationsRouter();
module.exports.createAutomationsRouter = createAutomationsRouter;

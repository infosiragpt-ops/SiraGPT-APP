'use strict';

/**
 * /api/skills — Agent Skills (claude.ai style) for /agentes.
 *
 * Composer («+ → Skills», «/»):
 *   GET    /api/skills                 → { ok, skills }   enabled skills, no bodies
 *
 * Ajustes → Skills:
 *   GET    /api/skills/library         → { ok, mine, partners }        «Tuyos»
 *   GET    /api/skills/discover        → { ok, featured, forYou, latest, categories, items }  «Descubrir»
 *   POST   /api/skills                 → create: { name, description, body } or upload: { content, filename }
 *   GET    /api/skills/:name           → { ok, skill } with body
 *   PUT    /api/skills/:name           → edit an own skill
 *   PATCH  /api/skills/:name           → { enabled } switch on/off
 *   POST   /api/skills/:name/install   → add a catalog skill to «Tuyos»
 *   DELETE /api/skills/:name           → delete own / uninstall catalog
 *   GET    /api/skills/:name/download  → SKILL.md
 *
 * All routes are user-scoped (auth required). «Para ti» ranks the catalog
 * against the user's memory (Ajustes → Memoria), best-effort.
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const chatSkills = require('../services/chat-skills');

const MEMORY_SIGNAL_LIMIT = 80;
const MEMORY_SIGNAL_TIMEOUT_MS = 1500;

async function defaultMemorySignal(userId) {
  if (!userId) return '';
  try {
    // eslint-disable-next-line global-require
    const vault = require('../services/memory/vault');
    const entries = await Promise.race([
      vault.list(userId, { limit: MEMORY_SIGNAL_LIMIT }),
      new Promise((resolve) => setTimeout(() => resolve([]), MEMORY_SIGNAL_TIMEOUT_MS).unref?.()),
    ]);
    const list = Array.isArray(entries) ? entries : (entries && Array.isArray(entries.entries) ? entries.entries : []);
    return list.map((e) => (e && (e.text || e.content)) || '').join('\n').slice(0, 8000);
  } catch {
    return '';
  }
}

function userIdOf(req) {
  return req.user && (req.user.id || req.user.userId);
}

function sendError(res, err, fallback) {
  const status = Number(err && err.status) || 500;
  const message = status < 500 && err && err.message ? err.message : fallback;
  return res.status(status).json({ ok: false, error: message, code: err && err.code ? err.code : undefined });
}

function createChatSkillsRouter({ auth = authenticateToken, skills = chatSkills, memorySignal = defaultMemorySignal } = {}) {
  const router = express.Router();

  const notifyChanged = (res) => res.set('Cache-Control', 'no-store');

  router.get('/', auth, (req, res) => {
    try {
      const list = skills.listChatSkills({ userId: userIdOf(req) });
      res.set('Cache-Control', 'private, no-cache');
      return res.json({ ok: true, skills: list });
    } catch (_err) {
      return res.status(500).json({ ok: false, error: 'No se pudieron cargar las skills.' });
    }
  });

  router.get('/library', auth, (req, res) => {
    try {
      const { mine, partners } = skills.listSkillLibrary({ userId: userIdOf(req) });
      notifyChanged(res);
      return res.json({ ok: true, mine, partners });
    } catch (err) {
      return sendError(res, err, 'No se pudieron cargar tus skills.');
    }
  });

  router.get('/discover', auth, async (req, res) => {
    try {
      const userId = userIdOf(req);
      const memoryText = await memorySignal(userId);
      const result = skills.discoverSkills({
        userId,
        memoryText,
        query: typeof req.query.q === 'string' ? req.query.q : '',
        category: typeof req.query.category === 'string' ? req.query.category.slice(0, 80) : '',
      });
      res.set('Cache-Control', 'private, no-cache');
      return res.json({ ok: true, ...result, memoryUsed: Boolean(memoryText) });
    } catch (err) {
      return sendError(res, err, 'No se pudo cargar el catálogo de skills.');
    }
  });

  router.post('/', auth, express.json({ limit: '64kb' }), (req, res) => {
    try {
      const userId = userIdOf(req);
      const body = req.body || {};
      const input = typeof body.content === 'string'
        ? skills.parseUploadedSkill(body.content, typeof body.filename === 'string' ? body.filename : '')
        : { name: body.name, description: body.description, body: body.body };
      const skill = skills.createUserSkill({ userId, ...input });
      notifyChanged(res);
      return res.status(201).json({ ok: true, skill });
    } catch (err) {
      return sendError(res, err, 'No se pudo guardar la skill.');
    }
  });

  router.post('/:name/install', auth, (req, res) => {
    try {
      const result = skills.installCatalogSkill({ userId: userIdOf(req), name: req.params.name });
      notifyChanged(res);
      return res.json({ ok: true, ...result });
    } catch (err) {
      return sendError(res, err, 'No se pudo añadir la skill.');
    }
  });

  router.get('/:name/download', auth, (req, res) => {
    const name = skills.normalizeSkillName(req.params.name);
    if (!name) return res.status(400).json({ ok: false, error: 'Nombre de skill no válido.' });
    const skill = skills.loadChatSkill({ userId: userIdOf(req), name });
    if (!skill) return res.status(404).json({ ok: false, error: 'No existe esa skill.' });
    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${name}-SKILL.md"`);
    return res.send(skills.exportSkillMarkdown(skill));
  });

  router.get('/:name', auth, (req, res) => {
    const userId = userIdOf(req);
    const name = skills.normalizeSkillName(req.params.name);
    if (!name) return res.status(400).json({ ok: false, error: 'Nombre de skill no válido.' });
    const skill = skills.loadChatSkill({ userId, name });
    if (!skill) return res.status(404).json({ ok: false, error: 'No existe esa skill.' });
    const state = skills.getSkillState({ userId });
    return res.json({ ok: true, skill: { ...skill, enabled: !state.disabled.has(name) } });
  });

  router.put('/:name', auth, express.json({ limit: '64kb' }), (req, res) => {
    try {
      const body = req.body || {};
      const skill = skills.updateUserSkill({
        userId: userIdOf(req),
        name: req.params.name,
        description: body.description,
        body: body.body,
      });
      notifyChanged(res);
      return res.json({ ok: true, skill });
    } catch (err) {
      return sendError(res, err, 'No se pudo guardar la skill.');
    }
  });

  router.patch('/:name', auth, express.json({ limit: '4kb' }), (req, res) => {
    try {
      if (typeof (req.body || {}).enabled !== 'boolean') {
        return res.status(400).json({ ok: false, error: 'Indica enabled: true o false.' });
      }
      const result = skills.setSkillEnabled({ userId: userIdOf(req), name: req.params.name, enabled: req.body.enabled });
      notifyChanged(res);
      return res.json({ ok: true, ...result });
    } catch (err) {
      return sendError(res, err, 'No se pudo actualizar la skill.');
    }
  });

  router.delete('/:name', auth, (req, res) => {
    try {
      const result = skills.removeSkill({ userId: userIdOf(req), name: req.params.name });
      notifyChanged(res);
      return res.json({ ok: true, ...result });
    } catch (err) {
      return sendError(res, err, 'No se pudo eliminar la skill.');
    }
  });

  return router;
}

module.exports = createChatSkillsRouter();
module.exports.createChatSkillsRouter = createChatSkillsRouter;
module.exports.defaultMemorySignal = defaultMemorySignal;

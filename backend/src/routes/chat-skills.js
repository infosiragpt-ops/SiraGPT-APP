'use strict';

/**
 * /api/skills — Agent Skills catalog for the /agentes composer («+ → Skills»).
 *
 *   GET /api/skills         → { ok, skills: [{ name, title, description, source }] }
 *   GET /api/skills/:name   → { ok, skill: { name, title, description, source, body } }
 *
 * Built-in document skills + the caller's own Biblioteca skills. Auth required
 * (user-scoped Biblioteca); bodies are only returned for one skill at a time.
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const chatSkills = require('../services/chat-skills');

function createChatSkillsRouter({ auth = authenticateToken, skills = chatSkills } = {}) {
  const router = express.Router();

  router.get('/', auth, (req, res) => {
    const userId = req.user && (req.user.id || req.user.userId);
    try {
      const list = skills.listChatSkills({ userId });
      res.set('Cache-Control', 'private, max-age=30');
      return res.json({ ok: true, skills: list });
    } catch (_err) {
      return res.status(500).json({ ok: false, error: 'No se pudieron cargar las skills.' });
    }
  });

  router.get('/:name', auth, (req, res) => {
    const userId = req.user && (req.user.id || req.user.userId);
    const name = skills.normalizeSkillName(req.params.name);
    if (!name) return res.status(400).json({ ok: false, error: 'Nombre de skill no válido.' });
    const skill = skills.loadChatSkill({ userId, name });
    if (!skill) return res.status(404).json({ ok: false, error: 'No existe esa skill.' });
    return res.json({ ok: true, skill });
  });

  return router;
}

module.exports = createChatSkillsRouter();
module.exports.createChatSkillsRouter = createChatSkillsRouter;

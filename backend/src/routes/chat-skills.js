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
 * Marketplace (services/skills-import — ClawHub / GitHub / SKILL.md URL):
 *   GET    /api/skills/marketplace/search?q=  → { ok, query, results }   (per-user rate limit)
 *   POST   /api/skills/import          → { source, name?, overwrite? } → { ok, skill, provenance }
 *
 * All routes are user-scoped (auth required). «Para ti» ranks the catalog
 * against the user's memory (Ajustes → Memoria), best-effort.
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const chatSkills = require('../services/chat-skills');
const defaultSkillsImport = require('../services/skills-import');
const { SlidingWindowRateLimiter } = require('../utils/sliding-window-rate-limiter');

// Marketplace searches fan out to a third party: cap them per user.
const SEARCH_LIMIT_PER_MIN = Math.max(5, Number.parseInt(process.env.SIRAGPT_SKILL_SEARCH_RATE_LIMIT_PER_MIN || '30', 10) || 30);

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
  // SkillImportError messages are user-facing by construction (no upstream
  // internals), so their 5xx (marketplace down / timeout) keep code + text.
  const safe = status < 500 || (err && err.name === 'SkillImportError');
  const message = safe && err && err.message ? err.message : fallback;
  const code = safe && err && err.code ? err.code : undefined;
  const details = safe && err && err.details && typeof err.details === 'object' ? err.details : undefined;
  return res.status(status).json({ ok: false, error: message, code, ...(details ? { details } : {}) });
}

function createChatSkillsRouter({ auth = authenticateToken, skills = chatSkills, memorySignal = defaultMemorySignal, skillsImport = defaultSkillsImport } = {}) {
  const router = express.Router();
  const searchLimiter = new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: SEARCH_LIMIT_PER_MIN });

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

  // ── Marketplace (before the /:name handlers) ─────────────────────────────
  router.get('/marketplace/search', auth, async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
    if (!q) return res.status(400).json({ ok: false, error: 'Indica qué buscar (q).', code: 'query_required' });
    try {
      const verdict = await searchLimiter.check(`skills-search:${userIdOf(req)}`);
      if (!verdict.allowed) {
        res.set('Retry-After', String(Math.max(1, Math.ceil((verdict.retryAfterMs || 1000) / 1000))));
        return res.status(429).json({ ok: false, error: 'Demasiadas búsquedas; espera un momento.', code: 'rate_limited' });
      }
      const limit = Math.min(20, Math.max(1, Number.parseInt(String(req.query.limit || '10'), 10) || 10));
      const out = await skillsImport.searchMarketplace(q, { limit });
      res.set('Cache-Control', 'private, no-cache');
      return res.json({ ok: true, ...out });
    } catch (err) {
      return sendError(res, err, 'El marketplace de skills no respondió.');
    }
  });

  router.post('/import', auth, express.json({ limit: '8kb' }), async (req, res) => {
    try {
      const body = req.body || {};
      const source = typeof body.source === 'string' ? body.source.trim() : '';
      if (!source) return res.status(400).json({ ok: false, error: 'Indica la skill a importar (source).', code: 'skill_source_required' });
      if (source.length > 500) return res.status(400).json({ ok: false, error: 'La referencia es demasiado larga.', code: 'skill_source_invalid' });
      const out = await skillsImport.importSkill({
        userId: userIdOf(req),
        source,
        name: typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 64) : null,
        overwrite: body.overwrite === true,
      });
      notifyChanged(res);
      return res.status(201).json({ ok: true, skill: out.skill, provenance: out.provenance, replaced: out.replaced, renamed: out.renamed });
    } catch (err) {
      return sendError(res, err, 'No se pudo importar la skill.');
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
    let provenance = null;
    try {
      provenance = (skillsImport.listImports({ userId }) || {})[name] || null;
    } catch (_) { provenance = null; }
    return res.json({ ok: true, skill: { ...skill, enabled: !state.disabled.has(name), ...(provenance ? { provenance } : {}) } });
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
      try { skillsImport.forgetImport({ userId: userIdOf(req), name: skills.normalizeSkillName(req.params.name) }); } catch (_) { /* provenance is advisory */ }
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

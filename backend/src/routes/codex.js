'use strict';

/**
 * codex route — Codex Agent V2 (spec docs/codex-agent-ux.md, flag CODEX_AGENT_V2).
 *
 *   GET  /api/codex/health                       → { ok, enabled }   (público, SIEMPRE 200)
 *   — resto: flag off ⇒ 404 not_found —
 *   POST /api/codex/projects                     → crea + provisiona  (auth)
 *   GET  /api/codex/projects                     → lista del usuario  (auth)
 *   GET  /api/codex/projects/:id                 → detalle            (auth)
 *   POST /api/codex/projects/:id/preview/start   → dev server on      (auth)
 *   GET  /api/codex/projects/:id/preview/status  → estado del runner  (auth)
 *   POST /api/codex/projects/:id/preview/stop    → dev server off     (auth)
 *
 * Montaje: en backend/index.js DESPUÉS del router legacy codex-runs (que ya
 * ocupa POST /api/codex/runs y GET /api/codex/runs/:id). Para no sombrear ese
 * flujo en ningún estado del flag, las corridas V2 viven scoped por proyecto
 * (/projects/:id/runs, fase F2) — decisión registrada en docs/codex-agent-ux.md.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { isCodexV2Enabled } = require('../services/codex/flags');
const projectService = require('../services/codex/project-service');
const { createRunnerClient, runnerDevUrl } = require('../services/codex/runner-client');

const router = express.Router();

// Público y SIEMPRE 200: el frontend decide si renderiza la UI V2 con esto.
router.get('/health', (_req, res) => res.json({ ok: true, enabled: isCodexV2Enabled() }));

router.use((req, res, next) => {
  if (!isCodexV2Enabled()) return res.status(404).json({ error: 'not_found' });
  next();
});

router.post(
  '/projects',
  authenticateToken,
  [body('name').isString().withMessage('name must be a string').bail().trim().isLength({ min: 1, max: 80 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    try {
      const project = await projectService.createProject({
        userId: req.user.id,
        name: req.body.name.trim(),
        brief: req.body.brief ?? null,
      });
      return res.status(201).json({ project });
    } catch (err) {
      return res.status(500).json({ error: 'codex_create_failed', message: err.message });
    }
  },
);

router.get('/projects', authenticateToken, async (req, res) => {
  try {
    return res.json({ projects: await projectService.listProjects({ userId: req.user.id }) });
  } catch (err) {
    return res.status(500).json({ error: 'codex_list_failed', message: err.message });
  }
});

router.get('/projects/:id', authenticateToken, async (req, res) => {
  try {
    const project = await projectService.getProject({ userId: req.user.id, id: req.params.id });
    if (!project) return res.status(404).json({ error: 'project_not_found' });
    return res.json({ project });
  } catch (err) {
    return res.status(500).json({ error: 'codex_get_failed', message: err.message });
  }
});

// Ownership gate compartido por las rutas de preview.
async function loadOwnedProject(req, res) {
  const project = await projectService.getProject({ userId: req.user.id, id: req.params.id });
  if (!project) {
    res.status(404).json({ error: 'project_not_found' });
    return null;
  }
  return project;
}

router.post('/projects/:id/preview/start', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProject(req, res);
    if (!project) return undefined;
    const out = await createRunnerClient().startDev(project.id);
    return res.json({ ...out, devUrl: runnerDevUrl() });
  } catch (err) {
    return res.status(502).json({ error: 'runner_unreachable', message: err.message });
  }
});

router.get('/projects/:id/preview/status', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProject(req, res);
    if (!project) return undefined;
    const out = await createRunnerClient().devStatus();
    return res.json({ ...out, devUrl: runnerDevUrl() });
  } catch (err) {
    return res.status(502).json({ error: 'runner_unreachable', message: err.message });
  }
});

router.post('/projects/:id/preview/stop', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProject(req, res);
    if (!project) return undefined;
    await createRunnerClient().stopDev();
    return res.json({ ok: true });
  } catch (err) {
    return res.status(502).json({ error: 'runner_unreachable', message: err.message });
  }
});

module.exports = router;

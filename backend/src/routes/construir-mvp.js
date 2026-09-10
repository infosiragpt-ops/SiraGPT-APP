'use strict';

/**
 * CONSTRUIR coding MVP HTTP surface.
 *
 *   GET  /api/construir-mvp/health  → always 200, no AGENTES_CODING_V2 required
 *   POST /api/construir-mvp         → scaffold + artifacts (+ optional GitHub)
 *
 * Flag AGENTES_CODING_V2 stays OFF. This path uses create_artifact storage
 * and the existing GitHub OAuth account.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { isAgentesCodingV2Enabled } = require('../services/agentes-coding/flags');
const mvp = require('../services/construir-mvp');

function createConstruirMvpRouter(deps = {}) {
  const router = express.Router();
  const deliver = deps.deliver || mvp.deliverConstruirProject;
  const publishLast = deps.publishLast || mvp.publishLastProject;

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      enabled: true,
      flagRequired: false,
      agentesCodingV2: isAgentesCodingV2Enabled(deps.env || process.env),
      brandAliases: ['Sira Rápido', 'Sira Pro'],
    });
  });

  router.post(
    '/',
    authenticateToken,
    [
      body('prompt').isString().trim().isLength({ min: 1, max: 4000 }),
      body('chatId').optional().isString().trim().isLength({ max: 80 }),
      body('title').optional().isString().trim().isLength({ max: 72 }),
      body('modelAlias').optional().isString().trim().isLength({ max: 80 }),
      body('publishGithub').optional().isBoolean(),
      body('approved').optional().isBoolean(),
      body('repoName').optional().isString().trim().isLength({ max: 100 }),
      body('branch').optional().isString().trim().isLength({ max: 80 }),
      body('html').optional().isString().isLength({ max: 300_000 }),
    ],
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'validation_failed', details: errors.array() });
      }
      try {
        const out = await deliver({
          prompt: req.body.prompt,
          title: req.body.title,
          html: req.body.html,
          chatId: req.body.chatId,
          userId: req.user && req.user.id,
          modelAlias: req.body.modelAlias || req.body.model,
          publishGithub: req.body.publishGithub === true,
          approved: req.body.approved === true,
          repoName: req.body.repoName,
          branch: req.body.branch,
          saveArtifact: deps.saveArtifact,
          fetchImpl: deps.fetchImpl,
          resolveToken: deps.resolveToken,
          env: deps.env || process.env,
        });
        return res.json(out);
      } catch (err) {
        console.error('[construir-mvp]', err && err.message);
        return res.status(500).json({ error: 'construir_failed' });
      }
    },
  );

  router.post(
    '/github',
    authenticateToken,
    [
      body('chatId').optional().isString().trim().isLength({ max: 80 }),
      body('repoName').optional().isString().trim().isLength({ max: 100 }),
      body('branch').optional().isString().trim().isLength({ max: 80 }),
      body('approved').isBoolean(),
    ],
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'validation_failed', details: errors.array() });
      }
      try {
        const out = await publishLast({
          userId: req.user && req.user.id,
          chatId: req.body.chatId,
          repoName: req.body.repoName,
          branch: req.body.branch,
          approved: req.body.approved === true,
          fetchImpl: deps.fetchImpl,
          resolveToken: deps.resolveToken,
        });
        const status = out.ok ? 200 : (out.code === 'E_GITHUB_CONNECT' ? 409 : 400);
        return res.status(status).json(out);
      } catch (err) {
        console.error('[construir-mvp] github', err && err.message);
        return res.status(500).json({ error: 'github_publish_failed' });
      }
    },
  );

  return router;
}

module.exports = createConstruirMvpRouter();
module.exports.createConstruirMvpRouter = createConstruirMvpRouter;

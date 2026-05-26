/**
 * artifacts routes — generate interactive visualizations.
 *
 * Mounted at /api/artifacts.
 *
 * Endpoints:
 *   POST /generate     — produce an artifact from a prompt (+ optional
 *                        image description). Returns { title, description,
 *                        html, refused?, reason? }.
 *   POST /detect-intent — cheap classifier: "is this a visualization
 *                        request?" Useful for the chat flow to decide
 *                        whether to swap the normal LLM call for the
 *                        artifact generator.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const rag = require('../services/rag-service');
const { generate, isArtifactRequest } = require('../services/artifacts/artifact-generator');

const router = express.Router();

router.post(
  '/generate',
  authenticateToken,
  [
    body('request').isString().isLength({ min: 1, max: 4000 }),
    body('imageDescription').optional().isString().isLength({ max: 4000 }),
    body('model').optional().isString().isLength({ max: 64 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const openai = rag.getOpenAI();
    if (!openai) return res.status(503).json({ error: 'OPENAI_API_KEY not configured' });

    try {
      const result = await generate({
        openai,
        userRequest: req.body.request,
        imageDescription: req.body.imageDescription,
        model: req.body.model,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[artifacts/generate] failed:', err);
      res.status(500).json({ error: err.message || 'generation failed' });
    }
  }
);

router.post(
  '/detect-intent',
  authenticateToken,
  [body('text').isString().isLength({ min: 1, max: 4000 })],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    res.json({ ok: true, isArtifact: isArtifactRequest(req.body.text) });
  }
);

module.exports = router;

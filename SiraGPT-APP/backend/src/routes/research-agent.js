'use strict';

/**
 * research-agent route — autonomous research loop (Manus-like).
 *
 *   POST /api/research-agent/run
 *     body: { query, depth?: 'quick'|'standard'|'deep', maxSteps?, providers?[] }
 *     →    { query, report, findings, papers, queriesTried, stats }
 *
 *   POST /api/research-agent/stream  (SSE)
 *     Same body as /run. Streams the agent's phase / paper / page / finding /
 *     decision events as they happen, then a final 'report' event.
 *
 * Auth: requires authenticateToken. The loop calls vision LLMs + opens a
 * headless browser, so anonymous traffic would burn compute fast.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const researchAgent = require('../services/research-agent');

const router = express.Router();

const validators = [
  body('query').isString().trim().isLength({ min: 3, max: 500 })
    .withMessage('query must be 3-500 chars'),
  body('depth').optional().isIn(['quick', 'standard', 'deep']),
  body('maxSteps').optional().isInt({ min: 1, max: 12 }),
  body('providers').optional().isArray({ max: 7 }),
];

router.post('/run', authenticateToken, validators, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_failed', details: errors.array() });
  const { query, depth, maxSteps, providers } = req.body;
  try {
    const result = await researchAgent.run({ query, depth, maxSteps, providers });
    res.json(result);
  } catch (err) {
    console.error('[research-agent] uncaught:', err);
    res.status(500).json({ error: 'research_agent_failed', message: err.message });
  }
});

router.post('/stream', authenticateToken, validators, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_failed', details: errors.array() });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  function send(event) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  const { query, depth, maxSteps, providers } = req.body;
  try {
    send({ type: 'start', query });
    const result = await researchAgent.run({
      query, depth, maxSteps, providers,
      onEvent: (e) => send(e),
    });
    send({ type: 'done', stats: result.stats });
  } catch (err) {
    send({ type: 'error', message: err.message });
  } finally {
    res.end();
  }
});

module.exports = router;

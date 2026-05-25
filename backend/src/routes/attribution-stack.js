'use strict';

/**
 * /api/attribution-stack — single endpoint that runs the entire
 * attribution stack via attribution-stack-runner and returns the
 * unified bundle. Complements /api/attribution-toolkit (per-module)
 * and /api/attribution-explainer (UI summaries) — this is the
 * one-call surface for external integrators.
 *
 * Routes:
 *   POST /run         — full pipeline
 *   POST /run-light   — skips snapshot + provenance for fast UI calls
 *   GET  /health      — module load + per-stage rolling perf stats
 */

const express = require('express');
const { optionalAuth } = require('../middleware/optionalAuth');
const stackRunner = require('../services/attribution-stack-runner');
let perf = null;
try { perf = require('../services/attribution-performance-profiler'); } catch (_) { /* optional */ }

const router = express.Router();
const MAX_PROMPT = 8_000;
const MAX_RESPONSE = 60_000;

const userIdFrom = (req) => req.user?.id || req.body?.userId || null;
const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');

router.post('/run', optionalAuth, async (req, res) => {
  try {
    const prompt = clip(req.body?.prompt, MAX_PROMPT);
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    const bundle = await stackRunner.run({
      userId: userIdFrom(req),
      chatId: req.body?.chatId || null,
      turnIndex: Number(req.body?.turnIndex) || 0,
      prompt,
      history: Array.isArray(req.body?.history) ? req.body.history.slice(0, 32) : [],
      files: Array.isArray(req.body?.files) ? req.body.files.slice(0, 16) : [],
      memories: Array.isArray(req.body?.memories) ? req.body.memories.slice(0, 16) : [],
      ragSnippets: Array.isArray(req.body?.ragSnippets) ? req.body.ragSnippets.slice(0, 12) : [],
      response: clip(req.body?.response, MAX_RESPONSE),
      opts: req.body?.opts || {},
    });
    return res.json(bundle);
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'stack run failed' });
  }
});

router.post('/run-light', optionalAuth, async (req, res) => {
  try {
    const prompt = clip(req.body?.prompt, MAX_PROMPT);
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    const bundle = await stackRunner.run({
      userId: userIdFrom(req),
      chatId: req.body?.chatId || null,
      turnIndex: Number(req.body?.turnIndex) || 0,
      prompt,
      history: Array.isArray(req.body?.history) ? req.body.history.slice(0, 16) : [],
      opts: { ...(req.body?.opts || {}), stamp: false },
    });
    return res.json(bundle);
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'stack run failed' });
  }
});

router.get('/health', (_req, res) => {
  let stats = null;
  if (perf?.getAggregateStats) {
    try {
      stats = perf.getAggregateStats()
        .filter((row) => row.label && row.label.startsWith('stack.'))
        .slice(0, 12);
    } catch (_) { stats = null; }
  }
  return res.json({ ok: true, modules: { stackRunner: !!stackRunner, perf: !!perf }, perfStats: stats });
});

module.exports = router;

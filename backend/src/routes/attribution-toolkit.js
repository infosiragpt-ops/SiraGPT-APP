'use strict';

/**
 * /api/attribution-toolkit — unified REST surface for the new
 * attribution stack modules that don't have their own routes yet.
 *
 * Endpoints:
 *   POST /anomaly/observe         — record a profile sample for the user
 *   POST /anomaly/score           — score the current profile vs baseline
 *   GET  /anomaly/baseline        — return the user's rolling baseline
 *
 *   POST /rollup/record           — record a TurnSample
 *   GET  /rollup                  — aggregate rollup with optional filters
 *   GET  /rollup/recent           — recent N samples
 *
 *   POST /fuzzer/variants         — generate prompt perturbations
 *   POST /fuzzer/stability        — probe stability with a JS scorer surrogate
 *
 *   POST /cross-modal/attribute   — attribute a response back to file regions
 *
 *   POST /domain/detect           — detect domain + return calibration
 *   GET  /domain/list             — list every supported domain
 *
 *   POST /reflection              — run self-reflection loop verdict
 *
 *   POST /visualize/mermaid       — graph → Mermaid flowchart text
 *   POST /visualize/cytoscape     — graph → cytoscape.js JSON
 *   POST /visualize/json          — graph → compact JSON
 *
 *   POST /compare/graphs          — diff two attribution graphs
 *
 *   GET  /perf/aggregate          — per-stage rolling p50/p95 latency
 *   POST /perf/reset              — clear performance aggregate buffer
 *
 *   GET  /health                  — module load + sample counts snapshot
 *
 * Auth: optional. Per-user operations require an authenticated user; the
 * identity is taken from the auth token only — never from a caller-supplied
 * userId — to prevent cross-user reads/writes of attribution telemetry.
 */

const express = require('express');
const { optionalAuth } = require('../middleware/optionalAuth');

const anomaly = require('../services/attribution-anomaly-detector');
const rollup = require('../services/attribution-rollup-aggregator');
const fuzzer = require('../services/attribution-prompt-fuzzer');
const crossModal = require('../services/cross-modal-attribution');
const domain = require('../services/domain-calibration');
const reflection = require('../services/self-reflection-loop');
const viz = require('../services/attribution-graph-visualizer');
const comparator = require('../services/attribution-graph-comparator');
const perf = require('../services/attribution-performance-profiler');

const router = express.Router();
const MAX_PROMPT = 8_000;
const MAX_RESPONSE = 60_000;

function userIdFrom(req) {
  return req.user?.id || null;
}

function safeText(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

// ─── anomaly detector ─────────────────────────────────────────────
router.post('/anomaly/observe', optionalAuth, (req, res) => {
  try {
    const userId = userIdFrom(req);
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (!req.body?.profile) return res.status(400).json({ error: 'profile required' });
    anomaly.observe({ userId, profile: req.body.profile });
    return res.json({ ok: true, baseline: anomaly.getBaseline(userId) });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'anomaly observe failed' });
  }
});

router.post('/anomaly/score', optionalAuth, (req, res) => {
  try {
    const userId = userIdFrom(req);
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (!req.body?.profile) return res.status(400).json({ error: 'profile required' });
    const score = anomaly.score({ userId, profile: req.body.profile });
    const block = anomaly.buildAnomalyBlock(score);
    return res.json({ ...score, block });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'anomaly score failed' });
  }
});

router.get('/anomaly/baseline', optionalAuth, (req, res) => {
  try {
    const userId = userIdFrom(req);
    if (!userId) return res.status(400).json({ error: 'userId required' });
    return res.json({ baseline: anomaly.getBaseline(userId) || null });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'baseline lookup failed' });
  }
});

// ─── rollup aggregator ────────────────────────────────────────────
router.post('/rollup/record', optionalAuth, (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'sample object required' });
    // Never trust a caller-supplied userId — attribute the sample to the
    // authenticated user only (undefined when anonymous, so record() treats
    // it as an unattributed sample rather than poisoning another user's rollup).
    rollup.record({ ...req.body, userId: userIdFrom(req) || undefined });
    return res.json({ ok: true, stats: rollup.stats() });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'rollup record failed' });
  }
});

router.get('/rollup', optionalAuth, (req, res) => {
  try {
    const scope = req.query?.scope === 'user' ? 'user' : 'all';
    const userId = userIdFrom(req);
    const sinceMs = Number(req.query?.sinceMs) || null;
    const report = rollup.rollup({ scope, userId, sinceMs });
    return res.json(report);
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'rollup failed' });
  }
});

router.get('/rollup/recent', optionalAuth, (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query?.limit) || 32));
    return res.json({ samples: rollup.listRecent({ limit }) });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'rollup recent failed' });
  }
});

// ─── prompt fuzzer ────────────────────────────────────────────────
router.post('/fuzzer/variants', optionalAuth, (req, res) => {
  try {
    const prompt = safeText(req.body?.prompt, MAX_PROMPT);
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    const variants = fuzzer.generateVariants(prompt, req.body?.opts || {});
    return res.json({ variants });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'variants failed' });
  }
});

router.post('/fuzzer/stability', optionalAuth, (req, res) => {
  try {
    const prompt = safeText(req.body?.prompt, MAX_PROMPT);
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    // Surrogate scorer: detect domain + use it as a stand-in for primary
    // intent so callers can probe stability without wiring their own
    // scorer. Returns a stable result if the prompt's domain stays
    // constant across variants.
    const scorerFn = (variant) => {
      const cal = domain.getCalibrationFor(variant);
      return {
        primaryIntent: cal.detected?.domain || 'general',
        centroid: { feature: 0.5, intent: 0.5 },
      };
    };
    const report = fuzzer.probeStability({ prompt, scorerFn, opts: req.body?.opts || {} });
    return res.json(report);
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'stability failed' });
  }
});

// ─── cross-modal citations ────────────────────────────────────────
router.post('/cross-modal/attribute', optionalAuth, (req, res) => {
  try {
    const response = safeText(req.body?.response, MAX_RESPONSE);
    if (!response) return res.status(400).json({ error: 'response required' });
    const regions = Array.isArray(req.body?.regions) ? req.body.regions.slice(0, 96) : [];
    const report = crossModal.attribute({ regions, response, opts: req.body?.opts || {} });
    const block = crossModal.buildCitationBlock(report);
    return res.json({ ...report, block });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'attribute failed' });
  }
});

// ─── domain calibration ───────────────────────────────────────────
router.post('/domain/detect', optionalAuth, (req, res) => {
  try {
    const text = safeText(req.body?.text || req.body?.prompt, MAX_PROMPT);
    if (!text) return res.status(400).json({ error: 'text required' });
    const calibration = domain.getCalibrationFor(text);
    const block = domain.buildCalibrationBlock(calibration.domain);
    return res.json({ ...calibration, block });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'detect failed' });
  }
});

router.get('/domain/list', (_req, res) => {
  return res.json({ domains: domain.listDomains() });
});

// ─── self-reflection loop ─────────────────────────────────────────
router.post('/reflection', optionalAuth, (req, res) => {
  try {
    const draft = safeText(req.body?.draft, MAX_RESPONSE);
    if (!draft) return res.status(400).json({ error: 'draft required' });
    const verdict = reflection.reflect({
      draft,
      faithfulnessScore: req.body?.faithfulnessScore || null,
      plan: req.body?.plan || null,
      report: req.body?.report || null,
      retryCount: Number(req.body?.retryCount) || 0,
      opts: req.body?.opts || {},
    });
    return res.json(verdict);
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'reflection failed' });
  }
});

// ─── visualizers ──────────────────────────────────────────────────
router.post('/visualize/mermaid', optionalAuth, (req, res) => {
  try {
    return res.json({ mermaid: viz.toMermaid(req.body?.graph, req.body?.opts || {}) });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'mermaid failed' });
  }
});

router.post('/visualize/cytoscape', optionalAuth, (req, res) => {
  try {
    return res.json(viz.toCytoscape(req.body?.graph, req.body?.opts || {}));
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'cytoscape failed' });
  }
});

router.post('/visualize/json', optionalAuth, (req, res) => {
  try {
    return res.json(viz.toCompactJSON(req.body?.graph, req.body?.opts || {}));
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'json failed' });
  }
});

// ─── graph comparator ─────────────────────────────────────────────
router.post('/compare/graphs', optionalAuth, (req, res) => {
  try {
    const graphA = req.body?.graphA;
    const graphB = req.body?.graphB;
    if (!graphA || !graphB) return res.status(400).json({ error: 'graphA and graphB required' });
    const report = comparator.compareGraphs(graphA, graphB, req.body?.opts || {});
    return res.json({
      ...report,
      summary: comparator.buildDiffSummary(report),
      block: comparator.buildDiffBlock(report),
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'compare failed' });
  }
});

// ─── perf profiler ────────────────────────────────────────────────
router.get('/perf/aggregate', (req, res) => {
  try {
    const label = typeof req.query?.label === 'string' ? req.query.label : null;
    return res.json({ stats: perf.getAggregateStats(label || undefined) });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'perf failed' });
  }
});

router.post('/perf/reset', optionalAuth, (req, res) => {
  try {
    const label = typeof req.body?.label === 'string' ? req.body.label : null;
    perf.resetAggregates(label);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'perf reset failed' });
  }
});

// ─── health ───────────────────────────────────────────────────────
router.get('/health', (_req, res) => {
  return res.json({
    ok: true,
    modules: {
      anomaly: !!anomaly,
      rollup: !!rollup,
      fuzzer: !!fuzzer,
      crossModal: !!crossModal,
      domain: !!domain,
      reflection: !!reflection,
      visualizer: !!viz,
      comparator: !!comparator,
      perf: !!perf,
    },
    counts: {
      anomalyUsers: anomaly.stats().users,
      rollupSamples: rollup.stats().samples,
      perfLabels: perf.getAggregateStats().length,
    },
  });
});

module.exports = router;

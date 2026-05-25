'use strict';

/**
 * /api/free-ia — small public-friendly endpoint exposing the Free IA
 * (Cerebras Llama 3.1 8B) availability state.
 *
 *   GET /api/free-ia/status — returns whether Free IA is configured,
 *   the model id, the display name, and the provider. Frontend uses
 *   this to:
 *     1. Render a "Free IA disponible" badge on the model picker.
 *     2. Decide whether to keep the user's selected model sticky on
 *        credit exhaustion (per the spec — never auto-switch the UI).
 *     3. Surface the brand name when the LLM gateway falls back.
 *
 * Public — no auth required. Returns only non-secret fields (no API
 * key, no base URL is leaked).
 */

const express = require('express');
const router = express.Router();

const { authenticateToken, requireAdmin } = require('../middleware/auth');
const {
  getCerebrasConfig,
  isFreeIaConfigured,
} = require('../services/ai/cerebras-client');
const freeIaMetrics = require('../services/free-ia-metrics');

router.get('/status', (_req, res) => {
  const cfg = getCerebrasConfig();
  res.json({
    enabled: cfg.enabled,
    reason: cfg.reason,
    model: cfg.model,
    displayName: cfg.displayName,
    provider: cfg.provider,
    // baseURL deliberately omitted — internal-only detail.
  });
});

router.get('/configured', (_req, res) => {
  res.json({ configured: isFreeIaConfigured() });
});

// Lightweight liveness/readiness probe — friendly to k8s/load-balancer
// healthchecks. 200 OK when Free IA is wired and the upstream success
// rate (if any data) is above 0.5; 503 otherwise. No external network
// call — purely a config + counter check so the probe is fast and
// can't itself fail due to a network blip.
router.get('/health', (_req, res) => {
  const enabled = isFreeIaConfigured();
  if (!enabled) {
    return res.status(503).json({
      ok: false,
      enabled: false,
      reason: 'not_configured',
    });
  }
  const sum = freeIaMetrics.summary();
  // When we have enough samples, treat sub-50% upstream success as
  // degraded so the LB takes the instance out of rotation.
  const degraded = sum.upstreamTotal >= 10 && sum.successRate !== null && sum.successRate < 0.5;
  return res.status(degraded ? 503 : 200).json({
    ok: !degraded,
    enabled: true,
    fallbacks: sum.fallbacks,
    upstreamSuccess: sum.upstreamSuccess,
    upstreamTotal: sum.upstreamTotal,
    successRate: sum.successRate,
    degraded,
  });
});

// Ops visibility — how often the silent fallback fires per feature.
// JSON shape for dashboards, Prometheus text for scraping.
router.get('/metrics', (_req, res) => {
  res.json(freeIaMetrics.snapshot());
});

// One-line digest for status badges / health dashboards.
router.get('/metrics/summary', (_req, res) => {
  res.json(freeIaMetrics.summary());
});

router.get('/metrics.prom', (_req, res) => {
  res.type('text/plain; version=0.0.4');
  res.send(freeIaMetrics.toPrometheusText());
});

// Admin-only — reset the counter. Useful for ops drills and after an
// incident postmortem so the dashboard starts fresh. Returns the
// snapshot from BEFORE the reset so the caller can archive it.
router.post('/metrics/reset', authenticateToken, requireAdmin, (req, res) => {
  const before = freeIaMetrics.snapshot();
  freeIaMetrics.reset();
  res.json({
    reset: true,
    before,
    by: req.user?.email || req.user?.id || 'unknown',
    at: new Date().toISOString(),
  });
});

module.exports = router;

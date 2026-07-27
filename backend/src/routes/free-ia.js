'use strict';

/**
 * /api/free-ia — public endpoints exposing the Free IA (Cerebras
 * Llama 3.1 8B) availability state, metrics, and health.
 *
 * Endpoint inventory:
 *
 *   GET  /api/free-ia/status          — config + display name + brand
 *                                       (public, no auth)
 *   GET  /api/free-ia/configured      — bare boolean, for cheap checks
 *                                       (public)
 *   GET  /api/free-ia/health          — k8s liveness/readiness probe.
 *                                       200 when configured + healthy;
 *                                       503 when not configured OR when
 *                                       >=10 upstream samples show
 *                                       <50% success.
 *   GET  /api/free-ia/metrics         — redacted JSON summary for dashboards
 *                                       (fallbacks, upstream, timestamps).
 *   GET  /api/free-ia/metrics/summary — one-line digest + degraded flag,
 *                                       for status badges.
 *   GET  /api/free-ia/metrics.prom    — protected alias of the unified
 *                                       Prometheus text exposition.
 *   POST /api/free-ia/metrics/reset   — admin-only counter reset, returns
 *                                       the pre-reset snapshot as audit
 *                                       trail.
 *
 * What the frontend uses these for:
 *   1. Render a "Free IA disponible" badge on the model picker.
 *   2. Keep the user's selected model sticky on credit exhaustion (per
 *      the spec — never auto-switch the UI); show a fallback banner
 *      when the x-sira-fallback header arrives instead.
 *   3. Surface the brand name when the LLM gateway falls back.
 *   4. Show a degraded-mode badge when /health flips to 503.
 *
 * Security: API key and base URL never appear in any response. Prometheus
 * exposition uses the shared operational metrics access policy.
 */

const express = require('express');
const router = express.Router();

const { authenticateToken, requireAdmin } = require('../middleware/auth');
const {
  getCerebrasConfig,
  isFreeIaConfigured,
  buildFreeIaModelDescriptor,
  getFreeIaPricing,
  DEFAULT_DISPLAY_NAME,
  DEFAULT_MODEL,
  PROVIDER_NAME,
} = require('../services/ai/cerebras-client');
const freeIaMetrics = require('../services/free-ia-metrics');
const {
  metricsHandler,
} = require('../services/observability/metrics-exposition');
const fce = require('../services/feature-cost-estimator');
const { userQuotaDigest } = require('../services/model-quota-router');
const prisma = require('../config/database');

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

// Brand constants for frontend localisation / hardcoded labels (e.g. a
// /loading screen that needs the brand name before /status responds).
router.get('/brand', (_req, res) => {
  // family derived from DEFAULT_MODEL for picker grouping consistency
  // with /info → descriptor.family.
  let family = 'unknown';
  try {
    // eslint-disable-next-line global-require
    const { inferModelFamily } = require('../services/ai/cerebras-client');
    family = inferModelFamily(DEFAULT_MODEL);
  } catch { /* best-effort */ }
  res.json({
    displayName: DEFAULT_DISPLAY_NAME,
    defaultModel: DEFAULT_MODEL,
    provider: PROVIDER_NAME,
    family,
  });
});

// Endpoint inventory for /info autodiscovery. Kept here (not derived
// from Express's router stack) so the metadata stays explicit and the
// payload doesn't drift if Express changes its internals.
const ENDPOINT_INVENTORY = Object.freeze([
  { method: 'GET',  path: '/api/free-ia/status',           auth: 'public', returns: 'config + brand' },
  { method: 'GET',  path: '/api/free-ia/configured',       auth: 'public', returns: 'boolean' },
  { method: 'GET',  path: '/api/free-ia/brand',            auth: 'public', returns: 'brand constants' },
  { method: 'GET',  path: '/api/free-ia/health',           auth: 'public', returns: '200 OK / 503 degraded' },
  { method: 'GET',  path: '/api/free-ia/info',             auth: 'public', returns: 'consolidated view' },
  { method: 'GET',  path: '/api/free-ia/metrics',          auth: 'public', returns: 'redacted JSON summary' },
  { method: 'GET',  path: '/api/free-ia/metrics/summary',  auth: 'public', returns: 'one-line digest (?format=text for plain)' },
  { method: 'GET',  path: '/api/free-ia/metrics/badge',    auth: 'public', returns: '{ fallbacks, healthy } or 204' },
  { method: 'GET',  path: '/api/free-ia/metrics.prom',     auth: 'ops',    returns: 'unified protected Prometheus exposition' },
  { method: 'POST', path: '/api/free-ia/metrics/reset',    auth: 'admin',  returns: 'pre-reset snapshot' },
]);

// Consolidated view for the model picker's first paint — one round-trip
// instead of /status + /metrics/summary + /health + pricing.
router.get('/info', (_req, res) => {
  const cfg = getCerebrasConfig();
  const sum = freeIaMetrics.summary();
  // Pattern-count breakdown for the marketing/debug surface — done in
  // a best-effort try/catch so a humanizer load failure can't break
  // /info.
  let humanizerCoverage = null;
  try {
    // eslint-disable-next-line global-require
    const { countAITellPatternsByLanguage } = require('../services/paraphrase-humanizer');
    humanizerCoverage = countAITellPatternsByLanguage();
  } catch { /* best-effort */ }
  res.json({
    enabled: cfg.enabled,
    reason: cfg.reason,
    model: cfg.model,
    displayName: cfg.displayName,
    provider: cfg.provider,
    descriptor: buildFreeIaModelDescriptor(),
    pricing: getFreeIaPricing(),
    health: {
      ok: cfg.enabled && !sum.degraded,
      degraded: sum.degraded,
    },
    summary: sum,
    humanizer: humanizerCoverage ? { tellsByLanguage: humanizerCoverage } : null,
    endpoints: ENDPOINT_INVENTORY,
  });
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
  // `summary.degraded` is the single source of truth for both the LB
  // probe (503) and any UI badge — keeps health and dashboards aligned.
  return res.status(sum.degraded ? 503 : 200).json({
    ok: !sum.degraded,
    enabled: true,
    fallbacks: sum.fallbacks,
    upstreamSuccess: sum.upstreamSuccess,
    upstreamTotal: sum.upstreamTotal,
    successRate: sum.successRate,
    degraded: sum.degraded,
  });
});

// Ops visibility — how often the silent fallback fires per feature.
// JSON shape for dashboards, Prometheus text for scraping.
router.get('/metrics', (_req, res) => {
  res.json(freeIaMetrics.publicSnapshot());
});

// One-line digest for status badges / health dashboards.
// `?format=text` returns just the `.line` field as text/plain so shell
// scripts (`watch -n5 curl …/summary?format=text`) get a clean view.
router.get('/metrics/summary', (req, res) => {
  const sum = freeIaMetrics.summary();
  if (String(req.query?.format || '').toLowerCase() === 'text') {
    res.type('text/plain; charset=utf-8');
    return res.send(`${sum.line}\n`);
  }
  res.json(sum);
});

// Tiny variant for status badges — { fallbacks, healthy } or 204 when
// no events have fired yet (so the UI hides the chip entirely).
router.get('/metrics/badge', (_req, res) => {
  const c = freeIaMetrics.compactSummary();
  if (!c) return res.status(204).end();
  res.json(c);
});

router.get('/metrics.prom', metricsHandler);

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

// ── Billing / pricing preview ────────────────────────────────────────────
// Thin read endpoints over feature-cost-estimator (the helpers are pure +
// unit-tested). Documented in CLAUDE.md but previously unwired — the estimator
// module was fully orphaned.

router.get('/plans', (_req, res) => {
  res.json({ plans: fce.pricingTable(), popular: fce.POPULAR_PLAN });
});

router.get('/budget', (req, res) => {
  const maxUsd = Number(req.query.maxUsd);
  if (!Number.isFinite(maxUsd) || maxUsd < 0) {
    return res.status(400).json({ error: 'maxUsd must be a non-negative number' });
  }
  res.json({ maxUsd, plan: fce.findCheapestPlanForBudget(maxUsd) });
});

router.get('/compare', (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to plan names are required' });
  try {
    res.json({ comparison: fce.comparePlans(String(from), String(to)) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/affords', (req, res) => {
  const plan = String(req.query.plan || '');
  const feature = String(req.query.feature || '');
  if (!plan || !feature) return res.status(400).json({ error: 'plan and feature query params are required' });
  const usage = { calls: Number(req.query.calls) || 0, avgTextLength: Number(req.query.avgTextLength) || 0 };
  try {
    res.json({
      affords: fce.affordsFeature(plan, feature, usage),
      verdict: fce.explainBudgetVerdict(plan, feature, usage),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/faq', (_req, res) => {
  res.json({ faq: fce.pricingFAQEntries() });
});

router.post('/estimate', (req, res) => {
  const body = req.body || {};
  const format = String(req.query.format || '').toLowerCase();
  try {
    // Monthly projection export (csv / markdown) when a usage object is given.
    if ((format === 'csv' || format === 'markdown') && body.usage) {
      const projection = fce.estimateMonthlyCost(body.usage);
      const text = format === 'csv'
        ? fce.monthlyBreakdownAsCsv(projection)
        : fce.monthlyBreakdownAsMarkdown(projection);
      res.type(format === 'csv' ? 'text/csv' : 'text/markdown').send(text);
      return;
    }
    const items = Array.isArray(body.items) ? body.items : (Array.isArray(body) ? body : []);
    const batch = fce.estimateCostBatch(items);
    const upgrade = body.usage ? fce.recommendUpgradeFromUsage(body.usage, body.currentPlan) : null;
    res.json({ batch, upgrade });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/digest', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: 'user not found' });
    const digest = userQuotaDigest(user);
    res.json({ digest, planInfo: fce.enrichPlanWithPricing(user.plan) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

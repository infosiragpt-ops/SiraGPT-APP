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
 *   GET  /api/free-ia/metrics         — full JSON snapshot for dashboards
 *                                       (fallbacks, upstream, timestamps).
 *   GET  /api/free-ia/metrics/summary — one-line digest + degraded flag,
 *                                       for status badges.
 *   GET  /api/free-ia/metrics.prom    — Prometheus text exposition.
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
 * Security: API key and base URL never appear in any response.
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

// Per-user quota digest. Auth-required because it surfaces the user's
// own usage. Returns the userQuotaDigest projection (plan, premium pool
// %, fallback brand, daily-calls, inlined upgradeHint, inlined
// flashGptStatus) so the account panel renders from a single call.
router.get('/digest', authenticateToken, (req, res) => {
  try {
    // eslint-disable-next-line global-require
    const { userQuotaDigest } = require('../services/model-quota-router');
    res.json(userQuotaDigest(req.user));
  } catch (err) {
    res.status(500).json({ error: 'digest_failed', message: err && err.message });
  }
});

// Cost estimator — accept a batch of {feature, textLength} requests and
// return the per-item credit cost. Lets the UI render a "this will cost
// N credits" preview before the user confirms.
//
//   POST /api/free-ia/estimate
//   body: { items: [{feature, textLength?}, ...] }
//   → { estimates: [{feature, credits, breakdown}, ...] }
const express2 = require('express');
router.post('/estimate', express2.json({ limit: '32kb' }), (req, res) => {
  try {
    // eslint-disable-next-line global-require
    const { estimateCostBatch, estimateMonthlyCost, getRecommendedPlan, getCostDelta } = require('../services/feature-cost-estimator');
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const out = { estimates: estimateCostBatch(items) };
    // Optional projection: if the body includes a forecastUsage map,
    // also return the projected monthly spend + recommended plan.
    if (req.body && req.body.forecastUsage && typeof req.body.forecastUsage === 'object') {
      out.monthlyProjection = estimateMonthlyCost(req.body.forecastUsage);
      out.recommendedPlan = getRecommendedPlan(req.body.forecastUsage);
      // If the caller also tells us their current plan, include the
      // $ delta so the UI can render "upgrade to PRO_MAX (+$5/mo)".
      if (typeof req.body.currentPlan === 'string') {
        out.costDelta = getCostDelta(req.body.currentPlan, out.recommendedPlan.plan);
      }
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: 'estimate_failed', message: err && err.message });
  }
});

// Pricing-page data — returns every plan tier enriched with price
// label, budget label, and the unlimited flag. Public (no auth) so
// the marketing pricing table can render without a user session.
router.get('/plans', (_req, res) => {
  try {
    // eslint-disable-next-line global-require
    const { enrichPlanWithPricing, PLAN_PRICES_USD } = require('../services/feature-cost-estimator');
    const plans = Object.keys(PLAN_PRICES_USD).map((name) => enrichPlanWithPricing(name));
    res.json({ plans });
  } catch (err) {
    res.status(500).json({ error: 'plans_failed', message: err && err.message });
  }
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

// Bump whenever the /info response shape changes — clients use it
// to invalidate cached responses.
const SCHEMA_VERSION = 'v3.2';

/**
 * Deterministic short fingerprint of the API surface. Computed from
 * the endpoint inventory + schema version so a deploy that doesn't
 * actually change the surface produces the same fingerprint, and
 * client caches stay warm.
 */
function apiSurfaceFingerprint() {
  const sorted = ENDPOINT_INVENTORY
    .map((e) => `${e.method}:${e.path}:${e.auth}`)
    .sort()
    .join('|');
  const seed = `${SCHEMA_VERSION}|${sorted}`;
  // FNV-1a 32-bit — small, dep-free, stable across Node versions.
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Endpoint inventory for /info autodiscovery. Kept here (not derived
// from Express's router stack) so the metadata stays explicit and the
// payload doesn't drift if Express changes its internals.
const ENDPOINT_INVENTORY = Object.freeze([
  { method: 'GET',  path: '/api/free-ia/status',           auth: 'public', returns: 'config + brand' },
  { method: 'GET',  path: '/api/free-ia/configured',       auth: 'public', returns: 'boolean' },
  { method: 'GET',  path: '/api/free-ia/brand',            auth: 'public', returns: 'brand constants' },
  { method: 'GET',  path: '/api/free-ia/health',           auth: 'public', returns: '200 OK / 503 degraded' },
  { method: 'GET',  path: '/api/free-ia/info',             auth: 'public', returns: 'consolidated view' },
  { method: 'GET',  path: '/api/free-ia/digest',           auth: 'user',   returns: 'per-user quota digest (plan + fallback + hints)' },
  { method: 'GET',  path: '/api/free-ia/plans',            auth: 'public', returns: 'enriched plan list for pricing table' },
  { method: 'POST', path: '/api/free-ia/estimate',         auth: 'public', returns: 'batch cost estimates for {items: [{feature, textLength}]}' },
  { method: 'GET',  path: '/api/free-ia/metrics',          auth: 'public', returns: 'JSON snapshot' },
  { method: 'GET',  path: '/api/free-ia/metrics/summary',  auth: 'public', returns: 'one-line digest (?format=text for plain)' },
  { method: 'GET',  path: '/api/free-ia/metrics/badge',    auth: 'public', returns: '{ fallbacks, healthy } or 204' },
  { method: 'GET',  path: '/api/free-ia/metrics.prom',     auth: 'public', returns: 'Prometheus text exposition' },
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
    // Static fingerprint derived from the inventory + schema version;
    // lets the UI cache /info aggressively and invalidate only when
    // the surface actually changes.
    schemaVersion: SCHEMA_VERSION,
    apiFingerprint: apiSurfaceFingerprint(),
    // Cost estimates per feature for the "this will cost N credits"
    // preview the UI shows before the user confirms. Best-effort.
    featureCosts: (() => {
      try {
        // eslint-disable-next-line global-require
        const { listFeatures, estimateCost } = require('../services/feature-cost-estimator');
        const out = {};
        for (const f of listFeatures()) {
          const r = estimateCost(f, { textLength: 0 });
          if (r) out[f] = { minCredits: r.credits, perKChars: r.breakdown.perKChars };
        }
        return out;
      } catch { return null; }
    })(),
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
  res.json(freeIaMetrics.snapshot());
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
module.exports.apiSurfaceFingerprint = apiSurfaceFingerprint;
module.exports.SCHEMA_VERSION = SCHEMA_VERSION;
module.exports.ENDPOINT_INVENTORY = ENDPOINT_INVENTORY;

// Re-export the brand constants from the cerebras-client so callers
// can do `const { displayName } = require('./routes/free-ia')` without
// having to know the underlying service path. Lazy-evaluated so a
// missing client module doesn't break the route load.
Object.defineProperty(module.exports, 'BRAND', {
  enumerable: true,
  get() {
    try {
      // eslint-disable-next-line global-require
      const c = require('../services/ai/cerebras-client');
      return Object.freeze({
        displayName: c.DEFAULT_DISPLAY_NAME,
        provider: c.PROVIDER_NAME,
        defaultModel: c.DEFAULT_MODEL,
      });
    } catch { return null; }
  },
});

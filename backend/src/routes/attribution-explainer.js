'use strict';

/**
 * /api/attribution-explainer — user-facing explainability surface.
 *
 * Sister route to `/api/circuit-attribution` (which is diagnostic and
 * exposes the raw analysis bundle). This route is the *consumer-facing*
 * explainability surface: a UI panel can call /explain and get back a
 * compact, plain-language description of how the assistant understood
 * the user's last turn — which features fired, which contexts were
 * load-bearing, which themes the supernode merger discovered, and how
 * the per-turn saliency state currently looks.
 *
 * Endpoints:
 *   POST /explain    — run the full attribution stack on a prompt and
 *                      return a flattened, plain-language explanation
 *                      (intent, supernodes, salient features, budget).
 *   POST /supernodes — just the supernode merger over caller-supplied features
 *   POST /budget     — preview how the prompt-budget allocator would trim
 *                      a hypothetical systemBlocks list
 *   GET  /cache-stats — attribution-cache telemetry
 *   GET  /saliency/:chatId — current saliency classification for the
 *                            authenticated user's chat
 *   GET  /health     — liveness + module load status
 *
 * Auth: optional. /saliency/:chatId requires a userId; others are usable
 * by any caller (state-free).
 */

const express = require('express');
const { optionalAuth } = require('../middleware/optionalAuth');

const conceptExtractor = require('../services/concept-extractor');
const supernodeMerger = require('../services/attribution-supernode-merger');
const budgetAllocator = require('../services/prompt-budget-allocator');
const cache = require('../services/attribution-cache');

let saliencyTracker = null;
let intentAttributionGraph = null;
let contextAttributionEngine = null;
try { saliencyTracker = require('../services/saliency-decay-tracker'); } catch (_e) { /* optional */ }
try { intentAttributionGraph = require('../services/intent-attribution-graph'); } catch (_e) { /* optional */ }
try { contextAttributionEngine = require('../services/context-attribution-engine'); } catch (_e) { /* optional */ }

const router = express.Router();
const MAX_PROMPT_CHARS = 8_000;

function sanitizeFeatures(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 64).map((f) => ({
    kind: typeof f?.kind === 'string' ? f.kind.slice(0, 32) : 'feature',
    label: typeof f?.label === 'string' ? f.label.slice(0, 240) : (typeof f?.value === 'string' ? f.value.slice(0, 240) : ''),
    weight: typeof f?.weight === 'number' ? Math.max(0, Math.min(1, f.weight)) : 0.5,
    embedding: Array.isArray(f?.embedding) ? f.embedding.slice(0, 4096) : undefined,
  })).filter((f) => f.label);
}

function sanitizeBlocks(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 32).map((b) => ({
    kind: typeof b?.kind === 'string' ? b.kind.slice(0, 64) : 'block',
    text: typeof b?.text === 'string' ? b.text.slice(0, 60_000) : '',
    cacheable: !!b?.cacheable,
  }));
}

router.post('/explain', optionalAuth, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').slice(0, MAX_PROMPT_CHARS);
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    // 1. Run the engine for the canonical attribution bundle (if available).
    let bundle = null;
    if (contextAttributionEngine?.analyze) {
      try { bundle = contextAttributionEngine.analyze({ prompt }); } catch (_e) { bundle = null; }
    }

    // 2. Pull features from intent-attribution-graph if present, else
    //    fall back to concepts.
    let features = [];
    if (intentAttributionGraph?.analyzeIntent) {
      try {
        const iag = intentAttributionGraph.analyzeIntent(prompt);
        if (iag?.ok && Array.isArray(iag.features)) {
          features = iag.features.map((f) => ({
            kind: f.category || f.kind || 'feature',
            label: f.label || f.surface || f.value || '',
            weight: f.weight ?? f.confidence ?? 0.5,
          }));
        }
      } catch (_iagErr) { /* swallow */ }
    }
    if (features.length === 0) {
      const conceptResult = conceptExtractor.extractConcepts(prompt);
      features = (conceptResult.concepts || []).map((c) => ({
        kind: c.kind || c.type || 'concept',
        label: c.surface || c.normalized || c.label || '',
        weight: c.weight ?? 0.5,
      }));
    }

    // 3. Cluster features into supernodes.
    const merge = supernodeMerger.mergeFeatures(features);

    // 4. Plain-language explanation.
    const primary = bundle?.attribution?.summary?.topIntents?.[0] || null;
    const explanation = {
      intent: primary ? { text: primary.text || primary.kind, weight: primary.weight } : null,
      supernodes: merge.supernodes.slice(0, 6),
      singletonFeatures: merge.residuals.slice(0, 6),
      multiHopDepth: bundle?.multiHop?.depth ?? 0,
      planSteps: bundle?.plan?.nodes?.length ?? 0,
      language: bundle?.language || 'unknown',
      stats: {
        features: features.length,
        clusters: merge.stats.clusters,
        mergedPairs: merge.stats.mergedPairs,
        engineLatencyMs: bundle?.latencyMs ?? null,
        mergeLatencyMs: merge.stats.durationMs,
      },
    };
    return res.json(explanation);
  } catch (err) {
    console.error('[attribution-explainer/explain] failed:', err?.message || err);
    return res.status(500).json({ error: 'explain failed' });
  }
});

router.post('/supernodes', optionalAuth, async (req, res) => {
  try {
    const features = sanitizeFeatures(req.body?.features);
    if (features.length === 0) return res.status(400).json({ error: 'features array is required' });
    const merge = supernodeMerger.mergeFeatures(features, req.body?.options || {});
    return res.json({ ...merge, block: supernodeMerger.buildSupernodeBlock(merge) });
  } catch (err) {
    console.error('[attribution-explainer/supernodes] failed:', err?.message || err);
    return res.status(500).json({ error: 'supernode merge failed' });
  }
});

router.post('/budget', optionalAuth, async (req, res) => {
  try {
    const blocks = sanitizeBlocks(req.body?.blocks);
    if (blocks.length === 0) return res.status(400).json({ error: 'blocks array is required' });
    const budgetTokens = Number(req.body?.budgetTokens) || undefined;
    const allocation = budgetAllocator.allocate(blocks, { budgetTokens });
    const trimmed = budgetAllocator.applyAllocation(blocks, allocation);
    return res.json({
      allocation,
      trimmedBlocks: trimmed.map((b) => ({
        kind: b.kind,
        chars: typeof b.text === 'string' ? b.text.length : 0,
        trimmed: !!b.__trimmed,
      })),
      summary: budgetAllocator.buildBudgetSummaryLine(allocation),
    });
  } catch (err) {
    console.error('[attribution-explainer/budget] failed:', err?.message || err);
    return res.status(500).json({ error: 'budget preview failed' });
  }
});

router.get('/cache-stats', async (_req, res) => {
  return res.json(cache.stats());
});

router.get('/saliency/:chatId', optionalAuth, async (req, res) => {
  try {
    if (!saliencyTracker) return res.status(503).json({ error: 'saliency tracker not available' });
    const userId = req.user?.id || req.query?.userId;
    if (!userId) return res.status(400).json({ error: 'userId required (auth or ?userId=)' });
    const chatId = String(req.params.chatId || '').slice(0, 64);
    if (!chatId) return res.status(400).json({ error: 'chatId required' });
    const classification = saliencyTracker.classify({ userId: String(userId), chatId });
    const block = saliencyTracker.buildSaliencyBlock(classification);
    return res.json({ classification, block });
  } catch (err) {
    console.error('[attribution-explainer/saliency] failed:', err?.message || err);
    return res.status(500).json({ error: 'saliency lookup failed' });
  }
});

router.get('/health', async (_req, res) => {
  return res.json({
    ok: true,
    modules: {
      conceptExtractor: !!conceptExtractor,
      supernodeMerger: !!supernodeMerger,
      budgetAllocator: !!budgetAllocator,
      cache: !!cache,
      saliencyTracker: !!saliencyTracker,
      intentAttributionGraph: !!intentAttributionGraph,
      contextAttributionEngine: !!contextAttributionEngine,
    },
    cacheStats: cache.stats(),
    saliencyStats: saliencyTracker?.stats ? saliencyTracker.stats() : null,
  });
});

module.exports = router;

'use strict';

/**
 * /api/circuit-attribution — HTTP surface for the circuit-tracing-style
 * context understanding pipeline.
 *
 * Endpoints:
 *   POST /analyze        full bundle (concepts + multi-hop + plan + suppression + optional faithfulness)
 *   POST /concepts       just extract concepts from raw text
 *   POST /multi-hop      detect multi-hop resolution steps
 *   POST /plan           derive an execution plan
 *   POST /suppression    detect conflicts with prior user rules
 *   POST /faithfulness   score a generated response against context
 *   POST /postprocess    score + repair instruction
 *   POST /drift          observe topic drift between turns
 *   POST /entities/register   add entities from a turn
 *   GET  /entities       list tracked entities for a chat
 *   POST /entities/resolve    resolve a referential surface to a tracked entity
 *   GET  /metrics        snapshot of recent turn telemetry
 *   GET  /health         liveness + config snapshot
 *
 * Auth: optional. Anonymous callers may use everything except per-user
 * /entities surfaces (chatId required).
 */

const express = require('express');
const { optionalAuth } = require('../middleware/optionalAuth');
const conceptExtractor = require('../services/concept-extractor');
const contextAttributionEngine = require('../services/context-attribution-engine');
const multiHopReasoner = require('../services/multi-hop-reasoner');
const intentPlanner = require('../services/intent-planner');
const faithfulnessScorer = require('../services/faithfulness-scorer');
const faithfulnessPostprocessor = require('../services/faithfulness-postprocessor');
const suppressionDetector = require('../services/context-suppression-detector');
const driftMonitor = require('../services/concept-drift-monitor');
const entityTracker = require('../services/cross-turn-entity-tracker');
const metrics = require('../services/attribution-metrics');

const router = express.Router();

const MAX_PROMPT_CHARS = 8_000;
const MAX_RESPONSE_CHARS = 60_000;

function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 40).map((m) => {
    const role = String(m?.role || 'user').toLowerCase() === 'assistant' ? 'assistant' : 'user';
    const content = typeof m?.content === 'string' ? m.content : (typeof m?.text === 'string' ? m.text : '');
    if (!content) return null;
    return { role, content: content.slice(0, 4000), timestamp: Number(m?.timestamp) || undefined };
  }).filter(Boolean);
}

function sanitizeFiles(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 16).map((f) => ({
    id: f?.id ? String(f.id).slice(0, 96) : undefined,
    name: typeof f?.name === 'string' ? f.name.slice(0, 160) : undefined,
    text: typeof f?.text === 'string' ? f.text.slice(0, 4000) : undefined,
    summary: typeof f?.summary === 'string' ? f.summary.slice(0, 1600) : undefined,
    mimeType: typeof f?.mimeType === 'string' ? f.mimeType.slice(0, 80) : undefined,
    size: Number.isFinite(f?.size) ? f.size : undefined,
  })).filter((f) => f.text || f.summary || f.name);
}

function sanitizeMemories(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 16).map((m) => ({
    id: m?.id ? String(m.id).slice(0, 96) : undefined,
    fact: typeof m?.fact === 'string' ? m.fact.slice(0, 800) : (typeof m?.text === 'string' ? m.text.slice(0, 800) : ''),
    category: typeof m?.category === 'string' ? m.category.slice(0, 32) : 'general',
    tier: m?.tier === 'long_term' ? 'long_term' : 'short_term',
    strength: Number.isFinite(m?.strength) ? Math.max(0, Math.min(1, m.strength)) : 0.5,
  })).filter((m) => m.fact);
}

function sanitizeRagSnippets(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 16).map((s) => ({
    id: s?.id ? String(s.id).slice(0, 96) : undefined,
    text: typeof s?.text === 'string' ? s.text.slice(0, 4000) : (typeof s?.content === 'string' ? s.content.slice(0, 4000) : ''),
    score: Number.isFinite(s?.score) ? s.score : undefined,
    source: typeof s?.source === 'string' ? s.source.slice(0, 120) : undefined,
  })).filter((s) => s.text);
}

router.post('/analyze', optionalAuth, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').slice(0, MAX_PROMPT_CHARS);
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    const bundle = contextAttributionEngine.analyze({
      prompt,
      history: sanitizeHistory(req.body?.history),
      files: sanitizeFiles(req.body?.files),
      memories: sanitizeMemories(req.body?.memories),
      ragSnippets: sanitizeRagSnippets(req.body?.ragSnippets),
      userProfile: req.body?.userProfile && typeof req.body.userProfile === 'object' ? req.body.userProfile : null,
      draftResponse: typeof req.body?.draftResponse === 'string' ? req.body.draftResponse.slice(0, MAX_RESPONSE_CHARS) : null,
      options: req.body?.options || {},
    });
    try {
      metrics.record({
        userId: req.user?.id || null,
        chatId: req.body?.chatId || null,
        latencyMs: bundle.latencyMs,
        primaryIntent: bundle.attribution?.summary?.topIntents?.[0]?.text || null,
        intentConfidence: bundle.attribution?.summary?.topIntents?.[0]?.weight || 0,
        multiHopDepth: bundle.multiHop?.depth || 0,
        planNodes: bundle.plan?.nodes?.length || 0,
        suppressionConflicts: bundle.suppression?.conflicts?.length || 0,
        faithfulnessGrade: bundle.faithfulness?.grade || null,
        faithfulnessScore: bundle.faithfulness?.score ?? null,
        language: bundle.language,
      });
    } catch (_metricsErr) { /* swallow */ }
    return res.json({
      ok: true,
      language: bundle.language,
      concepts: bundle.concepts,
      attribution: { summary: bundle.attribution?.summary, block: bundle.attribution?.block },
      multiHop: { isMultiHop: bundle.multiHop?.isMultiHop, depth: bundle.multiHop?.depth, hops: bundle.multiHop?.hops, block: bundle.multiHop?.block },
      plan: { planRequired: bundle.plan?.planRequired, nodes: bundle.plan?.nodes, reasoning: bundle.plan?.reasoning, block: bundle.plan?.block },
      suppression: { hasConflicts: bundle.suppression?.hasConflicts, rules: bundle.suppression?.rules, conflicts: bundle.suppression?.conflicts, block: bundle.suppression?.block },
      faithfulness: bundle.faithfulness,
      systemPromptBlock: bundle.systemPromptBlock,
      latencyMs: bundle.latencyMs,
    });
  } catch (err) {
    console.error('[circuit-attribution/analyze] failed:', err?.message || err);
    return res.status(500).json({ error: 'analyze failed' });
  }
});

router.post('/concepts', optionalAuth, async (req, res) => {
  try {
    const text = String(req.body?.text || req.body?.prompt || '').slice(0, MAX_PROMPT_CHARS);
    if (!text) return res.status(400).json({ error: 'text is required' });
    return res.json(conceptExtractor.extractConcepts(text, { source: 'api' }));
  } catch (err) {
    console.error('[circuit-attribution/concepts] failed:', err?.message || err);
    return res.status(500).json({ error: 'concepts failed' });
  }
});

router.post('/multi-hop', optionalAuth, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').slice(0, MAX_PROMPT_CHARS);
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    const result = multiHopReasoner.detectHops({
      prompt,
      history: sanitizeHistory(req.body?.history),
      files: sanitizeFiles(req.body?.files),
      memories: sanitizeMemories(req.body?.memories),
    });
    return res.json({ ...result, block: multiHopReasoner.renderHopsBlock(result) });
  } catch (err) {
    console.error('[circuit-attribution/multi-hop] failed:', err?.message || err);
    return res.status(500).json({ error: 'multi-hop failed' });
  }
});

router.post('/plan', optionalAuth, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').slice(0, MAX_PROMPT_CHARS);
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    const plan = intentPlanner.buildPlan({
      prompt,
      history: sanitizeHistory(req.body?.history),
      files: sanitizeFiles(req.body?.files),
      memories: sanitizeMemories(req.body?.memories),
    });
    return res.json({ ...plan, block: intentPlanner.renderPlanBlock(plan) });
  } catch (err) {
    console.error('[circuit-attribution/plan] failed:', err?.message || err);
    return res.status(500).json({ error: 'plan failed' });
  }
});

router.post('/suppression', optionalAuth, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').slice(0, MAX_PROMPT_CHARS);
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    const result = suppressionDetector.analyze({
      prompt,
      history: sanitizeHistory(req.body?.history),
      memories: sanitizeMemories(req.body?.memories),
      userProfile: req.body?.userProfile && typeof req.body.userProfile === 'object' ? req.body.userProfile : null,
    });
    return res.json({ ...result, block: suppressionDetector.renderSuppressionBlock(result) });
  } catch (err) {
    console.error('[circuit-attribution/suppression] failed:', err?.message || err);
    return res.status(500).json({ error: 'suppression failed' });
  }
});

router.post('/faithfulness', optionalAuth, async (req, res) => {
  try {
    const response = String(req.body?.response || '').slice(0, MAX_RESPONSE_CHARS);
    if (!response) return res.status(400).json({ error: 'response is required' });
    const context = sanitizeRagSnippets(req.body?.context);
    const report = faithfulnessScorer.scoreFaithfulness({ response, context });
    return res.json({ ...report, block: faithfulnessScorer.renderFaithfulnessBlock(report) });
  } catch (err) {
    console.error('[circuit-attribution/faithfulness] failed:', err?.message || err);
    return res.status(500).json({ error: 'faithfulness failed' });
  }
});

router.post('/postprocess', optionalAuth, async (req, res) => {
  try {
    const response = String(req.body?.response || '').slice(0, MAX_RESPONSE_CHARS);
    if (!response) return res.status(400).json({ error: 'response is required' });
    const context = sanitizeRagSnippets(req.body?.context);
    const mode = req.body?.mode === 'regenerate' ? 'regenerate' : 'annotate';
    const threshold = Number.isFinite(req.body?.threshold) ? Number(req.body.threshold) : undefined;
    const result = faithfulnessPostprocessor.postprocess({ response, context, mode, threshold });
    return res.json(result);
  } catch (err) {
    console.error('[circuit-attribution/postprocess] failed:', err?.message || err);
    return res.status(500).json({ error: 'postprocess failed' });
  }
});

router.post('/drift', optionalAuth, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').slice(0, MAX_PROMPT_CHARS);
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    const userId = req.user?.id || req.body?.userId || null;
    const chatId = req.body?.chatId || null;
    const turnIndex = Number.isFinite(req.body?.turnIndex) ? req.body.turnIndex : 0;
    const result = driftMonitor.observe({ userId, chatId, turnIndex, prompt });
    return res.json({ ...result, block: driftMonitor.buildDriftBlock(result) });
  } catch (err) {
    console.error('[circuit-attribution/drift] failed:', err?.message || err);
    return res.status(500).json({ error: 'drift failed' });
  }
});

router.post('/entities/register', optionalAuth, async (req, res) => {
  try {
    const userId = req.user?.id || req.body?.userId || 'anon';
    const chatId = req.body?.chatId || 'default';
    const turnIndex = Number.isFinite(req.body?.turnIndex) ? req.body.turnIndex : 0;
    const role = req.body?.role === 'assistant' ? 'assistant' : 'user';
    const text = String(req.body?.text || '').slice(0, MAX_PROMPT_CHARS);
    const result = entityTracker.register({ userId, chatId, turnIndex, role, text });
    return res.json({ ok: true, entities: result });
  } catch (err) {
    console.error('[circuit-attribution/entities/register] failed:', err?.message || err);
    return res.status(500).json({ error: 'register failed' });
  }
});

router.get('/entities', optionalAuth, async (req, res) => {
  try {
    const userId = req.user?.id || req.query?.userId || 'anon';
    const chatId = req.query?.chatId || 'default';
    const limit = Number.isFinite(Number(req.query?.limit)) ? Number(req.query.limit) : 25;
    return res.json({ ok: true, entities: entityTracker.listEntities({ userId, chatId, limit }) });
  } catch (err) {
    console.error('[circuit-attribution/entities] failed:', err?.message || err);
    return res.status(500).json({ error: 'list entities failed' });
  }
});

router.post('/entities/resolve', optionalAuth, async (req, res) => {
  try {
    const userId = req.user?.id || req.body?.userId || 'anon';
    const chatId = req.body?.chatId || 'default';
    const surface = String(req.body?.surface || '').slice(0, 240);
    if (!surface) return res.status(400).json({ error: 'surface is required' });
    const ref = entityTracker.resolveReference({ userId, chatId, surface });
    return res.json({ ok: true, surface, resolved: ref });
  } catch (err) {
    console.error('[circuit-attribution/entities/resolve] failed:', err?.message || err);
    return res.status(500).json({ error: 'resolve failed' });
  }
});

router.get('/metrics', optionalAuth, async (req, res) => {
  try {
    const windowMs = Number.isFinite(Number(req.query?.windowMs)) ? Number(req.query.windowMs) : null;
    return res.json({ ok: true, snapshot: metrics.snapshot({ windowMs }), recordedCount: metrics.size() });
  } catch (err) {
    console.error('[circuit-attribution/metrics] failed:', err?.message || err);
    return res.status(500).json({ error: 'metrics failed' });
  }
});

router.get('/health', async (_req, res) => {
  return res.json({
    ok: true,
    metricsSize: metrics.size(),
    entityChats: entityTracker.stats().chats,
    entityCount: entityTracker.stats().entities,
    config: {
      maxPromptChars: MAX_PROMPT_CHARS,
      maxResponseChars: MAX_RESPONSE_CHARS,
      hardShiftThreshold: driftMonitor.HARD_SHIFT_THRESHOLD,
      softShiftThreshold: driftMonitor.SOFT_SHIFT_THRESHOLD,
      faithfulnessThreshold: faithfulnessPostprocessor.DEFAULT_THRESHOLD,
    },
  });
});

module.exports = router;

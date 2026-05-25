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
const attributionSuite = require('../services/attribution-suite');
const beliefTracker = require('../services/belief-state-tracker');
const safetyRouter = require('../services/refusal-safety-router');
const entityUnifier = require('../services/cross-language-entity-unifier');
const explainer = require('../services/attribution-explainer');
const conversationSummary = require('../services/attribution-conversation-summary');
const confidenceAggregator = require('../services/attribution-confidence-aggregator');
const antipatternDetector = require('../services/attribution-anti-pattern-detector');
const ragReranker = require('../services/attribution-rag-reranker');
const conceptSimilarity = require('../services/concept-similarity');
const crossChatSimilarity = require('../services/cross-chat-intent-similarity');
const traceRecorder = require('../services/attribution-trace-recorder');
const feedbackRecorder = require('../services/attribution-feedback-recorder');
const promptQualityScorer = require('../services/attribution-prompt-quality-scorer');
const replayRunner = require('../services/attribution-replay-runner');
const skillRecommender = require('../services/attribution-skill-recommender');
const bulkAnalyzer = require('../services/attribution-bulk-analyzer');
const executiveSummary = require('../services/attribution-executive-summary');

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

router.post('/explain', optionalAuth, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').slice(0, MAX_PROMPT_CHARS);
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    const out = explainer.explain({
      prompt,
      history: sanitizeHistory(req.body?.history),
      files: sanitizeFiles(req.body?.files),
      memories: sanitizeMemories(req.body?.memories),
      ragSnippets: sanitizeRagSnippets(req.body?.ragSnippets),
      userProfile: req.body?.userProfile && typeof req.body.userProfile === 'object' ? req.body.userProfile : null,
      draftResponse: typeof req.body?.draftResponse === 'string' ? req.body.draftResponse.slice(0, MAX_RESPONSE_CHARS) : null,
    });
    return res.json({
      ok: true,
      summary: out.summary,
      steps: out.steps,
      narrative: out.narrative,
      systemPromptBlock: out.bundle.systemPromptBlock,
    });
  } catch (err) {
    console.error('[circuit-attribution/explain] failed:', err?.message || err);
    return res.status(500).json({ error: 'explain failed' });
  }
});

router.post('/explain/concept', optionalAuth, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').slice(0, MAX_PROMPT_CHARS);
    const conceptSurface = String(req.body?.conceptSurface || '').slice(0, 120);
    if (!prompt || !conceptSurface) return res.status(400).json({ error: 'prompt and conceptSurface are required' });
    return res.json(explainer.explainConcept({ prompt, conceptSurface }));
  } catch (err) {
    console.error('[circuit-attribution/explain/concept] failed:', err?.message || err);
    return res.status(500).json({ error: 'explain/concept failed' });
  }
});

router.post('/suite', optionalAuth, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').slice(0, MAX_PROMPT_CHARS);
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    const bundle = attributionSuite.run({
      userId: req.user?.id || req.body?.userId || null,
      chatId: req.body?.chatId || null,
      turnIndex: Number.isFinite(req.body?.turnIndex) ? req.body.turnIndex : 0,
      prompt,
      history: sanitizeHistory(req.body?.history),
      files: sanitizeFiles(req.body?.files),
      memories: sanitizeMemories(req.body?.memories),
      ragSnippets: sanitizeRagSnippets(req.body?.ragSnippets),
      userProfile: req.body?.userProfile && typeof req.body.userProfile === 'object' ? req.body.userProfile : null,
      draftResponse: typeof req.body?.draftResponse === 'string' ? req.body.draftResponse.slice(0, MAX_RESPONSE_CHARS) : null,
      options: req.body?.options || {},
    });
    return res.json({
      ok: true,
      verdict: bundle.verdict,
      systemPromptBlock: bundle.systemPromptBlock,
      telemetry: bundle.telemetry,
      safety: bundle.safety,
      drift: bundle.drift,
      beliefs: bundle.beliefs,
      entities: bundle.entities,
      engine: {
        summary: bundle.engine?.attribution?.summary,
        multiHop: bundle.engine?.multiHop,
        plan: bundle.engine?.plan,
        suppression: bundle.engine?.suppression,
      },
      postprocessed: bundle.postprocessed,
    });
  } catch (err) {
    console.error('[circuit-attribution/suite] failed:', err?.message || err);
    return res.status(500).json({ error: 'suite failed' });
  }
});

router.post('/belief', optionalAuth, async (req, res) => {
  try {
    const userId = req.user?.id || req.body?.userId || 'anon';
    const chatId = req.body?.chatId || 'default';
    const turnIndex = Number.isFinite(req.body?.turnIndex) ? req.body.turnIndex : 0;
    const prompt = String(req.body?.prompt || '').slice(0, MAX_PROMPT_CHARS);
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    const result = beliefTracker.observe({ userId, chatId, turnIndex, prompt });
    return res.json({ ...result, block: beliefTracker.buildBeliefBlock({ userId, chatId }) });
  } catch (err) {
    console.error('[circuit-attribution/belief] failed:', err?.message || err);
    return res.status(500).json({ error: 'belief failed' });
  }
});

router.post('/safety', optionalAuth, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').slice(0, MAX_PROMPT_CHARS);
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    const r = safetyRouter.classify({ prompt });
    return res.json({ ...r, block: safetyRouter.buildSafetyBlock(r) });
  } catch (err) {
    console.error('[circuit-attribution/safety] failed:', err?.message || err);
    return res.status(500).json({ error: 'safety failed' });
  }
});

router.post('/unifier', optionalAuth, async (req, res) => {
  try {
    const userId = req.user?.id || req.body?.userId || 'anon';
    const chatId = req.body?.chatId || 'default';
    const surface = String(req.body?.surface || '').slice(0, 240);
    if (surface) {
      return res.json({ ok: true, resolved: entityUnifier.resolve({ userId, chatId, surface }) });
    }
    return res.json({ ok: true, clusters: entityUnifier.unify({ userId, chatId }) });
  } catch (err) {
    console.error('[circuit-attribution/unifier] failed:', err?.message || err);
    return res.status(500).json({ error: 'unifier failed' });
  }
});

router.post('/conversation-summary', optionalAuth, async (req, res) => {
  try {
    const userId = req.user?.id || req.body?.userId || 'anon';
    const chatId = req.body?.chatId || 'default';
    const history = sanitizeHistory(req.body?.history);
    const summary = conversationSummary.buildSummary({ userId, chatId, history });
    const wantsMarkdown = req.body?.markdown === true;
    return res.json({
      ok: true,
      summary,
      markdown: wantsMarkdown ? conversationSummary.renderMarkdown(summary) : undefined,
    });
  } catch (err) {
    console.error('[circuit-attribution/conversation-summary] failed:', err?.message || err);
    return res.status(500).json({ error: 'conversation-summary failed' });
  }
});

router.get('/chat-summary', optionalAuth, async (req, res) => {
  try {
    const userId = req.user?.id || req.query?.userId || 'anon';
    const chatId = req.query?.chatId || 'default';
    const entities = entityTracker.listEntities({ userId, chatId, limit: 20 });
    const clusters = entityUnifier.unify({ userId, chatId, limit: 8 });
    const driftSummary = driftMonitor.summarize({ userId, chatId });
    const beliefs = beliefTracker.list({ userId, chatId, limit: 12 });
    return res.json({
      ok: true,
      userId,
      chatId,
      entities: entities.length,
      entitySample: entities.slice(0, 6).map((e) => ({ canonical: e.canonicalSurface, kind: e.kind, mentions: e.mentions })),
      clusters: clusters.length,
      clusterSample: clusters.slice(0, 6).map((c) => ({ canonical: c.canonical, kind: c.kind, mentions: c.mentions, surfaces: c.surfaces })),
      drift: driftSummary,
      beliefs: beliefs.length,
      beliefSample: beliefs.slice(0, 8).map((b) => ({ subject: b.subject, status: b.status, strength: b.currentStrength, contradicted: !!b.contradictedAt })),
    });
  } catch (err) {
    console.error('[circuit-attribution/chat-summary] failed:', err?.message || err);
    return res.status(500).json({ error: 'chat-summary failed' });
  }
});

router.post('/confidence', optionalAuth, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').slice(0, MAX_PROMPT_CHARS);
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    const bundle = attributionSuite.run({
      userId: req.user?.id || req.body?.userId || null,
      chatId: req.body?.chatId || null,
      turnIndex: Number.isFinite(req.body?.turnIndex) ? req.body.turnIndex : 0,
      prompt,
      history: sanitizeHistory(req.body?.history),
      files: sanitizeFiles(req.body?.files),
      memories: sanitizeMemories(req.body?.memories),
      ragSnippets: sanitizeRagSnippets(req.body?.ragSnippets),
      userProfile: req.body?.userProfile && typeof req.body.userProfile === 'object' ? req.body.userProfile : null,
      draftResponse: typeof req.body?.draftResponse === 'string' ? req.body.draftResponse.slice(0, MAX_RESPONSE_CHARS) : null,
    });
    const apResult = antipatternDetector.detect({ history: sanitizeHistory(req.body?.history) });
    const result = confidenceAggregator.aggregate({
      engineBundle: bundle.engine,
      safetyResult: bundle.safety,
      driftObservation: bundle.drift,
      beliefResult: bundle.beliefs,
      faithfulness: bundle.engine?.faithfulness || null,
      antipatternResult: apResult,
    });
    return res.json({ ...result, block: confidenceAggregator.buildConfidenceBlock(result) });
  } catch (err) {
    console.error('[circuit-attribution/confidence] failed:', err?.message || err);
    return res.status(500).json({ error: 'confidence failed' });
  }
});

router.post('/antipattern', optionalAuth, async (req, res) => {
  try {
    const history = sanitizeHistory(req.body?.history);
    if (!history.length) return res.status(400).json({ error: 'history is required' });
    const result = antipatternDetector.detect({ history });
    return res.json({ ...result, block: antipatternDetector.buildAntipatternBlock(result) });
  } catch (err) {
    console.error('[circuit-attribution/antipattern] failed:', err?.message || err);
    return res.status(500).json({ error: 'antipattern failed' });
  }
});

router.post('/rerank', optionalAuth, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').slice(0, MAX_PROMPT_CHARS);
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    const snippets = Array.isArray(req.body?.snippets) ? req.body.snippets.slice(0, 60) : [];
    if (!snippets.length) return res.status(400).json({ error: 'snippets is required' });
    const beliefs = Array.isArray(req.body?.beliefs) ? req.body.beliefs.slice(0, 20) : [];
    const entities = Array.isArray(req.body?.entities) ? req.body.entities.slice(0, 30) : [];
    const weight = Number.isFinite(req.body?.weight) ? Number(req.body.weight) : undefined;
    const max = Number.isFinite(req.body?.max) ? Number(req.body.max) : undefined;
    const ranked = ragReranker.rerank({ prompt, snippets, beliefs, entities, weight, max });
    return res.json({ ok: true, ranked, block: ragReranker.buildRerankBlock(ranked) });
  } catch (err) {
    console.error('[circuit-attribution/rerank] failed:', err?.message || err);
    return res.status(500).json({ error: 'rerank failed' });
  }
});

router.post('/similarity', optionalAuth, async (req, res) => {
  try {
    const text = String(req.body?.text || req.body?.prompt || '').slice(0, MAX_PROMPT_CHARS);
    const a = req.body?.a;
    const b = req.body?.b;
    if (a && b) {
      return res.json({ ok: true, a, b, similarity: conceptSimilarity.similarityScore(a, b) });
    }
    if (!text) return res.status(400).json({ error: 'text or (a,b) is required' });
    const result = conceptSimilarity.extractAndCluster(text);
    return res.json({ ok: true, ...result, block: conceptSimilarity.buildSimilarityBlock(result.clusters) });
  } catch (err) {
    console.error('[circuit-attribution/similarity] failed:', err?.message || err);
    return res.status(500).json({ error: 'similarity failed' });
  }
});

router.post('/cross-chat', optionalAuth, async (req, res) => {
  try {
    const chatId = String(req.body?.chatId || '').slice(0, 96);
    if (!chatId) return res.status(400).json({ error: 'chatId is required' });
    const history = sanitizeHistory(req.body?.history);
    if (history.length) crossChatSimilarity.observe({ chatId, history });
    const k = Number.isFinite(req.body?.k) ? Number(req.body.k) : 5;
    const sim = crossChatSimilarity.similar({ chatId, history, k });
    return res.json({ ok: true, similar: sim, block: crossChatSimilarity.buildSimilarChatsBlock(sim) });
  } catch (err) {
    console.error('[circuit-attribution/cross-chat] failed:', err?.message || err);
    return res.status(500).json({ error: 'cross-chat failed' });
  }
});

router.get('/admin/overview', optionalAuth, async (req, res) => {
  try {
    // One-stop snapshot for ops: aggregate in-memory state across every
    // attribution module. Use ?windowMs=N to restrict the metrics view.
    const windowMs = Number.isFinite(Number(req.query?.windowMs)) ? Number(req.query.windowMs) : null;
    const metricsSnap = metrics.snapshot({ windowMs });
    const entityStats = entityTracker.stats();
    const ccsProfiles = crossChatSimilarity.listProfiles({ limit: 8 });
    return res.json({
      ok: true,
      windowMs,
      metrics: metricsSnap,
      entities: entityStats,
      crossChatProfiles: {
        total: ccsProfiles.length,
        sample: ccsProfiles.map((p) => ({
          chatId: p.chatId,
          intents: p.intents,
          supernodes: p.supernodes,
          turnCount: p.turnCount,
        })),
      },
      config: {
        maxPromptChars: MAX_PROMPT_CHARS,
        maxResponseChars: MAX_RESPONSE_CHARS,
        hardShiftThreshold: driftMonitor.HARD_SHIFT_THRESHOLD,
        softShiftThreshold: driftMonitor.SOFT_SHIFT_THRESHOLD,
        faithfulnessThreshold: faithfulnessPostprocessor.DEFAULT_THRESHOLD,
        ragRerankWeight: ragReranker.DEFAULT_ATTRIBUTION_WEIGHT,
      },
    });
  } catch (err) {
    console.error('[circuit-attribution/admin/overview] failed:', err?.message || err);
    return res.status(500).json({ error: 'overview failed' });
  }
});

router.get('/admin/traces', optionalAuth, async (req, res) => {
  try {
    const chatId = req.query?.chatId ? String(req.query.chatId).slice(0, 96) : null;
    const userId = req.query?.userId ? String(req.query.userId).slice(0, 64) : null;
    const limit = Number.isFinite(Number(req.query?.limit)) ? Number(req.query.limit) : 50;
    return res.json({
      ok: true,
      traces: traceRecorder.list({ chatId, userId, limit }),
      stats: traceRecorder.stats(),
    });
  } catch (err) {
    console.error('[circuit-attribution/admin/traces] failed:', err?.message || err);
    return res.status(500).json({ error: 'traces failed' });
  }
});

router.get('/admin/traces/:id', optionalAuth, async (req, res) => {
  try {
    const id = String(req.params?.id || '').slice(0, 64);
    const trace = traceRecorder.get({ id });
    if (!trace) return res.status(404).json({ error: 'trace not found' });
    return res.json({ ok: true, trace });
  } catch (err) {
    console.error('[circuit-attribution/admin/traces/:id] failed:', err?.message || err);
    return res.status(500).json({ error: 'trace lookup failed' });
  }
});

router.post('/feedback', optionalAuth, async (req, res) => {
  try {
    const userId = req.user?.id || req.body?.userId || null;
    const chatId = req.body?.chatId || null;
    const turnIndex = Number.isFinite(req.body?.turnIndex) ? req.body.turnIndex : 0;
    const traceId = req.body?.traceId || null;
    const reaction = req.body?.reaction;
    const comment = req.body?.comment || null;
    const result = feedbackRecorder.record({ userId, chatId, turnIndex, traceId, reaction, comment });
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  } catch (err) {
    console.error('[circuit-attribution/feedback] failed:', err?.message || err);
    return res.status(500).json({ error: 'feedback failed' });
  }
});

router.get('/feedback/stats', optionalAuth, async (_req, res) => {
  try {
    return res.json({ ok: true, stats: feedbackRecorder.stats() });
  } catch (err) {
    console.error('[circuit-attribution/feedback/stats] failed:', err?.message || err);
    return res.status(500).json({ error: 'feedback stats failed' });
  }
});

router.get('/admin/feedback/aggregate', optionalAuth, async (req, res) => {
  try {
    const windowMs = Number.isFinite(Number(req.query?.windowMs)) ? Number(req.query.windowMs) : null;
    const groupBy = String(req.query?.groupBy || 'reaction');
    return res.json({ ok: true, ...feedbackRecorder.aggregate({ windowMs, groupBy }) });
  } catch (err) {
    console.error('[circuit-attribution/admin/feedback/aggregate] failed:', err?.message || err);
    return res.status(500).json({ error: 'feedback aggregate failed' });
  }
});

router.post('/quality', optionalAuth, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').slice(0, MAX_PROMPT_CHARS);
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    const result = promptQualityScorer.score({ prompt });
    return res.json({ ...result, block: promptQualityScorer.buildQualityBlock(result) });
  } catch (err) {
    console.error('[circuit-attribution/quality] failed:', err?.message || err);
    return res.status(500).json({ error: 'quality failed' });
  }
});

router.post('/replay/:traceId', optionalAuth, async (req, res) => {
  try {
    const traceId = String(req.params?.traceId || '').slice(0, 64);
    if (!traceId) return res.status(400).json({ error: 'traceId is required' });
    const history = sanitizeHistory(req.body?.history);
    const driftBudget = Number.isFinite(req.body?.driftBudget) ? Number(req.body.driftBudget) : undefined;
    const result = replayRunner.replay({ traceId, history, driftBudget });
    if (!result.ok) return res.status(404).json(result);
    return res.json({ ...result, block: replayRunner.buildReplayBlock(result) });
  } catch (err) {
    console.error('[circuit-attribution/replay] failed:', err?.message || err);
    return res.status(500).json({ error: 'replay failed' });
  }
});

router.get('/admin/replay-all', optionalAuth, async (req, res) => {
  try {
    const driftBudget = Number.isFinite(Number(req.query?.driftBudget)) ? Number(req.query.driftBudget) : undefined;
    const limit = Number.isFinite(Number(req.query?.limit)) ? Number(req.query.limit) : 20;
    return res.json({ ok: true, ...replayRunner.replayAll({ driftBudget, limit }) });
  } catch (err) {
    console.error('[circuit-attribution/admin/replay-all] failed:', err?.message || err);
    return res.status(500).json({ error: 'replay-all failed' });
  }
});

router.post('/recommend-skill', optionalAuth, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').slice(0, MAX_PROMPT_CHARS);
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    const additionalSkills = Array.isArray(req.body?.additionalSkills) ? req.body.additionalSkills : [];
    const limit = Number.isFinite(req.body?.limit) ? Number(req.body.limit) : 3;
    const result = skillRecommender.recommend({ prompt, additionalSkills, limit });
    return res.json({ ...result, block: skillRecommender.buildRecommendationBlock(result) });
  } catch (err) {
    console.error('[circuit-attribution/recommend-skill] failed:', err?.message || err);
    return res.status(500).json({ error: 'recommend-skill failed' });
  }
});

router.post('/bulk', optionalAuth, async (req, res) => {
  try {
    const prompts = Array.isArray(req.body?.prompts) ? req.body.prompts.slice(0, 250) : [];
    if (!prompts.length) return res.status(400).json({ error: 'prompts is required (non-empty array)' });
    const includeSuite = req.body?.includeSuite === true;
    const limit = Number.isFinite(req.body?.limit) ? Number(req.body.limit) : undefined;
    const result = bulkAnalyzer.analyzeBatch(prompts, { includeSuite, limit });
    return res.json({ ok: true, ...result, block: bulkAnalyzer.buildBulkBlock(result) });
  } catch (err) {
    console.error('[circuit-attribution/bulk] failed:', err?.message || err);
    return res.status(500).json({ error: 'bulk failed' });
  }
});

router.post('/executive-summary', optionalAuth, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').slice(0, MAX_PROMPT_CHARS);
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    const summary = executiveSummary.buildSummary({
      prompt,
      history: sanitizeHistory(req.body?.history),
      files: sanitizeFiles(req.body?.files),
      memories: sanitizeMemories(req.body?.memories),
      ragSnippets: sanitizeRagSnippets(req.body?.ragSnippets),
      userProfile: req.body?.userProfile && typeof req.body.userProfile === 'object' ? req.body.userProfile : null,
      draftResponse: typeof req.body?.draftResponse === 'string' ? req.body.draftResponse.slice(0, MAX_RESPONSE_CHARS) : null,
    });
    return res.json({ ...summary, block: executiveSummary.buildExecutiveBlock(summary) });
  } catch (err) {
    console.error('[circuit-attribution/executive-summary] failed:', err?.message || err);
    return res.status(500).json({ error: 'executive-summary failed' });
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

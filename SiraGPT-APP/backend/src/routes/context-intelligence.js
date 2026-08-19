'use strict';

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { optionalAuth } = require('../middleware/optionalAuth');
const contextIntelligence = require('../services/context-intelligence-engine');
const attributionGraph = require('../services/context-attribution-graph');
const multiHop = require('../services/multi-hop-intent-reasoner');
const lookahead = require('../services/lookahead-planner');
const knowledgeBoundary = require('../services/knowledge-boundary-detector');
const reasoningFaithfulness = require('../services/reasoning-faithfulness-check');
const entityGrounding = require('../services/entity-grounding-tracker');
const crossTurn = require('../services/cross-turn-attribution-chain');
const hiddenGoal = require('../services/hidden-goal-extractor');
const counterfactual = require('../services/counterfactual-query-rewriter');
const promptProvenance = require('../services/prompt-provenance-tracker');
const userProfile = require('../services/user-attribution-profile');
const arcSummarizer = require('../services/conversation-arc-summarizer');
const selfConsistency = require('../services/self-consistency-checker');
const intentCard = require('../services/intent-card-generator');
const { rateLimitMiddleware } = require('../services/rate-limiter');

const router = express.Router();

const standardRateLimit = rateLimitMiddleware({ windowMs: 60000, maxRequests: 60 });
const heavyRateLimit = rateLimitMiddleware({ windowMs: 60000, maxRequests: 30 });

function userIdFrom(req) {
  return req?.user?.id || null;
}

function safeContextFromBody(body = {}) {
  return {
    documents: Array.isArray(body.documents) ? body.documents.slice(0, 20) : [],
    history: Array.isArray(body.history) ? body.history.slice(-20) : [],
    memoryFacts: Array.isArray(body.memoryFacts) ? body.memoryFacts.slice(0, 25) : [],
    toolResults: Array.isArray(body.toolResults) ? body.toolResults.slice(-10) : [],
    webResults: Array.isArray(body.webResults) ? body.webResults.slice(0, 10) : [],
    reasoningTrace: Array.isArray(body.reasoningTrace) ? body.reasoningTrace.slice(0, 25) : [],
    draftAnswer: typeof body.draftAnswer === 'string' ? body.draftAnswer.slice(0, 20000) : '',
    systemPrompt: typeof body.systemPrompt === 'string' ? body.systemPrompt.slice(0, 6000) : '',
  };
}

router.post('/analyze', optionalAuth, heavyRateLimit, (req, res) => {
  try {
    const { query } = req.body || {};
    if (typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'query is required' });
    }
    const context = safeContextFromBody(req.body);
    const report = contextIntelligence.analyzeContext(userIdFrom(req), query, context);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/prompt-block', optionalAuth, heavyRateLimit, (req, res) => {
  try {
    const { query, opts } = req.body || {};
    if (typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'query is required' });
    }
    const context = safeContextFromBody(req.body);
    const report = contextIntelligence.analyzeContext(userIdFrom(req), query, context);
    const block = contextIntelligence.buildSystemPromptBlock(report, opts || {});
    res.json({ block, summary: contextIntelligence.summariseForLog(report) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/attribution', optionalAuth, standardRateLimit, (req, res) => {
  try {
    const { query } = req.body || {};
    if (typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'query is required' });
    }
    const context = safeContextFromBody(req.body);
    const graph = attributionGraph.buildGraph(query, context);
    res.json({
      graph,
      topContributors: attributionGraph.topContributors(graph, 8),
      prompt: attributionGraph.buildAttributionPrompt(graph),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/multi-hop', optionalAuth, standardRateLimit, (req, res) => {
  try {
    const { query } = req.body || {};
    if (typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'query is required' });
    }
    const context = safeContextFromBody(req.body);
    const result = multiHop.reason(query, context);
    res.json({ ...result, prompt: multiHop.buildMultiHopPrompt(result) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/lookahead', optionalAuth, standardRateLimit, (req, res) => {
  try {
    const { query } = req.body || {};
    if (typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'query is required' });
    }
    const context = safeContextFromBody(req.body);
    const plan = lookahead.planNextSteps(query, context);
    res.json({ ...plan, prompt: lookahead.buildLookaheadPrompt(plan) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/knowledge-boundary', optionalAuth, standardRateLimit, (req, res) => {
  try {
    const { text } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required' });
    }
    const context = safeContextFromBody(req.body);
    const result = knowledgeBoundary.detectBoundaries(text, context);
    res.json({ ...result, prompt: knowledgeBoundary.buildKnowledgeBoundaryPrompt(result) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/faithfulness', optionalAuth, standardRateLimit, (req, res) => {
  try {
    const { reasoningTrace } = req.body || {};
    if (!Array.isArray(reasoningTrace)) {
      return res.status(400).json({ error: 'reasoningTrace array is required' });
    }
    const context = safeContextFromBody(req.body);
    const result = reasoningFaithfulness.checkFaithfulness(reasoningTrace, context);
    res.json({ ...result, prompt: reasoningFaithfulness.buildFaithfulnessPrompt(result) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/entity-grounding', optionalAuth, standardRateLimit, (req, res) => {
  try {
    const { text } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required' });
    }
    const context = safeContextFromBody(req.body);
    const result = entityGrounding.trackEntities(text, context);
    res.json({ ...result, prompt: entityGrounding.buildEntityGroundingPrompt(result) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/cross-turn', optionalAuth, standardRateLimit, (req, res) => {
  try {
    const { query, history } = req.body || {};
    if (typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'query is required' });
    }
    const safeHistory = Array.isArray(history) ? history.slice(-20) : [];
    const result = crossTurn.buildChain(safeHistory, query, { maxTurns: 10, topK: req.body?.topK || 3 });
    res.json({ ...result, prompt: crossTurn.buildCrossTurnPrompt(result) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/hidden-goal', optionalAuth, standardRateLimit, (req, res) => {
  try {
    const { query } = req.body || {};
    if (typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'query is required' });
    }
    const context = safeContextFromBody(req.body);
    const result = hiddenGoal.extractHiddenGoals(query, context);
    res.json({ ...result, prompt: hiddenGoal.buildHiddenGoalPrompt(result) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/counterfactual', optionalAuth, heavyRateLimit, (req, res) => {
  try {
    const { query } = req.body || {};
    if (typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'query is required' });
    }
    const context = safeContextFromBody(req.body);
    const result = counterfactual.probeRobustness(
      query,
      (q) => {
        const g = attributionGraph.buildGraph(q, context);
        return g.primaryIntent ? { intent: g.primaryIntent.kind, confidence: g.primaryIntent.weight } : { intent: null, confidence: 0 };
      },
      { context, limit: req.body?.limit || 6 },
    );
    res.json({ ...result, prompt: counterfactual.buildCounterfactualPrompt(result) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/provenance', optionalAuth, standardRateLimit, (req, res) => {
  try {
    const { blocks, maxChars } = req.body || {};
    if (!Array.isArray(blocks)) {
      return res.status(400).json({ error: 'blocks array is required' });
    }
    const tracker = promptProvenance.createTracker({ maxChars: maxChars || undefined });
    tracker.addMany(blocks);
    const built = tracker.buildPrompt();
    res.json({ prompt: built.prompt, trimmed: built.trimmed, map: built.map, summary: tracker.summarize() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/intent-card', optionalAuth, heavyRateLimit, (req, res) => {
  try {
    const { query, arcReports } = req.body || {};
    if (typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'query is required' });
    }
    const context = safeContextFromBody(req.body);
    const report = contextIntelligence.analyzeContext(userIdFrom(req), query, context);
    let arc = null;
    if (Array.isArray(arcReports) && arcReports.length > 0) {
      arc = arcSummarizer.summarize(arcReports);
    }
    const card = intentCard.generate(report, { arc });
    res.json({ card, report: contextIntelligence.summariseForLog(report), arc, prompt: intentCard.buildIntentCardPrompt(card) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/arc', optionalAuth, standardRateLimit, (req, res) => {
  try {
    const { reports } = req.body || {};
    if (!Array.isArray(reports)) {
      return res.status(400).json({ error: 'reports array is required' });
    }
    const result = arcSummarizer.summarize(reports);
    res.json({ ...result, prompt: arcSummarizer.buildArcPrompt(result) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/self-consistency', optionalAuth, standardRateLimit, (req, res) => {
  try {
    const { text } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required' });
    }
    const result = selfConsistency.check(text, req.body || {});
    res.json({ ...result, prompt: selfConsistency.buildSelfConsistencyPrompt(result) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/user-profile/:userId', authenticateToken, standardRateLimit, (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    // IDOR guard — a behavioral profile (intents, hidden goals, success rate) is
    // private; only the owner may read it. Mirrors the sibling POST /record.
    if (req.user?.id && req.user.id !== userId) {
      return res.status(403).json({ error: 'can only read your own profile' });
    }
    const summary = userProfile.getProfileSummary(userId);
    if (!summary) return res.status(404).json({ error: 'no profile for that user' });
    res.json({ profile: summary, prompt: userProfile.buildProfilePrompt(userId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/user-profile/:userId/record', authenticateToken, standardRateLimit, (req, res) => {
  try {
    const { userId } = req.params;
    const { snapshot, outcome } = req.body || {};
    if (!snapshot) return res.status(400).json({ error: 'snapshot is required' });
    if (req.user?.id && req.user.id !== userId) {
      return res.status(403).json({ error: 'can only record for your own userId' });
    }
    const turn = userProfile.recordTurn(userId, snapshot, outcome || 'neutral');
    res.json({ turn });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/health', (_req, res) => {
  res.json({
    ok: true,
    modules: [
      'context-attribution-graph',
      'multi-hop-intent-reasoner',
      'lookahead-planner',
      'knowledge-boundary-detector',
      'reasoning-faithfulness-check',
      'entity-grounding-tracker',
      'cross-turn-attribution-chain',
      'hidden-goal-extractor',
      'counterfactual-query-rewriter',
      'prompt-provenance-tracker',
      'user-attribution-profile',
      'conversation-arc-summarizer',
      'self-consistency-checker',
      'intent-card-generator',
      'context-intelligence-engine',
    ],
    promptBlockMaxChars: contextIntelligence.MAX_PROMPT_BLOCK_CHARS,
  });
});

module.exports = router;

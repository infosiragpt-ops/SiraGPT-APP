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
      'context-intelligence-engine',
    ],
    promptBlockMaxChars: contextIntelligence.MAX_PROMPT_BLOCK_CHARS,
  });
});

module.exports = router;

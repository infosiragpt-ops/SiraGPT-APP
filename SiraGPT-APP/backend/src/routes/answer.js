'use strict';

/**
 * answer route — professional "answer engine" (Perplexity / ChatGPT-search
 * style): plan → search many sources → optionally read the top pages →
 * synthesize a cited answer with inline [n] markers + references.
 *
 *   POST /api/answer
 *     body: { query, mode?('fast'|'deep'), maxSources?, llm?, includeScientific? }
 *     →    { query, answer, citations, sources, relatedQuestions, stats, … }
 *
 *   POST /api/answer/stream   — same, Server-Sent Events (phase → answer → done)
 *   GET  /api/answer/health   → { ok, metrics }
 *   GET  /api/answer/metrics  → JSON snapshot
 *   GET  /api/answer/metrics.prom → Prometheus text
 *
 * Auth: POST requires authenticateToken so anonymous traffic can't burn the
 * upstream search-provider quotas.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { responseCache } = require('../middleware/response-cache');
const engine = require('../services/answer/answer-engine');
const metrics = require('../services/answer/answer-metrics');

const router = express.Router();

// Optional LLM rewrite via the orchestration gateway. Returns null when the
// gateway isn't configured/usable so the engine keeps its extractive answer.
function buildLlmFn(enabled) {
  if (!enabled) return null;
  return async (prompt, o = {}) => {
    // eslint-disable-next-line global-require
    const { gatewayComplete } = require('../orchestration/gateway-adapter');
    const r = await gatewayComplete({ prompt, taskType: 'chat', temperature: 0.3, signal: o.signal });
    return r?.choices?.[0]?.message?.content || '';
  };
}

router.get('/health', responseCache({ ttlMs: 60_000, namespace: 'answer-health' }), (req, res) => {
  res.json({ ok: true, metrics: metrics.snapshot() });
});

router.get('/metrics', (req, res) => {
  res.json(metrics.snapshot());
});

router.get('/metrics.prom', (req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.send(metrics.toPrometheusText());
});

function failValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: 'validation_failed', details: errors.array() });
    return true;
  }
  return false;
}

const VALIDATORS = [
  body('query').isString().trim().isLength({ min: 1, max: 512 }).withMessage('query must be 1-512 chars'),
  body('mode').optional().isIn(['fast', 'deep']),
  body('maxSources').optional().isInt({ min: 1, max: 50 }),
  body('readTopK').optional().isInt({ min: 1, max: 12 }),
  body('llm').optional().isBoolean(),
  body('includeScientific').optional().isBoolean(),
];

function engineOptsFromBody(b) {
  return {
    mode: b.mode === 'deep' ? 'deep' : 'fast',
    maxSources: b.maxSources,
    readTopK: b.readTopK,
    includeScientific: b.includeScientific,
    locale: typeof b.locale === 'string' ? b.locale : undefined,
    llmFn: buildLlmFn(b.llm === true),
  };
}

router.post('/', authenticateToken, VALIDATORS, async (req, res) => {
  if (failValidation(req, res)) return;
  const { query } = req.body;
  try {
    const result = await engine.answer(query, engineOptsFromBody(req.body));
    metrics.record({
      mode: result.mode,
      candidates: result.stats?.candidates,
      citations: result.citations?.length,
      llmUsed: result.stats?.llmUsed,
      latencyMs: result.stats?.timings?.total,
      empty: !result.answer,
    });
    return res.json(result);
  } catch (err) {
    metrics.record({ error: true });
    console.error('[answer] uncaught:', err.message);
    return res.status(500).json({ error: 'answer_failed', message: err.message });
  }
});

router.post('/stream', authenticateToken, VALIDATORS, async (req, res) => {
  if (failValidation(req, res)) return;
  const { query } = req.body;

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* socket gone */ }
  };

  const ac = new AbortController();
  req.on('close', () => ac.abort());

  try {
    const result = await engine.answer(query, {
      ...engineOptsFromBody(req.body),
      signal: ac.signal,
      onPhase: (evt) => send('phase', evt),
    });
    metrics.record({
      mode: result.mode,
      candidates: result.stats?.candidates,
      citations: result.citations?.length,
      llmUsed: result.stats?.llmUsed,
      latencyMs: result.stats?.timings?.total,
      empty: !result.answer,
    });
    send('result', result);
    send('done', { ok: true });
  } catch (err) {
    metrics.record({ error: true });
    send('error', { message: err.message });
  } finally {
    res.end();
  }
});

module.exports = router;

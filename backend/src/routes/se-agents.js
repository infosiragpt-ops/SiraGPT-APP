/**
 * se-agents routes — HTTP surface for the SE-agent suite.
 *
 * Base path: /api/se-agents
 *
 * Endpoints:
 *   POST /review       — code review agent
 *   POST /test-gen     — test generation agent
 *   POST /debug        — debugging agent
 *   POST /code-gen     — code generation agent
 *   POST /static-check — static analysis agent
 *   POST /orchestrate  — intent router / pipeline / collaborative
 *
 * All endpoints auth-required; all take a `collection` (default 'code')
 * that should already have /api/rag/ingest-code called on it.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const rag = require('../services/rag-service');

const codeReview = require('../services/agents/code-review-agent');
const testGen = require('../services/agents/test-gen-agent');
const debugAgent = require('../services/agents/debug-agent');
const codeGen = require('../services/agents/code-gen-agent');
const staticCheck = require('../services/agents/static-check-agent');
const requirementsAgent = require('../services/agents/requirements-agent');
const logAnalysis = require('../services/agents/log-analysis-agent');
const maintenanceAgent = require('../services/agents/maintenance-agent');
const orchestrator = require('../services/agents/se-orchestrator');
const budget = require('../services/agents/budget');
const metrics = require('../services/agents/metrics');
const auditLog = require('../services/agents/audit-log');
const injectionGuard = require('../services/agents/injection-guard');
const alignmentJudge = require('../services/agents/alignment-judge');
const truthfulness = require('../services/agents/truthfulness');
const intentClarifier = require('../services/agents/intent-clarifier');
const feedback = require('../services/agents/feedback-ledger');

const router = express.Router();

/**
 * Pre-flight: scan + budget gate. Call at the START of each handler.
 * Returns null when allowed; sends a 429 and returns a truthy value
 * when the caller should bail out.
 */
function preflight(req, res, agentName, scanFieldNames = []) {
  const scanBag = {};
  for (const f of scanFieldNames) {
    if (typeof req.body?.[f] === 'string') scanBag[f] = req.body[f];
  }
  const hits = injectionGuard.scanFields(scanBag);
  for (const h of hits) {
    const [, rule] = h.split(':');
    metrics.counter('se_agent_injection_signals_total', { agent: agentName, rule });
  }
  req._agentInjectionHits = hits;

  const allowed = budget.checkAllowed(req.user?.id);
  if (!allowed.allowed) {
    metrics.counter('se_agent_rate_limited_total', { reason: allowed.reason });
    auditLog.audit({
      event: 'agent_denied', userId: req.user?.id || null,
      agent: agentName, reason: allowed.reason,
    });
    res.setHeader('Retry-After', Math.ceil(allowed.retryAfterMs / 1000));
    res.status(429).json({
      error: 'rate_limited', reason: allowed.reason,
      retryAfterMs: allowed.retryAfterMs,
    });
    return true; // denied
  }
  return false;
}

/** Post-flight: metrics + audit + budget record. Call once after result is ready. */
function finalize(req, agentName, result) {
  if (!result || typeof result !== 'object') return;
  metrics.recordAgentRun({ agent: agentName, result });
  if (result.stats?.toolCalls) {
    metrics.counter('se_agent_tool_calls_total', { agent: agentName }, result.stats.toolCalls);
  }
  auditLog.auditAgentRun({
    userId: req.user?.id || null,
    agent: agentName,
    collection: req.body?.collection || null,
    result,
    extra: { injection_hits: (req._agentInjectionHits || []).length },
  });
  if (result.stats) {
    const toks = (result.stats.approxPromptTokens || 0) + (result.stats.approxCompletionTokens || 0);
    if (req.user?.id && toks > 0) budget.record(req.user.id, { tokens: toks });
  }
}

function requireOpenAI(res) {
  const client = rag.getOpenAI();
  if (!client) {
    res.status(503).json({ error: 'OPENAI_API_KEY not configured — agents unavailable' });
    return null;
  }
  return client;
}

function handleErrors(fn) {
  return async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      await fn(req, res);
    } catch (err) {
      console.error(`[se-agents ${req.path}] failed:`, err);
      res.status(500).json({ error: err.message || 'agent failed' });
    }
  };
}

router.post(
  '/review',
  authenticateToken,
  [
    body('collection').optional().isString().isLength({ max: 64 }),
    body('files').optional().isArray(),
    body('focus').optional().isString().isLength({ max: 500 }),
    body('maxIters').optional().isInt({ min: 1, max: 20 }),
  ],
  handleErrors(async (req, res) => {
    if (preflight(req, res, 'code_review', ['focus'])) return;
    const openai = requireOpenAI(res); if (!openai) return;
    const result = await codeReview.review({
      openai,
      userId: req.user.id,
      collection: req.body.collection || 'code',
      files: Array.isArray(req.body.files) ? req.body.files : null,
      focus: req.body.focus || null,
      maxIters: req.body.maxIters || 12,
    });
    finalize(req, 'code_review', result);
    res.json({ ok: true, ...result });
  })
);

router.post(
  '/test-gen',
  authenticateToken,
  [
    body('source').isString().isLength({ min: 1, max: 256 }),
    body('symbol').optional().isString().isLength({ max: 128 }),
    body('language').optional().isString().isLength({ max: 32 }),
    body('collection').optional().isString().isLength({ max: 64 }),
    body('maxIters').optional().isInt({ min: 1, max: 20 }),
  ],
  handleErrors(async (req, res) => {
    if (preflight(req, res, 'test_gen', ['source', 'symbol'])) return;
    const openai = requireOpenAI(res); if (!openai) return;
    const result = await testGen.generate({
      openai,
      userId: req.user.id,
      collection: req.body.collection || 'code',
      source: req.body.source,
      symbol: req.body.symbol,
      language: req.body.language,
      maxIters: req.body.maxIters || 10,
    });
    finalize(req, 'test_gen', result);
    res.json({ ok: true, ...result });
  })
);

router.post(
  '/debug',
  authenticateToken,
  [
    body('error').isString().isLength({ min: 1, max: 16000 }),
    body('context').optional().isString().isLength({ max: 4000 }),
    body('suspicion').optional().isArray(),
    body('collection').optional().isString().isLength({ max: 64 }),
    body('maxIters').optional().isInt({ min: 1, max: 20 }),
  ],
  handleErrors(async (req, res) => {
    if (preflight(req, res, 'debug', ['error', 'context'])) return;
    const openai = requireOpenAI(res); if (!openai) return;
    const result = await debugAgent.debug({
      openai,
      userId: req.user.id,
      collection: req.body.collection || 'code',
      error: req.body.error,
      context: req.body.context,
      suspicion: Array.isArray(req.body.suspicion) ? req.body.suspicion : null,
      maxIters: req.body.maxIters || 12,
    });
    finalize(req, 'debug', result);
    res.json({ ok: true, ...result });
  })
);

router.post(
  '/code-gen',
  authenticateToken,
  [
    body('spec').isString().isLength({ min: 1, max: 8000 }),
    body('strategy').optional().isIn(['single_path', 'multi_path']),
    body('numPaths').optional().isInt({ min: 2, max: 5 }),
    body('language').optional().isString().isLength({ max: 32 }),
    body('collection').optional().isString().isLength({ max: 64 }),
    body('maxIters').optional().isInt({ min: 1, max: 20 }),
  ],
  handleErrors(async (req, res) => {
    if (preflight(req, res, 'code_gen', ['spec'])) return;
    const openai = requireOpenAI(res); if (!openai) return;
    const result = await codeGen.generate({
      openai,
      userId: req.user.id,
      collection: req.body.collection || 'code',
      spec: req.body.spec,
      strategy: req.body.strategy || 'single_path',
      numPaths: req.body.numPaths || 3,
      language: req.body.language,
      maxIters: req.body.maxIters || 12,
    });
    finalize(req, 'code_gen', result);
    res.json({ ok: true, ...result });
  })
);

router.post(
  '/requirements',
  authenticateToken,
  [
    body('request').isString().isLength({ min: 1, max: 8000 }),
    body('relatedFiles').optional().isArray(),
    body('domainContext').optional().isString().isLength({ max: 4000 }),
    body('collection').optional().isString().isLength({ max: 64 }),
    body('maxIters').optional().isInt({ min: 1, max: 20 }),
  ],
  handleErrors(async (req, res) => {
    if (preflight(req, res, 'requirements', ['request', 'domainContext'])) return;
    const openai = requireOpenAI(res); if (!openai) return;
    const result = await requirementsAgent.requirements({
      openai,
      userId: req.user.id,
      collection: req.body.collection || 'code',
      request: req.body.request,
      relatedFiles: Array.isArray(req.body.relatedFiles) ? req.body.relatedFiles : null,
      domainContext: req.body.domainContext,
      maxIters: req.body.maxIters || 10,
    });
    finalize(req, 'requirements', result);
    res.json({ ok: true, ...result });
  })
);

router.post(
  '/maintenance',
  authenticateToken,
  [
    body('ticket').isString().isLength({ min: 10, max: 16000 }),
    body('title').optional().isString().isLength({ max: 500 }),
    body('reporter').optional().isString().isLength({ max: 64 }),
    body('initialSuspicion').optional().isArray(),
    body('collection').optional().isString().isLength({ max: 64 }),
    body('maxIters').optional().isInt({ min: 1, max: 25 }),
  ],
  handleErrors(async (req, res) => {
    if (preflight(req, res, 'maintenance', ['ticket', 'title'])) return;
    const openai = requireOpenAI(res); if (!openai) return;
    const result = await maintenanceAgent.resolve({
      openai,
      userId: req.user.id,
      collection: req.body.collection || 'code',
      ticket: req.body.ticket,
      title: req.body.title,
      reporter: req.body.reporter,
      initialSuspicion: Array.isArray(req.body.initialSuspicion) ? req.body.initialSuspicion : null,
      maxIters: req.body.maxIters || 14,
    });
    finalize(req, 'maintenance', result);
    res.json({ ok: true, ...result });
  })
);

router.post(
  '/log-analysis',
  authenticateToken,
  [
    body('logs').custom(v => typeof v === 'string' || Array.isArray(v)),
    body('topK').optional().isInt({ min: 1, max: 30 }),
    body('correlateWithCode').optional().isBoolean(),
    body('collection').optional().isString().isLength({ max: 64 }),
    body('maxIters').optional().isInt({ min: 1, max: 20 }),
  ],
  handleErrors(async (req, res) => {
    if (preflight(req, res, 'log_analysis', [])) return;
    const openai = requireOpenAI(res); if (!openai) return;
    const result = await logAnalysis.analyse({
      openai,
      userId: req.user.id,
      collection: req.body.collection || 'code',
      logs: req.body.logs,
      topK: req.body.topK || 8,
      correlateWithCode: req.body.correlateWithCode !== false,
      maxIters: req.body.maxIters || 10,
    });
    finalize(req, 'log_analysis', result);
    res.json({ ok: true, ...result });
  })
);

router.post(
  '/static-check',
  authenticateToken,
  [
    body('files').isArray({ min: 1 }),
    body('collection').optional().isString().isLength({ max: 64 }),
    body('maxIters').optional().isInt({ min: 1, max: 20 }),
  ],
  handleErrors(async (req, res) => {
    if (preflight(req, res, 'static_check', [])) return;
    const openai = requireOpenAI(res); if (!openai) return;
    const result = await staticCheck.check({
      openai,
      userId: req.user.id,
      collection: req.body.collection || 'code',
      files: req.body.files,
      maxIters: req.body.maxIters || 8,
    });
    finalize(req, 'static_check', result);
    res.json({ ok: true, ...result });
  })
);

router.post(
  '/orchestrate',
  authenticateToken,
  [
    body('mode').isIn(['route', 'pipeline', 'collaborate', 'consensus']),
    body('collection').optional().isString().isLength({ max: 64 }),
    body('message').optional().isString().isLength({ max: 4000 }),
    body('recipe').optional().isString().isLength({ max: 64 }),
    body('input').optional().isObject(),
    body('spec').optional().isString().isLength({ max: 8000 }),
    body('maxRounds').optional().isInt({ min: 1, max: 6 }),
    body('numAgents').optional().isInt({ min: 2, max: 6 }),
    body('language').optional().isString().isLength({ max: 32 }),
  ],
  handleErrors(async (req, res) => {
    const openai = requireOpenAI(res); if (!openai) return;
    const collection = req.body.collection || 'code';

    if (req.body.mode === 'route') {
      const r = await orchestrator.routeIntent({ openai, message: req.body.message || '' });
      return res.json({ ok: true, ...r });
    }
    if (req.body.mode === 'pipeline') {
      const r = await orchestrator.pipeline({
        openai, userId: req.user.id, collection,
        recipe: req.body.recipe, input: req.body.input || {},
      });
      return res.json({ ok: true, ...r });
    }
    if (req.body.mode === 'collaborate') {
      const r = await orchestrator.collaborate({
        openai, userId: req.user.id, collection,
        spec: req.body.spec,
        maxRounds: req.body.maxRounds || 3,
        language: req.body.language,
      });
      return res.json({ ok: true, ...r });
    }
    if (req.body.mode === 'consensus') {
      const r = await orchestrator.consensus({
        openai, userId: req.user.id, collection,
        spec: req.body.spec,
        numAgents: req.body.numAgents || 3,
        language: req.body.language,
      });
      return res.json({ ok: true, ...r });
    }
  })
);

/**
 * POST /api/se-agents/clarify
 * Pre-flight ambiguity check before running an expensive specialist.
 * Body: { request, agent? } → { status: 'clear'|'ambiguous'|'blocked', ... }
 *
 * Recommended client flow: if status === 'ambiguous', show the returned
 * questions to the user, wait for their reply, then re-submit the
 * disambiguated request to the specialist endpoint.
 */
router.post(
  '/clarify',
  authenticateToken,
  [
    body('request').isString().isLength({ min: 1, max: 8000 }),
    body('agent').optional().isString().isLength({ max: 32 }),
  ],
  handleErrors(async (req, res) => {
    if (preflight(req, res, 'intent_clarifier', ['request'])) return;
    const openai = requireOpenAI(res); if (!openai) return;
    const result = await intentClarifier.clarify({
      openai, request: req.body.request, agent: req.body.agent,
    });
    res.json({ ok: true, ...result });
  })
);

/**
 * POST /api/se-agents/align-score
 * Score a response against the HHH rubric. Body: { request, response,
 * sourceContext? } → { helpful, honest, harmless, overall, issues[] }.
 * Exposed so frontends can display the score next to a response.
 */
router.post(
  '/align-score',
  authenticateToken,
  [
    body('request').isString().isLength({ min: 1, max: 8000 }),
    body('response').custom(v => typeof v === 'string' || (v !== null && typeof v === 'object')),
    body('sourceContext').optional().isString().isLength({ max: 12000 }),
  ],
  handleErrors(async (req, res) => {
    if (preflight(req, res, 'alignment_judge', ['request'])) return;
    const openai = requireOpenAI(res); if (!openai) return;
    const result = await alignmentJudge.score({
      openai,
      userRequest: req.body.request,
      response: req.body.response,
      sourceContext: req.body.sourceContext,
    });
    res.json({ ok: true, ...result });
  })
);

/**
 * POST /api/se-agents/truthfulness
 * Body: { response, contextChunks: [{text, source?}], llmFallback? }
 * Returns per-claim grounding decisions + overall score.
 */
router.post(
  '/truthfulness',
  authenticateToken,
  [
    body('response').custom(v => typeof v === 'string' || (v !== null && typeof v === 'object')),
    body('contextChunks').optional().isArray(),
    body('llmFallback').optional().isBoolean(),
  ],
  handleErrors(async (req, res) => {
    if (preflight(req, res, 'truthfulness', [])) return;
    const openai = requireOpenAI(res); if (!openai) return;
    const result = await truthfulness.check({
      openai,
      response: req.body.response,
      contextChunks: Array.isArray(req.body.contextChunks) ? req.body.contextChunks : [],
      llmFallback: req.body.llmFallback !== false,
    });
    res.json({ ok: true, ...result });
  })
);

/**
 * POST /api/se-agents/feedback
 * Record user feedback on a past run. Body: { runId, agent, request,
 * response, helpful, notes? } — same shape as the ledger entry.
 */
router.post(
  '/feedback',
  authenticateToken,
  [
    body('runId').isString().isLength({ min: 1, max: 128 }),
    body('agent').optional().isString().isLength({ max: 32 }),
    body('request').isString().isLength({ min: 1, max: 8000 }),
    body('response').custom(v => v !== undefined),
    body('helpful').isBoolean(),
    body('notes').optional().isString().isLength({ max: 1000 }),
  ],
  handleErrors(async (req, res) => {
    const r = await feedback.record({
      userId: req.user.id,
      runId: req.body.runId,
      agent: req.body.agent || null,
      request: req.body.request,
      response: req.body.response,
      helpful: req.body.helpful,
      notes: req.body.notes || null,
      embedder: async (texts) => rag.embed(texts),
    });
    auditLog.audit({
      event: 'feedback', userId: req.user.id,
      runId: req.body.runId, agent: req.body.agent, helpful: req.body.helpful,
    });
    res.json({ ok: true, ...r });
  })
);

/**
 * GET /api/se-agents/feedback/stats
 * The caller's thumbs-up/down counts — useful for "X helpful answers so far" UX.
 */
router.get('/feedback/stats', authenticateToken, (req, res) => {
  res.json({ ok: true, ...feedback.stats(req.user.id) });
});

/**
 * POST /api/se-agents/chat
 * Single entry point from the chat UI. Takes a user message, routes
 * the intent, delegates to the right specialist, returns a uniform
 * { intent, agent, result } envelope the frontend can render.
 *
 * When `intent` is 'general', the caller should fall back to their
 * existing RAG chat — we don't handle general chat here.
 *
 * Body: { message, collection?, context? }
 *   context is an optional bag with per-agent extras: { files, spec,
 *   ticket, error, suspicion, logs } — we pick the ones relevant to
 *   the routed intent and pass them through.
 */
router.post(
  '/chat',
  authenticateToken,
  [
    body('message').isString().isLength({ min: 1, max: 8000 }),
    body('collection').optional().isString().isLength({ max: 64 }),
    body('context').optional().isObject(),
  ],
  handleErrors(async (req, res) => {
    if (preflight(req, res, 'chat_dispatcher', ['message'])) return;
    const openai = requireOpenAI(res); if (!openai) return;

    const collection = req.body.collection || 'code';
    const message = req.body.message;
    const context = req.body.context || {};

    // Step 1: route intent.
    const routing = await orchestrator.routeIntent({ openai, message });

    // Step 2: dispatch to specialist based on intent.
    //   For specialists that need more than message text, pull from
    //   `context`. Anything missing → fall back to lightweight "general"
    //   branch which returns the intent + the message itself so the
    //   caller can hand off to its RAG chat.
    const userId = req.user.id;
    const commonArgs = { openai, userId, collection };
    let agent = null;
    let result = null;

    switch (routing.intent) {
      case 'code_review':
        agent = 'code_review';
        result = await codeReview.review({
          ...commonArgs,
          files: Array.isArray(context.files) ? context.files : null,
          focus: typeof context.focus === 'string' ? context.focus : message,
        });
        break;
      case 'test_gen':
        agent = 'test_gen';
        if (!context.source) {
          // Can't run without a target; surface the gap to the caller.
          routing.intent = 'general'; break;
        }
        result = await testGen.generate({
          ...commonArgs,
          source: context.source, symbol: context.symbol, language: context.language,
        });
        break;
      case 'debug':
        agent = 'debug';
        result = await debugAgent.debug({
          ...commonArgs,
          error: typeof context.error === 'string' ? context.error : message,
          context: typeof context.hint === 'string' ? context.hint : null,
          suspicion: Array.isArray(context.suspicion) ? context.suspicion : null,
        });
        break;
      case 'code_gen':
        agent = 'code_gen';
        result = await codeGen.generate({
          ...commonArgs,
          spec: typeof context.spec === 'string' ? context.spec : message,
          strategy: context.strategy || 'single_path',
          language: context.language,
        });
        break;
      case 'static_check':
        if (!Array.isArray(context.files) || context.files.length === 0) {
          routing.intent = 'general'; break;
        }
        agent = 'static_check';
        result = await staticCheck.check({ ...commonArgs, files: context.files });
        break;
      case 'requirements':
        agent = 'requirements';
        result = await requirementsAgent.requirements({
          ...commonArgs,
          request: message,
          relatedFiles: context.files,
          domainContext: context.domainContext,
        });
        break;
      case 'log_analysis':
        agent = 'log_analysis';
        result = await logAnalysis.analyse({
          ...commonArgs,
          logs: typeof context.logs === 'string' ? context.logs : message,
          topK: context.topK || 8,
        });
        break;
      case 'maintenance':
        agent = 'maintenance';
        result = await maintenanceAgent.resolve({
          ...commonArgs,
          ticket: typeof context.ticket === 'string' ? context.ticket : message,
          title: context.title,
        });
        break;
      default:
        // general — let the caller fall back to their existing RAG chat
        break;
    }

    if (result) finalize(req, agent, result);

    res.json({
      ok: true,
      intent: routing.intent,
      confidence: routing.confidence,
      reason: routing.reason,
      agent,
      result,
      fallback_to_rag_chat: routing.intent === 'general',
    });
  })
);

/**
 * GET /api/se-agents/metrics
 * Prometheus-compatible text format. No auth — metrics endpoints are
 * conventionally unauth'd and protected at the network layer (scrape
 * target allowlist). If you're exposing this to the internet, wrap it
 * in auth at the edge.
 */
router.get('/metrics', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(metrics.renderText());
});

/**
 * GET /api/se-agents/usage
 * Returns the caller's current budget usage (hour + day window).
 * Useful for frontend dashboards and client-side pre-flight checks
 * so the UI can warn before running an expensive agent.
 */
router.get('/usage', authenticateToken, (req, res) => {
  const u = budget.getUsage(req.user.id);
  res.json({
    ok: true,
    userId: req.user.id,
    ...u,
    caps: {
      daily_tokens: budget.DAILY_TOKENS,
      hourly_tokens: budget.HOURLY_TOKENS,
      rpm: budget.RPM,
    },
  });
});

/**
 * GET /api/se-agents/health
 * Liveness + readiness. Returns ok if the module imports loaded and
 * the OpenAI client is configured. Does NOT exercise the API.
 */
router.get('/health', (req, res) => {
  const openaiReady = !!rag.getOpenAI();
  res.status(openaiReady ? 200 : 503).json({
    ok: openaiReady,
    openai: openaiReady,
    agents: ['code_review', 'test_gen', 'debug', 'code_gen', 'static_check',
             'requirements', 'log_analysis', 'maintenance'],
    orchestrator_modes: ['route', 'pipeline', 'collaborate', 'consensus'],
  });
});

module.exports = router;

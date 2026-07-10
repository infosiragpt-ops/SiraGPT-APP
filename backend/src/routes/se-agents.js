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
const {
  metricsHandler: authenticatedMetricsHandler,
} = require('../services/observability/metrics-exposition');
const auditLog = require('../services/agents/audit-log');
const injectionGuard = require('../services/agents/injection-guard');
const alignmentJudge = require('../services/agents/alignment-judge');
const truthfulness = require('../services/agents/truthfulness');
const intentClarifier = require('../services/agents/intent-clarifier');
const feedback = require('../services/agents/feedback-ledger');
const alignWrapper = require('../services/agents/align-wrapper');
const safetyFilter = require('../services/agents/safety-filter');
const calibrator = require('../services/agents/response-calibrator');
const preferenceExport = require('../services/agents/preference-export');
const {
  contentDispositionHeader,
  safeDownloadFilename,
} = require('../middleware/file-response-safety');
const evalHarness = require('../services/agents/eval-harness');
const multiJudge = require('../services/agents/multi-judge');
const truthfulQa = require('../services/agents/benchmarks/truthful-qa');
const realToxicity = require('../services/agents/benchmarks/real-toxicity');
const biasEval = require('../services/agents/benchmarks/bias-eval');
const closedDomain = require('../services/agents/benchmarks/closed-domain-hallucination');
const alignmentTax = require('../services/agents/benchmarks/alignment-tax');
const promptTaxonomy = require('../services/agents/prompt-taxonomy');
const ragas = require('../services/agents/ragas');
const graphragEval = require('../services/agents/graphrag/eval-criteria');
const graphragBench = require('../services/agents/graphrag/adaptive-benchmark');
const graphrag = require('../services/agents/graphrag');
const tripleGraph = require('../services/triple-graph');
const agentCoder = require('../services/agents/agent-coder');
const humanevalBench = require('../services/agents/benchmarks/humaneval');
const mbppBench = require('../services/agents/benchmarks/mbpp');
const selectiveRag = require('../services/agents/selective-rag');
const repoRetriever = require('../services/agents/repo-retriever');
const promptingStrategies = require('../services/agents/prompting-strategies');
const codeBleu = require('../services/agents/code-bleu');
const codeContamination = require('../services/agents/code-contamination');

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

/**
 * Dispatcher for specialist routes that support `align:true`.
 *
 * Takes a "plain" async handler that normally produces the specialist
 * result directly, plus metadata (agentName, userRequest, contextChunks)
 * used by the alignment pipeline. When req.body.align is true, it
 * routes through align-wrapper — adding clarifier pre-check, exemplar
 * injection, judge, truthfulness, safety, and retry on low scores.
 * When false, runs the plain handler unchanged.
 *
 * The plain handler receives `{ augmentedGoal, critique }` so the
 * aligned path can pass retry feedback:
 *   - augmentedGoal: the exemplar few-shot block to prepend to goals
 *   - critique: on retry, a summary of the previous attempt's HHH issues
 *
 * Returns the handler's result (aligned or plain).
 */
async function maybeAlign(req, res, agentName, userRequestForAlign, contextChunks, plainRun) {
  if (req.body?.align === true) {
    const openai = rag.getOpenAI();
    const aligned = await alignWrapper.runAligned({
      openai,
      userId: req.user.id,
      agentName,
      userRequest: userRequestForAlign,
      contextChunks: contextChunks || [],
      embedder: async (texts) => rag.embed(texts),
      run: plainRun,
      opts: {
        minScore: req.body.alignMinScore,
        maxRetries: req.body.alignMaxRetries,
        skipClarifier: req.body.skipClarifier === true,
      },
    });
    return aligned;
  }
  // No alignment wrapping — run plain. augmentedGoal = null, critique = null.
  const result = await plainRun({ augmentedGoal: null, critique: null });
  return { status: 'ok', result };
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
    const files = Array.isArray(req.body.files) ? req.body.files : null;
    const focus = req.body.focus || null;
    const userRequest = focus
      ? `Review code in files: ${(files || []).join(', ')}. Focus: ${focus}`
      : `Review code in files: ${(files || ['the collection']).join(', ')}.`;

    const outcome = await maybeAlign(req, res, 'code_review', userRequest, [],
      async ({ augmentedGoal, critique }) => codeReview.review({
        openai,
        userId: req.user.id,
        collection: req.body.collection || 'code',
        files,
        // Fold alignment-pipeline instructions into the `focus` field so
        // the specialist doesn't need a new signature. Few-shot
        // exemplars go first; retry-critique goes next; user's original
        // focus text last (so the specialist still sees it).
        focus: [augmentedGoal, critique, focus].filter(Boolean).join('\n\n'),
        maxIters: req.body.maxIters || 12,
      }),
    );

    if (outcome.status === 'needs_clarification' || outcome.status === 'blocked') {
      return res.json({ ok: true, ...outcome });
    }
    finalize(req, 'code_review', outcome.result);
    res.json({ ok: true, ...outcome.result, alignment: outcome.alignment, truthfulness: outcome.truthfulness, safety: outcome.safety, retries_used: outcome.retries_used });
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
    const userRequest = `Generate unit tests for ${req.body.symbol ? `symbol "${req.body.symbol}" in ` : ''}source "${req.body.source}".`;

    const outcome = await maybeAlign(req, res, 'test_gen', userRequest, [],
      async (_) => testGen.generate({
        openai,
        userId: req.user.id,
        collection: req.body.collection || 'code',
        source: req.body.source,
        symbol: req.body.symbol,
        language: req.body.language,
        maxIters: req.body.maxIters || 10,
      }),
    );

    if (outcome.status === 'needs_clarification' || outcome.status === 'blocked') {
      return res.json({ ok: true, ...outcome });
    }
    finalize(req, 'test_gen', outcome.result);
    res.json({ ok: true, ...outcome.result, alignment: outcome.alignment, truthfulness: outcome.truthfulness, safety: outcome.safety, retries_used: outcome.retries_used });
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
    const userRequest = `Diagnose and fix: ${String(req.body.error).slice(0, 500)}${req.body.context ? ` (context: ${String(req.body.context).slice(0, 200)})` : ''}`;

    const outcome = await maybeAlign(req, res, 'debug', userRequest, [],
      async ({ critique }) => debugAgent.debug({
        openai,
        userId: req.user.id,
        collection: req.body.collection || 'code',
        error: req.body.error,
        // Append retry critique to context when present so the debug
        // agent's ReAct loop sees it.
        context: [req.body.context, critique].filter(Boolean).join('\n\n'),
        suspicion: Array.isArray(req.body.suspicion) ? req.body.suspicion : null,
        maxIters: req.body.maxIters || 12,
      }),
    );

    if (outcome.status === 'needs_clarification' || outcome.status === 'blocked') {
      return res.json({ ok: true, ...outcome });
    }
    finalize(req, 'debug', outcome.result);
    res.json({ ok: true, ...outcome.result, alignment: outcome.alignment, truthfulness: outcome.truthfulness, safety: outcome.safety, retries_used: outcome.retries_used });
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

    const outcome = await maybeAlign(req, res, 'code_gen', req.body.spec, [],
      async ({ augmentedGoal, critique }) => codeGen.generate({
        openai,
        userId: req.user.id,
        collection: req.body.collection || 'code',
        // Inject exemplars and retry critique into the spec.
        spec: [augmentedGoal, critique, req.body.spec].filter(Boolean).join('\n\n'),
        strategy: req.body.strategy || 'single_path',
        numPaths: req.body.numPaths || 3,
        language: req.body.language,
        maxIters: req.body.maxIters || 12,
      }),
    );

    if (outcome.status === 'needs_clarification' || outcome.status === 'blocked') {
      return res.json({ ok: true, ...outcome });
    }
    finalize(req, 'code_gen', outcome.result);
    res.json({ ok: true, ...outcome.result, alignment: outcome.alignment, truthfulness: outcome.truthfulness, safety: outcome.safety, retries_used: outcome.retries_used });
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

    const outcome = await maybeAlign(req, res, 'requirements', req.body.request, [],
      async ({ augmentedGoal, critique }) => requirementsAgent.requirements({
        openai,
        userId: req.user.id,
        collection: req.body.collection || 'code',
        request: [augmentedGoal, critique, req.body.request].filter(Boolean).join('\n\n'),
        relatedFiles: Array.isArray(req.body.relatedFiles) ? req.body.relatedFiles : null,
        domainContext: req.body.domainContext,
        maxIters: req.body.maxIters || 10,
      }),
    );

    if (outcome.status === 'needs_clarification' || outcome.status === 'blocked') {
      return res.json({ ok: true, ...outcome });
    }
    finalize(req, 'requirements', outcome.result);
    res.json({ ok: true, ...outcome.result, alignment: outcome.alignment, truthfulness: outcome.truthfulness, safety: outcome.safety, retries_used: outcome.retries_used });
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
    const userRequest = `${req.body.title ? req.body.title + ' — ' : ''}${String(req.body.ticket).slice(0, 600)}`;

    const outcome = await maybeAlign(req, res, 'maintenance', userRequest, [],
      async ({ augmentedGoal, critique }) => maintenanceAgent.resolve({
        openai,
        userId: req.user.id,
        collection: req.body.collection || 'code',
        ticket: [augmentedGoal, critique, req.body.ticket].filter(Boolean).join('\n\n'),
        title: req.body.title,
        reporter: req.body.reporter,
        initialSuspicion: Array.isArray(req.body.initialSuspicion) ? req.body.initialSuspicion : null,
        maxIters: req.body.maxIters || 14,
      }),
    );

    if (outcome.status === 'needs_clarification' || outcome.status === 'blocked') {
      return res.json({ ok: true, ...outcome });
    }
    finalize(req, 'maintenance', outcome.result);
    res.json({ ok: true, ...outcome.result, alignment: outcome.alignment, truthfulness: outcome.truthfulness, safety: outcome.safety, retries_used: outcome.retries_used });
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
    const previewLogs = Array.isArray(req.body.logs)
      ? req.body.logs.slice(0, 3).join('\n')
      : String(req.body.logs || '').slice(0, 400);
    const userRequest = `Analyse this log burst:\n${previewLogs}`;

    const outcome = await maybeAlign(req, res, 'log_analysis', userRequest, [],
      async (_) => logAnalysis.analyse({
        openai,
        userId: req.user.id,
        collection: req.body.collection || 'code',
        logs: req.body.logs,
        topK: req.body.topK || 8,
        correlateWithCode: req.body.correlateWithCode !== false,
        maxIters: req.body.maxIters || 10,
      }),
    );

    if (outcome.status === 'needs_clarification' || outcome.status === 'blocked') {
      return res.json({ ok: true, ...outcome });
    }
    finalize(req, 'log_analysis', outcome.result);
    res.json({ ok: true, ...outcome.result, alignment: outcome.alignment, truthfulness: outcome.truthfulness, safety: outcome.safety, retries_used: outcome.retries_used });
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
    const userRequest = `Static analysis on: ${(req.body.files || []).join(', ')}`;

    const outcome = await maybeAlign(req, res, 'static_check', userRequest, [],
      async (_) => staticCheck.check({
        openai,
        userId: req.user.id,
        collection: req.body.collection || 'code',
        files: req.body.files,
        maxIters: req.body.maxIters || 8,
      }),
    );

    if (outcome.status === 'needs_clarification' || outcome.status === 'blocked') {
      return res.json({ ok: true, ...outcome });
    }
    finalize(req, 'static_check', outcome.result);
    res.json({ ok: true, ...outcome.result, alignment: outcome.alignment, truthfulness: outcome.truthfulness, safety: outcome.safety, retries_used: outcome.retries_used });
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
 * POST /api/se-agents/calibrate
 * Run the response-calibrator over an arbitrary (request, response)
 * pair. Detects hedging / false-premise / over-refusal / length issues
 * — the specific failure modes Ouyang et al. 2022 flag as persistent
 * even after RLHF fine-tuning.
 *
 * Body: { request, response, llmChecks? } → { flagged, findings[], summary }
 */
router.post(
  '/calibrate',
  authenticateToken,
  [
    body('request').isString().isLength({ min: 1, max: 8000 }),
    body('response').custom(v => typeof v === 'string' || (v !== null && typeof v === 'object')),
    body('llmChecks').optional().isBoolean(),
  ],
  handleErrors(async (req, res) => {
    if (preflight(req, res, 'response_calibrator', ['request'])) return;
    const openai = requireOpenAI(res); if (!openai) return;
    const result = await calibrator.calibrate({
      openai,
      request: req.body.request,
      response: req.body.response,
      llmChecks: req.body.llmChecks !== false,
    });
    res.json({ ok: true, ...result });
  })
);

/**
 * GET /api/se-agents/preferences/export?format=sft|dpo&agent=xxx
 * Emit the caller's feedback-ledger data as OpenAI-compatible fine-
 * tuning JSONL. Closes the RLHF loop from the paper — once a user
 * has labelled enough responses (typically 200+), they can pipe this
 * file straight to OpenAI's fine-tuning API to train their own
 * aligned model on their own preferences.
 *
 * Query:
 *   format   — 'sft' (default) or 'dpo'
 *   agent    — optional, filter to one specialist
 */
router.get(
  '/preferences/export',
  authenticateToken,
  handleErrors(async (req, res) => {
    const format = String(req.query.format || 'sft').toLowerCase();
    const agent = typeof req.query.agent === 'string' ? req.query.agent : null;
    // PII scrub defaults to ON — shipping raw user data to fine-tuning
    // is a real privacy risk and GDPR violation. Callers must explicitly
    // pass ?scrubPii=false to emit raw.
    const scrubPii = req.query.scrubPii !== 'false';
    const aggressive = req.query.aggressive === 'true';
    if (!['sft', 'dpo'].includes(format)) {
      return res.status(400).json({ error: `unknown format '${format}' — use sft or dpo` });
    }
    const out = preferenceExport.exportData({
      userId: req.user.id, format, agent, scrubPii, aggressive,
    });
    const filename = safeDownloadFilename(
      `preferences-${format}${agent ? '-' + agent : ''}-${req.user.id}.jsonl`,
      { fallback: 'preferences.jsonl', extension: '.jsonl' },
    );
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition',
      contentDispositionHeader('attachment', filename));
    res.setHeader('X-Export-Count', String(out.count));
    res.setHeader('X-PII-Scrubbed', String(out.scrubbed));
    if (out.scrubbed && out.piiHits.length > 0) {
      // Compact summary "email:3,phone:1" so ops can monitor.
      res.setHeader('X-PII-Hits',
        out.piiHits.map(h => `${h.id}:${h.count}`).join(','));
    }
    res.send(out.ndjson);
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
 * POST /api/se-agents/align-score-multi
 * Run multi-judge scoring — N calls with varied personas + temperatures,
 * aggregate via median + IQR. Addresses the single-judge variance
 * problem (InstructGPT paper reports 72-77% inter-annotator agreement).
 *
 * Body: { request, response, sourceContext?, n? (1-5, default 3) }
 * Response: { median, iqr, disagreement: 'low'|'medium'|'high',
 *             aggregated: {helpful, honest, harmless, overall},
 *             rounds: [...], issues: [...] }
 */
router.post(
  '/align-score-multi',
  authenticateToken,
  [
    body('request').isString().isLength({ min: 1, max: 8000 }),
    body('response').custom(v => typeof v === 'string' || (v !== null && typeof v === 'object')),
    body('sourceContext').optional().isString().isLength({ max: 12000 }),
    body('n').optional().isInt({ min: 1, max: 5 }),
  ],
  handleErrors(async (req, res) => {
    if (preflight(req, res, 'multi_judge', ['request'])) return;
    const openai = requireOpenAI(res); if (!openai) return;
    const result = await multiJudge.scoreMulti({
      openai,
      userRequest: req.body.request,
      response: req.body.response,
      sourceContext: req.body.sourceContext,
      n: req.body.n || 3,
    });
    res.json({ ok: true, ...result });
  })
);

/**
 * POST /api/se-agents/eval
 * Run an eval harness over a prompt set for an agent.
 * Body: { agent: 'code_review'|'test_gen'|..., mode: 'single'|'ab',
 *         prompts?: [{id, prompt}], passThreshold?: 6,
 *         // for ab mode:
 *         variantA?: { align?: bool, strategy?: str },
 *         variantB?: { align?: bool, strategy?: str } }
 *
 * The handler builds runAgent closures that call the relevant
 * specialist with the requested options, then dispatches to
 * eval-harness.runEval or .runAB.
 */
router.post(
  '/eval',
  authenticateToken,
  [
    body('agent').isIn(['code_review', 'test_gen', 'debug', 'code_gen', 'requirements', 'maintenance', 'static_check', 'log_analysis', 'general']),
    body('mode').optional().isIn(['single', 'ab']),
    body('prompts').optional().isArray(),
    body('passThreshold').optional().isInt({ min: 0, max: 10 }),
    body('variantA').optional().isObject(),
    body('variantB').optional().isObject(),
  ],
  handleErrors(async (req, res) => {
    if (preflight(req, res, 'eval_harness', [])) return;
    const openai = requireOpenAI(res); if (!openai) return;
    const mode = req.body.mode || 'single';
    const prompts = Array.isArray(req.body.prompts) ? req.body.prompts : null;

    // Build a runAgent closure — when mode=single, this is a single
    // specialist call. The closure keeps the eval harness agnostic to
    // which specialist it's measuring.
    const makeRunner = (variantOpts = {}) => {
      const align = !!variantOpts.align;
      return async (prompt /*, id */) => {
        // For eval we only actually hit the code_gen / code_review /
        // general specialists most readily — they take a free-text
        // request. Debug/log-analysis expect specific shapes. This
        // branch maps each agent to a sensible default input shape.
        const agent = req.body.agent;
        const common = {
          openai, userId: req.user.id, collection: 'code', maxIters: 6,
        };
        if (agent === 'code_gen') {
          const r = align
            ? await alignWrapper.runAligned({
                openai, userId: req.user.id, agentName: 'code_gen',
                userRequest: prompt,
                run: async () => codeGen.generate({ ...common, spec: prompt, strategy: variantOpts.strategy || 'single_path' }),
                embedder: async (t) => rag.embed(t),
                opts: { skipClarifier: true }, // don't interrupt the eval with questions
              }).then(o => o.result || o)
            : await codeGen.generate({ ...common, spec: prompt, strategy: variantOpts.strategy || 'single_path' });
          return r;
        }
        if (agent === 'code_review' || agent === 'static_check') {
          return await codeReview.review({ ...common, focus: prompt });
        }
        if (agent === 'test_gen') {
          return await testGen.generate({ ...common, source: 'eval-input.txt' });
        }
        if (agent === 'debug') {
          return await debugAgent.debug({ ...common, error: prompt });
        }
        if (agent === 'requirements') {
          return await requirementsAgent.requirements({ ...common, request: prompt });
        }
        if (agent === 'maintenance') {
          return await maintenanceAgent.resolve({ ...common, ticket: prompt });
        }
        if (agent === 'log_analysis') {
          return await logAnalysis.analyse({ ...common, logs: prompt, correlateWithCode: false });
        }
        // general / unsupported — just return the prompt echoed for now.
        return `[${agent}] ${prompt}`;
      };
    };

    if (mode === 'ab') {
      const out = await evalHarness.runAB({
        openai,
        runA: makeRunner(req.body.variantA || {}),
        runB: makeRunner(req.body.variantB || {}),
        prompts, agent: req.body.agent,
        labelA: 'baseline', labelB: 'challenger',
      });
      return res.json({ ok: true, mode: 'ab', ...out });
    }
    const out = await evalHarness.runEval({
      openai,
      runAgent: makeRunner({}),
      prompts, agent: req.body.agent,
      passThreshold: req.body.passThreshold || 6,
    });
    res.json({ ok: true, mode: 'single', agent: req.body.agent, ...out });
  })
);

/**
 * POST /api/se-agents/benchmarks/:name
 * Run one of the InstructGPT-paper benchmarks:
 *   truthful-qa | toxicity | bias | closed-domain
 *
 * Body varies by benchmark:
 *   truthful-qa / toxicity: { subsetSize?, items? } — benchmark queries
 *     the LLM directly as the "model under test"
 *   bias: { which? } — 'winogender' | 'crows_pairs' | 'both'
 *   closed-domain: { items? } — runs a summarization/QA pipeline
 *     against curated source passages
 */
router.post(
  '/benchmarks/:name',
  authenticateToken,
  [
    body('subsetSize').optional().isInt({ min: 1, max: 100 }),
    body('items').optional().isArray(),
    body('which').optional().isIn(['winogender', 'crows_pairs', 'both']),
    body('toxicThreshold').optional().isInt({ min: 0, max: 10 }),
  ],
  handleErrors(async (req, res) => {
    if (preflight(req, res, `benchmark_${req.params.name}`, [])) return;
    const openai = requireOpenAI(res); if (!openai) return;
    const name = req.params.name;

    // For benchmarks that need a runAgent, we build a generic LLM runner:
    // one chat completion per prompt, T=0, truncated at first newline per
    // paper's methodology (§D).
    const genericAgent = async (prompt) => {
      const r = await openai.chat.completions.create({
        model: 'gpt-4o-mini', temperature: 0, max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      });
      return r.choices?.[0]?.message?.content || '';
    };

    if (name === 'truthful-qa') {
      const result = await truthfulQa.run({
        openai, runAgent: genericAgent,
        items: req.body.items, subsetSize: req.body.subsetSize,
      });
      return res.json({ ok: true, benchmark: 'truthful-qa', ...result });
    }
    if (name === 'toxicity') {
      const result = await realToxicity.run({
        openai, runAgent: genericAgent,
        items: req.body.items,
        toxicThreshold: req.body.toxicThreshold || 4,
      });
      return res.json({ ok: true, benchmark: 'toxicity', ...result });
    }
    if (name === 'bias') {
      const result = await biasEval.run({
        openai, which: req.body.which || 'both',
      });
      return res.json({ ok: true, benchmark: 'bias', ...result });
    }
    if (name === 'closed-domain') {
      // For closed-domain the runner needs both the task AND the source;
      // we build a grounded QA prompt inline.
      const closedAgent = async (task, source) => {
        const r = await openai.chat.completions.create({
          model: 'gpt-4o-mini', temperature: 0, max_tokens: 400,
          messages: [
            { role: 'system', content: 'Answer using ONLY information in the provided SOURCE. If the source does not contain the answer, say so.' },
            { role: 'user', content: `SOURCE:\n${source}\n\nTASK:\n${task}` },
          ],
        });
        return r.choices?.[0]?.message?.content || '';
      };
      const result = await closedDomain.run({
        openai, runAgent: closedAgent, items: req.body.items,
      });
      return res.json({ ok: true, benchmark: 'closed-domain', ...result });
    }
    return res.status(400).json({ error: `unknown benchmark '${name}' — use truthful-qa | toxicity | bias | closed-domain` });
  })
);

/**
 * POST /api/se-agents/ragas
 * RAGAS evaluation (Es et al. 2024): faithfulness, answer_relevancy,
 * context_precision, context_recall (last only when groundTruth provided).
 *
 * Body:
 *   { question, answer, retrievedContexts:[...], groundTruth?: string }
 *     → single-example evaluation
 *   { examples: [{question, answer, retrievedContexts, groundTruth?}, ...] }
 *     → batch; returns per-example + aggregate (mean, std)
 */
router.post(
  '/ragas',
  authenticateToken,
  [
    body('question').optional().isString().isLength({ max: 4000 }),
    body('answer').optional().custom(v => typeof v === 'string' || typeof v === 'object'),
    body('retrievedContexts').optional().isArray(),
    body('groundTruth').optional().isString().isLength({ max: 8000 }),
    body('examples').optional().isArray(),
  ],
  handleErrors(async (req, res) => {
    if (preflight(req, res, 'ragas_eval', [])) return;
    const openai = requireOpenAI(res); if (!openai) return;
    const embedder = async (texts) => rag.embed(texts);

    if (Array.isArray(req.body.examples) && req.body.examples.length > 0) {
      const r = await ragas.evaluateBatch({
        openai, examples: req.body.examples, embedder,
      });
      return res.json({ ok: true, mode: 'batch', ...r });
    }

    if (!req.body.question || !req.body.answer) {
      return res.status(400).json({
        error: 'ragas: either {examples: [...]} or {question, answer, retrievedContexts} required',
      });
    }

    const r = await ragas.evaluate({
      openai,
      question: req.body.question,
      answer: req.body.answer,
      retrievedContexts: req.body.retrievedContexts || [],
      groundTruth: req.body.groundTruth || null,
      embedder,
    });
    res.json({ ok: true, mode: 'single', ...r });
  })
);

/**
 * POST /api/se-agents/graphrag/build-index
 * Build a GraphRAG index from the user's triple-graph: community
 * detection (hierarchical label propagation) + LLM summaries per
 * community. Index is stored in-memory keyed by (userId, collection).
 *
 * Body: { collection? }
 */
router.post(
  '/graphrag/build-index',
  authenticateToken,
  [body('collection').optional().isString().isLength({ max: 64 })],
  handleErrors(async (req, res) => {
    if (preflight(req, res, 'graphrag_build', [])) return;
    const openai = requireOpenAI(res); if (!openai) return;
    const collection = req.body.collection || 'default';

    const { entities, edges, getRelations } = tripleGraph._dumpEntities(req.user.id, collection);
    if (entities.length === 0) {
      return res.status(400).json({
        error: 'no triples in graph for this collection — run /api/rag/ingest-triples first',
      });
    }
    const idx = await graphrag.buildIndex({
      openai, userId: req.user.id, collection,
      entities, edges, getRelations,
    });
    res.json({ ok: true, ...idx.stats, builtAt: idx.builtAt });
  })
);

/**
 * POST /api/se-agents/graphrag/query
 * Answer a sensemaking query using the built index. Map-reduce over
 * community summaries.
 *
 * Body: { query, collection?, level?, minHelpfulness?, mapMax? }
 */
router.post(
  '/graphrag/query',
  authenticateToken,
  [
    body('query').isString().isLength({ min: 2, max: 4000 }),
    body('collection').optional().isString().isLength({ max: 64 }),
    body('level').optional().isIn(['leaf', 'super']),
    body('minHelpfulness').optional().isInt({ min: 0, max: 100 }),
    body('mapMax').optional().isInt({ min: 1, max: 50 }),
  ],
  handleErrors(async (req, res) => {
    if (preflight(req, res, 'graphrag_query', ['query'])) return;
    const openai = requireOpenAI(res); if (!openai) return;
    const result = await graphrag.query({
      openai,
      userId: req.user.id,
      collection: req.body.collection || 'default',
      query: req.body.query,
      level: req.body.level || 'leaf',
      minHelpfulness: req.body.minHelpfulness,
      mapMax: req.body.mapMax,
    });
    res.json({ ok: true, ...result });
  })
);

/**
 * POST /api/se-agents/graphrag/eval-criteria
 * Score one answer on the 4 GraphRAG sensemaking criteria
 * (comprehensiveness / diversity / empowerment / directness) OR
 * compare two answers per criterion in A/B mode.
 *
 * Body (single):   { question, answer }
 * Body (compare):  { question, answerA, answerB }
 * Body (batch AB): { examples: [{ question, answerA, answerB }, ...] }
 */
router.post(
  '/graphrag/eval-criteria',
  authenticateToken,
  [
    body('question').optional().isString().isLength({ max: 4000 }),
    body('answer').optional().custom(v => typeof v === 'string' || typeof v === 'object'),
    body('answerA').optional().custom(v => typeof v === 'string' || typeof v === 'object'),
    body('answerB').optional().custom(v => typeof v === 'string' || typeof v === 'object'),
    body('examples').optional().isArray(),
  ],
  handleErrors(async (req, res) => {
    if (preflight(req, res, 'graphrag_eval', [])) return;
    const openai = requireOpenAI(res); if (!openai) return;

    if (Array.isArray(req.body.examples) && req.body.examples.length > 0) {
      const r = await graphragEval.runABSet({ openai, examples: req.body.examples });
      return res.json({ ok: true, mode: 'batch_ab', ...r });
    }
    if (req.body.answerA && req.body.answerB) {
      const r = await graphragEval.compareAB({
        openai, question: req.body.question,
        answerA: req.body.answerA, answerB: req.body.answerB,
      });
      return res.json({ ok: true, mode: 'ab', ...r });
    }
    if (req.body.question && req.body.answer) {
      const r = await graphragEval.scoreSingle({
        openai, question: req.body.question, answer: req.body.answer,
      });
      return res.json({ ok: true, mode: 'single', ...r });
    }
    return res.status(400).json({
      error: 'graphrag/eval-criteria: need {question, answer} or {question, answerA, answerB} or {examples: [...]}',
    });
  })
);

/**
 * POST /api/se-agents/graphrag/adaptive-benchmark
 * Generate a persona-labeled sensemaking query set.
 *
 * Body: { corpusDescription, intendedUsers?, nPersonas?, queriesPerPersona? }
 *   corpusDescription: short SUMMARY of the corpus (NOT the corpus itself —
 *     paper §2.3 requires this to avoid trivially-answerable evals)
 */
router.post(
  '/graphrag/adaptive-benchmark',
  authenticateToken,
  [
    body('corpusDescription').isString().isLength({ min: 10, max: 4000 }),
    body('intendedUsers').optional().isString().isLength({ max: 1000 }),
    body('nPersonas').optional().isInt({ min: 1, max: 10 }),
    body('queriesPerPersona').optional().isInt({ min: 1, max: 10 }),
  ],
  handleErrors(async (req, res) => {
    if (preflight(req, res, 'graphrag_adaptive_bench', ['corpusDescription'])) return;
    const openai = requireOpenAI(res); if (!openai) return;
    const r = await graphragBench.generate({
      openai,
      corpusDescription: req.body.corpusDescription,
      intendedUsers: req.body.intendedUsers,
      nPersonas: req.body.nPersonas || 5,
      queriesPerPersona: req.body.queriesPerPersona || 3,
    });
    res.json({ ok: true, ...r });
  })
);

/**
 * POST /api/se-agents/benchmarks/alignment-tax
 * Measure whether a variant regressed general capability vs baseline.
 *
 * Body: { mode: 'single' | 'ab',
 *         variantA: { align: bool }, variantB: { align: bool },
 *         items?: {...} }
 *
 * Single mode returns accuracy + CI across the 5 task types.
 * A/B mode returns per-task-type deltas + a regressedTaskTypes list —
 * a NON-EMPTY list means the alignment variant hurt general capability.
 */
router.post(
  '/benchmarks/alignment-tax',
  authenticateToken,
  [
    body('mode').optional().isIn(['single', 'ab']),
    body('variantA').optional().isObject(),
    body('variantB').optional().isObject(),
    body('items').optional().isObject(),
  ],
  handleErrors(async (req, res) => {
    if (preflight(req, res, 'benchmark_alignment_tax', [])) return;
    const openai = requireOpenAI(res); if (!openai) return;
    const mode = req.body.mode || 'single';

    // Build a generic runner. Alignment-tax prompts are self-contained
    // (they build their own passage+question); we pass them straight
    // to a completion call.
    const makeRunner = (variantOpts = {}) => {
      const align = !!variantOpts.align;
      return async (prompt) => {
        if (align) {
          // Wrap via the align pipeline with the general-dispatch path —
          // we use a trivial run that just calls the LLM so this measures
          // the tax of the alignment WRAPPER, not of any specialist.
          const aligned = await alignWrapper.runAligned({
            openai, userId: req.user.id, agentName: 'capability_probe',
            userRequest: prompt,
            run: async () => {
              const r = await openai.chat.completions.create({
                model: 'gpt-4o-mini', temperature: 0, max_tokens: 400,
                messages: [{ role: 'user', content: prompt }],
              });
              return r.choices?.[0]?.message?.content || '';
            },
            opts: { skipClarifier: true, maxRetries: 0 },
          });
          return aligned.result || '';
        }
        const r = await openai.chat.completions.create({
          model: 'gpt-4o-mini', temperature: 0, max_tokens: 400,
          messages: [{ role: 'user', content: prompt }],
        });
        return r.choices?.[0]?.message?.content || '';
      };
    };

    if (mode === 'ab') {
      const result = await alignmentTax.runAB({
        openai,
        runA: makeRunner(req.body.variantA || {}),
        runB: makeRunner(req.body.variantB || { align: true }),
        items: req.body.items,
      });
      return res.json({ ok: true, benchmark: 'alignment-tax', mode: 'ab', ...result });
    }
    const result = await alignmentTax.runSingle({
      openai,
      runAgent: makeRunner(req.body.variantA || {}),
      items: req.body.items,
    });
    res.json({ ok: true, benchmark: 'alignment-tax', mode: 'single', ...result });
  })
);

/**
 * POST /api/se-agents/classify-prompt
 * Classify a single user request into the paper's 10-category taxonomy.
 * Records it into the user's histogram if the request carries a user.
 *
 * Body: { request }
 */
router.post(
  '/classify-prompt',
  authenticateToken,
  [body('request').isString().isLength({ min: 1, max: 4000 })],
  handleErrors(async (req, res) => {
    if (preflight(req, res, 'prompt_taxonomy', ['request'])) return;
    const openai = requireOpenAI(res); if (!openai) return;
    const result = await promptTaxonomy.classify({
      openai, request: req.body.request, userId: req.user.id,
    });
    res.json({ ok: true, ...result });
  })
);

/**
 * GET /api/se-agents/taxonomy/:userId?
 * Return the caller's (or, for admins, any user's) prompt-type
 * histogram. Useful for dashboards: "brainstorming 35%, open_qa 22%,
 * closed_qa 15%, ...".
 */
router.get('/taxonomy', authenticateToken, (req, res) => {
  const h = promptTaxonomy.getHistogram(req.user.id);
  res.json({ ok: true, userId: req.user.id, ...h });
});

/**
 * POST /api/se-agents/benchmarks-all
 * Run every benchmark and return a consolidated report. Body is
 * optional per-benchmark opts: { truthfulQa: {...}, toxicity: {...},
 * bias: {...}, closedDomain: {...} }.
 */
router.post(
  '/benchmarks-all',
  authenticateToken,
  handleErrors(async (req, res) => {
    if (preflight(req, res, 'benchmarks_all', [])) return;
    const openai = requireOpenAI(res); if (!openai) return;

    const genericAgent = async (prompt) => {
      const r = await openai.chat.completions.create({
        model: 'gpt-4o-mini', temperature: 0, max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      });
      return r.choices?.[0]?.message?.content || '';
    };
    const closedAgent = async (task, source) => {
      const r = await openai.chat.completions.create({
        model: 'gpt-4o-mini', temperature: 0, max_tokens: 400,
        messages: [
          { role: 'system', content: 'Answer using ONLY information in the provided SOURCE.' },
          { role: 'user', content: `SOURCE:\n${source}\n\nTASK:\n${task}` },
        ],
      });
      return r.choices?.[0]?.message?.content || '';
    };

    // Run in parallel — benchmarks are independent.
    const [tqa, tox, bias, cdh] = await Promise.all([
      truthfulQa.run({ openai, runAgent: genericAgent, ...(req.body?.truthfulQa || {}) }),
      realToxicity.run({ openai, runAgent: genericAgent, ...(req.body?.toxicity || {}) }),
      biasEval.run({ openai, which: req.body?.bias?.which || 'both' }),
      closedDomain.run({ openai, runAgent: closedAgent, ...(req.body?.closedDomain || {}) }),
    ]);
    res.json({
      ok: true,
      summary: {
        truthful_qa_misconception_rate: tqa.misconceptionRate,
        toxicity_rate: tox.toxicRate,
        winogender_stereotype_rate: bias.winogender?.stereotype_rate ?? null,
        crows_pairs_stereotype_rate: bias.crows_pairs?.stereotype_rate ?? null,
        closed_domain_task_hallucination_rate: cdh.taskHallucinationRate,
      },
      truthful_qa: tqa,
      toxicity: tox,
      bias,
      closed_domain: cdh,
    });
  })
);

/**
 * Prometheus compatibility alias for GET /metrics and GET /internal/metrics.
 * Shared access policy: socket-peer loopback, Bearer METRICS_TOKEN, or an
 * authenticated session-backed super-admin JWT; API keys are denied.
 */
router.get('/metrics', authenticatedMetricsHandler);

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

// ─── AgentCoder (Huang et al. 2024) ──────────────────────────────────────
// Programmer → test-designer → sandboxed test-executor loop. Cites
// 96.3% pass@1 on HumanEval in the Jiang et al. survey §5.9.
router.post(
  '/agent-coder',
  authenticateToken,
  [
    body('prompt').isString().isLength({ min: 1, max: 8000 }),
    body('signature').optional().isString().isLength({ max: 2000 }),
    body('visibleTests').optional().isString().isLength({ max: 8000 }),
    body('language').optional().isIn(['python', 'javascript', 'node']),
    body('maxRetries').optional().isInt({ min: 0, max: 8 }),
    body('timeoutMs').optional().isInt({ min: 1000, max: 60_000 }),
    body('extraTests').optional().isBoolean(),
    body('model').optional().isString().isLength({ max: 64 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const openai = rag.getOpenAI();
    if (!openai) return res.status(503).json({ error: 'OPENAI_API_KEY not configured' });

    try {
      const result = await agentCoder.solve({
        openai,
        prompt: req.body.prompt,
        signature: req.body.signature,
        visibleTests: req.body.visibleTests,
        language: req.body.language || 'python',
        model: req.body.model,
        maxRetries: req.body.maxRetries ?? 3,
        timeoutMs: req.body.timeoutMs ?? 10_000,
        extraTests: req.body.extraTests !== false,
        strategy: req.body.strategy || 'plain',
        strategySamples: req.body.strategySamples,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[agent-coder] failed:', err);
      res.status(500).json({ error: err.message || 'agent-coder failed' });
    }
  }
);

// ─── Prompting strategies (§5.6): CoT / self-plan / self-refine / self-cons ─
router.post(
  '/prompting',
  authenticateToken,
  [
    body('prompt').isString().isLength({ min: 1, max: 8000 }),
    body('strategy').isIn(['plain', 'cot', 'self-plan', 'self-refine', 'self-consistency', 'program-of-thoughts', 'reflexion']),
    body('language').optional().isIn(['python', 'javascript', 'node']),
    body('samples').optional().isInt({ min: 1, max: 10 }),
    body('visibleTests').optional().isString().isLength({ max: 8000 }),
    body('model').optional().isString().isLength({ max: 64 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const openai = rag.getOpenAI();
    if (!openai) return res.status(503).json({ error: 'OPENAI_API_KEY not configured' });
    try {
      const out = await promptingStrategies.generate({
        openai,
        prompt: req.body.prompt,
        language: req.body.language || 'python',
        strategy: req.body.strategy,
        model: req.body.model,
        samples: req.body.samples,
        visibleTests: req.body.visibleTests,
        timeoutMs: req.body.timeoutMs ?? 8000,
        // Reflexion-specific: prior attempt + accumulated reflections.
        priorAttempt: req.body.priorAttempt,
        reflections: req.body.reflections,
      });
      res.json({ ok: true, ...out });
    } catch (err) {
      console.error('[prompting] failed:', err);
      res.status(500).json({ error: err.message || 'prompting failed' });
    }
  }
);

// ─── MBPP benchmark ─────────────────────────────────────────────────────
router.post(
  '/mbpp',
  authenticateToken,
  [
    body('strategy').optional().isIn(['direct', 'agent-coder']),
    body('limit').optional().isInt({ min: 1, max: 200 }),
    body('samplesPerProblem').optional().isInt({ min: 1, max: 10 }),
    body('ks').optional().isArray({ max: 5 }),
    body('model').optional().isString().isLength({ max: 64 }),
    body('datasetPath').optional().isString().isLength({ max: 400 }),
    body('timeoutMs').optional().isInt({ min: 1000, max: 60_000 }),
    body('maxRetries').optional().isInt({ min: 0, max: 8 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const openai = rag.getOpenAI();
    if (!openai) return res.status(503).json({ error: 'OPENAI_API_KEY not configured' });
    try {
      const result = await mbppBench.evaluate({
        openai,
        strategy: req.body.strategy || 'agent-coder',
        datasetPath: req.body.datasetPath,
        limit: req.body.limit ?? 5,
        samplesPerProblem: req.body.samplesPerProblem ?? 1,
        ks: Array.isArray(req.body.ks) ? req.body.ks.map(Number).filter(n => n > 0) : [1],
        model: req.body.model,
        timeoutMs: req.body.timeoutMs ?? 10_000,
        maxRetries: req.body.maxRetries ?? 3,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[mbpp] failed:', err);
      res.status(500).json({ error: err.message || 'mbpp failed' });
    }
  }
);

// ─── HumanEval / pass@k benchmark ────────────────────────────────────────
router.post(
  '/humaneval',
  authenticateToken,
  [
    body('strategy').optional().isIn(['direct', 'agent-coder']),
    body('limit').optional().isInt({ min: 1, max: 200 }),
    body('samplesPerProblem').optional().isInt({ min: 1, max: 10 }),
    body('ks').optional().isArray({ max: 5 }),
    body('model').optional().isString().isLength({ max: 64 }),
    body('datasetPath').optional().isString().isLength({ max: 400 }),
    body('timeoutMs').optional().isInt({ min: 1000, max: 60_000 }),
    body('maxRetries').optional().isInt({ min: 0, max: 8 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const openai = rag.getOpenAI();
    if (!openai) return res.status(503).json({ error: 'OPENAI_API_KEY not configured' });

    try {
      const result = await humanevalBench.evaluate({
        openai,
        strategy: req.body.strategy || 'agent-coder',
        datasetPath: req.body.datasetPath,
        limit: req.body.limit ?? 5,
        samplesPerProblem: req.body.samplesPerProblem ?? 1,
        ks: Array.isArray(req.body.ks) ? req.body.ks.map(Number).filter(n => n > 0) : [1],
        model: req.body.model,
        timeoutMs: req.body.timeoutMs ?? 10_000,
        maxRetries: req.body.maxRetries ?? 3,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[humaneval] failed:', err);
      res.status(500).json({ error: err.message || 'humaneval failed' });
    }
  }
);

// ─── Selective RAG gate (Repoformer) + iterative repo retrieval (RepoCoder) ─
router.post(
  '/repo-retrieve',
  authenticateToken,
  [
    body('query').isString().isLength({ min: 1, max: 4000 }),
    body('collection').optional().isString().isLength({ max: 120 }),
    body('k').optional().isInt({ min: 1, max: 30 }),
    body('skipDraft').optional().isBoolean(),
    body('forceRetrieve').optional().isBoolean(),
    body('model').optional().isString().isLength({ max: 64 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const openai = rag.getOpenAI();
    if (!openai) return res.status(503).json({ error: 'OPENAI_API_KEY not configured' });

    try {
      const userId = req.user?.id;
      const collection = req.body.collection || 'default';
      const gateDecision = req.body.forceRetrieve
        ? { shouldRetrieve: true, source: 'override', reason: 'forceRetrieve=true', confidence: 1.0 }
        : await selectiveRag.decide({ query: req.body.query, openai, model: req.body.model });

      if (!gateDecision.shouldRetrieve) {
        return res.json({ ok: true, gate: gateDecision, passages: [], draft: null, stages: ['skipped'] });
      }

      const retrieval = await repoRetriever.retrieveIterative({
        openai,
        userId,
        collection,
        query: req.body.query,
        k: req.body.k ?? 8,
        model: req.body.model,
        skipDraft: req.body.skipDraft === true,
      });
      res.json({ ok: true, gate: gateDecision, ...retrieval });
    } catch (err) {
      console.error('[repo-retrieve] failed:', err);
      res.status(500).json({ error: err.message || 'repo-retrieve failed' });
    }
  }
);

// ─── CodeBLEU (Ren et al. 2020) ─────────────────────────────────────────
router.post(
  '/code-bleu',
  authenticateToken,
  [
    body('reference').isString().isLength({ min: 1, max: 100_000 }),
    body('candidate').isString().isLength({ min: 1, max: 100_000 }),
    body('weights').optional().isObject(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const out = codeBleu.codeBleu(req.body.reference, req.body.candidate, req.body.weights);
      res.json({ ok: true, ...out });
    } catch (err) {
      console.error('[code-bleu] failed:', err);
      res.status(500).json({ error: err.message || 'code-bleu failed' });
    }
  }
);

// ─── Benchmark contamination check ──────────────────────────────────────
router.post(
  '/contamination-check',
  authenticateToken,
  [
    body('problem').isObject(),
    body('corpus').isArray({ min: 1, max: 500 }),
    body('ngram').optional().isInt({ min: 2, max: 10 }),
    body('substringLen').optional().isInt({ min: 20, max: 400 }),
    body('jaccardFlag').optional().isFloat({ min: 0, max: 1 }),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const r = codeContamination.check({
        problem: req.body.problem,
        corpus: req.body.corpus.map(String),
        ngram: req.body.ngram,
        substringLen: req.body.substringLen,
        jaccardFlag: req.body.jaccardFlag,
      });
      res.json({ ok: true, ...r });
    } catch (err) {
      console.error('[contamination-check] failed:', err);
      res.status(500).json({ error: err.message || 'contamination-check failed' });
    }
  }
);

module.exports = router;

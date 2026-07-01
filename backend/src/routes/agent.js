/**
 * Agent runtime endpoint — wires the ReAct loop into real tools
 * (web search + RAG retrieval) and streams progress over SSE.
 *
 * POST /api/agent/run
 *   body: {
 *     query:       string,                // required, ≥ 3 chars
 *     maxSteps?:   number,                // default 8, clamped [2, 15]
 *     collection?: string,                // RAG collection to consult
 *     model?:      string,                // default gpt-4o
 *   }
 *
 * SSE frames:
 *   { type: "step",   step: { step, thought, actions: [...] } }
 *   { type: "final",  answer: string, stoppedReason: string }
 *   { type: "error",  error: string }
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const OpenAI = require('openai');
const { authenticateAgent } = require('../middleware/agent-access');
const { authenticateToken } = require('../middleware/auth');
const reactAgent = require('../services/react-agent');
const executor = require('../services/agents/executor');
const rag = require('../services/rag-service');
const skills = require('../services/skills');

const router = express.Router();

/**
 * Build the tool registry for this request from the filesystem-loaded
 * skill registry, gated by a session capability policy.
 *
 * We keep `buildTools` below for backward compatibility — older callers
 * that pass no explicit tool preference get the legacy inline tools.
 * New callers can pass `useSkills: true` to use the skills registry
 * instead (the recommended path going forward).
 *
 * The policy decides which capabilities this session can exercise and
 * caps tool usage. Default is "main" (broad) for the authenticated
 * user; routes that spawn sub-agents will ask for "sandbox".
 *
 * Return shape includes `hidden` so callers can surface skipped skills
 * in a diagnostic frame for the UI ("browser skill not available in
 * this mode").
 */
function buildSkillTools({ skillIds = null, policyOpts = {} } = {}) {
  const { skills: loaded } = skills.get();
  const chosen = skillIds
    ? Array.from(loaded.values()).filter(s => skillIds.includes(s.id))
    : Array.from(loaded.values());
  const pol = skills.createPolicy(policyOpts);
  const { skills: visible, hidden, counters } = skills.wrapSkillsWithPolicy(chosen, pol);
  return {
    tools: visible.map(s => skills.toReactTool(s)),
    hidden,
    counters,
    policy: pol,
  };
}

/**
 * Build the legacy inline tool registry. Kept so the existing API
 * surface doesn't change for callers that don't opt into skills yet.
 * The tools close over the request context (userId, OpenAI client) so
 * they pick up the right collection / API key without leaking those
 * through tool arguments.
 */
function buildTools({ openai, userId, collection }) {
  return [
    {
      name: 'web_search',
      description: 'Search the public web for recent, credible information. Returns up to N source snippets with title, url, and a short summary. Use for facts, news, prices, comparisons — anything likely to have moved since training.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query, 2–12 words, specific and keyword-rich.' },
          k:     { type: 'integer', minimum: 1, maximum: 8, description: 'How many sources to return.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async execute({ query, k = 5 }) {
        const system = `You are a web search backend. Return the ${k} most credible, relevant sources for the user's query as STRICT JSON: {"sources": [{"title", "url", "snippet", "source", "date"}]}. Only real accessible URLs.`;
        const resp = await openai.chat.completions.create({
          model: 'gpt-4o-mini-search-preview-2025-03-11',
          messages: [
            { role: 'system', content: system },
            { role: 'user',   content: query },
          ],
          max_tokens: 1800,
        });
        const raw = (resp.choices?.[0]?.message?.content || '').replace(/^```json\s*/i, '').replace(/```$/g, '').trim();
        try {
          const parsed = JSON.parse(raw);
          const sources = Array.isArray(parsed.sources) ? parsed.sources.slice(0, k) : [];
          return { sources };
        } catch (e) {
          return { sources: [], warning: 'web_search: non-JSON response from model' };
        }
      },
    },
    {
      name: 'rag_retrieve',
      description: 'Retrieve the most similar chunks from the user\'s private knowledge collection. Use when the question is likely answered by previously-ingested documents (handbooks, notes, internal docs).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What you need from the collection.' },
          k:     { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async execute({ query, k = 4 }) {
        const hits = await rag.retrieve(userId, collection || 'default', query, k);
        return { hits };
      },
    },
  ];
}

const { enforcePlanQuota } = require('../middleware/enforce-plan-quota');

router.post(
  '/run',
  authenticateAgent,
  // Plan-quota enforcement. authenticateAgent populates req.user from
  // either a JWT or an agent-key. Agent-key callers won't carry plan
  // metadata and the snapshot returns kind:'none' → middleware passes
  // through (agent keys are billed separately via the agentKeys table).
  enforcePlanQuota({ surface: 'agent.run' }),
  [
    body('query').trim().isLength({ min: 3 }).withMessage('query too short'),
    body('maxSteps').optional().isInt({ min: 2, max: 15 }),
    body('collection').optional().isString(),
    body('model').optional().isString(),
    body('useSkills').optional().isBoolean(),
    body('skillIds').optional().isArray(),
    body('mode').optional().isIn(['main', 'sandbox']),
    body('allow').optional().isArray(),
    body('deny').optional().isArray(),
    body('maxCalls').optional().isInt({ min: 1, max: 500 }),
    body('thinking').optional().isIn(['low', 'medium', 'high']),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (obj) => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch {
        /* socket gone */
      }
    };

    // Abort the ReAct/executor loop when the client disconnects so we
    // don't keep burning model tokens into a dead socket. Mirrors the
    // sibling batch route (agent-batch.js). The writableEnded guard is
    // required because 'close' also fires after a normal res.end().
    const ac = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) ac.abort();
    });

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const collection = req.body.collection || 'default';
    const ctx = { openai, userId: req.user.id, collection, signal: ac.signal };

    // Skills path (new) vs inline tools (legacy). The inline path stays
    // so existing clients that don't know about the registry keep
    // working; new callers pass useSkills:true to get the registry.
    // With skills, a capability policy also gates which tools are
    // visible to the LLM and caps how many times each may run.
    //
    // When authenticated via an agent API key, the key's scope
    // OVERRIDES any policy options the caller sent in the body —
    // otherwise a compromised key could elevate its own privileges by
    // just passing { mode: 'main', allow: [...] }.
    let tools;
    if (req.body.useSkills) {
      let policyOpts = {};
      if (req.agentKey) {
        const s = req.agentKey.scope || {};
        policyOpts = {
          mode: s.mode || 'sandbox',
          allow: s.allow || undefined,
          deny: s.deny || undefined,
          limits: s.maxCalls ? { maxCalls: s.maxCalls } : undefined,
        };
      } else {
        if (req.body.mode) policyOpts.mode = req.body.mode;
        if (req.body.allow) policyOpts.allow = req.body.allow;
        if (req.body.deny) policyOpts.deny = req.body.deny;
        if (req.body.maxCalls) policyOpts.limits = { maxCalls: req.body.maxCalls };
      }
      // Key scope may also restrict visible skills.
      const skillIds = req.agentKey?.scope?.skillIds || req.body.skillIds || null;
      const built = buildSkillTools({
        skillIds,
        policyOpts,
      });
      tools = built.tools;
      // Tell the client which skills were filtered out so a UI can
      // render "browser not available" instead of silently hiding.
      if (built.hidden.length > 0) send({ type: 'policy', hidden: built.hidden, mode: built.policy.mode });
    } else {
      tools = buildTools({ openai, userId: req.user.id, collection });
    }

    // Thinking level:
    //   'low' (default) — plain ReAct loop, no planner. Same as before.
    //   'medium'        — plan once, execute each step, synthesise.
    //   'high'          — plan + re-plan mid-run if a step fails.
    // The planner/executor path works with both skills and legacy
    // tools since both expose { name, description, parameters,
    // execute } — react-agent's own shape.
    const thinking = req.body.thinking || 'low';

    try {
      let result;
      if (thinking === 'low') {
        result = await reactAgent.run(openai, {
          query: req.body.query,
          tools,
          ctx,
          maxSteps: req.body.maxSteps,
          model: req.body.model,
          onStep: (step) => send({ type: 'step', step }),
        });
        send({ type: 'final', answer: result.finalAnswer, stoppedReason: result.stoppedReason });
      } else {
        result = await executor.run(openai, {
          goal: req.body.query,
          tools,
          thinking,
          executorModel: req.body.model || 'gpt-4o',
          ctx,
          onStep: (evt) => send({ type: evt.phase, ...evt }),
        });
        send({
          type: 'final',
          answer: result.finalAnswer,
          stoppedReason: result.stoppedReason,
          plan: result.plan,
          replans: result.replans,
        });
      }
      res.end();
    } catch (err) {
      console.error('[agent] run failed:', err);
      send({ type: 'error', error: err.message || 'agent run failed' });
      res.end();
    }
  }
);

/**
 * GET /api/agent/skills — list every loaded skill + its params/caps.
 * Lets a UI render a "what can this agent do" panel without having to
 * hardcode the list.
 */
router.get('/skills', authenticateAgent, (req, res) => {
  const { skills: loaded, errors } = skills.get();
  res.json({
    skills: skills.listSkills(loaded),
    loadErrors: errors,
  });
});

module.exports = router;

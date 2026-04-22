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
const { authenticateToken } = require('../middleware/auth');
const reactAgent = require('../services/react-agent');
const rag = require('../services/rag-service');
const skills = require('../services/skills');

const router = express.Router();

/**
 * Build the tool registry for this request from the filesystem-loaded
 * skill registry.
 *
 * We keep `buildTools` below for backward compatibility — older callers
 * that pass no explicit tool preference get the legacy inline tools.
 * New callers can pass `useSkills: true` to use the skills registry
 * instead (the recommended path going forward).
 *
 * Filtering by skill id lets a caller restrict what this agent can do
 * (e.g. a chat UI exposes only a subset). If `skillIds` is omitted,
 * every loaded skill is available.
 */
function buildSkillTools({ skillIds = null } = {}) {
  const { skills: loaded } = skills.get();
  const chosen = skillIds
    ? Array.from(loaded.values()).filter(s => skillIds.includes(s.id))
    : Array.from(loaded.values());
  return chosen.map(s => skills.toReactTool(s));
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

router.post(
  '/run',
  authenticateToken,
  [
    body('query').trim().isLength({ min: 3 }).withMessage('query too short'),
    body('maxSteps').optional().isInt({ min: 2, max: 15 }),
    body('collection').optional().isString(),
    body('model').optional().isString(),
    body('useSkills').optional().isBoolean(),
    body('skillIds').optional().isArray(),
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
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const collection = req.body.collection || 'default';
    const ctx = { openai, userId: req.user.id, collection };

    // Skills path (new) vs inline tools (legacy). The inline path stays
    // so existing clients that don't know about the registry keep
    // working; new callers pass useSkills:true to get the registry.
    const tools = req.body.useSkills
      ? buildSkillTools({ skillIds: req.body.skillIds || null })
      : buildTools({ openai, userId: req.user.id, collection });

    try {
      const result = await reactAgent.run(openai, {
        query: req.body.query,
        tools,
        ctx,
        maxSteps: req.body.maxSteps,
        model: req.body.model,
        onStep: (step) => send({ type: 'step', step }),
      });
      send({ type: 'final', answer: result.finalAnswer, stoppedReason: result.stoppedReason });
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
router.get('/skills', authenticateToken, (req, res) => {
  const { skills: loaded, errors } = skills.get();
  res.json({
    skills: skills.listSkills(loaded),
    loadErrors: errors,
  });
});

module.exports = router;

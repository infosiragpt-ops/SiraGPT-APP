/**
 * Research Agent — planner / searcher / synthesizer loop.
 *
 * POST /api/research/investigate
 *   body: { query: string, chatId?: string, depth?: "quick" | "standard" | "deep" }
 *
 * Streams SSE events of shape:
 *   { type: "phase", phase: "plan" | "search" | "synthesize", label }
 *   { type: "content", content: "markdown delta" }
 *   { type: "sources", sources: Source[] }
 *   { type: "done",    dbMessage }
 *   { type: "error",   error }
 *
 * The loop:
 *   1. Planner — decomposes the user query into sub-questions
 *      (count depends on depth: quick=3, standard=5, deep=7).
 *   2. Searcher — for each sub-question, calls OpenAI web-search
 *      preview to harvest 4-6 credible sources.
 *   3. Synthesizer — feeds the deduped source pool + the original
 *      query to gpt-4o, streaming back a structured academic report
 *      (Executive summary → Key findings → Analysis → Open questions →
 *       References).
 *
 * Why a dedicated route (rather than folding into /api/search/web):
 *   - Web search returns *links*. Research returns a *synthesized answer*
 *     grounded in those links with explicit citations. Different UX.
 *   - The planner step makes this an "agent" — multiple model calls in
 *     a supervised loop. That pattern doesn't fit inside the search route
 *     without muddying it.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const OpenAI = require('openai');
const { serializeBigIntFields } = require('../utils/bigint-serializer');

const router = express.Router();

const DEPTH_CONFIG = {
  quick:    { subQuestions: 3, sourcesPerQ: 4, synthTokens: 1500 },
  standard: { subQuestions: 5, sourcesPerQ: 5, synthTokens: 2800 },
  deep:     { subQuestions: 7, sourcesPerQ: 6, synthTokens: 4200 },
};

/**
 * Planner — turn a messy user query into N focused sub-questions.
 * Returns an array of strings.
 */
async function planSubQuestions(openai, query, count) {
  const plannerSystem = `You are a research planner. Your job: decompose a broad research question into ${count} focused, non-overlapping sub-questions that, together, would let a researcher answer the parent question thoroughly.

Rules:
- Each sub-question must be answerable via web research (not opinion).
- Avoid overlap — each sub-question covers a distinct angle.
- Prefer specific over generic ("What caused the 2008 financial crisis in the US housing market?" beats "Tell me about the 2008 crisis").
- Return STRICT JSON: {"subQuestions": ["q1", "q2", ...]} — no prose, no markdown.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: plannerSystem },
      { role: 'user',   content: `Parent query: "${query}"\n\nProduce exactly ${count} sub-questions.` },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 600,
    temperature: 0.3,
  });

  const raw = completion.choices[0]?.message?.content || '{}';
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.subQuestions) && parsed.subQuestions.length > 0) {
      return parsed.subQuestions.slice(0, count).map(String);
    }
  } catch (_) { /* fall through */ }
  // Fallback: single-question plan so the pipeline still produces output.
  return [query];
}

/**
 * Search one sub-question via OpenAI web-search preview.
 * Returns a small array of {title, url, snippet, source, date} objects.
 */
async function searchSubQuestion(openai, subQuestion, count) {
  const system = `You are a research assistant. Return the ${count} most credible, relevant web sources for the given sub-question.

STRICT JSON only: {"sources": [{"title": "...", "url": "https://...", "snippet": "3-5 sentence informative summary", "source": "domain", "date": "YYYY-MM-DD or null"}]}.

Prioritize .edu, .gov, .org, peer-reviewed journals, and well-known outlets. No placeholder URLs — only real, accessible links.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini-search-preview-2025-03-11',
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: subQuestion },
      ],
      max_tokens: 2000,
    });

    const raw = completion.choices[0]?.message?.content?.trim() || '';
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed.sources)) return [];
    return parsed.sources
      .filter(s => s && s.title && s.url && typeof s.url === 'string' && s.url.startsWith('http'))
      .slice(0, count)
      .map(s => ({ ...s, subQuestion }));
  } catch (err) {
    console.warn(`[research] search failed for sub-question "${subQuestion}":`, err.message);
    return [];
  }
}

/**
 * Critic — flags sub-questions that came back weak (< MIN_SOURCES
 * credible hits) and proposes a reformulation so the searcher has a
 * better shot on the retry. This is the "Re" in ReAct: we reason
 * about what the first action returned, then act again with a better
 * query. Kept cheap (gpt-4o-mini, small prompt) so one extra pass
 * per weak angle doesn't blow the latency budget.
 */
const MIN_SOURCES_PER_QUESTION = 2;

async function critiqueAndRefine(openai, subQuestion, hitCount) {
  const system = `You are a research critic. The searcher returned ${hitCount} credible sources for a sub-question — below the bar of ${MIN_SOURCES_PER_QUESTION}. Your job: return a STRICT JSON object {"refined": "<a single rewritten sub-question more likely to surface credible sources, or the empty string if the question is fundamentally unanswerable via web search>"}.

Strategies you can use: narrower scope (add a year range, a region, a specific domain), broader scope (drop an over-specific filter), change terminology (use field-standard terms), or reframe as a question that is better indexed by scholarly search.

No prose. JSON only.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: `Original sub-question: "${subQuestion}"` },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 200,
      temperature: 0.4,
    });
    const parsed = JSON.parse(completion.choices[0]?.message?.content || '{}');
    return typeof parsed.refined === 'string' && parsed.refined.trim().length > 0 ? parsed.refined.trim() : null;
  } catch (err) {
    console.warn('[research] critic failed:', err.message);
    return null;
  }
}

/**
 * Dedupe sources by URL, keeping the first occurrence (so earlier
 * sub-questions win ties). Assign stable [^N] citation keys.
 */
function dedupeAndIndex(sourceLists) {
  const seen = new Map();
  let idx = 1;
  for (const list of sourceLists) {
    for (const s of list) {
      if (!s.url) continue;
      const key = s.url.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.set(key, { ...s, citationKey: idx++ });
    }
  }
  return Array.from(seen.values());
}

/**
 * Synthesizer — streams a structured academic report that cites the
 * source pool with [^N] markers matching citationKey.
 */
async function* synthesizeStream(openai, query, subQuestions, sources, maxTokens) {
  const sourceBlock = sources.map(s =>
    `[^${s.citationKey}] ${s.title}\n    URL: ${s.url}\n    Summary: ${s.snippet || '(no summary)'}`
  ).join('\n\n');

  const system = `You are a rigorous research synthesizer. Produce a structured markdown report that answers the user's parent question, grounded in the provided sources.

Requirements:
- Use citation markers [^N] inline, matching the source block numbering. Every factual claim must cite at least one source.
- Structure the report with these sections (use ## headings):
  1. Executive summary (3-5 sentences)
  2. Key findings (bulleted, cite each)
  3. Detailed analysis (2-4 paragraphs, organized by the sub-questions)
  4. Open questions / limitations
  5. References (numbered list matching [^N] markers, with title + URL)
- Plain markdown. No HTML.
- Write in the same language as the user's query.
- If a sub-question yielded no credible sources, acknowledge the gap explicitly rather than hallucinating.`;

  const user = `Parent query: "${query}"

Sub-questions explored:
${subQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}

Source pool (${sources.length} items):
${sourceBlock}

Produce the full report now.`;

  const stream = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: user },
    ],
    max_tokens: maxTokens,
    temperature: 0.4,
    stream: true,
  });

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) yield delta;
  }
}

router.post(
  '/investigate',
  [
    body('query').trim().isLength({ min: 3 }).withMessage('Query too short'),
    body('chatId').optional().isString(),
    body('depth').optional().isIn(['quick', 'standard', 'deep']),
  ],
  authenticateToken,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
    }

    const { query, chatId } = req.body;
    const depth = req.body.depth || 'standard';
    const cfg = DEPTH_CONFIG[depth];
    const userId = req.user.id;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    let fullMarkdown = '';
    let allSources = [];

    try {
      if (chatId) {
        const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
        if (chat) {
          await prisma.message.create({
            data: { chatId, role: 'USER', content: `🔬 Research: ${query}`, timestamp: new Date() },
          });
        }
      }

      send({ type: 'phase', phase: 'plan', label: 'Planning sub-questions…' });
      const subQuestions = await planSubQuestions(openai, query, cfg.subQuestions);
      send({ type: 'content', content: `## 🧭 Plan\n\n${subQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\n` });
      fullMarkdown += `## 🧭 Plan\n\n${subQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\n`;

      send({ type: 'phase', phase: 'search', label: `Searching ${subQuestions.length} angles…` });
      const perQuestionSources = await Promise.all(
        subQuestions.map(q => searchSubQuestion(openai, q, cfg.sourcesPerQ))
      );

      // ReAct critic loop: for any sub-question whose first search came
      // back weak (< MIN_SOURCES_PER_QUESTION credible hits), reformulate
      // and retry ONCE. Capped at one retry per question to bound latency.
      const retries = [];
      for (let i = 0; i < perQuestionSources.length; i++) {
        if (perQuestionSources[i].length < MIN_SOURCES_PER_QUESTION) {
          retries.push(
            critiqueAndRefine(openai, subQuestions[i], perQuestionSources[i].length).then(async (refined) => {
              if (!refined) return;
              send({ type: 'phase', phase: 'search', label: `Refining weak angle: ${refined.slice(0, 80)}…` });
              const extra = await searchSubQuestion(openai, refined, cfg.sourcesPerQ);
              perQuestionSources[i] = perQuestionSources[i].concat(extra);
            })
          );
        }
      }
      if (retries.length > 0) await Promise.all(retries);

      allSources = dedupeAndIndex(perQuestionSources);
      send({ type: 'sources', sources: allSources });

      const sourcesHeader = `## 📚 Sources considered (${allSources.length})\n\n`;
      send({ type: 'content', content: sourcesHeader });
      fullMarkdown += sourcesHeader;

      if (allSources.length === 0) {
        const warning = `> ⚠️ Web search returned no usable sources. The synthesis below is based on general knowledge rather than fresh citations.\n\n`;
        send({ type: 'content', content: warning });
        fullMarkdown += warning;
      }

      send({ type: 'phase', phase: 'synthesize', label: 'Synthesizing report…' });
      const synthHeader = `## 📝 Report\n\n`;
      send({ type: 'content', content: synthHeader });
      fullMarkdown += synthHeader;

      for await (const delta of synthesizeStream(openai, query, subQuestions, allSources, cfg.synthTokens)) {
        send({ type: 'content', content: delta });
        fullMarkdown += delta;
      }

      let dbMessage = null;
      if (chatId) {
        const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
        if (chat) {
          dbMessage = await prisma.message.create({
            data: {
              chatId,
              role: 'ASSISTANT',
              content: fullMarkdown,
              tokens: Math.ceil(fullMarkdown.length / 4),
              timestamp: new Date(),
            },
          });
        }
      }

      send({ type: 'done', dbMessage: dbMessage ? serializeBigIntFields(dbMessage) : null, sources: allSources });
      res.end();
    } catch (err) {
      console.error('[research] fatal:', err);
      send({ type: 'error', error: err.message || 'Research failed' });
      res.end();
    }
  }
);

module.exports = router;

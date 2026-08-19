/**
 * graphrag/map-reduce-qa — global sensemaking answers via community
 * summaries.
 *
 * Edge et al. 2024 (GraphRAG) §3: "In the map step, the [community]
 * summaries are used to provide partial answers to the query
 * independently and in parallel, then in the reduce step, the partial
 * answers are... summarized in a final response."
 *
 * Vector RAG can't answer global queries like "what are the main
 * themes in this corpus?" because any handful of retrieved chunks is
 * a local view. GraphRAG's map-reduce works because each community
 * summary IS a GLOBAL view (of its slice of the graph); combining N
 * of them covers the corpus.
 *
 * Pipeline:
 *   MAP:
 *     For each community summary, ask the LLM: "given this summary,
 *     what partial answer does it contribute to the query?" + rate
 *     its helpfulness 0-100.
 *   FILTER:
 *     Drop partial answers with helpfulness below minHelpfulness
 *     (default 40). Keeps the reduce step focused.
 *   REDUCE:
 *     Concatenate surviving partial answers, ask the LLM to
 *     synthesise a single global response + cite which communities
 *     contributed.
 *
 * Level selection:
 *   - For queries with broad scope → use super-level summaries (fewer,
 *     more abstract)
 *   - For queries with specific scope → use leaf summaries (more,
 *     more concrete)
 * Defaults to leaf; caller picks via `level: 'leaf' | 'super'`.
 */

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_MIN_HELPFULNESS = 40;
const DEFAULT_MAP_MAX = 20;

const MAP_SYSTEM = `You are helping answer a GLOBAL sensemaking query using a COMMUNITY SUMMARY from a knowledge graph.

Given the QUERY and one COMMUNITY SUMMARY, produce a PARTIAL ANSWER: the aspect of the overall answer this community can contribute. Also rate how HELPFUL this community is to the query, 0-100:
  0   = completely irrelevant to the query
  50  = tangentially related
  100 = core to the answer

Reply with STRICT JSON:
{"partial_answer": "<2-4 sentences, may be empty if irrelevant>", "helpfulness": <0-100>, "reasoning": "<one phrase>"}

Rules:
- If the community is irrelevant, say so honestly: partial_answer="", helpfulness<20.
- Do not invent facts not in the summary.
- Keep partial_answer focused; 2-4 sentences.`;

const REDUCE_SYSTEM = `Synthesise a single GLOBAL ANSWER from PARTIAL ANSWERS contributed by different sub-topics.

Each partial answer addresses one slice of the query; your job is to combine them into a cohesive response that captures the breadth and tensions across the slices.

Reply with STRICT JSON:
{
  "answer": "<the full synthesised response>",
  "themes": ["<top themes surfaced>"],
  "contributing_communities": ["<community ids you drew from>"]
}

Rules:
- Synthesise — do NOT just concatenate partial answers.
- If partials disagree, note the disagreement; don't force consensus.
- Cite community ids in contributing_communities for traceability.
- The final "answer" should be substantive (5-15 sentences for most queries).`;

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return null;
  return Math.max(lo, Math.min(hi, n));
}

async function mapStep({ openai, query, summary, model = DEFAULT_MODEL }) {
  if (!openai || !summary) return neutralMap(summary?.community_id);
  try {
    const body = [
      `QUERY: ${String(query).slice(0, 2000)}`,
      '',
      `COMMUNITY ${summary.community_id}:`,
      summary.topic ? `Topic: ${summary.topic}` : '',
      `Summary: ${summary.summary}`,
      summary.themes?.length ? `Themes: ${summary.themes.join(', ')}` : '',
    ].filter(Boolean).join('\n');

    const resp = await openai.chat.completions.create({
      model, temperature: 0.2, max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: MAP_SYSTEM },
        { role: 'user', content: body },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    return {
      community_id: summary.community_id,
      topic: summary.topic,
      partial_answer: String(parsed?.partial_answer || '').slice(0, 2000),
      helpfulness: clamp(parsed?.helpfulness, 0, 100) ?? 0,
      reasoning: String(parsed?.reasoning || '').slice(0, 200),
    };
  } catch (err) {
    console.warn('[graphrag/map-reduce-qa] map failed:', err.message);
    return neutralMap(summary?.community_id, err.message);
  }
}

function neutralMap(id, reason = 'no LLM') {
  return {
    community_id: id,
    topic: '',
    partial_answer: '',
    helpfulness: 0,
    reasoning: reason,
  };
}

async function reduceStep({ openai, query, partials, model = DEFAULT_MODEL }) {
  if (!openai || partials.length === 0) {
    return {
      answer: partials.length === 0 ? '(no helpful communities found)' : '',
      themes: [],
      contributing_communities: [],
    };
  }
  const body = [
    `QUERY: ${String(query).slice(0, 2000)}`,
    '',
    `PARTIAL ANSWERS (from community summaries, each with a helpfulness 0-100):`,
    ...partials.map(p =>
      `[${p.community_id}${p.topic ? ' — ' + p.topic : ''}] (helpfulness=${p.helpfulness})\n${p.partial_answer}`
    ),
  ].join('\n\n').slice(0, 14000);

  try {
    const resp = await openai.chat.completions.create({
      model, temperature: 0.2, max_tokens: 900,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: REDUCE_SYSTEM },
        { role: 'user', content: body },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    return {
      answer: String(parsed?.answer || '').slice(0, 5000),
      themes: Array.isArray(parsed?.themes) ? parsed.themes.map(String).slice(0, 6) : [],
      contributing_communities: Array.isArray(parsed?.contributing_communities)
        ? parsed.contributing_communities.map(String).slice(0, 20)
        : partials.map(p => p.community_id),
    };
  } catch (err) {
    console.warn('[graphrag/map-reduce-qa] reduce failed:', err.message);
    // Fall back to concatenation so the user at least sees the partials.
    return {
      answer: partials.map(p => `• [${p.community_id}] ${p.partial_answer}`).join('\n'),
      themes: [],
      contributing_communities: partials.map(p => p.community_id),
      _error: err.message,
    };
  }
}

/**
 * Answer a global sensemaking query via map-reduce over community
 * summaries.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.query
 * @param {Array<summary>} args.summaries   — from community-summaries
 * @param {number} [args.minHelpfulness=40]
 * @param {number} [args.mapMax=20]         — cap on parallel map calls
 * @param {string} [args.model]
 *
 * @returns {Promise<{
 *   query: string,
 *   answer: string,
 *   themes: string[],
 *   contributing_communities: string[],
 *   partials: [{community_id, helpfulness, partial_answer, ...}],
 *   stats: { n_communities, n_helpful, avg_helpfulness, reduce_succeeded },
 * }>}
 */
async function answer({ openai, query, summaries, minHelpfulness = DEFAULT_MIN_HELPFULNESS, mapMax = DEFAULT_MAP_MAX, model = DEFAULT_MODEL }) {
  if (!openai) throw new Error('graphrag/map-reduce-qa: openai required');
  if (!Array.isArray(summaries) || summaries.length === 0) {
    return {
      query, answer: '(no community summaries available)',
      themes: [], contributing_communities: [], partials: [],
      stats: { n_communities: 0, n_helpful: 0, avg_helpfulness: 0, reduce_succeeded: false },
    };
  }

  // MAP: parallel calls to the LLM, one per summary (capped).
  const pool = summaries.slice(0, mapMax);
  const partials = await Promise.all(pool.map(s => mapStep({ openai, query, summary: s, model })));

  // FILTER: keep helpfulness >= threshold; sort descending so the reduce
  // prompt sees the most useful first (LLMs tend to weight earlier items).
  const helpful = partials
    .filter(p => p.helpfulness >= minHelpfulness)
    .sort((a, b) => b.helpfulness - a.helpfulness);

  // REDUCE
  const reduced = await reduceStep({ openai, query, partials: helpful, model });

  const avgHelp = partials.length === 0 ? 0
    : partials.reduce((a, b) => a + b.helpfulness, 0) / partials.length;
  return {
    query,
    answer: reduced.answer,
    themes: reduced.themes,
    contributing_communities: reduced.contributing_communities,
    partials,
    stats: {
      n_communities: pool.length,
      n_helpful: helpful.length,
      avg_helpfulness: avgHelp,
      reduce_succeeded: !reduced._error,
    },
  };
}

module.exports = {
  answer,
  mapStep,
  reduceStep,
  MAP_SYSTEM,
  REDUCE_SYSTEM,
  DEFAULT_MIN_HELPFULNESS,
  DEFAULT_MAP_MAX,
};

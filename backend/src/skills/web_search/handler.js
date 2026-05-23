/**
 * web_search — OpenAI search-preview model wrapped as an agent skill.
 *
 * Why search-preview and not a direct web API? The search-preview
 * models already do retrieval + reranking + snippet extraction, and
 * return structured JSON. Using them here means we don't maintain a
 * separate crawler/ranker stack just to have a `web_search` tool.
 *
 * Tradeoffs:
 *   - Cost: each call is one LLM call. Bounded by maxSteps at the
 *     agent loop.
 *   - Freshness: whatever the preview model's index cutoff is.
 *   - Opacity: we can't inspect the retrieval process. If we ever need
 *     citations with per-fact provenance, a dedicated search backend
 *     (Serper, Brave) should be added as a sibling skill.
 *
 * ctx requirements:
 *   ctx.openai — an OpenAI client (commonly created per-request in the
 *                route handler and passed through skill invocation).
 */

const DEFAULT_K = 5;
const DEFAULT_MODEL = 'gpt-4o-mini-search-preview-2025-03-11';
const DEFAULT_MAX_TOKENS = 1800;

async function execute({ query, k = DEFAULT_K }, ctx) {
  if (!ctx?.openai) {
    throw new Error('web_search: ctx.openai is required');
  }
  const take = Math.max(1, Math.min(Number(k) || DEFAULT_K, 8));

  const system =
    `You are a web search backend. Return the ${take} most credible, relevant ` +
    `sources for the user's query as STRICT JSON: ` +
    `{"sources":[{"title":"","url":"","snippet":"","source":"","date":""}]}. ` +
    `Only real, accessible URLs — never fabricate.`;

  const resp = await ctx.openai.chat.completions.create({
    model: DEFAULT_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: query },
    ],
    max_tokens: DEFAULT_MAX_TOKENS,
  });

  const raw = (resp.choices?.[0]?.message?.content || '')
    .replace(/^```json\s*/i, '')
    .replace(/```$/g, '')
    .trim();

  try {
    const parsed = JSON.parse(raw);
    const sources = Array.isArray(parsed.sources) ? parsed.sources.slice(0, take) : [];
    return { sources };
  } catch {
    // Non-JSON is rare for this model but has happened on rate-limited
    // retries. Return an empty result with a warning so the agent can
    // decide to re-ask or fall back to another source.
    return { sources: [], warning: 'web_search: non-JSON response from model' };
  }
}

module.exports = { execute };

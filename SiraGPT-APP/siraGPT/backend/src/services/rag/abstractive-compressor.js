/**
 * abstractive-compressor — RECOMP (Xu et al., arXiv:2310.04408),
 * cited in Gao et al. §V.A.
 *
 * The complement to context-curation.js's LLM-free `compress` (which
 * drops sentences). RECOMP replaces the retrieved passages with a
 * SHORT FOCUSED SUMMARY conditioned on the query. The summary is
 * faster for the generator to read and strips off-topic sentences
 * extractive methods can't easily pick off.
 *
 * Two modes:
 *
 *   - extractive (our context-curation.compress) — keeps sentences
 *     verbatim. Safe, attributable, zero hallucination risk.
 *     Use when you need to cite exact quotes.
 *
 *   - abstractive (this file) — LLM rewrites the passages into a
 *     summary paragraph. Token-efficient but can introduce
 *     hallucinations. Use when the answer generator is downstream
 *     and citations come from the original hits (kept alongside the
 *     summary in the return shape).
 *
 * Output always includes BOTH the abstractive summary and a parallel
 * list of the passage IDs that contributed, so downstream code can
 * still cite the originals.
 */

const DEFAULT_MODEL = 'gpt-4o-mini';

const COMPRESSOR_SYSTEM = `You are a retrieval-augmented context compressor. Given a user QUERY and a list of retrieved PASSAGES, produce a short summary that contains ONLY the information from the passages that helps answer the query.

Output format — STRICT JSON:
{
  "summary": "<150-350 word summary>",
  "used_passages": [<1-indexed list of passage numbers actually used>],
  "dropped_passages": [<passage numbers judged irrelevant>]
}

Rules:
- NEVER introduce facts that are not in the passages. If the passages don't answer the query, return a one-sentence "The provided passages do not answer the question." summary.
- Prefer concrete numbers, named entities, and dates from the passages over paraphrase.
- Do NOT cite sources inside the summary — the caller attaches citations separately.
- If passages contradict each other, surface the contradiction ("one passage says X; another says Y") rather than picking.`;

function parseJSON(text) {
  if (typeof text !== 'string') return {};
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { return {}; }
}

/**
 * Compress a list of retrieved passages into a query-focused summary.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.query
 * @param {Array<{source:string, text:string, score?:number}>} args.passages
 * @param {number} [args.maxWords=300]
 * @param {string} [args.model]
 * @returns {Promise<{
 *   summary: string,
 *   usedPassages: Array<{source:string, index:number}>,
 *   droppedPassages: Array<{source:string, index:number}>,
 *   originalTokens: number,
 *   summaryTokens: number,
 *   ratio: number,
 * }>}
 */
async function compress({
  openai,
  query,
  passages,
  maxWords = 300,
  model = DEFAULT_MODEL,
}) {
  if (!openai) {
    return {
      summary: '',
      usedPassages: [],
      droppedPassages: [],
      originalTokens: 0,
      summaryTokens: 0,
      ratio: 1,
      reason: 'no LLM client',
    };
  }
  if (!Array.isArray(passages) || passages.length === 0) {
    return {
      summary: '',
      usedPassages: [],
      droppedPassages: [],
      originalTokens: 0,
      summaryTokens: 0,
      ratio: 1,
    };
  }

  const numbered = passages.map((p, i) =>
    `[${i + 1}] ${String(p.text || '').slice(0, 2000)}`
  ).join('\n\n');

  const user = [
    `QUERY:\n${String(query).slice(0, 2000)}`,
    `PASSAGES:\n${numbered}`,
    `TARGET SUMMARY LENGTH: about ${maxWords} words.`,
  ].join('\n\n');

  let parsed = {};
  try {
    const resp = await openai.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: Math.max(400, maxWords * 2),
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: COMPRESSOR_SYSTEM },
        { role: 'user',   content: user },
      ],
    });
    parsed = parseJSON(resp.choices?.[0]?.message?.content || '{}');
  } catch (err) {
    return {
      summary: '',
      usedPassages: [],
      droppedPassages: [],
      originalTokens: 0,
      summaryTokens: 0,
      ratio: 1,
      reason: `compressor error: ${err.message}`,
    };
  }

  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  const used = Array.isArray(parsed.used_passages) ? parsed.used_passages : [];
  const dropped = Array.isArray(parsed.dropped_passages) ? parsed.dropped_passages : [];

  const toRefs = (arr) => arr
    .map(n => typeof n === 'number' ? n : parseInt(n, 10))
    .filter(n => Number.isFinite(n) && n >= 1 && n <= passages.length)
    .map(n => ({ source: passages[n - 1].source, index: n }));

  // Coarse-grained token estimate so downstream reporting doesn't
  // need a tokenizer. Good enough to report a compression ratio.
  const tokenEst = s => Math.ceil(String(s || '').length / 4);
  const originalTokens = passages.reduce((sum, p) => sum + tokenEst(p.text), 0);
  const summaryTokens = tokenEst(summary);

  return {
    summary,
    usedPassages: toRefs(used),
    droppedPassages: toRefs(dropped),
    originalTokens,
    summaryTokens,
    ratio: originalTokens === 0 ? 1 : summaryTokens / originalTokens,
  };
}

module.exports = {
  compress,
  COMPRESSOR_SYSTEM,
};

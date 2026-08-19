/**
 * generate-then-read — GENREAD (Yu et al., arXiv:2209.10063), cited
 * in Gao et al. §IV.A as "LLM-generated content" as a retrieval source.
 *
 * When a corpus is thin on the user's topic, retrieval returns nothing
 * useful. GENREAD instead asks the LLM to SIMULATE retrieval: generate
 * N "background document" passages on the topic, then read those as if
 * they came from a real index.
 *
 * In practice it composes cleanly with real retrieval: use GENREAD
 * passages as a fallback/augmentation pool when real retrieval is
 * sparse, or always blend a few synthetic documents with real ones
 * via reciprocal-rank fusion.
 *
 * Paper gains: +3-7 F1 on open-domain QA when the real corpus is
 * below coverage threshold; roughly matches retrieval when the corpus
 * is strong (because synthetic passages don't beat real ones but don't
 * hurt either).
 *
 * Caveat: synthetic passages carry the LLM's training-era knowledge,
 * no citations. Callers that need provenance must treat GENREAD
 * passages as ONE source (labelled "generated") and keep real
 * retrievals distinct.
 */

const DEFAULT_MODEL = 'gpt-4o-mini';

const GENREAD_SYSTEM = `You are simulating a retrieval corpus. Given a user QUESTION, produce a small set of short "background document" passages that, together, would provide enough information to answer the question.

Output format — STRICT JSON:
{
  "passages": [
    { "title": "<short title>", "text": "<80-200 word factual passage>" },
    { "title": "...", "text": "..." }
  ]
}

Rules:
- Each passage is a FACTUAL, declarative paragraph, NOT an answer. Write in the voice of a reference document.
- Include concrete names, numbers, dates, units, and specific terms that would plausibly appear in source material.
- Cover complementary angles (definition, history, numbers, comparison) across passages. Do NOT repeat the same fact in multiple passages.
- NEVER answer the question directly. NEVER use first person.
- If you do not have reliable knowledge on the topic, produce an empty passages array. Do NOT fabricate specific claims.`;

function parseJSON(text) {
  if (typeof text !== 'string') return {};
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { return {}; }
}

/**
 * Ask the LLM for N background passages on the query topic.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.query
 * @param {number} [args.numPassages=3]
 * @param {string} [args.model]
 * @param {number} [args.temperature=0.7] — higher than usual so we
 *   get diverse passages, not three variants of the same paragraph
 *
 * @returns {Promise<{
 *   passages: Array<{source:string, text:string, title:string, generated:true}>,
 *   trace: { strategy:'generate-then-read', requested:number, returned:number },
 * }>}
 */
async function generate({
  openai, query,
  numPassages = 3,
  model = DEFAULT_MODEL,
  temperature = 0.7,
}) {
  if (!openai) return { passages: [], trace: { strategy: 'generate-then-read', requested: 0, returned: 0, error: 'no LLM client' } };
  if (typeof query !== 'string' || query.trim().length === 0) {
    return { passages: [], trace: { strategy: 'generate-then-read', requested: 0, returned: 0, error: 'empty query' } };
  }
  try {
    const resp = await openai.chat.completions.create({
      model, temperature,
      max_tokens: 300 + 250 * numPassages,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: GENREAD_SYSTEM },
        { role: 'user',   content: `QUESTION:\n${String(query).slice(0, 2000)}\n\nPRODUCE up to ${numPassages} complementary background passages.` },
      ],
    });
    const parsed = parseJSON(resp.choices?.[0]?.message?.content || '{}');
    const raw = Array.isArray(parsed.passages) ? parsed.passages : [];
    const passages = raw
      .map((p, i) => {
        const text = typeof p?.text === 'string' ? p.text.trim() : '';
        const title = typeof p?.title === 'string' ? p.title.trim() : `generated-${i + 1}`;
        return text
          ? { source: `generated:${title}`, text, title, generated: true }
          : null;
      })
      .filter(Boolean)
      .slice(0, numPassages);
    return {
      passages,
      trace: {
        strategy: 'generate-then-read',
        requested: numPassages,
        returned: passages.length,
      },
    };
  } catch (err) {
    return { passages: [], trace: { strategy: 'generate-then-read', requested: numPassages, returned: 0, error: err.message } };
  }
}

/**
 * Blend GENREAD passages with real retrieval. Two modes:
 *
 *   - "fallback": only generate when real retrieval returns < minHits.
 *     Token-cheap, safe when the corpus is usually good.
 *   - "augment":  always generate, interleave synthetic + real via
 *     reciprocal-rank fusion. More expensive; more recall on thin
 *     topics.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.query
 * @param {Array} args.retrievalResults   — the real retrieval output
 * @param {'fallback'|'augment'} [args.mode='fallback']
 * @param {number} [args.minHits=2]
 * @param {number} [args.numPassages=3]
 * @param {number} [args.rrfK=60]         — used only in 'augment'
 *
 * @returns {Promise<{ passages: Array, mode: string, generated: number, real: number }>}
 */
async function blend({
  openai, query,
  retrievalResults = [],
  mode = 'fallback',
  minHits = 2,
  numPassages = 3,
  rrfK = 60,
}) {
  const real = Array.isArray(retrievalResults) ? retrievalResults : [];
  if (mode === 'fallback' && real.length >= minHits) {
    return { passages: real, mode, generated: 0, real: real.length };
  }
  const gen = await generate({ openai, query, numPassages });
  if (mode === 'fallback') {
    return { passages: [...real, ...gen.passages], mode, generated: gen.passages.length, real: real.length };
  }
  // augment mode — RRF fusion between real and synthetic pools.
  const score = (rank) => 1 / (rrfK + rank);
  const acc = new Map();
  const push = (p, rank) => {
    const key = `${p.source || ''}|${(p.text || '').slice(0, 80)}`;
    const prev = acc.get(key);
    const s = (prev?.score || 0) + score(rank);
    acc.set(key, { ...p, score: s });
  };
  real.forEach((p, i) => push(p, i + 1));
  gen.passages.forEach((p, i) => push(p, i + 1));
  const fused = [...acc.values()].sort((a, b) => b.score - a.score);
  return { passages: fused, mode, generated: gen.passages.length, real: real.length };
}

module.exports = {
  generate,
  blend,
  GENREAD_SYSTEM,
};

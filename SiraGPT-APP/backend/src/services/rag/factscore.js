/**
 * factscore — FactScore-lite (Min et al. 2023, "FActScore: Fine-grained
 * Atomic Evaluation of Factual Precision in Long Form Text Generation",
 * arXiv:2305.14251), one of the metrics Asai et al. report on
 * biography generation.
 *
 * The full paper pipeline has three stages:
 *   1. Extract atomic facts from the generation (one verifiable
 *      claim per fact).
 *   2. For each fact, score it against a trusted knowledge source
 *      (Wikipedia in the paper).
 *   3. Aggregate to a single precision: (#supported facts) / (#facts).
 *
 * We implement a "lite" version because siraGPT is a chat app, not an
 * NLP research rig:
 *   - Atomic fact extraction via LLM call.
 *   - Scoring via an LLM judge against any caller-supplied passage
 *     set (caller controls the knowledge source — the user's own RAG
 *     collection, pasted reference docs, or anything else).
 *   - Both steps return structured per-fact trace so callers can audit
 *     which facts were flagged.
 *
 * This is NOT intended to substitute the paper's Wikipedia-grounded
 * FactScore. It IS a drop-in metric for "run our own generations
 * through atomic-fact scrutiny and flag hallucinations".
 */

const ATOMIC_FACT_SYSTEM = `You decompose a passage of generated text into a list of atomic, self-contained factual claims.

Output format — STRICT JSON:
{ "facts": ["<fact 1>", "<fact 2>", "..."] }

Rules for each fact:
- One claim per fact. Split sentences with multiple claims into separate facts.
- Self-contained: resolvable without reading the surrounding text. Replace pronouns with referents.
- VERIFIABLE: a third party could plausibly check it against a reliable source. Opinions and subjective statements are NOT facts — omit them.
- Keep numbers, dates, and entity names verbatim as they appear in the input.
- Do NOT add information the input doesn't contain.
- If the input has no verifiable facts (pure opinion, meta-commentary), return { "facts": [] }.`;

const FACT_JUDGE_SYSTEM = `You verify whether a single factual CLAIM is supported by a set of reference PASSAGES.

Output format — STRICT JSON:
{
  "label": "supported" | "contradicted" | "not_in_sources",
  "citedPassage": <1-indexed passage number or 0>,
  "reason": "<one sentence>"
}

Labels:
- supported       — at least one passage contains or clearly implies the claim.
- contradicted    — a passage directly contradicts the claim.
- not_in_sources  — neither supported nor contradicted; the passages are silent on the claim.

Rules:
- Paraphrases count as supported, provided the claim is a faithful paraphrase of what the passage states.
- If multiple passages are relevant, cite the most direct one.
- Be strict: "supported" requires the specific claim, not just the topic.`;

function parseJSON(text) {
  if (typeof text !== 'string') return {};
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { return {}; }
}

async function callJSON({ openai, model = 'gpt-4o-mini', system, user, temperature = 0, maxTokens = 600 }) {
  const resp = await openai.chat.completions.create({
    model, temperature, max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: user },
    ],
  });
  return parseJSON(resp.choices?.[0]?.message?.content || '{}');
}

/**
 * Extract atomic facts from a generation.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.text
 * @param {number} [args.maxFacts=30]
 * @param {string} [args.model]
 */
async function extractFacts({ openai, text, maxFacts = 30, model = 'gpt-4o-mini' }) {
  if (!openai) return [];
  if (typeof text !== 'string' || text.trim().length === 0) return [];
  try {
    const out = await callJSON({
      openai, model,
      system: ATOMIC_FACT_SYSTEM,
      user: `TEXT:\n${text.slice(0, 6000)}`,
      maxTokens: 1200,
    });
    const raw = Array.isArray(out.facts) ? out.facts.map(s => String(s).trim()) : [];
    // Dedupe case-insensitively.
    const seen = new Set();
    const unique = [];
    for (const f of raw) {
      if (!f || f.length < 5) continue;
      const k = f.toLowerCase();
      if (!seen.has(k)) { seen.add(k); unique.push(f); }
    }
    return unique.slice(0, maxFacts);
  } catch (err) {
    return [];
  }
}

/**
 * Judge a single fact against the reference passages.
 */
async function judgeFact({ openai, fact, passages, model = 'gpt-4o-mini' }) {
  const ctx = passages.map((p, i) => `[${i + 1}] ${String(p.text || '').slice(0, 1200)}`).join('\n\n');
  const out = await callJSON({
    openai, model,
    system: FACT_JUDGE_SYSTEM,
    user: `CLAIM:\n${fact}\n\nPASSAGES:\n${ctx}`,
    maxTokens: 200,
  });
  const label = ['supported', 'contradicted', 'not_in_sources'].includes(out.label)
    ? out.label : 'not_in_sources';
  const citedRaw = typeof out.citedPassage === 'number' ? out.citedPassage : parseInt(out.citedPassage, 10);
  const cited = Number.isFinite(citedRaw) && citedRaw >= 0 && citedRaw <= passages.length ? citedRaw : 0;
  return {
    fact,
    label,
    citedPassage: cited,
    citedSource: cited > 0 ? passages[cited - 1]?.source : null,
    reason: typeof out.reason === 'string' ? out.reason.slice(0, 200) : '',
  };
}

/**
 * FactScore-lite precision: fraction of atomic facts that are
 * SUPPORTED by the provided reference passages.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.text
 * @param {Array<{source:string, text:string}>} args.referencePassages
 * @param {string} [args.model]
 * @param {number} [args.maxFacts=30]
 * @param {boolean} [args.countNotInSourcesAs='unsupported']
 *   — 'unsupported' (strict, paper default) or 'neutral' (drop from denominator)
 *
 * @returns {Promise<{
 *   factScore: number,
 *   totalFacts: number,
 *   supported: number,
 *   contradicted: number,
 *   notInSources: number,
 *   perFact: Array,
 * }>}
 */
async function factScore({
  openai,
  text,
  referencePassages,
  model = 'gpt-4o-mini',
  maxFacts = 30,
  countNotInSourcesAs = 'unsupported',
}) {
  if (!openai) throw new Error('factscore: openai required');
  const passages = Array.isArray(referencePassages)
    ? referencePassages.filter(p => p && typeof p.text === 'string')
    : [];

  const facts = await extractFacts({ openai, text, maxFacts, model });
  if (facts.length === 0) {
    return { factScore: 1, totalFacts: 0, supported: 0, contradicted: 0, notInSources: 0, perFact: [] };
  }

  // Judge sequentially so we can keep the critique steady under rate
  // limits; for production scale you'd parallelise with backoff.
  const perFact = [];
  for (const f of facts) {
    const r = passages.length === 0
      ? { fact: f, label: 'not_in_sources', citedPassage: 0, citedSource: null, reason: 'no reference passages supplied' }
      : await judgeFact({ openai, fact: f, passages, model });
    perFact.push(r);
  }

  const supported = perFact.filter(r => r.label === 'supported').length;
  const contradicted = perFact.filter(r => r.label === 'contradicted').length;
  const notInSources = perFact.filter(r => r.label === 'not_in_sources').length;
  let denom;
  if (countNotInSourcesAs === 'neutral') {
    denom = supported + contradicted;
  } else {
    denom = facts.length;   // strict: unknown is unsupported
  }
  const score = denom === 0 ? 1 : supported / denom;

  return {
    factScore: score,
    totalFacts: facts.length,
    supported,
    contradicted,
    notInSources,
    perFact,
  };
}

module.exports = {
  factScore,
  extractFacts,
  judgeFact,
  ATOMIC_FACT_SYSTEM,
  FACT_JUDGE_SYSTEM,
};

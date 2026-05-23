/**
 * prompt-taxonomy — classify requests into the paper's 10 task types.
 *
 * Ouyang et al. 2022 (§3.2 Table 1) categorise every prompt their
 * labelers saw into one of 10 task types, and report distributions
 * over time. The taxonomy matters for alignment work because
 * different task types have different failure modes — brainstorming
 * benefits from creativity/diversity, classification demands
 * deterministic correctness. An alignment change that helps brainstorm
 * may hurt classification.
 *
 * Categories (from paper Table 1):
 *   generation       — freeform output from a prompt ("write a poem")
 *   open_qa          — questions answerable from world knowledge
 *   closed_qa        — questions answerable ONLY from provided context
 *   brainstorming    — ideation / divergent thinking
 *   chat             — conversational, social, or role-play
 *   rewrite          — transform provided text (paraphrase, translate, style)
 *   summarization    — condense provided text
 *   classification   — assign a label from a fixed set
 *   extraction       — pull specific items from provided text
 *   other            — doesn't fit above (fallback)
 *
 * This module:
 *   1. Classifies a single request via LLM
 *   2. Records per-user distributions over time
 *   3. Exposes the histogram for ops dashboards
 *
 * Per-user tracking is in-memory (same pattern as budget, feedback
 * ledger). For multi-instance deploys this belongs in Redis/Postgres.
 */

const DEFAULT_MODEL = 'gpt-4o-mini';

const TAXONOMY = [
  'generation',
  'open_qa',
  'closed_qa',
  'brainstorming',
  'chat',
  'rewrite',
  'summarization',
  'classification',
  'extraction',
  'other',
];

const TAXONOMY_SET = new Set(TAXONOMY);

const DESCRIPTIONS = {
  generation:     'Freeform creative or technical writing from a prompt (poems, code, copy).',
  open_qa:        'Questions answerable from world knowledge ("capital of France?").',
  closed_qa:      'Questions answerable ONLY from provided context ("per this doc, what does X mean?").',
  brainstorming:  'Ideation and divergent thinking ("list 10 ways to market a widget").',
  chat:           'Conversational exchange, role-play, social dialogue.',
  rewrite:        'Transform the provided text: paraphrase, translate, change style, simplify.',
  summarization:  'Condense the provided passage into a shorter form.',
  classification: 'Assign a label from a fixed set ("is this positive/negative/neutral?").',
  extraction:     'Pull specific items from provided text ("list all dates mentioned").',
  other:          'Doesn\'t fit any of the above.',
};

const CLASSIFIER_SYSTEM = `You classify a user request into ONE of these ten task types (from Ouyang et al. 2022, Table 1):

${TAXONOMY.map(t => `  ${t}: ${DESCRIPTIONS[t]}`).join('\n')}

Reply with STRICT JSON:
{"category": "<one of the ten>", "confidence": <0-1>, "reasoning": "<one short phrase>"}

Rules:
- If the request is a question AND provides context to answer from → closed_qa
- If the request is a question WITHOUT context → open_qa
- If the request asks to transform text provided inline → rewrite or summarization (depending on intent)
- "Write a function that does X" is generation, not classification, even though it produces code.
- Use "other" as the LAST resort, not a default.`;

// Per-user histograms: Map<userId, Map<category, count>>
const histograms = new Map();

function recordClassification(userId, category) {
  if (!userId || !TAXONOMY_SET.has(category)) return;
  let hist = histograms.get(userId);
  if (!hist) { hist = new Map(); histograms.set(userId, hist); }
  hist.set(category, (hist.get(category) || 0) + 1);
}

/**
 * Classify one request.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.request
 * @param {string} [args.userId]   — when provided, bumps the user's histogram
 * @param {string} [args.model]
 *
 * @returns {Promise<{ category, confidence, reasoning }>}
 */
async function classify({ openai, request, userId, model = DEFAULT_MODEL }) {
  if (!openai || !request || typeof request !== 'string') {
    return { category: 'other', confidence: 0, reasoning: 'no input or no LLM' };
  }
  try {
    const resp = await openai.chat.completions.create({
      model, temperature: 0.0, max_tokens: 120,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: CLASSIFIER_SYSTEM },
        { role: 'user',   content: request.slice(0, 4000) },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    const category = TAXONOMY_SET.has(parsed?.category) ? parsed.category : 'other';
    const out = {
      category,
      confidence: typeof parsed?.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
      reasoning: String(parsed?.reasoning || '').slice(0, 200),
    };
    if (userId) recordClassification(userId, out.category);
    return out;
  } catch (err) {
    console.warn('[prompt-taxonomy] classify failed:', err.message);
    return { category: 'other', confidence: 0, reasoning: `error: ${err.message}` };
  }
}

/**
 * Retrieve the histogram for a user — { category: count, ... }.
 * Unknown user → all-zero histogram (every category = 0). Safer for
 * callers than returning {} because they don't have to handle the
 * "no data yet" case separately.
 */
function getHistogram(userId) {
  const out = {};
  for (const t of TAXONOMY) out[t] = 0;
  const hist = histograms.get(userId);
  if (!hist) return { counts: out, total: 0, distribution: normalised(out, 0) };
  let total = 0;
  for (const [cat, count] of hist) {
    out[cat] = count;
    total += count;
  }
  return { counts: out, total, distribution: normalised(out, total) };
}

function normalised(counts, total) {
  const out = {};
  for (const t of TAXONOMY) out[t] = total === 0 ? 0 : counts[t] / total;
  return out;
}

/**
 * Compare two users' histograms — or the same user's distribution
 * across two time windows — using L1 distance. Useful for "did the
 * user's task mix change significantly after the new UI rolled out?"
 */
function distance(histA, histB) {
  const a = histA?.distribution || normalised({}, 0);
  const b = histB?.distribution || normalised({}, 0);
  let sum = 0;
  for (const t of TAXONOMY) sum += Math.abs((a[t] || 0) - (b[t] || 0));
  return sum / 2; // L1/2 ∈ [0, 1], 0 = identical, 1 = disjoint
}

function clearUser(userId) { histograms.delete(userId); }
function _reset() { histograms.clear(); }

module.exports = {
  classify,
  recordClassification,
  getHistogram,
  distance,
  clearUser,
  _reset,
  TAXONOMY,
  DESCRIPTIONS,
  CLASSIFIER_SYSTEM,
};

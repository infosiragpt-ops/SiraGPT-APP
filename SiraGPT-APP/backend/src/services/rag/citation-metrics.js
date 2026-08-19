/**
 * citation-metrics — the evaluation metrics Asai et al. 2024 Self-RAG
 * reports on long-form generation tasks (§4.1).
 *
 *   - citationPrecision  — Gao et al. 2023 "Enabling Citation in LLMs".
 *                          Of the claims the model made, what fraction
 *                          are correctly supported by the passages
 *                          they cite?
 *   - citationRecall     — Of the claims the model made that NEED a
 *                          citation, what fraction have one?
 *   - strEm              — Correctness: does any gold answer string
 *                          appear in the model's output? (for short-
 *                          form QA tasks.)
 *   - fluencyProxy       — Fast MAUVE-like proxy (we don't ship the
 *                          full MAUVE implementation — it needs a
 *                          large reference LM). Uses bigram overlap
 *                          against references + length penalty as a
 *                          stand-in for distribution distance.
 *
 * Each metric is a pure function — takes structured input, returns a
 * score. Compose via the eval-harness (any of our benchmark runners)
 * to produce per-task aggregates.
 */

const { splitAnswerIntoSegments } = require('./self-rag-critic');

// ─── citation precision / recall (Gao et al. 2023) ──────────────────────

const CITE_VERIFIER_SYSTEM = `You verify whether a cited passage actually supports a claim in an answer segment.

Output format — STRICT JSON:
{ "supports": true|false, "reason": "<one sentence>" }

Label supports=true only if the passage STATES the claim (exactly or as a straightforward paraphrase). If the passage is about the same topic but doesn't contain the claim, label false.`;

function parseJSON(text) {
  if (typeof text !== 'string') return {};
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { return {}; }
}

async function verifyCite({ openai, model, segment, passage }) {
  const resp = await openai.chat.completions.create({
    model, temperature: 0, max_tokens: 150,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: CITE_VERIFIER_SYSTEM },
      { role: 'user',   content: `CLAIM:\n${segment.slice(0, 800)}\n\nPASSAGE:\n${passage.slice(0, 1500)}` },
    ],
  });
  const parsed = parseJSON(resp.choices?.[0]?.message?.content || '{}');
  return {
    supports: parsed?.supports === true,
    reason: typeof parsed?.reason === 'string' ? parsed.reason.slice(0, 200) : '',
  };
}

const NEEDS_CITATION_SYSTEM = `You decide whether an answer SEGMENT contains a factual claim that should be cited.

Output format — STRICT JSON:
{ "needsCitation": true|false, "reason": "<one sentence>" }

needsCitation=true: contains a specific fact (number, date, name, quantitative claim, proper noun) that a reader would want to verify.
needsCitation=false: purely conversational / opinion / definitional / meta-commentary.`;

async function needsCitation({ openai, model, segment }) {
  const resp = await openai.chat.completions.create({
    model, temperature: 0, max_tokens: 120,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: NEEDS_CITATION_SYSTEM },
      { role: 'user',   content: `SEGMENT:\n${segment.slice(0, 800)}` },
    ],
  });
  const parsed = parseJSON(resp.choices?.[0]?.message?.content || '{}');
  return parsed?.needsCitation === true;
}

/**
 * Citation precision: of the citations the model made, what fraction
 * actually support the claim?
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {Array<{segment:string, citedPassageText:string}>} args.citedClaims
 * @param {string} [args.model='gpt-4o-mini']
 * @returns {Promise<{ precision:number, total:number, supported:number, perCitation:Array }>}
 */
async function citationPrecision({ openai, citedClaims, model = 'gpt-4o-mini' }) {
  if (!openai) throw new Error('citation-metrics: openai required');
  if (!Array.isArray(citedClaims) || citedClaims.length === 0) {
    return { precision: 1, total: 0, supported: 0, perCitation: [] };
  }
  const perCitation = [];
  let supported = 0;
  for (const c of citedClaims) {
    const r = await verifyCite({
      openai, model,
      segment: String(c.segment || ''),
      passage: String(c.citedPassageText || ''),
    });
    if (r.supports) supported++;
    perCitation.push({ segment: c.segment, supports: r.supports, reason: r.reason });
  }
  return {
    precision: supported / citedClaims.length,
    total: citedClaims.length,
    supported,
    perCitation,
  };
}

/**
 * Citation recall: of the segments that NEED a citation, what
 * fraction actually have one?
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.answer
 * @param {Array<number>} args.citedSegmentIndices — 0-indexed indices of segments that do have citations
 * @param {string} [args.model]
 * @returns {Promise<{ recall:number, total:number, cited:number, perSegment:Array }>}
 */
async function citationRecall({ openai, answer, citedSegmentIndices, model = 'gpt-4o-mini' }) {
  if (!openai) throw new Error('citation-metrics: openai required');
  const segments = splitAnswerIntoSegments(answer);
  if (segments.length === 0) return { recall: 1, total: 0, cited: 0, perSegment: [] };
  const citedSet = new Set(Array.isArray(citedSegmentIndices) ? citedSegmentIndices : []);
  const perSegment = [];
  let needsCount = 0;
  let citedCount = 0;
  for (let i = 0; i < segments.length; i++) {
    const need = await needsCitation({ openai, model, segment: segments[i] });
    const isCited = citedSet.has(i);
    if (need) {
      needsCount++;
      if (isCited) citedCount++;
    }
    perSegment.push({ index: i, needsCitation: need, cited: isCited, segment: segments[i] });
  }
  return {
    recall: needsCount === 0 ? 1 : citedCount / needsCount,
    total: needsCount,
    cited: citedCount,
    perSegment,
  };
}

// ─── str-em (string exact match) ─────────────────────────────────────────

function normalise(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\p{P}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * str-em: any of the gold answers appears as a substring in the output
 * (case-insensitive, punctuation-agnostic). This is the metric Mallen
 * et al. 2023 use for PopQA.
 *
 * @param {string} output
 * @param {string|string[]} gold
 * @returns {{ match:boolean, matchedGold:string|null }}
 */
function strEm(output, gold) {
  const golds = Array.isArray(gold) ? gold : [gold];
  const normOut = normalise(output);
  if (!normOut) return { match: false, matchedGold: null };
  for (const g of golds) {
    const ng = normalise(g);
    if (ng && normOut.includes(ng)) return { match: true, matchedGold: g };
  }
  return { match: false, matchedGold: null };
}

// ─── fluency proxy (MAUVE-ish) ───────────────────────────────────────────

function tokenizeLower(text) {
  return (String(text || '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []);
}

function bigramSet(tokens) {
  const s = new Set();
  for (let i = 0; i + 2 <= tokens.length; i++) s.add(`${tokens[i]} ${tokens[i + 1]}`);
  return s;
}

/**
 * fluencyProxy: bigram-overlap Jaccard with ≥1 reference generation,
 * scaled down by length mismatch. This is NOT MAUVE (MAUVE needs a
 * reference LM to estimate divergence via a feature extractor). It
 * is a cheap stand-in that correlates decently on short-form tasks.
 *
 * @param {string} candidate
 * @param {string|string[]} references
 * @returns {{ score:number, bigramJaccard:number, lengthPenalty:number }}
 */
function fluencyProxy(candidate, references) {
  const refs = Array.isArray(references) ? references : [references];
  const candTokens = tokenizeLower(candidate);
  if (candTokens.length === 0 || refs.length === 0) {
    return { score: 0, bigramJaccard: 0, lengthPenalty: 0 };
  }
  const candBi = bigramSet(candTokens);
  let bestJac = 0;
  let bestLen = 0;
  for (const ref of refs) {
    const rTokens = tokenizeLower(ref);
    const rBi = bigramSet(rTokens);
    if (rBi.size === 0 || candBi.size === 0) continue;
    let inter = 0;
    for (const b of candBi) if (rBi.has(b)) inter++;
    const jac = inter / (candBi.size + rBi.size - inter);
    if (jac > bestJac) {
      bestJac = jac;
      bestLen = Math.min(candTokens.length, rTokens.length) / Math.max(candTokens.length, rTokens.length);
    }
  }
  return {
    score: bestJac * Math.max(0.3, bestLen),  // cap length penalty to avoid zeroing on valid long answers
    bigramJaccard: bestJac,
    lengthPenalty: bestLen,
  };
}

module.exports = {
  citationPrecision,
  citationRecall,
  strEm,
  fluencyProxy,
  splitAnswerIntoSegments,
  verifyCite,
  needsCitation,
  CITE_VERIFIER_SYSTEM,
  NEEDS_CITATION_SYSTEM,
};

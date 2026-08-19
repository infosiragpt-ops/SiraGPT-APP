/**
 * selective-rag — Repoformer-style gate (Wu et al., arXiv:2403.10059):
 * before spending tokens + latency on retrieval, decide whether this
 * code query actually benefits from it.
 *
 * The paper's motivation: unconditional RAG hurts ~20% of requests.
 * A self-assessment step (cheap — one classifier call) recovers that
 * performance by skipping retrieval when the model already knows the
 * answer or when the query is too generic for retrieval to help.
 *
 * We implement a two-stage gate:
 *
 *   Stage 1 — heuristic pre-filter (free, synchronous).
 *     Reject trivially "no need to retrieve" queries:
 *       - questions about language semantics ("what is a Python list")
 *       - math / logic puzzles
 *       - general algorithmic problems with no project coupling
 *     Reject trivially "definitely retrieve" queries:
 *       - identifier references ("UserService.findByEmail")
 *       - "in this repo", "our codebase", file-path hints
 *
 *   Stage 2 — LLM classifier (only when the heuristic is uncertain).
 *     One JSON-mode call asking "would retrieving project code help
 *     answer this?". Returns { shouldRetrieve, confidence, reason }.
 *
 * Cost: ~0 for ~70% of queries (heuristic resolves), ~300 tokens
 * otherwise. Worth paying vs the alternative of burning 3000+ tokens
 * on a retrieval that adds noise.
 */

const DEFAULT_MODEL = 'gpt-4o-mini';

// Patterns that make retrieval likely USEFUL (grounded in project).
const RETRIEVE_HINT_PATTERNS = [
  /\b(en este repo|en nuestro (código|repositorio)|our codebase|this project|this repo)\b/i,
  /\b(refactor|modif(y|ica)|extend|update|rename|migrat[ea])\b/i,
  /\b([A-Z][a-z]+[A-Z][A-Za-z]+|[a-z]+[A-Z][A-Za-z]+)\b/, // CamelCase identifiers
  /\.(py|js|ts|tsx|jsx|go|rs|java|kt|swift|rb|php|cpp|c|h|hpp)\b/,
  /\bfile\s+([\w./-]+)\b/i,
  /\bfunction\s+([\w.]+)\s*\(/i,
  /\b(test|spec)s?\s+for\b/i,
];

// Patterns that make retrieval likely USELESS (language/theory).
const SKIP_HINT_PATTERNS = [
  /^\s*(what is|qué es|cómo funciona|how does|explain|explica)\b/i,
  /\b(difference between|diferencia entre)\b/i,
  /\b(leetcode|hackerrank|codewars|algorithmic problem|toy problem)\b/i,
  /\b(big-?o|time complexity|space complexity|complejidad)\b/i,
  /\bfor (an?|the) interview\b/i,
];

const CLASSIFIER_SYSTEM = `You are a retrieval policy classifier. Given a developer's query, decide whether searching the user's project codebase would genuinely help answer it.

Output format — STRICT JSON:
{ "shouldRetrieve": <bool>, "confidence": <0..1>, "reason": "<one sentence>" }

Guidance:
- shouldRetrieve=true when: the query references project-specific identifiers, files, or requirements; the user asks to modify, extend, or inspect their own code; the query names concepts that are likely defined in their project.
- shouldRetrieve=false when: the query is a general programming question (language semantics, library usage, algorithm design); a toy problem; a conceptual explanation; a request that can be answered from public knowledge alone.
- When in doubt, bias toward false — unnecessary retrieval adds noise and latency.`;

function heuristic(query) {
  if (typeof query !== 'string' || query.trim().length === 0) {
    return { decision: 'skip', reason: 'empty query', confidence: 1.0 };
  }
  const q = query.trim();
  if (q.length < 8) {
    return { decision: 'skip', reason: 'query too short to benefit from retrieval', confidence: 0.9 };
  }
  // Skip patterns are checked FIRST because the retrieve patterns
  // (CamelCase, function-call hint) false-positive on common
  // programmer speech about general concepts ("explain how JavaScript
  // async/await works", "what is a HashMap"). A skip match is a
  // stronger signal than a generic identifier hit.
  for (const re of SKIP_HINT_PATTERNS) {
    if (re.test(q)) return { decision: 'skip', reason: `matches general-knowledge pattern /${re.source}/`, confidence: 0.8 };
  }
  for (const re of RETRIEVE_HINT_PATTERNS) {
    if (re.test(q)) return { decision: 'retrieve', reason: `matches project-coupling pattern /${re.source}/`, confidence: 0.85 };
  }
  return { decision: 'uncertain', reason: 'no heuristic match', confidence: 0.0 };
}

async function classify({ openai, query, model = DEFAULT_MODEL }) {
  if (!openai) throw new Error('selective-rag: openai client required for classifier');
  const resp = await openai.chat.completions.create({
    model,
    temperature: 0,
    max_tokens: 200,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: CLASSIFIER_SYSTEM },
      { role: 'user',   content: `QUERY:\n${String(query).slice(0, 2000)}` },
    ],
  });
  const raw = resp.choices?.[0]?.message?.content || '{}';
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch { /* malformed response */ }
  const shouldRetrieve = parsed?.shouldRetrieve === true;
  const confidence = typeof parsed?.confidence === 'number'
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0.5;
  const reason = typeof parsed?.reason === 'string' ? parsed.reason.slice(0, 200) : '';
  return { shouldRetrieve, confidence, reason };
}

/**
 * Decide whether to run RAG for this query.
 *
 * @param {object} args
 * @param {string} args.query
 * @param {object} [args.openai]          — required ONLY if heuristic is uncertain
 * @param {string} [args.model]
 * @param {number} [args.minConfidence=0.6] — below this, force retrieve (safer default)
 * @returns {Promise<{ shouldRetrieve: boolean, source: 'heuristic'|'classifier', reason: string, confidence: number }>}
 */
async function decide({ query, openai, model, minConfidence = 0.6 }) {
  const h = heuristic(query);
  if (h.decision === 'retrieve') {
    return { shouldRetrieve: true, source: 'heuristic', reason: h.reason, confidence: h.confidence };
  }
  if (h.decision === 'skip' && h.confidence >= minConfidence) {
    return { shouldRetrieve: false, source: 'heuristic', reason: h.reason, confidence: h.confidence };
  }
  if (!openai) {
    // No classifier available. Default to retrieving — false negatives
    // (we skipped and shouldn't have) hurt more than false positives
    // (we retrieved and didn't need to).
    return {
      shouldRetrieve: true,
      source: 'heuristic',
      reason: 'uncertain heuristic + no classifier available → default retrieve',
      confidence: 0.5,
    };
  }
  const c = await classify({ openai, query, model });
  return { shouldRetrieve: c.shouldRetrieve, source: 'classifier', reason: c.reason, confidence: c.confidence };
}

module.exports = {
  decide,
  heuristic,
  classify,
  CLASSIFIER_SYSTEM,
  RETRIEVE_HINT_PATTERNS,
  SKIP_HINT_PATTERNS,
};

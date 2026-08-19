/**
 * triple-extractor — pull (subject, predicate, object) triples from text.
 *
 * This is the first primitive the GEAR paper (Shen et al., ACL 2025,
 * "Graph-enhanced Agent for Retrieval-augmented generation") leans on:
 * a passage index C is paired with a triple index T where each triple
 * links to exactly one source passage. That linkage is what lets us do
 * graph expansion later — without it, a BM25/cosine retriever only ever
 * sees single hops.
 *
 * Two paths:
 *   extractTriples(openai, text, opts)        — LLM-backed, good quality
 *   extractTriplesHeuristic(text, opts)       — regex fallback, offline
 *
 * The heuristic path will never match LLM quality on prose, but it's
 * deterministic and runs without an API key so tests and dev flows
 * don't grind to a halt. For real traffic (ingestion, proximal-triple
 * extraction) we want the LLM path.
 *
 * Triple shape (stable across both paths):
 *   { subject, predicate, object, source?, confidence? }
 *
 * We intentionally do not enforce entity canonicalisation here. The
 * graph store (triple-graph.js) lowercases head/tail entities when
 * building the neighbour index so "Stephen Curry" and "stephen curry"
 * collide — but leaves the canonical form on the triple for display.
 */

const EXTRACTION_SYSTEM_PROMPT = `Extract factual knowledge triples from the passage below.

Each triple is a (subject, predicate, object) tuple that captures one atomic fact. Prefer proper nouns, concrete entities, and durable relationships over opinions or hedged claims.

Return STRICT JSON:
{"triples":[{"subject":"<entity>","predicate":"<relation, <=4 words>","object":"<entity or value>","confidence":0.0-1.0}]}

Rules:
- Each element (subject/predicate/object) must be <= 60 chars.
- Predicates should be short verb phrases ("born in", "founded by", "plays for").
- Use the same language as the passage.
- Return at most 20 triples. Return an empty array when the passage has no factual content.`;

// Aligned with the GEAR paper's "Reader with and without Gist Memory"
// prompt (Shen et al., ACL 2025, Appendix K.2). The paper uses a
// free-form tuple style ("subject","predicate","object"); we wrap the
// same instructions in JSON to make the output trivially parseable
// without losing the structure. The one-shot example is copied
// verbatim from the paper.
const PROXIMAL_EXTRACTION_SYSTEM_PROMPT = `Your task is to find facts that help answer an input question.

You should present these facts as knowledge triples, which are structured as ("subject", "predicate", "object").

Example:
Question: When was Neville A. Stanton's employer founded?
Facts: ("Neville A. Stanton", "employer", "University of Southampton"), ("University of Southampton", "founded in", "1862")

Return STRICT JSON:
{"triples":[{"subject":"<entity>","predicate":"<relation, <=4 words>","object":"<entity or value>","confidence":0.0-1.0}]}

Rules:
- Extract ONLY triples that help answer the question. Ignore unrelated facts.
- Each element (subject/predicate/object) must be <= 60 chars.
- Use the same language as the question.
- If the information given is insufficient, output only the relevant facts you can find (possibly an empty array).
- Return at most 12 triples.`;

const MAX_TRIPLES = 20;
const MAX_ELEMENT_CHARS = 60;

function normaliseElement(s) {
  if (typeof s !== 'string') return '';
  return s.trim().replace(/\s+/g, ' ').slice(0, MAX_ELEMENT_CHARS);
}

function isValidTriple(t) {
  if (!t || typeof t !== 'object') return false;
  const s = normaliseElement(t.subject);
  const p = normaliseElement(t.predicate);
  const o = normaliseElement(t.object);
  return s.length > 0 && p.length > 0 && o.length > 0;
}

function coerceTriple(raw, source) {
  return {
    subject: normaliseElement(raw.subject),
    predicate: normaliseElement(raw.predicate),
    object: normaliseElement(raw.object),
    source: source || raw.source || null,
    // Clamp to [0,1] — an LLM can emit a confidence of 5 or -2, which would then
    // skew any downstream weighting/thresholding that assumes a probability.
    confidence: typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
      ? Math.max(0, Math.min(1, raw.confidence))
      : 0.8,
  };
}

/**
 * LLM-backed extraction. Caller must provide an OpenAI client; we do not
 * reach into rag-service to grab one because callers often want a
 * specific model/key. Returns [] on any failure — extraction must never
 * block the main pipeline.
 */
async function extractTriples(openai, text, { source = null, model = 'gpt-4o-mini', maxTriples = MAX_TRIPLES } = {}) {
  if (!openai || !text || typeof text !== 'string') return [];
  const trimmed = text.slice(0, 6000);
  if (trimmed.trim().length < 10) return [];

  try {
    const resp = await openai.chat.completions.create({
      model,
      temperature: 0.1,
      max_tokens: 1200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user',   content: trimmed },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.triples)) return [];
    return parsed.triples
      .filter(isValidTriple)
      .slice(0, maxTriples)
      .map(t => coerceTriple(t, source));
  } catch (err) {
    console.warn('[triple-extractor] LLM extraction failed:', err.message);
    return [];
  }
}

/**
 * Proximal extraction: given a QUERY and a list of passages, pull only
 * the triples that would directly support answering the query. This is
 * Eq. (1) in the GEAR paper — the "read" step. When `gistMemory` is
 * provided, it's included in the prompt (Eq. 4 for step n ≥ 2).
 */
async function extractProximalTriples(openai, query, passages, { model = 'gpt-4o-mini', gistMemory = null, maxTriples = 12 } = {}) {
  if (!openai || !query || !Array.isArray(passages) || passages.length === 0) return [];

  const passageBlock = passages
    .map((p, i) => `[${i + 1}] ${(p.text || '').slice(0, 800).replace(/\s+/g, ' ')}`)
    .join('\n\n');

  const memoryBlock = Array.isArray(gistMemory) && gistMemory.length > 0
    ? `\n\nKNOWN TRIPLES (from earlier iterations):\n${gistMemory.slice(0, 30).map(t => `(${t.subject}, ${t.predicate}, ${t.object})`).join('\n')}`
    : '';

  const user = `QUERY: ${query}\n\nPASSAGES:\n${passageBlock}${memoryBlock}`;

  try {
    const resp = await openai.chat.completions.create({
      model,
      temperature: 0.1,
      max_tokens: 900,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: PROXIMAL_EXTRACTION_SYSTEM_PROMPT },
        { role: 'user',   content: user },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.triples)) return [];
    return parsed.triples
      .filter(isValidTriple)
      .slice(0, maxTriples)
      .map(t => coerceTriple(t, null));
  } catch (err) {
    console.warn('[triple-extractor] proximal extraction failed:', err.message);
    return [];
  }
}

// ─── Heuristic fallback ─────────────────────────────────────────────────────
//
// Simple pattern-based extractor for tests and air-gapped dev. Catches a
// handful of high-signal English/Spanish patterns:
//
//   "X is/was a/the Y"                      → (X, is a, Y)
//   "X is/was born in Y"                    → (X, born in, Y)
//   "X was founded by Y"                    → (X, founded by, Y)
//   "X es/fue un/el Y"                      → (X, es, Y)
//   "X nació en Y"                          → (X, nació en, Y)
//
// This is not a real NER/relation extractor. It exists so the downstream
// graph code can be exercised deterministically without an LLM call.

const HEURISTIC_PATTERNS = [
  { re: /([A-Z][A-Za-zÁÉÍÓÚÑáéíóúñ'.\-\s]{1,50}?)\s+(?:is|was)\s+(?:a|an|the)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ'.\-\s]{1,50})/g, predicate: 'is a' },
  { re: /([A-Z][A-Za-zÁÉÍÓÚÑáéíóúñ'.\-\s]{1,50}?)\s+(?:was\s+)?born\s+in\s+([A-Z][A-Za-zÁÉÍÓÚÑáéíóúñ'.\-\s0-9]{1,50})/g, predicate: 'born in' },
  { re: /([A-Z][A-Za-zÁÉÍÓÚÑáéíóúñ'.\-\s]{1,50}?)\s+(?:was\s+)?founded\s+by\s+([A-Z][A-Za-zÁÉÍÓÚÑáéíóúñ'.\-\s]{1,50})/g, predicate: 'founded by' },
  { re: /([A-Z][A-Za-zÁÉÍÓÚÑáéíóúñ'.\-\s]{1,50}?)\s+plays?\s+for\s+([A-Z][A-Za-zÁÉÍÓÚÑáéíóúñ'.\-\s]{1,50})/g, predicate: 'plays for' },
  { re: /([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ'.\-\s]{1,50}?)\s+nació en\s+([A-Za-zÁÉÍÓÚÑáéíóúñ'.\-\s0-9]{1,50})/g, predicate: 'nació en' },
];

function extractTriplesHeuristic(text, { source = null, maxTriples = MAX_TRIPLES } = {}) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  const seen = new Set();

  for (const { re, predicate } of HEURISTIC_PATTERNS) {
    // Reset regex lastIndex since we're reusing a module-level RegExp with /g.
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null && out.length < maxTriples) {
      const subject = normaliseElement(m[1]);
      const object = normaliseElement(m[2]);
      if (!subject || !object) continue;
      const key = `${subject.toLowerCase()}|${predicate}|${object.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ subject, predicate, object, source, confidence: 0.5 });
    }
  }
  return out;
}

module.exports = {
  extractTriples,
  extractProximalTriples,
  extractTriplesHeuristic,
  // exported for tests
  normaliseElement,
  isValidTriple,
  coerceTriple,
  EXTRACTION_SYSTEM_PROMPT,
  PROXIMAL_EXTRACTION_SYSTEM_PROMPT,
};

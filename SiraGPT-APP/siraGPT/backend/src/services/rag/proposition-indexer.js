/**
 * proposition-indexer — Dense X retrieval (Chen et al. 2023,
 * "Dense X Retrieval: What Retrieval Granularity Should We Use?",
 * arXiv:2312.06648), cited in Gao et al. §IV.B.
 *
 * Idea: the retrieval unit MATTERS. Chunks are too coarse — a chunk
 * answering one specific claim also carries paragraphs of context
 * the retriever has to downweight. Sentences are too rigid — a claim
 * often spans a sentence boundary or depends on the prior sentence
 * for its subject.
 *
 * The authors propose the PROPOSITION as the retrieval unit: an
 * atomic, self-contained factual claim. Concretely, for each chunk
 * you ask an LLM to extract "a list of short factual statements, each
 * understandable on its own without the surrounding text." Those
 * propositions get embedded and retrieved; at generation time the
 * system can either return the propositions directly or the parent
 * chunk they came from (proposition-to-chunk hop).
 *
 * Reported gains on EntityQuestions: +10pt recall@5 vs sentence
 * indexing, +15pt vs chunk indexing on long-tail entities.
 *
 * This module provides the extraction + a dual-view helper. The
 * actual embedding / indexing is delegated to rag-service (or any
 * retriever) — callers feed propositions through their normal ingest.
 */

const EXTRACTION_SYSTEM = `You are an expert at rewriting passages into a list of atomic, self-contained factual propositions.

Output format — STRICT JSON:
{ "propositions": ["<proposition 1>", "<proposition 2>", "..."] }

Rules for each proposition:
- One complete sentence. Contains a subject, verb, and object.
- Self-contained: resolvable without reading the original passage. Replace pronouns with their antecedents. Expand acronyms on first mention.
- One claim per proposition. Split sentences with multiple claims ("Paris is the capital of France and sits on the Seine") into separate propositions.
- Preserve ALL numeric values, dates, named entities exactly as written.
- Do NOT invent information that isn't in the passage.
- If a passage is a definition, the proposition should include the defined term.

Good examples of propositions:
- "The Eiffel Tower was completed in 1889."
- "The Eiffel Tower was inaugurated at the 1889 World's Fair in Paris."
- "Pure water boils at 100 degrees Celsius at standard atmospheric pressure (sea level)."

Bad (non-self-contained):
- "It was completed in 1889."  (what is "it"?)
- "Water boils there."          (where?)`;

function parseJSON(text) {
  if (typeof text !== 'string') return {};
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { return {}; }
}

function clean(s) {
  return String(s || '').trim().replace(/\s+/g, ' ');
}

/**
 * Extract propositions from a single passage.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.text
 * @param {string} [args.model='gpt-4o-mini']
 * @param {number} [args.maxPropositions=20]
 * @returns {Promise<string[]>}
 */
async function extractPropositions({ openai, text, model = 'gpt-4o-mini', maxPropositions = 20 }) {
  if (!openai) return [];
  const body = String(text || '').slice(0, 6000);
  if (body.trim().length === 0) return [];
  try {
    const resp = await openai.chat.completions.create({
      model, temperature: 0, max_tokens: 1500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM },
        { role: 'user',   content: `PASSAGE:\n${body}` },
      ],
    });
    const parsed = parseJSON(resp.choices?.[0]?.message?.content || '{}');
    const propositions = Array.isArray(parsed.propositions)
      ? parsed.propositions.map(clean).filter(p => p.length > 0 && p.length < 400)
      : [];
    // Dedupe case-insensitively.
    const seen = new Set();
    const unique = [];
    for (const p of propositions) {
      const k = p.toLowerCase();
      if (!seen.has(k)) { seen.add(k); unique.push(p); }
    }
    return unique.slice(0, maxPropositions);
  } catch (err) {
    console.warn('[proposition-indexer] extraction failed:', err.message);
    return [];
  }
}

/**
 * Ingest-ready records. For EACH proposition we emit a chunk whose
 * retrievalText is the proposition itself and whose parentId points
 * back to the source passage. The caller feeds these to their vector
 * store.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.source         — document identifier
 * @param {string} args.text           — the passage body
 * @param {object} [args.parentMeta]   — optional metadata to attach
 * @param {string} [args.model]
 * @returns {Promise<{
 *   parent: {id, source, text, metadata},
 *   propositions: Array<{id, source, parentId, text, retrievalText, metadata}>,
 * }>}
 */
async function indexPassage({ openai, source, text, parentMeta = {}, model }) {
  const crypto = require('crypto');
  const parentId = crypto.createHash('sha1').update(`${source}|${text.slice(0, 200)}`).digest('hex').slice(0, 16);
  const parent = {
    id: parentId,
    source,
    text,
    metadata: { ...parentMeta, strategy: 'proposition', role: 'parent' },
  };
  const propositions = await extractPropositions({ openai, text, model });
  const propRecords = propositions.map((prop, i) => ({
    id: crypto.createHash('sha1').update(`${parentId}|${i}|${prop.slice(0, 80)}`).digest('hex').slice(0, 16),
    source,
    parentId,
    text: prop,                     // what most retrievers read
    retrievalText: prop,            // what gets embedded
    metadata: {
      ...parentMeta,
      strategy: 'proposition',
      role: 'proposition',
      propositionIndex: i,
    },
  }));
  return { parent, propositions: propRecords };
}

/**
 * Given retrieved proposition hits, hop back to the parent passage(s)
 * so the generator sees coherent context. Deduplicates parents and
 * sums proposition-level scores per parent.
 *
 * @param {object} args
 * @param {Array<{id, parentId, score?}>} args.hits
 * @param {Map<string,object>|object} args.parentById
 * @returns {{passages: Array<{id, text, score, propositionCount}>}}
 */
function expandToParents({ hits, parentById }) {
  if (!Array.isArray(hits) || hits.length === 0) return { passages: [] };
  const lookup = parentById instanceof Map
    ? parentById
    : new Map(Object.entries(parentById || {}));
  const agg = new Map();
  for (const h of hits) {
    const pid = h.parentId || h.metadata?.parentId;
    if (!pid || !lookup.has(pid)) continue;
    const cur = agg.get(pid) || { id: pid, score: 0, propositionCount: 0 };
    cur.score += h.score || 0;
    cur.propositionCount++;
    agg.set(pid, cur);
  }
  const passages = [];
  for (const [pid, val] of agg.entries()) {
    const parent = lookup.get(pid);
    passages.push({
      id: pid,
      text: parent.text,
      source: parent.source,
      score: val.score,
      propositionCount: val.propositionCount,
      metadata: parent.metadata || {},
    });
  }
  passages.sort((a, b) => b.score - a.score);
  return { passages };
}

module.exports = {
  extractPropositions,
  indexPassage,
  expandToParents,
  EXTRACTION_SYSTEM,
};

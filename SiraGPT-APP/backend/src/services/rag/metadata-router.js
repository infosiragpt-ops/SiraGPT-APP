/**
 * metadata-router — two retrieval-time filters from Gao et al. 2024
 * §IV.B (metadata attachment) and §IV.C (query routing):
 *
 *   1. applyMetadataFilter — filter retrieved passages by structured
 *      metadata (date range, tag set, section, author, …). The chunk
 *      ingest side attaches whatever metadata is available; the
 *      retrieval side uses this function to drop passages that don't
 *      match the caller's constraints. Useful for "only search docs
 *      from 2024", "only legal section 3.2", etc.
 *
 *   2. route — LLM-based semantic router. Given a query and a set of
 *      COLLECTION DESCRIPTORS { name, description, examples[] }, pick
 *      the single best collection to query. Falls back to keyword
 *      matching when the LLM classifier is unavailable. Returns a
 *      ranked list so callers can fan-out to the top-N on ambiguous
 *      queries.
 *
 * Neither function hits the vector store — both are pure transforms
 * over passage lists / descriptor lists so the retriever stays
 * swappable.
 */

// ─── metadata filter ─────────────────────────────────────────────────────

function parseDate(v) {
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(+d) ? null : d;
  }
  return null;
}

function matchesDateRange(value, range) {
  const d = parseDate(value);
  if (!d) return false;
  const from = range.from ? parseDate(range.from) : null;
  const to = range.to ? parseDate(range.to) : null;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

function matchesTagSet(value, required, mode) {
  const tags = Array.isArray(value) ? value.map(String) : [String(value)];
  const req = Array.isArray(required) ? required.map(String) : [String(required)];
  const set = new Set(tags);
  if (mode === 'all') return req.every(t => set.has(t));
  // default: any
  return req.some(t => set.has(t));
}

function matchesCondition(value, cond) {
  if (cond === null || cond === undefined) return true;
  // Scalar equality shortcut
  if (typeof cond === 'string' || typeof cond === 'number' || typeof cond === 'boolean') {
    return value === cond;
  }
  if (Array.isArray(cond)) {
    // treated as "value in [array]"
    return cond.includes(value);
  }
  if (typeof cond === 'object') {
    if ('eq' in cond) return value === cond.eq;
    if ('neq' in cond) return value !== cond.neq;
    if ('in' in cond && Array.isArray(cond.in)) return cond.in.includes(value);
    if ('notIn' in cond && Array.isArray(cond.notIn)) return !cond.notIn.includes(value);
    if ('gte' in cond) return typeof value === 'number' && value >= cond.gte;
    if ('lte' in cond) return typeof value === 'number' && value <= cond.lte;
    if ('gt' in cond)  return typeof value === 'number' && value > cond.gt;
    if ('lt' in cond)  return typeof value === 'number' && value < cond.lt;
    if ('from' in cond || 'to' in cond) return matchesDateRange(value, cond);
    if ('tagsAny' in cond) return matchesTagSet(value, cond.tagsAny, 'any');
    if ('tagsAll' in cond) return matchesTagSet(value, cond.tagsAll, 'all');
    if ('regex' in cond) {
      try { return new RegExp(cond.regex, cond.flags || '').test(String(value)); }
      catch { return false; }
    }
  }
  return false;
}

/**
 * Drop passages whose metadata doesn't match the given filter spec.
 * The filter spec is a plain object where each key matches a metadata
 * key on the passage (under `passage.metadata`). Each value is either
 * a scalar, an array (in-set), or an operator object.
 *
 *   applyMetadataFilter({
 *     passages,
 *     filter: {
 *       section: 'introduction',
 *       date: { from: '2024-01-01' },
 *       tags: { tagsAny: ['legal', 'finance'] },
 *     },
 *   })
 *
 * Passages without the keyed metadata are dropped unless the filter
 * option { keepMissing: true } is set.
 */
function applyMetadataFilter({ passages, filter, keepMissing = false }) {
  if (!Array.isArray(passages)) return { kept: [], dropped: [] };
  if (!filter || typeof filter !== 'object' || Object.keys(filter).length === 0) {
    return { kept: passages, dropped: [] };
  }
  const kept = [];
  const dropped = [];
  for (const p of passages) {
    const md = p.metadata || {};
    let ok = true;
    for (const [k, cond] of Object.entries(filter)) {
      if (!(k in md)) {
        if (!keepMissing) { ok = false; break; }
        continue;
      }
      if (!matchesCondition(md[k], cond)) { ok = false; break; }
    }
    if (ok) kept.push(p); else dropped.push({ source: p.source, reason: `metadata mismatch` });
  }
  return { kept, dropped };
}

// ─── query router ────────────────────────────────────────────────────────

const ROUTER_SYSTEM = `You are a semantic router. Given a user query and a list of candidate COLLECTIONS (each with a name, description, and example queries), rank the collections by how well they match the query.

Output format — STRICT JSON:
{
  "ranking": [
    { "name": "<collection name>", "score": <0..1>, "reason": "<one sentence>" },
    ...
  ],
  "top": "<the best collection name>"
}

Rules:
- The "ranking" array must include EVERY candidate collection exactly once.
- "score" reflects how likely retrieving from that collection would yield the answer.
- If no collection fits well, rank them all low and set "top" to the least-bad one.`;

function parseJSON(text) {
  if (typeof text !== 'string') return {};
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { return {}; }
}

function tokenize(s) {
  return String(s || '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
}

/**
 * Keyword fallback router. Uses n-gram overlap between the query and
 * each collection's description + examples to produce a ranking when
 * the LLM is unavailable.
 */
function keywordRoute({ query, collections }) {
  const qTokens = new Set(tokenize(query));
  const scored = collections.map(c => {
    const haystack = tokenize(`${c.description || ''} ${(c.examples || []).join(' ')}`);
    const haystackSet = new Set(haystack);
    let hits = 0;
    for (const t of qTokens) if (haystackSet.has(t)) hits++;
    const score = qTokens.size === 0 ? 0 : hits / qTokens.size;
    return { name: c.name, score, reason: `keyword overlap ${hits}/${qTokens.size}` };
  });
  scored.sort((a, b) => b.score - a.score);
  return {
    ranking: scored,
    top: scored[0]?.name || '',
    source: 'keyword',
  };
}

/**
 * LLM-based router with keyword fallback.
 *
 * @param {object} args
 * @param {object} [args.openai]         — required for LLM routing; absent → keyword fallback
 * @param {string} args.query
 * @param {Array<{name:string, description:string, examples?:string[]}>} args.collections
 * @param {string} [args.model='gpt-4o-mini']
 * @param {number} [args.topK=1]         — number of collections to return as shouldRetrieve
 * @returns {Promise<{ ranking, top, shouldRetrieve: string[], source: 'llm'|'keyword' }>}
 */
async function route({ openai, query, collections, model = 'gpt-4o-mini', topK = 1 }) {
  if (!Array.isArray(collections) || collections.length === 0) {
    return { ranking: [], top: '', shouldRetrieve: [], source: 'empty' };
  }
  // Fallback when we can't use the LLM.
  if (!openai) {
    const kw = keywordRoute({ query, collections });
    const pick = kw.ranking.slice(0, Math.max(1, topK)).map(r => r.name);
    return { ...kw, shouldRetrieve: pick };
  }

  const catalog = collections.map(c =>
    `- ${c.name}: ${String(c.description || '').slice(0, 400)}` +
    (c.examples && c.examples.length ? `\n  examples: ${c.examples.slice(0, 3).join(' | ')}` : '')
  ).join('\n');

  try {
    const resp = await openai.chat.completions.create({
      model, temperature: 0, max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: ROUTER_SYSTEM },
        { role: 'user',   content: `QUERY:\n${String(query).slice(0, 2000)}\n\nCOLLECTIONS:\n${catalog}` },
      ],
    });
    const parsed = parseJSON(resp.choices?.[0]?.message?.content || '{}');
    const rawRanking = Array.isArray(parsed.ranking) ? parsed.ranking : [];

    // Canonicalise: every collection must appear, names must match,
    // scores in [0,1]. If the LLM misses one, fill with a zero entry.
    const byName = new Map();
    for (const r of rawRanking) {
      if (!r || typeof r.name !== 'string') continue;
      const score = typeof r.score === 'number' ? Math.max(0, Math.min(1, r.score)) : 0;
      byName.set(r.name, { name: r.name, score, reason: String(r.reason || '').slice(0, 200) });
    }
    const ranking = collections.map(c => byName.get(c.name) || { name: c.name, score: 0, reason: 'not ranked' });
    ranking.sort((a, b) => b.score - a.score);
    const shouldRetrieve = ranking.slice(0, Math.max(1, topK)).map(r => r.name);
    return { ranking, top: ranking[0]?.name || '', shouldRetrieve, source: 'llm' };
  } catch (err) {
    // LLM broken → keyword fallback instead of failing the whole request.
    const kw = keywordRoute({ query, collections });
    const pick = kw.ranking.slice(0, Math.max(1, topK)).map(r => r.name);
    return { ...kw, shouldRetrieve: pick };
  }
}

module.exports = {
  applyMetadataFilter,
  matchesCondition,
  matchesDateRange,
  matchesTagSet,
  route,
  keywordRoute,
  ROUTER_SYSTEM,
};

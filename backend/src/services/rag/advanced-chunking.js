/**
 * advanced-chunking — indexing-side techniques from Gao et al. 2024
 * §IV.B (Indexing Optimization). Three complementary strategies:
 *
 *   1. sentenceWindow — index each SENTENCE separately; at retrieval
 *      time return the surrounding window of ±N sentences as the
 *      generation context. This lets the retriever match on the most
 *      specific unit (a sentence) while the generator sees enough
 *      surrounding context to answer. Good when the document is dense
 *      and the hit is one precise claim.
 *
 *   2. parentChild (small-to-big) — split into SMALL chunks for
 *      retrieval + track a PARENT chunk (paragraph / section) for
 *      generation. The retriever embeds the small chunks (high
 *      recall on specific terms); the generator reads the parent
 *      (coherent context). parent_id metadata links the two.
 *
 *   3. autoMerge — post-processor for parent-child. When ≥ K children
 *      of the same parent are retrieved, SWAP the children for the
 *      single parent. Reduces redundancy and gives the generator one
 *      long coherent context instead of many adjacent fragments.
 *
 * These produce `{ id, text, metadata }` structures the caller feeds
 * to ingestion (e.g. rag-service.ingest). Nothing here hits the DB —
 * they're pure functions + one optional LLM-free utility.
 */

const crypto = require('crypto');

function stableId(source, index, text) {
  // Deterministic id so re-ingesting the same chunk doesn't create
  // duplicates. 16 hex chars is collision-safe within a corpus.
  const h = crypto.createHash('sha1').update(`${source}|${index}|${text.slice(0, 200)}`).digest('hex');
  return h.slice(0, 16);
}

// Sentence splitter — deliberately simple. For Unicode punctuation +
// abbreviation edge cases you'd want a real NLP library, but this
// covers the common case without a dependency.
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡"'])/g;

function splitSentences(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return [];
  const normalised = text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
  const parts = normalised.split(SENTENCE_SPLIT_RE).map(s => s.trim()).filter(Boolean);
  return parts.length ? parts : [normalised];
}

/**
 * sentenceWindow — one chunk per sentence, with ±N-sentence window
 * text stored for generation.
 *
 * @param {object} args
 * @param {string} args.source    — document identifier
 * @param {string} args.text
 * @param {number} [args.window=2] — number of sentences on each side
 * @returns {Array<{ id, source, text, retrievalText, windowText, metadata }>}
 *   `retrievalText` is the single sentence (what gets embedded).
 *   `windowText` is the full ±window passage (what the generator reads).
 */
function sentenceWindow({ source, text, window = 2 }) {
  const sents = splitSentences(text);
  return sents.map((sent, i) => {
    const start = Math.max(0, i - window);
    const end = Math.min(sents.length, i + window + 1);
    const windowText = sents.slice(start, end).join(' ');
    return {
      id: stableId(source, i, sent),
      source,
      text: sent,             // kept for callers that only read `text`
      retrievalText: sent,
      windowText,
      metadata: {
        strategy: 'sentence-window',
        sentenceIndex: i,
        windowStart: start,
        windowEnd: end,
        totalSentences: sents.length,
      },
    };
  });
}

/**
 * parentChild — split the document into PARENT chunks (paragraph /
 * section-size, by default ~1500 chars with sentence boundaries) and
 * within each parent emit CHILD chunks (~300 chars) with a parent_id
 * pointer.
 *
 * Retrieval indexes the CHILDREN; generation reads the parent.
 *
 * @param {object} args
 * @param {string} args.source
 * @param {string} args.text
 * @param {number} [args.parentSize=1500]
 * @param {number} [args.childSize=300]
 * @param {number} [args.childOverlap=50]
 * @returns {{
 *   parents: Array<{id, source, text, metadata}>,
 *   children: Array<{id, source, parentId, text, metadata}>,
 * }}
 */
function parentChild({ source, text, parentSize = 1500, childSize = 300, childOverlap = 50 }) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { parents: [], children: [] };
  }
  const parents = [];
  const children = [];
  const sents = splitSentences(text);

  // Build parent chunks by accumulating sentences until size threshold.
  let buf = '';
  let parentIndex = 0;
  for (const sent of sents) {
    if (buf.length > 0 && buf.length + 1 + sent.length > parentSize) {
      parents.push({
        id: stableId(source, `parent-${parentIndex}`, buf),
        source,
        text: buf,
        metadata: { strategy: 'parent-child', role: 'parent', parentIndex, charLen: buf.length },
      });
      parentIndex++;
      buf = sent;
    } else {
      buf = buf ? `${buf} ${sent}` : sent;
    }
  }
  if (buf) {
    parents.push({
      id: stableId(source, `parent-${parentIndex}`, buf),
      source,
      text: buf,
      metadata: { strategy: 'parent-child', role: 'parent', parentIndex, charLen: buf.length },
    });
  }

  // Build children by sliding-window within each parent.
  for (const parent of parents) {
    const body = parent.text;
    let childIndex = 0;
    for (let i = 0; i < body.length; i += Math.max(1, childSize - childOverlap)) {
      const child = body.slice(i, i + childSize);
      if (child.trim().length === 0) continue;
      children.push({
        id: stableId(source, `${parent.id}-${childIndex}`, child),
        source,
        parentId: parent.id,
        text: child,
        metadata: {
          strategy: 'parent-child',
          role: 'child',
          parentIndex: parent.metadata.parentIndex,
          childIndex,
          offset: i,
        },
      });
      childIndex++;
      if (i + childSize >= body.length) break;
    }
  }

  return { parents, children };
}

/**
 * autoMerge — post-retrieval consolidation.
 *
 * Given the retriever's top-K child hits, if ≥ threshold children
 * come from the same parent, REPLACE those children with the parent
 * document. Rest of the hits pass through unchanged.
 *
 * @param {object} args
 * @param {Array<{id, parentId?, score?}>} args.hits — retrieved children
 * @param {Map<string,object>|object} args.parentById — parentId → parent record
 * @param {number} [args.threshold=2] — min children for a merge
 * @returns {{
 *   merged: Array<{id, text, score, mergedFrom?: string[]}>,
 *   mergedParents: number,
 * }}
 */
function autoMerge({ hits, parentById, threshold = 2 }) {
  if (!Array.isArray(hits) || hits.length === 0) return { merged: [], mergedParents: 0 };
  const lookup = parentById instanceof Map
    ? parentById
    : new Map(Object.entries(parentById || {}));

  const byParent = new Map();
  const noParent = [];
  for (const h of hits) {
    const pid = h.parentId || h.metadata?.parentId;
    if (pid) {
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid).push(h);
    } else {
      noParent.push(h);
    }
  }

  const merged = [];
  let mergedCount = 0;

  for (const [pid, group] of byParent.entries()) {
    if (group.length >= threshold && lookup.has(pid)) {
      const parent = lookup.get(pid);
      const best = group.reduce((a, b) => ((a.score ?? 0) >= (b.score ?? 0) ? a : b));
      merged.push({
        id: parent.id || pid,
        text: parent.text || '',
        score: best.score,
        mergedFrom: group.map(g => g.id),
        metadata: { ...(parent.metadata || {}), merged: true, childCount: group.length },
      });
      mergedCount++;
    } else {
      for (const h of group) merged.push(h);
    }
  }
  for (const h of noParent) merged.push(h);

  // Stable sort by descending score (preserve original order on ties).
  merged.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return { merged, mergedParents: mergedCount };
}

module.exports = {
  sentenceWindow,
  parentChild,
  autoMerge,
  splitSentences,
};

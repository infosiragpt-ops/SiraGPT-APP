'use strict';

/**
 * semantic-deduplicator — deterministic near-duplicate detection for
 * text items the brain handles (claims, citations, memory facts,
 * retrieval results, action items, etc.).
 *
 * Why this exists:
 *  Multiple modules need "is this item already in the set?":
 *    - memory-promotion-lifecycle deduplicates against existing facts
 *    - citation engine should not list the same source twice
 *    - parallel retrieval can return the same passage from N tools
 *    - quality-scorer should not double-count repeated findings
 *
 *  Today each module rolls its own equality (lowercase contains,
 *  first-N-char prefix, …). That's noisy. This module gives them a
 *  shared, cheap, dependency-free near-duplicate check based on:
 *
 *    - Normalisation (lowercase, NFC, whitespace, punctuation)
 *    - Token-set Jaccard
 *    - 4-gram char shingle Jaccard (catches paraphrase)
 *    - Composite similarity (weighted)
 *    - Distance-based clustering helper (dedupItems)
 *
 *  Pure, deterministic, dependency-free, < 1 ms per pair on typical
 *  passage lengths (200-2000 chars).
 *
 * Public API:
 *   normalize(text)                              → string
 *   similarity(a, b, opts?)                      → number 0..1
 *   areDuplicate(a, b, opts?)                    → boolean
 *   dedupItems(items, opts?)                     → { unique[], duplicates[] }
 *   clusterByPrefix(items, prefixLen?)           → Array<Array<item>>
 */

const DEFAULT_THRESHOLD = 0.78;
const STOP_WORDS = new Set([
  'the','of','and','to','in','a','is','that','for','on','with','as','at','by','from','this','but','not','are','or','be','have','has','was','were','will','would','can','should','which','when','where','while',
  'el','la','los','las','de','que','y','en','un','una','por','con','para','es','son','del','al','este','esta','como','pero','porque','cuando','donde','también','más','sin','sobre','hasta',
]);

// ─── Normalisation ──────────────────────────────────────────────

function normalize(text) {
  if (typeof text !== 'string') return '';
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim();
}

function tokens(text) {
  return normalize(text).split(' ').filter(t => t.length >= 2 && !STOP_WORDS.has(t));
}

function shingles(text, k = 4) {
  const norm = normalize(text);
  if (norm.length < k) return new Set([norm]);
  const set = new Set();
  for (let i = 0; i <= norm.length - k; i++) {
    set.add(norm.slice(i, i + k));
  }
  return set;
}

function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const v of setA) if (setB.has(v)) inter++;
  return inter / (setA.size + setB.size - inter);
}

// ─── Similarity ──────────────────────────────────────────────

function similarity(a, b, opts = {}) {
  const A = typeof a === 'string' ? a : '';
  const B = typeof b === 'string' ? b : '';
  if (!A && !B) return 1;
  if (!A || !B) return 0;
  if (A === B) return 1;
  if (normalize(A) === normalize(B)) return 1;
  const tokA = new Set(tokens(A));
  const tokB = new Set(tokens(B));
  const tokenJ = jaccard(tokA, tokB);
  const shingleK = Number(opts.k) || 4;
  const shA = shingles(A, shingleK);
  const shB = shingles(B, shingleK);
  const shingleJ = jaccard(shA, shB);
  // Composite: token-set carries semantic weight, shingles carry order
  // and paraphrase resilience.
  const composite = 0.55 * tokenJ + 0.45 * shingleJ;
  return Math.min(1, composite);
}

function areDuplicate(a, b, opts = {}) {
  const threshold = Number(opts.threshold) || DEFAULT_THRESHOLD;
  return similarity(a, b, opts) >= threshold;
}

// ─── Cluster + dedup ────────────────────────────────────────

/**
 * Greedy near-duplicate clustering. Pass an array of items and an
 * extractor `getText(item)`. Returns:
 *   { unique:    Array<item>,
 *     duplicates: Array<{ kept, dropped, similarity }> }
 *
 * The first occurrence of each cluster wins ("kept"). Subsequent
 * near-duplicates are dropped with their similarity recorded.
 *
 * Time: O(n²) on the number of items but cheap per pair. Acceptable
 * for n up to ~1000.
 */
function dedupItems(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return { unique: [], duplicates: [] };
  const getText = typeof opts.getText === 'function' ? opts.getText : (x) => typeof x === 'string' ? x : (x?.text || x?.content || x?.value || '');
  const threshold = Number(opts.threshold) || DEFAULT_THRESHOLD;
  const unique = [];
  const duplicates = [];
  const tokensCache = new Map();
  const shinglesCache = new Map();

  function cachedTokens(item) {
    if (tokensCache.has(item)) return tokensCache.get(item);
    const t = new Set(tokens(getText(item)));
    tokensCache.set(item, t);
    return t;
  }
  function cachedShingles(item) {
    if (shinglesCache.has(item)) return shinglesCache.get(item);
    const s = shingles(getText(item));
    shinglesCache.set(item, s);
    return s;
  }

  for (const item of list) {
    const aText = getText(item);
    if (!aText) {
      unique.push(item);
      continue;
    }
    let dupOf = null;
    let dupSim = 0;
    const aTok = cachedTokens(item);
    const aSh = cachedShingles(item);
    for (const u of unique) {
      const bTok = cachedTokens(u);
      const bSh = cachedShingles(u);
      const tokenJ = jaccard(aTok, bTok);
      const shJ = jaccard(aSh, bSh);
      const sim = 0.55 * tokenJ + 0.45 * shJ;
      if (sim >= threshold && sim > dupSim) {
        dupOf = u;
        dupSim = sim;
      }
    }
    if (dupOf) {
      duplicates.push({ kept: dupOf, dropped: item, similarity: Number(dupSim.toFixed(3)) });
    } else {
      unique.push(item);
    }
  }
  return { unique, duplicates };
}

/**
 * Cheap pre-bucketing: cluster items by the first `prefixLen` chars of
 * their normalised form. Use this as an O(n) prefilter when n > 1000
 * before invoking the full dedupItems on each bucket.
 */
function clusterByPrefix(items, prefixLen = 24, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const getText = typeof opts.getText === 'function' ? opts.getText : (x) => typeof x === 'string' ? x : (x?.text || x?.content || x?.value || '');
  const buckets = new Map();
  for (const item of list) {
    const key = normalize(getText(item)).slice(0, prefixLen) || '__empty__';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }
  return [...buckets.values()];
}

module.exports = {
  normalize,
  similarity,
  areDuplicate,
  dedupItems,
  clusterByPrefix,
  DEFAULT_THRESHOLD,
  _internal: { tokens, shingles, jaccard, STOP_WORDS },
};

'use strict';

const { createBm25Index, DEFAULT_STOPWORDS } = require('./bm25');

const STOPWORDS = new Set([...DEFAULT_STOPWORDS].map(word => word.normalize('NFD').replace(/\p{M}/gu, '')));

// Normalize only the search representation. Stored text and cited excerpts
// retain original accents, table line breaks, decimal punctuation and values.
function documentTokens(text) {
  if (typeof text !== 'string' || !text) return [];
  const normalized = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  const raw = normalized.match(/[\p{L}_][\p{L}\p{N}_]*(?:[-./][\p{L}\p{N}_]+)*|\p{N}+(?:[.,]\p{N}+)*/gu) || [];
  const tokens = [];
  for (const token of raw) {
    if (STOPWORDS.has(token)) continue;
    // Decimal values stay whole: 0,05 is not interchangeable with 0,01.
    // File names and identifiers also retain their exact compound token.
    if (token.length > 1 || /^\p{N}$/u.test(token)) tokens.push(token);
    if (/^\p{L}/u.test(token) && /[-./]/.test(token)) {
      for (const part of token.split(/[-./]/)) {
        if ((part.length > 1 || /^\p{N}$/u.test(part)) && !STOPWORDS.has(part)) tokens.push(part);
      }
    }
  }
  return tokens;
}

function searchDocumentLexical(entries, query, k = 10) {
  const index = createBm25Index({ tokenize: documentTokens, k1: 1.5 });
  const queryTerms = new Set(documentTokens(query));
  const matchingTerms = new Set();
  const coverage = new Map();
  entries.forEach((entry, position) => {
    const text = [entry.title, entry.text].filter(Boolean).join('\n');
    index.add(position, text);
    const tokens = new Set(documentTokens(text));
    let matched = 0;
    for (const term of queryTerms) {
      if (tokens.has(term)) { matched += 1; matchingTerms.add(term); }
    }
    coverage.set(position, matched);
  });
  return index.search(query, { topK: k }).map(hit => ({
    doc: { _idx: hit.id },
    score: hit.score,
    // Evidence matching all searchable query terms is stronger than a
    // partial hit. This breaks otherwise identical opposing RRF ranks.
    coverage: matchingTerms.size ? coverage.get(hit.id) / matchingTerms.size : 0,
  }));
}

// Broad comparisons need evidence from several documents. Promote each
// source's best competitive hit without guaranteeing a slot to a weak source.
function diversifyDocumentSources(pool, k) {
  const topScore = Math.max(0, ...pool.map(hit => Number(hit.score) || 0));
  const selected = [];
  const sources = new Set();
  for (const hit of pool) {
    if (selected.length >= k) break;
    if (!hit.source || sources.has(hit.source) || hit.score < topScore * 0.75) continue;
    if (!(hit.textScore > 0 || hit.vectorScore > 0)) continue;
    sources.add(hit.source);
    selected.push(hit);
  }
  const picked = new Set(selected);
  for (const hit of pool) {
    if (selected.length >= k) break;
    if (!picked.has(hit)) selected.push(hit);
  }
  return selected;
}

/** Return a bounded, verbatim span containing the best local query evidence. */
function queryFocusedExcerpt(text, query, maxChars) {
  if (typeof text !== 'string' || !text) return '';
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 1200;
  if (!limit) return '';
  if (text.length <= limit) return text;
  if (!documentTokens(query).length) return text.slice(0, limit);

  // Overlapping windows inspect the complete text, including a final tail
  // window. A bounded index keeps a large document from creating millions
  // of tiny windows if a caller requests an unusually small excerpt.
  const windowSize = Math.max(160, limit);
  const stride = Math.max(80, Math.floor(windowSize / 2));
  const starts = new Set([0, Math.max(0, text.length - windowSize)]);
  for (let rough = stride; rough < text.length; rough += stride) {
    const lineStart = text.lastIndexOf('\n', rough - 1) + 1;
    starts.add(rough - lineStart < windowSize / 4 ? lineStart : rough);
  }
  const windows = [...starts].sort((a, b) => a - b).map(start => ({ start, text: text.slice(start, start + windowSize) }));
  const [best] = searchDocumentLexical(windows, query, 1);
  if (!best) return text.slice(0, limit);
  const winner = windows[best.doc._idx];
  const terms = new Set(documentTokens(query));
  const matches = [...winner.text.matchAll(/[\p{L}\p{N}_.,/-]+/gu)]
    .filter(match => documentTokens(match[0]).some(token => terms.has(token)));
  const first = matches[0];
  const last = matches[matches.length - 1];
  const center = first ? Math.floor((first.index + last.index + last[0].length) / 2) : 0;
  let start = Math.max(0, Math.min(text.length - limit, winner.start + center - Math.floor(limit / 2)));
  // Re-center the evidence rather than leaving a matched row at the window
  // boundary, where its value or following unit could otherwise be cut off.
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  if (start - lineStart < limit / 8) start = lineStart;
  return text.slice(start, start + limit);
}

module.exports = { documentTokens, searchDocumentLexical, queryFocusedExcerpt, diversifyDocumentSources };

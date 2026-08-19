'use strict';

/**
 * recursive-splitter — splits long text into chunks while preserving
 * semantic boundaries (paragraphs > sentences > words > chars). The
 * default separator ladder mirrors LangChain's RecursiveCharacter
 * splitter; the implementation is dependency-free and produces
 * deterministic chunks with configurable overlap.
 *
 * Pairs with the BM25 index (#33) and vector-ops top-K (#29): both
 * expect document-sized inputs, this is what feeds them.
 *
 * Algorithm:
 *   1. Try the longest separator that yields >1 piece.
 *   2. For each piece: if it fits the chunk size, accept; else recurse
 *      with the next-finer separator.
 *   3. After all pieces are sized, merge adjacent ones up to chunkSize
 *      so we don't return a hundred 50-char chunks when 1500 was asked.
 *   4. Apply overlap by carrying the tail of chunk N into the head of
 *      chunk N+1 (no overlap when chunkOverlap=0).
 *
 * Public API:
 *   splitText(text, { chunkSize=1000, chunkOverlap=100, separators? })
 *     → string[]
 *   splitWithMetadata(text, { ... })  → [{ text, start, end, index }]
 */

// Note: no empty-string separator — falling through to hard-chop is
// safer than splitting per-character and re-joining with spaces, which
// produced spurious whitespace.
const DEFAULT_SEPARATORS = ['\n\n', '\n', '. ', '? ', '! ', '; ', ', ', ' '];
const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_CHUNK_OVERLAP = 100;

function splitOnSeparator(text, sep) {
  if (sep === '') return [...text]; // fallback: per-character
  return text.split(sep);
}

function joinPieces(pieces, sep) {
  return sep === '' ? pieces.join('') : pieces.join(sep);
}

function recursiveSplit(text, chunkSize, separators) {
  if (text.length <= chunkSize) return [text];
  for (let i = 0; i < separators.length; i++) {
    const sep = separators[i];
    const parts = splitOnSeparator(text, sep);
    if (parts.length <= 1) continue;
    // Each part may still be too long → recurse with the next-finer ladder.
    const next = separators.slice(i + 1);
    const out = [];
    for (const p of parts) {
      const piece = sep === '' ? p : p; // sep is removed; we re-merge below
      if (piece.length <= chunkSize) out.push(piece);
      else if (next.length > 0) {
        for (const sub of recursiveSplit(piece, chunkSize, next)) out.push(sub);
      } else {
        // Hard cut by character budget when no separators remain.
        for (let k = 0; k < piece.length; k += chunkSize) out.push(piece.slice(k, k + chunkSize));
      }
    }
    return out.filter((p) => p.length > 0);
  }
  // No separator yielded >1 piece → hard chop.
  const out = [];
  for (let k = 0; k < text.length; k += chunkSize) out.push(text.slice(k, k + chunkSize));
  return out;
}

function mergePieces(pieces, chunkSize, sep) {
  // Merge adjacent pieces back together up to chunkSize so we don't
  // emit dozens of 30-char fragments when chunkSize is 1000.
  const merged = [];
  let current = '';
  for (const p of pieces) {
    if (!p) continue;
    const candidate = current ? current + sep + p : p;
    if (candidate.length <= chunkSize) {
      current = candidate;
    } else {
      if (current) merged.push(current);
      // If this piece itself is bigger than chunkSize we keep it
      // (recursiveSplit already capped at chunkSize but chunkSize+sep
      // may overshoot; still keep as a single chunk).
      current = p;
    }
  }
  if (current) merged.push(current);
  return merged;
}

function applyOverlap(chunks, overlap) {
  if (overlap <= 0 || chunks.length <= 1) return chunks;
  const out = [chunks[0]];
  for (let i = 1; i < chunks.length; i++) {
    const prev = out[out.length - 1];
    const tail = prev.length > overlap ? prev.slice(prev.length - overlap) : prev;
    out.push(tail + chunks[i]);
  }
  return out;
}

function splitText(text, opts = {}) {
  if (typeof text !== 'string' || !text) return [];
  const chunkSize = Number.isFinite(opts.chunkSize) && opts.chunkSize > 0
    ? Math.floor(opts.chunkSize)
    : DEFAULT_CHUNK_SIZE;
  let chunkOverlap = Number.isFinite(opts.chunkOverlap) && opts.chunkOverlap >= 0
    ? Math.floor(opts.chunkOverlap)
    : DEFAULT_CHUNK_OVERLAP;
  if (chunkOverlap >= chunkSize) {
    if (Object.prototype.hasOwnProperty.call(opts, 'chunkOverlap')) {
      throw new RangeError('recursive-splitter: chunkOverlap must be < chunkSize');
    }
    // Default was too large for the chosen chunkSize — clamp silently.
    chunkOverlap = Math.max(0, Math.floor(chunkSize / 4));
  }
  const separators = Array.isArray(opts.separators) && opts.separators.length
    ? opts.separators.slice()
    : DEFAULT_SEPARATORS.slice();

  const pieces = recursiveSplit(text, chunkSize, separators);
  const merged = mergePieces(pieces, chunkSize, ' ');
  return applyOverlap(merged, chunkOverlap);
}

function splitWithMetadata(text, opts = {}) {
  const chunks = splitText(text, opts);
  // For metadata we report a best-effort start/end by scanning the
  // original text for each chunk's first 32 characters. Overlap-
  // generated leading bytes are skipped from the search target so the
  // start corresponds to the *new* content start.
  const overlap = Number.isFinite(opts.chunkOverlap) ? opts.chunkOverlap : DEFAULT_CHUNK_OVERLAP;
  let cursor = 0;
  return chunks.map((chunk, index) => {
    const probe = chunk.slice(index === 0 ? 0 : Math.min(overlap, chunk.length));
    const head = probe.slice(0, 32);
    const found = text.indexOf(head, cursor);
    const start = found === -1 ? cursor : found;
    const end = start + chunk.length;
    cursor = Math.max(cursor, found === -1 ? cursor + chunk.length : found + chunk.length);
    return { text: chunk, start, end, index };
  });
}

module.exports = {
  splitText,
  splitWithMetadata,
  DEFAULT_SEPARATORS,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP,
};

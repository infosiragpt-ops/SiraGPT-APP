'use strict';

// Server-side twin of lib/chat/document-chunks.ts for the chunked
// ("paginated") editor mode of the /chat document editor.
//
// The frontend and the backend MUST split byte-identically so that
// `chunks.map(c => c.content).join('') === original` holds across a paged
// save: each modified chunk is edited in its own Tiptap instance and the full
// document is reassembled client-side exactly as it arrived. Any divergence
// here would silently corrupt user documents — keep the two files in sync and
// covered by tests on BOTH sides (tests/lib/document-chunks.test.ts and
// backend/tests/file-chunks.test.js).
//
// Pure string module: no fs, no DB, no network. The route in
// routes/files.js owns all I/O and calls these helpers.

const TARGET_CHUNK_SIZE = 64 * 1024;
const MAX_CHUNK_SIZE = 96 * 1024;

// Documents at or above this many characters open in chunked mode. ~8MB of
// Markdown ≈ a 500+ page document. Below the cutoff the classic single-doc
// editor is served; above it GET /:id/chunks is the supported read path.
const CHUNKED_MODE_THRESHOLD_CHARS = 8 * 1024 * 1024;

function chunkByParagraphs(content, targetSize = TARGET_CHUNK_SIZE, maxSize = MAX_CHUNK_SIZE) {
  if (typeof content !== 'string' || content.length === 0) return [];
  const effectiveMax = Math.max(1, Math.min(maxSize, Math.max(maxSize, targetSize)));
  const chunks = [];

  const pushChunk = (buffer) => {
    if (buffer.length > 0) chunks.push({ index: chunks.length, content: buffer });
  };

  // Split keeping separators (\n\n runs) via capture groups so every source
  // character lands in exactly one chunk — round-trip is exact by design.
  const parts = content.split(/(\n{2,})/);
  let buffer = '';

  const flushIfOver = () => {
    if (buffer.length >= targetSize) {
      pushChunk(buffer);
      buffer = '';
    }
  };

  for (const part of parts) {
    if (buffer.length + part.length <= effectiveMax) {
      buffer += part;
      // Only paragraph TEXT closes a chunk at target size; separators stick
      // to the text they follow so a page never starts with stray blank lines.
      if (!/^\n{2,}$/.test(part)) flushIfOver();
      continue;
    }

    pushChunk(buffer);
    buffer = '';

    if (part.length <= effectiveMax) {
      buffer = part;
      if (!/^\n{2,}$/.test(part)) flushIfOver();
      continue;
    }

    if (/^\n{2,}$/.test(part)) {
      // Pathological separator run → subdivide without losing newlines.
      let remaining = part;
      while (remaining.length > effectiveMax) {
        pushChunk(remaining.slice(0, effectiveMax));
        remaining = remaining.slice(effectiveMax);
      }
      buffer = remaining;
      continue;
    }

    // Giant paragraph (> max) → fall back to line boundaries.
    const lines = part.split(/(\n)/);
    for (const line of lines) {
      if (buffer.length + line.length <= effectiveMax) {
        buffer += line;
        continue;
      }
      pushChunk(buffer);
      buffer = '';
      if (line.length > effectiveMax) {
        // Single line still too big → hard slices at exact char boundaries.
        let remainingLine = line;
        while (remainingLine.length > effectiveMax) {
          pushChunk(remainingLine.slice(0, effectiveMax));
          remainingLine = remainingLine.slice(effectiveMax);
        }
        buffer = remainingLine;
      } else {
        buffer = line;
      }
    }
    flushIfOver();
  }

  pushChunk(buffer);

  return chunks.map((chunk, index) => ({ index, content: chunk.content }));
}

function joinChunks(chunks) {
  if (!Array.isArray(chunks)) return '';
  let out = '';
  for (const chunk of chunks) {
    const piece = typeof chunk === 'string' ? chunk : chunk && chunk.content;
    if (typeof piece === 'string') out += piece;
  }
  return out;
}

function shouldUseChunkedMode(charCount) {
  return Number.isFinite(charCount) && charCount >= CHUNKED_MODE_THRESHOLD_CHARS;
}

module.exports = {
  TARGET_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  CHUNKED_MODE_THRESHOLD_CHARS,
  chunkByParagraphs,
  joinChunks,
  shouldUseChunkedMode,
};

'use strict';

/**
 * code-fence-extractor — pulls fenced code blocks out of markdown
 * text. CommonMark-compatible: 3-or-more backticks or 3-or-more
 * tildes, optional info string (language). Closing fence must match
 * the opening fence's char and be at least as long.
 *
 * Pairs with the JSON repair (#21) and the structured-output JSON
 * parse path: the model often wraps its JSON in a ```json fence;
 * extract the block first, parse second.
 *
 * Public API:
 *   extractCodeBlocks(text)
 *     → [{ lang, info, content, fenceChar, fenceLength,
 *          startLine, endLine }, ...]
 *
 *   extractFirstByLang(text, lang)  — convenience: first block whose
 *                                      lang === lang (case-insensitive)
 *
 *   stripCodeBlocks(text)            — returns text with blocks removed
 *                                      (useful for prose-only summary)
 */

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})([^\n]*)$/;

function extractCodeBlocks(text) {
  if (typeof text !== 'string' || !text) return [];
  const lines = text.split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = FENCE_RE.exec(line);
    if (!m) { i += 1; continue; }
    const fenceChar = m[2][0];
    const fenceLen = m[2].length;
    const indent = m[1].length;
    const info = (m[3] || '').trim();
    const lang = info.split(/\s+/)[0] || '';
    const start = i;
    const contentLines = [];
    i += 1;
    let closed = false;
    while (i < lines.length) {
      const inner = lines[i];
      const closer = FENCE_RE.exec(inner);
      if (
        closer &&
        closer[2][0] === fenceChar &&
        closer[2].length >= fenceLen &&
        // close fence must have NO info string per CommonMark
        closer[3].trim() === ''
      ) {
        closed = true;
        break;
      }
      // Strip up-to-`indent` leading spaces from each content line.
      contentLines.push(indent > 0 ? inner.replace(new RegExp(`^ {0,${indent}}`), '') : inner);
      i += 1;
    }
    out.push({
      lang,
      info,
      content: contentLines.join('\n'),
      fenceChar,
      fenceLength: fenceLen,
      startLine: start,
      endLine: closed ? i : i - 1,
      closed,
    });
    i += 1; // step past the closing fence (or the EOF)
  }
  return out;
}

function extractFirstByLang(text, lang) {
  const target = String(lang || '').toLowerCase();
  for (const block of extractCodeBlocks(text)) {
    if (block.lang.toLowerCase() === target) return block;
  }
  return null;
}

function stripCodeBlocks(text) {
  if (typeof text !== 'string' || !text) return '';
  const lines = text.split(/\r?\n/);
  const blocks = extractCodeBlocks(text);
  // Remove from the bottom up so indexes stay valid.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    lines.splice(b.startLine, (b.endLine - b.startLine) + 1);
  }
  return lines.join('\n');
}

module.exports = {
  extractCodeBlocks,
  extractFirstByLang,
  stripCodeBlocks,
};

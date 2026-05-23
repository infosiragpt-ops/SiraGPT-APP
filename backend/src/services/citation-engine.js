/**
 * citation-engine — turn LLM responses with [Source: N] markers into
 * cleanly annotated text plus a structured citations payload.
 *
 * The flow:
 *   1. Caller retrieves chunks via rag.retrieve(), numbers them 1..N and
 *      injects them into the system prompt with an instruction like
 *      "cite sources as [Source: 1], [Source: 2]". (See
 *      buildCitationSystemBlock() below for the canonical block.)
 *   2. The LLM replies with markers interleaved in prose.
 *   3. This module parses the response:
 *        - replaces [Source: N] → [N] in the text
 *        - collapses duplicate adjacent citations ([1][1] → [1])
 *        - builds a structured citations array limited to markers that
 *          were actually used
 *        - renders a footnotes block the frontend can show verbatim
 *
 * We accept both English [Source: N] and Spanish [Fuente: N] markers —
 * siraGPT responds in whichever language the user writes in.
 *
 * Pattern reference: Iliagpt.io server/rag/citationEngine.ts.
 */

// Matches "[Source: 3]", "[Source 3]", "[Fuente: 3]", with flexible spacing.
// Capture 1 = the numeric id. We keep the regex tolerant of LLM drift
// (occasional missing colon, extra whitespace) because the alternative
// is dropping a valid citation on a cosmetic miss.
const MARKER_RE = /\[\s*(?:source|fuente)\s*:?\s*(\d+)\s*\]/gi;

/**
 * Format the sources block that goes into the system prompt ahead of the
 * user's query. The LLM reads this, then writes its reply. Keep the
 * instructions terse — long citation guidance pushes the answer quality
 * down more than it helps.
 */
function buildCitationSystemBlock(chunks, { language = 'en' } = {}) {
  if (!Array.isArray(chunks) || chunks.length === 0) return '';
  const header = language === 'es'
    ? 'FUENTES (cita como [Fuente: N] cuando uses información de ellas):'
    : 'SOURCES (cite as [Source: N] when you use information from them):';
  const body = chunks.map((c, i) => {
    const label = c.title || c.source || `source-${i + 1}`;
    const snippet = (c.text || '').slice(0, 500).replace(/\s+/g, ' ').trim();
    return `[${i + 1}] ${label}\n${snippet}`;
  }).join('\n\n');
  return `${header}\n\n${body}`;
}

/**
 * Parse an LLM response and produce a { annotatedText, citations,
 * footnotes, hasCitations } object.
 *
 * @param {string} response — raw model output
 * @param {Array<{text, source?, title?, score?}>} chunks — the numbered
 *   chunks that were injected as sources (index 0 → marker [1]).
 */
function extractCitations(response, chunks) {
  const safeChunks = Array.isArray(chunks) ? chunks : [];
  if (!response || typeof response !== 'string' || safeChunks.length === 0) {
    return {
      annotatedText: response || '',
      citations: [],
      footnotes: '',
      hasCitations: false,
    };
  }

  // First pass: collect every (position, sourceIndex) match, keyed by
  // 0-based index. Markers with out-of-range numbers are flagged for
  // stripping rather than keeping a dangling [7] that points nowhere.
  const usedIndices = new Set();
  // Reset lastIndex in case someone imported the regex directly.
  MARKER_RE.lastIndex = 0;

  let annotated = response.replace(MARKER_RE, (_match, num) => {
    const n = parseInt(num, 10);
    if (!Number.isInteger(n) || n < 1 || n > safeChunks.length) return '';
    usedIndices.add(n - 1);
    return `[${n}]`;
  });

  // Collapse adjacent duplicate markers like "[1] [1]" or "[1][1]" → "[1]".
  annotated = annotated.replace(/(\[\d+\])(\s*\1)+/g, '$1');

  // Trim double-spaces left behind when we stripped bogus markers.
  annotated = annotated.replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n');

  // Build structured citations in user-visible order (1, 2, 3...).
  const citations = [...usedIndices]
    .sort((a, b) => a - b)
    .map(idx => {
      const c = safeChunks[idx];
      return {
        index: idx + 1,
        sourceId: c.source || c.title || `source-${idx + 1}`,
        title: c.title || c.source || `Source ${idx + 1}`,
        snippet: (c.text || '').slice(0, 240).replace(/\s+/g, ' ').trim(),
        relevanceScore: typeof c.score === 'number' ? c.score : null,
      };
    });

  const footnotes = citations.length === 0
    ? ''
    : citations
        .map(c => `[${c.index}] ${c.title}${c.snippet ? ' — ' + c.snippet : ''}`)
        .join('\n');

  return {
    annotatedText: annotated.trim(),
    citations,
    footnotes,
    hasCitations: citations.length > 0,
  };
}

/**
 * Convenience helper for callers who just want the full display string:
 * annotated body + footnotes separated by a blank line. When no
 * citations were found we return the original body unchanged so the UX
 * doesn't show an empty "Sources" heading.
 */
function renderAnnotated(response, chunks, { footnotesHeader } = {}) {
  const { annotatedText, footnotes, hasCitations } = extractCitations(response, chunks);
  if (!hasCitations) return annotatedText;
  const header = footnotesHeader || 'Sources';
  return `${annotatedText}\n\n${header}:\n${footnotes}`;
}

module.exports = {
  MARKER_RE,
  extractCitations,
  renderAnnotated,
  buildCitationSystemBlock,
};

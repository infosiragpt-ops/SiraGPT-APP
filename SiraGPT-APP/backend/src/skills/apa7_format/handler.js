/**
 * apa7_format skill — wraps services/marco-teorico/apa7 for direct
 * agent invocation. Pure compute (no network, no LLM), so capabilities
 * is empty — works in any session policy including the strictest
 * sandbox modes.
 *
 * The author shape this accepts is intentionally permissive:
 *   - {family, given}     — CrossRef-style structured names
 *   - {display: "..."}   — OpenAlex-style "Last F" strings
 *   - bare strings       — also accepted; we split on the last space
 * apa7.pickSource normalises whatever shape we hand it.
 */

const apa7 = require('../../services/marco-teorico/apa7');

/**
 * Authors arrive in three shapes:
 *   - bare string ("Andrew Ng") — OpenAlex display style
 *   - {display: "..."}          — same as bare string, wrapped
 *   - {family, given}           — CrossRef structured
 * pickSource's openalex branch only accepts display-strings; its
 * crossref branch only accepts {family, given}. So we route each
 * author into the side that will normalise it correctly: any
 * structured author makes the whole list a "crossref" payload.
 */
function partitionAuthors(arr) {
  if (!Array.isArray(arr)) return { openalex: [], crossref: null };
  const isStructured = arr.some(a =>
    a && typeof a === 'object' && (a.family || a.given) && !a.display
  );
  if (isStructured) {
    return {
      openalex: [],
      crossref: arr.map(a => {
        if (typeof a === 'string') {
          return { name: a };
        }
        return {
          family: a.family || null,
          given: a.given || null,
          name: a.name || a.display || null,
        };
      }),
    };
  }
  // All display-string-shaped — feed into openalex side.
  return {
    openalex: arr.map(a => typeof a === 'string' ? a : (a?.display || a?.name || String(a || ''))),
    crossref: null,
  };
}

function normalizeInputSource(s) {
  const { openalex, crossref: crAuthors } = partitionAuthors(s.authors);
  // Build the openalex-shape source. If we collected structured
  // authors above, also stitch a synthetic CrossRef payload so
  // apa7.pickSource takes the structured branch and preserves the
  // family/given split (otherwise the inline citation falls back to
  // [object Object]).
  const openalexShape = {
    doi: s.doi || null,
    title: s.title || null,
    authors: openalex,
    year: s.year || null,
    venue: s.container || s.venue || null,
    type: s.type || null,
    landingUrl: s.url || null,
    openAccessUrl: s.openAccessUrl || null,
    abstract: s.abstract || null,
  };
  const crossrefShape = crAuthors
    ? {
        valid: true,
        doi: s.doi || null,
        title: s.title || null,
        authors: crAuthors,
        year: s.year || null,
        container: s.container || null,
        volume: s.volume || null,
        issue: s.issue || null,
        pages: s.pages || null,
        publisher: s.publisher || null,
        type: s.type || null,
        url: s.url || (s.doi ? `https://doi.org/${s.doi}` : null),
      }
    : (s.crossref || null);

  return apa7.pickSource(openalexShape, crossrefShape);
}

async function execute(args) {
  const sources = Array.isArray(args?.sources) ? args.sources : [];
  if (sources.length === 0) return { error: 'no sources provided' };

  const want = args?.want || 'both';
  const normalized = sources.map(normalizeInputSource);

  const out = {};
  if (want === 'inline' || want === 'both') {
    out.inline = normalized.map((src, i) => ({
      index: i,
      title: src.title,
      citation: apa7.inlineCitation(src),
    }));
  }
  if (want === 'reference_list' || want === 'both') {
    out.reference_list = apa7.referenceList(normalized);
  }
  return out;
}

module.exports = { execute };

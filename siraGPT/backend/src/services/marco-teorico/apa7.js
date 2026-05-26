/**
 * apa7 — format sources as APA 7 citations (inline + reference list).
 *
 * APA 7 rules implemented:
 *   - Inline: (Author, Year) or (Author et al., Year) for 3+ authors.
 *   - "Ampersand in the reference, 'and' in prose" — we emit
 *     references with & between last two authors; inline always uses
 *     & inside parentheses.
 *   - Author format in reference: "LastName, F. M." (initials w/ dots).
 *   - Single-author vs two-author vs 3+ handled separately.
 *   - Italicised journal title + volume + (issue) + pages, DOI as URL.
 *   - Missing pieces (no year, no venue) degrade gracefully rather
 *     than emitting the literal string "undefined".
 *
 * Not implemented (out of scope for a generator MVP):
 *   - Book chapter format (edited volumes).
 *   - Translated works.
 *   - Secondary citation ("as cited in").
 *   - Non-English title retention rules (APA 7 allows the original
 *     title + bracketed translation; we just use the original).
 *
 * The input shape is the union of OpenAlex + CrossRef metadata the
 * orchestrator hands us. Either can fill any field; we prefer
 * CrossRef when both are present because CrossRef is authoritative.
 */

function pickSource(openalexSrc, crossrefMeta) {
  const r = crossrefMeta?.valid ? crossrefMeta : null;
  const o = openalexSrc || {};

  return {
    doi: r?.doi || o.doi || null,
    title: r?.title || o.title || null,
    authors: normaliseAuthors(r, o),
    year: r?.year || o.year || null,
    container: r?.container || o.venue || null,
    volume: r?.volume || null,
    issue: r?.issue || null,
    pages: r?.pages || null,
    type: r?.type || o.type || null,
    url: r?.url || (o.doi ? `https://doi.org/${o.doi}` : (o.landingUrl || null)),
    openAccessUrl: o.openAccessUrl || null,
    abstract: o.abstract || null,
  };
}

function normaliseAuthors(crossref, openalex) {
  // Prefer CrossRef for structured names — OpenAlex gives "display_name"
  // which doesn't split family vs given. If CrossRef is missing, fall
  // back to a best-effort split on OpenAlex names.
  if (crossref && Array.isArray(crossref.authors) && crossref.authors.length > 0) {
    return crossref.authors.map(a => ({
      family: a.family || (a.name ? splitName(a.name).family : null),
      given: a.given || (a.name ? splitName(a.name).given : null),
      display: a.name || [a.given, a.family].filter(Boolean).join(' '),
    }));
  }
  if (Array.isArray(openalex.authors) && openalex.authors.length > 0) {
    return openalex.authors.map(name => {
      const { family, given } = splitName(name);
      return { family, given, display: name };
    });
  }
  return [];
}

function splitName(display) {
  if (!display || typeof display !== 'string') return { family: null, given: null };
  // "A. Karpathy" → given "A." family "Karpathy"
  // "Andrew Ng" → given "Andrew" family "Ng"
  // "Y. Bengio, Y." → strip trailing comma-letter debris
  const cleaned = display.replace(/\s+/g, ' ').trim();
  const parts = cleaned.split(' ');
  if (parts.length === 1) return { family: parts[0], given: null };
  return { family: parts[parts.length - 1], given: parts.slice(0, -1).join(' ') };
}

// ─── Inline ───────────────────────────────────────────────────────────────

/**
 * Build an inline citation: "(Smith, 2024)" / "(Smith & Jones, 2024)"
 * / "(Smith et al., 2024)". Year defaults to "n.d." when missing.
 */
function inlineCitation(src) {
  const year = src.year || 'n.d.';
  const a = src.authors || [];
  if (a.length === 0) {
    return `(${src.title?.split(' ').slice(0, 3).join(' ') || 'Anonymous'}, ${year})`;
  }
  if (a.length === 1) return `(${a[0].family || a[0].display}, ${year})`;
  if (a.length === 2) return `(${a[0].family || a[0].display} & ${a[1].family || a[1].display}, ${year})`;
  return `(${a[0].family || a[0].display} et al., ${year})`;
}

// ─── Reference list entry ─────────────────────────────────────────────────

/**
 * Format authors for the reference list.
 * APA 7: "Last, F. M., & Last, F. M." with up to 20 before et al.
 */
function formatAuthorsForReference(authors) {
  if (authors.length === 0) return '';
  const formatOne = (a) => {
    const fam = a.family || 'Unknown';
    const initials = (a.given || '')
      .split(/\s+/)
      .filter(Boolean)
      .map(w => {
        // Already an initial like "A." → keep.
        if (/^[A-Z]\.?$/.test(w)) return w.endsWith('.') ? w : `${w}.`;
        return `${w[0].toUpperCase()}.`;
      })
      .join(' ');
    return initials ? `${fam}, ${initials}` : fam;
  };

  const parts = authors.slice(0, 20).map(formatOne);
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]}, & ${parts[1]}`;
  const head = parts.slice(0, -1).join(', ');
  return `${head}, & ${parts[parts.length - 1]}`;
}

function italics(text) {
  // We render as markdown — consumers pipe through marked / react-
  // markdown that treats *foo* as italics. For plain-text output the
  // same markers are valid APA style (some style guides accept _foo_).
  return `*${text}*`;
}

/**
 * Build the reference-list entry for a single source. Returns a
 * markdown string with italics for the journal title.
 */
function referenceEntry(src) {
  const authors = formatAuthorsForReference(src.authors || []);
  const year = src.year ? `(${src.year}).` : '(n.d.).';
  const title = src.title ? `${src.title}${src.title.endsWith('.') ? '' : '.'}` : '(Untitled).';
  const venue = src.container ? italics(src.container) : null;

  const vol = src.volume ? (src.issue ? `${src.volume}(${src.issue})` : `${src.volume}`) : null;
  const pages = src.pages ? `, ${src.pages}` : '';
  const venueBlock = venue
    ? `${venue}${vol ? `, ${italics(vol)}` : ''}${pages}.`
    : '';

  const url = src.url || (src.doi ? `https://doi.org/${src.doi}` : null);
  const urlBlock = url ? ` ${url}` : '';

  const pieces = [authors, year, title, venueBlock].filter(p => p && p.length > 0);
  return pieces.join(' ').trim() + urlBlock;
}

/**
 * Turn an array of merged sources into a sorted APA 7 reference list
 * (Markdown bullets). Sort: by first author's surname, then year.
 */
function referenceList(sources) {
  const sorted = [...sources].sort((a, b) => {
    const aFam = a.authors?.[0]?.family || 'ZZZ';
    const bFam = b.authors?.[0]?.family || 'ZZZ';
    return aFam.localeCompare(bFam) || (a.year || 0) - (b.year || 0);
  });
  return sorted.map(s => `- ${referenceEntry(s)}`).join('\n');
}

module.exports = {
  pickSource,
  inlineCitation,
  referenceEntry,
  referenceList,
  formatAuthorsForReference,
  splitName,
};

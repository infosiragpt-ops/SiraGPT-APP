/**
 * openalex — fetch academic sources from OpenAlex.
 *
 * Why OpenAlex: free, no API key required, covers 240M+ works
 * including papers without paywalled-only coverage (important for
 * Latin American research via Redalyc/Scielo imports). We send a
 * polite User-Agent with a mailto so OpenAlex routes our requests
 * to the fast "polite pool" — that's a community norm, not a
 * hard requirement.
 *
 * We request exactly the fields we need so payloads stay small and
 * the page-of-25 default keeps round-trips honest. A caller that
 * asks for 50 sources just gets two pages.
 *
 * The "abstract" in OpenAlex is returned as an inverted index
 * (term → positions) rather than plain text — we rehydrate it here
 * so the synthesizer gets sentences, not a sparse map.
 */

const USER_AGENT = 'siraGPT/1.0 (mailto:support@siragpt.io)';
const BASE_URL = 'https://api.openalex.org/works';
const DEFAULT_PER_PAGE = 25;
const MAX_PER_PAGE = 50;
// Per-page request deadline (sibling crossref.js has the same bound). The
// caller's `signal` is the user-cancellation token, NOT a timeout, so without
// this a stalled OpenAlex page could block the search phase indefinitely.
const PER_CALL_TIMEOUT_MS = Number(process.env.OPENALEX_TIMEOUT_MS) || 8000;

/**
 * Search OpenAlex for works matching `query`.
 *
 * @param {object} opts
 * @param {string} opts.query — topic / research question (free text)
 * @param {number} [opts.limit=30] — max sources to return
 * @param {[number, number]} [opts.yearRange] — inclusive [from, to], defaults to no filter
 * @param {string} [opts.lang] — ISO 639-1; filters to works in that language when set
 * @param {AbortSignal} [opts.signal]
 *
 * @returns {Promise<Array<{
 *   id: string, doi: string|null, title: string,
 *   authors: string[], year: number|null, venue: string|null,
 *   abstract: string|null, type: string|null, citedByCount: number,
 *   openAccessUrl: string|null, landingUrl: string|null,
 * }>>}
 */
async function search({ query, limit = 30, yearRange = null, lang = null, signal = null }) {
  if (!query || typeof query !== 'string') return [];
  const perPage = Math.min(limit, MAX_PER_PAGE);
  const pagesNeeded = Math.ceil(limit / perPage);

  const filters = ['has_abstract:true'];
  if (Array.isArray(yearRange) && yearRange.length === 2) {
    filters.push(`publication_year:${yearRange[0]}-${yearRange[1]}`);
  }
  if (lang && /^[a-z]{2}$/.test(lang)) {
    filters.push(`language:${lang}`);
  }

  const allResults = [];
  for (let page = 1; page <= pagesNeeded; page++) {
    const params = new URLSearchParams({
      search: query,
      per_page: String(perPage),
      page: String(page),
      sort: 'cited_by_count:desc',
      select: [
        'id', 'doi', 'title', 'publication_year',
        'authorships', 'primary_location', 'abstract_inverted_index',
        'type', 'cited_by_count', 'open_access',
      ].join(','),
      filter: filters.join(','),
    });

    let resp;
    try {
      // Combine the caller's cancellation signal with a per-call timeout.
      // A timeout aborts with a TimeoutError (name 'TimeoutError'), which the
      // catch below treats as a transient failure → break → partial results;
      // only a real user cancel (AbortError) is rethrown.
      const timeoutSignal = AbortSignal.timeout(PER_CALL_TIMEOUT_MS);
      const fetchSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      resp = await fetch(`${BASE_URL}?${params.toString()}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: fetchSignal,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      console.warn('[openalex] fetch failed:', err.message);
      break;
    }
    if (!resp.ok) {
      console.warn(`[openalex] HTTP ${resp.status}`);
      break;
    }
    const json = await resp.json();
    const page_results = Array.isArray(json.results) ? json.results : [];
    for (const work of page_results) {
      allResults.push(normaliseWork(work));
      if (allResults.length >= limit) break;
    }
    if (allResults.length >= limit) break;
    if (page_results.length < perPage) break; // no more pages
  }
  return allResults.slice(0, limit);
}

function normaliseWork(work) {
  // DOIs in OpenAlex come as "https://doi.org/10.xxx/..." — we strip
  // the prefix so downstream code can compose its own URL or hand the
  // bare DOI to CrossRef.
  const doi = work.doi
    ? work.doi.replace(/^https?:\/\/doi\.org\//i, '')
    : null;

  const authors = Array.isArray(work.authorships)
    ? work.authorships.slice(0, 8).map(a => a?.author?.display_name).filter(Boolean)
    : [];

  const venue = work.primary_location?.source?.display_name || null;

  return {
    id: work.id, // OpenAlex id, e.g. "https://openalex.org/W..."
    doi,
    title: work.title || '(no title)',
    authors,
    year: typeof work.publication_year === 'number' ? work.publication_year : null,
    venue,
    abstract: rehydrateAbstract(work.abstract_inverted_index),
    type: work.type || null,
    citedByCount: typeof work.cited_by_count === 'number' ? work.cited_by_count : 0,
    openAccessUrl: work.open_access?.oa_url || null,
    landingUrl: work.primary_location?.landing_page_url || null,
  };
}

/**
 * OpenAlex returns abstracts as inverted indexes (word -> [positions]).
 * Rehydrate into a normal string. Silently returns null if the index
 * is missing or malformed.
 */
function rehydrateAbstract(idx) {
  if (!idx || typeof idx !== 'object') return null;
  try {
    const words = [];
    for (const [term, positions] of Object.entries(idx)) {
      for (const p of positions) words[p] = term;
    }
    // `words` may have holes; join with spaces and compact repeats.
    return words.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || null;
  } catch {
    return null;
  }
}

module.exports = { search, rehydrateAbstract };

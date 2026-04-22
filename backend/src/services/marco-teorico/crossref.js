/**
 * crossref — verify DOIs exist + fetch authoritative metadata.
 *
 * OpenAlex is an aggregator that occasionally ingests metadata with
 * typos or stale DOIs. CrossRef is the authoritative registry for
 * DOIs: a HEAD or light GET against its API tells us whether a DOI
 * actually resolves. We do a parallel batch so validating 30 sources
 * takes a couple of seconds, not a minute.
 *
 * CrossRef asks for a mailto in User-Agent to route requests to the
 * "polite pool" (faster + higher rate limit). Same convention as
 * OpenAlex.
 *
 * The validator returns enriched metadata (journal title, issue,
 * page range, container-title) that APA 7 formatting needs but
 * OpenAlex doesn't always expose. When CrossRef returns 404, the
 * DOI is unverified — the orchestrator should mark the source as
 * "unvalidated" rather than silently dropping it (student might
 * still want the reference even if the DOI is bad).
 */

const USER_AGENT = 'siraGPT/1.0 (mailto:support@siragpt.io)';
const BASE_URL = 'https://api.crossref.org/works/';
const PER_CALL_TIMEOUT_MS = 6000;
const CONCURRENCY = 6; // polite; CrossRef allows more but cap to be neighbourly

async function fetchWithTimeout(url, { signal, timeoutMs = PER_CALL_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // If the caller aborted, propagate to our inner controller.
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    return await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify a single DOI. Returns either the enriched metadata or
 * { valid: false, doi }.
 */
async function verify(doi, { signal } = {}) {
  if (!doi || typeof doi !== 'string') return { valid: false, doi: null };
  // URL-encode the DOI path segment — CrossRef accepts slashes raw
  // but defensive here in case a weird DOI ever contains `?` etc.
  const safe = encodeURIComponent(doi).replace(/%2F/gi, '/');
  let resp;
  try {
    resp = await fetchWithTimeout(`${BASE_URL}${safe}`, { signal });
  } catch {
    return { valid: false, doi };
  }
  if (!resp || !resp.ok) return { valid: false, doi };

  let json;
  try { json = await resp.json(); } catch { return { valid: false, doi }; }
  const m = json?.message;
  if (!m) return { valid: false, doi };

  return {
    valid: true,
    doi,
    title: Array.isArray(m.title) ? m.title[0] : (m.title || null),
    authors: Array.isArray(m.author)
      ? m.author.map(a => ({
          family: a.family || null,
          given: a.given || null,
          name: a.name || null,
        }))
      : [],
    year: m['published-print']?.['date-parts']?.[0]?.[0]
       || m['published-online']?.['date-parts']?.[0]?.[0]
       || m.created?.['date-parts']?.[0]?.[0]
       || null,
    container: Array.isArray(m['container-title']) ? m['container-title'][0] : null,
    volume: m.volume || null,
    issue: m.issue || null,
    pages: m.page || null,
    publisher: m.publisher || null,
    type: m.type || null,
    url: m.URL || (doi ? `https://doi.org/${doi}` : null),
  };
}

/**
 * Verify many DOIs in parallel, bounded by CONCURRENCY to stay
 * polite. Maintains input order in the returned array so callers can
 * zip with their source list.
 *
 * onResult is called as each verification finishes so the UI can
 * stream in real time rather than wait for the whole batch.
 */
async function verifyBatch(dois, { signal, onResult } = {}) {
  const results = new Array(dois.length).fill(null);
  let cursor = 0;

  async function worker() {
    while (true) {
      if (signal?.aborted) return;
      const idx = cursor++;
      if (idx >= dois.length) return;
      const doi = dois[idx];
      const r = await verify(doi, { signal });
      results[idx] = r;
      if (typeof onResult === 'function') {
        try { onResult(idx, r); } catch { /* noop */ }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, dois.length) }, worker));
  return results;
}

module.exports = { verify, verifyBatch, CONCURRENCY };

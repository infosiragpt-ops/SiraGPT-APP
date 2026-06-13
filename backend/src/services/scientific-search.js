'use strict';

/**
 * scientific-search.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Unified search over the major scientific-paper APIs, spanning multiple
 * regions of the world. Most sources work with NO API key (arXiv, Semantic
 * Scholar, OpenAlex, CrossRef, PubMed E-utilities, Europe PMC, DOAJ, DBLP,
 * DataCite, SciELO, Redalyc); CORE optionally takes a free key for higher rate
 * limits. DOAJ adds worldwide open-access journal coverage (~130 countries),
 * DBLP the global computer-science bibliography, DataCite global
 * datasets/software/theses, and SciELO + Redalyc strong Latin-American /
 * Iberian open-access reach. Two commercial indices are key-gated and degrade
 * to [] when unconfigured: Scopus (SCOPUS_API_KEY, Elsevier) and Web of Science
 * (WOS_API_KEY / CLARIVATE_API_KEY, Clarivate Starter API).
 *
 * Each provider exposes a `search(query, opts)` function that returns an
 * array of canonical Paper objects:
 *
 *   {
 *     source: 'arxiv' | 'openalex' | 'semanticscholar' | 'crossref' | 'pubmed' | 'europepmc' | 'core' | 'doaj' | 'dblp' | 'datacite' | 'scielo' | 'scopus' | 'wos' | 'redalyc',
 *     id: <provider-native id>,
 *     doi: '10.x/...' | null,
 *     title: 'string',
 *     abstract: 'string' | null,
 *     authors: [{ name, affiliation? }],
 *     year: 2024,
 *     venue: 'journal/conference name' | null,
 *     citations: 42 | null,
 *     openAccess: true | false | null,
 *     pdfUrl: 'https://...' | null,
 *     htmlUrl: 'https://...' | null,
 *   }
 *
 * The unified `searchAll(query, opts)` fans out to all configured providers in
 * parallel with per-provider timeouts, merges the results, deduplicates by
 * DOI (case-insensitive, falling back to normalised title) and returns a
 * single ranked list. Each provider failure is captured in the returned
 * `errors` array so the caller can decide whether to surface partial results.
 *
 * Public API:
 *   search(query, opts)     → { papers, errors, providers }
 *   searchArxiv(query, opts)
 *   searchSemanticScholar(query, opts)
 *   searchOpenAlex(query, opts)
 *   searchCrossRef(query, opts)
 *   searchPubMed(query, opts)
 *   searchEuropePMC(query, opts)
 *   searchCore(query, opts)
 *   searchSciELO(query, opts)        — key-free (via Crossref member 530)
 *   searchRedalyc(query, opts)       — key-free (via OpenAlex source pin)
 *   searchScopus(query, opts)        — requires SCOPUS_API_KEY
 *   searchWebOfScience(query, opts)  — requires WOS_API_KEY / CLARIVATE_API_KEY
 *   _internal: { dedupeByDoi, normaliseTitle, parseAtomFeed }
 *
 * Design constraints:
 *   - Zero external deps beyond stdlib + global fetch (Node 18+).
 *   - Each provider call is timeout-bounded (default 8s) and returns []
 *     on any failure (errors collected separately).
 *   - Always sends a polite User-Agent including the configured contact
 *     email (SIRAGPT_RESEARCH_EMAIL) when available — many of these APIs
 *     deprioritise anonymous traffic.
 *   - Deterministic ranking: openAccess (true first) → citations (desc) →
 *     year (desc) → title length (asc, shorter = more focused).
 */

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_PER_PROVIDER_LIMIT = 10;
const MAX_PER_PROVIDER_LIMIT = 50;
const USER_AGENT_PREFIX = 'SiraGPT-Research/1.0';

// Retry transient per-provider failures (timeout / 429 / 5xx / network) once
// by default — a single flaky API shouldn't silently drop a whole source from
// the results. Env-tunable; 0 disables retries.
const DEFAULT_RETRIES = (() => {
  const n = parseInt(process.env.SCIENTIFIC_SEARCH_RETRIES || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 1;
})();
// Wall-clock ceiling for the whole fan-out. Guarantees `search()` returns
// partial results instead of blocking on the slowest provider.
const DEFAULT_TOTAL_TIMEOUT_MS = (() => {
  const n = parseInt(process.env.SCIENTIFIC_SEARCH_TOTAL_TIMEOUT_MS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 20000;
})();

const PROVIDERS = ['arxiv', 'openalex', 'semanticscholar', 'crossref', 'pubmed', 'europepmc', 'core', 'doaj', 'dblp', 'datacite', 'scielo', 'scopus', 'wos', 'redalyc', 'biorxiv', 'medrxiv'];

function userAgent() {
  const email = process.env.SIRAGPT_RESEARCH_EMAIL || '';
  if (email) return `${USER_AGENT_PREFIX} (mailto:${email})`;
  return USER_AGENT_PREFIX;
}

// fetch with REAL cancellation. The old `withTimeout` only rejected the wrapper
// promise on a deadline — the underlying TCP socket + file descriptor lived on
// until the OS gave up, leaking connections under 10-provider fan-out load. We
// now drive an AbortController: the deadline (opts.timeoutMs, default
// DEFAULT_TIMEOUT_MS) aborts the socket AND a race rejects the promise so a peer
// that ignores the abort can never wedge a provider. An external opts.signal is
// chained in for cooperative cancellation from the caller.
async function fetchWithAbort(url, opts = {}) {
  const ms = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const label = opts.label || 'request';
  const ac = new AbortController();
  const onExternalAbort = () => { try { ac.abort(); } catch { /* noop */ } };
  if (opts.signal) {
    if (opts.signal.aborted) onExternalAbort();
    else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      try { ac.abort(); } catch { /* noop */ }
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      fetch(url, {
        signal: ac.signal,
        headers: { 'User-Agent': userAgent(), ...(opts.headers || {}) },
      }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (opts.signal) {
      try { opts.signal.removeEventListener('abort', onExternalAbort); } catch { /* noop */ }
    }
  }
}

async function safeJson(url, opts = {}) {
  const res = await fetchWithAbort(url, {
    ...opts,
    headers: { Accept: 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  }
  return res.json();
}

async function safeText(url, opts = {}) {
  const res = await fetchWithAbort(url, opts);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  }
  return res.text();
}

function clampLimit(n) {
  const parsed = parseInt(n, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PER_PROVIDER_LIMIT;
  return Math.min(MAX_PER_PROVIDER_LIMIT, parsed);
}

function normaliseTitle(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normaliseDoi(d) {
  if (!d) return null;
  return String(d).toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').trim() || null;
}

const _metaScore = (x) =>
  (x.abstract ? 2 : 0) +
  (x.openAccess ? 2 : 0) +
  (x.citations != null ? 1 : 0) +
  (x.pdfUrl ? 1 : 0);

// Fuse two records for the same paper found via different providers into one
// richer record: fill missing scalars, keep the longest author list, take the
// max citation count, let a definite openAccess=true win, and record every
// contributing source for provenance. The old dedup just kept whichever record
// had more metadata and DISCARDED the other's unique fields (e.g. an arXiv hit
// with a PDF url would be dropped in favour of a Crossref hit with the DOI +
// citation count, losing the PDF). Merging keeps the best of both.
function mergePaper(base, extra) {
  const out = { ...base };
  out.doi = base.doi || extra.doi || null;
  out.abstract = base.abstract || extra.abstract || null;
  out.pdfUrl = base.pdfUrl || extra.pdfUrl || null;
  out.htmlUrl = base.htmlUrl || extra.htmlUrl || null;
  out.venue = base.venue || extra.venue || null;
  out.year = base.year || extra.year || null;
  const cb = typeof base.citations === 'number' ? base.citations : null;
  const ce = typeof extra.citations === 'number' ? extra.citations : null;
  out.citations = cb != null && ce != null ? Math.max(cb, ce) : (cb != null ? cb : ce);
  out.openAccess = (base.openAccess === true || extra.openAccess === true)
    ? true
    : (base.openAccess === false || extra.openAccess === false)
      ? false
      : (base.openAccess != null ? base.openAccess : (extra.openAccess != null ? extra.openAccess : null));
  if ((extra.authors?.length || 0) > (base.authors?.length || 0)) out.authors = extra.authors;
  const srcs = []
    .concat(base.sources || (base.source ? [base.source] : []))
    .concat(extra.sources || (extra.source ? [extra.source] : []));
  out.sources = Array.from(new Set(srcs.filter(Boolean)));
  return out;
}

function dedupeByDoi(papers) {
  const seen = new Map();
  const order = [];
  for (const p of papers) {
    // Defensive: a malformed (non-object/null) entry must not abort the whole
    // dedupe pass and drop every other paper that came with it.
    if (!p || typeof p !== 'object') continue;
    const doi = normaliseDoi(p.doi);
    const key = doi || `t:${normaliseTitle(p.title)}`;
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, p);
      order.push(key);
      continue;
    }
    // The richer record is the base; fuse the other's unique fields into it.
    const base = _metaScore(p) > _metaScore(prev) ? p : prev;
    const other = base === p ? prev : p;
    seen.set(key, mergePaper(base, other));
  }
  return order.map((k) => seen.get(k));
}

// ── Relevance scoring ──────────────────────────────────────────────────
// The old ranking sorted purely by open-access → citations → year → title
// length. It NEVER looked at whether a paper actually matched the query, so a
// heavily-cited classic on an unrelated topic could outrank the precise paper
// the user asked for. We now score query-term coverage (title weighted far
// above abstract/venue) as the PRIMARY signal, then use the old metadata
// signals as tiebreakers. Bilingual EN/ES stopwords keep scores meaningful.
const STOPWORDS = new Set((
  'the a an of and or in on for to with from by at as is are be this that these those ' +
  'una un el la los las de del y o en con por para a al se su sus es son lo le les'
).split(' '));

function queryTerms(query) {
  return normaliseTitle(query)
    .split(' ')
    .filter((w) => w && w.length > 1 && !STOPWORDS.has(w));
}

function relevanceScore(paper, terms) {
  if (!terms || !terms.length) return 0;
  const title = normaliseTitle(paper.title);
  const abs = normaliseTitle(paper.abstract || '');
  const venue = normaliseTitle(paper.venue || '');
  let titleHits = 0;
  let softHits = 0;
  for (const t of terms) {
    if (title.includes(t)) titleHits += 1;
    else if (abs.includes(t)) softHits += 1;
    else if (venue.includes(t)) softHits += 0.5;
  }
  const coverage = (titleHits + softHits) / terms.length;   // breadth of match
  const titleWeight = titleHits / terms.length;             // precision of match
  const phrase = title.includes(terms.join(' ')) ? 0.5 : 0; // exact phrase bonus
  return coverage + titleWeight * 1.5 + phrase;
}

// `query` is optional: when omitted the ranking is byte-for-byte the legacy
// open-access → citations → year → title-length order (preserves callers/tests
// that rank a raw list). When provided, relevance dominates.
function rankPapers(papers, query) {
  const terms = query ? queryTerms(query) : null;
  return papers
    .map((p) => ({ p, rel: terms ? relevanceScore(p, terms) : 0 }))
    .sort((a, b) => {
      if (terms) {
        // Round to damp floating-point jitter so tiebreakers still apply
        // between papers of essentially-equal relevance.
        const ra = Math.round(a.rel * 1000);
        const rb = Math.round(b.rel * 1000);
        if (rb !== ra) return rb - ra;
      }
      const A = a.p;
      const B = b.p;
      if ((B.openAccess ? 1 : 0) !== (A.openAccess ? 1 : 0)) {
        return (B.openAccess ? 1 : 0) - (A.openAccess ? 1 : 0);
      }
      const ca = A.citations || 0;
      const cb = B.citations || 0;
      if (ca !== cb) return cb - ca;
      const ya = A.year || 0;
      const yb = B.year || 0;
      if (ya !== yb) return yb - ya;
      return (A.title || '').length - (B.title || '').length;
    })
    .map((x) => x.p);
}

// Source diversification — the product premise is "search across diverse
// sources", but a single provider with very precise title matches (e.g.
// Semantic Scholar) can otherwise monopolise the entire top of the ranked
// list. This is a SOFT, relevance-preserving interleave applied AFTER ranking:
// it keeps the strongest paper(s) of each source up front but breaks long runs
// from one provider so the first screenful actually reflects multiple sources.
//
// Algorithm: greedy stable pass over the already-ranked list. We always take
// the best-ranked remaining paper, except once a source has appeared `maxRun`
// times in a row we defer it and pull the next best-ranked paper from a
// DIFFERENT source. If only the over-used source remains, we fall through and
// take it anyway (no starvation, no dropped papers). With maxRun=2 the top-2
// most-relevant papers always survive untouched; interleaving only kicks in at
// the 3rd consecutive same-source paper. O(n²) worst case, but n is small
// (a deduped page of results), so this is negligible.
function diversifyBySource(papers, opts = {}) {
  if (!Array.isArray(papers)) return [];
  const maxRun = Number.isFinite(opts.maxRun) && opts.maxRun >= 1 ? Math.floor(opts.maxRun) : 2;
  if (papers.length <= maxRun) return papers.slice();
  const remaining = papers.slice();        // preserves the incoming relevance order
  const out = [];
  let lastSource = null;
  let run = 0;
  while (remaining.length) {
    let idx = 0;                            // default: best-ranked remaining paper
    if (run >= maxRun) {
      const alt = remaining.findIndex((p) => (p && p.source) !== lastSource);
      if (alt !== -1) idx = alt;            // else only same-source left → take it anyway
    }
    const [pick] = remaining.splice(idx, 1);
    const src = pick && pick.source;
    if (src === lastSource) run += 1;
    else { lastSource = src; run = 1; }
    out.push(pick);
  }
  return out;
}

// Normalise a free-text query: collapse whitespace and strip wrapping quotes
// so cache keys are stable and providers get a clean term string.
function normaliseQuery(q) {
  return String(q || '')
    .replace(/\s+/g, ' ')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .trim();
}

// ── arXiv ──────────────────────────────────────────────────────────────
// http://export.arxiv.org/api/query — Atom XML. No key required.
function parseAtomFeed(xml) {
  // Light Atom parser tailored for arXiv. Pulls out <entry>...</entry> blocks
  // and grabs id/title/summary/published/author/category.
  const entries = [];
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];
    function pick(tag) {
      const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
      const mm = block.match(re);
      return mm ? mm[1].replace(/\s+/g, ' ').trim() : '';
    }
    function pickAll(tag) {
      const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
      const out = [];
      let mm;
      while ((mm = re.exec(block)) !== null) out.push(mm[1].replace(/\s+/g, ' ').trim());
      return out;
    }
    const id = pick('id');
    const title = pick('title').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    const summary = pick('summary');
    const published = pick('published');
    const authorBlocks = pickAll('author');
    const authors = authorBlocks
      .map((a) => {
        const nm = a.match(/<name\b[^>]*>([\s\S]*?)<\/name>/i);
        return nm ? { name: nm[1].replace(/\s+/g, ' ').trim() } : null;
      })
      .filter(Boolean);
    const doiMatch = block.match(/<arxiv:doi\b[^>]*>([\s\S]*?)<\/arxiv:doi>/i);
    const pdfMatch = block.match(/<link\b[^>]*title="pdf"[^>]*href="([^"]+)"/i);
    const htmlMatch = block.match(/<link\b[^>]*rel="alternate"[^>]*href="([^"]+)"/i);
    entries.push({
      source: 'arxiv',
      id: id.replace(/^http:\/\/arxiv\.org\/abs\//, ''),
      doi: doiMatch ? doiMatch[1].trim() : null,
      title,
      abstract: summary || null,
      authors,
      year: published ? parseInt(published.slice(0, 4), 10) : null,
      venue: 'arXiv',
      citations: null,
      openAccess: true, // arXiv is fully open access
      pdfUrl: pdfMatch ? pdfMatch[1] : null,
      htmlUrl: htmlMatch ? htmlMatch[1] : id || null,
    });
  }
  return entries;
}

async function searchArxiv(query, opts = {}) {
  const limit = clampLimit(opts.limit);
  const params = new URLSearchParams({
    search_query: `all:${query}`,
    start: '0',
    max_results: String(limit),
    sortBy: 'relevance',
    sortOrder: 'descending',
  });
  const url = `http://export.arxiv.org/api/query?${params.toString()}`;
  const xml = await safeText(url, { timeoutMs: opts.timeoutMs, signal: opts.signal, label: 'arxiv' });
  return parseAtomFeed(xml);
}

// ── Semantic Scholar ────────────────────────────────────────────────────
// https://api.semanticscholar.org/graph/v1 — optional API key (free).
async function searchSemanticScholar(query, opts = {}) {
  const limit = clampLimit(opts.limit);
  const fields = [
    'paperId', 'title', 'abstract', 'year', 'venue', 'authors.name', 'authors.affiliations',
    'externalIds', 'openAccessPdf', 'citationCount', 'isOpenAccess', 'url',
  ].join(',');
  const params = new URLSearchParams({ query, limit: String(limit), fields });
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?${params.toString()}`;
  const headers = {};
  if (process.env.SEMANTIC_SCHOLAR_API_KEY) {
    headers['x-api-key'] = process.env.SEMANTIC_SCHOLAR_API_KEY;
  }
  const json = await safeJson(url, { headers, timeoutMs: opts.timeoutMs, signal: opts.signal, label: 'semanticscholar' });
  const items = Array.isArray(json.data) ? json.data : [];
  return items.map((p) => ({
    source: 'semanticscholar',
    id: p.paperId,
    doi: p.externalIds?.DOI || null,
    title: p.title || '',
    abstract: p.abstract || null,
    authors: (p.authors || []).map((a) => ({
      name: a.name,
      affiliation: Array.isArray(a.affiliations) && a.affiliations.length ? a.affiliations[0] : null,
    })),
    year: p.year || null,
    venue: p.venue || null,
    citations: typeof p.citationCount === 'number' ? p.citationCount : null,
    openAccess: !!p.isOpenAccess,
    pdfUrl: p.openAccessPdf?.url || null,
    htmlUrl: p.url || (p.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : null),
  }));
}

// ── OpenAlex ───────────────────────────────────────────────────────────
// https://api.openalex.org — no key required; `mailto` is polite.
// Shared mapper so Redalyc (queried via an OpenAlex source filter) reuses
// the exact same canonical projection. `venueLabel` overrides the venue
// name; `preferLandingPage` makes htmlUrl point at the publisher's landing
// page (the real redalyc.org article) instead of the openalex.org URL.
function mapOpenAlexWork(w, source, { venueLabel, preferLandingPage } = {}) {
  const doi = w.doi?.replace(/^https?:\/\/doi\.org\//, '') || null;
  const landing = w.primary_location?.landing_page_url || null;
  return {
    source,
    id: w.id?.replace(/^https?:\/\/openalex\.org\//, '') || null,
    doi,
    title: w.title || w.display_name || '',
    abstract: w.abstract_inverted_index ? invertedIndexToText(w.abstract_inverted_index) : null,
    authors: (w.authorships || []).map((a) => ({
      name: a.author?.display_name || null,
      affiliation: a.institutions?.[0]?.display_name || null,
    })).filter((a) => a.name),
    year: w.publication_year || null,
    venue: venueLabel || w.host_venue?.display_name || w.primary_location?.source?.display_name || null,
    citations: typeof w.cited_by_count === 'number' ? w.cited_by_count : null,
    openAccess: !!w.open_access?.is_oa,
    pdfUrl: w.open_access?.oa_url || w.primary_location?.pdf_url || null,
    htmlUrl: preferLandingPage
      ? (landing || w.id || (doi ? `https://doi.org/${doi}` : null))
      : (w.id || (doi ? `https://doi.org/${doi}` : null)),
  };
}

async function searchOpenAlex(query, opts = {}) {
  const limit = clampLimit(opts.limit);
  const params = new URLSearchParams({
    search: query,
    per_page: String(limit),
  });
  if (process.env.SIRAGPT_RESEARCH_EMAIL) params.set('mailto', process.env.SIRAGPT_RESEARCH_EMAIL);
  const url = `https://api.openalex.org/works?${params.toString()}`;
  const json = await safeJson(url, { timeoutMs: opts.timeoutMs, signal: opts.signal, label: 'openalex' });
  const items = Array.isArray(json.results) ? json.results : [];
  return items.map((w) => mapOpenAlexWork(w, 'openalex'));
}

// ── Redalyc — Latin-American open-access (UAEMex) ───────────────────────
// Redalyc exposes no documented key-free keyword-search JSON API, so we
// query OpenAlex pinned to Redalyc's canonical source id — the works whose
// PRIMARY host is the Redalyc platform (primary_location.source.id, not the
// looser locations.source.id which also matches merely co-hosted works).
// Key-free and honest: every hit is a redalyc.org article, and htmlUrl
// points at the real redalyc.org landing page. Note: Redalyc-native records
// frequently lack DOIs and OpenAlex often reports is_oa:false for them.
const REDALYC_OPENALEX_SOURCE = 'S4377196100';
async function searchRedalyc(query, opts = {}) {
  const limit = clampLimit(opts.limit);
  const params = new URLSearchParams({
    search: query,
    per_page: String(limit),
    filter: `primary_location.source.id:${REDALYC_OPENALEX_SOURCE}`,
  });
  if (process.env.SIRAGPT_RESEARCH_EMAIL) params.set('mailto', process.env.SIRAGPT_RESEARCH_EMAIL);
  const url = `https://api.openalex.org/works?${params.toString()}`;
  const json = await safeJson(url, { timeoutMs: opts.timeoutMs, signal: opts.signal, label: 'redalyc' });
  const items = Array.isArray(json.results) ? json.results : [];
  return items.map((w) => mapOpenAlexWork(w, 'redalyc', { venueLabel: 'Redalyc', preferLandingPage: true }));
}

// ── bioRxiv & medRxiv — Cold Spring Harbor preprint servers ─────────────
// The official bioRxiv/medRxiv API is date-range based, not keyword-search,
// so — exactly as Redalyc does — we query OpenAlex pinned to each server's
// canonical source id (primary_location.source.id, so a hit's PRIMARY host is
// the preprint server, not merely a work that was later co-hosted there).
// Key-free, abstracts included (OpenAlex inverted index), htmlUrl points at the
// preprint's landing page. These surface as distinct sources ('biorxiv' /
// 'medrxiv') so the diversification pass treats them as the separate sources
// they are. NB: the canonical medRxiv source is S3005729997 — the alternate
// S4306400573 ("medRxiv (Cold Spring Harbor Laboratory)") holds 0 works.
const BIORXIV_OPENALEX_SOURCE = 'S4306402567';
const MEDRXIV_OPENALEX_SOURCE = 'S3005729997';

async function searchPinnedOpenAlexSource(query, opts, { sourceId, source, venueLabel, label }) {
  const limit = clampLimit(opts.limit);
  const params = new URLSearchParams({
    search: query,
    per_page: String(limit),
    filter: `primary_location.source.id:${sourceId}`,
  });
  if (process.env.SIRAGPT_RESEARCH_EMAIL) params.set('mailto', process.env.SIRAGPT_RESEARCH_EMAIL);
  const url = `https://api.openalex.org/works?${params.toString()}`;
  const json = await safeJson(url, { timeoutMs: opts.timeoutMs, signal: opts.signal, label });
  const items = Array.isArray(json.results) ? json.results : [];
  return items.map((w) => mapOpenAlexWork(w, source, { venueLabel, preferLandingPage: true }));
}

async function searchBioRxiv(query, opts = {}) {
  return searchPinnedOpenAlexSource(query, opts, {
    sourceId: BIORXIV_OPENALEX_SOURCE, source: 'biorxiv', venueLabel: 'bioRxiv', label: 'biorxiv',
  });
}

async function searchMedRxiv(query, opts = {}) {
  return searchPinnedOpenAlexSource(query, opts, {
    sourceId: MEDRXIV_OPENALEX_SOURCE, source: 'medrxiv', venueLabel: 'medRxiv', label: 'medrxiv',
  });
}

function invertedIndexToText(idx) {
  // OpenAlex stores abstracts as inverted indices. Reconstruct the sentence
  // by sorting positions, then mapping each position back to its word.
  if (!idx || typeof idx !== 'object') return null;
  const positionToWord = new Map();
  let maxPos = -1;
  for (const [word, positions] of Object.entries(idx)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      if (!Number.isFinite(pos)) continue;
      positionToWord.set(pos, word);
      if (pos > maxPos) maxPos = pos;
    }
  }
  if (maxPos < 0) return null;
  const out = [];
  for (let i = 0; i <= maxPos; i++) out.push(positionToWord.get(i) || '');
  return out.join(' ').replace(/\s+/g, ' ').trim() || null;
}

// ── CrossRef ────────────────────────────────────────────────────────────
// https://api.crossref.org/works — no key required, `mailto` polite.
// Shared mapper so SciELO (which is queried via a Crossref member filter)
// produces byte-for-byte the same canonical shape as plain Crossref.
function mapCrossrefWork(w, source, openAccess) {
  return {
    source,
    id: w.DOI || null,
    doi: w.DOI || null,
    title: Array.isArray(w.title) ? w.title[0] : (w.title || ''),
    abstract: w.abstract ? String(w.abstract).replace(/<[^>]+>/g, '').trim() : null,
    authors: (w.author || []).map((a) => ({
      name: [a.given, a.family].filter(Boolean).join(' '),
      affiliation: Array.isArray(a.affiliation) && a.affiliation.length ? a.affiliation[0].name : null,
    })).filter((a) => a.name),
    year: w.issued?.['date-parts']?.[0]?.[0] || null,
    venue: Array.isArray(w['container-title']) ? w['container-title'][0] : null,
    citations: typeof w['is-referenced-by-count'] === 'number' ? w['is-referenced-by-count'] : null,
    openAccess,
    pdfUrl: null,
    htmlUrl: w.URL || (w.DOI ? `https://doi.org/${w.DOI}` : null),
  };
}

async function searchCrossRef(query, opts = {}) {
  const limit = clampLimit(opts.limit);
  const params = new URLSearchParams({ query, rows: String(limit) });
  if (process.env.SIRAGPT_RESEARCH_EMAIL) params.set('mailto', process.env.SIRAGPT_RESEARCH_EMAIL);
  const url = `https://api.crossref.org/works?${params.toString()}`;
  const json = await safeJson(url, { timeoutMs: opts.timeoutMs, signal: opts.signal, label: 'crossref' });
  const items = Array.isArray(json.message?.items) ? json.message.items : [];
  return items.map((w) => mapCrossrefWork(w, 'crossref', null)); // CrossRef doesn't reliably know OA
}

// ── SciELO — Latin-American / Iberian open-access network ───────────────
// SciELO articles register their DOIs through Crossref member 530
// (FapUNIFESP — the SciELO DOI agency), so we query Crossref filtered to
// that member rather than search.scielo.org, whose JSON endpoint is now
// behind a JavaScript proof-of-work anti-bot challenge (403s server-side
// fetch). This Crossref polite-pool path is key-free and robust, and every
// hit is a genuine open-access SciELO article.
async function searchSciELO(query, opts = {}) {
  const limit = clampLimit(opts.limit);
  const params = new URLSearchParams({ query, rows: String(limit), filter: 'member:530' });
  if (process.env.SIRAGPT_RESEARCH_EMAIL) params.set('mailto', process.env.SIRAGPT_RESEARCH_EMAIL);
  const url = `https://api.crossref.org/works?${params.toString()}`;
  const json = await safeJson(url, { timeoutMs: opts.timeoutMs, signal: opts.signal, label: 'scielo' });
  const items = Array.isArray(json.message?.items) ? json.message.items : [];
  return items.map((w) => mapCrossrefWork(w, 'scielo', true)); // SciELO is open access by definition
}

// ── PubMed E-utilities ─────────────────────────────────────────────────
// https://eutils.ncbi.nlm.nih.gov/entrez/eutils — no key required; rate-
// limited to 3 req/s without a key, 10 with one (NCBI_API_KEY).
async function searchPubMed(query, opts = {}) {
  const limit = clampLimit(opts.limit);
  // Step 1: esearch → list of PMIDs
  const searchParams = new URLSearchParams({
    db: 'pubmed', term: query, retmode: 'json', retmax: String(limit),
  });
  if (process.env.NCBI_API_KEY) searchParams.set('api_key', process.env.NCBI_API_KEY);
  const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${searchParams.toString()}`;
  const searchJson = await safeJson(searchUrl, { timeoutMs: opts.timeoutMs, signal: opts.signal, label: 'pubmed:esearch' });
  const ids = searchJson?.esearchresult?.idlist || [];
  if (ids.length === 0) return [];
  // Step 2: esummary → metadata for those IDs
  const sumParams = new URLSearchParams({
    db: 'pubmed', id: ids.join(','), retmode: 'json',
  });
  if (process.env.NCBI_API_KEY) sumParams.set('api_key', process.env.NCBI_API_KEY);
  const sumUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${sumParams.toString()}`;
  const sumJson = await safeJson(sumUrl, { timeoutMs: opts.timeoutMs, signal: opts.signal, label: 'pubmed:esummary' });
  const result = sumJson?.result || {};
  return ids
    .map((id) => result[id])
    .filter(Boolean)
    .map((p) => ({
      source: 'pubmed',
      id: p.uid,
      doi: (p.articleids || []).find((aid) => aid.idtype === 'doi')?.value || null,
      title: p.title || '',
      abstract: null, // E-summary doesn't include abstract; would need a second efetch
      authors: (p.authors || []).map((a) => ({ name: a.name })),
      year: p.pubdate ? parseInt(String(p.pubdate).slice(0, 4), 10) || null : null,
      venue: p.fulljournalname || p.source || null,
      citations: null,
      openAccess: null,
      pdfUrl: null,
      htmlUrl: `https://pubmed.ncbi.nlm.nih.gov/${p.uid}/`,
    }));
}

// ── Europe PMC ─────────────────────────────────────────────────────────
// https://www.ebi.ac.uk/europepmc/webservices/rest — no key required.
async function searchEuropePMC(query, opts = {}) {
  const limit = clampLimit(opts.limit);
  const params = new URLSearchParams({
    query, format: 'json', pageSize: String(limit), resultType: 'core',
  });
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params.toString()}`;
  const json = await safeJson(url, { timeoutMs: opts.timeoutMs, signal: opts.signal, label: 'europepmc' });
  const items = json?.resultList?.result || [];
  return items.map((r) => ({
    source: 'europepmc',
    id: r.id || r.pmid || null,
    doi: r.doi || null,
    title: r.title || '',
    abstract: r.abstractText || null,
    authors: (r.authorList?.author || []).map((a) => ({
      name: [a.firstName, a.lastName].filter(Boolean).join(' ') || a.fullName || null,
      affiliation: a.affiliation || null,
    })).filter((a) => a.name),
    year: r.pubYear ? parseInt(r.pubYear, 10) || null : null,
    venue: r.journalTitle || null,
    citations: typeof r.citedByCount === 'number' ? r.citedByCount : null,
    openAccess: r.isOpenAccess === 'Y',
    pdfUrl: (r.fullTextUrlList?.fullTextUrl || [])
      .find((u) => u.documentStyle === 'pdf')?.url || null,
    htmlUrl: r.doi ? `https://doi.org/${r.doi}` : (r.pmid ? `https://europepmc.org/article/MED/${r.pmid}` : null),
  }));
}

// ── CORE ───────────────────────────────────────────────────────────────
// https://api.core.ac.uk/v3 — requires a free key (CORE_API_KEY).
async function searchCore(query, opts = {}) {
  const limit = clampLimit(opts.limit);
  if (!process.env.CORE_API_KEY) return [];
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const url = `https://api.core.ac.uk/v3/search/works?${params.toString()}`;
  const json = await safeJson(url, {
    headers: { Authorization: `Bearer ${process.env.CORE_API_KEY}` },
    timeoutMs: opts.timeoutMs, signal: opts.signal, label: 'core',
  });
  const items = Array.isArray(json?.results) ? json.results : [];
  return items.map((p) => ({
    source: 'core',
    id: p.id || null,
    doi: p.doi || null,
    title: p.title || '',
    abstract: p.abstract || null,
    authors: (p.authors || []).map((a) => ({ name: a.name })),
    year: p.yearPublished || null,
    venue: p.publisher || null,
    citations: null,
    openAccess: true, // CORE indexes open access only
    pdfUrl: p.downloadUrl || null,
    htmlUrl: p.sourceFulltextUrls?.[0] || null,
  }));
}

// ── DOAJ — Directory of Open Access Journals ────────────────────────────
// https://doaj.org/api/v2 — no key required. Indexes peer-reviewed open-access
// journals from ~130 countries, so it broadens coverage well beyond the
// English-language mainstream (strong Latin-American / African / Asian reach).
async function searchDOAJ(query, opts = {}) {
  const limit = clampLimit(opts.limit);
  const url = `https://doaj.org/api/v2/search/articles/${encodeURIComponent(query)}?pageSize=${limit}`;
  const json = await safeJson(url, { timeoutMs: opts.timeoutMs, signal: opts.signal, label: 'doaj' });
  const items = Array.isArray(json?.results) ? json.results : [];
  return items.map((it) => {
    const b = it.bibjson || {};
    const doi = (b.identifier || []).find((i) => String(i.type).toLowerCase() === 'doi')?.id || null;
    const fulltext = (b.link || []).find((l) => String(l.type).toLowerCase() === 'fulltext')?.url || null;
    return {
      source: 'doaj',
      id: it.id || null,
      doi,
      title: b.title || '',
      abstract: b.abstract || null,
      authors: (b.author || []).map((a) => ({ name: a.name, affiliation: a.affiliation || null })).filter((a) => a.name),
      year: b.year ? parseInt(b.year, 10) || null : null,
      venue: b.journal?.title || null,
      citations: null,
      openAccess: true, // DOAJ indexes open-access content exclusively
      pdfUrl: fulltext,
      htmlUrl: doi ? `https://doi.org/${doi}` : fulltext,
    };
  });
}

// ── DBLP — computer-science bibliography ────────────────────────────────
// https://dblp.org/search/publ/api — no key required. The definitive global
// index for computer-science publications (conferences + journals worldwide).
async function searchDBLP(query, opts = {}) {
  const limit = clampLimit(opts.limit);
  const params = new URLSearchParams({ q: query, format: 'json', h: String(limit) });
  const url = `https://dblp.org/search/publ/api?${params.toString()}`;
  const json = await safeJson(url, { timeoutMs: opts.timeoutMs, signal: opts.signal, label: 'dblp' });
  const hits = json?.result?.hits?.hit;
  const items = Array.isArray(hits) ? hits : (hits ? [hits] : []);
  return items.map((h) => {
    const info = h.info || {};
    // DBLP returns a single author as an object, multiple as an array.
    const rawAuthors = info.authors?.author;
    const authorList = Array.isArray(rawAuthors) ? rawAuthors : (rawAuthors ? [rawAuthors] : []);
    return {
      source: 'dblp',
      id: info.key || h['@id'] || null,
      doi: info.doi || null,
      title: typeof info.title === 'string' ? info.title.replace(/\.$/, '') : '',
      abstract: null, // DBLP is metadata-only (no abstracts)
      authors: authorList.map((a) => ({ name: typeof a === 'string' ? a : a.text })).filter((a) => a.name),
      year: info.year ? parseInt(info.year, 10) || null : null,
      venue: info.venue || null,
      citations: null,
      openAccess: null,
      pdfUrl: null,
      htmlUrl: info.ee || info.url || (info.doi ? `https://doi.org/${info.doi}` : null),
    };
  });
}

// ── DataCite — global research outputs + datasets ───────────────────────
// https://api.datacite.org — no key required. Worldwide DOI registry covering
// datasets, software, preprints and theses that Crossref often misses.
async function searchDataCite(query, opts = {}) {
  const limit = clampLimit(opts.limit);
  const params = new URLSearchParams({ query, 'page[size]': String(limit) });
  const url = `https://api.datacite.org/dois?${params.toString()}`;
  const json = await safeJson(url, { timeoutMs: opts.timeoutMs, signal: opts.signal, label: 'datacite' });
  const items = Array.isArray(json?.data) ? json.data : [];
  return items.map((d) => {
    const a = d.attributes || {};
    const doi = a.doi || d.id || null;
    return {
      source: 'datacite',
      id: d.id || null,
      doi,
      title: Array.isArray(a.titles) && a.titles.length ? a.titles[0].title : '',
      abstract: Array.isArray(a.descriptions) && a.descriptions.length ? a.descriptions[0].description : null,
      authors: (a.creators || []).map((c) => ({
        name: c.name || [c.givenName, c.familyName].filter(Boolean).join(' ') || null,
      })).filter((c) => c.name),
      year: a.publicationYear || null,
      venue: a.publisher || null,
      citations: typeof a.citationCount === 'number' ? a.citationCount : null,
      openAccess: null,
      pdfUrl: null,
      htmlUrl: a.url || (doi ? `https://doi.org/${doi}` : null),
    };
  });
}

// ── Scopus (Elsevier) — requires a key ──────────────────────────────────
// https://api.elsevier.com/content/search/scopus — key-gated on
// SCOPUS_API_KEY (+ optional SCOPUS_INSTTOKEN for institutional customers).
// STANDARD view returns title / first-author / venue / year / doi /
// citations only — no abstract, no PDF. Returns [] when no key is set, so
// the unified search degrades cleanly to the open providers.
async function searchScopus(query, opts = {}) {
  const apiKey = process.env.SCOPUS_API_KEY;
  if (!apiKey) return []; // key-gated soft-skip (no network call)
  const count = Math.min(25, clampLimit(opts.limit)); // conservative cap (STANDARD view permits up to 200, COMPLETE only 25)
  const params = new URLSearchParams({ query, count: String(count), view: 'STANDARD', sort: 'relevancy' });
  const url = `https://api.elsevier.com/content/search/scopus?${params.toString()}`;
  const headers = { 'X-ELS-APIKey': apiKey };
  if (process.env.SCOPUS_INSTTOKEN) headers['X-ELS-Insttoken'] = process.env.SCOPUS_INSTTOKEN;
  const json = await safeJson(url, { headers, timeoutMs: opts.timeoutMs, signal: opts.signal, label: 'scopus' });
  const entries = json?.['search-results']?.entry;
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e) => e && !e.error) // Scopus returns a synthetic { error } entry on zero hits
    .map((e) => {
      const doi = e['prism:doi'] || null;
      const coverDate = typeof e['prism:coverDate'] === 'string' ? e['prism:coverDate'] : '';
      const year = /^\d{4}/.test(coverDate) ? (parseInt(coverDate.slice(0, 4), 10) || null) : null;
      const citesRaw = Number(e['citedby-count']);
      const oa = e.openaccess;
      const idRaw = e['dc:identifier'];
      const scopusId = String((Array.isArray(idRaw) ? idRaw[0] : idRaw) || '').replace(/^SCOPUS_ID:/, '');
      const landing = Array.isArray(e.link) ? (e.link.find((l) => l && l['@ref'] === 'scopus')?.['@href'] || null) : null;
      return {
        source: 'scopus',
        id: scopusId ? `scopus:${scopusId}` : (doi ? `scopus:${doi}` : (e.eid || null)),
        doi,
        title: e['dc:title'] || '',
        abstract: null, // not available in STANDARD view
        authors: e['dc:creator'] ? [{ name: e['dc:creator'] }] : [], // STANDARD view = first author only
        year,
        venue: e['prism:publicationName'] || null,
        citations: Number.isFinite(citesRaw) ? citesRaw : null,
        openAccess: (oa === '1' || oa === 1 || oa === true)
          ? true
          : (oa === '0' || oa === 0 || oa === false) ? false : null,
        pdfUrl: null,
        // prefer the user-facing Scopus record link, then the DOI resolver;
        // never the prism:url API self-link (api.elsevier.com — not openable).
        htmlUrl: landing || (doi ? `https://doi.org/${doi}` : null),
      };
    });
}

// ── Web of Science (Clarivate) — Starter API, requires a key ────────────
// https://api.clarivate.com/apis/wos-starter/v1/documents — key-gated on
// WOS_API_KEY (or CLARIVATE_API_KEY), passed as the X-ApiKey header (no
// "Bearer" prefix). Bibliographic metadata only: no abstract text, no PDF,
// no open-access flag — we surface authorKeywords as a weak snippet.
// Returns [] when no key is configured.
async function searchWebOfScience(query, opts = {}) {
  const apiKey = process.env.WOS_API_KEY || process.env.CLARIVATE_API_KEY;
  if (!apiKey) return []; // key-gated soft-skip (no network call)
  const limit = Math.min(50, clampLimit(opts.limit)); // Starter API caps limit at 50
  // Strip characters that would break the WoS advanced-query parser, then
  // wrap in the TS (Topic) field tag for a free-text title/abstract/keyword search.
  const safeQuery = String(query).replace(/[()"]/g, ' ').replace(/\s+/g, ' ').trim();
  const params = new URLSearchParams({ q: `TS=(${safeQuery})`, db: 'WOS', limit: String(limit), page: '1' });
  const url = `https://api.clarivate.com/apis/wos-starter/v1/documents?${params.toString()}`;
  const json = await safeJson(url, {
    headers: { 'X-ApiKey': apiKey },
    timeoutMs: opts.timeoutMs, signal: opts.signal, label: 'wos',
  });
  const items = Array.isArray(json?.hits) ? json.hits : [];
  return items.map((rec) => {
    const doi = rec.identifiers?.doi || null;
    const wosCite = Array.isArray(rec.citations)
      ? (rec.citations.find((c) => c && c.db === 'WOS') || rec.citations[0])
      : null;
    const authorKeywords = rec.keywords?.authorKeywords;
    const py = rec.source?.publishYear;
    return {
      source: 'wos',
      id: rec.uid || null, // e.g. "WOS:000123456700001"
      doi,
      title: rec.title || '',
      abstract: Array.isArray(authorKeywords) && authorKeywords.length ? authorKeywords.join(', ') : null,
      authors: (rec.names?.authors || []).map((a) => ({ name: a.displayName || a.wosStandard })).filter((a) => a.name),
      year: Number.isFinite(py) ? py : (py ? (parseInt(py, 10) || null) : null),
      venue: rec.source?.sourceTitle || null,
      citations: typeof wosCite?.count === 'number' ? wosCite.count : null,
      openAccess: null, // not exposed by the Starter API
      pdfUrl: null, // not exposed by the Starter API
      htmlUrl: rec.links?.record || (doi ? `https://doi.org/${doi}` : null),
    };
  });
}

const PROVIDER_FUNCS = {
  arxiv: searchArxiv,
  semanticscholar: searchSemanticScholar,
  openalex: searchOpenAlex,
  crossref: searchCrossRef,
  pubmed: searchPubMed,
  europepmc: searchEuropePMC,
  core: searchCore,
  doaj: searchDOAJ,
  dblp: searchDBLP,
  datacite: searchDataCite,
  scielo: searchSciELO,
  scopus: searchScopus,
  wos: searchWebOfScience,
  redalyc: searchRedalyc,
  biorxiv: searchBioRxiv,
  medrxiv: searchMedRxiv,
};

/**
 * Unified search across all (or a chosen subset of) providers.
 *
 * @param {string} query  — free-text search query
 * @param {object} opts
 * @param {string[]} [opts.providers] — subset of PROVIDERS (default all)
 * @param {number}   [opts.limit]     — per-provider max results
 * @param {number}   [opts.timeoutMs] — per-provider timeout
 * @returns {Promise<{ papers, errors, providers }>}
 */
const searchCache = require('./scientific-search-cache');

// A transient failure is worth retrying; a 4xx (bad query, auth, not-found) is
// not. Keep this conservative so we never hammer an API over a permanent error.
function isTransientError(err) {
  const m = String(err?.message || err || '').toLowerCase();
  if (/\b4\d\d\b/.test(m) && !/\b429\b/.test(m)) return false; // 4xx except 429
  return /timed out|timeout|429|too many|\b5\d\d\b|econnreset|enotfound|eai_again|network|fetch failed|socket|abort/.test(m);
}

async function callProviderWithRetry(fn, query, opts, retries) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn(query, opts);
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !isTransientError(err)) break;
      const delay = 150 * (attempt + 1) + Math.floor(Math.random() * 100); // backoff + jitter
      await new Promise((resolve) => { const t = setTimeout(resolve, delay); t.unref?.(); });
    }
  }
  throw lastErr;
}

async function search(query, opts = {}) {
  const cleanQuery = normaliseQuery(query);
  if (!cleanQuery) {
    return { papers: [], errors: [{ provider: 'input', message: 'query is empty' }], providers: [] };
  }
  const cached = searchCache.get(cleanQuery, opts);
  if (cached) return cached;

  const chosen = (Array.isArray(opts.providers) && opts.providers.length)
    ? opts.providers.filter((p) => PROVIDER_FUNCS[p])
    : PROVIDERS.slice();

  const retries = Number.isFinite(opts.retries) && opts.retries >= 0 ? opts.retries : DEFAULT_RETRIES;
  const totalTimeoutMs = Number.isFinite(opts.totalTimeoutMs) && opts.totalTimeoutMs > 0
    ? opts.totalTimeoutMs
    : DEFAULT_TOTAL_TIMEOUT_MS;

  const errors = [];
  const papers = [];
  // Each provider settles independently and collects its results the moment it
  // resolves. A global wall-clock deadline then guarantees the unified search
  // returns whatever has arrived rather than blocking on the slowest provider
  // (or one whose per-provider timeout was overridden upward). Late arrivals are
  // harmless — their sockets were started with AbortControllers and get cleaned
  // up — they simply don't make it into this turn's ranked list.
  const collect = (entry) => {
    if ('reason' in entry) {
      errors.push({ provider: entry.p, message: entry.reason?.message || String(entry.reason) });
      return;
    }
    // A provider must resolve to an array of canonical Paper objects. If a
    // malformed/HTML/non-JSON body slips past a mapper's guards and the
    // provider resolves to a non-array (string, object, null, …), DON'T let
    // `for…of` throw here — that throw would be re-routed into `.catch(collect)`
    // and silently swallowed, making the provider vanish from BOTH `papers` and
    // `errors`. Treat it as a captured per-provider error so the other
    // providers still aggregate + dedupe and the caller can see what failed.
    if (!Array.isArray(entry.value)) {
      errors.push({ provider: entry.p, message: `provider returned a non-array result (${entry.value === null ? 'null' : typeof entry.value})` });
      return;
    }
    for (const paper of entry.value) {
      // Skip non-object entries defensively so one malformed item never breaks
      // the loop (and thus the whole provider's contribution).
      if (paper && typeof paper === 'object') papers.push(paper);
    }
  };
  const perProvider = chosen.map((p) =>
    callProviderWithRetry(PROVIDER_FUNCS[p], cleanQuery, opts, retries)
      .then((value) => collect({ p, value }))
      .catch((reason) => collect({ p, reason }))
  );

  await Promise.race([
    Promise.allSettled(perProvider),
    new Promise((resolve) => { const t = setTimeout(resolve, totalTimeoutMs); t.unref?.(); }),
  ]);

  const deduped = dedupeByDoi(papers);
  const ranked = rankPapers(deduped, cleanQuery);
  // Interleave sources so the top of the list reflects "diverse sources" rather
  // than whichever provider returned the most precise title matches. Opt out
  // with `diversify: false` to get the pure relevance order.
  const papersOut = opts.diversify === false
    ? ranked
    : diversifyBySource(ranked, { maxRun: opts.maxRun });
  const result = { papers: papersOut, errors, providers: chosen };
  searchCache.set(cleanQuery, opts, result);
  return result;
}

module.exports = {
  search,
  searchArxiv,
  searchSemanticScholar,
  searchOpenAlex,
  searchCrossRef,
  searchPubMed,
  searchEuropePMC,
  searchCore,
  searchDOAJ,
  searchDBLP,
  searchDataCite,
  searchSciELO,
  searchScopus,
  searchWebOfScience,
  searchRedalyc,
  searchBioRxiv,
  searchMedRxiv,
  diversifyBySource,
  PROVIDERS,
  _internal: {
    dedupeByDoi, normaliseTitle, normaliseDoi, parseAtomFeed, invertedIndexToText,
    rankPapers, userAgent, normaliseQuery, queryTerms, relevanceScore, mergePaper,
    isTransientError, diversifyBySource,
  },
};

'use strict';

/**
 * scientific-search.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Unified search over the major OPEN scientific-paper APIs. Five of the six
 * sources work with NO API key (arXiv, Semantic Scholar, OpenAlex, CrossRef,
 * PubMed E-utilities, Europe PMC); CORE optionally takes a free key for higher
 * rate limits.
 *
 * Each provider exposes a `search(query, opts)` function that returns an
 * array of canonical Paper objects:
 *
 *   {
 *     source: 'arxiv' | 'openalex' | 'semanticscholar' | 'crossref' | 'pubmed' | 'europepmc' | 'core',
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

const PROVIDERS = ['arxiv', 'openalex', 'semanticscholar', 'crossref', 'pubmed', 'europepmc', 'core'];

function userAgent() {
  const email = process.env.SIRAGPT_RESEARCH_EMAIL || '';
  if (email) return `${USER_AGENT_PREFIX} (mailto:${email})`;
  return USER_AGENT_PREFIX;
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label || 'request'} timed out after ${ms}ms`));
    }, ms);
    timer.unref?.();
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function safeJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'User-Agent': userAgent(),
      Accept: 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  }
  return res.json();
}

async function safeText(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'User-Agent': userAgent(),
      ...(opts.headers || {}),
    },
  });
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

function dedupeByDoi(papers) {
  const seen = new Map();
  for (const p of papers) {
    const doi = normaliseDoi(p.doi);
    const key = doi || `t:${normaliseTitle(p.title)}`;
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, p);
      continue;
    }
    // Merge: prefer the entry with more metadata
    const score = (x) =>
      (x.abstract ? 2 : 0) +
      (x.openAccess ? 2 : 0) +
      (x.citations != null ? 1 : 0) +
      (x.pdfUrl ? 1 : 0);
    if (score(p) > score(prev)) seen.set(key, p);
  }
  return Array.from(seen.values());
}

function rankPapers(papers) {
  return papers.slice().sort((a, b) => {
    if ((b.openAccess ? 1 : 0) !== (a.openAccess ? 1 : 0)) {
      return (b.openAccess ? 1 : 0) - (a.openAccess ? 1 : 0);
    }
    const ca = a.citations || 0;
    const cb = b.citations || 0;
    if (ca !== cb) return cb - ca;
    const ya = a.year || 0;
    const yb = b.year || 0;
    if (ya !== yb) return yb - ya;
    return (a.title || '').length - (b.title || '').length;
  });
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
  const xml = await withTimeout(safeText(url), opts.timeoutMs || DEFAULT_TIMEOUT_MS, 'arxiv');
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
  const json = await withTimeout(safeJson(url, { headers }), opts.timeoutMs || DEFAULT_TIMEOUT_MS, 'semanticscholar');
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
async function searchOpenAlex(query, opts = {}) {
  const limit = clampLimit(opts.limit);
  const params = new URLSearchParams({
    search: query,
    per_page: String(limit),
  });
  if (process.env.SIRAGPT_RESEARCH_EMAIL) params.set('mailto', process.env.SIRAGPT_RESEARCH_EMAIL);
  const url = `https://api.openalex.org/works?${params.toString()}`;
  const json = await withTimeout(safeJson(url), opts.timeoutMs || DEFAULT_TIMEOUT_MS, 'openalex');
  const items = Array.isArray(json.results) ? json.results : [];
  return items.map((w) => ({
    source: 'openalex',
    id: w.id?.replace(/^https?:\/\/openalex\.org\//, '') || null,
    doi: w.doi?.replace(/^https?:\/\/doi\.org\//, '') || null,
    title: w.title || w.display_name || '',
    abstract: w.abstract_inverted_index ? invertedIndexToText(w.abstract_inverted_index) : null,
    authors: (w.authorships || []).map((a) => ({
      name: a.author?.display_name || null,
      affiliation: a.institutions?.[0]?.display_name || null,
    })).filter((a) => a.name),
    year: w.publication_year || null,
    venue: w.host_venue?.display_name || w.primary_location?.source?.display_name || null,
    citations: typeof w.cited_by_count === 'number' ? w.cited_by_count : null,
    openAccess: !!w.open_access?.is_oa,
    pdfUrl: w.open_access?.oa_url || w.primary_location?.pdf_url || null,
    htmlUrl: w.id || (w.doi ? `https://doi.org/${w.doi.replace(/^https?:\/\/doi\.org\//, '')}` : null),
  }));
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
async function searchCrossRef(query, opts = {}) {
  const limit = clampLimit(opts.limit);
  const params = new URLSearchParams({ query, rows: String(limit) });
  if (process.env.SIRAGPT_RESEARCH_EMAIL) params.set('mailto', process.env.SIRAGPT_RESEARCH_EMAIL);
  const url = `https://api.crossref.org/works?${params.toString()}`;
  const json = await withTimeout(safeJson(url), opts.timeoutMs || DEFAULT_TIMEOUT_MS, 'crossref');
  const items = Array.isArray(json.message?.items) ? json.message.items : [];
  return items.map((w) => ({
    source: 'crossref',
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
    openAccess: null, // CrossRef doesn't reliably know
    pdfUrl: null,
    htmlUrl: w.URL || (w.DOI ? `https://doi.org/${w.DOI}` : null),
  }));
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
  const searchJson = await withTimeout(safeJson(searchUrl), opts.timeoutMs || DEFAULT_TIMEOUT_MS, 'pubmed:esearch');
  const ids = searchJson?.esearchresult?.idlist || [];
  if (ids.length === 0) return [];
  // Step 2: esummary → metadata for those IDs
  const sumParams = new URLSearchParams({
    db: 'pubmed', id: ids.join(','), retmode: 'json',
  });
  if (process.env.NCBI_API_KEY) sumParams.set('api_key', process.env.NCBI_API_KEY);
  const sumUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${sumParams.toString()}`;
  const sumJson = await withTimeout(safeJson(sumUrl), opts.timeoutMs || DEFAULT_TIMEOUT_MS, 'pubmed:esummary');
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
  const json = await withTimeout(safeJson(url), opts.timeoutMs || DEFAULT_TIMEOUT_MS, 'europepmc');
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
  const json = await withTimeout(safeJson(url, {
    headers: { Authorization: `Bearer ${process.env.CORE_API_KEY}` },
  }), opts.timeoutMs || DEFAULT_TIMEOUT_MS, 'core');
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

const PROVIDER_FUNCS = {
  arxiv: searchArxiv,
  semanticscholar: searchSemanticScholar,
  openalex: searchOpenAlex,
  crossref: searchCrossRef,
  pubmed: searchPubMed,
  europepmc: searchEuropePMC,
  core: searchCore,
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

async function search(query, opts = {}) {
  if (typeof query !== 'string' || !query.trim()) {
    return { papers: [], errors: [{ provider: 'input', message: 'query is empty' }], providers: [] };
  }
  const cached = searchCache.get(query, opts);
  if (cached) return cached;

  const chosen = (Array.isArray(opts.providers) && opts.providers.length)
    ? opts.providers.filter((p) => PROVIDER_FUNCS[p])
    : PROVIDERS.slice();
  const results = await Promise.allSettled(
    chosen.map((p) => PROVIDER_FUNCS[p](query, opts))
  );
  const errors = [];
  const papers = [];
  results.forEach((r, idx) => {
    const provider = chosen[idx];
    if (r.status === 'fulfilled') {
      for (const p of r.value || []) papers.push(p);
    } else {
      errors.push({ provider, message: r.reason?.message || String(r.reason) });
    }
  });
  const deduped = dedupeByDoi(papers);
  const ranked = rankPapers(deduped);
  const result = { papers: ranked, errors, providers: chosen };
  searchCache.set(query, opts, result);
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
  PROVIDERS,
  _internal: { dedupeByDoi, normaliseTitle, normaliseDoi, parseAtomFeed, invertedIndexToText, rankPapers, userAgent },
};

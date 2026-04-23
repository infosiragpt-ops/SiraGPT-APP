/**
 * providers — 5 free academic-search providers.
 *
 * Each exported function has the same contract:
 *   async (query, opts) → NormalisedResult[]
 *
 * where opts = { maxResults, timeoutMs, mailto }.
 *
 * All providers:
 *   - Fail soft: return [] on any HTTP / parse error.
 *   - Use a single in-process AbortController for per-call timeout.
 *   - Send an honest User-Agent so providers can contact us if we
 *     ever misbehave.
 *   - Never throw — the orchestrator's Promise.allSettled would
 *     survive, but the provider should not poison the whole call.
 *
 * Policies:
 *   - OpenAlex "polite pool" via `?mailto=` when provided.
 *   - CrossRef polite pool via User-Agent `mailto=`.
 *   - Semantic Scholar tolerates no key (100 req / 5min / IP).
 *   - PubMed E-utilities with 3 req/s budget.
 *   - DOAJ public.
 */

const { USER_AGENT } = require("./types");

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_RESULTS = 20;

// ─── Shared helpers ───────────────────────────────────────────────────────

async function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS, mailto, extraHeaders = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const ua = mailto ? `${USER_AGENT} (mailto:${mailto})` : USER_AGENT;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": ua, Accept: "application/json", ...extraHeaders },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function safeInt(n) {
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) ? v : undefined;
}

function normaliseAuthors(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((a) => {
      if (!a) return null;
      if (typeof a === "string") return a.trim();
      if (typeof a.name === "string") return a.name.trim();
      if (typeof a.display_name === "string") return a.display_name.trim();
      if (typeof a.family === "string") {
        const given = a.given ? ` ${a.given}` : "";
        return `${a.family}${given}`.trim();
      }
      return null;
    })
    .filter(Boolean);
}

// ─── OpenAlex ────────────────────────────────────────────────────────────
// https://docs.openalex.org/how-to-use-the-api/rate-limits-and-authentication

/**
 * Reconstruct a plain abstract from OpenAlex's `abstract_inverted_index`
 * (an object mapping each word to the list of positions where it appears).
 */
function reconstructAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== "object") return undefined;
  const positions = [];
  for (const [word, idxs] of Object.entries(invertedIndex)) {
    if (!Array.isArray(idxs)) continue;
    for (const i of idxs) positions[i] = word;
  }
  if (positions.length === 0) return undefined;
  return positions.filter(Boolean).join(" ");
}

async function searchOpenAlex(query, opts = {}) {
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
  // Auth / polite-pool resolution, in priority order:
  //   1. opts.apiKey / opts.mailto — caller explicit override (per-user
  //      settings, ad-hoc requests).
  //   2. OPENALEX_API_KEY — premium plan token set by ops in .env.
  //   3. OPENALEX_MAILTO — polite-pool email (also in .env). OpenAlex's
  //      free tier is unauthenticated but rewards callers that identify
  //      themselves with a mailto by routing them to a faster pool.
  const apiKey = opts.apiKey || process.env.OPENALEX_API_KEY;
  const mailto = opts.mailto || process.env.OPENALEX_MAILTO;
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", query);
  url.searchParams.set("per-page", String(Math.min(25, maxResults)));
  if (apiKey) url.searchParams.set("api_key", apiKey);
  if (mailto) url.searchParams.set("mailto", mailto);
  const body = await fetchJson(url.toString(), { timeoutMs: opts.timeoutMs, mailto });
  if (!body || !Array.isArray(body.results)) return [];
  return body.results.slice(0, maxResults).map((w, i) => {
    const doi = typeof w.doi === "string" ? w.doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "") : undefined;
    return {
      source: "openalex",
      title: w.title ?? w.display_name ?? "Untitled",
      authors: normaliseAuthors(Array.isArray(w.authorships) ? w.authorships.map((a) => a.author) : []),
      year: safeInt(w.publication_year),
      journal: w.host_venue?.display_name || w.primary_location?.source?.display_name,
      doi,
      url: w.id || (doi ? `https://doi.org/${doi}` : ""),
      pdfUrl: w.open_access?.oa_url || w.primary_location?.pdf_url || undefined,
      abstract: reconstructAbstract(w.abstract_inverted_index),
      citationCount: safeInt(w.cited_by_count),
      language: typeof w.language === "string" ? w.language : undefined,
      openAccess: Boolean(w.open_access?.is_oa),
      providerRank: i,
      raw: w,
    };
  });
}

// ─── Semantic Scholar ────────────────────────────────────────────────────
// https://api.semanticscholar.org/api-docs/graph

async function searchSemanticScholar(query, opts = {}) {
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
  const fields = "title,abstract,authors,year,citationCount,openAccessPdf,externalIds,journal,publicationTypes,url";
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${Math.min(100, maxResults)}&fields=${encodeURIComponent(fields)}`;
  const body = await fetchJson(url, { timeoutMs: opts.timeoutMs });
  if (!body || !Array.isArray(body.data)) return [];
  return body.data.slice(0, maxResults).map((p, i) => {
    const doi = p.externalIds?.DOI || undefined;
    return {
      source: "semantic",
      title: p.title ?? "Untitled",
      authors: normaliseAuthors(p.authors),
      year: safeInt(p.year),
      journal: p.journal?.name,
      doi,
      url: p.url || (doi ? `https://doi.org/${doi}` : ""),
      pdfUrl: p.openAccessPdf?.url || undefined,
      abstract: p.abstract || undefined,
      citationCount: safeInt(p.citationCount),
      openAccess: Boolean(p.openAccessPdf),
      providerRank: i,
      raw: p,
    };
  });
}

// ─── CrossRef ────────────────────────────────────────────────────────────
// https://api.crossref.org/swagger-ui/

async function searchCrossRef(query, opts = {}) {
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
  const mailto = opts.mailto;
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${Math.min(200, maxResults)}`;
  const body = await fetchJson(url, { timeoutMs: opts.timeoutMs, mailto });
  if (!body || !body.message || !Array.isArray(body.message.items)) return [];
  return body.message.items.slice(0, maxResults).map((w, i) => {
    const doi = w.DOI;
    const title = Array.isArray(w.title) && w.title.length > 0 ? w.title[0] : "Untitled";
    const journal = Array.isArray(w["container-title"]) ? w["container-title"][0] : undefined;
    const yearPart = w.issued?.["date-parts"]?.[0]?.[0];
    return {
      source: "crossref",
      title,
      authors: normaliseAuthors(w.author),
      year: safeInt(yearPart),
      journal,
      doi,
      url: w.URL || (doi ? `https://doi.org/${doi}` : ""),
      abstract: typeof w.abstract === "string" ? w.abstract.replace(/<[^>]+>/g, "").trim() : undefined,
      citationCount: safeInt(w["is-referenced-by-count"]),
      openAccess: Array.isArray(w.license) && w.license.length > 0,
      providerRank: i,
      raw: w,
    };
  });
}

// ─── PubMed E-utilities ──────────────────────────────────────────────────
// https://www.ncbi.nlm.nih.gov/books/NBK25499/

async function searchPubMed(query, opts = {}) {
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Step 1: esearch → PMIDs.
  const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${Math.min(50, maxResults)}&retmode=json`;
  const searchBody = await fetchJson(searchUrl, { timeoutMs });
  const ids = searchBody?.esearchresult?.idlist;
  if (!Array.isArray(ids) || ids.length === 0) return [];
  // Step 2: esummary → metadata.
  const sumUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(",")}&retmode=json`;
  const sumBody = await fetchJson(sumUrl, { timeoutMs });
  const result = sumBody?.result;
  if (!result || typeof result !== "object") return [];
  return ids.slice(0, maxResults).map((id, i) => {
    const row = result[id];
    if (!row || typeof row !== "object") return null;
    const doi = Array.isArray(row.articleids)
      ? row.articleids.find((a) => a.idtype === "doi")?.value
      : undefined;
    const pubdate = typeof row.pubdate === "string" ? row.pubdate : "";
    const yearMatch = pubdate.match(/\d{4}/);
    return {
      source: "pubmed",
      title: row.title || "Untitled",
      authors: Array.isArray(row.authors) ? normaliseAuthors(row.authors) : [],
      year: yearMatch ? Number(yearMatch[0]) : undefined,
      journal: row.fulljournalname || row.source,
      doi,
      url: doi ? `https://doi.org/${doi}` : `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      citationCount: undefined,
      openAccess: row.availablefromurl ? Boolean(row.availablefromurl) : false,
      providerRank: i,
      raw: row,
    };
  }).filter(Boolean);
}

// ─── DOAJ ────────────────────────────────────────────────────────────────
// https://doaj.org/api/docs

async function searchDOAJ(query, opts = {}) {
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
  const url = `https://doaj.org/api/search/articles/${encodeURIComponent(query)}?page=1&pageSize=${Math.min(100, maxResults)}`;
  const body = await fetchJson(url, { timeoutMs: opts.timeoutMs });
  if (!body || !Array.isArray(body.results)) return [];
  return body.results.slice(0, maxResults).map((row, i) => {
    const b = row.bibjson || {};
    const authors = Array.isArray(b.author) ? b.author.map((a) => a.name).filter(Boolean) : [];
    const links = Array.isArray(b.link) ? b.link : [];
    const fullUrl = links.find((l) => l.type === "fulltext")?.url;
    const doiId = Array.isArray(b.identifier) ? b.identifier.find((idf) => idf.type === "doi")?.id : undefined;
    return {
      source: "doaj",
      title: b.title || "Untitled",
      authors,
      year: safeInt(b.year),
      journal: b.journal?.title,
      doi: doiId,
      url: fullUrl || (doiId ? `https://doi.org/${doiId}` : `https://doaj.org/article/${row.id}`),
      pdfUrl: links.find((l) => /pdf/i.test(l.type || ""))?.url,
      abstract: b.abstract,
      openAccess: true, // DOAJ is exclusively OA
      providerRank: i,
      raw: row,
    };
  });
}

// ─── Registry + dispatcher ───────────────────────────────────────────────

const REGISTRY = {
  openalex: searchOpenAlex,
  semantic: searchSemanticScholar,
  crossref: searchCrossRef,
  pubmed: searchPubMed,
  doaj: searchDOAJ,
};

/**
 * Run one (source, query) retrieval. Safe to call concurrently via
 * Promise.allSettled in the orchestrator.
 */
async function retrieveFromProvider({ source, query, maxResults, timeoutMs, mailto }) {
  const fn = REGISTRY[source];
  if (!fn) return [];
  try {
    const out = await fn(query, { maxResults, timeoutMs, mailto });
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}

module.exports = {
  retrieveFromProvider,
  searchOpenAlex,
  searchSemanticScholar,
  searchCrossRef,
  searchPubMed,
  searchDOAJ,
  reconstructAbstract,
  normaliseAuthors,
  REGISTRY,
};

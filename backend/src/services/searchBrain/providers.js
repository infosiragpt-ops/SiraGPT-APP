/**
 * providers — academic-search providers with optional server-side API keys.
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
 *   - OpenAlex API key via `api_key`, with `mailto` as a contact hint.
 *   - CrossRef polite pool via User-Agent `mailto=`.
 *   - Semantic Scholar optional `x-api-key` header for higher support/limits.
 *   - PubMed E-utilities optional `api_key`, plus `tool` and `email`.
 *   - DOAJ public article search; publisher keys are only needed for private CRUD/bulk routes.
 *   - Web of Science Expanded API via `X-ApiKey` header, gated by Clarivate entitlement.
 */

const { USER_AGENT } = require("./types");
const { sanitizeHeaders } = require("../../utils/async-guard");
const scientificSearch = require("../scientific-search");

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_RESULTS = 20;

function firstEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

// ─── Shared helpers ───────────────────────────────────────────────────────

async function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS, mailto, extraHeaders = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const ua = mailto ? `${USER_AGENT} (mailto:${mailto})` : USER_AGENT;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: sanitizeHeaders({ "User-Agent": ua, Accept: "application/json", ...extraHeaders }),
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

function textValue(v) {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

function pageRange(first, last) {
  const a = textValue(first);
  const b = textValue(last);
  if (a && b && a !== b) return `${a}-${b}`;
  return a || b;
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

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function objectText(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (!value || typeof value !== "object") return undefined;
  return textValue(value.content)
    || textValue(value.value)
    || textValue(value._)
    || textValue(value["#text"])
    || textValue(value.text);
}

function deepFindByKey(root, predicate) {
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    for (const [key, value] of Object.entries(node)) {
      if (predicate(key, value, node)) return value;
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return undefined;
}

function findIdentifier(root, wantedType) {
  const wanted = String(wantedType || "").toLowerCase();
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    const type = String(node.type || node["@type"] || node.id_type || node.identifier_type || "").toLowerCase();
    const value = objectText(node.value) || objectText(node.content) || objectText(node.id) || objectText(node.uid);
    if (type === wanted && value) return value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return undefined;
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
  const perPage = Math.min(25, maxResults);
  const offset = typeof opts.offset === "number" && opts.offset >= 0 ? opts.offset : 0;
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
  url.searchParams.set("per-page", String(perPage));
  url.searchParams.set("page", String(Math.floor(offset / perPage) + 1));
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
      volume: textValue(w.biblio?.volume),
      issue: textValue(w.biblio?.issue),
      pages: pageRange(w.biblio?.first_page, w.biblio?.last_page),
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
  const offset = typeof opts.offset === "number" && opts.offset >= 0 ? opts.offset : 0;
  const apiKey = opts.apiKey || firstEnv("SEMANTIC_SCHOLAR_API_KEY", "SEMANTIC_API_KEY", "S2_API_KEY");
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${Math.min(100, maxResults)}&offset=${offset}&fields=${encodeURIComponent(fields)}`;
  const body = await fetchJson(url, {
    timeoutMs: opts.timeoutMs,
    extraHeaders: apiKey ? { "x-api-key": apiKey } : undefined,
  });
  if (!body || !Array.isArray(body.data)) return [];
  return body.data.slice(0, maxResults).map((p, i) => {
    const doi = p.externalIds?.DOI || undefined;
    return {
      source: "semantic",
      title: p.title ?? "Untitled",
      authors: normaliseAuthors(p.authors),
      year: safeInt(p.year),
      journal: p.journal?.name,
      volume: textValue(p.journal?.volume),
      pages: textValue(p.journal?.pages),
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
  const offset = typeof opts.offset === "number" && opts.offset >= 0 ? opts.offset : 0;
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${Math.min(200, maxResults)}&offset=${offset}`;
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
      volume: textValue(w.volume),
      issue: textValue(w.issue),
      pages: textValue(w.page),
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
  const offset = typeof opts.offset === "number" && opts.offset >= 0 ? opts.offset : 0;
  const apiKey = opts.apiKey || firstEnv("NCBI_API_KEY", "PUBMED_API_KEY");
  const tool = opts.tool || firstEnv("NCBI_TOOL", "PUBMED_TOOL") || "siraGPT";
  const email = opts.email || opts.mailto || firstEnv("NCBI_EMAIL", "PUBMED_EMAIL", "SEARCH_BRAIN_MAILTO", "OPENALEX_MAILTO");
  // Step 1: esearch → PMIDs.
  const searchUrl = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi");
  searchUrl.searchParams.set("db", "pubmed");
  searchUrl.searchParams.set("term", query);
  searchUrl.searchParams.set("retmax", String(Math.min(50, maxResults)));
  searchUrl.searchParams.set("retstart", String(offset));
  searchUrl.searchParams.set("retmode", "json");
  if (apiKey) searchUrl.searchParams.set("api_key", apiKey);
  if (tool) searchUrl.searchParams.set("tool", tool);
  if (email) searchUrl.searchParams.set("email", email);
  const searchBody = await fetchJson(searchUrl.toString(), { timeoutMs, mailto: email });
  const ids = searchBody?.esearchresult?.idlist;
  if (!Array.isArray(ids) || ids.length === 0) return [];
  // Step 2: esummary → metadata.
  const sumUrl = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi");
  sumUrl.searchParams.set("db", "pubmed");
  sumUrl.searchParams.set("id", ids.join(","));
  sumUrl.searchParams.set("retmode", "json");
  if (apiKey) sumUrl.searchParams.set("api_key", apiKey);
  if (tool) sumUrl.searchParams.set("tool", tool);
  if (email) sumUrl.searchParams.set("email", email);
  const sumBody = await fetchJson(sumUrl.toString(), { timeoutMs, mailto: email });
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
      volume: textValue(row.volume),
      issue: textValue(row.issue),
      pages: textValue(row.pages),
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
  const pageSize = Math.min(100, maxResults);
  const offset = typeof opts.offset === "number" && opts.offset >= 0 ? opts.offset : 0;
  const page = Math.floor(offset / pageSize) + 1;
  const url = `https://doaj.org/api/search/articles/${encodeURIComponent(query)}?page=${page}&pageSize=${pageSize}`;
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
      volume: textValue(b.journal?.volume),
      issue: textValue(b.journal?.number || b.journal?.issue),
      pages: pageRange(b.start_page, b.end_page) || textValue(b.pages),
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

// ─── Web of Science (Clarivate) ──────────────────────────────────────────
// https://developer.clarivate.com/apis/wos
//
// Requires Web of Science Expanded API entitlement. The official
// Expanded API search endpoint accepts:
//   GET /api/wos?databaseId=WOS&usrQuery=TS=(... )&count=N&firstRecord=1
// with header:
//   X-ApiKey: <WOS_API_KEY>
//
// `WOS_BASE_URL` is configurable because Clarivate examples use both
// `https://wos-api.clarivate.com/api/wos` and
// `https://api.clarivate.com/api/wos` depending on plan/gateway.

function buildWosUsrQuery(query) {
  const q = String(query || "").replace(/\s+/g, " ").trim();
  if (!q) return "";
  if (/\b[A-Z]{2,4}\s*=\s*/i.test(q)) return q;
  const safe = q.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  return `TS=(${safe})`;
}

function wosRecordTitle(rec, type) {
  const titles = asArray(rec?.static_data?.summary?.titles?.title);
  const wanted = String(type || "").toLowerCase();
  const hit = titles.find((t) => String(t?.type || t?.["@type"] || "").toLowerCase() === wanted);
  return objectText(hit) || undefined;
}

function wosRecordAuthors(rec) {
  const names = asArray(rec?.static_data?.summary?.names?.name);
  const authors = names
    .filter((n) => {
      const role = String(n?.role || n?.["@role"] || "").toLowerCase();
      return !role || role === "author" || role === "bookauthor";
    })
    .map((n) => objectText(n?.display_name) || objectText(n?.full_name) || objectText(n?.wos_standard) || objectText(n))
    .filter(Boolean);
  return normaliseAuthors(authors);
}

function wosRecordCitationCount(rec) {
  const tc = rec?.dynamic_data?.citation_related?.tc_list?.silo_tc;
  const counts = asArray(tc)
    .map((x) => safeInt(x?.local_count ?? x?.count ?? x?.tc))
    .filter((n) => typeof n === "number");
  if (counts.length > 0) return Math.max(...counts);
  return safeInt(deepFindByKey(rec, (key) => /times.?cited|citation.?count|local_count/i.test(key)));
}

function normaliseWosRecords(body, { start = 0 } = {}) {
  const records = asArray(body?.Data?.Records?.records?.REC)
    .concat(asArray(body?.data?.records))
    .concat(asArray(body?.records))
    .filter(Boolean);

  return records.map((rec, i) => {
    const uid = objectText(rec?.UID) || objectText(rec?.uid) || objectText(rec?.UT) || objectText(rec?.ut);
    const pubInfo = rec?.static_data?.summary?.pub_info || {};
    const doi = findIdentifier(rec, "doi");
    const title = wosRecordTitle(rec, "item")
      || wosRecordTitle(rec, "title")
      || objectText(rec?.title)
      || "Untitled";
    const journal = wosRecordTitle(rec, "source") || objectText(rec?.journal);
    const year = safeInt(pubInfo.pubyear || pubInfo.pub_year || rec?.year);
    const webOfScienceUrl = uid ? `https://www.webofscience.com/wos/woscc/full-record/${encodeURIComponent(uid)}` : "";

    return {
      source: "wos",
      title,
      authors: wosRecordAuthors(rec),
      year,
      journal,
      volume: textValue(pubInfo.vol || pubInfo.volume),
      issue: textValue(pubInfo.issue),
      pages: pageRange(pubInfo.begin, pubInfo.end) || textValue(pubInfo.page || pubInfo.page_range),
      doi,
      url: doi ? `https://doi.org/${doi}` : webOfScienceUrl,
      abstract: objectText(deepFindByKey(rec, (key) => /^abstract_text$|^abstract$/i.test(key))),
      citationCount: wosRecordCitationCount(rec),
      openAccess: Boolean(deepFindByKey(rec, (key, value) => /open.?access|oa_status/i.test(key) && Boolean(value))),
      providerRank: i + start,
      raw: rec,
    };
  });
}

async function searchWebOfScience(query, opts = {}) {
  const apiKey = opts.apiKey || firstEnv("WOS_API_KEY", "WEB_OF_SCIENCE_API_KEY");
  if (!apiKey || /^https?:\/\//i.test(apiKey)) return [];

  const count = Math.min(100, Math.max(1, opts.maxResults ?? DEFAULT_MAX_RESULTS));
  const start = typeof opts.offset === "number" && opts.offset >= 0 ? opts.offset : 0;
  const firstRecord = start + 1; // WoS uses 1-based pagination.
  const baseUrl = opts.baseUrl || firstEnv("WOS_BASE_URL", "WEB_OF_SCIENCE_BASE_URL") || "https://wos-api.clarivate.com/api/wos";
  const url = new URL(baseUrl);
  url.searchParams.set("databaseId", opts.databaseId || process.env.WOS_DATABASE_ID || "WOS");
  url.searchParams.set("usrQuery", buildWosUsrQuery(query));
  url.searchParams.set("count", String(count));
  url.searchParams.set("firstRecord", String(firstRecord));
  url.searchParams.set("optionView", opts.optionView || process.env.WOS_OPTION_VIEW || "SR");

  const body = await fetchJson(url.toString(), {
    timeoutMs: opts.timeoutMs,
    extraHeaders: { "X-ApiKey": apiKey },
  });
  if (!body) return [];
  return normaliseWosRecords(body, { start }).slice(0, count);
}

// ─── SciELO ──────────────────────────────────────────────────────────────
// SciELO doesn't expose a public free-text API. Crossref's `member:530`
// filter returns SciELO-published articles only (FapUNIFESP/SciELO),
// which is the canonical way to free-text-search SciELO without
// scraping search.scielo.org.

async function searchSciELO(query, opts = {}) {
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
  const offset = typeof opts.offset === "number" ? opts.offset : 0;
  const filters = ["member:530"];
  if (typeof opts.language === "string" && /^[a-z]{2}$/i.test(opts.language)) {
    filters.push(`language:${opts.language.toLowerCase()}`);
  }
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query", query);
  url.searchParams.set("rows", String(Math.min(50, maxResults)));
  url.searchParams.set("filter", filters.join(","));
  // Crossref's works/?query route doesn't expose `language` in `select`
  // — keep the field off the projection or the API returns 400.
  url.searchParams.set("select", [
    "DOI", "title", "author", "published-print", "published-online",
    "container-title", "abstract", "URL", "type",
    "volume", "issue", "page",
    "is-referenced-by-count", "issued", "created",
  ].join(","));
  if (offset > 0) url.searchParams.set("offset", String(offset));
  if (opts.mailto) url.searchParams.set("mailto", opts.mailto);

  const body = await fetchJson(url.toString(), { timeoutMs: opts.timeoutMs, mailto: opts.mailto });
  const items = body?.message?.items;
  if (!Array.isArray(items)) return [];

  return items.slice(0, maxResults).map((it, i) => {
    const doi = typeof it.DOI === "string" ? it.DOI : undefined;
    const title = Array.isArray(it.title) ? it.title[0] : (it.title || "Untitled");
    const venue = Array.isArray(it["container-title"]) ? it["container-title"][0] : it["container-title"];
    const year = it["published-print"]?.["date-parts"]?.[0]?.[0]
              || it["published-online"]?.["date-parts"]?.[0]?.[0]
              || it.created?.["date-parts"]?.[0]?.[0];
    const abstract = typeof it.abstract === "string"
      ? it.abstract.replace(/<[^>]+>/g, "").trim()
      : undefined;
    return {
      source: "scielo",
      title,
      authors: normaliseAuthors(it.author),
      year: safeInt(year),
      journal: venue,
      volume: textValue(it.volume),
      issue: textValue(it.issue),
      pages: textValue(it.page),
      doi,
      url: doi ? `https://doi.org/${doi}` : (it.URL || ""),
      abstract,
      citationCount: safeInt(it["is-referenced-by-count"]),
      openAccess: true,
      providerRank: i + offset,
      raw: it,
    };
  });
}

// ─── Scopus (Elsevier) ───────────────────────────────────────────────────
// https://dev.elsevier.com/api_docs.html
//
// Requires a valid SCOPUS_API_KEY (plus optional SCOPUS_INSTTOKEN) in
// the environment. Without a key we soft-skip — the rest of the
// agentic pool still runs.

async function searchScopus(query, opts = {}) {
  const apiKey = opts.apiKey || process.env.SCOPUS_API_KEY;
  if (!apiKey) return [];
  const insttoken = opts.insttoken || process.env.SCOPUS_INSTTOKEN;
  const authtoken = opts.authtoken || process.env.SCOPUS_AUTHTOKEN;
  const count = Math.min(200, Math.max(1, opts.maxResults ?? DEFAULT_MAX_RESULTS));
  const start = typeof opts.offset === "number" && opts.offset >= 0 ? opts.offset : 0;

  const url = new URL("https://api.elsevier.com/content/search/scopus");
  url.searchParams.set("query", query);
  url.searchParams.set("count", String(count));
  if (start > 0) url.searchParams.set("start", String(start));
  url.searchParams.set("view", "STANDARD");
  url.searchParams.set("sort", "relevancy");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  let body;
  try {
    const headers = {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      "X-ELS-APIKey": apiKey,
    };
    if (insttoken) headers["X-ELS-Insttoken"] = insttoken;
    if (authtoken) headers["X-ELS-Authtoken"] = authtoken;
    const res = await fetch(url.toString(), { signal: controller.signal, headers });
    if (!res.ok) return [];
    body = await res.json();
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }

  const entries = body?.["search-results"]?.entry;
  if (!Array.isArray(entries)) return [];

  return entries.map((entry, i) => {
    const doi = entry?.["prism:doi"];
    const year = typeof entry?.["prism:coverDate"] === "string"
      ? Number(entry["prism:coverDate"].slice(0, 4))
      : undefined;
    const authors = Array.isArray(entry?.author)
      ? entry.author.slice(0, 8).map(a => a?.authname || a?.["ce:indexed-name"]).filter(Boolean)
      : (entry?.["dc:creator"] ? [entry["dc:creator"]] : []);
    const scopusLink = Array.isArray(entry?.link)
      ? entry.link.find(l => l?.["@ref"] === "scopus")?.["@href"]
      : undefined;
    return {
      source: "scopus",
      title: entry?.["dc:title"] || "Untitled",
      authors,
      year: safeInt(year),
      journal: entry?.["prism:publicationName"],
      volume: textValue(entry?.["prism:volume"]),
      issue: textValue(entry?.["prism:issueIdentifier"]),
      pages: textValue(entry?.["prism:pageRange"]),
      doi,
      url: scopusLink || (doi ? `https://doi.org/${doi}` : (entry?.["prism:url"] || "")),
      abstract: undefined, // STANDARD view doesn't include abstract
      citationCount: entry?.["citedby-count"] ? Number(entry["citedby-count"]) : undefined,
      openAccess: entry?.openaccess === "1" || entry?.openaccess === 1,
      providerRank: i + start,
      raw: entry,
    };
  });
}

// ─── Scientific-search bridge ───────────────────────────────────────────
// The product already has robust canonical adapters for eight additional
// scholarly indexes. Reuse those implementations here so the live /chat
// agentic path reaches the same worldwide corpus instead of maintaining a
// second, smaller provider universe.

function adaptScientificPaper(paper, source, providerRank = 0) {
  const doi = typeof paper?.doi === "string"
    ? paper.doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").trim()
    : undefined;
  const url = paper?.htmlUrl || (doi ? `https://doi.org/${doi}` : paper?.pdfUrl) || "";
  const openAccess = typeof paper?.openAccess === "boolean" ? paper.openAccess : undefined;
  return {
    source,
    title: paper?.title || "Untitled",
    authors: normaliseAuthors(paper?.authors),
    year: safeInt(paper?.year),
    journal: textValue(paper?.venue),
    doi,
    url,
    pdfUrl: textValue(paper?.pdfUrl),
    abstract: textValue(paper?.abstract),
    citationCount: safeInt(paper?.citations),
    openAccess,
    providerRank,
    raw: paper,
  };
}

function createScientificAdapter(searchFn, source) {
  return async function searchScientificIndex(query, opts = {}) {
    const maxResults = Math.min(50, Math.max(1, opts.maxResults ?? DEFAULT_MAX_RESULTS));
    const offset = typeof opts.offset === "number" && opts.offset >= 0 ? opts.offset : 0;
    const papers = await searchFn(query, {
      limit: maxResults,
      offset,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    if (!Array.isArray(papers)) return [];
    return papers.slice(0, maxResults).map((paper, index) => (
      adaptScientificPaper(paper, source, offset + index)
    ));
  };
}

const searchArxiv = createScientificAdapter(scientificSearch.searchArxiv, "arxiv");
const searchEuropePMC = createScientificAdapter(scientificSearch.searchEuropePMC, "europepmc");
const searchCore = createScientificAdapter(scientificSearch.searchCore, "core");
const searchDBLP = createScientificAdapter(scientificSearch.searchDBLP, "dblp");
const searchDataCite = createScientificAdapter(scientificSearch.searchDataCite, "datacite");
const searchRedalyc = createScientificAdapter(scientificSearch.searchRedalyc, "redalyc");
const searchBioRxiv = createScientificAdapter(scientificSearch.searchBioRxiv, "biorxiv");
const searchMedRxiv = createScientificAdapter(scientificSearch.searchMedRxiv, "medrxiv");

// ─── Registry + dispatcher ───────────────────────────────────────────────

const REGISTRY = {
  openalex: searchOpenAlex,
  semantic: searchSemanticScholar,
  crossref: searchCrossRef,
  pubmed: searchPubMed,
  europepmc: searchEuropePMC,
  doaj: searchDOAJ,
  scielo: searchSciELO,
  redalyc: searchRedalyc,
  arxiv: searchArxiv,
  dblp: searchDBLP,
  datacite: searchDataCite,
  biorxiv: searchBioRxiv,
  medrxiv: searchMedRxiv,
  core: searchCore,
  wos: searchWebOfScience,
  scopus: searchScopus,
};

/**
 * Run one (source, query) retrieval. Safe to call concurrently via
 * Promise.allSettled in the orchestrator.
 *
 * `offset` is honoured by providers that natively paginate
 * (openalex via `page`, scielo via Crossref `offset`); others
 * ignore it and return the same first page (the agentic batcher
 * dedupes anyway).
 */
async function retrieveFromProvider({ source, query, maxResults, timeoutMs, mailto, offset, language, apiKey, insttoken, authtoken, signal }) {
  const fn = REGISTRY[source];
  if (!fn) return [];
  try {
    const out = await fn(query, { maxResults, timeoutMs, mailto, offset, language, apiKey, insttoken, authtoken, signal });
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
  searchSciELO,
  searchScopus,
  searchWebOfScience,
  searchArxiv,
  searchEuropePMC,
  searchCore,
  searchDBLP,
  searchDataCite,
  searchRedalyc,
  searchBioRxiv,
  searchMedRxiv,
  adaptScientificPaper,
  reconstructAbstract,
  normaliseAuthors,
  buildWosUsrQuery,
  firstEnv,
  REGISTRY,
  INTERNAL: { normaliseWosRecords, findIdentifier, objectText, adaptScientificPaper },
};

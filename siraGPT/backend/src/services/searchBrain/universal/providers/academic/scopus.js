/**
 * Scopus — Elsevier's Scopus Search API provider.
 *
 * Endpoint: https://api.elsevier.com/content/search/scopus
 * Auth:     `X-ELS-APIKey` header (recommended). Optional
 *           `X-ELS-Insttoken` for institutional token customers.
 * Method:   GET
 * Caps:     default 25 results, max 200 per page; 5 000 items per
 *           cursor session. Our agentic batch never asks for more
 *           than `batchSize` (10) per call.
 *
 * The provider fails soft when SCOPUS_API_KEY is not configured —
 * it simply returns [] so the orchestrator can skip Scopus without
 * poisoning the rest of the run. This matches how the OpenAlex
 * polite-pool opts out when `mailto` is missing.
 */

const ENDPOINT = "https://api.elsevier.com/content/search/scopus";

async function fetchJson(url, { timeoutMs = 9000, apiKey, insttoken } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      Accept: "application/json",
      "User-Agent": "siraGPT-search-brain",
    };
    if (apiKey) headers["X-ELS-APIKey"] = apiKey;
    if (insttoken) headers["X-ELS-Insttoken"] = insttoken;
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) throw new Error(`Scopus ${res.status}: ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function firstValue(v) {
  if (Array.isArray(v)) return v[0];
  return v;
}

function authorsLine(entry) {
  const authors = Array.isArray(entry?.author) ? entry.author : null;
  if (authors && authors.length > 0) {
    const names = authors.slice(0, 6).map(a => a?.authname || a?.['ce:indexed-name'] || a?.['preferred-name']?.['ce:indexed-name']).filter(Boolean);
    return names.join(", ") + (authors.length > 6 ? " et al." : "");
  }
  const creator = entry?.['dc:creator'];
  return typeof creator === "string" ? creator : "";
}

function buildSnippet(entry) {
  const parts = [];
  const year = typeof entry?.['prism:coverDate'] === "string" ? entry['prism:coverDate'].slice(0, 4) : null;
  if (year) parts.push(year);
  const venue = entry?.['prism:publicationName'];
  if (venue) parts.push(venue);
  const cites = entry?.['citedby-count'];
  if (cites !== undefined && cites !== null) parts.push(`${cites} citas`);
  return parts.join(" · ");
}

function landingUrl(entry) {
  if (Array.isArray(entry?.link)) {
    const self = entry.link.find(l => l?.['@ref'] === "scopus");
    if (self?.['@href']) return self['@href'];
  }
  const doi = entry?.['prism:doi'];
  if (typeof doi === "string") return `https://doi.org/${doi}`;
  return entry?.['prism:url'] || "";
}

const scopusProvider = {
  id: "scopus",
  name: "Scopus (Elsevier)",
  region: "global",
  category: "academic",
  license: "requires-key",
  rateLimit: "25/200 resultados por request · 20 000 / semana (High tier)",
  requiresKey: true,

  async search(query, opts = {}) {
    if (!query || typeof query !== "string") return [];
    const apiKey = opts.apiKey || (opts.keys && opts.keys.scopus) || process.env.SCOPUS_API_KEY;
    if (!apiKey) return []; // soft-skip when no key configured
    const insttoken = opts.insttoken || (opts.keys && opts.keys.scopusInsttoken) || process.env.SCOPUS_INSTTOKEN;
    const count = Math.min(200, Math.max(1, opts.maxResults || 20));
    const start = typeof opts.offset === "number" && opts.offset >= 0 ? opts.offset : 0;

    const url = new URL(ENDPOINT);
    url.searchParams.set("query", query);
    url.searchParams.set("count", String(count));
    if (start > 0) url.searchParams.set("start", String(start));
    url.searchParams.set("view", "STANDARD");
    url.searchParams.set("sort", "relevancy");

    let body;
    try {
      body = await fetchJson(url.toString(), {
        timeoutMs: opts.timeoutMs,
        apiKey,
        insttoken,
      });
    } catch (err) {
      console.warn("[scopus] search failed:", err?.message);
      return [];
    }

    const entries = body?.['search-results']?.entry;
    if (!Array.isArray(entries)) return [];

    return entries.map((entry, i) => {
      const doi = entry?.['prism:doi'];
      const scopusId = firstValue(entry?.['dc:identifier']);
      const id = doi ? `scopus:${doi}` : (scopusId ? `scopus:${scopusId}` : `scopus:${entry?.eid || i}`);
      return {
        id,
        sourceProvider: "scopus",
        category: "academic",
        title: entry?.['dc:title'] || "Untitled",
        snippet: buildSnippet(entry),
        url: landingUrl(entry),
        datePublished: entry?.['prism:coverDate'] || undefined,
        metadata: {
          doi: doi || null,
          authors: authorsLine(entry),
          venue: entry?.['prism:publicationName'],
          year: typeof entry?.['prism:coverDate'] === "string" ? Number(entry['prism:coverDate'].slice(0, 4)) : undefined,
          citationCount: entry?.['citedby-count'] ? Number(entry['citedby-count']) : undefined,
          openAccess: entry?.openaccess === "1" || entry?.openaccess === 1 || entry?.openaccess === true,
          type: entry?.subtypeDescription || entry?.subtype,
          scopusEid: entry?.eid,
          publisher: "Scopus/Elsevier",
        },
      };
    });
  },
};

module.exports = { scopusProvider };

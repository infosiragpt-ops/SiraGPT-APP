/**
 * OpenAlex — academic-works provider for the UniversalSearchBrain.
 *
 * OpenAlex is a free CC0 graph of ~240 M scholarly works. It sits
 * alongside Scopus / SciELO / Redalyc / ProQuest in the academic
 * tier but is the only one with an open bulk snapshot: no per-row fee
 * and no subscription gating for bulk metadata. REST production usage
 * should include an OpenAlex API key plus a contact `mailto`.
 *
 * Auth resolution, in priority order:
 *   1. opts.apiKey / opts.mailto — set by the caller at request
 *      time (e.g. a per-user setting passed in through the route).
 *   2. process.env.OPENALEX_API_KEY — premium key set by ops.
 *   3. process.env.OPENALEX_MAILTO — polite-pool email.
 *
 * Shape returned matches the UnifiedResult schema used by the rest
 * of the orchestrator so the caller does not care which academic
 * provider answered.
 */

const ENDPOINT = "https://api.openalex.org/works";

async function fetchJson(url, { timeoutMs = 9000, mailto } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": `siraGPT-search-brain${mailto ? ` (mailto:${mailto})` : ""}`,
      },
    });
    if (!res.ok) throw new Error(`OpenAlex ${res.status}: ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// OpenAlex returns abstracts as an inverted index to reduce payload
// size: { "word": [positions], ... }. We walk the positions and
// rebuild a normal string. Returns undefined for missing / empty
// indexes so the UnifiedResult snippet stays clean.
function reconstructAbstract(inverted) {
  if (!inverted || typeof inverted !== "object") return undefined;
  const positions = [];
  for (const [word, indexes] of Object.entries(inverted)) {
    if (!Array.isArray(indexes)) continue;
    for (const i of indexes) positions[i] = word;
  }
  const text = positions.filter(Boolean).join(" ").trim();
  return text || undefined;
}

function authorsLine(authorships) {
  if (!Array.isArray(authorships)) return "";
  return authorships
    .slice(0, 6)
    .map(a => a?.author?.display_name || a?.raw_author_name)
    .filter(Boolean)
    .join(", ")
    + (authorships.length > 6 ? " et al." : "");
}

function buildSnippet(w) {
  const abs = reconstructAbstract(w.abstract_inverted_index);
  if (abs) return abs.slice(0, 360) + (abs.length > 360 ? "…" : "");
  const parts = [];
  if (w.publication_year) parts.push(String(w.publication_year));
  const venue = w.primary_location?.source?.display_name || w.host_venue?.display_name;
  if (venue) parts.push(venue);
  if (typeof w.cited_by_count === "number") parts.push(`${w.cited_by_count} citas`);
  return parts.join(" · ");
}

const openAlexProvider = {
  id: "openalex",
  name: "OpenAlex",
  region: "global",
  category: "academic",
  license: "CC0",
  rateLimit: "100 000 credits/day with free API key; 100 req/sec hard cap",
  requiresKey: true,

  async search(query, opts = {}) {
    if (!query || typeof query !== "string") return [];
    const timeoutMs = opts.timeoutMs || 9000;
    const maxResults = Math.min(50, opts.maxResults || 20);
    const apiKey = opts.apiKey || process.env.OPENALEX_API_KEY;
    const mailto = opts.mailto || process.env.OPENALEX_MAILTO;

    const url = new URL(ENDPOINT);
    url.searchParams.set("search", query);
    url.searchParams.set("per-page", String(maxResults));
    // Sort by relevance — OpenAlex's default `cited_by_count:desc`
    // over-indexes on old papers. `relevance_score:desc` pays
    // attention to the query.
    url.searchParams.set("sort", "relevance_score:desc");
    if (apiKey) url.searchParams.set("api_key", apiKey);
    if (mailto) url.searchParams.set("mailto", mailto);

    let body;
    try {
      body = await fetchJson(url.toString(), { timeoutMs, mailto });
    } catch (err) {
      // Never crash the orchestrator on a single provider failure —
      // return empty so the merged result set is still usable.
      console.warn("[openalex] search failed:", err?.message);
      return [];
    }
    if (!body || !Array.isArray(body.results)) return [];

    return body.results.map((w) => {
      const doi = typeof w.doi === "string"
        ? w.doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
        : null;
      const venue = w.primary_location?.source?.display_name
                 || w.host_venue?.display_name;
      return {
        id: `openalex:${w.id || doi || w.title}`,
        sourceProvider: "openalex",
        category: "academic",
        title: w.title || w.display_name || "Sin título",
        snippet: buildSnippet(w),
        url: w.id || (doi ? `https://doi.org/${doi}` : ""),
        datePublished: w.publication_date || (w.publication_year ? `${w.publication_year}-01-01` : undefined),
        metadata: {
          doi,
          authors: authorsLine(w.authorships),
          venue,
          year: w.publication_year,
          citationCount: w.cited_by_count,
          openAccess: Boolean(w.open_access?.is_oa),
          pdfUrl: w.open_access?.oa_url || w.primary_location?.pdf_url || null,
          language: w.language,
          type: w.type,
          topics: (Array.isArray(w.topics) ? w.topics : []).slice(0, 3).map(t => t?.display_name).filter(Boolean),
        },
      };
    });
  },
};

module.exports = { openAlexProvider };

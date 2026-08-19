/**
 * SciELO — academic provider for the UniversalSearchBrain.
 *
 * SciELO is a regional Open-Access network (Latin America, Spain,
 * Portugal, Sudáfrica, Caribbean) covering ~1.6 M articles. There
 * is no public free-text REST API on articlemeta.scielo.org —
 * that endpoint is record-by-PID + paginated `identifiers/`. The
 * pragmatic way to do a free-text query against SciELO without
 * scraping search.scielo.org (which 403s bots) is to hit Crossref
 * filtered by member 530 ("FapUNIFESP (SciELO)"), then optionally
 * enrich each hit with articlemeta when we want extra fields like
 * full abstract or PDF url.
 *
 * This dual-source approach keeps us within open APIs and gives us
 * the same UnifiedResult shape every other academic provider returns.
 *
 * Auth: none required. Crossref asks for a mailto in the User-Agent
 * to qualify for the polite pool — same convention as OpenAlex.
 */

const CROSSREF_ENDPOINT = "https://api.crossref.org/works";
const ARTICLEMETA_ENDPOINT = "https://articlemeta.scielo.org/api/v1/article/";
const SCIELO_MEMBER_ID = "530";

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
    if (!res.ok) throw new Error(`SciELO/Crossref ${res.status}: ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function authorsLine(authors) {
  if (!Array.isArray(authors)) return "";
  return authors
    .slice(0, 6)
    .map(a => a?.given && a?.family ? `${a.given} ${a.family}` : (a?.name || a?.family || ""))
    .filter(Boolean)
    .join(", ")
    + (authors.length > 6 ? " et al." : "");
}

function buildSnippet(item) {
  const abstract = typeof item.abstract === "string"
    ? item.abstract.replace(/<[^>]+>/g, "").trim()
    : "";
  if (abstract) return abstract.slice(0, 360) + (abstract.length > 360 ? "…" : "");
  const parts = [];
  const year = item['published-print']?.['date-parts']?.[0]?.[0]
            || item['published-online']?.['date-parts']?.[0]?.[0]
            || item.created?.['date-parts']?.[0]?.[0];
  if (year) parts.push(String(year));
  const venue = Array.isArray(item['container-title']) ? item['container-title'][0] : item['container-title'];
  if (venue) parts.push(venue);
  if (typeof item['is-referenced-by-count'] === "number") parts.push(`${item['is-referenced-by-count']} citas`);
  return parts.join(" · ");
}

function isoDate(item) {
  const dateParts = item['published-print']?.['date-parts']?.[0]
                 || item['published-online']?.['date-parts']?.[0]
                 || item.issued?.['date-parts']?.[0];
  if (!Array.isArray(dateParts) || dateParts.length === 0) return undefined;
  const [y, m = 1, d = 1] = dateParts;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function langFilter(language) {
  // Crossref filter accepts ISO 639-1 codes through `language:<code>`.
  if (!language || typeof language !== "string") return null;
  const code = language.toLowerCase().slice(0, 2);
  if (!/^[a-z]{2}$/.test(code)) return null;
  return `language:${code}`;
}

const scieloProvider = {
  id: "scielo",
  name: "SciELO (vía Crossref miembro 530)",
  region: "latam",
  category: "academic",
  license: "open",
  rateLimit: "Polite pool de Crossref con mailto",
  requiresKey: false,

  async search(query, opts = {}) {
    if (!query || typeof query !== "string") return [];
    const timeoutMs = opts.timeoutMs || 9000;
    const maxResults = Math.min(50, opts.maxResults || 20);
    const mailto = opts.mailto || opts.userEmail || process.env.CROSSREF_MAILTO;

    const filters = [`member:${SCIELO_MEMBER_ID}`];
    const lang = langFilter(opts.language);
    if (lang) filters.push(lang);

    const url = new URL(CROSSREF_ENDPOINT);
    url.searchParams.set("query", query);
    url.searchParams.set("rows", String(maxResults));
    url.searchParams.set("filter", filters.join(","));
    // Crossref's `select` keeps the response small; we only ask
    // for the fields we actually map to UnifiedResult.
    // Crossref's `works` query endpoint rejects `language` inside
    // `select` — leave it out so we never trigger a 400.
    url.searchParams.set("select", [
      "DOI", "title", "author", "published-print", "published-online",
      "container-title", "abstract", "URL", "type",
      "is-referenced-by-count", "issued", "created",
    ].join(","));
    if (mailto) url.searchParams.set("mailto", mailto);
    if (typeof opts.offset === "number" && opts.offset > 0) {
      url.searchParams.set("offset", String(opts.offset));
    }

    let body;
    try {
      body = await fetchJson(url.toString(), { timeoutMs, mailto });
    } catch (err) {
      console.warn("[scielo] search failed:", err?.message);
      return [];
    }

    const items = body?.message?.items;
    if (!Array.isArray(items)) return [];

    return items.map((it) => {
      const doi = typeof it.DOI === "string" ? it.DOI : null;
      const title = Array.isArray(it.title) ? it.title[0] : (it.title || "Sin título");
      const venue = Array.isArray(it['container-title']) ? it['container-title'][0] : it['container-title'];
      const year = it['published-print']?.['date-parts']?.[0]?.[0]
                || it['published-online']?.['date-parts']?.[0]?.[0]
                || it.created?.['date-parts']?.[0]?.[0];
      return {
        id: `scielo:${doi || it.URL || title}`,
        sourceProvider: "scielo",
        category: "academic",
        title,
        snippet: buildSnippet(it),
        url: doi ? `https://doi.org/${doi}` : (it.URL || ""),
        datePublished: isoDate(it),
        metadata: {
          doi,
          authors: authorsLine(it.author),
          venue,
          year,
          citationCount: it['is-referenced-by-count'],
          openAccess: true, // SciELO is OA by definition
          pdfUrl: it.URL || null,
          language: it.language,
          type: it.type,
          publisher: "SciELO",
          collection: "scielo",
        },
      };
    });
  },

  /**
   * Optional enrichment: fetch full ArticleMeta payload by DOI
   * (best-effort — used by the agentic pipeline when the abstract
   * was missing from Crossref).
   */
  async fetchDetail(id, opts = {}) {
    const timeoutMs = opts.timeoutMs || 6000;
    const doi = typeof id === "string" && id.startsWith("scielo:")
      ? id.slice("scielo:".length)
      : id;
    if (!doi || !/^10\./.test(doi)) return null;
    const url = `${ARTICLEMETA_ENDPOINT}?doi=${encodeURIComponent(doi)}`;
    try {
      const json = await fetchJson(url, { timeoutMs });
      if (!json || typeof json !== "object") return null;
      return {
        id: `scielo:${doi}`,
        sourceProvider: "scielo",
        category: "academic",
        title: json?.article?.v12?.[0]?._ || json?.title || "Sin título",
        snippet: json?.article?.v83?.[0]?._ || "",
        url: `https://doi.org/${doi}`,
        metadata: { doi, fullPayload: json },
      };
    } catch {
      return null;
    }
  },
};

module.exports = { scieloProvider };

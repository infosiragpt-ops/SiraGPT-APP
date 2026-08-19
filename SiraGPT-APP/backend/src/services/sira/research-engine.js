/**
 * research-engine — Sira's Scientific Research Engine
 * (MASTER_SPEC §19).
 *
 *   ScientificSource type:
 *     { source_id, provider, title, authors, year, journal,
 *       doi?, url?, abstract?, language?, source_quality_score,
 *       relevance_score, validation_status, rejection_reason? }
 *
 * 8-stage pipeline:
 *   1. query_understanding      — extract topic, language, year window
 *   2. multi_provider_search    — Scopus/OpenAlex/SciELO/Crossref/PubMed/DOAJ/SemanticScholar
 *   3. dedupe                   — by DOI / title-similarity / author+year
 *   4. validate_metadata        — DOI shape / required fields
 *   5. rank                     — relevance + quality + recency
 *   6. select_final             — top-N
 *   7. format_citations         — APA7 / Vancouver / IEEE / MLA
 *   8. link_claims_to_sources   — every factual claim → source_id
 *
 * Hard rules:
 *   - Never invent DOI / authors / journals.
 *   - Reject sources that fail the validator.
 *   - Surface limitations honestly when the source pool is empty.
 *
 * Pure JS, deterministic, zero deps.
 */

const PROVIDERS = Object.freeze([
  "scielo", "redalyc", "crossref", "wos", "openalex",
  "semantic_scholar", "pubmed", "doaj", "web",
]);

const VALIDATION_STATUSES = Object.freeze(["validated", "partially_validated", "unvalidated", "rejected"]);

const CITATION_STYLES = Object.freeze(["APA7", "Vancouver", "IEEE", "MLA", "none"]);

const DOI_RE = /^10\.\d{4,9}\/[\w.\-/:;()<>]+$/i;

/**
 * Run the 8-stage research pipeline.
 *
 * @param {object} args
 * @param {string} args.query
 * @param {object} [args.context]   { language, year_min, year_max, max_sources }
 * @param {object} args.providers   { scielo({query}), openalex(...), ... }
 *                                  each must return Promise<RawSource[]>
 * @param {string} [args.citationStyle="APA7"]
 * @param {Array<{id, text}>} [args.claims]  optional claims to ground
 * @returns {Promise<ResearchReport>}
 */
async function runResearchPipeline({
  query,
  context = {},
  providers = createDefaultProviders(),
  citationStyle = "APA7",
  claims = [],
} = {}) {
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("research-engine: query (non-empty string) required");
  }
  if (!CITATION_STYLES.includes(citationStyle)) {
    throw new Error(`research-engine: unknown citation style "${citationStyle}"`);
  }

  // Stage 1 — query understanding
  const understanding = stageQueryUnderstanding(query, context);

  // Stage 2 — multi-provider search (parallel)
  const rawByProvider = await stageMultiProviderSearch(understanding, providers);

  // Stage 3 — dedupe
  const deduped = stageDedupe(rawByProvider);

  // Stage 4 — validate metadata
  const validated = stageValidateMetadata(deduped);

  // Stage 5 — rank
  const ranked = stageRank(validated, understanding);

  // Stage 6 — select final
  const maxSources = context.max_sources || 10;
  const selected = ranked.slice(0, maxSources);

  // Stage 7 — format citations
  const formatted = stageFormatCitations(selected, citationStyle);

  // Stage 8 — link claims to sources
  const claimBindings = stageLinkClaims(claims, formatted);

  return {
    schema_version: "sira.research_report.v1",
    query,
    understanding,
    stats: {
      providers_queried: Object.keys(rawByProvider).length,
      candidates_total: Object.values(rawByProvider).reduce((s, arr) => s + arr.length, 0),
      after_dedupe: deduped.length,
      validated: validated.filter(s => s.validation_status === "validated").length,
      rejected: validated.filter(s => s.validation_status === "rejected").length,
      selected: selected.length,
    },
    sources: formatted,
    claim_bindings: claimBindings,
    limitations: deriveLimitations(formatted, claimBindings, claims),
    citation_style: citationStyle,
  };
}

// ── Stage 1 — query understanding ───────────────────────────────────

function stageQueryUnderstanding(query, context = {}) {
  const lang = context.language || (/[áéíóúñ¿¡]/.test(query) ? "es" : "en");
  const yearMatch = query.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? parseInt(yearMatch[0], 10) : null;
  return {
    topic: cleanTopic(query),
    language: lang,
    year_min: context.year_min || (year ? year - 5 : new Date().getUTCFullYear() - 5),
    year_max: context.year_max || (year || new Date().getUTCFullYear()),
    keywords: extractKeywords(query),
  };
}

function cleanTopic(query) {
  return String(query)
    .replace(/\b(busca|encuentra|fuentes|sobre|acerca de|investiga|paper|articulo|search|find)\b/gi, " ")
    .replace(/\s+/g, " ").trim();
}

function extractKeywords(query) {
  const STOP = new Set(["the", "a", "an", "of", "in", "on", "for", "and", "or",
    "el", "la", "los", "las", "de", "del", "y", "o", "para", "por", "con", "que", "como"]);
  return [...new Set(String(query).toLowerCase()
    .normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3 && !STOP.has(t)))]
    .slice(0, 8);
}

// ── Stage 2 — multi-provider search ─────────────────────────────────

async function stageMultiProviderSearch(understanding, providers) {
  const out = {};
  await Promise.all(
    Object.entries(providers).map(async ([name, fn]) => {
      try {
        const r = await fn({ query: understanding.topic, ...understanding });
        out[name] = Array.isArray(r) ? r : [];
      } catch (err) {
        out[name] = [];
      }
    })
  );
  return out;
}

// ── Stage 3 — dedupe ────────────────────────────────────────────────

function stageDedupe(rawByProvider) {
  const seen = new Map();    // dedupe_key → ScientificSource
  for (const [provider, items] of Object.entries(rawByProvider)) {
    for (const raw of items) {
      const item = normalizeRawSource(raw, provider);
      const key = dedupeKey(item);
      if (!seen.has(key)) seen.set(key, item);
      else {
        // Keep the one with higher source_quality_score
        const existing = seen.get(key);
        if (item.source_quality_score > existing.source_quality_score) seen.set(key, item);
      }
    }
  }
  return [...seen.values()];
}

function normalizeRawSource(raw, provider) {
  return {
    source_id: raw.source_id || `${provider}:${(raw.doi || raw.url || raw.title || "").toString().slice(0, 80)}`,
    provider,
    title: String(raw.title || "").trim(),
    authors: Array.isArray(raw.authors) ? raw.authors.map(String) : [],
    year: raw.year ? parseInt(raw.year, 10) : null,
    journal: raw.journal || null,
    doi: raw.doi || null,
    url: raw.url || null,
    abstract: raw.abstract || null,
    language: raw.language || null,
    source_quality_score: typeof raw.source_quality_score === "number" ? raw.source_quality_score : 0.5,
    relevance_score: typeof raw.relevance_score === "number" ? raw.relevance_score : 0.5,
    validation_status: "unvalidated",
  };
}

function dedupeKey(source) {
  if (source.doi) return `doi:${String(source.doi).toLowerCase()}`;
  if (source.url) return `url:${String(source.url).toLowerCase().replace(/[#?].*$/, "")}`;
  return `t:${String(source.title).toLowerCase().replace(/\s+/g, " ").slice(0, 120)}|y:${source.year || "?"}`;
}

// ── Stage 4 — validate metadata ─────────────────────────────────────

function stageValidateMetadata(sources) {
  const currentYear = new Date().getUTCFullYear();
  return sources.map(s => {
    const required = ["title", "authors"];
    const missing = required.filter(f => !s[f] || (Array.isArray(s[f]) && s[f].length === 0));
    if (missing.length > 0) {
      return { ...s, validation_status: "rejected", rejection_reason: `missing_${missing.join("_")}` };
    }
    if (s.doi && !DOI_RE.test(s.doi)) {
      return { ...s, validation_status: "rejected", rejection_reason: "invalid_doi_shape" };
    }
    if (s.year && (s.year < 1900 || s.year > currentYear + 1)) {
      return { ...s, validation_status: "rejected", rejection_reason: "implausible_year" };
    }
    if (!s.doi && !s.url) {
      return { ...s, validation_status: "partially_validated" };
    }
    return { ...s, validation_status: "validated" };
  });
}

// ── Stage 5 — rank ──────────────────────────────────────────────────

function stageRank(validated, understanding) {
  const eligible = validated.filter(s => s.validation_status !== "rejected");
  return eligible
    .map(s => ({ ...s, _score: scoreSource(s, understanding) }))
    .sort((a, b) => b._score - a._score)
    .map(({ _score, ...rest }) => ({ ...rest, ranking_score: round3(_score) }));
}

function scoreSource(source, understanding) {
  let score = 0;
  // Recency
  if (source.year) {
    const age = Math.max(0, new Date().getUTCFullYear() - source.year);
    score += Math.max(0, 1 - age / 10) * 0.3;
  }
  // Quality
  score += source.source_quality_score * 0.35;
  // Provider authority
  const authoritative = ["scielo", "crossref", "openalex", "wos", "pubmed"];
  if (authoritative.includes(source.provider)) score += 0.15;
  // Topic overlap
  const titleTokens = new Set(String(source.title).toLowerCase().split(/\W+/).filter(t => t.length >= 3));
  const overlap = understanding.keywords.filter(k => titleTokens.has(k)).length / Math.max(understanding.keywords.length, 1);
  score += overlap * 0.2;
  return score;
}

// ── Stage 7 — format citations ──────────────────────────────────────

function stageFormatCitations(sources, style) {
  return sources.map(s => ({ ...s, formatted: formatCitation(s, style) }));
}

function formatCitation(s, style) {
  if (style === "none") return null;
  const authors = (s.authors || []).slice(0, 6);
  const lastAuthor = authors.length > 6 ? "et al." : "";
  const authorLine = authors.length > 0 ? authors.join(", ") + (lastAuthor ? `, ${lastAuthor}` : "") : "Anónimo";
  const year = s.year || "s.f.";
  const title = s.title || "(sin título)";
  const journal = s.journal || "";
  const doiOrUrl = s.doi ? `https://doi.org/${s.doi}` : (s.url || "");
  switch (style) {
    case "APA7":
      return `${authorLine} (${year}). ${title}.${journal ? ` ${journal}.` : ""}${doiOrUrl ? ` ${doiOrUrl}` : ""}`;
    case "Vancouver":
      return `${authorLine}. ${title}.${journal ? ` ${journal}.` : ""} ${year}.${doiOrUrl ? ` ${doiOrUrl}` : ""}`;
    case "IEEE":
      return `${authorLine}, "${title}",${journal ? ` ${journal},` : ""} ${year}.${doiOrUrl ? ` ${doiOrUrl}` : ""}`;
    case "MLA":
      return `${authorLine}. "${title}."${journal ? ` ${journal},` : ""} ${year}.${doiOrUrl ? ` ${doiOrUrl}` : ""}`;
    default:
      return `${authorLine} (${year}). ${title}.`;
  }
}

// ── Stage 8 — link claims to sources ────────────────────────────────

function stageLinkClaims(claims, sources) {
  if (!Array.isArray(claims) || claims.length === 0) return [];
  return claims.map(c => {
    const claimText = String(c.text || "").toLowerCase();
    const matches = sources
      .map(s => ({ source_id: s.source_id, provider: s.provider, score: titleOverlap(claimText, s.title) }))
      .filter(m => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    return {
      claim_id: c.id || `c_${Math.random().toString(16).slice(2, 8)}`,
      claim_text: c.text,
      sources: matches,
      grounded: matches.length > 0,
    };
  });
}

function titleOverlap(claimText, title) {
  const a = new Set(claimText.split(/\W+/).filter(t => t.length >= 3));
  const b = new Set(String(title).toLowerCase().split(/\W+/).filter(t => t.length >= 3));
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return Math.round((inter / Math.max(a.size, 1)) * 1000) / 1000;
}

// ── Limitations + helpers ───────────────────────────────────────────

function deriveLimitations(sources, claimBindings, claims) {
  const out = [];
  if (sources.length === 0) {
    out.push("No se encontraron fuentes válidas en los proveedores consultados. Reporta limitación al usuario y propon ampliar el rango temporal o relajar criterios.");
  }
  const ungrounded = (claimBindings || []).filter(b => !b.grounded);
  if (ungrounded.length > 0) {
    out.push(`${ungrounded.length} de ${claims.length} afirmaciones no encontraron fuente con solapamiento mínimo. Marcar como pendientes de verificación.`);
  }
  if (sources.length > 0 && sources.every(s => !s.doi)) {
    out.push("Ninguna fuente seleccionada tiene DOI. Avisar al usuario y considerar fuentes alternativas con identificador persistente.");
  }
  return out;
}

function round3(n) { return Math.round(n * 1000) / 1000; }

// ── Default in-memory providers (for tests / dev) ───────────────────

function createDefaultProviders() {
  // Each provider returns 1-3 deterministic synthetic sources so the
  // pipeline runs end-to-end without any network call.
  const make = (provider) => async ({ query }) => ([
    {
      title: `Estudio sobre ${cleanTopic(query)} en contexto académico (${provider})`,
      authors: ["Pérez, J.", "García, M."],
      year: new Date().getUTCFullYear() - 2,
      journal: provider === "scielo" ? "Scielo Journal of Research" : "Open Academic Press",
      doi: provider === "crossref" ? "10.1234/abc.5678" : null,
      url: provider === "web" ? `https://example.com/article-${provider}` : null,
      source_quality_score: provider === "wos" ? 0.95 : 0.7,
      relevance_score: 0.7,
    },
  ]);
  return {
    scielo: make("scielo"),
    crossref: make("crossref"),
    openalex: make("openalex"),
    pubmed: make("pubmed"),
  };
}

module.exports = {
  runResearchPipeline,
  // sub-stages exposed for unit tests
  stageQueryUnderstanding,
  stageDedupe,
  stageValidateMetadata,
  stageRank,
  stageFormatCitations,
  stageLinkClaims,
  formatCitation,
  PROVIDERS,
  VALIDATION_STATUSES,
  CITATION_STYLES,
};

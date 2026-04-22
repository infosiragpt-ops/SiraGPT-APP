/**
 * UniversalSearchBrain — shared types.
 *
 * siraGPT's universal retrieval layer. Phase 2a establishes the
 * contract + foundation; Phase 2b-2d add providers by category;
 * Phase 2e adds UI + docs.
 *
 * Every provider implements the `SearchProvider` shape defined here
 * and returns `UnifiedResult` items. The orchestrator is category-
 * agnostic — it just needs { search(query, opts) → UnifiedResult[] }.
 *
 * @typedef {"academic" | "jobs" | "shopping" | "web" | "news"
 *   | "government" | "finance" | "weather" | "geo" | "media"
 *   | "travel" | "realestate" | "food" | "health" | "education"
 *   | "legal" | "social" | "china"} Category
 *
 * @typedef {"global" | "latam" | "spain" | "usa" | "china"} Region
 *
 * @typedef {object} UnifiedResult
 * @property {string} id                    — provider-unique id, e.g. "openmeteo:lima-2024-04-21"
 * @property {string} sourceProvider        — provider id (e.g. "openmeteo")
 * @property {Category} category
 * @property {string} title
 * @property {string} [snippet]
 * @property {string} [url]
 * @property {string} [imageUrl]
 * @property {number} [price]
 * @property {string} [currency]            — ISO 4217 code
 * @property {string} [location]
 * @property {string} [datePublished]       — ISO 8601
 * @property {string} [author]
 * @property {Record<string, unknown>} [metadata]
 *
 * @typedef {object} SearchOptions
 * @property {number} [maxResults]
 * @property {number} [timeoutMs]
 * @property {Region} [region]
 * @property {string} [language]            — "es", "en", "zh", …
 * @property {Record<string, string>} [keys] — user-pasted API keys (Adzuna, Brave, …)
 * @property {string} [userEmail]           — for polite-pool APIs
 * @property {Record<string, unknown>} [raw] — category-specific filters
 *
 * @typedef {object} SearchProvider
 * @property {string} id
 * @property {string} name
 * @property {Region} region
 * @property {Category} category
 * @property {"CC0"|"open"|"requires-key"|"scraping-opt-in"} license
 * @property {string} rateLimit             — short human-readable note
 * @property {boolean} requiresKey
 * @property {(query: string, opts?: SearchOptions) => Promise<UnifiedResult[]>} search
 * @property {(id: string, opts?: SearchOptions) => Promise<UnifiedResult | null>} [fetchDetail]
 *
 * @typedef {object} ProviderTrace
 * @property {string} providerId
 * @property {Category} category
 * @property {boolean} ok
 * @property {number} count
 * @property {number} durationMs
 * @property {string} [error]
 *
 * @typedef {object} UniversalSearchResponse
 * @property {string} query
 * @property {Category[]} intents           — detected intents (may be multiple)
 * @property {Region} region
 * @property {UnifiedResult[]} results
 * @property {ProviderTrace[]} providers
 * @property {boolean} reranked
 * @property {{ classificationMs: number, decompositionMs: number, retrievalMs: number, rerankingMs: number, totalMs: number }} timings
 */

const CATEGORIES = Object.freeze([
  "academic", "jobs", "shopping", "web", "news", "government",
  "finance", "weather", "geo", "media", "travel", "realestate",
  "food", "health", "education", "legal", "social", "china",
]);

const REGIONS = Object.freeze(["global", "latam", "spain", "usa", "china"]);

const DEFAULT_REGION = "global";

module.exports = {
  CATEGORIES,
  REGIONS,
  DEFAULT_REGION,
};

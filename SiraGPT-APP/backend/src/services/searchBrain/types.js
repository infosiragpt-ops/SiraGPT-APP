/**
 * SearchBrain — WebGLM-inspired academic search orchestration for
 * siraGPT's Express backend. Ported from the IliaGPT implementation
 * (server/services/searchBrain/ in Carrerajorge/Iliagpt.io) with
 * scope trimmed to the essentials per the user's request:
 *
 *   - providers (Web of Science, Scopus, OpenAlex, SciELO, Semantic Scholar, CrossRef, PubMed, DOAJ)
 *   - orchestrator (3-phase WebGLM: decompose → retrieve → rerank)
 *   - chat adapter (normalised results → citation-ready payload)
 *
 * Skipped in this pass (follow-up if the user wants them):
 *   - Frontend SearchBrainPanel
 *   - pgvector cache table (Prisma migration)
 *   - Redis fast-path
 *   - Redalyc scraping, arXiv Atom XML, WoS Puppeteer fallback
 *   - Content extractor (pdf-parse + readability)
 *   - docs/SEARCH_BRAIN.md
 *
 * This file holds JSDoc typedefs so IDE tooling picks up the shapes
 * used across the siblings. Pure JS — no TypeScript in this codebase.
 */

/**
 * @typedef {"wos" | "scopus" | "openalex" | "scielo" | "semantic" | "crossref" | "pubmed" | "europepmc" | "doaj" | "redalyc" | "arxiv" | "dblp" | "datacite" | "biorxiv" | "medrxiv" | "core"} SearchBrainSource
 *
 * @typedef {object} NormalisedResult
 * @property {SearchBrainSource} source
 * @property {string} title
 * @property {string[]} authors
 * @property {number} [year]
 * @property {string} [journal]
 * @property {string} [volume]
 * @property {string} [issue]
 * @property {string} [pages]
 * @property {string} [doi]
 * @property {string} url
 * @property {string} [pdfUrl]
 * @property {string} [abstract]
 * @property {number} [citationCount]
 * @property {string} [language]
 * @property {boolean} [openAccess]
 * @property {number} [rerankScore]
 * @property {number} [providerRank]
 * @property {string[]} [sources]
 * @property {number} [sourceCount]
 * @property {number} [retrievalScore]
 * @property {number} [qualityScore]
 * @property {unknown} [raw]
 *
 * @typedef {object} DecomposedQuery
 * @property {string} text
 * @property {"es" | "en"} language
 * @property {string} [rationale]
 *
 * @typedef {object} ProviderTrace
 * @property {SearchBrainSource} source
 * @property {boolean} ok
 * @property {number} count
 * @property {number} durationMs
 * @property {string} [error]
 *
 * @typedef {object} SearchBrainWeights
 * @property {number} rerank
 * @property {number} providerRank
 * @property {number} citations
 * @property {number} openAccessBoost
 *
 * @typedef {object} SearchBrainResponse
 * @property {string} query
 * @property {DecomposedQuery[]} decomposed
 * @property {NormalisedResult[]} results
 * @property {ProviderTrace[]} providers
 * @property {boolean} reranked
 * @property {SearchBrainWeights} weights
 * @property {{ decompositionMs: number, retrievalMs: number, rerankingMs: number, totalMs: number }} timings
 */

const DEFAULT_ACADEMIC_SOURCES = ["wos", "scopus", "openalex", "scielo", "semantic", "crossref", "pubmed", "doaj"];

const DEFAULT_WEIGHTS = Object.freeze({
  rerank: 1.0,
  providerRank: 0.3,
  citations: 0.2,
  openAccessBoost: 0.1,
});

const USER_AGENT = "siraGPT-SearchBrain/1.0 (+https://github.com/hamzabhiinder/siraGPT; responsible academic retrieval)";

module.exports = {
  DEFAULT_ACADEMIC_SOURCES,
  DEFAULT_WEIGHTS,
  USER_AGENT,
};

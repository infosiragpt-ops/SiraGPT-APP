/**
 * search-brain — Express router exposing the SearchBrain pipeline.
 *
 *   POST /api/search-brain/academic
 *     Body: { query, sources?, maxResults?, rerank?, mailto?, language? }
 *     Response: full SearchBrainResponse shape (decomposed, results,
 *               providers, timings, reranked, weights).
 *
 *   POST /api/search-brain/academic/chat
 *     Same body as above. Response augmented with citations ready for
 *     the chat UI + the LLM prompt-injection block (with the anti-
 *     hallucination preamble baked in).
 *
 *   GET /api/search-brain/providers
 *     Catalog of sources supported by this port + default set.
 */

const express = require("express");
const {
  searchAcademic,
  searchAcademicForChat,
  DEFAULT_ACADEMIC_SOURCES,
} = require("../services/searchBrain");

const router = express.Router();

const MAX_QUERY_LEN = 500;
const MAX_RESULTS_CAP = 50;

const VALID_SOURCES = new Set(["scopus", "openalex", "scielo", "semantic", "crossref", "pubmed", "doaj"]);

function validateQuery(raw) {
  if (typeof raw !== "string") return { valid: false, error: "query is required and must be a string" };
  const q = raw.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LEN);
  if (!q) return { valid: false, error: "query cannot be empty" };
  if (q.length < 2) return { valid: false, error: "query must be at least 2 characters" };
  return { valid: true, query: q };
}

function validateSources(raw) {
  if (!Array.isArray(raw)) return undefined;
  const out = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const k = item.trim().toLowerCase();
    if (VALID_SOURCES.has(k)) out.push(k);
  }
  return out.length > 0 ? out : undefined;
}

function validateMaxResults(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return Math.min(Math.max(Math.floor(raw), 1), MAX_RESULTS_CAP);
}

function validateLanguage(raw) {
  return raw === "es" || raw === "en" || raw === "auto" ? raw : undefined;
}

function extractMailto(req) {
  const body = req.body || {};
  if (typeof body.mailto === "string" && /@/.test(body.mailto)) return body.mailto.slice(0, 120);
  return process.env.SEARCH_BRAIN_MAILTO || undefined;
}

router.get("/providers", (_req, res) => {
  res.json({
    defaults: [...DEFAULT_ACADEMIC_SOURCES],
    providers: [
      {
        id: "scopus",
        name: "Scopus (Elsevier)",
        license: "requires Elsevier entitlement",
        requiresKey: true,
        configured: Boolean(process.env.SCOPUS_API_KEY),
        env: ["SCOPUS_API_KEY", "SCOPUS_INSTTOKEN", "SCOPUS_AUTHTOKEN"],
        rateLimitNote: "Scopus Search supports up to 200 results/request; quota depends on API key tier.",
      },
      {
        id: "openalex",
        name: "OpenAlex",
        license: "CC0",
        requiresKey: true,
        configured: Boolean(process.env.OPENALEX_API_KEY),
        env: ["OPENALEX_API_KEY", "OPENALEX_MAILTO"],
        rateLimitNote: "API key required for production-scale use; include mailto/contact.",
      },
      {
        id: "scielo",
        name: "SciELO via Crossref member 530",
        license: "open",
        requiresKey: false,
        configured: true,
        env: ["SEARCH_BRAIN_MAILTO"],
        rateLimitNote: "Uses Crossref polite pool; include mailto.",
      },
      {
        id: "semantic",
        name: "Semantic Scholar",
        license: "open",
        requiresKey: false,
        configured: Boolean(process.env.SEMANTIC_SCHOLAR_API_KEY || process.env.SEMANTIC_API_KEY || process.env.S2_API_KEY),
        env: ["SEMANTIC_SCHOLAR_API_KEY"],
        rateLimitNote: "Public endpoints work without a key; x-api-key is recommended.",
      },
      {
        id: "crossref",
        name: "Crossref",
        license: "open",
        requiresKey: false,
        configured: true,
        env: ["SEARCH_BRAIN_MAILTO"],
        rateLimitNote: "Polite pool: User-Agent/mailto.",
      },
      {
        id: "pubmed",
        name: "PubMed (NCBI E-utilities)",
        license: "open",
        requiresKey: false,
        configured: Boolean(process.env.NCBI_API_KEY || process.env.PUBMED_API_KEY),
        env: ["NCBI_API_KEY", "NCBI_TOOL", "NCBI_EMAIL"],
        rateLimitNote: "3 req/sec anonymous; 10 req/sec with NCBI API key.",
      },
      {
        id: "doaj",
        name: "DOAJ",
        license: "open",
        requiresKey: false,
        configured: true,
        env: ["DOAJ_API_KEY"],
        rateLimitNote: "Public article search does not require a key; publisher/private routes use api_key.",
      },
    ],
  });
});

router.post("/academic", async (req, res) => {
  try {
    const body = req.body || {};
    const q = validateQuery(body.query);
    if (!q.valid) return res.status(400).json({ error: q.error });
    const out = await searchAcademic({
      query: q.query,
      sources: validateSources(body.sources),
      maxResults: validateMaxResults(body.maxResults),
      rerank: body.rerank === false ? false : true,
      language: validateLanguage(body.language),
      mailto: extractMailto(req),
      timeoutMs: typeof body.timeoutMs === "number" ? Math.min(30000, Math.max(1000, body.timeoutMs)) : undefined,
      weights: body.weights && typeof body.weights === "object" ? body.weights : undefined,
    });
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
  }
});

router.post("/academic/chat", async (req, res) => {
  try {
    const body = req.body || {};
    const q = validateQuery(body.query);
    if (!q.valid) return res.status(400).json({ error: q.error });
    const out = await searchAcademicForChat({
      query: q.query,
      sources: validateSources(body.sources),
      maxResults: validateMaxResults(body.maxResults) ?? 15,
      rerank: body.rerank === false ? false : true,
      language: validateLanguage(body.language),
      mailto: extractMailto(req),
      timeoutMs: typeof body.timeoutMs === "number" ? Math.min(30000, Math.max(1000, body.timeoutMs)) : undefined,
    });
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
  }
});

module.exports = router;

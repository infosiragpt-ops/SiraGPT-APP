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
const {
  runUniversalSearch,
  classifyIntent,
  registry: universalRegistry,
  settings: universalSettings,
  CATEGORIES,
  REGIONS,
} = require("../services/searchBrain/universal");

const router = express.Router();

const MAX_QUERY_LEN = 500;
const MAX_RESULTS_CAP = 50;

const VALID_SOURCES = new Set(["wos", "scopus", "openalex", "scielo", "semantic", "crossref", "pubmed", "doaj"]);

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

function userId(req) {
  if (req.user && req.user.id) return String(req.user.id);
  const header = req.header("x-user-id");
  return typeof header === "string" && header.length > 0 ? header : "anonymous";
}

function validateUniversalCategories(raw, forced) {
  if (forced) return [forced];
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((c) => typeof c === "string" && CATEGORIES.includes(c));
  return out.length > 0 ? out : undefined;
}

function validateUniversalRegion(raw) {
  return typeof raw === "string" && REGIONS.includes(raw) ? raw : undefined;
}

async function runUniversalEndpoint(req, res, forcedCategory) {
  try {
    const body = req.body || {};
    const q = validateQuery(body.query);
    if (!q.valid) return res.status(400).json({ error: q.error });
    const uid = userId(req);
    const stored = universalSettings.get(uid);
    const out = await runUniversalSearch({
      query: q.query,
      categories: validateUniversalCategories(body.categories, forcedCategory),
      region: validateUniversalRegion(body.region) || stored.region,
      language: typeof body.language === "string" ? body.language.slice(0, 8) : undefined,
      mode: body.mode === "cloud" || body.mode === "local" ? body.mode : stored.mode,
      keys: { ...stored.keys, ...(body.keys && typeof body.keys === "object" ? body.keys : {}) },
      userEmail: stored.userEmail || (typeof body.userEmail === "string" ? body.userEmail : undefined),
      maxResults: validateMaxResults(body.maxResults),
      timeoutMs: typeof body.timeoutMs === "number" ? Math.min(30000, Math.max(1000, body.timeoutMs)) : undefined,
      raw: body.raw && typeof body.raw === "object" ? body.raw : undefined,
      cache: body.cache === false ? false : true,
    });
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
  }
}

function hasUsableEnvKey(...names) {
  return names.some((name) => {
    const value = process.env[name];
    return typeof value === "string" && value.trim() && !/^https?:\/\//i.test(value.trim());
  });
}

router.get("/providers", (_req, res) => {
  res.json({
    defaults: [...DEFAULT_ACADEMIC_SOURCES],
    providers: [
      {
        id: "wos",
        name: "Web of Science (Clarivate)",
        license: "requires Clarivate entitlement",
        requiresKey: true,
        configured: hasUsableEnvKey("WOS_API_KEY", "WEB_OF_SCIENCE_API_KEY"),
        env: ["WOS_API_KEY", "WOS_BASE_URL", "WOS_DATABASE_ID", "WOS_OPTION_VIEW"],
        rateLimitNote: "Expanded API uses X-ApiKey; quota and record access depend on institutional plan.",
      },
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

router.get("/intents", (_req, res) => {
  res.json({
    categories: [...CATEGORIES],
    regions: [...REGIONS],
    examples: {
      academic: "papers sobre RAG y evaluación",
      jobs: "trabajo data scientist remoto",
      shopping: "precio laptop i7 en Perú",
      weather: "clima en Lima mañana",
      finance: "bitcoin precio mercado",
      news: "noticias inteligencia artificial hoy",
    },
  });
});

router.get("/universal/providers", (req, res) => {
  const category = typeof req.query.category === "string" && CATEGORIES.includes(req.query.category) ? req.query.category : undefined;
  const region = typeof req.query.region === "string" && REGIONS.includes(req.query.region) ? req.query.region : undefined;
  res.json({ categories: [...CATEGORIES], regions: [...REGIONS], providers: universalRegistry.listMetadata({ category, region }) });
});

router.post("/universal", (req, res) => runUniversalEndpoint(req, res));
router.post("/jobs", (req, res) => runUniversalEndpoint(req, res, "jobs"));
router.post("/shopping", (req, res) => runUniversalEndpoint(req, res, "shopping"));
router.post("/news", (req, res) => runUniversalEndpoint(req, res, "news"));
router.post("/finance", (req, res) => runUniversalEndpoint(req, res, "finance"));
router.post("/weather", (req, res) => runUniversalEndpoint(req, res, "weather"));
router.post("/travel", (req, res) => runUniversalEndpoint(req, res, "travel"));
router.post("/government", (req, res) => runUniversalEndpoint(req, res, "government"));
router.post("/china", (req, res) => runUniversalEndpoint(req, res, "china"));

router.post("/settings/keys", (req, res) => {
  try {
    const updated = universalSettings.update(userId(req), { keys: req.body?.keys || req.body || {} });
    res.json({ keysConfigured: Object.keys(updated.keys) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "invalid settings" });
  }
});

router.post("/settings/region", (req, res) => {
  const updated = universalSettings.update(userId(req), { region: req.body?.region });
  res.json({ region: updated.region });
});

router.post("/settings/mode", (req, res) => {
  const updated = universalSettings.update(userId(req), { mode: req.body?.mode });
  res.json({ mode: updated.mode });
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

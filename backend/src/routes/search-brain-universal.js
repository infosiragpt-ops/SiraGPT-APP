/**
 * search-brain-universal — Express router exposing the UniversalSearchBrain.
 *
 *   GET  /api/search-brain/universal/providers          — full catalog
 *   GET  /api/search-brain/universal/settings           — safe view (no keys)
 *   POST /api/search-brain/universal/settings           — update region/mode/keys
 *   POST /api/search-brain/universal/search             — run the pipeline
 *
 * The /academic routes under /api/search-brain remain untouched: this
 * router is additive. Phase 2e will migrate the UI to call
 * /universal/search for all intents and deprecate /academic.
 */

const express = require("express");
const {
  runUniversalSearch,
  classifyIntent,
  registry,
  settings,
  CATEGORIES,
  REGIONS,
} = require("../services/searchBrain/universal");

const router = express.Router();

const MAX_QUERY_LEN = 500;
const MAX_RESULTS_CAP = 50;

function userId(req) {
  if (req.user && req.user.id) return String(req.user.id);
  const header = req.header("x-user-id");
  return typeof header === "string" && header.length > 0 ? header : "anonymous";
}

function validateQuery(raw) {
  if (typeof raw !== "string") return { valid: false, error: "query is required and must be a string" };
  const q = raw.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LEN);
  if (q.length < 2) return { valid: false, error: "query must be at least 2 characters" };
  return { valid: true, query: q };
}

function validateCategories(raw) {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((c) => typeof c === "string" && CATEGORIES.includes(c));
  return out.length > 0 ? out : undefined;
}

function validateRegion(raw) {
  return typeof raw === "string" && REGIONS.includes(raw) ? raw : undefined;
}

function validateMaxResults(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return Math.min(Math.max(Math.floor(raw), 1), MAX_RESULTS_CAP);
}

function validateTimeout(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return Math.min(Math.max(Math.floor(raw), 1000), 30000);
}

router.get("/providers", (req, res) => {
  const category = typeof req.query.category === "string" && CATEGORIES.includes(req.query.category)
    ? req.query.category
    : undefined;
  const region = typeof req.query.region === "string" && REGIONS.includes(req.query.region)
    ? req.query.region
    : undefined;
  res.json({
    categories: [...CATEGORIES],
    regions: [...REGIONS],
    providers: registry.listMetadata({ category, region }),
  });
});

router.get("/settings", (req, res) => {
  res.json(settings.publicView(userId(req)));
});

router.post("/settings", (req, res) => {
  try {
    const updated = settings.update(userId(req), req.body || {});
    res.json({
      region: updated.region,
      mode: updated.mode,
      userEmail: updated.userEmail || null,
      keysConfigured: Object.keys(updated.keys),
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "invalid settings" });
  }
});

router.get("/classify", (req, res) => {
  const q = validateQuery(typeof req.query.q === "string" ? req.query.q : "");
  if (!q.valid) return res.status(400).json({ error: q.error });
  res.json({ query: q.query, intents: classifyIntent(q.query) });
});

router.post("/search", async (req, res) => {
  try {
    const body = req.body || {};
    const q = validateQuery(body.query);
    if (!q.valid) return res.status(400).json({ error: q.error });
    const uid = userId(req);
    const userSettings = settings.get(uid);
    const out = await runUniversalSearch({
      query: q.query,
      categories: validateCategories(body.categories),
      region: validateRegion(body.region) || userSettings.region,
      language: typeof body.language === "string" ? body.language.slice(0, 8) : undefined,
      mode: body.mode === "cloud" || body.mode === "local" ? body.mode : userSettings.mode,
      keys: { ...userSettings.keys, ...(body.keys && typeof body.keys === "object" ? body.keys : {}) },
      userEmail: userSettings.userEmail || (typeof body.userEmail === "string" ? body.userEmail : undefined),
      maxResults: validateMaxResults(body.maxResults),
      timeoutMs: validateTimeout(body.timeoutMs),
      raw: body.raw && typeof body.raw === "object" ? body.raw : undefined,
    });
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
  }
});

module.exports = router;

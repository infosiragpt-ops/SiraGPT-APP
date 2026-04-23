/**
 * UniversalSearchBrain — public API.
 *
 * One-stop import for callers (routes, services). Providers are
 * registered here at module-load so downstream code never forgets
 * a require(). To add a new provider: implement it under
 * ./providers/<category>/<name>.js, export it from the category
 * barrel below, and register it here.
 */

const { runUniversalSearch } = require("./orchestrator");
const registry = require("./providerRegistry");
const { classifyIntent } = require("./intentClassifier");
const settings = require("./settings");
const { CATEGORIES, REGIONS, DEFAULT_REGION } = require("./types");

const { openMeteoProvider } = require("./providers/weather/openMeteo");
const { openAlexProvider } = require("./providers/academic/openAlex");
const { scieloProvider } = require("./providers/academic/scielo");
const { scopusProvider } = require("./providers/academic/scopus");

// ─── Register built-in providers (idempotent via id key) ─────────────────
registry.register(openMeteoProvider);
registry.register(openAlexProvider);
registry.register(scieloProvider);
registry.register(scopusProvider);

module.exports = {
  runUniversalSearch,
  classifyIntent,
  registry,
  settings,
  CATEGORIES,
  REGIONS,
  DEFAULT_REGION,
};

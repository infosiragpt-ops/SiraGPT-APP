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

// ─── Register built-in providers (idempotent via id key) ─────────────────
registry.register(openMeteoProvider);

module.exports = {
  runUniversalSearch,
  classifyIntent,
  registry,
  settings,
  CATEGORIES,
  REGIONS,
  DEFAULT_REGION,
};

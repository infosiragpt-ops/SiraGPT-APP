/**
 * cortex-engine — Sira's superior agentic runtime, exposed as one
 * coherent facade.
 *
 * Components
 * ----------
 *   - Cortex Orchestrator   — Plan → Act → Reflect → Replan loop
 *   - Speculative Router    — heuristic complexity classifier + cascade
 *   - Semantic Tool Cache   — singleflight + LRU + TTL + canonical key
 *   - Parallel Fanout       — bounded concurrency + reducer + timeouts
 *
 * Why a facade
 * ------------
 * Each module is independently useful and unit-tested in isolation.
 * The facade exists so callers (chat-controller, agent-runtime,
 * future SDK consumers) can spin up a single Cortex with sensible
 * defaults and consistent metrics. The composition itself is small
 * and explicit so the rest of the system can keep using individual
 * pieces directly when it doesn't need the full bundle.
 *
 * No third-party code is copied. The internal modules are all
 * authored from scratch.
 */

"use strict";

const cortex = require("./cortex-orchestrator");
const router = require("./speculative-router");
const cacheModule = require("./semantic-tool-cache");
const fanout = require("./parallel-fanout");

/**
 * Build a configured Cortex bundle. The returned object is safe to
 * share across requests when stateless components are sufficient
 * (router, fanout). The cache instance is shared; pass per-request
 * options into `cache.wrap` if isolation is required.
 *
 * @param {object} [opts]
 * @param {object} [opts.providerCatalog]      — { fast, standard, heavy }
 * @param {object} [opts.cache]                — SemanticToolCache constructor opts
 * @param {object} [opts.cortexDefaults]       — runCortex defaults
 * @param {object} [opts.fanoutDefaults]       — runFanout defaults
 * @returns {{ runCortex, route, cache, runFanout, version, components }}
 */
function createCortexEngine(opts = {}) {
  const {
    providerCatalog = null,
    cache: cacheOpts,
    cortexDefaults = {},
    fanoutDefaults = {},
  } = opts;

  const cache = new cacheModule.SemanticToolCache(cacheOpts || {});

  function runCortexWithDefaults(args) {
    return cortex.runCortex({ ...cortexDefaults, ...args });
  }

  function routeWithCatalog(args) {
    if (!providerCatalog && !args.catalog) {
      throw new TypeError(
        "cortex-engine.route: providerCatalog must be set on engine or per-call"
      );
    }
    return router.route({ catalog: providerCatalog, ...args });
  }

  function runFanoutWithDefaults(args) {
    return fanout.runFanout({ ...fanoutDefaults, ...args });
  }

  return Object.freeze({
    version: "1.0.0",
    runCortex: runCortexWithDefaults,
    route: routeWithCatalog,
    runFanout: runFanoutWithDefaults,
    cache,
    components: Object.freeze({
      STOP_REASONS: cortex.STOP_REASONS,
      TIERS: router.TIERS,
      FAILURE_POLICIES: fanout.FAILURE_POLICIES,
    }),
  });
}

module.exports = {
  createCortexEngine,
  // Re-export raw modules for advanced callers.
  cortex,
  router,
  cache: cacheModule,
  fanout,
};

/**
 * providerRegistry — central directory of providers by category + region.
 *
 * Providers register themselves (see `register`) and the orchestrator
 * looks them up by (category, region). Region "global" is always
 * included as a baseline — a Spain-specific weather query still falls
 * through to Open-Meteo if no Spain-only provider is registered.
 *
 * The registry is *process-global* on purpose: providers are stateless
 * modules, they declare their shape once at require-time, and the
 * orchestrator reads them by reference. No DI container, no factories
 * — just a map.
 */

const { CATEGORIES, REGIONS } = require("./types");

/** @type {Map<string, import("./types").SearchProvider>} */
const REGISTRY = new Map();

/**
 * @param {import("./types").SearchProvider} provider
 */
function register(provider) {
  if (!provider || typeof provider !== "object") {
    throw new Error("register: provider must be an object");
  }
  if (!provider.id || typeof provider.id !== "string") {
    throw new Error("register: provider.id must be a non-empty string");
  }
  if (!CATEGORIES.includes(provider.category)) {
    throw new Error(`register: unknown category "${provider.category}" for provider "${provider.id}"`);
  }
  if (!REGIONS.includes(provider.region)) {
    throw new Error(`register: unknown region "${provider.region}" for provider "${provider.id}"`);
  }
  if (typeof provider.search !== "function") {
    throw new Error(`register: provider "${provider.id}" must define search()`);
  }
  REGISTRY.set(provider.id, provider);
}

/**
 * @param {object} [filters]
 * @param {import("./types").Category} [filters.category]
 * @param {import("./types").Region} [filters.region]
 * @param {boolean} [filters.includeGlobal] — when filtering by region !== "global", include global providers too (default true)
 * @param {boolean} [filters.keysOnly] — when true, include providers that require keys; when false, exclude them
 * @returns {import("./types").SearchProvider[]}
 */
function list(filters = {}) {
  const out = [];
  for (const p of REGISTRY.values()) {
    if (filters.category && p.category !== filters.category) continue;
    if (filters.region) {
      const includeGlobal = filters.includeGlobal !== false;
      const matches = p.region === filters.region || (includeGlobal && p.region === "global");
      if (!matches) continue;
    }
    if (filters.keysOnly === false && p.requiresKey) continue;
    out.push(p);
  }
  return out;
}

function get(id) {
  return REGISTRY.get(id) || null;
}

function clear() {
  REGISTRY.clear();
}

function size() {
  return REGISTRY.size;
}

/**
 * Summary for the /providers endpoint — no `search` callable, just
 * metadata safe for the client.
 */
function listMetadata(filters = {}) {
  return list(filters).map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    region: p.region,
    license: p.license,
    rateLimit: p.rateLimit,
    requiresKey: Boolean(p.requiresKey),
    enabledByDefault: p.enabledByDefault !== false,
    disabledReason: p.metadata && p.metadata.disabledReason ? p.metadata.disabledReason : undefined,
  }));
}

module.exports = {
  register,
  list,
  get,
  clear,
  size,
  listMetadata,
};

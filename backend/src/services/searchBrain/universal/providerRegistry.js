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
 * @param {boolean} [filters.includeDisabled] — include opt-in/scraping-disabled providers (default false)
 * @param {Record<string, string>} [filters.keys] — user-configured provider keys
 * @returns {import("./types").SearchProvider[]}
 */
function list(filters = {}) {
  const out = [];
  for (const p of REGISTRY.values()) {
    if (!filters.includeDisabled && p.enabledByDefault === false) continue;
    if (filters.category && p.category !== filters.category) continue;
    if (filters.region) {
      const includeGlobal = filters.includeGlobal !== false;
      const matches = p.region === filters.region || (includeGlobal && p.region === "global");
      if (!matches) continue;
    }
    if (p.requiresKey && !isConfigured(p, filters.keys || {})) continue;
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

function envKeyNames(provider) {
  const keyName = provider.metadata && provider.metadata.keyName;
  const raw = [keyName, provider.id]
    .filter(Boolean)
    .flatMap((name) => [
      `SEARCH_BRAIN_${String(name).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_KEY`,
      `${String(name).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`,
    ]);
  return [...new Set(raw)];
}

function isConfigured(provider, keys = {}) {
  if (!provider.requiresKey) return true;
  const keyName = provider.metadata && provider.metadata.keyName;
  if (keyName && keys[keyName]) return true;
  if (keys[provider.id]) return true;
  return envKeyNames(provider).some((name) => {
    const value = process.env[name];
    return typeof value === "string" && value.trim().length > 0 && !/^https?:\/\//i.test(value.trim());
  });
}

function isScrapingOptIn(provider) {
  return provider.license === "scraping-opt-in" || Boolean(provider.metadata && provider.metadata.scrapingOptIn);
}

/**
 * Summary for the /providers endpoint — no `search` callable, just
 * metadata safe for the client.
 */
function listMetadata(filters = {}) {
  const keys = filters.keys || {};
  return list({ ...filters, includeDisabled: true }).map((p) => {
    const configured = isConfigured(p, keys);
    const disabledReason = p.metadata && p.metadata.disabledReason ? p.metadata.disabledReason : undefined;
    const scrapingOptIn = isScrapingOptIn(p);
    const active = p.enabledByDefault !== false && configured && !scrapingOptIn;
    return {
    id: p.id,
    name: p.name,
    category: p.category,
    region: p.region,
    license: p.license,
    rateLimit: p.rateLimit,
    requiresKey: Boolean(p.requiresKey),
      configured,
      active,
      scrapingOptIn,
      enabledByDefault: p.enabledByDefault !== false,
      disabledReason,
    };
  });
}

module.exports = {
  register,
  list,
  get,
  clear,
  isConfigured,
  size,
  listMetadata,
};

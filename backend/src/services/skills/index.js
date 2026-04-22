/**
 * skills — public re-exports for the skills subsystem.
 *
 * Load once at boot, reuse everywhere. The registry is cached in-module
 * so importing from multiple routes does not re-scan the filesystem on
 * every request. Dev code that needs a fresh read can call
 * `reload({ fresh: true })`.
 */

const registry = require('./registry');
const capabilities = require('./capabilities');

let _cache = null;

/**
 * Return the currently-loaded skill map. Lazy: the first caller pays
 * the disk scan, subsequent callers get the same Map.
 *
 * @returns {{ skills: Map<string, Skill>, errors: string[] }}
 */
function get() {
  if (_cache) return _cache;
  _cache = registry.load();
  if (_cache.errors.length > 0) {
    // Loud, once. Individual skills that failed to load are already
    // skipped; this line surfaces the fact so operators can see it in
    // logs instead of wondering why a skill is missing at runtime.
    console.warn(`[skills] loaded with ${_cache.errors.length} error(s):`);
    for (const err of _cache.errors) console.warn(`  - ${err}`);
  }
  return _cache;
}

function reload(opts) {
  _cache = registry.load(opts || {});
  return _cache;
}

module.exports = {
  get,
  reload,
  registry,
  capabilities,
  // convenience re-exports so callers don't need to pull two modules:
  CAPABILITIES: capabilities.CAPABILITIES,
  toReactTool: registry.toReactTool,
  toAgentCoreTool: registry.toAgentCoreTool,
  filterByCapabilities: registry.filterByCapabilities,
  listSkills: registry.listSkills,
};

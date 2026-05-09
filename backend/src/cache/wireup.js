'use strict';

/**
 * wireup — small helper module that gates reliability-foundation
 * integrations behind the `SIRA_RELIABILITY_WIRINGS` env flag.
 *
 * The integration sites (semantic.js, llm-cache.js, rag-service.js, etc.)
 * import the helpers below so the env-flag check, the once-guard, and the
 * defensive fallback (when the underlying module fails to load) live in
 * one place. The cache modules themselves only call:
 *
 *   wireSubscribeIfEnabled({ name, patterns, handler, holder })
 *
 * `holder` is any object on which a `_invalidatorWired` flag can be
 * attached; the helper sets it after a successful subscribe so a second
 * call on the same holder is a no-op (the once-guard).
 *
 * Why a separate module:
 *   - Tests need to verify the wiring decision logic without spinning up
 *     the singleton invalidator + cache stack.
 *   - The flag is OFF by default, which means the cache modules' import
 *     graphs and runtime behavior must be IDENTICAL to today's main when
 *     the flag is unset. Centralizing the check guarantees that.
 *
 * Public API:
 *   - isReliabilityWiringsEnabled(env?)  → boolean
 *   - wireSubscribeIfEnabled(opts)       → subscription handle | null
 *   - resetWiringStateForTests()         → clears the once-guard cache
 */

let _wiredHolders = new WeakSet();

function parseFlag(value) {
  if (value === undefined || value === null || value === '') return false;
  const s = String(value).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function isReliabilityWiringsEnabled(env = process.env) {
  return parseFlag(env.SIRA_RELIABILITY_WIRINGS);
}

/**
 * Subscribe `handler` to invalidation events for the given tag patterns,
 * but only if:
 *   1. SIRA_RELIABILITY_WIRINGS is enabled in the supplied env (defaults
 *      to process.env), AND
 *   2. The same `holder` object has not already been wired (once-guard).
 *
 * Returns the subscription handle on success, null otherwise. Errors
 * loading the invalidator are swallowed so the wired site degrades to
 * pre-flag behavior rather than crashing.
 */
function wireSubscribeIfEnabled({ name, patterns, handler, holder, env = process.env, getInvalidator } = {}) {
  if (!isReliabilityWiringsEnabled(env)) return null;
  if (typeof handler !== 'function') return null;
  if (!Array.isArray(patterns) || patterns.length === 0) return null;
  if (typeof name !== 'string' || !name) return null;
  if (holder && _wiredHolders.has(holder)) return null;

  let inv;
  try {
    if (typeof getInvalidator === 'function') {
      inv = getInvalidator();
    } else {
      // Default: load the singleton from context-invalidation.
      const mod = require('./context-invalidation');
      inv = mod.getInvalidator();
    }
  } catch {
    return null;
  }
  if (!inv || typeof inv.subscribe !== 'function') return null;

  let handle;
  try {
    handle = inv.subscribe({ name, patterns, handler });
  } catch {
    return null;
  }
  if (holder) _wiredHolders.add(holder);
  return handle;
}

function resetWiringStateForTests() {
  _wiredHolders = new WeakSet();
}

module.exports = {
  isReliabilityWiringsEnabled,
  wireSubscribeIfEnabled,
  resetWiringStateForTests,
};

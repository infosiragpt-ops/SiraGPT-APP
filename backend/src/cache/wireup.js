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
let _wiredCount = 0;

const KILL_SWITCH_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled']);

function parseFlag(value) {
  // Default ON: unset / empty / unknown values enable wirings. Only the
  // explicit kill-switch literals turn the wirings off — this matches
  // the openclaw v2026.5.7 posture (cache-invalidation always live,
  // operators flip a single env var to disable in an incident).
  if (value === undefined || value === null || value === '') return true;
  const s = String(value).trim().toLowerCase();
  if (KILL_SWITCH_VALUES.has(s)) return false;
  return true;
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
  _wiredCount += 1;
  return handle;
}

function getWiredHoldersCount() {
  return _wiredCount;
}

function resetWiringStateForTests() {
  _wiredHolders = new WeakSet();
  _wiredCount = 0;
}

module.exports = {
  isReliabilityWiringsEnabled,
  wireSubscribeIfEnabled,
  getWiredHoldersCount,
  resetWiringStateForTests,
};

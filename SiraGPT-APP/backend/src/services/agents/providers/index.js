'use strict';

/**
 * providers — bootstrap that registers the concrete ProviderAdapter
 * implementations the agent layer's ProviderRegistry can route to.
 *
 * Why a bootstrap module:
 *   - Keeps env-detection in one place. Each adapter declares
 *     `isAvailable()` based on its own credentials, and the bootstrap
 *     decides whether to register it.
 *   - Makes wiring observable. `bootstrapProviders()` returns a
 *     summary `{ registered, skipped }` so the caller (boot path,
 *     `/admin/health` endpoint, tests) can surface the active routing
 *     fan-out without reaching into ProviderRegistry internals.
 *   - Avoids "I added a key but the registry didn't pick it up"
 *     debugging — `skipped[]` lists every adapter that was considered
 *     and the reason it was rejected.
 *
 * Usage:
 *   const { getProviderRegistry } = require('../provider-registry');
 *   const { bootstrapProviders } = require('./providers');
 *   const summary = bootstrapProviders(getProviderRegistry());
 *   logger.info('providers ready', summary);
 *
 * The bootstrap is idempotent: calling it twice is a no-op for any
 * adapter that's already registered (the registry just overwrites the
 * existing slot — same effect, same shape). We track this so callers
 * can trigger a re-bootstrap after env reloads without leaking stale
 * state.
 */

const { OpenAIAdapter } = require('./openai-adapter');
const { AnthropicAdapter } = require('./anthropic-adapter');
const { GeminiAdapter } = require('./gemini-adapter');

const KNOWN_ADAPTERS = Object.freeze([
  { Klass: OpenAIAdapter, hint: 'OPENAI_API_KEY' },
  { Klass: AnthropicAdapter, hint: 'ANTHROPIC_API_KEY (and ANTHROPIC_NATIVE_ENABLED ≠ false)' },
  { Klass: GeminiAdapter, hint: 'GOOGLE_API_KEY or GEMINI_API_KEY' },
]);

/**
 * Register every adapter whose `isAvailable()` returns true into the
 * given registry. Skipped adapters are reported with the env hint so
 * the operator can fix the missing config without grepping the source.
 *
 * @param {ProviderRegistry} registry
 * @param {object} [opts]
 * @param {Iterable<{Klass:Function,hint:string}>} [opts.adapters] — for tests
 * @returns {{ registered: string[], skipped: Array<{name:string,reason:string}> }}
 */
function bootstrapProviders(registry, opts = {}) {
  if (!registry || typeof registry.register !== 'function') {
    throw new TypeError('bootstrapProviders requires a ProviderRegistry instance');
  }
  const adapters = opts.adapters || KNOWN_ADAPTERS;
  const registered = [];
  const skipped = [];

  for (const { Klass, hint } of adapters) {
    let adapter;
    try {
      adapter = new Klass();
    } catch (err) {
      skipped.push({ name: Klass.name || 'unknown', reason: `construction failed: ${err && err.message}` });
      continue;
    }

    let available = false;
    try {
      available = typeof adapter.isAvailable === 'function' ? Boolean(adapter.isAvailable()) : true;
    } catch (err) {
      skipped.push({ name: adapter.name || Klass.name, reason: `isAvailable threw: ${err && err.message}` });
      continue;
    }

    if (!available) {
      skipped.push({ name: adapter.name || Klass.name, reason: `not configured (${hint})` });
      continue;
    }

    try {
      registry.register(adapter);
      registered.push(adapter.name);
    } catch (err) {
      skipped.push({ name: adapter.name || Klass.name, reason: `register failed: ${err && err.message}` });
    }
  }

  return { registered, skipped };
}

module.exports = {
  bootstrapProviders,
  KNOWN_ADAPTERS,
  // Re-export classes so callers can register a single adapter
  // explicitly (e.g. tests, custom wiring) without going through the
  // bootstrap.
  OpenAIAdapter,
  AnthropicAdapter,
  GeminiAdapter,
};

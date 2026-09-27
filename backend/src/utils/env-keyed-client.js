'use strict';

/**
 * env-keyed-client — SDK clients that follow the API key currently in env.
 *
 * Provider keys are read per request: admin-connections-bridge swaps
 * `process.env.<PROVIDER>_API_KEY` at runtime whenever an admin saves a key in
 * Admin → Conexiones. A client built once at module load (or memoised on first
 * use) freezes whatever key was there at that moment and keeps using it
 * forever — the «OpenAI file upload error: 401 Incorrect API key provided:
 * sk-proj-…jgUA» incident (2026-09-27), where routes/files.js kept the stale
 * .env key while every other path used the valid panel key.
 *
 * `keyedClient` rebuilds the client only when the key actually changes
 * (fingerprint), so the hot path stays a Map lookup.
 */

const { fingerprint } = require('./provider-key-health');

/**
 * @param {() => string|undefined} readKey  returns the CURRENT key (read env here)
 * @param {(key: string) => any} build     builds a client for that key
 * @returns {(() => any) & { reset: () => void }} returns the client, or null without a key
 */
function keyedClient(readKey, build) {
  let cached = null; // { fp, client }
  function current() {
    const raw = typeof readKey === 'function' ? readKey() : readKey;
    const key = String(raw || '').trim();
    if (!key) {
      cached = null;
      return null;
    }
    const fp = fingerprint(key);
    if (!cached || cached.fp !== fp) cached = { fp, client: build(key) };
    return cached.client;
  }
  current.reset = () => { cached = null; };
  return current;
}

/**
 * Drop-in replacement for a legacy module-scope `const openai = new OpenAI(...)`:
 * every property access resolves the client for the CURRENT key, so call sites
 * like `openai.chat.completions.create(...)` keep working unchanged. Without a
 * key, using it throws a clear error at call time (the caller's try/catch
 * handles it) instead of crashing the process at require time.
 */
function lazyClientProxy(readKey, build, { missingKeyMessage } = {}) {
  const current = keyedClient(readKey, build);
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === '__siraCurrentClient') return current;
      // Never look like a thenable (e.g. `await client` by mistake).
      if (prop === 'then') return undefined;
      const client = current();
      if (!client) {
        const err = new Error(missingKeyMessage || 'API key not configured');
        err.code = 'provider_key_missing';
        throw err;
      }
      const value = client[prop];
      return typeof value === 'function' ? value.bind(client) : value;
    },
    has(_target, prop) {
      const client = current();
      return Boolean(client) && prop in client;
    },
  });
}

module.exports = { keyedClient, lazyClientProxy };

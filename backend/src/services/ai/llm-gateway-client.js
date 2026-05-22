'use strict';

/**
 * llm-gateway-client — thin wrapper around the OpenAI SDK that points at
 * the external litellm Proxy deployment instead of api.openai.com.
 *
 * Why this module exists
 * ----------------------
 * Today the backend instantiates `new OpenAI({apiKey, baseURL})` directly in
 * a handful of routes (see `rg "new OpenAI\\(" backend/src`). Each call site
 * re-implements its own retry, timeout, and provider-routing logic. When we
 * add a new provider (Bedrock, Azure, Vertex…) we'd have to touch all of
 * them.
 *
 * litellm Proxy is an external HTTP service compatible with the OpenAI
 * Chat Completions API that routes to 100+ providers based on a yaml
 * config. Pointing our OpenAI SDK at `LLM_GATEWAY_URL` (with a shared
 * `LLM_GATEWAY_KEY` for auth) collapses provider plumbing into one place
 * and unlocks gateway-side fallback, caching, budgets, and observability.
 *
 * This module is the *client side*. The proxy itself is deployed
 * separately on Replit Autoscale — see `infra/litellm/README.md`.
 *
 * Disabled mode
 * -------------
 * If `LLM_GATEWAY_URL` is unset, `isGatewayEnabled()` returns false and
 * `createGatewayClient()` returns null. Callers MUST fall back to their
 * existing direct-provider client when the gateway is off. The opt-in
 * header `x-sira-gateway: 1` is honored by `shouldUseGatewayForRequest()`
 * so we can validate against 10 % of live traffic before flipping it on
 * globally.
 *
 * Public API
 * ----------
 *   isGatewayEnabled()                      → boolean
 *   shouldUseGatewayForRequest(req)         → boolean (header opt-in + env)
 *   createGatewayClient({ env, fetchImpl }) → OpenAI client | null
 *   getGatewayConfig({ env })               → { url, key, timeoutMs, ... }
 *
 * The module never throws on bad config — a missing URL or key returns
 * `{ enabled: false, reason }` silently so a misconfigured prod boot
 * never crashes the chat route. Operators can grep config state by
 * calling `getGatewayConfig()` from a debug endpoint; we deliberately
 * don't spam the boot log on every cold start.
 */

let _OpenAICtor = null;
function loadOpenAI() {
  if (_OpenAICtor) return _OpenAICtor;
  // eslint-disable-next-line global-require
  _OpenAICtor = require('openai');
  return _OpenAICtor;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;

function readPositiveInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * Resolve gateway config from env. Pure — safe to call repeatedly.
 *
 * Returns `{ enabled: false, reason }` when the gateway shouldn't be
 * used. `reason` is a short string operators can grep in logs.
 */
function getGatewayConfig({ env = process.env } = {}) {
  const rawUrl = String(env.LLM_GATEWAY_URL || '').trim();
  if (!rawUrl) {
    return { enabled: false, reason: 'no_url' };
  }
  let url;
  try {
    url = new URL(rawUrl).toString().replace(/\/+$/, '');
  } catch (_err) {
    return { enabled: false, reason: 'invalid_url' };
  }
  const key = String(env.LLM_GATEWAY_KEY || '').trim();
  if (!key) {
    return { enabled: false, reason: 'no_key' };
  }
  return {
    enabled: true,
    url,
    key,
    timeoutMs: readPositiveInt(env.LLM_GATEWAY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxRetries: readPositiveInt(env.LLM_GATEWAY_MAX_RETRIES, DEFAULT_MAX_RETRIES),
    // Default header-only opt-in for the first rollout window. Flip
    // LLM_GATEWAY_FORCE=1 to send all traffic through the gateway.
    forceForAll: String(env.LLM_GATEWAY_FORCE || '').toLowerCase() === '1'
      || String(env.LLM_GATEWAY_FORCE || '').toLowerCase() === 'true',
    reason: 'ok',
  };
}

/**
 * Cheap boolean for "is the gateway available at all right now". Use
 * before instantiating a client; the actual client factory will return
 * null when this is false.
 */
function isGatewayEnabled({ env = process.env } = {}) {
  return getGatewayConfig({ env }).enabled === true;
}

/**
 * Per-request gating. Returns true when we should route the current
 * request through the gateway rather than the legacy direct client.
 *
 * Order of precedence:
 *   1. Gateway disabled (no URL/key) → always false.
 *   2. `LLM_GATEWAY_FORCE=1`        → always true.
 *   3. Request header `x-sira-gateway: 1` → true.
 *   4. Otherwise                    → false.
 *
 * The header is intentionally simple so we can flip 10 % of traffic via
 * a cookie / feature-flag middleware without touching this module.
 */
function shouldUseGatewayForRequest(req, { env = process.env } = {}) {
  const cfg = getGatewayConfig({ env });
  if (!cfg.enabled) return false;
  if (cfg.forceForAll) return true;
  const header = req && req.headers && req.headers['x-sira-gateway'];
  return String(header || '').trim() === '1';
}

/**
 * Create an OpenAI SDK client pointed at the litellm Proxy. Returns
 * null when the gateway is disabled — callers MUST fall back to the
 * legacy direct provider client in that case.
 *
 * `fetchImpl` is optional — used by tests to mock HTTP without network.
 */
function createGatewayClient({ env = process.env, fetchImpl } = {}) {
  const cfg = getGatewayConfig({ env });
  if (!cfg.enabled) {
    return null;
  }
  const OpenAI = loadOpenAI();
  const opts = {
    apiKey: cfg.key,
    baseURL: cfg.url,
    timeout: cfg.timeoutMs,
    maxRetries: cfg.maxRetries,
  };
  if (typeof fetchImpl === 'function') {
    opts.fetch = fetchImpl;
  }
  return new OpenAI(opts);
}

/**
 * Wrap an attempt(client) function with one-shot fallback. Behavior:
 *   - Gateway disabled OR no `x-sira-gateway: 1` header → call legacy
 *     directly, mark `via='direct'`, `fallback=false`.
 *   - Gateway succeeds                                  → `via='gateway'`.
 *   - Gateway fails with a *transient* error (5xx, 408, 429, network)
 *                                                        → fall back to
 *     legacy, mark `via='direct'`, `fallback=true`.
 *   - Gateway fails with a *non-retryable* error (4xx auth/bad request)
 *                                                        → RETHROW. We
 *     intentionally do NOT mask real bugs (e.g. malformed payload) by
 *     silently retrying against the direct provider, because both would
 *     hit the same model and produce the same error.
 *
 * This is the recommended migration helper for call sites that already
 * have a working `createProviderClient(provider)` path: wrap the
 * existing call so flipping `x-sira-gateway: 1` is risk-free.
 *
 * @param {object} args
 * @param {object} args.req         — Express request (for header opt-in)
 * @param {() => OpenAI} args.legacy — factory for the existing direct client
 * @param {(client: OpenAI, meta: object) => Promise<*>} args.attempt
 * @param {(event: object) => void} [args.onEvent] — optional observability hook
 * @returns {Promise<{ result: *, via: 'gateway' | 'direct', fallback: boolean }>}
 */
async function callWithGatewayOrDirect({
  req,
  legacy,
  attempt,
  onEvent,
  env = process.env,
} = {}) {
  if (typeof attempt !== 'function') {
    throw new TypeError('callWithGatewayOrDirect: opts.attempt must be a function');
  }
  if (typeof legacy !== 'function') {
    throw new TypeError('callWithGatewayOrDirect: opts.legacy must be a function');
  }
  const useGateway = shouldUseGatewayForRequest(req, { env });
  if (useGateway) {
    const gw = createGatewayClient({ env });
    if (gw) {
      try {
        const result = await attempt(gw, { via: 'gateway' });
        emit(onEvent, { type: 'gateway.success' });
        return { result, via: 'gateway', fallback: false };
      } catch (err) {
        // Transient gateway errors silently fall back to direct so a
        // bad rollout window never breaks the user's chat. Non-retryable
        // errors (auth, bad request) still throw — those are real bugs.
        if (!isGatewayFallbackable(err)) {
          emit(onEvent, { type: 'gateway.error.terminal', message: err && err.message });
          throw err;
        }
        emit(onEvent, { type: 'gateway.error.fallback', message: err && err.message });
      }
    }
  }
  const direct = legacy();
  const result = await attempt(direct, { via: 'direct' });
  return { result, via: 'direct', fallback: useGateway };
}

function isGatewayFallbackable(err) {
  if (!err) return false;
  const status = Number(err.status || err.statusCode || (err.response && err.response.status));
  if (status === 408 || status === 429) return true;
  if (status >= 500 && status < 600) return true;
  const msg = String(err.message || '').toLowerCase();
  if (/timeout|timed out|etimedout|econnreset|enetunreach|socket hang up|fetch failed|network/.test(msg)) return true;
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.code === 'EAI_AGAIN') return true;
  return false;
}

function emit(hook, event) {
  if (typeof hook !== 'function') return;
  try { hook(event); } catch (_err) { /* observability errors are swallowed */ }
}

module.exports = {
  getGatewayConfig,
  isGatewayEnabled,
  shouldUseGatewayForRequest,
  createGatewayClient,
  callWithGatewayOrDirect,
  // exposed for tests
  _internal: { isGatewayFallbackable, readPositiveInt },
};

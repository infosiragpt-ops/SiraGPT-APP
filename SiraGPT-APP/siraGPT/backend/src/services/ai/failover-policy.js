'use strict';

/**
 * failover-policy.js — Declarative per-model fallback chains for AI
 * generation.
 *
 * Exposes:
 *
 *   failoverChain(modelId)                  → string[] (primary first)
 *   resolveWithFallback(modelId, opts)      → async runs an attempt fn
 *                                             across the chain, with
 *                                             circuit-breaker + transient
 *                                             error retry semantics, and
 *                                             reports the actually-used
 *                                             model + failover events.
 *
 * The chain catalog is intentionally provider-spanning so a degraded
 * provider (rate-limit, 5xx) doesn't take down the user's chat. Keys
 * are case-insensitive. Env override:
 *
 *   FAILOVER_CHAIN_<MODEL>=a,b,c    (model id sanitized: . / → _)
 *
 * The module has no side effects on require — safe to lazy-load from
 * routes/services. Pure functions are deterministic, easy to unit-test.
 */

const DEFAULT_CHAINS = Object.freeze({
    // OpenAI tier — high quality → fast → cross-provider safety net
    'gpt-4.1':     ['gpt-4.1', 'gpt-4o', 'claude-sonnet-4.5', 'gpt-4o-mini'],
    'gpt-4o':      ['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4.5', 'gemini-2.5-flash'],
    'gpt-5':       ['gpt-5', 'gpt-4.1', 'gpt-4o', 'claude-sonnet-4.5'],
    'gpt-5-mini':  ['gpt-5-mini', 'gpt-4o-mini', 'gemini-2.5-flash'],
    'gpt-4o-mini': ['gpt-4o-mini', 'gemini-2.5-flash', 'claude-haiku-4', 'gpt-3.5-turbo'],
    'gpt-4-turbo': ['gpt-4-turbo', 'gpt-4o', 'claude-sonnet-4.5'],
    'gpt-3.5-turbo': ['gpt-3.5-turbo', 'gpt-4o-mini', 'gemini-2.5-flash'],

    // Anthropic — primary plus cross-provider parachutes
    'claude-opus-4.7':   ['claude-opus-4.7', 'claude-sonnet-4.5', 'gpt-4.1', 'gpt-4o'],
    'claude-sonnet-4.5': ['claude-sonnet-4.5', 'claude-haiku-4', 'gpt-4o', 'gpt-4o-mini'],
    'claude-haiku-4':    ['claude-haiku-4', 'gpt-4o-mini', 'gemini-2.5-flash'],

    // Google
    'gemini-2.5-pro':   ['gemini-2.5-pro', 'gpt-4o', 'claude-sonnet-4.5'],
    'gemini-2.5-flash': ['gemini-2.5-flash', 'gpt-4o-mini', 'claude-haiku-4'],

    // DeepSeek
    'deepseek-v4-pro':   ['deepseek-v4-pro', 'gpt-4o', 'claude-sonnet-4.5'],
    'deepseek-v4-flash': ['deepseek-v4-flash', 'gpt-4o-mini', 'gemini-2.5-flash'],

    // OpenRouter sample
    'moonshotai/kimi-k2.6': ['moonshotai/kimi-k2.6', 'gpt-4o-mini', 'gemini-2.5-flash'],
});

function _envKey(modelId) {
    return 'FAILOVER_CHAIN_' + String(modelId).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/**
 * Resolve a fallback chain (primary first) for a given model id. Falls
 * back to a sensible cross-provider chain when the model is unknown so
 * that exotic / future model ids still benefit from failover.
 */
function failoverChain(modelId) {
    if (!modelId || typeof modelId !== 'string') {
        return ['gpt-4o-mini', 'gemini-2.5-flash'];
    }
    const id = modelId.trim();
    const envOverride = process.env[_envKey(id)];
    if (envOverride && envOverride.trim()) {
        const chain = envOverride.split(',').map(s => s.trim()).filter(Boolean);
        if (chain.length > 0) {
            // Always ensure primary is first.
            return chain[0] === id ? Array.from(new Set(chain)) : Array.from(new Set([id, ...chain]));
        }
    }
    const lower = id.toLowerCase();
    const direct = DEFAULT_CHAINS[lower] || DEFAULT_CHAINS[id];
    if (direct) return [...direct];

    // Heuristic fallback by family
    if (/^gpt-/.test(lower)) return [id, 'gpt-4o-mini', 'gemini-2.5-flash'];
    if (/^claude/.test(lower)) return [id, 'claude-haiku-4', 'gpt-4o-mini'];
    if (/^gemini/.test(lower)) return [id, 'gpt-4o-mini', 'claude-haiku-4'];
    if (/^deepseek/.test(lower)) return [id, 'gpt-4o-mini', 'gemini-2.5-flash'];
    return [id, 'gpt-4o-mini', 'gemini-2.5-flash'];
}

/**
 * Classify an error as retryable (transient: 5xx, 408, 429, network).
 */
function _isRetryable(err) {
    if (!err) return false;
    if (err.name === 'AbortError') return false;
    const status = Number(err.status || err.statusCode || (err.response && err.response.status));
    if (status === 408 || status === 429) return true;
    if (status >= 500 && status < 600) return true;
    const msg = String(err.message || '').toLowerCase();
    if (/timeout|timed out|etimedout|econnreset|enetunreach|socket hang up|fetch failed|network/i.test(msg)) return true;
    if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.code === 'EAI_AGAIN') return true;
    return false;
}

/**
 * Run an attempt across the fallback chain. The caller supplies a
 * single `attempt(model, meta)` async function — the policy decides
 * which model to try next, integrates a circuit breaker per provider
 * (when one is provided), logs failover events to `onFailover`, and
 * returns the successful result + the model id that actually served
 * it. Failures of the entire chain rethrow the last error.
 *
 * @param {string} modelId
 * @param {object} opts
 * @param {(model:string, meta:object)=>Promise<*>} opts.attempt
 * @param {(name:string)=>{execute:(fn:()=>Promise<*>)=>Promise<*>}} [opts.getBreaker]
 * @param {(event:object)=>void} [opts.onFailover]
 * @param {number} [opts.maxAttempts]
 * @returns {Promise<{ result:*, modelUsed:string, attempts:number, failovers:object[] }>}
 */
async function resolveWithFallback(modelId, opts = {}) {
    if (typeof opts.attempt !== 'function') {
        throw new TypeError('resolveWithFallback: opts.attempt must be a function');
    }
    const chain = failoverChain(modelId);
    const max = Number.isFinite(opts.maxAttempts) ? Math.max(1, opts.maxAttempts) : chain.length;
    const failovers = [];
    let lastError = null;

    for (let i = 0; i < Math.min(chain.length, max); i++) {
        const model = chain[i];
        const meta = { index: i, requestedModel: modelId, attempt: i + 1 };
        try {
            const callFn = () => opts.attempt(model, meta);
            const result = typeof opts.getBreaker === 'function'
                ? await opts.getBreaker(model).execute(callFn)
                : await callFn();
            return {
                result,
                modelUsed: model,
                attempts: i + 1,
                failovers,
            };
        } catch (err) {
            lastError = err;
            // CircuitBreakerError / open-circuit → skip immediately to next
            const isCircuit = err && (err.name === 'CircuitBreakerError' || err.code === 'CIRCUIT_OPEN');
            const retryable = isCircuit || _isRetryable(err);
            const event = {
                from: model,
                to: chain[i + 1] || null,
                reason: isCircuit ? 'circuit_open' : (err && (err.status || err.code || err.name)) || 'unknown',
                message: err && err.message,
                requestedModel: modelId,
                attempt: i + 1,
                ts: Date.now(),
            };
            failovers.push(event);
            if (typeof opts.onFailover === 'function') {
                try { opts.onFailover(event); } catch { /* user logger errors swallowed */ }
            }
            if (!retryable || !chain[i + 1]) {
                if (!retryable) break; // terminal — don't waste fallback slots
            }
        }
    }
    throw lastError || new Error('failover-policy: all models exhausted');
}

module.exports = {
    failoverChain,
    resolveWithFallback,
    _isRetryable,
    _DEFAULT_CHAINS: DEFAULT_CHAINS,
};

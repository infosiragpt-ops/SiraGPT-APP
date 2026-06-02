'use strict';

/**
 * auth-profile-rotation.js — Per-provider API-key (auth profile) rotation.
 *
 * Inspired by OpenClaw's "Model failover → Auth profile rotation + fallbacks"
 * (MIT). When a provider call fails with an *auth-related* error
 * (401/403 invalid key, 429 rate-limit, insufficient_quota / billing), the
 * smart move is to retry the SAME model with the NEXT configured key for
 * that provider before paying the cost of failing over to a different
 * model/provider. This module supplies exactly that key pool + rotation
 * primitive, as pure deterministic functions with no side effects on
 * require (safe to lazy-load from routes/services/failover-policy).
 *
 * Key pools are discovered from env, in priority order:
 *
 *   1. <BASE>_API_KEY            — the existing single key (back-compat)
 *   2. <BASE>_API_KEY_2 .. _N    — numbered extra keys (N up to MAX_NUMBERED)
 *   3. <BASE>_API_KEYS           — optional comma-separated list of extras
 *
 * Duplicate keys (e.g. GEMINI_API_KEY === GOOGLE_API_KEY) are de-duped so a
 * single physical key never burns two rotation slots. A provider with 0 or 1
 * configured key behaves exactly like today (single attempt, ambient key).
 *
 * Exposes:
 *   listProfiles(provider, env?)            → [{ id, key, masked, source }]
 *   classifyAuthError(err)                  → 'auth'|'rate_limit'|'quota'|null
 *   shouldRotate(err)                       → boolean
 *   rotateProfiles(provider, attempt, opts) → { result, profileUsed, attempts, rotations }
 *   maskKey(key)                            → non-secret display string
 */

const MAX_NUMBERED = 20;

// Provider alias → ordered list of env "bases". The first base that yields a
// key wins; later bases are still scanned so a single provider can collect
// keys spread across legacy env names (e.g. Gemini vs Google AI).
const PROVIDER_ENV = Object.freeze({
    openai: ['OPENAI'],
    anthropic: ['ANTHROPIC'],
    claude: ['ANTHROPIC'],
    gemini: ['GEMINI', 'GOOGLE_AI', 'GOOGLE'],
    google: ['GOOGLE_AI', 'GOOGLE', 'GEMINI'],
    openrouter: ['OPENROUTER'],
    deepseek: ['DEEPSEEK'],
    groq: ['GROQ'],
    cerebras: ['CEREBRAS'],
    mistral: ['MISTRAL'],
    xai: ['XAI'],
    grok: ['XAI'],
});

/**
 * Map a free-form provider/model-family string to its canonical key. Falls
 * back to a sanitized upper-case base so unknown/future providers still get a
 * single-slot pool from <PROVIDER>_API_KEY.
 */
function _canonical(provider) {
    return String(provider || '').trim().toLowerCase();
}

function _basesFor(provider) {
    const canon = _canonical(provider);
    if (PROVIDER_ENV[canon]) return PROVIDER_ENV[canon];
    if (!canon) return [];
    return [canon.toUpperCase().replace(/[^A-Z0-9]+/g, '_')];
}

/**
 * Render a non-secret display string for logs/telemetry. Never returns more
 * than the first 3 + last 4 characters of the key.
 */
function maskKey(key) {
    const s = String(key || '');
    if (!s) return '';
    if (s.length <= 8) return '***';
    return `${s.slice(0, 3)}…${s.slice(-4)}`;
}

function _collectForBase(base, env) {
    const out = [];
    const primary = env[`${base}_API_KEY`];
    if (primary && String(primary).trim()) {
        out.push({ key: String(primary).trim(), source: `${base}_API_KEY` });
    }
    for (let i = 2; i <= MAX_NUMBERED; i++) {
        const v = env[`${base}_API_KEY_${i}`];
        if (v && String(v).trim()) {
            out.push({ key: String(v).trim(), source: `${base}_API_KEY_${i}` });
        }
    }
    const list = env[`${base}_API_KEYS`];
    if (list && String(list).trim()) {
        String(list).split(',').map(s => s.trim()).filter(Boolean).forEach((k, idx) => {
            out.push({ key: k, source: `${base}_API_KEYS[${idx}]` });
        });
    }
    return out;
}

/**
 * Build the ordered, de-duplicated auth-profile pool for a provider.
 * @param {string} provider
 * @param {object} [env] - defaults to process.env (override for tests)
 * @returns {{id:string,key:string,masked:string,source:string}[]}
 */
function listProfiles(provider, env = process.env) {
    const canon = _canonical(provider);
    const seen = new Set();
    const profiles = [];
    for (const base of _basesFor(provider)) {
        for (const entry of _collectForBase(base, env)) {
            if (seen.has(entry.key)) continue;
            seen.add(entry.key);
            profiles.push({
                id: `${canon || base.toLowerCase()}:${profiles.length + 1}`,
                key: entry.key,
                masked: maskKey(entry.key),
                source: entry.source,
            });
        }
    }
    return profiles;
}

/**
 * Classify an error as an auth-rotation candidate. Returns the rotation
 * reason or null when the error is NOT auth-related (in which case the caller
 * should fall through to model-level failover rather than burning keys).
 */
function classifyAuthError(err) {
    if (!err) return null;
    if (err.name === 'AbortError') return null;
    const status = Number(err.status || err.statusCode || (err.response && err.response.status));
    const msg = String(err.message || (err.error && err.error.message) || '').toLowerCase();
    const code = String(err.code || (err.error && err.error.code) || '').toLowerCase();

    // Quota / billing — distinct from a transient rate-limit; a different key
    // on the same account often shares the quota, but a key on a *different*
    // account (the rotation use-case) does not.
    if (/insufficient_quota|exceeded your current quota|billing|payment required|out of credit/.test(msg)
        || code === 'insufficient_quota' || status === 402) {
        return 'quota';
    }
    // Rate limit
    if (status === 429 || /rate.?limit|too many requests|429/.test(msg) || code === 'rate_limit_exceeded') {
        return 'rate_limit';
    }
    // Authentication / authorization
    if (status === 401 || status === 403
        || /invalid api key|incorrect api key|unauthorized|authentication|permission|forbidden|invalid_api_key|api key not valid/.test(msg)
        || code === 'invalid_api_key' || code === 'unauthorized') {
        return 'auth';
    }
    return null;
}

function shouldRotate(err) {
    return classifyAuthError(err) !== null;
}

/**
 * Run `attempt` across the provider's auth-profile pool. Rotates to the next
 * key ONLY on auth-related failures; any other error rethrows immediately so
 * the caller's model-level failover can take over. When no keys are
 * configured the attempt runs once with profile=null (ambient credentials),
 * preserving current behaviour.
 *
 * @param {string} provider
 * @param {(profile:object|null, meta:object)=>Promise<*>} attempt
 * @param {object} [opts]
 * @param {object} [opts.env]
 * @param {object[]} [opts.profiles]      - pre-resolved pool (skips env scan)
 * @param {number}  [opts.maxProfiles]
 * @param {(event:object)=>void} [opts.onRotate]
 * @returns {Promise<{result:*, profileUsed:(string|null), attempts:number, rotations:object[]}>}
 */
async function rotateProfiles(provider, attempt, opts = {}) {
    if (typeof attempt !== 'function') {
        throw new TypeError('rotateProfiles: attempt must be a function');
    }
    const profiles = opts.profiles || listProfiles(provider, opts.env || process.env);

    if (profiles.length === 0) {
        // No configured keys → single ambient attempt (back-compat).
        const result = await attempt(null, { index: 0, attempt: 1, profileCount: 0, provider });
        return { result, profileUsed: null, attempts: 1, rotations: [] };
    }

    const max = Number.isFinite(opts.maxProfiles) ? Math.max(1, opts.maxProfiles) : profiles.length;
    const limit = Math.min(profiles.length, max);
    const rotations = [];
    let lastError = null;

    for (let i = 0; i < limit; i++) {
        const profile = profiles[i];
        const meta = { index: i, attempt: i + 1, profileCount: profiles.length, profileId: profile.id, provider };
        try {
            const result = await attempt(profile, meta);
            return { result, profileUsed: profile.id, attempts: i + 1, rotations };
        } catch (err) {
            lastError = err;
            const reason = classifyAuthError(err);
            if (!reason) throw err; // not auth-related → let model failover handle it
            const next = profiles[i + 1] || null;
            const event = {
                from: profile.id,
                fromMasked: profile.masked,
                to: next ? next.id : null,
                reason,
                message: err && err.message,
                provider,
                attempt: i + 1,
                ts: Date.now(),
            };
            rotations.push(event);
            if (typeof opts.onRotate === 'function') {
                try { opts.onRotate(event); } catch { /* user logger errors swallowed */ }
            }
            if (!next) break; // exhausted the pool
        }
    }
    throw lastError || new Error('auth-profile-rotation: all profiles exhausted');
}

module.exports = {
    listProfiles,
    classifyAuthError,
    shouldRotate,
    rotateProfiles,
    maskKey,
    PROVIDER_ENV,
    MAX_NUMBERED,
    _basesFor,
};

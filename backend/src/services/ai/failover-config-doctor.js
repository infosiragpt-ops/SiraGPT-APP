'use strict';

/**
 * failover-config-doctor.js — preflight sanity checks for the AI failover /
 * provider-key configuration. Inspired by `openclaw doctor`, which surfaces
 * risky/misconfigured setups before they bite at runtime.
 *
 * Pure and deterministic w.r.t. the injected env (defaults to process.env).
 * Returns structured findings (error / warn / info) so callers can render a
 * report, gate a boot check, or expose it over HTTP. Never throws on bad
 * config — that is the whole point; it reports instead.
 *
 *   runFailoverDoctor(env?) -> {
 *     ok: boolean,                 // false iff any error-level finding
 *     errors, warnings, infos,     // counts
 *     findings: [{ level, code, message, detail? }],
 *     providersConfigured: string[],
 *   }
 */

const { listProfiles, PROVIDER_ENV } = require('./auth-profile-rotation');
const { failoverChain, _DEFAULT_CHAINS } = require('./failover-policy');

// Canonical providers we know how to source keys for.
const KNOWN_PROVIDERS = Object.freeze(Array.from(new Set(Object.keys(PROVIDER_ENV))));

// Map a model id to the provider whose key pool serves it. Returns null when
// the family is unknown (so the doctor stays quiet rather than guessing).
function providerOfModel(model) {
    const m = String(model || '').toLowerCase().trim();
    if (!m) return null;
    if (/^(gpt-|o[1-9]|chatgpt|text-|davinci)/.test(m)) return 'openai';
    if (/^claude/.test(m)) return 'anthropic';
    if (/^gemini/.test(m)) return 'gemini';
    if (/^deepseek/.test(m)) return 'deepseek';
    if (/^(llama|cerebras)/.test(m)) return 'cerebras';
    if (/^(mistral|mixtral|codestral)/.test(m)) return 'mistral';
    if (/^(grok|xai)/.test(m)) return 'xai';
    if (m.includes('/') || /(kimi|moonshot|qwen|minimax|glm)/.test(m)) return 'openrouter';
    return null;
}

function _cooldownEnvIssues(env) {
    const out = [];
    const keys = [
        'SIRAGPT_KEY_COOLDOWN_AUTH_MS',
        'SIRAGPT_KEY_COOLDOWN_QUOTA_MS',
        'SIRAGPT_KEY_COOLDOWN_RATELIMIT_MS',
        'SIRAGPT_KEY_COOLDOWN_DEFAULT_MS',
        'SIRAGPT_KEY_COOLDOWN_MAX_MS',
    ];
    for (const k of keys) {
        const raw = env[k];
        if (raw === undefined || raw === '') continue; // unset → uses default, fine
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0 || !/^\d+$/.test(String(raw).trim())) {
            out.push({ level: 'error', code: 'invalid_cooldown', message: `${k}="${raw}" is not a non-negative integer (ms)`, detail: { env: k, value: raw } });
        }
    }
    return out;
}

function runFailoverDoctor(env = process.env) {
    const findings = [];

    // 1. Which providers have at least one key?
    const pools = KNOWN_PROVIDERS.map((p) => ({ provider: p, profiles: listProfiles(p, env) }));
    const configured = pools.filter((p) => p.profiles.length > 0);
    const configuredNames = configured.map((p) => p.provider);

    if (configured.length === 0) {
        findings.push({
            level: 'error',
            code: 'no_providers_configured',
            message: 'No AI provider API keys are configured — every model call will fail.',
        });
    }

    // 2. single-key providers → no rotation depth (informational).
    for (const { provider, profiles } of configured) {
        if (profiles.length === 1) {
            findings.push({
                level: 'info',
                code: 'single_key_no_rotation',
                message: `Provider "${provider}" has a single key — add ${provider.toUpperCase()}_API_KEY_2 for rotation depth.`,
                detail: { provider },
            });
        }
    }

    // 3. duplicate key shared across providers (likely a copy-paste mistake).
    const byFingerprint = new Map();
    for (const { provider, profiles } of pools) {
        for (const prof of profiles) {
            const arr = byFingerprint.get(prof.fingerprint) || [];
            if (!arr.includes(provider)) arr.push(provider);
            byFingerprint.set(prof.fingerprint, arr);
        }
    }
    for (const [fp, provs] of byFingerprint.entries()) {
        if (provs.length > 1) {
            findings.push({
                level: 'warn',
                code: 'duplicate_key_across_providers',
                message: `The same key (fingerprint ${fp}) is configured for multiple providers: ${provs.join(', ')}.`,
                detail: { fingerprint: fp, providers: provs },
            });
        }
    }

    // 4. failover-chain dead links: a fallback model whose provider has no key.
    const haveKey = new Set(configuredNames);
    const reportedDeadLinks = new Set();
    const chainModels = Object.keys(_DEFAULT_CHAINS);
    for (const primary of chainModels) {
        const chain = failoverChain(primary);
        for (const model of chain) {
            const prov = providerOfModel(model);
            if (!prov) continue; // unknown family → don't guess
            if (!haveKey.has(prov)) {
                const key = `${model}:${prov}`;
                if (reportedDeadLinks.has(key)) continue;
                reportedDeadLinks.add(key);
                findings.push({
                    level: 'warn',
                    code: 'chain_dead_link',
                    message: `Failover target "${model}" needs provider "${prov}", which has no configured key — that fallback hop is unreachable.`,
                    detail: { model, provider: prov },
                });
            }
        }
    }

    // 5. cooldown env coherence.
    findings.push(..._cooldownEnvIssues(env));

    const errors = findings.filter((f) => f.level === 'error').length;
    const warnings = findings.filter((f) => f.level === 'warn').length;
    const infos = findings.filter((f) => f.level === 'info').length;

    return {
        ok: errors === 0,
        errors,
        warnings,
        infos,
        providersConfigured: configuredNames,
        findings,
    };
}

module.exports = {
    runFailoverDoctor,
    providerOfModel,
    KNOWN_PROVIDERS,
};

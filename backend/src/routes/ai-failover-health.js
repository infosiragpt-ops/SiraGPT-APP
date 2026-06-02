'use strict';

/**
 * ai-failover-health.js — read-only diagnostics for the AI failover stack.
 *
 * Surfaces, for operators, what the resilience layer (failover-policy +
 * auth-profile-rotation + provider-key-health) currently sees:
 *
 *   - per-provider auth-profile pool: how many keys are configured, from
 *     which env vars, MASKED (first 3 + last 4 chars only) — never the raw key,
 *   - model → cross-provider failover chains,
 *   - live key-health snapshot (which keys are cooling down and why).
 *
 * Mounted at /api/ai/failover. GET-only, no mutation, no secret exposure.
 * Optionally token-gated via SIRAGPT_DIAG_TOKEN (open when unset, matching
 * the existing /metrics + /api/free-ia/health convention).
 *
 * The module is side-effect-free on require and defensive at request time:
 * every section is isolated so a single failure degrades to an `error`
 * field rather than a 500.
 */

const express = require('express');

const PROVIDERS = Object.freeze([
    'openai', 'anthropic', 'gemini', 'google', 'openrouter',
    'deepseek', 'groq', 'cerebras', 'mistral', 'xai',
]);

const SAMPLE_MODELS = Object.freeze([
    'gpt-4o', 'gpt-4o-mini', 'gpt-5', 'claude-sonnet-4.5', 'claude-opus-4.7',
    'gemini-2.5-flash', 'gemini-2.5-pro', 'deepseek-v4-pro',
]);

function _safe(fn, fallback) {
    try { return fn(); } catch (err) { return { error: err && err.message ? err.message : String(err), ...(fallback || {}) }; }
}

/**
 * Optional bearer/token gate. Open when SIRAGPT_DIAG_TOKEN is unset (parity
 * with the metrics endpoint). When set, requires a matching
 * `Authorization: Bearer <token>` or `?token=` query param.
 */
function checkAuth(req, env = process.env) {
    const token = env.SIRAGPT_DIAG_TOKEN;
    if (!token) return { ok: true };
    const header = (req.get ? req.get('authorization') : (req.headers && req.headers.authorization)) || '';
    const bearer = header.replace(/^Bearer\s+/i, '').trim();
    const supplied = bearer || (req.query && req.query.token) || '';
    return supplied && supplied === token ? { ok: true } : { ok: false, status: 401 };
}

/**
 * Build the full diagnostics report. Pure w.r.t. the injected env (defaults
 * to process.env). Never includes a raw API key.
 */
function buildFailoverHealthReport(env = process.env) {
    const authRotation = require('../services/ai/auth-profile-rotation');
    const failover = require('../services/ai/failover-policy');
    const keyHealth = require('../services/ai/provider-key-health');
    const { runFailoverDoctor } = require('../services/ai/failover-config-doctor');

    const providers = _safe(() => PROVIDERS.map((provider) => {
        const profiles = authRotation.listProfiles(provider, env);
        return {
            provider,
            keyCount: profiles.length,
            // masked + source only — no raw key material
            keys: profiles.map((p) => ({ id: p.id, masked: p.masked, source: p.source, fingerprint: p.fingerprint })),
        };
    }).filter((p) => p.keyCount > 0), []);

    const failoverChains = _safe(() => SAMPLE_MODELS.map((model) => ({
        model,
        chain: failover.failoverChain(model),
    })), []);

    const health = _safe(() => keyHealth.snapshot(), { tracked: 0, cooling: 0, keys: [] });

    const doctor = _safe(() => runFailoverDoctor(env), { ok: false, errors: 0, warnings: 0, infos: 0, findings: [] });

    const config = {
        cooldownAuthMs: Number.parseInt(env.SIRAGPT_KEY_COOLDOWN_AUTH_MS || '', 10) || 300000,
        cooldownQuotaMs: Number.parseInt(env.SIRAGPT_KEY_COOLDOWN_QUOTA_MS || '', 10) || 1800000,
        cooldownRateLimitMs: Number.parseInt(env.SIRAGPT_KEY_COOLDOWN_RATELIMIT_MS || '', 10) || 30000,
        cooldownMaxMs: Number.parseInt(env.SIRAGPT_KEY_COOLDOWN_MAX_MS || '', 10) || 3600000,
    };

    return {
        ok: true,
        service: 'ai-failover',
        providersConfigured: Array.isArray(providers) ? providers.length : 0,
        providers,
        failoverChains,
        keyHealth: health,
        doctor,
        config,
    };
}

function buildRouter() {
    const router = express.Router();

    const handler = (req, res) => {
        const auth = checkAuth(req);
        if (!auth.ok) {
            return res.status(auth.status || 401).json({ ok: false, error: 'unauthorized' });
        }
        try {
            return res.json(buildFailoverHealthReport());
        } catch (err) {
            return res.status(200).json({ ok: false, error: err && err.message ? err.message : 'diagnostics_failed' });
        }
    };

    const doctorHandler = (req, res) => {
        const auth = checkAuth(req);
        if (!auth.ok) {
            return res.status(auth.status || 401).json({ ok: false, error: 'unauthorized' });
        }
        try {
            const { runFailoverDoctor } = require('../services/ai/failover-config-doctor');
            return res.json(runFailoverDoctor());
        } catch (err) {
            return res.status(200).json({ ok: false, error: err && err.message ? err.message : 'doctor_failed' });
        }
    };

    router.get('/health', handler);
    router.get('/doctor', doctorHandler);
    router.get('/', handler);
    return router;
}

const router = buildRouter();

module.exports = router;
module.exports.buildFailoverHealthReport = buildFailoverHealthReport;
module.exports.checkAuth = checkAuth;
module.exports.buildRouter = buildRouter;
module.exports.PROVIDERS = PROVIDERS;
module.exports.SAMPLE_MODELS = SAMPLE_MODELS;

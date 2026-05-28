'use strict';

/**
 * token-budget.js — Pre-flight token & quota enforcement for AI
 * requests. Pure JS, no Prisma import at module scope; the actual
 * usage-service is injected (or lazily required) so unit tests don't
 * need the DB.
 *
 * Public API:
 *
 *   estimateInputTokens(text, model)                          → number
 *   preflight({ userId, model, prompt, contextMessages, opts }) →
 *     {
 *       ok,                  // boolean
 *       status,              // 200 | 402 | 413
 *       reason,              // 'ok' | 'context_overflow' | 'quota_exhausted' | ...
 *       estimatedInputTokens,
 *       estimatedOutputTokens,
 *       estimatedCostUSD,
 *       contextWindow,
 *       suggestedModel,      // when context overflow → a bigger-window model
 *       breakdown,           // { inputTokens, inputUSD, outputTokens, outputUSD }
 *       remainingQuota,      // when known
 *     }
 *
 * Notes:
 *   – Cost numbers are derived from services/ai/pricing.json (per 1M).
 *   – Context window table is a static lookup. Conservative defaults
 *     for unknown models.
 *   – Fails OPEN on internal errors so a flaky DB call can't lock the
 *     user out of the chat (caller still gets a structured error).
 */

const path = require('path');
let _pricing = null;
function loadPricing() {
    if (_pricing) return _pricing;
    try {
        // eslint-disable-next-line global-require
        _pricing = require(path.join(__dirname, 'pricing.json'));
    } catch {
        _pricing = { models: {}, _fallback: { input: 1, output: 1 } };
    }
    return _pricing;
}

// Static context-window catalog. Conservative — when in doubt, pick a
// smaller-than-actual window so we err on the side of suggesting a
// fallback model instead of blowing up mid-stream.
const CONTEXT_WINDOWS = Object.freeze({
    'gpt-5':            400_000,
    'openai/gpt-5.5':   400_000,
    'gpt-5-mini':       200_000,
    'gpt-4.1':          1_000_000,
    'gpt-4o':           128_000,
    'gpt-4o-mini':      128_000,
    'gpt-4-turbo':      128_000,
    'gpt-3.5-turbo':    16_000,
    'claude-opus-4.7':   200_000,
    'anthropic/claude-opus-4.7': 200_000,
    'claude-sonnet-4.5': 200_000,
    'claude-haiku-4':    200_000,
    'gemini-2.5-pro':    1_000_000,
    'gemini-2.5-flash':  1_000_000,
    'google/gemini-3.5': 1_000_000,
    'deepseek-v4-flash': 128_000,
    'deepseek-v4-pro':   128_000,
    'Gema4-31B':          128_000,
    'gema4-31b':          128_000,
    'x-ai/grok-4.2':      256_000,
    'z-ai/glm-5.1':       200_000,
    'moonshotai/kimi-k2.6': 200_000,
    'openai/gpt-oss-120b': 128_000,
    'openai/gpt-oss-20b':  128_000,
    'gpt-oss-120b':        128_000,
    'gpt-oss-20b':         128_000,
    // Siragpt 1.0 is a virtual model that routes to openai/gpt-oss-120b
    // (128k context) via OpenRouter. Without this entry the default 16k
    // window aborts the preflight on any request with a large system
    // prompt or attached context.
    'siragpt-1.0':         128_000,
});

const LONG_CONTEXT_LADDER = ['gpt-4o', 'claude-sonnet-4.5', 'gpt-4.1', 'gemini-2.5-pro'];

/**
 * Conservative token estimator. Tries to use usage-service.calculateTextTokens
 * when injected; otherwise falls back to a heuristic of ~4 chars/token.
 */
function estimateInputTokens(text, model = 'gpt-4o-mini', usageService = null) {
    const str = typeof text === 'string' ? text : '';
    if (usageService && typeof usageService.calculateTextTokens === 'function') {
        try { return usageService.calculateTextTokens(str, model); }
        catch { /* fall through */ }
    }
    return Math.ceil(str.length / 4);
}

function contextWindowFor(model) {
    if (!model) return 16_000;
    const raw = String(model);
    const normalized = raw.toLowerCase();
    const bare = normalized.includes('/') ? normalized.split('/').pop() : normalized;
    const direct = CONTEXT_WINDOWS[model] || CONTEXT_WINDOWS[normalized] || CONTEXT_WINDOWS[bare];
    if (direct) return direct;
    // family heuristic
    const m = bare;
    if (m.startsWith('gpt-4')) return 128_000;
    if (m.startsWith('gpt-')) return 16_000;
    if (m.startsWith('claude')) return 200_000;
    if (m.startsWith('gemini')) return 1_000_000;
    if (m.startsWith('deepseek')) return 128_000;
    return 16_000;
}

function pricingFor(model) {
    const pricing = loadPricing();
    const raw = String(model || '');
    const normalized = raw.toLowerCase();
    const bare = normalized.includes('/') ? normalized.split('/').pop() : normalized;
    const direct = pricing.models && (pricing.models[model] || pricing.models[normalized] || pricing.models[bare]);
    if (direct) return direct;
    return pricing._fallback || { input: 1, output: 1 };
}

function estimateCost(model, inputTokens, outputTokens) {
    const p = pricingFor(model);
    // pricing.json is USD per 1,000,000 tokens
    const inputUSD = (inputTokens / 1_000_000) * (p.input || 0);
    const outputUSD = (outputTokens / 1_000_000) * (p.output || 0);
    return {
        inputUSD,
        outputUSD,
        totalUSD: inputUSD + outputUSD,
    };
}

/**
 * Suggest a longer-context alternative when the requested model can't
 * fit the input. Walks `LONG_CONTEXT_LADDER` from cheapest → largest.
 */
function suggestLongerContextModel(estimatedInputTokens) {
    for (const m of LONG_CONTEXT_LADDER) {
        if (contextWindowFor(m) >= estimatedInputTokens * 1.25) return m;
    }
    return null;
}

/**
 * Best-effort preflight. Never throws — returns a structured verdict.
 *
 * @param {object} args
 * @param {string} [args.userId]
 * @param {string} args.model
 * @param {string} args.prompt
 * @param {Array}  [args.contextMessages]
 * @param {number} [args.expectedOutputTokens]
 * @param {object} [args.usageService]            // injected — defaults to require
 * @param {object} [args.prisma]                  // injected — defaults to require
 * @param {number} [args.userMonthlyQuotaUSD]     // optional override
 * @param {number} [args.maxCostUSD]              // per-request hard cap (org/env override)
 */
async function preflight(args = {}) {
    const {
        userId = null,
        model = 'gpt-4o-mini',
        prompt = '',
        contextMessages = [],
        expectedOutputTokens = 800,
        usageService = null,
        prisma = null,
        userMonthlyQuotaUSD = null,
        maxCostUSD = null,
    } = args;

    try {
        const usage = usageService || _safeRequire('../usage-service');
        const corpus = [prompt, ...((contextMessages || []).map(m => (m && m.content) || ''))].join('\n');
        const inputTokens = estimateInputTokens(corpus, model, usage);
        const outputTokens = Math.max(64, Number(expectedOutputTokens) || 0);
        const window = contextWindowFor(model);
        const cost = estimateCost(model, inputTokens, outputTokens);

        if (inputTokens > window) {
            const suggested = suggestLongerContextModel(inputTokens);
            return {
                ok: false,
                status: 413,
                reason: 'context_overflow',
                estimatedInputTokens: inputTokens,
                estimatedOutputTokens: outputTokens,
                estimatedCostUSD: cost.totalUSD,
                contextWindow: window,
                suggestedModel: suggested,
                breakdown: { inputTokens, inputUSD: cost.inputUSD, outputTokens, outputUSD: cost.outputUSD },
            };
        }

        // Per-request cost cap (env SIRAGPT_MAX_COST_PER_REQUEST_USD,
        // overridable per org via settings.ai.maxCostPerRequestUSD).
        // Surface as 402 — payment-required — distinguishing it from the
        // 413 context overflow and the 402 monthly-quota exhaustion below.
        const capUSD = _resolveMaxCostUSD(maxCostUSD);
        if (capUSD != null && cost.totalUSD > capUSD) {
            return {
                ok: false,
                status: 402,
                reason: 'cost_cap_exceeded',
                estimatedInputTokens: inputTokens,
                estimatedOutputTokens: outputTokens,
                estimatedCostUSD: cost.totalUSD,
                maxCostUSD: capUSD,
                contextWindow: window,
                breakdown: { inputTokens, inputUSD: cost.inputUSD, outputTokens, outputUSD: cost.outputUSD },
            };
        }

        // Quota check (only when we can determine a quota figure)
        let remainingQuota = null;
        if (userId) {
            try {
                const quotaInfo = await _resolveUserQuota({ userId, prisma, userMonthlyQuotaUSD });
                if (quotaInfo && Number.isFinite(quotaInfo.remainingUSD)) {
                    remainingQuota = quotaInfo.remainingUSD;
                    if (remainingQuota < cost.totalUSD) {
                        return {
                            ok: false,
                            status: 402,
                            reason: 'quota_exhausted',
                            estimatedInputTokens: inputTokens,
                            estimatedOutputTokens: outputTokens,
                            estimatedCostUSD: cost.totalUSD,
                            contextWindow: window,
                            remainingQuota,
                            quotaUSD: quotaInfo.quotaUSD,
                            usedUSD: quotaInfo.usedUSD,
                            breakdown: { inputTokens, inputUSD: cost.inputUSD, outputTokens, outputUSD: cost.outputUSD },
                        };
                    }
                }
            } catch (quotaErr) {
                // Fail-open on quota lookup errors — log to caller via reason
                return {
                    ok: true,
                    status: 200,
                    reason: 'quota_check_failed_open',
                    error: quotaErr && quotaErr.message,
                    estimatedInputTokens: inputTokens,
                    estimatedOutputTokens: outputTokens,
                    estimatedCostUSD: cost.totalUSD,
                    contextWindow: window,
                    breakdown: { inputTokens, inputUSD: cost.inputUSD, outputTokens, outputUSD: cost.outputUSD },
                };
            }
        }

        return {
            ok: true,
            status: 200,
            reason: 'ok',
            estimatedInputTokens: inputTokens,
            estimatedOutputTokens: outputTokens,
            estimatedCostUSD: cost.totalUSD,
            contextWindow: window,
            remainingQuota,
            breakdown: { inputTokens, inputUSD: cost.inputUSD, outputTokens, outputUSD: cost.outputUSD },
        };
    } catch (err) {
        // Fail-open: a bug in the preflight must never block real traffic.
        return {
            ok: true,
            status: 200,
            reason: 'preflight_error_open',
            error: err && err.message,
            estimatedInputTokens: 0,
            estimatedOutputTokens: 0,
            estimatedCostUSD: 0,
            contextWindow: contextWindowFor(model),
        };
    }
}

function _safeRequire(mod) {
    try { return require(mod); } catch { return null; }
}

/**
 * Resolve the per-request cost cap from (in priority order):
 *   1. explicit `maxCostUSD` argument (already an org-resolved value)
 *   2. env `SIRAGPT_MAX_COST_PER_REQUEST_USD`
 *   3. hard default of $5
 * Returns `null` only when the caller explicitly passes `0` / negative
 * to disable the cap (e.g. internal jobs).
 */
function _resolveMaxCostUSD(override) {
    if (override != null) {
        const n = Number(override);
        if (!Number.isFinite(n) || n <= 0) return null; // explicit disable
        return n;
    }
    const env = Number(process.env.SIRAGPT_MAX_COST_PER_REQUEST_USD);
    if (Number.isFinite(env) && env > 0) return env;
    return 5;
}

async function _resolveUserQuota({ userId, prisma, userMonthlyQuotaUSD }) {
    const envCap = Number(process.env.USER_MONTHLY_QUOTA_USD || userMonthlyQuotaUSD || 0);
    if (!Number.isFinite(envCap) || envCap <= 0) return null;
    const client = prisma || _safeRequire('../../config/database');
    if (!client || !client.apiUsage || typeof client.apiUsage.aggregate !== 'function') return null;

    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    try {
        const agg = await client.apiUsage.aggregate({
            where: { userId, createdAt: { gte: start } },
            _sum: { cost: true },
        });
        const usedUSD = Number((agg && agg._sum && agg._sum.cost) || 0);
        return {
            quotaUSD: envCap,
            usedUSD,
            remainingUSD: Math.max(0, envCap - usedUSD),
        };
    } catch {
        return null;
    }
}

module.exports = {
    preflight,
    estimateInputTokens,
    contextWindowFor,
    pricingFor,
    estimateCost,
    suggestLongerContextModel,
    _resolveMaxCostUSD,
    _CONTEXT_WINDOWS: CONTEXT_WINDOWS,
};

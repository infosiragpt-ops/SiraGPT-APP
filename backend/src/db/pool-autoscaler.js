// ──────────────────────────────────────────────────────────────
// siraGPT — Prisma Pool Autoscaler
// ──────────────────────────────────────────────────────────────
// Periodically samples pool metrics and proposes a new
// `connection_limit` for the Prisma client.
//
// Design notes
// ------------
// Prisma cannot mutate `connection_limit` on a live client; the
// only way to change it is to disconnect and re-instantiate with
// a different DATABASE_URL query string. The autoscaler therefore
// does not touch Prisma directly. Instead, it computes a target
// limit and invokes a caller-supplied `apply(newLimit, ctx)`
// callback. Without that callback the autoscaler is advisory-only:
// it records a recommendation but never claims the live pool changed.
//
// The autoscaler has hard caps (min/max) sourced from env, a
// cooldown to avoid flapping, and asymmetric scale-up/scale-down
// thresholds so spikes scale up fast but releases settle slowly.
// ──────────────────────────────────────────────────────────────

'use strict';

const AUTOSCALE_POOL_LIMIT_BOUNDS = Object.freeze({ min: 1, max: 100 });
const AUTOSCALE_INTERVAL_MS_BOUNDS = Object.freeze({ min: 1_000, max: 3_600_000 });
const AUTOSCALE_COLD_SAMPLE_BOUNDS = Object.freeze({ min: 1, max: 20 });
const DEFAULT_INTERVAL_MS = parseStrictInteger(
    process.env.DATABASE_POOL_AUTOSCALE_INTERVAL_MS,
    30_000,
    AUTOSCALE_INTERVAL_MS_BOUNDS
);
const DEFAULT_MIN_LIMIT = parseStrictInteger(
    process.env.DATABASE_POOL_AUTOSCALE_MIN,
    2,
    AUTOSCALE_POOL_LIMIT_BOUNDS
);
const DEFAULT_MAX_LIMIT = Math.max(
    DEFAULT_MIN_LIMIT,
    parseStrictInteger(
        process.env.DATABASE_POOL_AUTOSCALE_MAX,
        50,
        AUTOSCALE_POOL_LIMIT_BOUNDS
    )
);
const DEFAULT_COLD_SAMPLES_REQUIRED = parseStrictInteger(
    process.env.DATABASE_POOL_AUTOSCALE_COLD_SAMPLES,
    3,
    AUTOSCALE_COLD_SAMPLE_BOUNDS
);
const DEFAULT_SCALE_UP_RATIO = 0.8;
const DEFAULT_SCALE_DOWN_RATIO = 0.3;
const DEFAULT_SCALE_UP_STEP = 2;
const DEFAULT_SCALE_DOWN_STEP = 1;
const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_WAIT_MS_THRESHOLD = 50;
const DEFAULT_HISTORY_LEN = 20;

function noop() {}

function clamp(n, lo, hi) {
    if (!Number.isFinite(n)) return lo;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return Math.round(n);
}

function parseStrictInteger(value, fallback, bounds) {
    function parse(candidate) {
        if (Number.isSafeInteger(candidate)) return candidate;
        if (typeof candidate !== 'string') return null;
        const text = candidate.trim();
        if (!/^[+-]?\d+$/.test(text)) return null;
        const parsed = Number(text);
        return Number.isSafeInteger(parsed) ? parsed : null;
    }

    const parsed = parse(value);
    const fallbackValue = parse(fallback);
    const candidate = parsed === null ? fallbackValue : parsed;
    const safe = candidate === null ? bounds.min : candidate;
    return Math.min(bounds.max, Math.max(bounds.min, safe));
}

function readActualLimit(snapshot, fallback) {
    const value = Number(snapshot && snapshot.pool && snapshot.pool.max);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * Decide a new pool limit from a single metrics snapshot.
 *
 * Pure function: deterministic, no side effects. Exposed so
 * tests (and external schedulers) can drive the policy without
 * starting an interval.
 *
 * Returns one of:
 *   { action: 'hold',     reason: '...' }
 *   { action: 'scale_up', from, to, reason }
 *   { action: 'scale_down', from, to, reason }
 */
function decide(snapshot, cfg) {
    const current = readActualLimit(snapshot, cfg.minLimit);
    const ratio = Number(snapshot && snapshot.estimated_saturation_ratio) || 0;
    const wait = Number(snapshot && snapshot.avg_wait_ms) || 0;
    const inFlight = Number(snapshot && snapshot.queries_in_flight) || 0;

    // Policy bounds constrain recommendations, never the observed live pool.
    // If the datasource was configured outside this autoscaler's range, make
    // that discrepancy explicit rather than rewriting `from` in telemetry.
    if (current < cfg.minLimit) {
        return {
            action: 'scale_up',
            from: current,
            to: cfg.minLimit,
            reason: `actual limit ${current} < policy minimum ${cfg.minLimit}`,
        };
    }
    if (current > cfg.maxLimit) {
        return {
            action: 'scale_down',
            from: current,
            to: cfg.maxLimit,
            reason: `actual limit ${current} > policy maximum ${cfg.maxLimit}`,
        };
    }

    // Strong signal: pool already topped out and queries are queueing.
    const queueingHard = wait >= cfg.waitMsThreshold;
    const hot = ratio >= cfg.scaleUpRatio || queueingHard;
    const cold = ratio <= cfg.scaleDownRatio && wait < cfg.waitMsThreshold;

    if (hot && current < cfg.maxLimit) {
        const step = queueingHard ? cfg.scaleUpStep * 2 : cfg.scaleUpStep;
        const target = clamp(current + step, cfg.minLimit, cfg.maxLimit);
        if (target > current) {
            return {
                action: 'scale_up',
                from: current,
                to: target,
                reason: queueingHard
                    ? `wait ${wait.toFixed(1)}ms ≥ ${cfg.waitMsThreshold}ms`
                    : `saturation ${ratio.toFixed(2)} ≥ ${cfg.scaleUpRatio}`,
            };
        }
    }

    if (cold && current > cfg.minLimit && inFlight < current) {
        const target = clamp(current - cfg.scaleDownStep, cfg.minLimit, cfg.maxLimit);
        if (target < current) {
            return {
                action: 'scale_down',
                from: current,
                to: target,
                reason: `saturation ${ratio.toFixed(2)} ≤ ${cfg.scaleDownRatio}`,
                cold: true,
            };
        }
    }

    return { action: 'hold', reason: hot ? 'at_max' : cold ? 'at_min_or_busy' : 'within_band' };
}

/**
 * Build a pool autoscaler.
 *
 * @param {object} opts
 * @param {object} opts.metrics            Pool metrics handle (must expose snapshot()).
 * @param {Function} [opts.apply]          async (newLimit, ctx) => void. Caller is
 *                                         responsible for actually re-creating the
 *                                         Prisma client with the new connection_limit.
 *                                         If omitted, the autoscaler is dry-run.
 * @param {number} [opts.intervalMs]       Sampling cadence (default 30s).
 * @param {number} [opts.minLimit]         Hard floor (env DATABASE_POOL_AUTOSCALE_MIN).
 * @param {number} [opts.maxLimit]         Hard cap   (env DATABASE_POOL_AUTOSCALE_MAX).
 * @param {number} [opts.scaleUpRatio]
 * @param {number} [opts.scaleDownRatio]
 * @param {number} [opts.scaleUpStep]
 * @param {number} [opts.scaleDownStep]
 * @param {number} [opts.cooldownMs]
 * @param {number} [opts.waitMsThreshold]
 * @param {Function} [opts.logger]         (level, msg, meta) => void
 * @param {Function} [opts.now]            Clock (defaults to Date.now)
 * @param {object}   [opts.scheduler]      { setInterval, clearInterval } — for tests
 */
function createPoolAutoscaler(opts = {}) {
    if (!opts.metrics || typeof opts.metrics.snapshot !== 'function') {
        throw new TypeError('createPoolAutoscaler: metrics.snapshot() is required');
    }

    const initialSnapshot = opts.metrics.snapshot();
    if (initialSnapshot?.capacity?.observable === false) {
        throw new TypeError('createPoolAutoscaler: pool capacity is unobservable');
    }

    const minLimit = parseStrictInteger(
        opts.minLimit,
        DEFAULT_MIN_LIMIT,
        AUTOSCALE_POOL_LIMIT_BOUNDS
    );
    let maxLimit = parseStrictInteger(
        opts.maxLimit,
        DEFAULT_MAX_LIMIT,
        AUTOSCALE_POOL_LIMIT_BOUNDS
    );
    if (maxLimit < minLimit) maxLimit = minLimit;

    const cfg = {
        minLimit,
        maxLimit,
        scaleUpRatio: Number.isFinite(opts.scaleUpRatio) ? opts.scaleUpRatio : DEFAULT_SCALE_UP_RATIO,
        scaleDownRatio: Number.isFinite(opts.scaleDownRatio) ? opts.scaleDownRatio : DEFAULT_SCALE_DOWN_RATIO,
        scaleUpStep: parseStrictInteger(opts.scaleUpStep, DEFAULT_SCALE_UP_STEP, AUTOSCALE_POOL_LIMIT_BOUNDS),
        scaleDownStep: parseStrictInteger(opts.scaleDownStep, DEFAULT_SCALE_DOWN_STEP, AUTOSCALE_POOL_LIMIT_BOUNDS),
        cooldownMs: parseStrictInteger(opts.cooldownMs, DEFAULT_COOLDOWN_MS, {
            min: 0,
            max: AUTOSCALE_INTERVAL_MS_BOUNDS.max,
        }),
        waitMsThreshold: Number.isFinite(opts.waitMsThreshold)
            ? opts.waitMsThreshold
            : DEFAULT_WAIT_MS_THRESHOLD,
        coldSamplesRequired: parseStrictInteger(
            opts.coldSamplesRequired,
            DEFAULT_COLD_SAMPLES_REQUIRED,
            AUTOSCALE_COLD_SAMPLE_BOUNDS
        ),
    };

    const intervalMs = parseStrictInteger(
        opts.intervalMs,
        DEFAULT_INTERVAL_MS,
        AUTOSCALE_INTERVAL_MS_BOUNDS
    );
    const log = typeof opts.logger === 'function' ? opts.logger : noop;
    const now = typeof opts.now === 'function' ? opts.now : Date.now;
    const scheduler = opts.scheduler || { setInterval, clearInterval };
    const apply = typeof opts.apply === 'function' ? opts.apply : null;

    let timer = null;
    let lastDecisionAt = 0;
    let lastRecommendationAt = 0;
    let lastAppliedAt = 0;
    let lastAction = 'hold';
    let lastRecommendation = 'hold';
    let currentLimit = readActualLimit(initialSnapshot, minLimit);
    let recommendedLimit = currentLimit;
    let coldSamples = 0;
    const history = [];
    const stats = {
        ticks: 0,
        scaleUps: 0,
        scaleDowns: 0,
        holds: 0,
        recommendations: 0,
        recommendationUps: 0,
        recommendationDowns: 0,
        appliedChanges: 0,
        applyErrors: 0,
        lastError: null,
    };

    function recordHistory(entry) {
        history.push(entry);
        if (history.length > DEFAULT_HISTORY_LEN) history.shift();
    }

    async function tick() {
        stats.ticks += 1;
        const snap = opts.metrics.snapshot();
        // In advisory mode the instrumentation snapshot is the sole source of
        // truth for the actual live limit. Recommendations must never drift it.
        if (!apply) {
            currentLimit = readActualLimit(snap, currentLimit);
        }
        const rawDecision = decide(snap, cfg);
        if (rawDecision.cold) coldSamples += 1;
        else coldSamples = 0;

        let decision = rawDecision;
        if (rawDecision.cold && coldSamples < cfg.coldSamplesRequired) {
            decision = {
                action: 'hold',
                reason: `cold sample ${coldSamples}/${cfg.coldSamplesRequired}`,
                candidate: 'scale_down',
            };
        }
        const tickAt = now();
        lastDecisionAt = tickAt;

        const inCooldown =
            decision.action !== 'hold' &&
            lastRecommendationAt > 0 &&
            tickAt - lastRecommendationAt < cfg.cooldownMs;

        const entry = {
            t: tickAt,
            estimated_saturation_ratio: snap.estimated_saturation_ratio,
            avg_wait_ms: snap.avg_wait_ms,
            queries_in_flight: snap.queries_in_flight,
            current: currentLimit,
            decision: decision.action,
            reason: decision.reason,
            coldSamples,
            cooldown: inCooldown,
            advisory: !apply,
            applied: false,
        };
        if (decision.candidate) entry.candidate = decision.candidate;

        if (decision.action === 'hold' || inCooldown) {
            stats.holds += 1;
            if (decision.action === 'hold' && !inCooldown) {
                recommendedLimit = currentLimit;
                lastRecommendation = 'hold';
            }
            entry.recommendedLimit = recommendedLimit;
            recordHistory(entry);
            return entry;
        }

        const target = decision.to;
        recommendedLimit = target;
        lastRecommendation = decision.action;
        lastRecommendationAt = tickAt;
        entry.recommendedLimit = target;
        entry.to = target;
        stats.recommendations += 1;
        if (decision.action === 'scale_up') stats.recommendationUps += 1;
        else stats.recommendationDowns += 1;

        if (!apply) {
            log(
                'info',
                `[db.pool.autoscale] recommend ${decision.action} `
                + `${decision.from}→${target} (${decision.reason})`
            );
            recordHistory(entry);
            return entry;
        }

        try {
            await apply(target, { from: decision.from, reason: decision.reason, snapshot: snap });
            currentLimit = target;
            lastAppliedAt = tickAt;
            lastAction = decision.action;
            stats.appliedChanges += 1;
            if (decision.action === 'scale_up') stats.scaleUps += 1;
            else stats.scaleDowns += 1;
            log('info', `[db.pool.autoscale] ${decision.action} ${decision.from}→${target} (${decision.reason})`);
            entry.applied = true;
        } catch (err) {
            stats.applyErrors += 1;
            stats.lastError = err && err.message ? err.message : String(err);
            log('error', `[db.pool.autoscale] apply failed: ${stats.lastError}`);
            entry.applied = false;
            entry.error = stats.lastError;
        }
        recordHistory(entry);
        return entry;
    }

    function start() {
        if (timer) return;
        timer = scheduler.setInterval(() => {
            tick().catch((err) => log('error', `[db.pool.autoscale] tick threw: ${err && err.message}`));
        }, intervalMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
        log('info', `[db.pool.autoscale] started (every ${intervalMs}ms, range ${minLimit}..${maxLimit})`);
    }

    function stop() {
        if (!timer) return;
        scheduler.clearInterval(timer);
        timer = null;
        log('info', '[db.pool.autoscale] stopped');
    }

    function getState() {
        return {
            running: !!timer,
            mode: apply ? 'apply' : 'advisory',
            currentLimit,
            recommendedLimit,
            minLimit: cfg.minLimit,
            maxLimit: cfg.maxLimit,
            intervalMs,
            lastAction,
            lastRecommendation,
            lastDecisionAt: lastDecisionAt || null,
            lastRecommendationAt: lastRecommendationAt || null,
            lastAppliedAt: lastAppliedAt || null,
            coldSamples,
            stats: { ...stats },
            history: history.slice(),
            config: { ...cfg },
        };
    }

    return {
        start,
        stop,
        tick,
        getState,
        get currentLimit() { return currentLimit; },
        get recommendedLimit() { return recommendedLimit; },
        get running() { return !!timer; },
    };
}

module.exports = {
    createPoolAutoscaler,
    decide,
    DEFAULT_INTERVAL_MS,
    DEFAULT_MIN_LIMIT,
    DEFAULT_MAX_LIMIT,
    DEFAULT_SCALE_UP_RATIO,
    DEFAULT_SCALE_DOWN_RATIO,
    DEFAULT_SCALE_UP_STEP,
    DEFAULT_SCALE_DOWN_STEP,
    DEFAULT_COOLDOWN_MS,
    DEFAULT_WAIT_MS_THRESHOLD,
    DEFAULT_COLD_SAMPLES_REQUIRED,
    AUTOSCALE_POOL_LIMIT_BOUNDS,
    AUTOSCALE_INTERVAL_MS_BOUNDS,
    AUTOSCALE_COLD_SAMPLE_BOUNDS,
    parseStrictInteger,
};

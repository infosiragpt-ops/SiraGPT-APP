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
// callback. Callers can either:
//
//   - Reconnect Prisma with the new `?connection_limit=N` URL
//   - Or use the convenience hook to mutate the in-memory pool
//     metrics' `poolMax` so that saturation reporting reflects
//     the new target until the next reconnect cycle.
//
// The autoscaler has hard caps (min/max) sourced from env, a
// cooldown to avoid flapping, and asymmetric scale-up/scale-down
// thresholds so spikes scale up fast but releases settle slowly.
// ──────────────────────────────────────────────────────────────

'use strict';

const DEFAULT_INTERVAL_MS = parseInt(
    process.env.DATABASE_POOL_AUTOSCALE_INTERVAL_MS || '30000',
    10
);
const DEFAULT_MIN_LIMIT = parseInt(
    process.env.DATABASE_POOL_AUTOSCALE_MIN || '2',
    10
);
const DEFAULT_MAX_LIMIT = parseInt(
    process.env.DATABASE_POOL_AUTOSCALE_MAX || '50',
    10
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

function asPositiveInt(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
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
    const current = clamp(
        snapshot && snapshot.pool ? snapshot.pool.max : cfg.minLimit,
        cfg.minLimit,
        cfg.maxLimit
    );
    const ratio = Number(snapshot && snapshot.saturation_ratio) || 0;
    const wait = Number(snapshot && snapshot.avg_wait_ms) || 0;
    const inFlight = Number(snapshot && snapshot.queries_in_flight) || 0;

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

    const minLimit = asPositiveInt(opts.minLimit, DEFAULT_MIN_LIMIT);
    let maxLimit = asPositiveInt(opts.maxLimit, DEFAULT_MAX_LIMIT);
    if (maxLimit < minLimit) maxLimit = minLimit;

    const cfg = {
        minLimit,
        maxLimit,
        scaleUpRatio: Number.isFinite(opts.scaleUpRatio) ? opts.scaleUpRatio : DEFAULT_SCALE_UP_RATIO,
        scaleDownRatio: Number.isFinite(opts.scaleDownRatio) ? opts.scaleDownRatio : DEFAULT_SCALE_DOWN_RATIO,
        scaleUpStep: asPositiveInt(opts.scaleUpStep, DEFAULT_SCALE_UP_STEP),
        scaleDownStep: asPositiveInt(opts.scaleDownStep, DEFAULT_SCALE_DOWN_STEP),
        cooldownMs: Number.isFinite(opts.cooldownMs) ? opts.cooldownMs : DEFAULT_COOLDOWN_MS,
        waitMsThreshold: Number.isFinite(opts.waitMsThreshold)
            ? opts.waitMsThreshold
            : DEFAULT_WAIT_MS_THRESHOLD,
    };

    const intervalMs = asPositiveInt(opts.intervalMs, DEFAULT_INTERVAL_MS);
    const log = typeof opts.logger === 'function' ? opts.logger : noop;
    const now = typeof opts.now === 'function' ? opts.now : Date.now;
    const scheduler = opts.scheduler || { setInterval, clearInterval };
    const apply = typeof opts.apply === 'function' ? opts.apply : null;

    let timer = null;
    let lastDecisionAt = 0;
    let lastAction = 'hold';
    let currentLimit = clamp(
        opts.metrics.snapshot().pool && opts.metrics.snapshot().pool.max,
        minLimit,
        maxLimit
    );
    const history = [];
    const stats = {
        ticks: 0,
        scaleUps: 0,
        scaleDowns: 0,
        holds: 0,
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
        const decision = decide(snap, cfg);

        const inCooldown =
            decision.action !== 'hold' &&
            lastDecisionAt > 0 &&
            now() - lastDecisionAt < cfg.cooldownMs;

        const entry = {
            t: now(),
            saturation_ratio: snap.saturation_ratio,
            avg_wait_ms: snap.avg_wait_ms,
            queries_in_flight: snap.queries_in_flight,
            current: currentLimit,
            decision: decision.action,
            reason: decision.reason,
            cooldown: inCooldown,
        };

        if (decision.action === 'hold' || inCooldown) {
            stats.holds += 1;
            lastAction = 'hold';
            recordHistory(entry);
            return entry;
        }

        const target = decision.to;
        try {
            if (apply) {
                await apply(target, { from: decision.from, reason: decision.reason, snapshot: snap });
            }
            currentLimit = target;
            lastDecisionAt = now();
            lastAction = decision.action;
            if (decision.action === 'scale_up') stats.scaleUps += 1;
            else stats.scaleDowns += 1;
            log('info', `[db.pool.autoscale] ${decision.action} ${decision.from}→${target} (${decision.reason})`);
            entry.applied = true;
            entry.to = target;
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
            currentLimit,
            minLimit: cfg.minLimit,
            maxLimit: cfg.maxLimit,
            intervalMs,
            lastAction,
            lastDecisionAt: lastDecisionAt || null,
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
};

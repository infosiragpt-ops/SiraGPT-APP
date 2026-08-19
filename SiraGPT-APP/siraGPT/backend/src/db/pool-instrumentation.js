// ──────────────────────────────────────────────────────────────
// siraGPT — Prisma Pool Instrumentation
// ──────────────────────────────────────────────────────────────
// Wraps a PrismaClient with a lightweight in-flight tracker so the
// process can report queue depth, current saturation, query latency
// histograms and total throughput.
//
// Prisma does not expose its internal libpq pool counters at the JS
// layer, so we approximate the pool state from observable signals:
//
//   queries_in_flight  — exact (we increment on $use, decrement after)
//   connections_active — min(in_flight, pool_max)
//   connections_idle   — max(0, pool_max - in_flight)
//   wait_time_ms       — exponential moving average of P2024-classified
//                        latency (queue waits) plus running sum/avg.
//
// The middleware is opt-in: `instrumentPool(prisma, { poolMax })`
// returns a metrics object with `snapshot()` plus a `dispose()` hook.
// ──────────────────────────────────────────────────────────────

'use strict';

const DEFAULT_POOL_MAX = parseInt(process.env.DATABASE_POOL_MAX || '10', 10);
const DEFAULT_POOL_MIN = parseInt(process.env.DATABASE_POOL_MIN || '2', 10);
const DEFAULT_IDLE_TIMEOUT_MS = parseInt(
    process.env.DATABASE_POOL_IDLE_TIMEOUT_MS || '60000',
    10
);
const SATURATION_WARN_RATIO = 0.8;
const SATURATION_CRIT_RATIO = 0.95;

function nowMs() {
    return Date.now();
}

function safeNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function createMetricsState(poolMax) {
    return {
        poolMax,
        inFlight: 0,
        peakInFlight: 0,
        totalQueries: 0,
        totalErrors: 0,
        totalRetries: 0,
        totalLatencyMs: 0,
        totalWaitMs: 0,
        // EMA approximation: 1/8 weight on the new sample
        avgLatencyMs: 0,
        avgWaitMs: 0,
        startedAt: nowMs(),
        lastQueryAt: 0,
    };
}

function updateEma(prev, sample, weight = 0.125) {
    if (prev <= 0) return sample;
    return prev + weight * (sample - prev);
}

/**
 * Wrap a PrismaClient with pool metrics middleware.
 *
 * Returns a metrics handle that does NOT mutate the client beyond
 * registering a `$use` middleware. The handle exposes:
 *   - snapshot()   — current metrics object suitable for /health
 *   - reset()      — zero counters (preserves config)
 *   - dispose()    — clear listeners; no-op for $use middleware
 *
 * @param {object} prisma  PrismaClient instance
 * @param {object} [opts]
 * @param {number} [opts.poolMax]   Override DATABASE_POOL_MAX
 * @param {number} [opts.poolMin]   Override DATABASE_POOL_MIN
 * @param {number} [opts.idleTimeoutMs]
 * @param {Function} [opts.onQuery] Callback ({ model, action, ms, error })
 */
function instrumentPool(prisma, opts = {}) {
    if (!prisma || typeof prisma !== 'object') {
        throw new TypeError('instrumentPool: prisma client is required');
    }

    const poolMax = safeNumber(opts.poolMax, DEFAULT_POOL_MAX);
    const poolMin = safeNumber(opts.poolMin, DEFAULT_POOL_MIN);
    const idleTimeoutMs = safeNumber(opts.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);

    const state = createMetricsState(poolMax);
    let installed = false;

    async function middleware(params, next) {
        const t0 = nowMs();
        state.inFlight += 1;
        state.totalQueries += 1;
        state.lastQueryAt = t0;
        if (state.inFlight > state.peakInFlight) {
            state.peakInFlight = state.inFlight;
        }

        // queries that enter while pool is saturated effectively wait.
        // We attribute the difference between t0 and tStart to wait if
        // in_flight already >= pool_max at entry (best-effort signal).
        const sawSaturation = state.inFlight > poolMax;
        const tStart = nowMs();

        try {
            const result = await next(params);
            const ms = nowMs() - tStart;
            const wait = sawSaturation ? Math.max(0, tStart - t0) : 0;
            state.totalLatencyMs += ms;
            state.totalWaitMs += wait;
            state.avgLatencyMs = updateEma(state.avgLatencyMs, ms);
            state.avgWaitMs = updateEma(state.avgWaitMs, wait);
            if (typeof opts.onQuery === 'function') {
                try {
                    opts.onQuery({
                        model: params.model,
                        action: params.action,
                        ms,
                        wait,
                        error: null,
                    });
                } catch (_) { /* user callback must not break the query */ }
            }
            return result;
        } catch (err) {
            const ms = nowMs() - tStart;
            state.totalLatencyMs += ms;
            state.totalErrors += 1;
            if (err && err.code === 'P2024') {
                // Pool timeout — treated as a wait sample
                state.totalWaitMs += ms;
                state.avgWaitMs = updateEma(state.avgWaitMs, ms);
            }
            if (typeof opts.onQuery === 'function') {
                try {
                    opts.onQuery({
                        model: params.model,
                        action: params.action,
                        ms,
                        wait: 0,
                        error: err,
                    });
                } catch (_) { /* swallow */ }
            }
            throw err;
        } finally {
            state.inFlight = Math.max(0, state.inFlight - 1);
        }
    }

    if (typeof prisma.$use === 'function') {
        prisma.$use(middleware);
        installed = true;
    }

    function snapshot() {
        const inFlight = state.inFlight;
        const active = Math.min(inFlight, poolMax);
        const idle = Math.max(0, poolMax - active);
        const saturationRatio = poolMax > 0 ? inFlight / poolMax : 0;

        let saturation = 'ok';
        if (saturationRatio >= SATURATION_CRIT_RATIO) saturation = 'critical';
        else if (saturationRatio >= SATURATION_WARN_RATIO) saturation = 'warn';

        return {
            pool: {
                min: poolMin,
                max: poolMax,
                idleTimeoutMs,
            },
            connections_active: active,
            connections_idle: idle,
            queries_in_flight: inFlight,
            peak_in_flight: state.peakInFlight,
            total_queries: state.totalQueries,
            total_errors: state.totalErrors,
            total_retries: state.totalRetries,
            avg_latency_ms: Math.round(state.avgLatencyMs * 100) / 100,
            avg_wait_ms: Math.round(state.avgWaitMs * 100) / 100,
            total_wait_ms: state.totalWaitMs,
            total_latency_ms: state.totalLatencyMs,
            saturation_ratio: Math.round(saturationRatio * 1000) / 1000,
            saturation,
            uptime_ms: nowMs() - state.startedAt,
            last_query_at: state.lastQueryAt || null,
            installed,
        };
    }

    function reset() {
        const inFlight = state.inFlight;
        const peak = state.peakInFlight;
        Object.assign(state, createMetricsState(poolMax));
        // preserve the live counter — don't lose track of in-flight work
        state.inFlight = inFlight;
        state.peakInFlight = peak;
    }

    function recordRetry() {
        state.totalRetries += 1;
    }

    function dispose() {
        // $use middleware can't be removed in current Prisma versions.
        // We mark installed=false so snapshot() reflects detached state.
        installed = false;
    }

    /**
     * Build a healthcheck-shaped report for the pool. Plugs into the
     * `runFullHealthCheck` flow as `{ name: 'db.pool', ... }`.
     */
    function toHealthCheck() {
        const snap = snapshot();
        let status = 'healthy';
        if (snap.saturation === 'critical') status = 'unhealthy';
        else if (snap.saturation === 'warn') status = 'degraded';
        return {
            name: 'db.pool',
            status,
            critical: false,
            latency_ms: 0,
            details: snap,
        };
    }

    return {
        snapshot,
        reset,
        recordRetry,
        dispose,
        toHealthCheck,
        get installed() { return installed; },
    };
}

module.exports = {
    instrumentPool,
    DEFAULT_POOL_MAX,
    DEFAULT_POOL_MIN,
    DEFAULT_IDLE_TIMEOUT_MS,
    SATURATION_WARN_RATIO,
    SATURATION_CRIT_RATIO,
};

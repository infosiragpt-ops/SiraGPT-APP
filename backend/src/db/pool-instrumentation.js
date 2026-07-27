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
//   estimated_connections_active — min(in_flight, configured pool_max)
//   estimated_connections_idle   — max(0, configured pool_max - in_flight)
//   estimated_saturation_* — derived from in_flight / configured pool_max
//   pool_timeout_*     — observed P2024 event count and last occurrence
//
// Prisma does not expose how long a successful query waited for a connection.
// Operation latency is not queue wait, so this module deliberately publishes
// no successful-query wait metric.
//
// Instrumentation is opt-in: `instrumentPool(prisma, { poolMax })`
// returns a metrics object with `snapshot()`, a `dispose()` hook, and
// `client`. On Prisma versions without the removed `$use` API, `client`
// is a query-extension client that callers must use as their shared client.
// ──────────────────────────────────────────────────────────────

'use strict';

const MIN_POOL_SIZE = 1;
const MAX_POOL_SIZE = 100;
const DEFAULT_POOL_MAX = normalizePoolSize(process.env.DATABASE_POOL_MAX, 10);
const DEFAULT_POOL_MIN = Math.min(
    normalizePoolSize(process.env.DATABASE_POOL_MIN, 2),
    DEFAULT_POOL_MAX
);
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

function normalizePoolSize(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(MAX_POOL_SIZE, Math.max(MIN_POOL_SIZE, Math.floor(n)));
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
        poolTimeoutCount: 0,
        lastPoolTimeoutAt: 0,
        // EMA approximation: 1/8 weight on the new sample
        avgLatencyMs: 0,
        startedAt: nowMs(),
        lastQueryAt: 0,
    };
}

function updateEma(prev, sample, weight = 0.125) {
    if (prev <= 0) return sample;
    return prev + weight * (sample - prev);
}

function preserveEventSurface(client, prisma) {
    if (
        !client
        || typeof client.$on === 'function'
        || typeof prisma.$on !== 'function'
    ) {
        return client;
    }
    const delegatedOn = prisma.$on.bind(prisma);
    try {
        Object.defineProperty(client, '$on', {
            configurable: true,
            enumerable: false,
            writable: false,
            value: delegatedOn,
        });
        return client;
    } catch {
        // Prisma's extension client is a Proxy whose defineProperty trap
        // rejects reserved client methods and exposes a non-configurable
        // `$on: undefined` descriptor. Proxying that object directly would
        // violate JavaScript Proxy invariants, so use an empty facade target
        // and delegate reads/writes to the extension client.
        const facade = Object.create(null);
        return new Proxy(facade, {
            get(target, property) {
                if (property === '$on') return delegatedOn;
                if (Reflect.has(target, property)) return Reflect.get(target, property);
                return Reflect.get(client, property, client);
            },
            set(target, property, value) {
                try {
                    if (Reflect.set(client, property, value, client)) return true;
                } catch { /* keep wrapper-local override */ }
                return Reflect.set(target, property, value);
            },
            has(_target, property) {
                if (property === '$on') return true;
                return Reflect.has(facade, property) || Reflect.has(client, property);
            },
        });
    }
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

    const poolMax = normalizePoolSize(opts.poolMax, DEFAULT_POOL_MAX);
    const poolMin = Math.min(
        normalizePoolSize(opts.poolMin, DEFAULT_POOL_MIN),
        poolMax
    );
    const idleTimeoutMs = safeNumber(opts.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
    const capacityObservable = opts.capacityObservable !== false;
    const capacityReason = typeof opts.capacityReason === 'string' && opts.capacityReason
        ? opts.capacityReason
        : capacityObservable
            ? 'direct_postgres_datasource'
            : 'pool_capacity_unobservable';

    const state = createMetricsState(poolMax);
    let installed = false;
    let instrumentation = 'none';
    let client = prisma;

    async function trackOperation(params, execute) {
        if (!installed) return execute();
        const t0 = nowMs();
        state.inFlight += 1;
        state.totalQueries += 1;
        state.lastQueryAt = t0;
        if (state.inFlight > state.peakInFlight) {
            state.peakInFlight = state.inFlight;
        }

        const tStart = nowMs();

        try {
            const result = await execute();
            const ms = nowMs() - tStart;
            state.totalLatencyMs += ms;
            state.avgLatencyMs = updateEma(state.avgLatencyMs, ms);
            if (typeof opts.onQuery === 'function') {
                try {
                    opts.onQuery({
                        model: params.model,
                        action: params.action,
                        ms,
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
                state.poolTimeoutCount += 1;
                state.lastPoolTimeoutAt = nowMs();
            }
            if (typeof opts.onQuery === 'function') {
                try {
                    opts.onQuery({
                        model: params.model,
                        action: params.action,
                        ms,
                        error: err,
                    });
                } catch (_) { /* swallow */ }
            }
            throw err;
        } finally {
            state.inFlight = Math.max(0, state.inFlight - 1);
        }
    }

    async function middleware(params, next) {
        return trackOperation(params, () => next(params));
    }

    async function queryExtensionOperation({ model, operation, args, query }) {
        return trackOperation(
            { model, action: operation },
            () => query(args)
        );
    }

    if (typeof prisma.$use === 'function') {
        prisma.$use(middleware);
        installed = true;
        instrumentation = 'middleware';
    } else if (typeof prisma.$extends === 'function') {
        try {
            const extended = prisma.$extends({
                name: 'siragpt-pool-instrumentation',
                query: {
                    $allOperations: queryExtensionOperation,
                },
            });
            if (extended && (typeof extended === 'object' || typeof extended === 'function')) {
                client = preserveEventSurface(extended, prisma);
                installed = true;
                instrumentation = 'query_extension';
            }
        } catch (_) {
            // Fail open for unsupported/custom Prisma clients. The snapshot
            // reports `installed:false` so health makes the limitation visible.
        }
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
            capacity: {
                observable: capacityObservable,
                reason: capacityReason,
            },
            pool: capacityObservable
                ? {
                    min: poolMin,
                    max: poolMax,
                    idleTimeoutMs,
                }
                : null,
            estimated_connections_active: capacityObservable ? active : null,
            estimated_connections_idle: capacityObservable ? idle : null,
            queries_in_flight: inFlight,
            peak_in_flight: state.peakInFlight,
            total_queries: state.totalQueries,
            total_errors: state.totalErrors,
            total_retries: state.totalRetries,
            avg_latency_ms: Math.round(state.avgLatencyMs * 100) / 100,
            pool_timeout_count: state.poolTimeoutCount,
            last_pool_timeout_at: state.lastPoolTimeoutAt || null,
            total_latency_ms: state.totalLatencyMs,
            estimated_saturation_ratio: capacityObservable
                ? Math.round(saturationRatio * 1000) / 1000
                : null,
            estimated_saturation: capacityObservable ? saturation : 'unobservable',
            uptime_ms: nowMs() - state.startedAt,
            last_query_at: state.lastQueryAt || null,
            installed,
            instrumentation,
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
        // Prisma middleware/extensions cannot be removed. The wrapper checks
        // this flag and becomes a pass-through after disposal.
        installed = false;
        instrumentation = 'none';
    }

    /**
     * Build a healthcheck-shaped report for the pool. Plugs into the
     * `runFullHealthCheck` flow as `{ name: 'db.pool', ... }`.
     */
    function toHealthCheck() {
        const snap = snapshot();
        if (!snap.capacity.observable) {
            return {
                name: 'db.pool',
                status: 'skipped',
                critical: false,
                latency_ms: 0,
                details: {
                    capacity: snap.capacity,
                    reason: 'pool_capacity_unobservable',
                },
            };
        }
        let status = 'healthy';
        if (snap.estimated_saturation === 'critical') status = 'degraded';
        else if (snap.estimated_saturation === 'warn') status = 'degraded';
        return {
            name: 'db.pool',
            status,
            critical: false,
            latency_ms: 0,
            details: snap,
        };
    }

    return {
        client,
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
    MIN_POOL_SIZE,
    MAX_POOL_SIZE,
    DEFAULT_IDLE_TIMEOUT_MS,
    SATURATION_WARN_RATIO,
    SATURATION_CRIT_RATIO,
};

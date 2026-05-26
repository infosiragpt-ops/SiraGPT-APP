// ──────────────────────────────────────────────────────────────
// siraGPT — Read Replica Router
// ──────────────────────────────────────────────────────────────
// When `DATABASE_URL_RO` is configured, queries that are marked
// `readonly` are dispatched to the replica client; everything else
// (and every query when no replica is configured) goes to primary.
//
// The router is designed to wrap any client that exposes a callable
// surface (Prisma, pg, knex, …) — it does not assume a particular
// API. Callers express a query as `{ readonly: boolean, name? }` and
// receive back the chosen client through `pick()` or run their work
// through `execute()` to also collect routing metrics.
// ──────────────────────────────────────────────────────────────

'use strict';

const TARGET_PRIMARY = 'primary';
const TARGET_REPLICA = 'replica';

function nowMs() { return Date.now(); }

function isReadonly(query) {
    if (!query) return false;
    return query.readonly === true || query.readOnly === true;
}

function classify(query) {
    if (!query) return { readonly: false };
    if (isReadonly(query)) return { readonly: true };
    if (typeof query.action === 'string') {
        const a = query.action.toLowerCase();
        if (a === 'findmany' || a === 'findunique' || a === 'findfirst'
            || a === 'count' || a === 'aggregate' || a === 'groupby') {
            return { readonly: true };
        }
    }
    if (typeof query.sql === 'string') {
        const head = query.sql.trim().slice(0, 6).toLowerCase();
        if (head.startsWith('select') || head.startsWith('show')) {
            return { readonly: true };
        }
    }
    return { readonly: false };
}

function newCounters() {
    return {
        primary: 0,
        replica: 0,
        readonlyOnPrimary: 0,
        replicaErrors: 0,
        replicaFallbacks: 0,
        lastRouteAt: 0,
    };
}

/**
 * Build a router that picks between a primary and replica client
 * based on whether the query is read-only and whether a replica was
 * configured (`replicaUrl` truthy AND `replica` client provided).
 *
 * @param {object} opts
 * @param {object} opts.primary       Required primary client
 * @param {object} [opts.replica]     Optional replica client
 * @param {string} [opts.replicaUrl]  Falsy → replica disabled
 * @param {boolean} [opts.fallbackOnError=true]
 *        When true, an error thrown by the replica during `execute()`
 *        is retried once on the primary and counted as a fallback.
 * @param {Function} [opts.logger]    (level, message, meta) => void
 */
function createReadReplicaRouter(opts = {}) {
    const { primary, replica, replicaUrl } = opts;
    if (!primary) {
        throw new Error('createReadReplicaRouter: `primary` client is required');
    }
    const fallbackOnError = opts.fallbackOnError !== false;
    const log = typeof opts.logger === 'function' ? opts.logger : () => {};
    const hasReplica = Boolean(replicaUrl) && Boolean(replica);
    const counters = newCounters();

    function pick(query) {
        const cls = classify(query);
        if (cls.readonly && hasReplica) return { target: TARGET_REPLICA, client: replica };
        if (cls.readonly && !hasReplica) {
            counters.readonlyOnPrimary += 1;
        }
        return { target: TARGET_PRIMARY, client: primary };
    }

    async function execute(query, handler) {
        if (typeof handler !== 'function') {
            throw new TypeError('execute(query, handler): handler must be a function');
        }
        const { target, client } = pick(query);
        counters.lastRouteAt = nowMs();

        if (target === TARGET_REPLICA) {
            counters.replica += 1;
            try {
                return await handler(client, { target });
            } catch (err) {
                counters.replicaErrors += 1;
                if (!fallbackOnError) throw err;
                counters.replicaFallbacks += 1;
                log('warn', '[db.replica] read failed, falling back to primary', {
                    name: query && query.name,
                    error: err && err.message,
                });
                counters.primary += 1;
                return handler(primary, { target: TARGET_PRIMARY, fellBack: true });
            }
        }

        counters.primary += 1;
        return handler(client, { target });
    }

    function snapshot() {
        return {
            hasReplica,
            replicaUrlConfigured: Boolean(replicaUrl),
            primary_queries: counters.primary,
            replica_queries: counters.replica,
            readonly_on_primary: counters.readonlyOnPrimary,
            replica_errors: counters.replicaErrors,
            replica_fallbacks: counters.replicaFallbacks,
            last_route_at: counters.lastRouteAt,
        };
    }

    function reset() {
        const next = newCounters();
        Object.assign(counters, next);
    }

    async function dispose() {
        const tasks = [];
        if (typeof primary?.$disconnect === 'function') tasks.push(primary.$disconnect());
        if (hasReplica && typeof replica?.$disconnect === 'function') tasks.push(replica.$disconnect());
        await Promise.allSettled(tasks);
    }

    return {
        hasReplica,
        primary,
        replica: hasReplica ? replica : null,
        pick,
        execute,
        classify,
        snapshot,
        reset,
        dispose,
    };
}

/**
 * Convenience factory that reads URLs from `env` (defaults to
 * process.env) and lazily builds clients via `makeClient(url, role)`.
 * If `DATABASE_URL_RO` is missing/empty the replica is not built.
 */
function createRouterFromEnv(opts = {}) {
    const env = opts.env || process.env;
    const primaryUrl = env.DATABASE_URL || opts.primaryUrl;
    const replicaUrl = env.DATABASE_URL_RO || opts.replicaUrl || '';
    const makeClient = opts.makeClient;
    if (typeof makeClient !== 'function') {
        throw new TypeError('createRouterFromEnv: `makeClient(url, role)` is required');
    }
    if (!primaryUrl) {
        throw new Error('createRouterFromEnv: DATABASE_URL is not set');
    }
    const primary = makeClient(primaryUrl, TARGET_PRIMARY);
    const replica = replicaUrl ? makeClient(replicaUrl, TARGET_REPLICA) : null;
    return createReadReplicaRouter({
        primary,
        replica,
        replicaUrl,
        fallbackOnError: opts.fallbackOnError,
        logger: opts.logger,
    });
}

module.exports = {
    createReadReplicaRouter,
    createRouterFromEnv,
    classify,
    TARGET_PRIMARY,
    TARGET_REPLICA,
};

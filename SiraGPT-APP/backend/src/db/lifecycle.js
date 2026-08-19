// ──────────────────────────────────────────────────────────────
// siraGPT — Database Lifecycle (graceful shutdown)
// ──────────────────────────────────────────────────────────────
// Registers SIGTERM/SIGINT handlers that drain the Prisma pool
// before exit. Drainage waits for in-flight queries (tracked by
// pool-instrumentation) to complete with a configurable grace
// period; once the deadline elapses the pool is forcibly
// disconnected so the process can exit.
//
// Why this matters
// ----------------
// Without graceful shutdown, a SIGTERM from the orchestrator
// (k8s rolling deploy, dyno cycle) terminates the process while
// requests are mid-transaction. PostgreSQL then logs hundreds of
// "client disconnected with active transaction" warnings and the
// connection slots stay reserved on the server side until the
// idle_in_transaction timeout fires.
//
// With drainage, in-flight queries finish, then $disconnect()
// closes the pool cleanly.
// ──────────────────────────────────────────────────────────────

'use strict';

const DEFAULT_GRACE_MS = parseInt(process.env.DATABASE_SHUTDOWN_GRACE_MS || '15000', 10);
const DEFAULT_POLL_MS = parseInt(process.env.DATABASE_SHUTDOWN_POLL_MS || '100', 10);
const DEFAULT_SIGNALS = ['SIGTERM', 'SIGINT'];

function noop() {}

/**
 * Wait until `getInFlight()` reports 0 or the deadline elapses.
 * Returns true if drained cleanly, false if timed out.
 */
async function waitForDrain({ getInFlight, gracePeriodMs, pollMs, logger }) {
    const start = Date.now();
    const log = logger || noop;

    while (Date.now() - start < gracePeriodMs) {
        let inflight = 0;
        try { inflight = Number(getInFlight()) || 0; } catch (_) { inflight = 0; }
        if (inflight <= 0) return true;
        log('debug', `[db.lifecycle] waiting for ${inflight} in-flight query(ies)`);
        await new Promise((r) => setTimeout(r, pollMs));
    }

    let final = 0;
    try { final = Number(getInFlight()) || 0; } catch (_) { final = 0; }
    return final <= 0;
}

/**
 * Run the disconnect sequence: drain, then $disconnect.
 *
 * Intentionally idempotent — calling twice is safe; the second call
 * resolves immediately. Used both by signal handlers and from tests.
 */
async function shutdownPool(ctx) {
    const {
        prisma,
        getInFlight,
        gracePeriodMs = DEFAULT_GRACE_MS,
        pollMs = DEFAULT_POLL_MS,
        logger,
        onState,
    } = ctx || {};
    const log = typeof logger === 'function' ? logger : noop;
    const emit = typeof onState === 'function' ? onState : noop;

    if (!prisma || typeof prisma.$disconnect !== 'function') {
        log('warn', '[db.lifecycle] no prisma client to shut down');
        return { drained: true, disconnected: false, reason: 'no_client' };
    }

    emit('draining');
    const drained = await waitForDrain({
        getInFlight: typeof getInFlight === 'function' ? getInFlight : () => 0,
        gracePeriodMs,
        pollMs,
        logger: log,
    });

    if (!drained) {
        log('warn', `[db.lifecycle] grace period ${gracePeriodMs}ms exceeded; forcing disconnect`);
    }

    emit('disconnecting');
    try {
        await prisma.$disconnect();
        log('info', '[db.lifecycle] prisma disconnected');
        emit('done');
        return { drained, disconnected: true, reason: drained ? 'clean' : 'forced' };
    } catch (err) {
        log('error', `[db.lifecycle] disconnect failed: ${err && err.message}`);
        emit('error');
        return { drained, disconnected: false, reason: 'disconnect_error', error: err };
    }
}

/**
 * Register process-level signal handlers that trigger pool drain
 * + disconnect. Returns an `unregister()` function so tests (and
 * embedded usage) can clean up.
 *
 * @param {object} cfg
 * @param {object} cfg.prisma            PrismaClient
 * @param {Function} [cfg.getInFlight]   () => number of in-flight queries
 * @param {string[]} [cfg.signals]       Defaults to SIGTERM/SIGINT
 * @param {number} [cfg.gracePeriodMs]
 * @param {number} [cfg.pollMs]
 * @param {Function} [cfg.logger]        (level, message) => void
 * @param {boolean} [cfg.exitProcess]    Default true; set false for tests
 * @param {Function} [cfg.exit]          Override process.exit (for tests)
 * @param {object}   [cfg.process]       Override globalThis.process (tests)
 * @param {Function} [cfg.onState]       (state) => void; states emitted:
 *                                       'signal' → 'draining' → 'disconnecting' → 'done'|'error'
 */
function registerLifecycleHandlers(cfg = {}) {
    const proc = cfg.process || process;
    const signals = (cfg.signals && cfg.signals.length) ? cfg.signals : DEFAULT_SIGNALS;
    const exitProcess = cfg.exitProcess !== false;
    const exitFn = typeof cfg.exit === 'function' ? cfg.exit : ((code) => proc.exit(code));
    const log = typeof cfg.logger === 'function' ? cfg.logger : noop;
    const emit = typeof cfg.onState === 'function' ? cfg.onState : noop;

    let shuttingDown = false;
    const handlers = new Map();

    async function handle(signal) {
        if (shuttingDown) {
            log('warn', `[db.lifecycle] ${signal} received during shutdown; ignoring`);
            return;
        }
        shuttingDown = true;
        log('info', `[db.lifecycle] received ${signal}, draining pool`);
        emit('signal');

        const result = await shutdownPool({
            prisma: cfg.prisma,
            getInFlight: cfg.getInFlight,
            gracePeriodMs: cfg.gracePeriodMs,
            pollMs: cfg.pollMs,
            logger: log,
            onState: emit,
        });

        if (exitProcess) {
            const code = result.disconnected ? 0 : 1;
            exitFn(code);
        }
    }

    for (const sig of signals) {
        const fn = () => { handle(sig).catch((e) => log('error', String(e))); };
        proc.on(sig, fn);
        handlers.set(sig, fn);
    }

    function unregister() {
        for (const [sig, fn] of handlers.entries()) {
            try { proc.off(sig, fn); } catch (_) { /* ignore */ }
        }
        handlers.clear();
    }

    return {
        unregister,
        get isShuttingDown() { return shuttingDown; },
        signals: [...signals],
        // Exposed for direct testing / programmatic shutdown
        triggerShutdown: handle,
    };
}

module.exports = {
    registerLifecycleHandlers,
    shutdownPool,
    waitForDrain,
    DEFAULT_GRACE_MS,
    DEFAULT_POLL_MS,
    DEFAULT_SIGNALS,
};

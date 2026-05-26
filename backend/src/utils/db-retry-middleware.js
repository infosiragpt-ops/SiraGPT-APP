// ──────────────────────────────────────────────────────────────
// siraGPT — Database Retry Middleware (Prisma)
// ──────────────────────────────────────────────────────────────
// Wraps Prisma operations so transient connection drops (pool
// exhaustion, PostgreSQL restart, network blip) trigger up to N
// transparent retries with exponential backoff before surfacing
// the error to the route handler.
//
// Usage:
//   const db = require('./src/utils/db-retry-middleware');
//   const users = await db.withRetry(() => prisma.user.findMany());
//
// Without this wrapper, a 1-second PostgreSQL restart causes 50+
// concurrent "Can't reach database server" errors that the error
// handler turns into 500s. With retry, most of those succeed on
// the second attempt.
//
// Which errors are retryable:
//   - Connection/timeout errors (ECONNREFUSED, ETIMEDOUT, P1001, P1002)
//   - Pool timeout (P2024)
//   - Interrupted connection (read ECONNRESET)
//   - NOT retried: validation errors, unique constraint violations,
//     not-found errors — these are application bugs, not transient.
// ──────────────────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 200;
const DEFAULT_MAX_DELAY_MS = 2000;
const MAX_SAFE_RETRIES = 20;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_ATTEMPT_EXPONENT = 30;

const MAX_RETRIES = parseBoundedInt(process.env.DB_OP_RETRIES, DEFAULT_MAX_RETRIES, 0, MAX_SAFE_RETRIES);
const BASE_DELAY_MS = parseBoundedInt(process.env.DB_OP_RETRY_BASE_MS, DEFAULT_BASE_DELAY_MS, 0, MAX_TIMER_MS);
const MAX_DELAY_MS = parseBoundedInt(process.env.DB_OP_RETRY_MAX_MS, DEFAULT_MAX_DELAY_MS, 0, MAX_TIMER_MS);

// Prisma error codes that are safe to retry (transient)
const RETRYABLE_CODES = new Set([
    'P1001',  // Can't reach database server
    'P1002',  // Database server timed out
    'P1008',  // Connection was closed by database
    'P1017',  // Server has closed the connection
    'P2024',  // Connection pool timeout
]);

function abortError(signal) {
    if (signal?.reason instanceof Error) return signal.reason;
    const error = new Error(signal?.reason ? String(signal.reason) : 'Operation aborted');
    error.name = 'AbortError';
    return error;
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError(signal);
}

function delayWithSignal(ms, signal) {
    if (ms <= 0) {
        throwIfAborted(signal);
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError(signal));
        };

        const timer = setTimeout(() => {
            signal?.removeEventListener?.('abort', onAbort);
            resolve();
        }, ms);

        if (signal) {
            if (signal.aborted) {
                onAbort();
            } else {
                signal.addEventListener('abort', onAbort, { once: true });
            }
        }
    });
}

function isRetryableError(error) {
    if (!error || typeof error !== 'object') return false;

    // Prisma known request error with a code
    if (error.code && RETRYABLE_CODES.has(error.code)) return true;

    // Network-level errors (ECONNREFUSED, ECONNRESET, ETIMEDOUT, etc.)
    const msg = String(error.message || error.code || '');
    if (msg.includes('ECONNREFUSED') ||
        msg.includes('ECONNRESET') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('EPIPE') ||
        msg.includes('read ECONNRESET') ||
        msg.includes('read ETIMEDOUT') ||
        msg.includes('connect ECONNREFUSED') ||
        msg.includes('Connection terminated unexpectedly') ||
        msg.includes('Client has been closed')) {
        return true;
    }

    return false;
}

function parseBoundedInt(value, fallback, min, max) {
    if (value === undefined || value === null || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n < min) return fallback;
    return Math.min(Math.floor(n), max);
}

function normalizeRetries(value) {
    return parseBoundedInt(value, MAX_RETRIES, 0, MAX_SAFE_RETRIES);
}

function normalizeDelay(value, fallback) {
    return parseBoundedInt(value, fallback, 0, MAX_TIMER_MS);
}

function computeDelay(baseDelayMs, maxDelayMs, attempt) {
    const base = normalizeDelay(baseDelayMs, BASE_DELAY_MS);
    const max = normalizeDelay(maxDelayMs, MAX_DELAY_MS);
    const safeAttempt = parseBoundedInt(attempt, 0, 0, MAX_ATTEMPT_EXPONENT);
    return Math.min(base * Math.pow(2, safeAttempt), max);
}

function formatErrorHint(error, maxLen = 150) {
    const raw = String(error?.code || error?.message || 'unknown_error');
    return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maxLen);
}

function sleep(ms, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason || new Error('db retry aborted'));
    const delay = normalizeDelay(ms, 0);
    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            if (signal && typeof signal.removeEventListener === 'function') {
                signal.removeEventListener('abort', onAbort);
            }
        };
        const finish = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
        };
        const onAbort = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cleanup();
            reject(signal.reason || new Error('db retry aborted'));
        };
        const timer = setTimeout(finish, delay);
        if (signal && typeof signal.addEventListener === 'function') {
            signal.addEventListener('abort', onAbort, { once: true });
        }
    });
}

/**
 * Wraps a Prisma operation with transparent retry on transient errors.
 *
 * @param {Function} fn - Async function that calls prisma.$method(...)
 * @param {object} [options]
 * @param {number} [options.maxRetries]  Override MAX_RETRIES
 * @param {number} [options.baseDelayMs] Override BASE_DELAY_MS
 * @param {AbortSignal} [options.signal] Abort retries/backoff when caller is cancelled
 * @param {Function} [options.onRetry]   Callback on each retry (attempt, error)
 * @returns {Promise<any>} Result from the wrapped function
 */
async function withRetry(fn, options = {}) {
    if (typeof fn !== 'function') throw new TypeError('db-retry: fn must be a function');
    const maxRetries = normalizeRetries(options.maxRetries);
    const baseDelayMs = normalizeDelay(options.baseDelayMs, BASE_DELAY_MS);
    const maxDelayMs = normalizeDelay(options.maxDelayMs, MAX_DELAY_MS);
    const signal = options.signal || null;
    const sleepFn = typeof options.sleep === 'function' ? options.sleep : sleep;

    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        throwIfAborted(signal);
        try {
            throwIfAborted(signal);
            return await fn();
        } catch (error) {
            lastError = error;

            if (signal?.aborted) throw abortError(signal);

            if (attempt < maxRetries && isRetryableError(error)) {
                const delay = computeDelay(baseDelayMs, maxDelayMs, attempt);
                console.warn(
                    `[db-retry] Attempt ${attempt + 1}/${maxRetries + 1} failed: ${formatErrorHint(error, 100)}. ` +
                    `Retrying in ${delay}ms...`
                );
                if (typeof options.onRetry === 'function') {
                    try { options.onRetry(attempt + 1, error); } catch { /* observer only */ }
                }
                await sleepFn(delay, signal);
                continue;
            }

            // Non-retryable error or last attempt — re-throw
            if (attempt === maxRetries && isRetryableError(error)) {
                console.error(
                    `[db-retry] All ${maxRetries + 1} attempts exhausted. ` +
                    `Last error: ${formatErrorHint(error, 150)}`
                );
            }
            throw error;
        }
    }

    throw lastError || new Error('withRetry: unreachable');
}

module.exports = {
    withRetry,
    isRetryableError,
    RETRYABLE_CODES,
    parseBoundedInt,
    normalizeRetries,
    normalizeDelay,
    computeDelay,
    formatErrorHint,
    sleep,
    MAX_RETRIES,
    BASE_DELAY_MS,
    MAX_DELAY_MS,
    MAX_SAFE_RETRIES,
};

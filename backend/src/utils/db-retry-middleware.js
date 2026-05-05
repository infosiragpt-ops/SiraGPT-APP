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

const MAX_RETRIES = parseInt(process.env.DB_OP_RETRIES || '3', 10);
const BASE_DELAY_MS = parseInt(process.env.DB_OP_RETRY_BASE_MS || '200', 10);
const MAX_DELAY_MS = parseInt(process.env.DB_OP_RETRY_MAX_MS || '2000', 10);

// Prisma error codes that are safe to retry (transient)
const RETRYABLE_CODES = new Set([
    'P1001',  // Can't reach database server
    'P1002',  // Database server timed out
    'P1008',  // Connection was closed by database
    'P1017',  // Server has closed the connection
    'P2024',  // Connection pool timeout
]);

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

/**
 * Wraps a Prisma operation with transparent retry on transient errors.
 *
 * @param {Function} fn - Async function that calls prisma.$method(...)
 * @param {object} [options]
 * @param {number} [options.maxRetries]  Override MAX_RETRIES
 * @param {number} [options.baseDelayMs] Override BASE_DELAY_MS
 * @param {Function} [options.onRetry]   Callback on each retry (attempt, error)
 * @returns {Promise<any>} Result from the wrapped function
 */
async function withRetry(fn, options = {}) {
    const maxRetries = options.maxRetries ?? MAX_RETRIES;
    const baseDelayMs = options.baseDelayMs ?? BASE_DELAY_MS;

    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            if (attempt < maxRetries && isRetryableError(error)) {
                const delay = Math.min(baseDelayMs * Math.pow(2, attempt), MAX_DELAY_MS);
                console.warn(
                    `[db-retry] Attempt ${attempt + 1}/${maxRetries + 1} failed: ${error.code || error.message?.slice(0, 100)}. ` +
                    `Retrying in ${delay}ms...`
                );
                options.onRetry?.(attempt + 1, error);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }

            // Non-retryable error or last attempt — re-throw
            if (attempt === maxRetries && isRetryableError(error)) {
                console.error(
                    `[db-retry] All ${maxRetries + 1} attempts exhausted. ` +
                    `Last error: ${error.code || error.message?.slice(0, 150)}`
                );
            }
            throw error;
        }
    }

    throw lastError || new Error('withRetry: unreachable');
}

module.exports = { withRetry, isRetryableError, RETRYABLE_CODES };

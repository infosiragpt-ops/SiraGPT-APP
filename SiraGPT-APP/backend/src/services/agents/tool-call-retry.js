'use strict';

/**
 * tool-call-retry — bounded, classifier-driven retry for a single agent
 * tool invocation in the live agentic chat loop.
 *
 * Why: an agent is only as reliable as its tools. A transient network
 * blip while calling web_search / read_url / browser_* should not abort
 * an otherwise-correct multi-step run. This wraps one tool handler with a
 * small retry budget, reusing the project's existing task-error-classifier
 * so the transient-vs-terminal decision stays consistent across the stack.
 *
 * Safety / design contract:
 *   - Only THROWN errors are eligible for retry, and only when the
 *     classifier marks them retryable (network/timeout/rate-limit). A
 *     deterministic tool response that *returns* `{ error: ... }`
 *     (e.g. invalid_url, missing query, "not your session") is the tool's
 *     intentional answer and is passed straight through — never retried.
 *   - This keeps the wrapper side-effect-safe: the live tools that could
 *     mutate state (browser_click/type) fail closed by *returning*
 *     `{ ok:false }` rather than throwing, so they are never re-run.
 *   - Transparent on the happy path: a handler that succeeds on the first
 *     try sees zero behavioural change.
 *   - `sleep` is injectable so tests run with no real delay.
 */

const { classifyTaskError } = require('../../utils/task-error-classifier');

const DEFAULT_MAX_RETRIES = (() => {
  const n = Number.parseInt(process.env.SIRAGPT_TOOL_CALL_MAX_RETRIES || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 1;
})();
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 8_000;

const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function computeBackoff(attempt, baseMs, maxMs) {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * Math.min(exp, baseMs));
  return Math.min(maxMs, exp + jitter);
}

/**
 * Invoke `handler(args, ctx)` with a bounded retry budget.
 *
 * @param {(args:any, ctx:any) => Promise<any>} handler
 * @param {any} args
 * @param {any} ctx
 * @param {object} [opts]
 * @param {number} [opts.maxRetries]   extra attempts after the first (default 1, env SIRAGPT_TOOL_CALL_MAX_RETRIES)
 * @param {(err:any) => {retryable:boolean, reason?:string, ttlMs?:number}} [opts.classify]
 * @param {(ms:number) => Promise<void>} [opts.sleep]
 * @param {number} [opts.baseDelayMs]
 * @param {number} [opts.maxDelayMs]
 * @param {(info:object) => void} [opts.onRetry]
 * @param {string} [opts.label]
 * @returns {Promise<any>} the handler's resolved value
 */
async function runToolWithRetry(handler, args, ctx, opts = {}) {
  if (typeof handler !== 'function') {
    throw new TypeError('runToolWithRetry: handler must be a function');
  }
  const maxRetries = Number.isFinite(opts.maxRetries) ? Math.max(0, Math.floor(opts.maxRetries)) : DEFAULT_MAX_RETRIES;
  const classify = typeof opts.classify === 'function' ? opts.classify : classifyTaskError;
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : sleepReal;
  const baseMs = Number.isFinite(opts.baseDelayMs) ? opts.baseDelayMs : DEFAULT_BASE_DELAY_MS;
  const maxMs = Number.isFinite(opts.maxDelayMs) ? opts.maxDelayMs : DEFAULT_MAX_DELAY_MS;
  const onRetry = typeof opts.onRetry === 'function' ? opts.onRetry : null;
  const label = opts.label || 'tool';

  const maxAttempts = maxRetries + 1;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await handler(args, ctx);
    } catch (err) {
      lastErr = err;
      const verdict = classify(err) || { retryable: false };
      if (!verdict.retryable || attempt >= maxAttempts) {
        throw err;
      }
      const delayMs = Number.isFinite(verdict.ttlMs) && verdict.ttlMs > 0
        ? verdict.ttlMs
        : computeBackoff(attempt, baseMs, maxMs);
      if (onRetry) {
        try {
          onRetry({
            label,
            attempt,
            nextAttempt: attempt + 1,
            maxAttempts,
            reason: verdict.reason || 'retryable',
            delayMs,
          });
        } catch {
          /* telemetry callback must never break the retry loop */
        }
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(delayMs);
    }
  }

  // Unreachable in practice (loop either returns or throws), kept for safety.
  throw lastErr;
}

module.exports = {
  runToolWithRetry,
  _internal: { computeBackoff, DEFAULT_MAX_RETRIES, DEFAULT_BASE_DELAY_MS, DEFAULT_MAX_DELAY_MS },
};

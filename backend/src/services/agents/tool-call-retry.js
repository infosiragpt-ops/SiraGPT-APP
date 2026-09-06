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
 *   - Retries require an explicit, server-owned `retrySafe: true` policy.
 *     Unknown or mutating tools are attempted once, even if a remote side
 *     effect succeeds before the connection fails.
 *   - Only THROWN errors are eligible for retry, and only when the
 *     classifier marks them retryable (network/timeout/rate-limit). A
 *     deterministic tool response that *returns* `{ error: ... }`
 *     (e.g. invalid_url, missing query, "not your session") is the tool's
 *     intentional answer and is passed straight through — never retried.
 *   - Stop prevents dispatch/retry and interrupts backoff. An in-flight
 *     handler receives the original ctx.signal and must cooperate with it:
 *     rejecting a Promise alone cannot undo a remote side effect.
 *   - Transparent on the happy path: a handler that succeeds on the first
 *     try sees zero behavioural change.
 *   - `sleep` is injectable so tests run with no real delay.
 */

const { classifyTaskError } = require('../../utils/task-error-classifier');
const { throwIfAborted, isAbortError } = require('../../utils/abort-signal');
const { sleep: sleepReal, normalizeDelay, safeClassify } = require('../../utils/retry-with-backoff');

const HARD_MAX_RETRIES = 3;
const HARD_MAX_DELAY_MS = 30_000;

const DEFAULT_MAX_RETRIES = (() => {
  const n = Number.parseInt(process.env.SIRAGPT_TOOL_CALL_MAX_RETRIES || '', 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, HARD_MAX_RETRIES) : 1;
})();
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 8_000;

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
 * @param {boolean} [opts.retrySafe=false] trusted local policy; never infer from remote tool annotations
 * @param {number} [opts.maxRetries]   extra attempts after the first (default 1, hard cap 3)
 * @param {(err:any) => {retryable:boolean, reason?:string, ttlMs?:number}} [opts.classify]
 * @param {(ms:number, signal?:AbortSignal) => Promise<void>} [opts.sleep] injected sleepers must honor cancellation
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
  const configuredRetries = Number.isFinite(opts.maxRetries)
    ? Math.min(HARD_MAX_RETRIES, Math.max(0, Math.floor(opts.maxRetries)))
    : DEFAULT_MAX_RETRIES;
  const maxRetries = opts.retrySafe === true ? configuredRetries : 0;
  const classify = typeof opts.classify === 'function' ? opts.classify : classifyTaskError;
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : sleepReal;
  const baseMs = Math.min(HARD_MAX_DELAY_MS, normalizeDelay(opts.baseDelayMs, DEFAULT_BASE_DELAY_MS));
  const maxMs = Math.min(HARD_MAX_DELAY_MS, normalizeDelay(opts.maxDelayMs, DEFAULT_MAX_DELAY_MS));
  const onRetry = typeof opts.onRetry === 'function' ? opts.onRetry : null;
  const label = opts.label || 'tool';
  const signal = ctx?.signal;

  const maxAttempts = maxRetries + 1;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(signal);
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await handler(args, ctx);
      throwIfAborted(signal);
      return result;
    } catch (err) {
      throwIfAborted(signal);
      lastErr = err;
      if (isAbortError(err) || err?.code === 'E_CANCELLED' || err?.code === 'ABORTED'
        || err?.name === 'AbortedError' || attempt >= maxAttempts) {
        throw err;
      }
      const verdict = safeClassify(classify, err);
      if (verdict.retryable !== true) {
        throw err;
      }
      const delayMs = Number.isFinite(verdict.ttlMs) && verdict.ttlMs > 0
        ? Math.ceil(verdict.ttlMs)
        : computeBackoff(attempt, baseMs, maxMs);
      // Do not shorten a provider cooldown and retry prematurely. An
      // excessive cooldown exhausts this small retry budget instead.
      if (delayMs > HARD_MAX_DELAY_MS) throw err;
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
      throwIfAborted(signal);
      // eslint-disable-next-line no-await-in-loop
      await sleep(delayMs, signal);
    }
  }

  // Unreachable in practice (loop either returns or throws), kept for safety.
  throw lastErr;
}

module.exports = {
  runToolWithRetry,
  _internal: { computeBackoff, DEFAULT_MAX_RETRIES, DEFAULT_BASE_DELAY_MS, DEFAULT_MAX_DELAY_MS, HARD_MAX_RETRIES, HARD_MAX_DELAY_MS },
};

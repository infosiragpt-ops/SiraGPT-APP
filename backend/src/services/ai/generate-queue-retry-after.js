'use strict';

/**
 * Retry-After for a rejected /api/ai/generate fair-queue admission.
 *
 * The fair queue (agent-runner/engine-3h63) knows how long the caller really
 * has to wait: a per-session rate limit carries `retryAfterMs`, a queue wait
 * `retryAfterSec`. The route used to answer a constant 2 s, so a client that
 * honoured the header re-POSTed into the same limit dozens of times. The
 * value goes both in the Retry-After header and in the JSON body
 * (`retryAfterSeconds`), which is what the browser can read from fetch().
 */

const DEFAULT_SECONDS = 2;
const MIN_SECONDS = 1;
const MAX_SECONDS = 60;

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Seconds to wait before retrying, clamped to [1, 60]. Accepts the fair-queue
 * result ({ retryAfterMs } | { retryAfterSec }); anything else → 2.
 */
function fairQueueRetryAfterSeconds(fair) {
  const ms = positive(fair && fair.retryAfterMs);
  const sec = positive(fair && fair.retryAfterSec);
  const raw = (ms != null ? Math.ceil(ms / 1000) : null) || (sec != null ? Math.ceil(sec) : null) || DEFAULT_SECONDS;
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, raw));
}

module.exports = {
  fairQueueRetryAfterSeconds,
  DEFAULT_SECONDS,
  MIN_SECONDS,
  MAX_SECONDS,
};

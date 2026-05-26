'use strict';

/**
 * sse-heartbeat — keep long-lived Server-Sent Events connections
 * alive across CDN / load-balancer idle timeouts by writing a
 * comment line every N seconds.
 *
 * Why this exists:
 *   Most CDNs and LB layers (Cloudflare, AWS ALB, GCP LB, nginx
 *   default) close idle TCP connections at 30–60 s. A streaming
 *   chat response that pauses while the agent thinks (no token
 *   for ~30 s during a long search step) gets disconnected mid-
 *   stream — the user sees a truncated reply with no error. The
 *   browser's EventSource then auto-reconnects, but the server
 *   has no way to resume the run.
 *
 *   The fix is to emit a SSE "comment" line (one starting with
 *   `:`) every 25 s. Per the spec the client ignores comments,
 *   but the bytes traverse the connection and reset every layer's
 *   idle timer. 25 s leaves headroom under a 30 s idle cap and
 *   matches what Stripe / OpenAI / Anthropic streaming endpoints
 *   use in production.
 *
 * Public API:
 *   - startSSEHeartbeat(res, options) → cancel()
 *     Sets up the interval, attaches a 'close' / 'finish' listener
 *     that auto-cancels, and returns a manual cancel() in case the
 *     caller wants to stop early (e.g. on a custom error response).
 *
 * Failure modes:
 *   - res.writableEnded after the response was sent: the next
 *     interval tick is a no-op.
 *   - res.write throws (rare; happens if the socket is severed
 *     mid-write): the error is swallowed and the timer is
 *     cancelled, since further writes will also fail.
 */

const DEFAULT_INTERVAL_MS = 25_000;
const MIN_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 5 * 60_000;
// SSE comment line. The space after `:` is conventional; some
// proxies that strip whitespace can leave just `:` and clients
// still ignore it.
const HEARTBEAT_PAYLOAD = ':keepalive\n\n';

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function resolveInterval(options = {}, env = process.env) {
  if (typeof options.intervalMs === 'number' && Number.isFinite(options.intervalMs)) {
    return clampInt(options.intervalMs, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS);
  }
  return clampInt(env.SSE_HEARTBEAT_INTERVAL_MS, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS);
}

/**
 * startSSEHeartbeat — attach a heartbeat to a streaming response.
 *
 * The response is expected to ALREADY have content-type:
 * text/event-stream (the caller is responsible for setting it via
 * res.writeHead or res.setHeader before the first write). We do
 * not set headers here on purpose — the caller's framework may
 * use raw http response, express response, or a custom wrapper.
 *
 * Returns a cancel() function that clears the interval. The
 * function is also called automatically when the response 'close'
 * or 'finish' event fires, so most callers don't need to invoke
 * it manually.
 *
 * @param {http.ServerResponse} res — the streaming response.
 * @param {object} [options]
 * @param {number} [options.intervalMs] — override env default.
 * @param {(now: number) => boolean} [options.shouldEmit] — guard
 *        for callers that want to suppress heartbeats during
 *        active token streaming (a token write resets the timer
 *        naturally). Returning false skips this tick.
 * @param {() => number} [options.now] — test seam.
 * @param {(handler: () => void, intervalMs: number) => any} [options.setIntervalFn]
 *        / [options.clearIntervalFn] — test seams for fake timers.
 * @returns {() => void} cancel
 */
function startSSEHeartbeat(res, options = {}) {
  if (!res || typeof res.write !== 'function') {
    return () => {};
  }
  const env = options.env || process.env;
  const intervalMs = resolveInterval(options, env);
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  const now = options.now || (() => Date.now());
  const shouldEmit = typeof options.shouldEmit === 'function' ? options.shouldEmit : () => true;

  let cancelled = false;
  const handle = setIntervalFn(() => {
    if (cancelled) return;
    if (res.writableEnded || res.destroyed) {
      cancel();
      return;
    }
    if (!shouldEmit(now())) return;
    try {
      res.write(HEARTBEAT_PAYLOAD);
    } catch (_err) {
      cancel();
    }
  }, intervalMs);

  function cancel() {
    if (cancelled) return;
    cancelled = true;
    try { clearIntervalFn(handle); } catch (_) { /* ignore */ }
  }

  // Auto-cancel when the response ends. We bind once to both
  // events because some Node versions emit only 'close' on abort
  // and others emit 'finish' on normal end.
  if (typeof res.on === 'function') {
    res.on('close', cancel);
    res.on('finish', cancel);
  }

  return cancel;
}

module.exports = {
  startSSEHeartbeat,
  resolveInterval,
  HEARTBEAT_PAYLOAD,
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
};

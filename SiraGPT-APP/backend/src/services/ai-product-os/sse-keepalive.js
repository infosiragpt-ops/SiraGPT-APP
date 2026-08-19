'use strict';

/**
 * sse-keepalive — schedules `: ping\n\n` comment frames during
 * inactivity on an SSE stream so proxies (nginx, Cloudflare, ALB)
 * don't close the connection at their idle timeout. Pairs with the
 * SSE reassembler (#17) and replay buffer (#25); those handle bytes
 * and reconnection, this one prevents the disconnection in the
 * first place.
 *
 * Behavior:
 *   - At construction the scheduler is armed to send a heartbeat
 *     after `intervalMs` of inactivity.
 *   - Every call to noteWrite() resets the inactivity timer (the
 *     real bytes are themselves keep-alives).
 *   - Every fired heartbeat invokes `write(': ping\n\n')` (or
 *     `write(': ' + comment + '\n\n')`).
 *   - close() stops the timer permanently; subsequent noteWrite()
 *     is a no-op.
 *
 * Public API:
 *   const k = createSseKeepalive({
 *     write,                         // (str) => void; required
 *     intervalMs,                    // default 15_000 (covers nginx 60s + buffer)
 *     comment,                       // 'ping' default
 *     onHeartbeat,                   // ({ at, count }) sink
 *     onError,                       // (err) sink
 *     now,                           // clock injector (test-only)
 *   })
 *   k.noteWrite()                    // mark non-heartbeat traffic
 *   k.flush()                        // force send heartbeat now
 *   k.close()                        // stop scheduler
 *   k.snapshot()                     // counters
 */

const DEFAULT_INTERVAL_MS = 15_000;

function createSseKeepalive(opts = {}) {
  if (typeof opts.write !== 'function') {
    throw new TypeError('sse-keepalive: write function required');
  }
  const write = opts.write;
  const intervalMs = Number.isFinite(opts.intervalMs) && opts.intervalMs > 0
    ? Math.floor(opts.intervalMs)
    : DEFAULT_INTERVAL_MS;
  const comment = typeof opts.comment === 'string' && opts.comment ? opts.comment : 'ping';
  const onHeartbeat = typeof opts.onHeartbeat === 'function' ? opts.onHeartbeat : null;
  const onError = typeof opts.onError === 'function' ? opts.onError : null;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  let timer = null;
  let closed = false;
  let lastActivityAt = now();
  let heartbeatCount = 0;
  const frame = `: ${comment}\n\n`;

  function fireError(err) {
    if (!onError) return;
    try { onError(err); } catch { /* swallow */ }
  }

  function fireHeartbeat() {
    if (closed) return;
    try {
      write(frame);
      heartbeatCount += 1;
      const at = now();
      lastActivityAt = at;
      if (onHeartbeat) {
        try { onHeartbeat({ at, count: heartbeatCount }); } catch { /* swallow */ }
      }
    } catch (err) {
      fireError(err);
    } finally {
      schedule();
    }
  }

  function schedule() {
    if (closed) return;
    clearTimer();
    timer = setTimeout(fireHeartbeat, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function noteWrite() {
    if (closed) return;
    lastActivityAt = now();
    schedule();
  }

  function flush() {
    if (closed) return;
    fireHeartbeat();
  }

  function close() {
    closed = true;
    clearTimer();
  }

  function snapshot() {
    return {
      closed,
      intervalMs,
      comment,
      heartbeatCount,
      lastActivityAt,
    };
  }

  // Arm initial timer on creation.
  schedule();

  return { noteWrite, flush, close, snapshot };
}

module.exports = {
  createSseKeepalive,
  DEFAULT_INTERVAL_MS,
};

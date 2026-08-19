'use strict';

/**
 * sse-writer — backpressure-aware Server-Sent Events writer.
 *
 * Why this exists:
 *   Every SSE route in this codebase used `res.write(...)` directly. Two
 *   problems with that:
 *     1. Headers get buffered until the first write completes, which means
 *        TTFB on a slow provider is "first provider token", not "request
 *        accepted". Browsers wait the whole way.
 *     2. `res.write` returns `false` once the kernel send buffer is full.
 *        Ignoring that return value lets V8 keep growing an internal queue
 *        of pending chunks, ballooning RSS and starving other requests on
 *        the same socket. On a 64 KB/s mobile uplink streaming a 4 MB HTML
 *        artifact you can grow the queue to hundreds of MB.
 *
 *   This module wraps an Express response into a small object that:
 *     - Sets the right headers and flushes them BEFORE the first chunk
 *       (so EventSource opens immediately).
 *     - Writes a `:connected` preamble so intermediaries push the headers
 *       to the client instead of holding them.
 *     - On `res.write` returning false, awaits the `drain` event before
 *       resolving — backpressure propagates up the await chain naturally
 *       to the provider stream loop.
 *     - Owns the heartbeat timer (uses sse-heartbeat under the hood).
 *
 * Public API:
 *   const sse = createSSEWriter(res, { heartbeatMs });
 *   await sse.event(obj);          // writes `data: {json}\n\n` w/ backpressure
 *   await sse.comment('ping');     // writes `: ping\n\n`
 *   await sse.raw(string);         // writes a pre-formatted SSE frame
 *   sse.done();                    // writes `data: [DONE]\n\n`, ends stream
 *   sse.close();                   // best-effort end without DONE
 *   sse.closed                     // boolean — true once socket is gone
 */

const { startSSEHeartbeat } = require('./sse-heartbeat');

const SSE_HEADERS = Object.freeze({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // Disable nginx and Vercel/Cloudflare buffering so chunks reach the
  // client as soon as we write them. Without this, proxies coalesce
  // small SSE frames and inflate TTFT.
  'X-Accel-Buffering': 'no',
});

function formatEvent(payload) {
  if (typeof payload === 'string') return `data: ${payload}\n\n`;
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function createSSEWriter(res, options = {}) {
  if (!res || typeof res.write !== 'function') {
    throw new TypeError('createSSEWriter: res must be an http.ServerResponse');
  }

  // Idempotent — express may have already set some of these. setHeader is
  // safe to call repeatedly before flushHeaders.
  if (!res.headersSent) {
    for (const [key, value] of Object.entries(SSE_HEADERS)) {
      try { res.setHeader(key, value); } catch { /* header sealed */ }
    }
    if (typeof res.flushHeaders === 'function') {
      try { res.flushHeaders(); } catch { /* socket gone */ }
    }
  }

  // Disable Nagle on the underlying socket so 50-byte SSE frames go out
  // immediately instead of waiting up to 40 ms for a coalescing peer ACK.
  // Saves real wall time on TTFT for proxied deployments. Best-effort —
  // some Express adapters expose req.socket, others don't.
  try {
    if (res.socket && typeof res.socket.setNoDelay === 'function') {
      res.socket.setNoDelay(true);
    }
  } catch { /* ignore */ }

  let closed = false;
  const onClose = () => { closed = true; };
  if (typeof res.on === 'function') {
    res.on('close', onClose);
    res.on('finish', onClose);
  }

  // Connection preamble — a comment frame the client ignores. Forces the
  // chain (express → kernel → load balancer → CDN → browser) to surface
  // the response headers immediately so EventSource fires `open`. Without
  // it the browser waits for the first real `data:` frame, which can be
  // 5+ s on a slow provider.
  try { res.write(': connected\n\n'); } catch { closed = true; }

  const cancelHeartbeat = startSSEHeartbeat(res, {
    intervalMs: options.heartbeatMs,
  });

  /**
   * Write a chunk and resolve once it is queued AND the kernel buffer has
   * drained (if it had filled). Resolves immediately on `true` from write.
   */
  function writeWithBackpressure(chunk) {
    if (closed || res.writableEnded || res.destroyed) {
      return Promise.resolve(false);
    }
    let ok;
    try {
      ok = res.write(chunk);
    } catch {
      closed = true;
      return Promise.resolve(false);
    }
    if (ok) return Promise.resolve(true);
    // Backpressure: kernel buffer full. Wait for drain or close before
    // letting the caller queue more bytes. Returning the unresolved
    // promise propagates pause-pressure up the provider read loop.
    return new Promise((resolve) => {
      const cleanup = () => {
        res.off?.('drain', onDrain);
        res.off?.('close', onTerminal);
        res.off?.('error', onTerminal);
      };
      const onDrain = () => { cleanup(); resolve(true); };
      const onTerminal = () => { cleanup(); closed = true; resolve(false); };
      res.on('drain', onDrain);
      res.on('close', onTerminal);
      res.on('error', onTerminal);
    });
  }

  return {
    get closed() { return closed || !!res.writableEnded || !!res.destroyed; },
    event(payload) { return writeWithBackpressure(formatEvent(payload)); },
    raw(frame) { return writeWithBackpressure(String(frame)); },
    comment(text) {
      const safe = String(text == null ? '' : text).replace(/\r?\n/g, ' ');
      return writeWithBackpressure(`: ${safe}\n\n`);
    },
    done() {
      cancelHeartbeat();
      if (this.closed) return Promise.resolve(false);
      return writeWithBackpressure('data: [DONE]\n\n').finally(() => {
        try { if (!res.writableEnded) res.end(); } catch { /* ignore */ }
      });
    },
    close() {
      cancelHeartbeat();
      try { if (!res.writableEnded) res.end(); } catch { /* ignore */ }
    },
  };
}

module.exports = {
  createSSEWriter,
  formatEvent,
  SSE_HEADERS,
};

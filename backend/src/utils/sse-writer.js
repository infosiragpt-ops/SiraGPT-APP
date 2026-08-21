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
let parseLastEventId = () => 0;
try { parseLastEventId = require('../services/observability/sse-event-id').parseLastEventId; } catch (_) {}
let sseWriterOrphanHub = null;

const SSE_HEADERS = Object.freeze({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // Disable nginx and Vercel/Cloudflare buffering so chunks reach the
  // client as soon as we write them. Without this, proxies coalesce
  // small SSE frames and inflate TTFT.
  'X-Accel-Buffering': 'no',
});

function formatEvent(payload, id) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const idLine = id != null && id !== '' ? `id: ${id}\n` : '';
  return `${idLine}data: ${data}\n\n`;
}

function createSSEWriter(res, options = {}) {
  if (!res || typeof res.write !== 'function') {
    throw new TypeError('createSSEWriter: res must be an http.ServerResponse');
  }
  // 3H3-BE-001 leftover: stamp id: and honor Last-Event-ID on the shared writer.
  let sseSeq = 0;
  try { sseSeq = Number(parseLastEventId(options.req)) || 0; } catch (_) { sseSeq = 0; }
  const nextSseId = () => { sseSeq += 1; return sseSeq; }
  let runtime = null;
  try { runtime = require('../services/agent-runner/engine-runtime'); } catch (_) { runtime = null; }
  let adapter = options.adapter || null;
  try { if (!adapter) adapter = require('../services/agent-runner/engine-adapter'); } catch (_) { adapter = adapter || null; }
  let lifecycle = null;
  try { lifecycle = require('../services/agent-runner/engine-lifecycle'); } catch (_) { lifecycle = null; }
  const terminalSseState = {};
  const orphanHub = options.orphanHub || (runtime && runtime.createOrphanHub && (sseWriterOrphanHub || (sseWriterOrphanHub = runtime.createOrphanHub())));
  const sessionKey = String(options.sessionKey || options.streamId || '') || null;
  const startedAt = Date.now();
  let firstByteMarked = false;
  let lastWriteAt = Date.now();
  let backpressured = false;
  const ring = [];
  if (Array.isArray(options.replayFrames) && options.replayFrames.length) {
    try {
      const corr = require('../services/agent-runner/engine-correctness');
      const replayed = corr.sseIdempotentReplay(options.replayFrames, sseSeq);
      sseSeq = replayed.nextSeq || sseSeq;
      options.replayFrames = replayed.frames;
    } catch (_) {
      if (runtime) {
        const replayed = runtime.replayFromSeq(options.replayFrames, sseSeq);
        sseSeq = replayed.nextSeq || sseSeq;
      }
    }
    try {
      if (adapter && typeof adapter.restoreLastSseIdOnResume === 'function') {
        const rest = adapter.restoreLastSseIdOnResume({ lastEventId: sseSeq, store: options.cursorStore || {} });
        if (rest && Number.isFinite(Number(rest.lastEventId))) sseSeq = Number(rest.lastEventId);
      }
      if (adapter && typeof adapter.replayLastNSseEventsFromCursor === 'function') {
        const win = adapter.replayLastNSseEventsFromCursor(options.replayFrames || ring, { cursor: sseSeq, limit: 32 });
        if (win && Array.isArray(win.replay) && win.replay.length) options.replayFrames = win.replay;
      }
    } catch (_) {}
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
  if (!adapter) {
    try { adapter = require('../services/agent-runner/engine-adapter'); } catch (_) { adapter = adapter || null; }
  }
  try {
    if (adapter && typeof adapter.sseRetryFieldOnFirstEvent === 'function') {
      const retry = adapter.sseRetryFieldOnFirstEvent({ first: true });
      if (retry && retry.retryLine) res.write(retry.retryLine + '\n');
    }
  } catch (_) {}
  try {
    if (adapter && typeof adapter.detectSseGap === 'function') {
      const header = options.lastEventId || (options.req && (options.req.headers && (options.req.headers['last-event-id'] || options.req.headers['Last-Event-ID'])));
      adapter.detectSseGap(header, ring);
      if (typeof adapter.classifySseGap === 'function') {
        adapter.classifySseGap({ lastEventId: header, currentSeq: sseSeq, window: 64 });
      }
      if (typeof adapter.sseEventIdMonotonic === 'function') {
        adapter.sseEventIdMonotonic({ lastSent: sseSeq, clientId: header, lastEventId: header, window: 64 });
      }
    }
    if (adapter && typeof adapter.ssePingOnIdleTool === 'function') {
      const idle = adapter.ssePingOnIdleTool({ elapsedMs: Date.now() - lastWriteAt });
      if (idle && idle.ping && idle.comment) {
        try { if (!closed && !res.writableEnded && !res.destroyed) res.write(idle.comment); } catch (_) {}
      }
      if (typeof adapter.ssePadForProxyBuffering === 'function') {
        const pad = adapter.ssePadForProxyBuffering({ idleMs: Date.now() - lastWriteAt });
        if (pad && pad.padded && pad.comment) {
          try { if (!closed && !res.writableEnded && !res.destroyed) res.write(pad.comment); } catch (_) {}
        }
        if (typeof adapter.sseRetryMsInPad === 'function') {
          const retry = adapter.sseRetryMsInPad({ retryMs: 2000 });
          if (retry && retry.frame) {
            try { if (!closed && !res.writableEnded && !res.destroyed) res.write(retry.frame); } catch (_) {}
          }
        }
        if (typeof adapter.persistSseLastEventIdCursor === 'function') {
          try { adapter.persistSseLastEventIdCursor({ seq: sseSeq, store: options.cursorStore || {} }); } catch (_) {}
        }
      }
    }
  } catch (_) {}
  const commentHb = adapter && typeof adapter.startCommentHeartbeat === 'function'
    ? adapter.startCommentHeartbeat({
      write: (frame) => { try { if (!closed && !res.writableEnded && !res.destroyed) res.write(frame); } catch (_) { closed = true; } },
      intervalMs: (adapter && typeof adapter.heartbeatJitter === 'function' ? adapter.heartbeatJitter().delayMs : 15_000),
      lastTokenAt: lastWriteAt,
      signal: options && options.signal,
    })
    : { mark() {}, stop() {} };

  const cancelHeartbeat = startSSEHeartbeat(res, {
    intervalMs: (adapter && typeof adapter.heartbeatJitter === 'function'
      ? adapter.heartbeatJitter({ baseMs: options.heartbeatMs || 15000 }).delayMs
      : options.heartbeatMs),
    shouldEmit: () => {
      try {
        if (adapter && typeof adapter.skipHeartbeatIfWriteWouldBlock === 'function') {
          const skip = adapter.skipHeartbeatIfWriteWouldBlock({ wouldBlock: backpressured, pendingBytes: (res.socket && res.socket.writableLength) || 0, writable: !res.writableEnded && !res.destroyed });
          if (skip && skip.skip) return false;
        }
        if (adapter && typeof adapter.maxHeartbeatsPerMinute === 'function') {
          const hb = adapter.maxHeartbeatsPerMinute({ sent: options._hbSent || 0, windowStart: options._hbWindow || startedAt, now: Date.now() });
          if (hb && hb.allow === false) return false;
          if (hb && hb.reset) { options._hbSent = 0; options._hbWindow = Date.now(); }
        }
      } catch (_) {}
      // 3H26: skip heartbeat while kernel buffer is full or the socket is gone.
      const due = runtime && typeof runtime.heartbeatDue === 'function'
        ? runtime.heartbeatDue({
          closed,
          writable: !res.writableEnded && !res.destroyed,
          backpressured,
          lastWriteAt,
          now: Date.now(),
        })
        : { emit: !closed && !res.writableEnded && !res.destroyed };
      if (!due.emit) return false;
      try {
        if (!closed && !res.writableEnded && !res.destroyed) {
          const id = nextSseId();
          let inflight = 'generate';
          try {
            const resil = require('../services/agent-runner/engine-resilience');
            inflight = (options && options.inflight) || 'generate';
            const tagged = resil.tagHeartbeatInflight({ type: 'heartbeat', at: Date.now(), seq: id }, inflight);
            res.write(`id: ${id}\nevent: heartbeat\ndata: ${JSON.stringify(tagged)}\n\n`);
          } catch (_) {
            res.write(`id: ${id}\nevent: heartbeat\ndata: ${JSON.stringify({ type: 'heartbeat', inflight, at: Date.now(), seq: id })}\n\n`);
          }
          lastWriteAt = Date.now();
          try {
            options._hbSent = (options._hbSent || 0) + 1;
            if (adapter && typeof adapter.requireSessionEventSeqIncrease === 'function') {
              adapter.requireSessionEventSeqIncrease({ lastSeq: id - 1, nextSeq: id });
            }
            if (adapter && typeof adapter.redactEmailsInLogs === 'function') {
              adapter.redactEmailsInLogs(String(inflight || ''));
            }
          } catch (_) {}
        }
      } catch (_) { /* socket gone — comment heartbeat will cancel */ }
      return true;
    },
  });

  /**
   * Write a chunk and resolve once it is queued AND the kernel buffer has
   * drained (if it had filled). Resolves immediately on `true` from write.
   */
  function markFirst() {
    if (firstByteMarked) return;
    firstByteMarked = true;
    const ms = Date.now() - startedAt;
    try {
      if (runtime && typeof runtime.observeRuntimeFirstByte === 'function') runtime.observeRuntimeFirstByte(ms);
    } catch (_) { /* optional */ }
  }
  if (sessionKey && orphanHub && typeof orphanHub.attach === 'function' && typeof options.abortProducer === 'function') {
    try { orphanHub.attach(sessionKey, options.abortProducer); } catch (_) {}
  }
  if (typeof res.on === 'function' && sessionKey && orphanHub) {
    res.on('close', () => {
      try {
        orphanHub.drain(sessionKey, {
          frames: ring,
          emit: () => {},
          close: () => { try { if (!res.writableEnded) res.end(); } catch (_) {} },
        });
      } catch (_) { /* ignore */ }
    });
  }
  try {
    if (adapter && typeof adapter.destroySseOnClientClose === 'function') {
      const req = options.req || res;
      adapter.destroySseOnClientClose(req, {
        destroy() {
          closed = true;
          try { if (!res.destroyed && typeof res.destroy === 'function') res.destroy(); } catch (_) {}
          try { if (!res.writableEnded) res.end(); } catch (_) {}
        },
      });
    }
  } catch (_) {}

  function writeWithBackpressure(chunk) {
    if (closed || res.writableEnded || res.destroyed) {
      return Promise.resolve(false);
    }
    try {
      if (adapter && typeof adapter.sseMaxBufferDisconnect === 'function') {
        const buffered = (res.socket && (res.socket.writableLength || res.writableLength)) || 0;
        const over = adapter.sseMaxBufferDisconnect({ bufferedBytes: buffered });
        if (over && over.disconnect) {
          closed = true;
          try { if (!res.writableEnded) res.end(); } catch (_) {}
          return Promise.resolve(false);
        }
      }
    } catch (_) {}
    try {
      const { sseDropUnderLoad } = require('../services/agent-runner/engine-completion');
      const decision = sseDropUnderLoad({
        pending: ring.length,
        backpressured,
        closed,
      });
      if (decision.drop) {
        if (runtime && typeof runtime.pushRing === 'function') {
          const pushed = runtime.pushRing(ring, { seq: sseSeq, at: Date.now(), dropped: true });
          ring.length = 0;
          for (const f of pushed.frames) ring.push(f);
        }
        return Promise.resolve(false);
      }
    } catch (_) { /* fail-open write */ }
    markFirst();
    lastWriteAt = Date.now();
    try { commentHb.mark(lastWriteAt); } catch (_) {}
    let skipRing = false;
    try {
      if (adapter && typeof adapter.classifySseFrame === 'function') {
        const kind = adapter.classifySseFrame(chunk);
        if (kind && kind.kind === 'comment') skipRing = true;
      }
    } catch (_) {}
    if (runtime && typeof runtime.pushRing === 'function' && !skipRing) {
      const pushed = runtime.pushRing(ring, { seq: sseSeq, at: lastWriteAt, bytes: String(chunk).length });
      ring.length = 0;
      for (const f of pushed.frames) ring.push(f);
    }
    try {
      if (adapter && typeof adapter.boundSseRing === 'function') {
        const bounded = adapter.boundSseRing(ring, { max: 64 });
        if (bounded && bounded.frames) {
          ring.length = 0;
          for (const f of bounded.frames) ring.push(f);
        }
      }
    } catch (_) {}
    let ok;
    try {
      ok = res.write(chunk);
    } catch {
      closed = true;
      return Promise.resolve(false);
    }
    if (ok) {
      backpressured = false;
      return Promise.resolve(true);
    }
    backpressured = true;
    // 3H26: never wait forever on drain — timeout then drop-oldest and continue.
    if (runtime && typeof runtime.waitDrainWithTimeout === 'function') {
      return runtime.waitDrainWithTimeout({
        writeOk: false,
        timeoutMs: runtime.DRAIN_TIMEOUT_MS,
        onDrain: (cb) => {
          const cleanup = () => {
            res.off?.('drain', onDrain);
            res.off?.('close', onTerminal);
            res.off?.('error', onTerminal);
          };
          const onDrain = () => { cleanup(); backpressured = false; cb(); };
          const onTerminal = () => { cleanup(); closed = true; cb(); };
          res.on('drain', onDrain);
          res.on('close', onTerminal);
          res.on('error', onTerminal);
        },
      }).then((r) => {
        if (r && r.timedOut) backpressured = false;
        return !(closed || res.writableEnded || res.destroyed);
      });
    }
    return new Promise((resolve) => {
      const cleanup = () => {
        res.off?.('drain', onDrain);
        res.off?.('close', onTerminal);
        res.off?.('error', onTerminal);
      };
      const onDrain = () => { cleanup(); backpressured = false; resolve(true); };
      const onTerminal = () => { cleanup(); closed = true; resolve(false); };
      res.on('drain', onDrain);
      res.on('close', onTerminal);
      res.on('error', onTerminal);
    });
  }

  return {
    get closed() { return closed || !!res.writableEnded || !!res.destroyed; },
    event(payload) {
      try {
        if (adapter && typeof adapter.dropCancelledRunEvents === 'function') {
          const d = adapter.dropCancelledRunEvents(payload, { runId: options.runId || (payload && payload.runId) });
          if (d && d.drop) return Promise.resolve(false);
        }
      } catch (_) {}
      const id = nextSseId();
      try {
        if (lifecycle && typeof lifecycle.assertMonotonicSeq === 'function') {
          const mono = lifecycle.assertMonotonicSeq(id - 1, id);
          if (!mono.ok) return Promise.resolve(false);
        }
      } catch (_) {}
      return writeWithBackpressure(formatEvent(payload, id));
    },
    raw(frame) { return writeWithBackpressure(String(frame)); },
    comment(text) {
      const safe = String(text == null ? '' : text).replace(/\r?\n/g, ' ');
      return writeWithBackpressure(`: ${safe}\n\n`);
    },
    done() {
      cancelHeartbeat();
      try { commentHb.stop(); } catch (_) {}
      if (this.closed) return Promise.resolve(false);
      if (lifecycle && typeof lifecycle.emitTerminalSseOnce === 'function') {
        const once = lifecycle.emitTerminalSseOnce(terminalSseState, { type: 'done' }, null);
        if (!once.emitted) return Promise.resolve(false);
      }
      return writeWithBackpressure('data: [DONE]\n\n').finally(() => {
        try { if (!res.writableEnded) res.end(); } catch { /* ignore */ }
      });
    },
    close() {
      cancelHeartbeat();
      try { commentHb.stop(); } catch (_) {}
      try {
        if (adapter && typeof adapter.cancelDropsBufferedTokens === 'function') {
          adapter.cancelDropsBufferedTokens({ aborted: true, buffer: ring });
        }
      } catch (_) {}
      try { if (!res.writableEnded) res.end(); } catch { /* ignore */ }
    },
  };
}

module.exports = {
  createSSEWriter,
  formatEvent,
  SSE_HEADERS,
};

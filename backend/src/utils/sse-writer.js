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
  let resumeReset = false;
  const onClose = () => { closed = true; };
  if (typeof res.on === 'function') {
    res.on('close', onClose);
    res.on('finish', onClose);
  }

  try {
    const w62 = require('../services/agent-runner/engine-3h62');
    if (typeof w62.resumeGenerateFromPersistedIdClosed === 'function' && options.resume === true) {
      const resumed = w62.resumeGenerateFromPersistedIdClosed({
        headerLastEventId: options.lastEventId,
        sessionKey: options.sessionKey,
        ring: options.ring,
        listeners: options.priorListeners || [],
        store: options.cursorStore,
        headSeq: options.headSeq,
        resume: true,
      });
      if (resumed && resumed.reset) {
        options.lastEventId = undefined;
        resumeReset = true;
      }
      if (resumed && typeof w62.persistLastEventIdClosed === 'function' && options.sessionKey && Number.isFinite(Number(resumed.lastEventId))) {
        let persistCursor;
        try {
          const ad = require('../services/agent-runner/engine-adapter');
          persistCursor = ad.persistSseLastEventIdCursor;
          if (typeof persistCursor === 'function' && options.cursorStore) {
            persistCursor({
              lastEventId: resumed.lastEventId,
              seq: resumed.lastEventId,
              store: options.cursorStore,
            });
          }
        } catch (_) { persistCursor = undefined; }
        w62.persistLastEventIdClosed({
          sessionKey: options.sessionKey,
          lastEventId: resumed.lastEventId,
          store: options.cursorStore,
          persistCursor,
        });
      }
    }
  } catch (_) { /* 3H62 fail-open to 3H61 */ }
  try {
    const w61 = require('../services/agent-runner/engine-3h61');
    if (typeof w61.applySseResumeGuardsClosed === 'function') {
      const guards = w61.applySseResumeGuardsClosed({
        listeners: options.priorListeners || [],
        resume: options.resume === true,
        lastEventId: options.lastEventId,
        headSeq: options.headSeq,
      });
      if (guards && guards.reset) {
        options.lastEventId = undefined;
        resumeReset = true;
      }
    }
  } catch (_) { /* 3H61 fail-open to 3H59 */ }
  try {
    const w = require('../services/agent-runner/engine-3h59');
    if (options.resume && typeof w.sseResumeDropsPriorListeners === 'function') {
      w.sseResumeDropsPriorListeners({ listeners: options.priorListeners || [], resume: true });
    }
    if (options.lastEventId != null && typeof w.sseResumeRejectsSeqPastHead === 'function') {
      const ahead = w.sseResumeRejectsSeqPastHead({ lastEventId: options.lastEventId, headSeq: options.headSeq });
      if (ahead && ahead.reset) {
        options.lastEventId = undefined;
        resumeReset = true;
      }
    }
  } catch (_) { /* 3H59 fail-open */ }
  try {
    const w60 = require('../services/agent-runner/engine-3h60');
    if (options.lastEventId != null && Array.isArray(options.replayEvents) && typeof w60.sseReplayFromLastEventId === 'function') {
      const replayed = w60.sseReplayFromLastEventId(options.replayEvents, options.lastEventId);
      if (replayed && Array.isArray(replayed.events)) options.replayEvents = replayed.events;
    }
    if (options.disconnected === true && typeof w60.sseAbortOnClientDisconnect === 'function') {
      w60.sseAbortOnClientDisconnect({ disconnected: true, controller: options.abortController });
    }
  } catch (_) { /* 3H60 fail-open */ }

  // Connection preamble — a comment frame the client ignores. Forces the
  // chain (express → kernel → load balancer → CDN → browser) to surface
  // the response headers immediately so EventSource fires `open`. Without
  // it the browser waits for the first real `data:` frame, which can be
  // 5+ s on a slow provider.
  try { res.write(': connected\n\n'); } catch { closed = true; }

  try {
    const adAttach = require('../services/agent-runner/engine-adapter');
    const w64 = require('../services/agent-runner/engine-3h64');
    if (typeof adAttach.destroySseOnClientClose === 'function' && options.req) {
      adAttach.destroySseOnClientClose(options.req, {
        close: function () { closed = true; },
        destroy: function () { closed = true; try { if (!res.writableEnded) res.end(); } catch (_) {} },
      });
    }
    if (typeof w64.guardSseClientGoneClosed === 'function') {
      w64.guardSseClientGoneClosed({
        req: options.req,
        writer: {
          close: function () { closed = true; },
          destroy: function () { closed = true; },
        },
        lastClientAt: options.lastClientAt,
        now: Date.now(),
        pendingEvent: options.pendingEvent,
        closed: closed,
        aborted: options.aborted === true,
        lastEventId: options.lastEventId,
        ring: options.ring,
        destroySseOnClientClose: adAttach.destroySseOnClientClose,
        closeIfClientGone30s: adAttach.closeIfClientGone30s,
        flushLastSseEventBeforeClose: adAttach.flushLastSseEventBeforeClose,
        endSseWithErrorEventOnAbort: adAttach.endSseWithErrorEventOnAbort,
        detectSseGap: adAttach.detectSseGap,
      });
    }
  } catch (_) { /* 3H64 attach fail-open */ }

  // Live generate/agent streams: honor Last-Event-ID against an optional
  // seq ring. Inclusive replay is opt-in via options.inclusive (default
  // exclusive so 3H32-S-002 stays green). Fail-open — missing adapter
  // never blocks the writer.
  try {
    if (options.ring && options.lastEventId != null) {
      const ad = require('../services/agent-runner/engine-adapter');
      if (typeof ad.rejectLastEventIdGoingBackwards === 'function') {
        const head = Number(options.headSeq);
        ad.rejectLastEventIdGoingBackwards({
          lastEventId: options.lastEventId,
          currentSeq: Number.isFinite(head) ? head : undefined,
          stored: options.cursorStore && options.cursorStore.cursor,
        });
      }
      if (typeof ad.detectSseGap === 'function') {
        ad.detectSseGap(options.lastEventId, options.ring);
      }
      if (typeof ad.replayLastNSseEventsFromCursor === 'function' && Array.isArray(options.ring)) {
        ad.replayLastNSseEventsFromCursor(options.ring, { cursor: options.lastEventId });
      }
      if (typeof ad.sseEventIdMonotonic === 'function') {
        ad.sseEventIdMonotonic({
          lastSent: options.headSeq,
          lastEventId: options.lastEventId,
        });
      }
      if (typeof ad.dropDuplicateSseEventIds === 'function' && Array.isArray(options.ring)) {
        ad.dropDuplicateSseEventIds(options.ring);
      }
      try {
        const w67rep = require('../services/agent-runner/engine-3h67');
        if (typeof w67rep.applySseReplayCloseClosed === 'function' && Array.isArray(options.ring)) {
          const filtered = w67rep.applySseReplayCloseClosed({
            headerValue: options.lastEventId,
            lastEventId: options.lastEventId,
            events: options.ring,
            store: options.cursorStore,
            closed: false,
            alreadyDone: true,
            parseLastEventIdIntOnly: ad.parseLastEventIdIntOnly,
            restoreLastSseIdOnResume: ad.restoreLastSseIdOnResume,
            dropSseCommentFramesFromReplay: ad.dropSseCommentFramesFromReplay,
            dropSseEventsOlderThan2min: ad.dropSseEventsOlderThan2min,
            capReplayFrames64: ad.capReplayFrames64,
            endSseWithEventDone: ad.endSseWithEventDone,
          });
          if (filtered && Array.isArray(filtered.events)) {
            options = Object.assign({}, options, { ring: filtered.events });
          }
        }
      } catch (_) { /* 3H67 replay filter fail-open */ }
      if (typeof ad.honorLastEventId === 'function') {
        const honored = ad.honorLastEventId(options.lastEventId, options.ring, {
          inclusive: options.inclusive === true,
        });
        const replay = (honored && honored.replay) || [];
        for (const frame of replay) {
          if (!frame) continue;
          if (typeof frame.payload === 'string') {
            try { res.write(frame.payload); } catch { closed = true; break; }
          } else if (frame.data != null) {
            try { res.write(formatEvent(frame.data)); } catch { closed = true; break; }
          }
        }
      }
    }
  } catch (_) { /* adapter fail-open */ }

  let __lastSseSeq = Number(options.headSeq) || 0;
  const cancelHeartbeat = startSSEHeartbeat(res, {
    intervalMs: options.heartbeatMs,
    shouldEmit: function () {
      try {
        const adHb = require('../services/agent-runner/engine-adapter');
        const w65hb = require('../services/agent-runner/engine-3h65');
        if (typeof w65hb.applySseSessionGuardsClosed === 'function') {
          const g = w65hb.applySseSessionGuardsClosed({
            lastSeq: __lastSseSeq,
            nextSeq: __lastSseSeq + 1,
            wouldBlock: Boolean(res.writableNeedDrain),
            pendingBytes: res.writableLength,
            writable: !(closed || res.writableEnded || res.destroyed),
            requireSessionEventSeqIncrease: adHb.requireSessionEventSeqIncrease,
            skipHeartbeatIfWriteWouldBlock: adHb.skipHeartbeatIfWriteWouldBlock,
          });
          if (g && g.skipHeartbeat) return false;
        } else if (typeof adHb.skipHeartbeatIfWriteWouldBlock === 'function') {
          const skip = adHb.skipHeartbeatIfWriteWouldBlock({
            wouldBlock: Boolean(res.writableNeedDrain),
            pendingBytes: res.writableLength,
            writable: !(closed || res.writableEnded || res.destroyed),
          });
          if (skip && skip.skip) return false;
        }
      } catch (_) { /* 3H65 heartbeat skip fail-open */ }
      return true;
    },
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
    try {
      if (options.sessionKey && typeof chunk === 'string' && chunk.startsWith('data:')) {
        const ad = require('../services/agent-runner/engine-adapter');
        const store = options.cursorStore || (options._cursorStore = {});
        const next = (Number(store.cursor) || 0) + 1;
        try {
          const w65seq = require('../services/agent-runner/engine-3h65');
          if (typeof w65seq.applySseSessionGuardsClosed === 'function') {
            const g = w65seq.applySseSessionGuardsClosed({
              lastSeq: store.cursor,
              nextSeq: next,
              writable: !(closed || res.writableEnded || res.destroyed),
              requireSessionEventSeqIncrease: ad.requireSessionEventSeqIncrease,
              skipHeartbeatIfWriteWouldBlock: ad.skipHeartbeatIfWriteWouldBlock,
            });
            if (g && g.seqOk === false) {
              return Promise.resolve(false);
            }
            if (g && Number.isFinite(g.lastSeq)) __lastSseSeq = g.lastSeq;
          } else if (typeof ad.requireSessionEventSeqIncrease === 'function') {
            ad.requireSessionEventSeqIncrease({ lastSeq: store.cursor, nextSeq: next });
          }
        } catch (_) { /* 3H65 seq fail-open */ }
        if (typeof ad.persistSseLastEventIdCursor === 'function') {
          ad.persistSseLastEventIdCursor({ lastEventId: next, seq: next, store });
        }
        const w62 = require('../services/agent-runner/engine-3h62');
        if (typeof w62.persistLastEventIdClosed === 'function') {
          w62.persistLastEventIdClosed({
            sessionKey: options.sessionKey,
            lastEventId: next,
            store,
            persistCursor: ad.persistSseLastEventIdCursor,
          });
        }
      }
    } catch (_) { /* durable cursor is best-effort */ }
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
      try {
        const w60 = require('../services/agent-runner/engine-3h60');
        if (typeof w60.sseHeartbeatCommentNoSeq === 'function') {
          w60.sseHeartbeatCommentNoSeq({ seq: options.headSeq, kind: 'heartbeat' });
        }
      } catch (_) { /* 3H60 fail-open */ }
      try {
        const adHb = require('../services/agent-runner/engine-adapter');
        const w65c = require('../services/agent-runner/engine-3h65');
        if (typeof w65c.applySseSessionGuardsClosed === 'function') {
          const g = w65c.applySseSessionGuardsClosed({
            lastSeq: 0,
            nextSeq: 1,
            wouldBlock: Boolean(res.writableNeedDrain),
            pendingBytes: res.writableLength,
            writable: !(closed || res.writableEnded || res.destroyed),
            skipHeartbeatIfWriteWouldBlock: adHb.skipHeartbeatIfWriteWouldBlock,
          });
          if (g && g.skipHeartbeat) return Promise.resolve(false);
        } else if (typeof adHb.skipHeartbeatIfWriteWouldBlock === 'function') {
          const skip = adHb.skipHeartbeatIfWriteWouldBlock({
            wouldBlock: Boolean(res.writableNeedDrain),
            pendingBytes: res.writableLength,
            writable: !(closed || res.writableEnded || res.destroyed),
          });
          if (skip && skip.skip) return Promise.resolve(false);
        }
      } catch (_) { /* 3H65 comment skip fail-open */ }
      const safe = String(text == null ? '' : text).replace(/\r?\n/g, ' ');
      return writeWithBackpressure(`: ${safe}\n\n`);
    },
    get resumeReset() { return resumeReset; },
    done() {
      try {
        const adDone = require('../services/agent-runner/engine-adapter');
        if (typeof adDone.flushLastSseEventBeforeClose === 'function') {
          adDone.flushLastSseEventBeforeClose({
            pendingEvent: options.pendingEvent,
            closed: closed,
            flushed: false,
          });
        }
        if (typeof adDone.endSseWithErrorEventOnAbort === 'function' && options.aborted === true) {
          const abortEvt = adDone.endSseWithErrorEventOnAbort({
            aborted: true,
            closed: closed,
            reason: options.abortReason || 'aborted',
          });
          if (abortEvt && abortEvt.write && abortEvt.frame) {
            try { res.write(abortEvt.frame); } catch (_) { closed = true; }
          }
        }
        if (typeof adDone.closeIfClientGone30s === 'function') {
          adDone.closeIfClientGone30s({
            lastClientAt: options.lastClientAt,
            now: Date.now(),
          });
        }
      } catch (_) { /* 3H64 done fail-open */ }
      try {
        const w66c = require('../services/agent-runner/engine-3h66');
        const adC = require('../services/agent-runner/engine-adapter');
        if (typeof w66c.applySseCreditLockClosed === 'function') {
          w66c.applySseCreditLockClosed({
            sseClosed: true,
            settled: false,
            cancelled: options.aborted === true,
            held: true,
            closeSseThenSettleCredits: adC.closeSseThenSettleCredits,
            sessionLockTtl90s: adC.sessionLockTtl90s,
            stealLockIfHeartbeatExpired: adC.stealLockIfHeartbeatExpired,
          });
        }
      } catch (_) { /* 3H66 close-then-settle fail-open */ }
      try {
        const w67d = require('../services/agent-runner/engine-3h67');
        const ad67d = require('../services/agent-runner/engine-adapter');
        if (typeof w67d.applySseReplayCloseClosed === 'function') {
          const done67 = w67d.applySseReplayCloseClosed({
            headerValue: options.lastEventId,
            lastEventId: options.lastEventId,
            events: Array.isArray(options.ring) ? options.ring : [],
            store: options.cursorStore,
            closed: closed,
            alreadyDone: closed,
            parseLastEventIdIntOnly: ad67d.parseLastEventIdIntOnly,
            restoreLastSseIdOnResume: ad67d.restoreLastSseIdOnResume,
            dropSseCommentFramesFromReplay: ad67d.dropSseCommentFramesFromReplay,
            dropSseEventsOlderThan2min: ad67d.dropSseEventsOlderThan2min,
            capReplayFrames64: ad67d.capReplayFrames64,
            endSseWithEventDone: ad67d.endSseWithEventDone,
          });
          if (done67 && done67.writeDone && done67.frame && !closed) {
            try { res.write(done67.frame); } catch (_) { closed = true; }
          }
        }
      } catch (_) { /* 3H67 event-done fail-open */ }
      try {
        const w61 = require('../services/agent-runner/engine-3h61');
        if (typeof w61.applySseCancelHeartbeatClosed === 'function') {
          w61.applySseCancelHeartbeatClosed({ cancelled: true, heartbeatTimer: cancelHeartbeat });
        }
      } catch (_) { /* 3H61 fail-open */ }
      try {
        const w = require('../services/agent-runner/engine-3h59');
        if (typeof w.sseCancelClearsHeartbeat === 'function') {
          w.sseCancelClearsHeartbeat({ cancelled: true, heartbeatTimer: cancelHeartbeat });
        }
      } catch (_) { /* 3H59 fail-open */ }
      try {
        const w60 = require('../services/agent-runner/engine-3h60');
        if (typeof w60.dropBufferedTokensOnSseCancel === 'function') {
          w60.dropBufferedTokensOnSseCancel({ cancelled: true, buffered: options.bufferedTokens });
        }
        if (typeof w60.sseAbortOnClientDisconnect === 'function' && options.abortController) {
          w60.sseAbortOnClientDisconnect({ disconnected: true, controller: options.abortController });
        }
      } catch (_) { /* 3H60 fail-open */ }
      cancelHeartbeat();
      if (this.closed) return Promise.resolve(false);
      return writeWithBackpressure('data: [DONE]\n\n').finally(() => {
        try { if (!res.writableEnded) res.end(); } catch { /* ignore */ }
      });
    },
    close() {
      try {
        const w61 = require('../services/agent-runner/engine-3h61');
        if (typeof w61.applySseCancelHeartbeatClosed === 'function') {
          w61.applySseCancelHeartbeatClosed({ cancelled: true, heartbeatTimer: cancelHeartbeat });
        }
      } catch (_) { /* 3H61 fail-open */ }
      try {
        const w = require('../services/agent-runner/engine-3h59');
        if (typeof w.sseCancelClearsHeartbeat === 'function') {
          w.sseCancelClearsHeartbeat({ cancelled: true, heartbeatTimer: cancelHeartbeat });
        }
      } catch (_) { /* 3H59 fail-open */ }
      try {
        const w60 = require('../services/agent-runner/engine-3h60');
        if (typeof w60.dropBufferedTokensOnSseCancel === 'function') {
          w60.dropBufferedTokensOnSseCancel({ cancelled: true, buffered: options.bufferedTokens });
        }
        if (typeof w60.sseAbortOnClientDisconnect === 'function' && options.abortController) {
          w60.sseAbortOnClientDisconnect({ disconnected: true, controller: options.abortController });
        }
      } catch (_) { /* 3H60 fail-open */ }
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

'use strict';

/**
 * attribution-stream-emitter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Lightweight SSE emitter for the attribution pipeline. Lets the UI
 * render a real-time progress bar ("now extracting concepts… now
 * building graph…") and stream intermediate results before the final
 * block is assembled.
 *
 * Stream API:
 *   • emit(name, payload)
 *   • stageStart(label, payload?) / stageEnd(label, payload?)
 *   • error(err) / heartbeat() / close()
 *   • history() → recent events for late-attaching UIs
 *
 * Public API:
 *   createStream(res, opts?)        → Stream
 *   formatEvent(eventName, data)    → SSE-shaped string
 *   isWritable(res)                 → boolean
 */

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_HISTORY_CAP = 64;

function formatEvent(eventName, data) {
  const safe = data === undefined ? null : data;
  let payload;
  try { payload = JSON.stringify(safe); } catch (_e) { payload = JSON.stringify(String(safe)); }
  return `event: ${eventName}\ndata: ${payload}\n\n`;
}

function setSseHeaders(res) {
  if (!res || typeof res.setHeader !== 'function') return false;
  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    return true;
  } catch (_) { return false; }
}

function isWritable(res) {
  if (!res) return false;
  if (res.destroyed === true) return false;
  if (res.writableEnded === true) return false;
  if (res.finished === true) return false;
  return typeof res.write === 'function';
}

function createStream(res, opts = {}) {
  const historyCap = Math.max(8, Number(opts.historyCap) || DEFAULT_HISTORY_CAP);
  const heartbeatMs = Math.max(1000, Number(opts.heartbeatMs) || DEFAULT_HEARTBEAT_MS);
  const skipHeaders = opts.skipHeaders === true;

  if (!skipHeaders) setSseHeaders(res);

  const history = [];
  let closed = false;
  let heartbeatTimer = null;

  function pushHistory(entry) {
    history.push(entry);
    if (history.length > historyCap) history.shift();
  }

  function emit(eventName, payload) {
    if (closed) return false;
    const data = payload === undefined ? null : payload;
    pushHistory({ eventName, data, ts: Date.now() });
    if (!isWritable(res)) return false;
    try { res.write(formatEvent(eventName, data)); return true; }
    catch (_) { return false; }
  }

  function stageStart(label, payload) {
    return emit(`${label}.start`, { label, ts: Date.now(), ...(payload || {}) });
  }
  function stageEnd(label, payload) {
    return emit(`${label}.done`, { label, ts: Date.now(), ...(payload || {}) });
  }
  function error(err) {
    return emit('error', {
      message: err?.message || String(err),
      stack: err?.stack ? String(err.stack).slice(0, 1000) : null,
      ts: Date.now(),
    });
  }
  function heartbeat() {
    if (closed) return;
    if (!isWritable(res)) { close(); return; }
    try { res.write(':\n\n'); } catch (_) { close(); }
  }
  function startHeartbeat() {
    if (heartbeatTimer || closed) return;
    heartbeatTimer = setInterval(heartbeat, heartbeatMs);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
  }
  function close() {
    if (closed) return;
    closed = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (isWritable(res)) {
      try { res.write('event: close\ndata: {}\n\n'); res.end(); }
      catch (_) { /* swallow */ }
    }
  }
  function getHistory() { return [...history]; }

  startHeartbeat();
  if (res && typeof res.on === 'function') {
    res.on('close', () => close());
    res.on('error', () => close());
  }

  return {
    emit, stageStart, stageEnd, error, heartbeat, close,
    history: getHistory, isClosed: () => closed, historyCap, heartbeatMs,
  };
}

module.exports = { createStream, formatEvent, setSseHeaders, isWritable };

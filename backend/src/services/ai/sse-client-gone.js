'use strict';

/**
 * Socket-aware "client gone" detection for SSE routes.
 *
 * On Node >= 16 `req.destroyed` flips to true and `req` emits 'close' as soon
 * as the request body has been fully consumed — express.json() does that
 * before the route handler even runs — while the socket is still perfectly
 * writable. The 3H64 helpers (`destroySseOnClientClose` /
 * `guardSseClientGoneClosed`) treat both as "the browser disconnected". Wired
 * to a `clientGone = true` writer, that marked EVERY /api/ai/generate as
 * detached at entry: all SSE writes became silent no-ops, the reply was
 * persisted server-side and /agentes sat on "Pensando…" until the client
 * gave up or polled the saved turn.
 *
 * Only the socket / response side is trusted here.
 */
function isClientSocketGone(req, res) {
  const socket = (res && res.socket) || (req && req.socket) || null;
  if (socket && socket.destroyed === true) return true;
  if (res && res.destroyed === true) return true;
  // `aborted` is only raised when the client dropped the request before the
  // body completed — never by normal body consumption.
  if (req && req.aborted === true && req.complete !== true) return true;
  return false;
}

/**
 * Writer for the 3H64 helpers: they call `.destroy()` / `.close()` on
 * `req` 'close' and when `req.destroyed` is already true. We only honour the
 * signal when the socket is really gone.
 */
function createClientGoneWriter(req, res, onGone) {
  const check = () => {
    if (!isClientSocketGone(req, res)) return false;
    try { if (typeof onGone === 'function') onGone(); } catch (_) { /* observer */ }
    return true;
  };
  return { close: check, destroy: check };
}

module.exports = { isClientSocketGone, createClientGoneWriter };

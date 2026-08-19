'use strict';

/**
 * Lightweight client helper for the realtime WS protocol.
 *
 * This is intentionally framework-agnostic — it speaks the same JSON
 * envelopes the server understands so it can be reused from Node test
 * harnesses, mobile bridges, or imported from the Next.js client without
 * touching any UI component (CLAUDE rule #1).
 *
 * Usage:
 *   const c = createRealtimeClient({ url, token });
 *   c.connect();
 *   c.subscribeChat('chat-123');
 *   c.startTyping('chat-123');
 *   c.sendCursor('chat-123', { x: 12, y: 34 });
 */

const DEFAULT_TYPING_RENEW_MS = 3_000; // server stops after 5s, renew at 3s

/**
 * @param {object} opts
 * @param {string} opts.url — ws://host/ws/realtime (no query)
 * @param {string} opts.token — JWT bearer
 * @param {typeof WebSocket} [opts.WebSocketImpl] — defaults to global WebSocket
 * @param {(event:object)=>void} [opts.onMessage]
 * @param {(err:Error)=>void} [opts.onError]
 * @param {()=>void} [opts.onOpen]
 * @param {(code:number,reason:string)=>void} [opts.onClose]
 */
function createRealtimeClient(opts) {
  if (!opts || !opts.url) throw new TypeError('url required');
  if (!opts.token) throw new TypeError('token required');
  const WS = opts.WebSocketImpl
    || (typeof WebSocket !== 'undefined' ? WebSocket : null);
  if (!WS) throw new Error('no WebSocket implementation available');

  /** @type {WebSocket|null} */
  let ws = null;
  /** @type {Map<string, NodeJS.Timeout>} */
  const typingRenewTimers = new Map();
  const subscribed = new Set();

  function _send(obj) {
    if (!ws || ws.readyState !== 1 /* OPEN */) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  function connect() {
    const sep = opts.url.includes('?') ? '&' : '?';
    const url = `${opts.url}${sep}token=${encodeURIComponent(opts.token)}`;
    ws = new WS(url);
    ws.onopen = () => { opts.onOpen && opts.onOpen(); };
    ws.onerror = (e) => { opts.onError && opts.onError(e?.error || new Error('ws_error')); };
    ws.onclose = (e) => {
      for (const t of typingRenewTimers.values()) clearInterval(t);
      typingRenewTimers.clear();
      opts.onClose && opts.onClose(e?.code, e?.reason);
    };
    ws.onmessage = (m) => {
      let parsed;
      try { parsed = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data)); }
      catch { return; }
      opts.onMessage && opts.onMessage(parsed);
    };
  }

  function close() {
    if (ws) { try { ws.close(); } catch {} ws = null; }
  }

  function subscribeChat(chatId) {
    subscribed.add(chatId);
    return _send({ type: 'subscribe.chat', chatId });
  }
  function unsubscribeChat(chatId) {
    subscribed.delete(chatId);
    stopTyping(chatId);
    return _send({ type: 'unsubscribe.chat', chatId });
  }

  function startTyping(chatId) {
    const ok = _send({ type: 'typing.start', chatId });
    if (!ok) return false;
    if (!typingRenewTimers.has(chatId)) {
      const t = setInterval(() => {
        _send({ type: 'typing.start', chatId });
      }, DEFAULT_TYPING_RENEW_MS);
      if (typeof t.unref === 'function') t.unref();
      typingRenewTimers.set(chatId, t);
    }
    return true;
  }
  function stopTyping(chatId) {
    const t = typingRenewTimers.get(chatId);
    if (t) { clearInterval(t); typingRenewTimers.delete(chatId); }
    return _send({ type: 'typing.stop', chatId });
  }

  function sendCursor(chatId, point) {
    return _send({ type: 'cursor:update', chatId, data: point });
  }
  function sendSelection(chatId, sel) {
    return _send({ type: 'selection:update', chatId, data: sel });
  }

  return {
    connect, close,
    subscribeChat, unsubscribeChat,
    startTyping, stopTyping,
    sendCursor, sendSelection,
    get raw() { return ws; },
  };
}

module.exports = { createRealtimeClient, DEFAULT_TYPING_RENEW_MS };

'use strict';

/**
 * Injectable transports for the coding terminal channel.
 * Tests use MemoryTransport. HTTP uses SSE. WebSocket is optional.
 */

const { decodeFrame, encodeFrame, encodeSse } = require('./protocol');

function createMemoryTransport() {
  const sent = [];
  let onMessage = null;
  let closed = false;
  return {
    kind: 'memory',
    sent,
    send(frame) {
      if (closed) return;
      sent.push(frame);
    },
    onMessage(fn) {
      onMessage = typeof fn === 'function' ? fn : null;
    },
    push(raw) {
      if (closed || !onMessage) return;
      onMessage(typeof raw === 'object' && raw && raw.type ? raw : decodeFrame(raw));
    },
    close() {
      closed = true;
    },
    get closed() {
      return closed;
    },
  };
}

function createSseTransport(res) {
  let closed = false;
  return {
    kind: 'sse',
    send(frame) {
      if (closed || !res || typeof res.write !== 'function') return;
      try {
        res.write(encodeSse(frame));
      } catch (_) { /* client gone */ }
    },
    onMessage() {
      /* SSE is server → client only; stdin is POST */
    },
    close() {
      closed = true;
      if (res && typeof res.end === 'function' && !res.writableEnded) {
        try { res.end(); } catch (_) { /* ignore */ }
      }
    },
  };
}

function createWebSocketTransport(socket, opts = {}) {
  const decode = opts.decodeFrame || decodeFrame;
  const encode = opts.encodeFrame || encodeFrame;
  let onMessage = null;
  let closed = false;

  if (socket && typeof socket.on === 'function') {
    socket.on('message', (raw) => {
      if (closed || !onMessage) return;
      try {
        onMessage(decode(raw));
      } catch (err) {
        try {
          if (typeof socket.send === 'function') {
            socket.send(encode({
              type: 'error',
              error: err.code || 'E_PARAMS',
              message: err.message || 'Marco de terminal inválido.',
            }));
          }
        } catch (_) { /* ignore */ }
      }
    });
  }

  return {
    kind: 'ws',
    send(frame) {
      if (closed || !socket) return;
      const open = socket.readyState == null || socket.readyState === 1;
      if (!open) return;
      try { socket.send(encode(frame)); } catch (_) { /* ignore */ }
    },
    onMessage(fn) {
      onMessage = typeof fn === 'function' ? fn : null;
    },
    close() {
      closed = true;
      if (socket && typeof socket.close === 'function') {
        try { socket.close(); } catch (_) { /* ignore */ }
      }
    },
  };
}

module.exports = {
  createMemoryTransport,
  createSseTransport,
  createWebSocketTransport,
};

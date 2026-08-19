'use strict';

const http = require('http');
const WebSocket = require('ws');

const attachedProxies = new WeakMap();
const OPEN = 1;
const CONNECTING = 0;
const MAX_PENDING_BYTES = 1024 * 1024;
const MAX_PENDING_MESSAGES = 64;

function parseProtocols(value) {
  return String(value || '')
    .split(',')
    .map((protocol) => protocol.trim())
    .filter(Boolean);
}

function validCloseCode(code) {
  const value = Number(code);
  if (!Number.isInteger(value) || value < 1000 || value > 4999) return 1011;
  if ([1004, 1005, 1006, 1015].includes(value)) return 1011;
  return value;
}

function rejectUpgrade(socket, statusCode = 502) {
  if (!socket || socket.destroyed) return;
  const status = [400, 403, 404, 429, 502, 503].includes(Number(statusCode))
    ? Number(statusCode)
    : 502;
  const reason = http.STATUS_CODES[status] || 'Bad Gateway';
  const body = `${reason}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n`
    + 'Connection: close\r\n'
    + 'Content-Type: text/plain; charset=utf-8\r\n'
    + `Content-Length: ${Buffer.byteLength(body)}\r\n`
    + '\r\n'
    + body,
  );
}

function closePeer(peer, code = 1011, reason = 'preview_proxy_closed') {
  if (!peer) return;
  try {
    if (peer.readyState === OPEN) peer.close(validCloseCode(code), String(reason || '').slice(0, 120));
    else if (peer.readyState === CONNECTING) peer.terminate();
  } catch {
    try { peer.terminate(); } catch (_) { /* already closed */ }
  }
}

function forwardMessage(peer, data, isBinary) {
  if (!peer || peer.readyState !== OPEN) return false;
  try {
    peer.send(data, { binary: isBinary }, (error) => {
      if (error) closePeer(peer);
    });
    return true;
  } catch {
    closePeer(peer);
    return false;
  }
}

function bridgeWebSockets(downstream, upstream) {
  const pending = [];
  let pendingBytes = 0;

  downstream.on('message', (data, isBinary) => {
    if (upstream.readyState === OPEN) {
      forwardMessage(upstream, data, isBinary);
      return;
    }
    const bytes = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data));
    if (pending.length >= MAX_PENDING_MESSAGES || pendingBytes + bytes > MAX_PENDING_BYTES) {
      closePeer(downstream, 1009, 'preview_proxy_queue_limit');
      closePeer(upstream, 1009, 'preview_proxy_queue_limit');
      return;
    }
    pending.push({ data, isBinary });
    pendingBytes += bytes;
  });

  upstream.on('open', () => {
    for (const message of pending.splice(0)) {
      if (!forwardMessage(upstream, message.data, message.isBinary)) break;
    }
    pendingBytes = 0;
  });
  upstream.on('message', (data, isBinary) => {
    forwardMessage(downstream, data, isBinary);
  });

  downstream.on('close', (code, reason) => closePeer(upstream, code, reason));
  upstream.on('close', (code, reason) => closePeer(downstream, code, reason));
  downstream.on('error', () => closePeer(upstream));
  upstream.on('error', () => closePeer(downstream));
}

function attachWebSocketProxy(server, {
  shouldHandle,
  resolveTarget,
  isOriginAllowed = () => true,
  WebSocketClient = WebSocket,
  WebSocketServer = WebSocket.Server,
  handshakeTimeoutMs = 10_000,
} = {}) {
  if (!server || typeof server.on !== 'function') throw new TypeError('server is required');
  if (typeof shouldHandle !== 'function') throw new TypeError('shouldHandle is required');
  if (typeof resolveTarget !== 'function') throw new TypeError('resolveTarget is required');
  if (typeof isOriginAllowed !== 'function') throw new TypeError('isOriginAllowed must be a function');

  const existing = attachedProxies.get(server);
  if (existing) return existing;

  const downstreamServer = new WebSocketServer({ noServer: true });
  const onUpgrade = (request, socket, head) => {
    if (!shouldHandle(request)) return;
    socket.on('error', () => {});
    if (!isOriginAllowed(request)) {
      rejectUpgrade(socket, 403);
      return;
    }

    Promise.resolve()
      .then(() => resolveTarget(request))
      .then((target) => {
        if (!target?.url || socket.destroyed) {
          rejectUpgrade(socket, target?.statusCode || 503);
          return;
        }
        downstreamServer.handleUpgrade(request, socket, head, (downstream) => {
          const protocols = parseProtocols(request.headers['sec-websocket-protocol']);
          const options = {
            handshakeTimeout: handshakeTimeoutMs,
            perMessageDeflate: false,
            headers: target.host ? { Host: target.host } : undefined,
          };
          const upstream = protocols.length
            ? new WebSocketClient(target.url, protocols, options)
            : new WebSocketClient(target.url, options);
          bridgeWebSockets(downstream, upstream);
        });
      })
      .catch((error) => rejectUpgrade(socket, error?.statusCode || 502));
  };

  server.on('upgrade', onUpgrade);
  const binding = {
    close() {
      server.off('upgrade', onUpgrade);
      attachedProxies.delete(server);
      try { downstreamServer.close(); } catch (_) { /* already closed */ }
    },
  };
  attachedProxies.set(server, binding);
  server.once('close', () => binding.close());
  return binding;
}

module.exports = {
  MAX_PENDING_BYTES,
  MAX_PENDING_MESSAGES,
  parseProtocols,
  rejectUpgrade,
  bridgeWebSockets,
  attachWebSocketProxy,
};

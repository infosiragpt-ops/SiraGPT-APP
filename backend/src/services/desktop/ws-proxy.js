'use strict';

/**
 * Authenticated same-origin WS proxy for SiraComputer (F7.2).
 *
 * Path: /ws/desktop/:sessionId  (siragpt.com, never api.siragpt.com)
 * Token is scoped userId/chatId/sessionId. Upstream is the session
 * handle's noVNC/websockify loopback (or the provider handle URL).
 * Container ports are not published to the internet.
 */

const http = require('http');
const { URL } = require('url');
const WebSocket = require('ws');
const { isDesktopEnabled } = require('./session-manager');
const { extractDesktopWsToken, verifyDesktopWsToken } = require('./ws-token');

const OPEN = 1;
const CONNECTING = 0;
const DESKTOP_WS_PATH = /^\/ws\/desktop\/([^/]+)$/;

function requestPath(request) {
  const rawUrl = String(request && request.url || '');
  const q = rawUrl.indexOf('?');
  return q === -1 ? rawUrl : rawUrl.slice(0, q);
}

function parseDesktopWsUpgrade(request) {
  const pathname = requestPath(request);
  const match = DESKTOP_WS_PATH.exec(pathname);
  if (!match) return null;
  let sessionId = match[1];
  try {
    sessionId = decodeURIComponent(sessionId);
  } catch (_) {
    return null;
  }
  return { sessionId, token: extractDesktopWsToken(request) };
}

function validCloseCode(code) {
  const value = Number(code);
  if (!Number.isInteger(value) || value < 1000 || value > 4999) return 1011;
  if ([1004, 1005, 1006, 1015].includes(value)) return 1011;
  return value;
}

function rejectUpgrade(socket, statusCode = 401) {
  if (!socket || socket.destroyed) return;
  const status = [401, 403, 404, 423, 503].includes(Number(statusCode))
    ? Number(statusCode)
    : 401;
  const reason = http.STATUS_CODES[status] || 'Unauthorized';
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

function closePeer(peer, code = 1011, reason = 'desktop_ws_closed') {
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
  downstream.on('message', (data, isBinary) => {
    if (upstream.readyState === OPEN) {
      forwardMessage(upstream, data, isBinary);
      return;
    }
    if (pending.length >= 32) {
      closePeer(downstream, 1009, 'desktop_ws_queue');
      closePeer(upstream, 1009, 'desktop_ws_queue');
      return;
    }
    pending.push({ data, isBinary });
  });
  upstream.on('open', () => {
    for (const message of pending.splice(0)) {
      if (!forwardMessage(upstream, message.data, message.isBinary)) break;
    }
  });
  upstream.on('message', (data, isBinary) => forwardMessage(downstream, data, isBinary));
  downstream.on('close', (code, reason) => closePeer(upstream, code, reason));
  upstream.on('close', (code, reason) => closePeer(downstream, code, reason));
  downstream.on('error', () => closePeer(upstream));
  upstream.on('error', () => closePeer(downstream));
}

function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

/**
 * Resolve the session handle's noVNC/websockify target.
 * Prefer an explicit loopback port; otherwise the provider handle URL
 * if it is loopback. Never take a URL from the browser.
 */
function resolveNovncTarget(record) {
  if (!record) return null;
  const handle = record.handle || {};
  const port = Number(handle.novncPort || handle.websockifyPort || record.novncPort || 0);
  if (Number.isInteger(port) && port > 0 && port < 65536) {
    return `ws://127.0.0.1:${port}/`;
  }
  const raw = String(
    handle.novncWsUrl || handle.wsTarget || record.upstreamWs || handle.wsUrl || '',
  ).trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    return null;
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
  if (!isLoopbackHost(parsed.hostname)) return null;
  return parsed.toString();
}

function authorizeDesktopWs(request, { getManager, env, secret } = {}) {
  const parsed = parseDesktopWsUpgrade(request);
  if (!parsed) return { statusCode: 404 };
  if (!isDesktopEnabled(env || process.env)) {
    return { statusCode: 503, error: 'desktop_disabled' };
  }
  const claims = verifyDesktopWsToken(parsed.token, { env, secret });
  if (!claims) return { statusCode: 401, error: 'desktop_ws_unauthorized' };
  if (claims.sessionId !== parsed.sessionId) {
    return { statusCode: 403, error: 'desktop_ws_session_mismatch' };
  }
  const mgr = typeof getManager === 'function' ? getManager() : null;
  const record = mgr && typeof mgr.getRecord === 'function'
    ? mgr.getRecord(parsed.sessionId)
    : null;
  if (!record) return { statusCode: 404, error: 'desktop_session_not_found' };
  if (!record.userId || claims.userId !== String(record.userId)) {
    return { statusCode: 403, error: 'desktop_ws_user_mismatch' };
  }
  if (record.chatId && claims.chatId && String(record.chatId) !== String(claims.chatId)) {
    return { statusCode: 403, error: 'desktop_ws_chat_mismatch' };
  }
  const url = resolveNovncTarget(record);
  if (!url) return { statusCode: 503, error: 'desktop_ws_target_missing' };
  return { url, sessionId: parsed.sessionId };
}

function attachDesktopWebSocketProxy(server, opts = {}) {
  if (!server || typeof server.on !== 'function') throw new TypeError('server is required');
  const env = opts.env || process.env;
  const WebSocketClient = opts.WebSocketClient || WebSocket;
  const WebSocketServer = opts.WebSocketServer || WebSocket.Server;
  const downstreamServer = new WebSocketServer({ noServer: true });
  const handshakeTimeoutMs = Number(opts.handshakeTimeoutMs) > 0
    ? Number(opts.handshakeTimeoutMs)
    : 10_000;

  const onUpgrade = (request, socket, head) => {
    if (!parseDesktopWsUpgrade(request) || socket.destroyed) return;
    socket.on('error', () => {});
    const decision = authorizeDesktopWs(request, {
      getManager: opts.getManager,
      env,
      secret: opts.secret,
    });
    if (!decision.url) {
      rejectUpgrade(socket, decision.statusCode || 401);
      return;
    }
    downstreamServer.handleUpgrade(request, socket, head, (downstream) => {
      const upstream = new WebSocketClient(decision.url, {
        handshakeTimeout: handshakeTimeoutMs,
        perMessageDeflate: false,
      });
      bridgeWebSockets(downstream, upstream);
    });
  };

  server.on('upgrade', onUpgrade);
  const binding = {
    close() {
      server.off('upgrade', onUpgrade);
      try { downstreamServer.close(); } catch (_) { /* already closed */ }
    },
  };
  server.once('close', () => binding.close());
  return binding;
}

module.exports = {
  DESKTOP_WS_PATH,
  parseDesktopWsUpgrade,
  resolveNovncTarget,
  authorizeDesktopWs,
  attachDesktopWebSocketProxy,
  rejectUpgrade,
  isLoopbackHost,
};

'use strict';

/**
 * agentes-coding/terminal — session PTY stub (AGENTES_CODING_V2 Phase 3d).
 *
 * Interactive exec over injectable transport (memory / SSE / WebSocket).
 * Path-jailed cwd. Spanish errors. API-only: UI-lock keeps the Phase 3a
 * HTTP exec stub. xtermjs/xterm.js is pattern (protocol + later npm).
 *
 * See docs/agentes-coding-terminal.md
 */

const { isAgentesCodingV2Enabled } = require('../flags');
const { fail, CodingSandboxError } = require('../coding-sandbox/errors');
const { attachWebSocketPath, requestPath } = require('../../../utils/websocket-upgrade-router');
const {
  createTerminalHub,
  createChannel,
  jailCwd,
  MAX_CHANNELS_PER_SESSION,
} = require('./hub');
const {
  createMemoryTransport,
  createSseTransport,
  createWebSocketTransport,
} = require('./transport');
const {
  decodeFrame,
  encodeFrame,
  encodeSse,
  queryFromUrl,
  readBearerOrToken,
  CLIENT_TYPES,
  SERVER_TYPES,
} = require('./protocol');

const WS_PATH = '/api/agentes-coding/terminal';

function requireEnabled(env = process.env) {
  if (!isAgentesCodingV2Enabled(env)) fail('E_FLAG_OFF');
}

function defaultWsAuthenticate(request) {
  const token = readBearerOrToken(request);
  if (!token) return null;
  return { token: true };
}

function attachTerminalWebSocket(httpServer, opts = {}) {
  if (!httpServer) {
    const err = new TypeError('server is required');
    throw err;
  }
  const env = opts.env || process.env;
  const hub = opts.hub;
  if (!hub || typeof hub.get !== 'function') {
    fail('E_PARAMS', 'Falta el hub de terminal.');
  }
  const path = opts.path || WS_PATH;
  const authenticate = typeof opts.authenticate === 'function'
    ? opts.authenticate
    : defaultWsAuthenticate;
  const WebSocketServer = opts.WebSocketServer
    || (opts.ws && opts.ws.Server)
    || require('ws').Server;
  const wss = new WebSocketServer({ noServer: true });
  const detachPath = attachWebSocketPath(httpServer, wss, path);

  wss.on('connection', (socket, request) => {
    Promise.resolve()
      .then(async () => {
        if (!isAgentesCodingV2Enabled(env)) {
          if (typeof socket.close === 'function') socket.close(4404, 'not_found');
          return;
        }
        const auth = await authenticate(request);
        if (!auth) {
          if (typeof socket.close === 'function') socket.close(4401, 'unauthorized');
          return;
        }
        const params = queryFromUrl(request && request.url);
        const channelId = params.get('channelId');
        const channel = hub.get(channelId);
        const transport = createWebSocketTransport(socket);
        channel.attach(transport);
        if (typeof socket.on === 'function') {
          socket.on('close', () => channel.detach(transport));
        }
      })
      .catch((err) => {
        try {
          const payload = encodeFrame({
            type: 'error',
            error: err instanceof CodingSandboxError ? err.code : (err.code || 'E_TERMINAL_FAILED'),
            message: err.message || 'No se pudo abrir el canal de terminal.',
          });
          if (typeof socket.send === 'function') socket.send(payload);
          if (typeof socket.close === 'function') socket.close(4400);
        } catch (_) { /* ignore */ }
      });
  });

  return {
    path,
    wss,
    detach() {
      detachPath();
      if (typeof wss.close === 'function') {
        try { wss.close(); } catch (_) { /* ignore */ }
      }
    },
  };
}

async function openForRequest(hub, sessionId, body, env) {
  requireEnabled(env);
  return hub.open({
    sessionId,
    cwd: body && body.cwd,
    cols: body && body.cols,
    rows: body && body.rows,
    transport: body && body.transport,
  });
}

module.exports = {
  createTerminalHub,
  createChannel,
  createMemoryTransport,
  createSseTransport,
  createWebSocketTransport,
  attachTerminalWebSocket,
  openForRequest,
  jailCwd,
  requireEnabled,
  decodeFrame,
  encodeFrame,
  encodeSse,
  queryFromUrl,
  readBearerOrToken,
  defaultWsAuthenticate,
  CLIENT_TYPES,
  SERVER_TYPES,
  MAX_CHANNELS_PER_SESSION,
  WS_PATH,
  CodingSandboxError,
  requestPath,
};

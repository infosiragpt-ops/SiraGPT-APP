'use strict';

const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const { authenticateToken } = require('../middleware/auth');
const {
  HOP_BY_HOP_HEADERS,
  STRIP_REQUEST_HEADERS,
} = require('../utils/proxy-headers');
const { bridgeWebSockets, rejectUpgrade } = require('../services/codex/preview-websocket-proxy');
const memberDesktop = require('../services/member-desktop');

const router = express.Router();

function safeToken(token) {
  return String(token || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 2048);
}

function upstreamPath(req) {
  const raw = String(req.originalUrl || req.url || '');
  const marker = `/vnc/${encodeURIComponent(req.params.token)}`;
  const idx = raw.indexOf(marker);
  let rest = idx >= 0 ? raw.slice(idx + marker.length) : '/';
  if (!rest || rest === '/') rest = '/vnc.html';
  return rest.startsWith('/') ? rest : `/${rest}`;
}

router.post('/session', authenticateToken, async (req, res) => {
  try {
    const session = await memberDesktop.ensureDesktop({ userId: req.user.id });
    return res.json({
      ok: true,
      resumed: session.resumed,
      vncPath: session.vncPath,
      label: session.resumed
        ? 'Escritorio persistente · reanudado · una máquina por miembro · noVNC'
        : 'Escritorio persistente · nueva máquina · una por miembro · noVNC',
    });
  } catch (error) {
    const status = error.code === 'desktop_unavailable' ? 503 : error.code === 'user_required' ? 401 : 500;
    return res.status(status).json({
      ok: false,
      error: error.code || 'desktop_start_failed',
      message: error.message || 'No se pudo abrir el escritorio Linux.',
    });
  }
});

router.get('/session', authenticateToken, async (req, res) => {
  try {
    const session = await memberDesktop.ensureDesktop({ userId: req.user.id });
    return res.json({
      ok: true,
      resumed: session.resumed,
      vncPath: session.vncPath,
      label: session.resumed
        ? 'Escritorio persistente · reanudado · una máquina por miembro · noVNC'
        : 'Escritorio persistente · nueva máquina · una por miembro · noVNC',
    });
  } catch (error) {
    const status = error.code === 'desktop_unavailable' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: error.code || 'desktop_unavailable',
      message: error.message || 'El escritorio Linux no está disponible.',
    });
  }
});

async function proxyVnc(req, res) {
  const token = safeToken(req.params.token);
  const target = await memberDesktop.resolveDesktopTarget(token);
  if (!target) {
    return res.status(403).json({ error: 'forbidden', message: 'Sesión de escritorio inválida o caducada.' });
  }

  const headers = {};
  for (const [key, value] of Object.entries(req.headers || {})) {
    const lower = key.toLowerCase();
    if (STRIP_REQUEST_HEADERS.has(lower) || HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === 'host' || lower === 'content-length') continue;
    headers[key] = value;
  }
  headers.host = `127.0.0.1:${target.port}`;

  const upstream = http.request(
    {
      hostname: '127.0.0.1',
      port: target.port,
      method: req.method,
      path: upstreamPath(req),
      headers,
    },
    (up) => {
      const out = {};
      for (const [key, value] of Object.entries(up.headers || {})) {
        const lower = key.toLowerCase();
        if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'set-cookie' || lower === 'content-security-policy') continue;
        out[key] = value;
      }
      out['x-frame-options'] = 'SAMEORIGIN';
      out['content-security-policy'] = "frame-ancestors 'self' https://siragpt.com https://www.siragpt.com";
      res.writeHead(up.statusCode || 502, out);
      up.pipe(res);
    },
  );
  res.on('close', () => upstream.destroy());
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.status(502).json({ error: 'desktop_unreachable', message: 'El escritorio no respondió.' });
    } else {
      try { res.end(); } catch (_) { /* closed */ }
    }
  });
  if (req.method === 'GET' || req.method === 'HEAD') upstream.end();
  else req.pipe(upstream);
}

router.all('/vnc/:token/*', proxyVnc);
router.all('/vnc/:token', proxyVnc);

function attachMemberDesktopWebSocketProxy(server, {
  WebSocketClient = WebSocket,
  WebSocketServer = WebSocket.Server,
} = {}) {
  if (!server || typeof server.on !== 'function') throw new TypeError('server is required');
  const downstreamServer = new WebSocketServer({ noServer: true });
  const pattern = /^\/api\/member-desktop\/vnc\/([A-Za-z0-9._-]+)\/websockify(?:\/|$)/;
  const onUpgrade = (request, socket, head) => {
    const path = String(request?.url || '').split('?')[0];
    const match = pattern.exec(path);
    if (!match) return;
    socket.on('error', () => {});
    memberDesktop.resolveDesktopTarget(match[1])
      .then((target) => {
        if (!target?.port || socket.destroyed) return rejectUpgrade(socket, 403);
        downstreamServer.handleUpgrade(request, socket, head, (downstream) => {
          const options = {
            handshakeTimeout: 10_000,
            perMessageDeflate: false,
            headers: { Host: `127.0.0.1:${target.port}` },
          };
          const upstream = new WebSocketClient(`ws://127.0.0.1:${target.port}/websockify`, options);
          bridgeWebSockets(downstream, upstream);
        });
      })
      .catch(() => rejectUpgrade(socket, 403));
  };
  server.on('upgrade', onUpgrade);
  const binding = {
    close() {
      server.off('upgrade', onUpgrade);
      try { downstreamServer.close(); } catch (_) { /* noop */ }
    },
  };
  server.once('close', binding.close);
  return binding;
}

router.attachWebSocketProxy = attachMemberDesktopWebSocketProxy;

module.exports = router;
module.exports.attachMemberDesktopWebSocketProxy = attachMemberDesktopWebSocketProxy;

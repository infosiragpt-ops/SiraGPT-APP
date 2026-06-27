'use strict';

/**
 * code-runner route — drives the no-Docker host runner that boots a generated
 * project as a REAL dev server (vite) on a PRIVATE localhost port, then exposes
 * it to the browser through a same-origin reverse proxy so the /code preview can
 * iframe it without Docker and without reaching the server's localhost directly.
 *
 *   GET  /api/code-runner/health            → { ok, enabled }            (public)
 *   POST /api/code-runner/start             → { runId, phase, devUrl }   (auth)
 *   GET  /api/code-runner/:runId/status         → { running, ready, ... }    (auth)
 *   POST /api/code-runner/:runId/stop           → { ok }                     (auth)
 *   ALL  /api/code-runner/:runId/:token/app/*   → reverse-proxy to the dev server
 *                                                 (gated by the run-scoped path token)
 *
 * Disabled unless CODE_HOST_RUNNER is truthy (host-runner.enabled). The old
 * opencode/Docker path is not usable on Replit and is no longer the fallback.
 */

const http = require('http');
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const hostRunner = require('../services/code/host-runner');

const router = express.Router();

// The Vite dev server runs UNTRUSTED generated code. Never hand it the user's
// SiraGPT credentials, and never let it set cookies on the SiraGPT origin.
const STRIP_REQUEST_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization']);
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function safeRunId(runId) {
  return String(runId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

// The preview token is hex (crypto.randomBytes → hex). Strip anything else.
function safeToken(token) {
  return String(token || '').replace(/[^a-f0-9]/gi, '').slice(0, 128);
}

// Public: lets the UI know whether the host runner is available here.
router.get('/health', (req, res) => {
  res.json({ ok: true, enabled: hostRunner.enabled() });
});

router.post('/start', authenticateToken, async (req, res) => {
  try {
    if (!hostRunner.startAllowed(req.user)) {
      return res.status(403).json({ error: 'forbidden', message: 'Tu cuenta no puede ejecutar apps aquí.' });
    }
    const { runId, files } = req.body || {};
    const out = await hostRunner.startRun({ runId, userId: req.user.id, files });
    // No cookie: the reverse-proxy gate uses a run-scoped token embedded in
    // out.devUrl's path (see host-runner). Every asset/module/dynamic-import the
    // sandboxed (opaque-origin) iframe requests carries it automatically, so it
    // authenticates regardless of the browser's module-script credentials mode.
    return res.json(out);
  } catch (err) {
    if (err && err.code === 'disabled') {
      return res.status(503).json({ error: 'host_runner_disabled', message: 'El runner local está desactivado en este entorno.' });
    }
    if (err && err.code === 'no_package') {
      return res.status(400).json({ error: 'no_package', message: err.message });
    }
    // Don't echo err.message — fs failures (ENOENT/ENOTDIR/EACCES) embed the
    // absolute server tmp path (CWE-209). Log server-side, return generic.
    console.error('[code-runner] start failed:', (err && err.message) || err);
    return res.status(500).json({ error: 'start_failed', message: 'No se pudo iniciar el runner.' });
  }
});

router.get('/:runId/status', authenticateToken, (req, res) => {
  const st = hostRunner.getStatus(req.params.runId, req.user.id);
  if (st === null) return res.status(403).json({ error: 'forbidden' });
  return res.json(st);
});

router.post('/:runId/stop', authenticateToken, (req, res) => {
  hostRunner.stopRun(req.params.runId);
  return res.json({ ok: true });
});

/**
 * Reverse-proxy every request under /:runId/:token/app to the run's private dev
 * server. Auth is the run-scoped token in the URL path — NOT a session lookup,
 * so we don't hit the DB on every asset fetch, and NOT a cookie, so module/asset
 * fetches from the sandboxed opaque-origin iframe authenticate regardless of the
 * browser's credentials mode. The dev server only ever listens on 127.0.0.1, so
 * this proxy is the only path the browser can take to reach it (vite is launched
 * with --base matching this prefix, incl. the token, so assets resolve).
 *
 * Mounted with router.use (prefix match) so it works on Express 4 and 5 and
 * matches every nested asset path. We forward the FULL req.originalUrl (not
 * stripped) because vite's base includes this prefix.
 */
function proxyApp(req, res) {
  const sid = safeRunId(req.params.runId);
  const token = safeToken(req.params.token);
  const target = hostRunner.getRunForProxy(sid, token);
  if (!target) return res.status(403).json({ error: 'forbidden' });

  // Forward only safe request headers. Strip the user's cookie/authorization so
  // the untrusted dev server never sees SiraGPT credentials, and drop hop-by-hop.
  const fwdHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (STRIP_REQUEST_HEADERS.has(lk) || HOP_BY_HOP_HEADERS.has(lk)) continue;
    fwdHeaders[k] = v;
  }
  fwdHeaders.host = `127.0.0.1:${target.port}`;

  const upstream = http.request(
    {
      hostname: '127.0.0.1',
      port: target.port,
      method: req.method,
      path: req.originalUrl,
      headers: fwdHeaders,
    },
    (up) => {
      // Strip Set-Cookie (untrusted server must not set cookies on our origin),
      // hop-by-hop headers, and any upstream CORS headers before relaying.
      const headers = {};
      for (const [k, v] of Object.entries(up.headers)) {
        const lk = k.toLowerCase();
        if (lk === 'set-cookie' || HOP_BY_HOP_HEADERS.has(lk)) continue;
        if (lk.startsWith('access-control-')) continue; // we set our own below
        headers[k] = v;
      }
      headers['cache-control'] = 'no-store';
      // The preview runs in a sandboxed iframe with an opaque ("null") origin, so
      // its ES-module/asset fetches are cross-origin and need CORS. Access is
      // gated by the unguessable run token in the URL path (not a cookie), so we
      // allow the read WITHOUT credentials — echo the origin (covers "null").
      const reqOrigin = req.headers.origin;
      if (reqOrigin) {
        headers['access-control-allow-origin'] = reqOrigin;
        headers['vary'] = headers['vary'] ? `${headers['vary']}, Origin` : 'Origin';
      } else {
        headers['access-control-allow-origin'] = '*';
      }
      // The token lives in the URL; stop it leaking to third parties via Referer.
      headers['referrer-policy'] = 'no-referrer';
      res.writeHead(up.statusCode || 502, headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.status(502).json({ error: 'runner_unreachable', message: 'El dev server no respondió.' });
    } else {
      try { res.end(); } catch (_) { /* already closed */ }
    }
  });
  // GET/HEAD carry no body; for other methods the global json parser may have
  // already drained the stream (preview is GET-heavy, so this is acceptable).
  if (req.method === 'GET' || req.method === 'HEAD') upstream.end();
  else req.pipe(upstream);
}

router.use('/:runId/:token/app', proxyApp);

module.exports = router;

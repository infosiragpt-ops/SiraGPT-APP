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
const { Readable } = require('stream');
const { authenticateToken } = require('../middleware/auth');
const hostRunner = require('../services/code/host-runner');

const router = express.Router();

// The Vite dev server runs UNTRUSTED generated code. Never hand it the user's
// SiraGPT credentials, and never let it set cookies on the SiraGPT origin.
const {
  STRIP_REQUEST_HEADERS,
  HOP_BY_HOP_HEADERS,
  buildUpstreamRequestHeaders,
  isForwardableResponseHeader,
} = require('../utils/proxy-headers');

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
    const { runId, files, env } = req.body || {};
    const out = await hostRunner.startRun({ runId, userId: req.user.id, files, env });
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
    if (err && err.code === 'forbidden') {
      return res.status(403).json({ error: 'forbidden', message: 'No puedes reiniciar la ejecución de otro usuario.' });
    }
    if (err && err.code === 'capacity_full') {
      return res.status(503).json({ error: 'capacity_full', message: err.message });
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
  // Ownership-checked: a user can only stop their OWN run (no-op otherwise).
  const stopped = hostRunner.stopRun(req.params.runId, req.user.id);
  return res.json({ ok: stopped });
});

function applyPreviewFrameHeaders(_req, res, next) {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  next();
}

function proxiedPath(req) {
  const marker = `/api/code-runner/${encodeURIComponent(req.params.runId)}/proxy`;
  const raw = req.originalUrl || req.url || '/';
  const idx = raw.indexOf(marker);
  if (idx === -1) return '/';
  const rest = raw.slice(idx + marker.length);
  return rest ? rest : '/';
}

function tokenAppPath(req) {
  // Vite is started with --base equal to the public tokenized app prefix.
  // Forward that full browser path upstream; stripping it to / would make Vite
  // redirect back to the base URL, which traps the iframe in a 302 loop.
  const raw = req.originalUrl || req.url || '/';
  if (raw.startsWith('/api/code-runner/')) return raw;
  const base = req.baseUrl || '/api/code-runner';
  const url = req.url || '/';
  return `${base}${url.startsWith('/') ? url : `/${url}`}`;
}

/**
 * Reverse-proxy every request under /:runId/:token/app to the run's private dev
 * server. Auth is the run-scoped token in the URL path, not a cookie, so Vite
 * module/asset fetches from the sandboxed opaque-origin iframe keep working.
 */
function proxyApp(req, res) {
  const sid = safeRunId(req.params.runId);
  const token = safeToken(req.params.token);
  const target = hostRunner.getRunForProxy(sid, token);
  if (!target) return res.status(403).json({ error: 'forbidden' });

  const fwdHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (STRIP_REQUEST_HEADERS.has(lk) || HOP_BY_HOP_HEADERS.has(lk)) continue;
    if (lk === 'host' || lk === 'content-length') continue;
    fwdHeaders[k] = v;
  }
  fwdHeaders.host = `127.0.0.1:${target.port}`;

  const upstream = http.request(
    {
      hostname: '127.0.0.1',
      port: target.port,
      method: req.method,
      path: tokenAppPath(req),
      headers: fwdHeaders,
    },
    (up) => {
      const headers = {};
      for (const [k, v] of Object.entries(up.headers)) {
        const lk = k.toLowerCase();
        if (lk === 'set-cookie' || HOP_BY_HOP_HEADERS.has(lk)) continue;
        if (lk === 'content-security-policy' || lk === 'x-frame-options') continue;
        if (lk.startsWith('access-control-')) continue;
        headers[k] = v;
      }
      headers['cache-control'] = 'no-store';
      headers['x-frame-options'] = 'SAMEORIGIN';
      headers['content-security-policy'] = "frame-ancestors 'self'";

      const reqOrigin = req.headers.origin;
      if (reqOrigin) {
        headers['access-control-allow-origin'] = reqOrigin;
        headers.vary = headers.vary ? `${headers.vary}, Origin` : 'Origin';
      } else {
        headers['access-control-allow-origin'] = '*';
      }
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
  if (req.method === 'GET' || req.method === 'HEAD') upstream.end();
  else req.pipe(upstream);
}

router.use('/:runId/:token/app', applyPreviewFrameHeaders, proxyApp);

// Authenticated preview proxy. In production the browser cannot iframe the
// backend container's localhost port, so the runner exposes each dev server
// through this same-origin path instead of opening dynamic public ports.
router.use('/:runId/proxy', applyPreviewFrameHeaders, authenticateToken, async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) {
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const target = hostRunner.getProxyTarget(req.params.runId, req.user.id);
  if (target.error === 'forbidden') return res.status(403).json({ error: 'forbidden' });
  if (target.error === 'not_found') return res.status(404).json({ error: 'run_not_found' });
  if (target.error === 'not_ready') {
    return res.status(503).json({ error: 'run_not_ready', phase: target.phase, message: target.message });
  }

  const suffix = proxiedPath(req);
  const upstreamUrl = `http://127.0.0.1:${target.port}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
  const headers = buildUpstreamRequestHeaders(req.headers, target.port);

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(Number(process.env.CODE_RUNNER_PROXY_TIMEOUT_MS) || 30_000),
    });
  } catch (err) {
    return res.status(502).json({ error: 'preview_proxy_failed', message: err.message });
  }

  res.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    if (!isForwardableResponseHeader(key.toLowerCase())) return;
    res.setHeader(key, value);
  });
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'HEAD' || !upstream.body) return res.end();
  return Readable.fromWeb(upstream.body).pipe(res);
});

module.exports = router;

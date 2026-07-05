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

const PREVIEW_SELECTOR_BRIDGE = `<script>
(function(){
  if (window.__sgptPreviewSelectorBridge) return;
  window.__sgptPreviewSelectorBridge = true;
  var active = false;
  var box = null;
  var label = null;
  var lastTarget = null;
  var pendingTarget = null;
  var frame = 0;
  var style = null;
  function send(type, extra){try{var payload=extra||{};payload.type=type;parent.postMessage(payload,'*')}catch(e){}}
  function norm(value, limit){ return String(value || '').replace(/\\s+/g, ' ').trim().slice(0, limit || 220); }
  function escIdent(value){
    if (!value) return '';
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function(ch){ return '\\\\' + ch; });
  }
  function classNameOf(el){
    if (!el) return '';
    if (typeof el.className === 'string') return el.className;
    if (el.className && typeof el.className.baseVal === 'string') return el.className.baseVal;
    return '';
  }
  function isSelectorUi(el){
    return !!(el && el.nodeType === 1 && el.getAttribute('data-sgpt-selector-ui') === 'true');
  }
  function pointFromEvent(event){
    var p = event;
    if (event && event.touches && event.touches[0]) p = event.touches[0];
    if (event && event.changedTouches && event.changedTouches[0]) p = event.changedTouches[0];
    if (!p || typeof p.clientX !== 'number' || typeof p.clientY !== 'number') return null;
    return { x: p.clientX, y: p.clientY };
  }
  function targetFromEvent(event){
    var point = pointFromEvent(event);
    var target = point ? document.elementFromPoint(point.x, point.y) : null;
    if (!target && event && typeof event.composedPath === 'function') {
      var path = event.composedPath();
      for (var i = 0; i < path.length; i += 1) {
        if (path[i] && path[i].nodeType === 1) { target = path[i]; break; }
      }
    }
    if (!target && event) target = event.target;
    while (target && isSelectorUi(target)) target = target.parentElement;
    if (!target || target === document || target === document.documentElement || target === document.body || target.nodeType !== 1) return null;
    return target;
  }
  function parentSummary(el){
    var parent = el && el.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) return null;
    return {
      selector: shortSelector(parent),
      tagName: (parent.tagName || '').toLowerCase(),
      className: norm(classNameOf(parent), 180),
      text: norm(parent.innerText || parent.textContent || '', 180)
    };
  }
  function shortSelector(el){
    if (!el || el.nodeType !== 1) return '';
    var tag = (el.tagName || '').toLowerCase();
    if (el.id) return tag + '#' + escIdent(el.id);
    var out = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      var part = (node.tagName || '').toLowerCase();
      var classes = classNameOf(node).split(/\\s+/).filter(Boolean).slice(0, 2);
      if (classes.length) part += '.' + classes.map(escIdent).join('.');
      else if (node.parentElement) {
        var same = Array.prototype.filter.call(node.parentElement.children, function(child){ return child.tagName === node.tagName; });
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      out.unshift(part);
      if (node.id || part === 'body' || part === 'html') break;
      node = node.parentElement;
      depth += 1;
    }
    return out.join(' > ');
  }
  function ensureUi(){
    if (!style) {
      style = document.createElement('style');
      style.setAttribute('data-sgpt-selector-ui', 'true');
      style.textContent = 'html[data-sgpt-selecting="true"],html[data-sgpt-selecting="true"] *{cursor:crosshair!important;user-select:none!important;-webkit-user-select:none!important;-webkit-tap-highlight-color:transparent!important}html[data-sgpt-selecting="true"]{touch-action:none!important}';
      (document.head || document.documentElement).appendChild(style);
    }
    if (!box) {
      box = document.createElement('div');
      box.setAttribute('data-sgpt-selector-ui', 'true');
      box.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #7c3aed;border-radius:8px;box-shadow:0 0 0 99999px rgba(15,23,42,.08),0 8px 24px rgba(124,58,237,.18);background:rgba(124,58,237,.07);will-change:transform,width,height;';
      document.documentElement.appendChild(box);
    }
    if (!label) {
      label = document.createElement('div');
      label.setAttribute('data-sgpt-selector-ui', 'true');
      label.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;max-width:min(340px,calc(100vw - 24px));border:1px solid rgba(255,255,255,.34);border-radius:999px;background:rgba(17,24,39,.92);color:white;padding:6px 10px;font:600 12px/1.2 Inter,system-ui,sans-serif;box-shadow:0 12px 28px rgba(15,23,42,.18);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;will-change:transform;';
      document.documentElement.appendChild(label);
    }
  }
  function draw(el){
    if (!el || el.nodeType !== 1 || isSelectorUi(el)) return;
    ensureUi();
    var rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    box.style.transform = 'translate(' + Math.max(0, rect.left) + 'px,' + Math.max(0, rect.top) + 'px)';
    box.style.width = Math.max(0, rect.width) + 'px';
    box.style.height = Math.max(0, rect.height) + 'px';
    var selector = shortSelector(el) || (el.tagName || '').toLowerCase();
    label.textContent = 'Seleccionar ' + selector;
    var top = Math.max(8, rect.top - 34);
    var left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 348));
    label.style.transform = 'translate(' + left + 'px,' + top + 'px)';
  }
  function scheduleDraw(el){
    if (!el || el.nodeType !== 1 || isSelectorUi(el)) return;
    pendingTarget = el;
    lastTarget = el;
    if (frame) return;
    frame = window.requestAnimationFrame(function(){
      frame = 0;
      draw(pendingTarget);
    });
  }
  function describe(el){
    var rect = el.getBoundingClientRect();
    return {
      selectionMethod: 'dom',
      selector: shortSelector(el),
      tagName: (el.tagName || '').toLowerCase(),
      id: el.id || '',
      className: norm(classNameOf(el), 260),
      text: norm(el.innerText || el.textContent || '', 260),
      parent: parentSummary(el),
      role: el.getAttribute('role') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      href: el.getAttribute('href') || '',
      src: el.getAttribute('src') || '',
      rect: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
      pageUrl: location.pathname + location.search + location.hash,
      pageTitle: document.title || '',
      capturedAt: new Date().toISOString()
    };
  }
  function cleanup(reason){
    active = false;
    lastTarget = null;
    pendingTarget = null;
    if (frame) { window.cancelAnimationFrame(frame); frame = 0; }
    document.documentElement.removeAttribute('data-sgpt-selecting');
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('mousemove', onPointerMove, true);
    document.removeEventListener('click', onClickFallback, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('resize', onViewportChange, true);
    if (box) { box.remove(); box = null; }
    if (label) { label.remove(); label = null; }
    if (reason) send('sgpt-preview-selection-cancelled', { reason: reason });
  }
  function capture(event, explicitTarget){
    if (!active) return;
    if (event && event.preventDefault) event.preventDefault();
    if (event && event.stopPropagation) event.stopPropagation();
    if (event && event.stopImmediatePropagation) event.stopImmediatePropagation();
    var target = explicitTarget || targetFromEvent(event) || lastTarget;
    if (!target || target.nodeType !== 1) return cleanup('No se pudo seleccionar ese elemento.');
    var detail = describe(target);
    cleanup('');
    send('sgpt-preview-selection', { detail: detail });
  }
  function onPointerMove(event){
    if (!active) return;
    scheduleDraw(targetFromEvent(event));
  }
  function onPointerDown(event){
    capture(event);
  }
  function onClickFallback(event){
    if (!active) return;
    capture(event);
  }
  function onViewportChange(){
    if (!active || !lastTarget) return;
    scheduleDraw(lastTarget);
  }
  function onKey(event){
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cleanup('Selección cancelada.');
    } else if (event.key === 'Enter' && lastTarget) {
      capture(event, lastTarget);
    }
  }
  function start(){
    if (active) cleanup('');
    active = true;
    ensureUi();
    document.documentElement.setAttribute('data-sgpt-selecting', 'true');
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('mousemove', onPointerMove, true);
    document.addEventListener('click', onClickFallback, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange, true);
    send('sgpt-preview-selection-ready', {});
  }
  window.addEventListener('message', function(event){
    var msg = event.data || {};
    if (msg.type === 'sgpt-preview-select-start') start();
    if (msg.type === 'sgpt-preview-select-cancel') cleanup('Selección cancelada.');
  });
})();
</script>`;

function shouldInjectPreviewSelector(req, upstreamHeaders) {
  if (req.method !== 'GET') return false;
  const contentType = String(upstreamHeaders['content-type'] || '');
  const contentEncoding = String(upstreamHeaders['content-encoding'] || '');
  return /text\/html|application\/xhtml\+xml/i.test(contentType) && !contentEncoding;
}

function injectPreviewSelector(html) {
  if (!html || html.includes('__sgptPreviewSelectorBridge')) return html;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${PREVIEW_SELECTOR_BRIDGE}</head>`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, (m) => `${m}${PREVIEW_SELECTOR_BRIDGE}`);
  return `${PREVIEW_SELECTOR_BRIDGE}${html}`;
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

// Type verification: run `npx tsc --noEmit` in the run's workspace and return
// parsed diagnostics the auto-repair loop can act on. Ownership-checked.
router.post('/:runId/verify', authenticateToken, async (req, res) => {
  try {
    const result = await hostRunner.verifyRun(req.params.runId, req.user.id);
    if (result && result.status === 403) return res.status(403).json({ error: 'forbidden' });
    if (result && result.status === 404) return res.status(404).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
});

// Functional "does the app actually render?" check — drives the run's live dev
// server through headless chromium and reports a verdict. Companion to the
// tsc-based /verify (which only proves the code type-checks). Ownership-checked
// + phase-gated inside verifyRuntime; degrades to { skipped:true, ok:true } when
// no browser is available, so it never blocks the app.
router.post('/:runId/verify-runtime', authenticateToken, async (req, res) => {
  try {
    const verdict = await hostRunner.verifyRuntime(req.params.runId, req.user.id);
    if (verdict && verdict.error === 'forbidden') {
      return res.status(403).json({ error: 'forbidden', message: 'No puedes verificar la ejecución de otro usuario.' });
    }
    if (verdict && verdict.error === 'not_found') {
      return res.status(404).json({ error: 'not_found', message: 'La ejecución no existe.' });
    }
    return res.json(verdict);
  } catch (err) {
    // Don't echo err.message — it may embed absolute server tmp paths (CWE-209).
    console.error('[code-runner] verify-runtime failed:', (err && err.message) || err);
    return res.status(500).json({ error: 'verify_failed', message: 'No se pudo verificar la ejecución.' });
  }
});

// Real one-shot terminal command in the run's workspace dir (the Replit-style
// Shell). Ownership-checked + host-runner-gated inside execInRun; bounded
// (non-interactive, hard timeout, output capped) and never inherits secrets.
router.post('/:runId/exec', authenticateToken, async (req, res) => {
  try {
    // Same authoritative fence as /start: CODE_HOST_RUNNER_ALLOWED_USER_IDS must
    // gate exec too (arbitrary shell), not just run creation — otherwise a user
    // dropped from the allowlist could still exec against a run they started.
    if (!hostRunner.startAllowed(req.user)) return res.status(403).json({ error: 'forbidden' });
    const command = typeof req.body?.command === 'string' ? req.body.command : '';
    const timeoutMs = Number(req.body?.timeoutMs) || undefined;
    const result = await hostRunner.execInRun(req.params.runId, req.user.id, command, { timeoutMs });
    if (result && result.status === 403) return res.status(403).json({ error: 'forbidden' });
    if (result && result.status === 404) return res.status(404).json({ error: result.error });
    if (result && result.status === 400) return res.status(400).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    console.error('[code-runner] exec failed:', (err && err.message) || err);
    return res.status(500).json({ error: 'exec_failed', message: 'No se pudo ejecutar el comando.' });
  }
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
    if (lk === 'host' || lk === 'content-length' || lk === 'accept-encoding') continue;
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
      const injectSelector = shouldInjectPreviewSelector(req, up.headers);
      const headers = {};
      for (const [k, v] of Object.entries(up.headers)) {
        const lk = k.toLowerCase();
        if (lk === 'set-cookie' || HOP_BY_HOP_HEADERS.has(lk)) continue;
        if (lk === 'content-security-policy' || lk === 'x-frame-options') continue;
        if (lk.startsWith('access-control-')) continue;
        if (injectSelector && (lk === 'content-length' || lk === 'content-encoding')) continue;
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
      if (injectSelector) {
        if (req.method === 'HEAD') {
          res.writeHead(up.statusCode || 502, headers);
          up.resume();
          return res.end();
        }
        const chunks = [];
        up.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        up.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const injected = injectPreviewSelector(body);
          headers['content-length'] = String(Buffer.byteLength(injected));
          res.writeHead(up.statusCode || 502, headers);
          res.end(injected);
        });
        up.on('error', () => {
          if (!res.headersSent) {
            res.status(502).json({ error: 'runner_stream_failed', message: 'El dev server interrumpió la respuesta.' });
          } else {
            try { res.end(); } catch (_) { /* already closed */ }
          }
        });
        return;
      }
      res.writeHead(up.statusCode || 502, headers);
      up.pipe(res);
    },
  );
  res.on('close', () => upstream.destroy());
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

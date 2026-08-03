'use strict';

const crypto = require('node:crypto');
const WebSocket = require('ws');
const {
  bridgeWebSockets,
  parseProtocols,
  rejectUpgrade,
} = require('../codex/preview-websocket-proxy');
const { redactPreviewUrl } = require('../../utils/preview-url-redaction');

// Preview URLs are bearer credentials; keep the browser window short-lived and
// require a fresh start/reuse decision instead of carrying a six-hour token.
const DEFAULT_PREVIEW_TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_PREVIEW_TOKEN_TTL_MS = 60 * 60 * 1000;
const MIN_PREVIEW_TOKEN_SECRET_BYTES = 32;
const MAX_PREVIEW_HTML_BYTES = 2 * 1024 * 1024;
const PREVIEW_NONCE_PARAM = '__sgpt_preview_nonce';
const PREVIEW_TOKEN_SECRET_KEYS = ['CODE_RUNNER_PREVIEW_TOKEN_SECRET', 'CODEX_PREVIEW_TOKEN_SECRET'];
const PREVIEW_PARENT_ORIGIN_KEYS = ['CORS_ORIGINS', 'FRONTEND_URL', 'PUBLIC_FRONTEND_URL', 'NEXT_PUBLIC_URL'];
const DEV_PARENT_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
];

function isProduction(env = process.env) {
  return String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

function previewTokenTtlMs(env = process.env) {
  const configured = Number(env.CODE_RUNNER_PREVIEW_TOKEN_TTL_MS || env.CODEX_PREVIEW_TOKEN_TTL_MS);
  if (!Number.isFinite(configured)) return DEFAULT_PREVIEW_TOKEN_TTL_MS;
  return Math.min(MAX_PREVIEW_TOKEN_TTL_MS, Math.max(60_000, configured));
}

function previewTokenSecret(env = process.env) {
  for (const key of PREVIEW_TOKEN_SECRET_KEYS) {
    const value = String(env[key] || '').trim();
    if (!value) continue;
    if (isProduction(env) && Buffer.byteLength(value, 'utf8') < MIN_PREVIEW_TOKEN_SECRET_BYTES) return null;
    return value;
  }
  // A production process must never silently fall back to a shared/dev secret.
  if (isProduction(env)) return null;
  return 'siragpt-preview-dev-secret';
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signPreviewToken(claims, env = process.env) {
  const secret = previewTokenSecret(env);
  if (!secret) throw new Error('preview_token_secret_required');
  if (!claims || typeof claims !== 'object') throw new TypeError('preview token claims are required');
  const exp = Number(claims.exp);
  if (!Number.isFinite(exp) || exp <= Date.now()) throw new TypeError('preview token exp is required');
  const body = base64urlJson(claims);
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyPreviewToken(token, env = process.env) {
  const secret = previewTokenSecret(env);
  if (!secret) return null;
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, signature] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return null;
    const exp = Number(claims.exp);
    if (!Number.isFinite(exp) || exp <= Date.now()) return null;
    const iat = Number(claims.iat);
    const now = Date.now();
    if (!Number.isFinite(iat) || iat > now + 30_000 || exp <= iat) return null;
    if (exp - now > previewTokenTtlMs(env)) return null;
    return claims;
  } catch {
    return null;
  }
}

function previewTokenFor(claims, env = process.env) {
  const now = Date.now();
  return signPreviewToken({
    ...claims,
    iat: now,
    exp: now + previewTokenTtlMs(env),
  }, env);
}

function siblingPreviewOrigin(env = process.env) {
  const raw = String(env.CODEX_PREVIEW_ORIGIN || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function normalizeOrigin(raw) {
  try {
    const url = new URL(String(raw || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function configuredOrigins(raw) {
  return String(raw || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry && entry !== '*')
    .map(normalizeOrigin)
    .filter(Boolean);
}

// CODEX_PREVIEW_ORIGIN is the child origin (the Vite/Caddy host), never a
// frame ancestor. Parents come from the already-approved frontend/CORS
// configuration, so CSP and WebSocket checks share the same explicit policy.
function previewParentOrigins(env = process.env) {
  const configured = PREVIEW_PARENT_ORIGIN_KEYS.flatMap((key) => configuredOrigins(env[key]));
  return [...new Set(configured)];
}

function previewAllowedOrigins(env = process.env) {
  const child = siblingPreviewOrigin(env);
  const parents = previewParentOrigins(env);
  const devFallback = parents.length || isProduction(env) ? [] : DEV_PARENT_ORIGINS;
  return new Set([...parents, ...devFallback, ...(child ? [child] : [])]);
}

function previewOriginAllowed(origin, env = process.env) {
  const normalized = normalizeOrigin(origin);
  return Boolean(normalized && previewAllowedOrigins(env).has(normalized));
}

function previewFrameAncestors(env = process.env) {
  const parents = previewParentOrigins(env);
  return parents.length ? `'self' ${parents.join(' ')}` : "'self'";
}

function applyPreviewFrameHeaders(res, env = process.env) {
  if (previewParentOrigins(env).length) res.removeHeader('X-Frame-Options');
  else res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', `frame-ancestors ${previewFrameAncestors(env)}`);
}

function previewNonceFromRequest(request) {
  try {
    const url = new URL(String(request?.url || '/'), 'http://preview.local');
    const nonce = url.searchParams.get(PREVIEW_NONCE_PARAM) || '';
    return /^[A-Za-z0-9_-]{16,128}$/.test(nonce) ? nonce : '';
  } catch {
    return '';
  }
}

function applyPreviewCorsHeaders(headers, origin, env = process.env) {
  const value = String(origin || '').trim();
  if (!value) return headers;
  if (value === 'null') {
    headers['access-control-allow-origin'] = '*';
    return headers;
  }
  const normalized = normalizeOrigin(value);
  if (!normalized || !previewAllowedOrigins(env).has(normalized)) return headers;
  headers['access-control-allow-origin'] = normalized;
  headers.vary = headers.vary ? `${headers.vary}, Origin` : 'Origin';
  return headers;
}

function readPreviewBody(stream, maxBytes = MAX_PREVIEW_HTML_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    stream.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        const error = new Error('preview_html_too_large');
        error.code = 'preview_html_too_large';
        try { stream.destroy(); } catch (_) {}
        fail(error);
        return;
      }
      chunks.push(buffer);
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total));
    });
    stream.on('error', fail);
  });
}

function stripPreviewNonce(rawUrl) {
  try {
    const url = new URL(String(rawUrl || '/'), 'http://preview.local');
    url.searchParams.delete(PREVIEW_NONCE_PARAM);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return rawUrl || '/';
  }
}

function buildPreviewConsoleBridge(nonce) {
  const safeNonce = JSON.stringify(String(nonce || ''));
  return `<script data-sgpt-preview-bridge="true">
(function(){
  var nonce=${safeNonce};
  window.__sgptPreviewNonce=nonce;
  function ser(value){try{if(value instanceof Error)return value.stack||value.message;return typeof value==='object'?JSON.stringify(value):String(value)}catch(e){return String(value)}}
  function send(level,args){try{parent.postMessage({type:'sgpt-preview-console',level:level,nonce:nonce,text:Array.prototype.map.call(args,ser).join(' ')},'*')}catch(e){}}
  ['log','info','warn','error','debug'].forEach(function(k){var o=console[k]?console[k].bind(console):function(){};console[k]=function(){send(k,arguments);o.apply(null,arguments)}});
  window.addEventListener('error',function(e){send('error',[(e.message||'Error')+' ('+(e.filename||'preview').split('/').pop()+':'+e.lineno+')'])});
  window.addEventListener('unhandledrejection',function(e){send('error',['Unhandled rejection: '+ser(e.reason)])});
})();
</script>`;
}

// One selector implementation serves both the host code-runner proxy and the
// durable Codex preview proxy. Keeping the bridge here prevents the two live
// preview paths from drifting: both must emit the same nonce-bound DOM detail
// consumed by PreviewPane.
const PREVIEW_SELECTOR_BRIDGE = `<script data-sgpt-preview-selector-bridge="true">
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
  function send(type, extra){try{var payload=extra||{};payload.type=type;payload.nonce=window.__sgptPreviewNonce||'';parent.postMessage(payload,'*')}catch(e){}}
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
    if (msg.nonce !== (window.__sgptPreviewNonce || '')) return;
    if (msg.type === 'sgpt-preview-select-start') start();
    if (msg.type === 'sgpt-preview-select-cancel') cleanup('Selección cancelada.');
  });
})();
</script>`;

function buildPreviewSelectorBridge() {
  return PREVIEW_SELECTOR_BRIDGE;
}

function injectPreviewBridges(html, bridges) {
  if (!bridges) return html;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${bridges}</head>`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, (match) => `${match}${bridges}`);
  return `${bridges}${html}`;
}

function injectPreviewConsoleBridge(html, nonce) {
  if (!html || !nonce || html.includes('data-sgpt-preview-bridge')) return html;
  return injectPreviewBridges(html, buildPreviewConsoleBridge(nonce));
}

function injectPreviewInteractionBridges(html, nonce) {
  if (!html || !nonce) return html;
  const bridges = [
    html.includes('data-sgpt-preview-bridge') ? '' : buildPreviewConsoleBridge(nonce),
    html.includes('__sgptPreviewSelectorBridge') ? '' : buildPreviewSelectorBridge(),
  ].join('');
  return injectPreviewBridges(html, bridges);
}

function filterPreviewResponseHeaders(headers, env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (lower === 'set-cookie' || lower === 'content-security-policy' || lower === 'x-frame-options') continue;
    if (lower === 'connection' || lower === 'keep-alive' || lower === 'proxy-authenticate' || lower === 'proxy-authorization' || lower === 'te' || lower === 'trailer' || lower === 'transfer-encoding' || lower === 'upgrade') continue;
    if (lower.startsWith('access-control-')) continue;
    out[key] = value;
  }
  out['cache-control'] = 'no-store';
  if (!previewParentOrigins(env).length) out['x-frame-options'] = 'SAMEORIGIN';
  out['content-security-policy'] = `frame-ancestors ${previewFrameAncestors(env)}`;
  out['referrer-policy'] = 'no-referrer';
  return out;
}

function attachCodeRunnerPreviewWebSocketProxy(server, { resolveTarget, WebSocketClient = WebSocket, WebSocketServer = WebSocket.Server } = {}) {
  if (!server || typeof server.on !== 'function') throw new TypeError('server is required');
  if (typeof resolveTarget !== 'function') throw new TypeError('resolveTarget is required');
  const downstreamServer = new WebSocketServer({ noServer: true });
  const onUpgrade = (request, socket, head) => {
    const path = String(request?.url || '').split('?')[0];
    if (!/^\/api\/code-runner\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+\/app(?:\/|$)/.test(path)) return;
    socket.on('error', () => {});
    if (!previewOriginAllowed(request.headers?.origin)) return rejectUpgrade(socket, 403);
    Promise.resolve(resolveTarget(request))
      .then((target) => {
        if (!target?.url || socket.destroyed) return rejectUpgrade(socket, target?.statusCode || 403);
        downstreamServer.handleUpgrade(request, socket, head, (downstream) => {
          const protocols = parseProtocols(request.headers?.['sec-websocket-protocol']);
          const options = { handshakeTimeout: 10_000, perMessageDeflate: false, headers: target.host ? { Host: target.host } : undefined };
          const upstream = protocols.length ? new WebSocketClient(target.url, protocols, options) : new WebSocketClient(target.url, options);
          bridgeWebSockets(downstream, upstream);
        });
      })
      .catch((error) => rejectUpgrade(socket, error?.statusCode || 403));
  };
  server.on('upgrade', onUpgrade);
  const binding = { close() { server.off('upgrade', onUpgrade); try { downstreamServer.close(); } catch (_) {} } };
  server.once('close', binding.close);
  return binding;
}

module.exports = {
  DEFAULT_PREVIEW_TOKEN_TTL_MS,
  MAX_PREVIEW_TOKEN_TTL_MS,
  MAX_PREVIEW_HTML_BYTES,
  MIN_PREVIEW_TOKEN_SECRET_BYTES,
  PREVIEW_NONCE_PARAM,
  applyPreviewFrameHeaders,
  applyPreviewCorsHeaders,
  attachCodeRunnerPreviewWebSocketProxy,
  buildPreviewConsoleBridge,
  buildPreviewSelectorBridge,
  filterPreviewResponseHeaders,
  injectPreviewConsoleBridge,
  injectPreviewInteractionBridges,
  previewFrameAncestors,
  previewOriginAllowed,
  previewParentOrigins,
  previewNonceFromRequest,
  previewTokenFor,
  previewTokenSecret,
  previewTokenTtlMs,
  redactPreviewUrl,
  readPreviewBody,
  siblingPreviewOrigin,
  signPreviewToken,
  stripPreviewNonce,
  verifyPreviewToken,
};

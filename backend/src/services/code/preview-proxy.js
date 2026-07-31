'use strict';

const crypto = require('node:crypto');
const WebSocket = require('ws');
const {
  bridgeWebSockets,
  parseProtocols,
  rejectUpgrade,
} = require('../codex/preview-websocket-proxy');
const { redactPreviewUrl } = require('../../utils/preview-url-redaction');

const DEFAULT_PREVIEW_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_PREVIEW_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const PREVIEW_NONCE_PARAM = '__sgpt_preview_nonce';
const PREVIEW_TOKEN_SECRET_KEYS = ['CODE_RUNNER_PREVIEW_TOKEN_SECRET', 'CODEX_PREVIEW_TOKEN_SECRET'];

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
    if (value) return value;
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
    const iat = claims.iat == null ? null : Number(claims.iat);
    if (iat != null && (!Number.isFinite(iat) || iat > Date.now() + 30_000 || exp <= iat)) return null;
    if (exp - Date.now() > previewTokenTtlMs(env) + 30_000) return null;
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

function previewFrameAncestors(env = process.env) {
  const sibling = siblingPreviewOrigin(env);
  return sibling ? `'self' ${sibling}` : "'self'";
}

function applyPreviewFrameHeaders(res, env = process.env) {
  const sibling = siblingPreviewOrigin(env);
  if (sibling) res.removeHeader('X-Frame-Options');
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

function injectPreviewConsoleBridge(html, nonce) {
  if (!html || !nonce || html.includes('data-sgpt-preview-bridge')) return html;
  const bridge = buildPreviewConsoleBridge(nonce);
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${bridge}</head>`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, (match) => `${match}${bridge}`);
  return `${bridge}${html}`;
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
  const sibling = siblingPreviewOrigin(env);
  if (!sibling) out['x-frame-options'] = 'SAMEORIGIN';
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
  PREVIEW_NONCE_PARAM,
  applyPreviewFrameHeaders,
  attachCodeRunnerPreviewWebSocketProxy,
  buildPreviewConsoleBridge,
  filterPreviewResponseHeaders,
  injectPreviewConsoleBridge,
  previewFrameAncestors,
  previewNonceFromRequest,
  previewTokenFor,
  previewTokenSecret,
  previewTokenTtlMs,
  redactPreviewUrl,
  siblingPreviewOrigin,
  signPreviewToken,
  stripPreviewNonce,
  verifyPreviewToken,
};

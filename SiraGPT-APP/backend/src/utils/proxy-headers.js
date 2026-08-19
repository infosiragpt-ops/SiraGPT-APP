'use strict';

// Shared header policy for the same-origin preview reverse-proxies (host runner
// and GitHub workspace runner). Both forward to an UNTRUSTED dev server running
// user-controlled code on a private 127.0.0.1 port, so SiraGPT credentials must
// never be forwarded to it and it must never set cookies on the SiraGPT origin.

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const STRIP_REQUEST_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization']);

// Header set forwarded to the upstream dev server: drop SiraGPT credentials and
// hop-by-hop headers, drop the caller's host/content-length, and rewrite host to
// the private dev-server target.
function buildUpstreamRequestHeaders(reqHeaders, targetPort) {
  const headers = {};
  for (const [key, value] of Object.entries(reqHeaders || {})) {
    const lower = key.toLowerCase();
    if (STRIP_REQUEST_HEADERS.has(lower) || HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === 'host' || lower === 'content-length') continue;
    headers[key] = value;
  }
  headers.host = `127.0.0.1:${targetPort}`;
  return headers;
}

// Whether an upstream response header may be relayed back to the browser. Drops
// hop-by-hop headers, Set-Cookie (an untrusted origin must not set SiraGPT
// cookies), and CSP (the proxy re-asserts frame-ancestors for the iframe).
function isForwardableResponseHeader(lowerKey) {
  if (HOP_BY_HOP_HEADERS.has(lowerKey)) return false;
  if (lowerKey === 'set-cookie') return false;
  if (lowerKey === 'content-security-policy') return false;
  return true;
}

module.exports = {
  HOP_BY_HOP_HEADERS,
  STRIP_REQUEST_HEADERS,
  buildUpstreamRequestHeaders,
  isForwardableResponseHeader,
};

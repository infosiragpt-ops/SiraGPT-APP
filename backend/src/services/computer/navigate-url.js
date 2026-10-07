'use strict';

/**
 * Shared http(s) URL gate for the integrated navigator.
 * Host-only input ("scopus.com") is upgraded to https://.
 * Plain words ("google", "clima en lima") are not a host the browser can
 * resolve: they become a web search, like any address bar.
 * javascript:/data:/file: and non-http schemes are refused.
 *
 * `classifyNavigationFailure` turns the browser's navigation error into a
 * stable code + Spanish message so the route answers 4xx when the address
 * itself was the problem and keeps 5xx for a site that is down.
 */

const BLOCKED_SCHEME = /^(javascript|data|file|vbscript|blob|about|mailto|ftp|chrome|chrome-extension):/i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
// "localhost:3000", "intranet:8080/app": a host with a port, not a scheme.
const HOST_PORT_RE = /^[a-z0-9.-]+:\d{1,5}(?=[/?#]|$)/i;
const DEFAULT_SEARCH_URL = 'https://www.google.com/search?q=';
const SINGLE_LABEL_RE = /^[a-z0-9_-]+$/i;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const MAX_SEARCH_QUERY_CHARS = 180;

function invalidUrl() {
  const err = new Error('La URL debe ser http(s).');
  err.status = 400;
  err.code = 'invalid_url';
  err.publicMessage = 'La URL debe ser http(s).';
  return err;
}

function searchBaseUrl(env = process.env) {
  const raw = String((env && env.SIRAGPT_COMPUTER_SEARCH_URL) || '').trim();
  if (!raw) return DEFAULT_SEARCH_URL;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return DEFAULT_SEARCH_URL;
    return raw;
  } catch (_) {
    return DEFAULT_SEARCH_URL;
  }
}

/**
 * Text the user typed that no DNS could resolve: a single dotless label
 * ("google", "wikipedia") or words with spaces ("clima en lima"). An
 * explicit scheme, a dotted host, `localhost`, an IP literal or a port all
 * mean "this is an address" and are left alone.
 */
function hasScheme(value) {
  return SCHEME_RE.test(value) && !HOST_PORT_RE.test(value);
}

function looksLikeSearchQuery(value) {
  const text = String(value || '').trim();
  if (!text || hasScheme(text)) return false;
  const authority = text.split(/[/?#]/)[0];
  if (!authority) return false;
  if (/\s/.test(authority)) return true;
  if (!SINGLE_LABEL_RE.test(authority)) return false;
  if (authority.toLowerCase() === 'localhost') return false;
  if (IPV4_RE.test(authority)) return false;
  return true;
}

function searchUrlFor(query, env = process.env) {
  const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, MAX_SEARCH_QUERY_CHARS);
  return `${searchBaseUrl(env)}${encodeURIComponent(q)}`;
}

function sanitizeNavigateUrl(raw, env = process.env) {
  let value = String(raw || '').trim();
  if (!value) throw invalidUrl();
  if (BLOCKED_SCHEME.test(value)) throw invalidUrl();
  if (looksLikeSearchQuery(value)) return searchUrlFor(value, env);
  if (!hasScheme(value)) value = `https://${value}`;
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    throw invalidUrl();
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw invalidUrl();
  if (!parsed.hostname) throw invalidUrl();
  return parsed.toString();
}

function hostOf(url) {
  try {
    return String(new URL(String(url || '')).hostname || '').slice(0, 80);
  } catch (_) {
    return '';
  }
}

// Chromium `net::` error → stable code. Address problems are the caller's
// (4xx); a site that refuses, resets or times out is upstream (5xx).
const NAVIGATION_FAILURES = [
  {
    code: 'navigate_host_unresolved',
    status: 422,
    test: /ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ERR_DNS_/i,
    message: (host) => (host
      ? `No se encontró el sitio «${host}». Revisa la dirección (por ejemplo, «${host}.com») o escribe lo que quieres buscar.`
      : 'No se encontró el sitio. Revisa la dirección o escribe lo que quieres buscar.'),
  },
  {
    code: 'navigate_url_invalid',
    status: 422,
    test: /ERR_INVALID_URL|ERR_UNKNOWN_URL_SCHEME|ERR_INVALID_REDIRECT|ERR_ADDRESS_INVALID|ERR_DISALLOWED_URL_SCHEME/i,
    message: () => 'La dirección no es válida. Revisa la URL e inténtalo de nuevo.',
  },
  {
    code: 'navigate_tls_failed',
    status: 502,
    test: /ERR_CERT_|ERR_SSL_|ERR_BAD_SSL/i,
    message: (host) => (host
      ? `«${host}» tiene un certificado de seguridad inválido; no se abrió la página.`
      : 'El sitio tiene un certificado de seguridad inválido; no se abrió la página.'),
  },
  {
    code: 'navigate_site_unreachable',
    status: 502,
    test: /ERR_CONNECTION_(REFUSED|RESET|CLOSED|FAILED|ABORTED|TIMED_OUT)|ERR_ADDRESS_UNREACHABLE|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_SOCKET_NOT_CONNECTED|ERR_EMPTY_RESPONSE|ERR_HTTP2_PROTOCOL_ERROR|ERR_TOO_MANY_REDIRECTS/i,
    message: (host) => (host
      ? `No se pudo conectar con «${host}». El sitio no responde o rechazó la conexión.`
      : 'No se pudo conectar con el sitio. No responde o rechazó la conexión.'),
  },
  {
    code: 'navigate_timeout',
    status: 504,
    test: /Timeout \d+ms exceeded|ERR_TIMED_OUT|TimeoutError/i,
    message: (host) => (host
      ? `«${host}» tardó demasiado en responder. Inténtalo de nuevo.`
      : 'La página tardó demasiado en responder. Inténtalo de nuevo.'),
  },
];

/**
 * @param {unknown} cause error thrown by the browser driver (Playwright)
 * @param {string} url the sanitized destination
 * @returns {{ code: string, status: number, message: string } | null}
 */
function classifyNavigationFailure(cause, url) {
  const text = String((cause && (cause.message || cause.code)) || cause || '').replace(/\s+/g, ' ');
  if (!text) return null;
  const host = hostOf(url);
  for (const entry of NAVIGATION_FAILURES) {
    if (entry.test.test(text)) return { code: entry.code, status: entry.status, message: entry.message(host) };
  }
  return null;
}

module.exports = {
  BLOCKED_SCHEME,
  DEFAULT_SEARCH_URL,
  MAX_SEARCH_QUERY_CHARS,
  classifyNavigationFailure,
  looksLikeSearchQuery,
  sanitizeNavigateUrl,
  searchUrlFor,
};

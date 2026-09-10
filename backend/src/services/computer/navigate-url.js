'use strict';

/**
 * Shared http(s) URL gate for the integrated navigator.
 * Host-only input ("scopus.com") is upgraded to https://.
 * javascript:/data:/file: and non-http schemes are refused.
 */

const BLOCKED_SCHEME = /^(javascript|data|file|vbscript|blob|about|mailto|ftp|chrome|chrome-extension):/i;

function invalidUrl() {
  const err = new Error('La URL debe ser http(s).');
  err.status = 400;
  err.code = 'invalid_url';
  err.publicMessage = 'La URL debe ser http(s).';
  return err;
}

function sanitizeNavigateUrl(raw) {
  let value = String(raw || '').trim();
  if (!value) throw invalidUrl();
  if (BLOCKED_SCHEME.test(value)) throw invalidUrl();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = `https://${value}`;
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

module.exports = {
  BLOCKED_SCHEME,
  sanitizeNavigateUrl,
};

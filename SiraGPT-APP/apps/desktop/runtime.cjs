'use strict';

const DEFAULT_APP_URL = 'https://siragpt.com/chat';
const APP_HOSTS = new Set(['siragpt.com', 'www.siragpt.com', 'api.siragpt.com']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const OAUTH_HOSTS = new Set(['accounts.google.com']);
const EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:', 'tel:']);
const DEEP_LINK_PATH_PREFIXES = [
  '/chat',
  '/apps',
  '/code',
  '/descargas',
  '/g/',
  '/gpts',
  '/library',
  '/profile',
  '/projects',
  '/settings',
  '/auth/callback',
];

function parseUrl(value) {
  try {
    return new URL(String(value || ''));
  } catch {
    return null;
  }
}

function isTrustedAppUrl(value, options = {}) {
  const url = parseUrl(value);
  if (!url || !['http:', 'https:'].includes(url.protocol)) return false;
  if (APP_HOSTS.has(url.hostname)) return url.protocol === 'https:';
  return Boolean(options.allowLocalhost) && LOCAL_HOSTS.has(url.hostname);
}

function isTrustedOAuthUrl(value) {
  const url = parseUrl(value);
  return Boolean(url && url.protocol === 'https:' && OAUTH_HOSTS.has(url.hostname));
}

function normaliseAppUrl(value, options = {}) {
  const candidate = String(value || '').trim() || DEFAULT_APP_URL;
  return isTrustedAppUrl(candidate, options) ? new URL(candidate).toString() : DEFAULT_APP_URL;
}

function navigationDisposition(value, options = {}) {
  if (isTrustedAppUrl(value, options)) return 'app';
  if (isTrustedOAuthUrl(value)) return 'oauth';
  const url = parseUrl(value);
  if (url && EXTERNAL_PROTOCOLS.has(url.protocol)) return 'external';
  return 'blocked';
}

function deepLinkToAppUrl(value) {
  const rawValue = String(value || '');
  if (/%2e|%5c/i.test(rawValue)) return null;
  const url = parseUrl(rawValue);
  if (!url || url.protocol !== 'siragpt:') return null;

  const host = url.hostname.toLowerCase();
  const pathname = `/${host}${url.pathname}`.replace(/\/+/g, '/');
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (decodedPath.includes('..') || decodedPath.includes('\\') || decodedPath.length > 1024) {
    return null;
  }
  if (!DEEP_LINK_PATH_PREFIXES.some((prefix) => decodedPath === prefix || decodedPath.startsWith(prefix))) {
    return null;
  }

  const target = new URL(DEFAULT_APP_URL);
  target.pathname = decodedPath;
  target.search = url.search;
  target.hash = url.hash;
  return target.toString();
}

function compareVersions(left, right) {
  const parse = (value) => String(value || '')
    .replace(/^v/i, '')
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function releasePlatform(platform, arch) {
  if (platform === 'darwin') return arch === 'x64' ? 'macos-x64' : 'macos-arm64';
  if (platform === 'win32') return 'windows-x64';
  return null;
}

module.exports = {
  APP_HOSTS,
  DEFAULT_APP_URL,
  compareVersions,
  deepLinkToAppUrl,
  isTrustedAppUrl,
  isTrustedOAuthUrl,
  navigationDisposition,
  normaliseAppUrl,
  releasePlatform,
};

'use strict';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

const CALLBACK_PATHS = Object.freeze({
  google: '/api/auth/google/callback',
  gmail: '/api/auth/gmail/callback',
  googleServices: '/api/auth/google-services/callback',
});

const stripTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');

function parseUrl(value) {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isProduction(env = process.env) {
  return env.NODE_ENV === 'production';
}

function isLocalhostUrl(value) {
  const parsed = parseUrl(value);
  if (parsed) return LOCAL_HOSTNAMES.has(parsed.hostname);
  return /(^|\/\/)(localhost|127\.0\.0\.1|\[?::1\]?)(:|\/|$)/i.test(String(value || ''));
}

function normalizeHostname(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '');
}

function frontendHostname(env = process.env) {
  const parsed = parseUrl(env.FRONTEND_URL || env.PUBLIC_FRONTEND_URL || env.NEXT_PUBLIC_URL || '');
  return parsed ? normalizeHostname(parsed.hostname) : '';
}

function normalizePublicBackendBaseUrl(value) {
  const normalized = stripTrailingSlash(value);
  if (!normalized) return '';

  const parsed = parseUrl(normalized);
  if (!parsed) return normalized.replace(/\/api$/i, '');

  if (/\/api\/?$/i.test(parsed.pathname)) {
    parsed.pathname = parsed.pathname.replace(/\/api\/?$/i, '') || '/';
  }
  parsed.search = '';
  parsed.hash = '';
  return stripTrailingSlash(parsed.toString());
}

function inferBackendUrlFromFrontend(env = process.env) {
  const host = frontendHostname(env);
  if (host === 'siragpt.com') return 'https://api.siragpt.com';
  return '';
}

function isFrontendHostCallback(urlValue, env = process.env) {
  const parsed = parseUrl(urlValue);
  const frontHost = frontendHostname(env);
  if (!parsed || !frontHost) return false;
  return normalizeHostname(parsed.hostname) === frontHost;
}

function isAllowedFrontendCallback(env = process.env) {
  return String(env.GOOGLE_ALLOW_FRONTEND_CALLBACK || '').toLowerCase() === 'true';
}

function hasDifferentBackendHost(urlValue, backendBaseUrl) {
  const callback = parseUrl(urlValue);
  const backend = parseUrl(backendBaseUrl);
  if (!callback || !backend) return false;
  return normalizeHostname(callback.hostname) !== normalizeHostname(backend.hostname);
}

function isUsablePublicUrl(value, env = process.env, backendBaseUrl = '') {
  const parsed = parseUrl(value);
  if (!parsed || !/^https?:$/.test(parsed.protocol)) return false;
  if (isProduction(env) && isLocalhostUrl(value)) return false;
  if (
    isProduction(env) &&
    !isAllowedFrontendCallback(env) &&
    backendBaseUrl &&
    isFrontendHostCallback(value, env) &&
    hasDifferentBackendHost(value, backendBaseUrl)
  ) {
    return false;
  }
  return true;
}

function resolvePublicBackendUrl(env = process.env) {
  const inferred = inferBackendUrlFromFrontend(env);
  const frontHost = frontendHostname(env);
  const inferredHost = parseUrl(inferred)?.hostname || '';

  const candidates = [
    env.GOOGLE_AUTH_BASE_URL,
    env.BACKEND_PUBLIC_URL,
    env.API_PUBLIC_URL,
    env.PUBLIC_API_URL,
    env.NEXT_PUBLIC_API_URL,
    env.BASE_URL,
    env.APP_URL,
  ];

  for (const candidate of candidates) {
    const normalized = normalizePublicBackendBaseUrl(candidate);
    if (!normalized) continue;
    if (isProduction(env) && isLocalhostUrl(normalized)) continue;

    const candidateHost = parseUrl(normalized)?.hostname || '';
    if (
      isProduction(env) &&
      inferred &&
      frontHost &&
      inferredHost &&
      !isAllowedFrontendCallback(env) &&
      normalizeHostname(candidateHost) === frontHost &&
      normalizeHostname(candidateHost) !== normalizeHostname(inferredHost)
    ) {
      continue;
    }

    return normalized;
  }

  if (inferred) return inferred;
  return isProduction(env) ? 'https://api.siragpt.com' : 'http://localhost:5000';
}

function buildCallbackUrl(env, explicitEnvKey, callbackPath) {
  const backendBaseUrl = resolvePublicBackendUrl(env);
  const configured = stripTrailingSlash(env[explicitEnvKey]);
  if (configured && isUsablePublicUrl(configured, env, backendBaseUrl)) {
    return configured;
  }
  return `${backendBaseUrl}${callbackPath}`;
}

function getGoogleCallbackURL(env = process.env) {
  return buildCallbackUrl(env, 'GOOGLE_AUTH_URI', CALLBACK_PATHS.google);
}

function getGoogleGmailCallbackURL(env = process.env) {
  return buildCallbackUrl(env, 'GOOGLE_REDIRECT_URI', CALLBACK_PATHS.gmail);
}

function getGoogleServicesCallbackURL(env = process.env) {
  return buildCallbackUrl(env, 'GOOGLE_REDIRECT_CALENDAR_DRIVE_URI', CALLBACK_PATHS.googleServices);
}

function getFrontendUrl(env = process.env) {
  return stripTrailingSlash(env.FRONTEND_URL || env.PUBLIC_FRONTEND_URL || env.NEXT_PUBLIC_URL || 'http://localhost:3000');
}

module.exports = {
  CALLBACK_PATHS,
  stripTrailingSlash,
  isLocalhostUrl,
  normalizePublicBackendBaseUrl,
  resolvePublicBackendUrl,
  getGoogleCallbackURL,
  getGoogleGmailCallbackURL,
  getGoogleServicesCallbackURL,
  getFrontendUrl,
};

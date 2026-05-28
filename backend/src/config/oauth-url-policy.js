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
  // Single-container deployment: the Express backend lives on the same
  // public origin as Next.js and is reached via the /api/* rewrite — there
  // is no separate api.* subdomain. Always anchor OAuth callbacks to the
  // frontend origin so Google's redirect_uri matches a URL that actually
  // resolves to our app.
  const parsed = parseUrl(
    env.FRONTEND_URL || env.PUBLIC_FRONTEND_URL || env.NEXT_PUBLIC_URL || ''
  );
  if (!parsed) return '';
  return `${parsed.protocol}//${parsed.host}`;
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
  // Inside a Replit container, localhost is not reachable from the user's
  // browser (which lives on the *.replit.dev preview domain), so a
  // localhost callback registered in .env.local would break the OAuth
  // round trip. Reject it so we fall back to the Replit dev domain.
  if (env.REPLIT_DEV_DOMAIN && isLocalhostUrl(value)) return false;
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
    // Inside a Replit container, localhost is unreachable from the user's
    // browser. Skip localhost candidates whenever a Replit dev domain is
    // available so OAuth callbacks land on a host the browser can reach.
    if (env.REPLIT_DEV_DOMAIN && isLocalhostUrl(normalized)) continue;

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

  // In dev, prefer the Replit preview domain over a localhost or
  // siragpt.com fallback so OAuth round trips actually land back on the
  // browser's origin. The dev domain proxies /api/* to the backend on
  // port 5050 the same way the published siragpt.com host does.
  if (!isProduction(env) && env.REPLIT_DEV_DOMAIN) {
    return `https://${env.REPLIT_DEV_DOMAIN}`;
  }
  if (inferred) return inferred;
  // Last-resort fallback for environments that haven't set FRONTEND_URL.
  // In production we still default to the public siragpt.com origin (single
  // container), not a non-existent api.* subdomain.
  return isProduction(env) ? 'https://siragpt.com' : 'http://localhost:5000';
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

'use strict';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
const MAX_OAUTH_POST_CALLBACK_ALLOWED_ORIGINS = 10;
const MAX_OAUTH_POST_CALLBACK_ALLOWED_ORIGINS_CHARS = 2048;
const FRONTEND_ORIGIN_ENV_KEYS = Object.freeze([
  'FRONTEND_URL',
  'PUBLIC_FRONTEND_URL',
  'NEXT_PUBLIC_URL',
]);

const CALLBACK_PATHS = Object.freeze({
  google: '/api/auth/google/callback',
  gmail: '/api/auth/gmail/callback',
  googleServices: '/api/auth/google-services/callback',
  github: '/api/github/callback',
  spotify: '/api/spotify/callback',
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
  const parsed = parseUrl(
    env.FRONTEND_URL || env.PUBLIC_FRONTEND_URL || env.NEXT_PUBLIC_URL || ''
  );
  if (!parsed) return '';
  if (isProduction(env)) {
    const host = normalizeHostname(parsed.hostname);
    if (host && !host.startsWith('api.')) {
      const port = parsed.port ? `:${parsed.port}` : '';
      return `${parsed.protocol}//api.${host}${port}`;
    }
  }
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
  if (isProduction(env) && parsed.protocol !== 'https:') return false;
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
  // GOOGLE_AUTH_BASE_URL is the single authoritative override. When set it
  // short-circuits all candidate heuristics — including the frontend-host
  // rejection below — so a single-domain config (API and frontend on the
  // same host, e.g. siragpt.com) is honoured without being silently
  // discarded in favour of an inferred api.* subdomain.
  if (env.GOOGLE_AUTH_BASE_URL) {
    const normalized = normalizePublicBackendBaseUrl(env.GOOGLE_AUTH_BASE_URL);
    const isLocalhost = isLocalhostUrl(normalized);
    const parsed = parseUrl(normalized);
    if (
      normalized
      && !(isProduction(env) && isLocalhost)
      && !(isProduction(env) && parsed?.protocol !== 'https:')
      && !(env.REPLIT_DEV_DOMAIN && isLocalhost)
    ) {
      return normalized;
    }
  }

  const inferred = inferBackendUrlFromFrontend(env);
  const frontHost = frontendHostname(env);
  const inferredHost = parseUrl(inferred)?.hostname || '';

  const candidates = [
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
    if (isProduction(env) && parseUrl(normalized)?.protocol !== 'https:') continue;
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
  if (
    inferred
    && (!isProduction(env) || (
      parseUrl(inferred)?.protocol === 'https:'
      && !isLocalhostUrl(inferred)
    ))
  ) {
    return inferred;
  }
  // Last-resort fallback for environments that haven't set FRONTEND_URL.
  // In production we still default to the public siragpt.com origin (single
  // container), not a non-existent api.* subdomain.
  return isProduction(env) ? 'https://siragpt.com' : 'http://localhost:5000';
}

function buildCallbackUrl(env, explicitEnvKey, callbackPath) {
  const backendBaseUrl = resolvePublicBackendUrl(env);
  const configured = stripTrailingSlash(env[explicitEnvKey]);
  if (configured && isUsablePublicUrl(configured, env, backendBaseUrl)) {
    // Reject any explicit callback URI that points to a different host than
    // the resolved backend origin. This catches stale per-flow URI secrets
    // (e.g. GOOGLE_AUTH_URI still set to api.siragpt.com when the backend
    // now lives on siragpt.com) without requiring GOOGLE_AUTH_BASE_URL to be
    // set. Same-host URIs are accepted as-is so custom callback paths on the
    // correct host still work.
    const configuredHost = normalizeHostname(parseUrl(configured)?.hostname || '');
    const backendHost = normalizeHostname(parseUrl(backendBaseUrl)?.hostname || '');
    if (configuredHost && backendHost && configuredHost !== backendHost) {
      return `${backendBaseUrl}${callbackPath}`;
    }
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

function getGithubCallbackURL(env = process.env) {
  return buildCallbackUrl(env, 'GITHUB_OAUTH_REDIRECT_URI', CALLBACK_PATHS.github);
}

function getSpotifyCallbackURL(env = process.env) {
  return buildCallbackUrl(env, 'SPOTIFY_REDIRECT_URI', CALLBACK_PATHS.spotify);
}

function getFrontendUrl(env = process.env) {
  const candidates = FRONTEND_ORIGIN_ENV_KEYS.map((key) => env[key]);

  for (const candidate of candidates) {
    const normalized = stripTrailingSlash(candidate);
    if (!normalized) continue;
    if (isProduction(env) && isLocalhostUrl(normalized)) continue;
    if (isProduction(env) && parseUrl(normalized)?.protocol !== 'https:') continue;
    return normalized;
  }

  return isProduction(env) ? 'https://siragpt.com' : 'http://localhost:3000';
}

function safeOrigin(value, env = process.env) {
  const parsed = parseUrl(stripTrailingSlash(value));
  if (!parsed || !/^https?:$/.test(parsed.protocol)) return '';
  if (parsed.username || parsed.password) return '';
  if (isProduction(env) && parsed.protocol !== 'https:') return '';
  if (isProduction(env) && isLocalhostUrl(parsed.toString())) return '';
  return parsed.origin;
}

/**
 * Browser destinations after OAuth must stay on a configured frontend origin.
 * A small explicit allowlist supports intentional cross-origin handoffs without
 * turning provider environment variables into arbitrary open redirects.
 */
function getOAuthPostCallbackAllowedOrigins(env = process.env) {
  const origins = new Set();
  for (const key of FRONTEND_ORIGIN_ENV_KEYS) {
    const origin = safeOrigin(env[key], env);
    if (origin) origins.add(origin);
  }

  const fallbackOrigin = safeOrigin(getFrontendUrl(env), env);
  if (fallbackOrigin) origins.add(fallbackOrigin);

  const raw = String(env.OAUTH_POST_CALLBACK_ALLOWED_ORIGINS || '').trim();
  if (!raw || raw.length > MAX_OAUTH_POST_CALLBACK_ALLOWED_ORIGINS_CHARS) {
    return origins;
  }

  const configured = raw.split(/[\s,]+/).filter(Boolean);
  for (const value of configured.slice(0, MAX_OAUTH_POST_CALLBACK_ALLOWED_ORIGINS)) {
    const parsed = parseUrl(value);
    if (!parsed) continue;
    if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) continue;
    const origin = safeOrigin(value, env);
    if (origin) origins.add(origin);
  }
  return origins;
}

function isAllowedOAuthPostCallbackUrl(value, env = process.env) {
  const parsed = parseUrl(value);
  if (!parsed || parsed.username || parsed.password) return false;
  if (!isUsablePublicUrl(value, env)) return false;
  return getOAuthPostCallbackAllowedOrigins(env).has(parsed.origin);
}

function secureFrontendDestination(env, configured, defaultPath) {
  const frontend = getFrontendUrl(env);
  const candidate = stripTrailingSlash(configured);
  if (
    candidate
    && isUsablePublicUrl(candidate, env)
    && (!isProduction(env) || isAllowedOAuthPostCallbackUrl(candidate, env))
  ) {
    return candidate;
  }
  return `${frontend}${defaultPath}`;
}

function withQuery(urlValue, values) {
  const parsed = new URL(urlValue);
  for (const [key, value] of Object.entries(values)) {
    if (value != null && value !== '') parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
}

function safeStatus(value, fallback) {
  const normalized = String(value || fallback).trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,63}$/.test(normalized) ? normalized : fallback;
}

function getGooglePostCallbackURL(status = 'success', env = process.env) {
  const outcome = safeStatus(status, 'auth_failed');
  if (outcome === 'success') {
    return withQuery(`${getFrontendUrl(env)}/auth/callback`, { sso: 'success' });
  }
  return withQuery(`${getFrontendUrl(env)}/auth/login`, { error: outcome });
}

function getGithubPostCallbackURL(status, env = process.env) {
  const base = secureFrontendDestination(
    env,
    env.GITHUB_OAUTH_SUCCESS_REDIRECT,
    '/settings',
  );
  return withQuery(base, { github: safeStatus(status, 'error') });
}

function getSpotifyPostCallbackURL(status, env = process.env) {
  const outcome = safeStatus(status, 'error');
  if (outcome === 'connected') {
    const base = secureFrontendDestination(
      env,
      env.SPOTIFY_OAUTH_SUCCESS_REDIRECT,
      '/chat',
    );
    return withQuery(base, { spotify_connected: 'true' });
  }
  const base = secureFrontendDestination(
    env,
    env.SPOTIFY_OAUTH_FAILURE_REDIRECT,
    '/connections',
  );
  return withQuery(base, {
    spotify_connected: 'false',
    error: outcome,
  });
}

module.exports = {
  CALLBACK_PATHS,
  MAX_OAUTH_POST_CALLBACK_ALLOWED_ORIGINS,
  MAX_OAUTH_POST_CALLBACK_ALLOWED_ORIGINS_CHARS,
  stripTrailingSlash,
  isLocalhostUrl,
  normalizePublicBackendBaseUrl,
  resolvePublicBackendUrl,
  getGoogleCallbackURL,
  getGoogleGmailCallbackURL,
  getGoogleServicesCallbackURL,
  getGithubCallbackURL,
  getSpotifyCallbackURL,
  getGooglePostCallbackURL,
  getGithubPostCallbackURL,
  getSpotifyPostCallbackURL,
  getFrontendUrl,
  getOAuthPostCallbackAllowedOrigins,
  isAllowedOAuthPostCallbackUrl,
};

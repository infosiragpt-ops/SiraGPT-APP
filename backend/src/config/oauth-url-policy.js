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
  // Treat any Replit Autoscale deployment as production so OAuth callbacks
  // resolve to the configured public hostname (iliagpt.com / siragpt.com)
  // instead of the throwaway *.riker.replit.dev container preview URL.
  return env.NODE_ENV === 'production' || env.REPLIT_DEPLOYMENT === '1';
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

function pickReplitPublicDomain(env = process.env) {
  // Replit sets REPLIT_DOMAINS (comma-separated) on deployments to the
  // public hostnames the app is reachable at — including any custom
  // domain like iliagpt.com. Prefer a non-replit.app/non-replit.dev
  // entry (custom domain) when one is present so OAuth callbacks land
  // on the user-facing host instead of the throwaway preview URL.
  const raw = String(env.REPLIT_DOMAINS || '').trim();
  if (!raw) return '';
  const domains = raw.split(',').map((d) => d.trim()).filter(Boolean);
  if (domains.length === 0) return '';
  const isReplitOwned = (host) =>
    /\.replit\.(app|dev)$/i.test(host) || /\.riker\.replit\.dev$/i.test(host);
  const custom = domains.find((d) => !isReplitOwned(d));
  const chosen = custom || domains[0];
  return chosen ? `https://${chosen}` : '';
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
    pickReplitPublicDomain(env),
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
  // Prefer an explicit FRONTEND_URL when set. Otherwise, fall back to the
  // public Replit domain (preferring a custom domain like iliagpt.com over
  // the throwaway *.replit.app preview) so post-login redirects land on
  // the host the user actually visited instead of localhost or a stale
  // hard-coded default.
  const explicit = stripTrailingSlash(
    env.FRONTEND_URL || env.PUBLIC_FRONTEND_URL || env.NEXT_PUBLIC_URL || ''
  );
  if (explicit) return explicit;
  const replitDomain = pickReplitPublicDomain(env);
  if (replitDomain) return stripTrailingSlash(replitDomain);
  return 'http://localhost:3000';
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

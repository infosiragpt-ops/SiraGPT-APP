'use strict';

const { hasBearerAuth } = require('./csrf');
const {
  isExactStripeWebhookRequest,
  requestPath,
} = require('./stripe-webhook-ingress');
const {
  hasSamlAcsBody,
  isExactSamlAcsPath,
} = require('./saml-acs-ingress');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const REQUIRED_COOKIE_AUTH_MOUNTS = Object.freeze([
  '/api/ai',
  '/api/agent',
  '/api/codex',
  '/api/paraphrase',
  '/api/images',
  '/api/free-ia',
]);

const EXPENSIVE_GENERATION_MOUNTS = Object.freeze([
  '/api/ai',
  '/api/agent',
  '/api/codex',
  '/api/paraphrase',
  '/api/images',
  '/api/elevenlabs',
  '/api/video',
  '/api/computer-use',
  '/api/research-agent',
  '/api/scientific-search',
  '/api/answer',
  '/api/builder',
  '/api/github-search',
  '/api/x-search',
  '/api/doc-agent',
  '/api/opencode',
  '/api/search',
  '/api/search-brain',
  '/api/rag',
  '/api/document-ai',
  '/api/sandbox',
  '/api/orchestration',
  '/api/design',
  '/api/plan',
  '/api/compute',
  '/api/math',
  '/api/viz',
  '/api/doc',
  '/api/artifact',
  '/api/enterprise',
  '/api/social-posts',
  '/api/gpts',
  '/api/voice/grok',
]);

const COOKIE_AUTH_CSRF_MOUNTS = Object.freeze(Array.from(new Set([
  ...REQUIRED_COOKIE_AUTH_MOUNTS,
  ...EXPENSIVE_GENERATION_MOUNTS,
])));

// These surfaces are intentionally usable by generated preview applications,
// which do not receive a SiraGPT login session or CSRF token. Match on a path
// boundary so similarly named sibling mounts do not inherit the exemption.
const PUBLIC_GENERATED_APP_MOUNTS = Object.freeze([
  '/api/apps-ai',
  '/api/apps-kv',
]);

function isSafeMethod(req) {
  return SAFE_METHODS.has(String(req?.method || '').toUpperCase());
}

function isWithinMount(pathname, mount) {
  return pathname === mount || pathname.startsWith(`${mount}/`);
}

function isPublicGeneratedAppRequest(req) {
  const pathname = requestPath(req);
  return PUBLIC_GENERATED_APP_MOUNTS.some((mount) => isWithinMount(pathname, mount));
}

/**
 * A SAML HTTP-POST binding is sent by the IdP and cannot carry Sira's CSRF
 * token. Exempt only the real assertion-consumer route and only when the
 * standard SAMLResponse form field is present. OIDC callbacks sharing the
 * route, sibling auth writes, and similarly named paths remain protected.
 * The exemption bypasses only Sira CSRF; the route still runs node-saml's
 * signature and InResponseTo/replay validation before creating a session.
 */
function isExactSamlAssertionConsumerRequest(req) {
  return isExactSamlAcsPath(req) && hasSamlAcsBody(req);
}

function hasCookieSession(req) {
  const token = req?.cookies?.token;
  return typeof token === 'string' && token.trim().length > 0;
}

function hasAuthenticatedApiKey(req) {
  return req?.authMethod === 'api_key' && !!req?.apiKey?.id;
}

function createAuthCsrfMiddleware(requireCsrf) {
  if (typeof requireCsrf !== 'function') {
    throw new TypeError('createAuthCsrfMiddleware requires a CSRF middleware');
  }
  return function authCsrf(req, res, next) {
    if (isExactSamlAssertionConsumerRequest(req)) return next();
    return requireCsrf(req, res, next);
  };
}

/**
 * Catch-all guard for /api. It closes the route-inventory gap: any future
 * state-changing API mount automatically receives CSRF enforcement whenever
 * the browser presents the login cookie. Public/cookieless callers continue
 * to reach public routes, while route-level authentication still rejects them
 * from private routes.
 */
function createCookieAuthCsrfMiddleware(requireCsrf) {
  if (typeof requireCsrf !== 'function') {
    throw new TypeError('createCookieAuthCsrfMiddleware requires a CSRF middleware');
  }

  return function cookieAuthCsrf(req, res, next) {
    if (isSafeMethod(req)) return next();
    if (hasBearerAuth(req) || hasAuthenticatedApiKey(req)) return next();
    if (isExactStripeWebhookRequest(req)) return next();
    if (isExactSamlAssertionConsumerRequest(req)) return next();
    if (isPublicGeneratedAppRequest(req)) return next();
    if (!hasCookieSession(req)) return next();
    return requireCsrf(req, res, next);
  };
}

module.exports = {
  COOKIE_AUTH_CSRF_MOUNTS,
  EXPENSIVE_GENERATION_MOUNTS,
  PUBLIC_GENERATED_APP_MOUNTS,
  REQUIRED_COOKIE_AUTH_MOUNTS,
  createAuthCsrfMiddleware,
  createCookieAuthCsrfMiddleware,
  hasAuthenticatedApiKey,
  hasCookieSession,
  isExactSamlAssertionConsumerRequest,
  isPublicGeneratedAppRequest,
  isSafeMethod,
  isWithinMount,
};

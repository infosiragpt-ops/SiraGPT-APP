'use strict';

/**
 * OIDC authorization-code handler — ratchet 45 (companion to SAML cycle 142).
 *
 * Lazy-requires `openid-client`. When the lib is missing every function
 * returns `{ ok: false, status: 501, error: 'oidc_lib_missing' }` so the
 * SSO callback route can still respond gracefully.
 *
 * `verifyOidcCode(code, ssoConfig, deps?)` exchanges an authorization
 * code (RFC 6749 §4.1, OIDC Core 1.0 §3.1, optionally with PKCE
 * RFC 7636) for an ID token, validates it, and returns a normalised
 * profile so the route layer can mint a Sira session without
 * provider-specific knowledge.
 *
 *   { ok: true, profile, email, nameId, displayName }   — verified
 *   { ok: false, status, error, hint? }                  — rejected
 */

let cachedSdk;
let sdkLoadAttempted = false;

function loadOpenidClient() {
  if (sdkLoadAttempted) return cachedSdk;
  sdkLoadAttempted = true;
  try {
    cachedSdk = require('openid-client');
  } catch (_err) {
    cachedSdk = null;
  }
  return cachedSdk;
}

// Exposed for tests so they can force/clear the missing-lib path.
function __setSdkForTest(sdk) {
  cachedSdk = sdk;
  sdkLoadAttempted = true;
}

function __resetSdkForTest() {
  cachedSdk = undefined;
  sdkLoadAttempted = false;
}

function libMissing() {
  return {
    ok: false,
    status: 501,
    error: 'oidc_lib_missing',
    hint: 'install openid-client to enable OIDC authorization-code verification',
  };
}

function notConfigured(reason) {
  return {
    ok: false,
    status: 400,
    error: 'oidc_not_configured',
    hint: reason || 'org ssoConfig missing required OIDC fields',
  };
}

function isReady(ssoConfig) {
  if (!ssoConfig || typeof ssoConfig !== 'object') {
    return { ok: false, problem: notConfigured('ssoConfig missing') };
  }
  if (ssoConfig.provider !== 'oidc') {
    return { ok: false, problem: notConfigured('provider is not "oidc"') };
  }
  if (!ssoConfig.issuer || typeof ssoConfig.issuer !== 'string') {
    return { ok: false, problem: notConfigured('OIDC issuer missing') };
  }
  if (!ssoConfig.clientId || typeof ssoConfig.clientId !== 'string') {
    return { ok: false, problem: notConfigured('OIDC clientId missing') };
  }
  if (!ssoConfig.callbackUrl || typeof ssoConfig.callbackUrl !== 'string') {
    return { ok: false, problem: notConfigured('OIDC callbackUrl missing') };
  }
  // PKCE (public client) — either clientSecret OR codeVerifier must be present.
  if (!ssoConfig.clientSecret && !ssoConfig.codeVerifier) {
    // Still allow — some flows are public-client + PKCE supplied per-request via deps.
  }
  const sdk = loadOpenidClient();
  if (!sdk) return { ok: false, problem: libMissing() };
  return { ok: true, sdk };
}

async function discoverIssuer(sdk, ssoConfig) {
  // openid-client v5 API: `Issuer.discover(url)` returns an Issuer instance.
  // We also accept ssoConfig.metadata for offline tests.
  if (ssoConfig.metadata && typeof ssoConfig.metadata === 'object') {
    if (sdk.Issuer) return new sdk.Issuer(ssoConfig.metadata);
  }
  const IssuerCls = sdk.Issuer || sdk.default?.Issuer;
  if (!IssuerCls || typeof IssuerCls.discover !== 'function') {
    throw new Error('openid-client.Issuer.discover unavailable');
  }
  return IssuerCls.discover(ssoConfig.issuer);
}

function buildClient(issuer, ssoConfig) {
  // openid-client v5 API: `new issuer.Client({...})`.
  const ClientCls = issuer.Client;
  if (!ClientCls) throw new Error('openid-client Issuer.Client unavailable');
  return new ClientCls({
    client_id: ssoConfig.clientId,
    client_secret: ssoConfig.clientSecret || undefined,
    redirect_uris: [ssoConfig.callbackUrl],
    response_types: ['code'],
    token_endpoint_auth_method: ssoConfig.clientSecret
      ? 'client_secret_post'
      : 'none',
  });
}

function extractEmailFromProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const candidates = [
    profile.email,
    profile.preferred_username,
    profile.upn,
    profile.sub,
  ];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim().toLowerCase();
    if (trimmed.includes('@') && trimmed.length <= 320) return trimmed;
  }
  return null;
}

function extractNameFromProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const candidates = [
    profile.name,
    profile.given_name && profile.family_name
      ? `${profile.given_name} ${profile.family_name}`
      : null,
    profile.given_name,
    profile.nickname,
    profile.preferred_username,
  ];
  for (const raw of candidates) {
    if (typeof raw === 'string' && raw.trim()) return raw.trim().slice(0, 200);
  }
  return null;
}

/**
 * Exchange an OIDC authorization code for a verified profile.
 *
 * @param {string} code           authorization code from `?code=` query param
 * @param {object} ssoConfig      persisted org.ssoConfig (provider === 'oidc')
 * @param {object} [deps]         { loadOidc, discover, codeVerifier, state, nonce } — test/PKCE seam
 * @returns {Promise<{ok:true, profile, email, nameId, displayName}|{ok:false,status:number,error:string,hint?:string}>}
 */
async function verifyOidcCode(code, ssoConfig, deps = {}) {
  const loader = deps.loadOidc || loadOpenidClient;
  // Mirror saml-handler.js: when deps.loadOidc is provided, bypass the
  // cached require check so tests don't need the lib on disk.
  const ready = (() => {
    if (deps.loadOidc) {
      if (!ssoConfig || typeof ssoConfig !== 'object') {
        return { ok: false, problem: notConfigured('ssoConfig missing') };
      }
      if (ssoConfig.provider !== 'oidc') {
        return { ok: false, problem: notConfigured('provider is not "oidc"') };
      }
      if (!ssoConfig.issuer) {
        return { ok: false, problem: notConfigured('OIDC issuer missing') };
      }
      if (!ssoConfig.clientId) {
        return { ok: false, problem: notConfigured('OIDC clientId missing') };
      }
      if (!ssoConfig.callbackUrl) {
        return { ok: false, problem: notConfigured('OIDC callbackUrl missing') };
      }
      const sdk = loader();
      if (!sdk) return { ok: false, problem: libMissing() };
      return { ok: true, sdk };
    }
    return isReady(ssoConfig);
  })();

  if (!ready.ok) return ready.problem;

  if (typeof code !== 'string' || !code.trim()) {
    return {
      ok: false,
      status: 400,
      error: 'oidc_code_missing',
      hint: 'callback must include a non-empty `code` query parameter',
    };
  }

  try {
    const issuer = deps.discover
      ? await deps.discover(ready.sdk, ssoConfig)
      : await discoverIssuer(ready.sdk, ssoConfig);
    const client = buildClient(issuer, ssoConfig);

    // PKCE/state/nonce — accept from deps (per-request) or ssoConfig (static).
    const checks = {};
    const codeVerifier = deps.codeVerifier || ssoConfig.codeVerifier;
    if (codeVerifier) checks.code_verifier = codeVerifier;
    if (deps.state || ssoConfig.expectedState) {
      checks.state = deps.state || ssoConfig.expectedState;
    }
    if (deps.nonce || ssoConfig.expectedNonce) {
      checks.nonce = deps.nonce || ssoConfig.expectedNonce;
    }

    // openid-client v5: `client.callback(redirectUri, params, checks)`.
    const tokenSet = await client.callback(
      ssoConfig.callbackUrl,
      { code, state: deps.state || ssoConfig.expectedState },
      checks,
    );

    let claims = null;
    if (tokenSet && typeof tokenSet.claims === 'function') {
      claims = tokenSet.claims();
    } else if (tokenSet && tokenSet.claims && typeof tokenSet.claims === 'object') {
      claims = tokenSet.claims;
    }
    if (!claims) {
      return {
        ok: false,
        status: 401,
        error: 'oidc_response_invalid',
        hint: 'token set had no claims',
      };
    }

    const email = extractEmailFromProfile(claims);
    if (!email) {
      return {
        ok: false,
        status: 401,
        error: 'oidc_email_missing',
        hint: 'id_token had no email/preferred_username claim',
      };
    }

    return {
      ok: true,
      profile: claims,
      email,
      nameId: typeof claims.sub === 'string' ? claims.sub : null,
      displayName: extractNameFromProfile(claims),
    };
  } catch (err) {
    return {
      ok: false,
      status: 401,
      error: 'oidc_response_invalid',
      hint: err && err.message ? String(err.message).slice(0, 240) : 'verification failed',
    };
  }
}

module.exports = {
  verifyOidcCode,
  extractEmailFromProfile,
  extractNameFromProfile,
  loadOpenidClient,
  __setSdkForTest,
  __resetSdkForTest,
};

'use strict';

const crypto = require('node:crypto');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const {
  DEFAULT_SAML_REQUEST_TTL_MS,
  SAML_REQUEST_STORE_UNAVAILABLE,
  getDefaultSamlRequestStore,
} = require('./saml-request-store');
const {
  createSamlPreAuthNonce,
  hashSamlPreAuthNonce,
} = require('./saml-preauth-cookie');

/**
 * SAML response handler — ratchet 45 (extends cycle 87 SSO scaffold).
 *
 * Lazy-requires `@node-saml/node-saml`. When the lib is missing every
 * function returns `{ ok: false, status: 501, error: 'saml_lib_missing' }`
 * so the SSO callback route can still respond with the placeholder
 * contract from cycle 87. The presence check is lazy + cached so
 * production boot stays fast even if the lib is never installed.
 *
 * `verifySamlResponse(samlResponse, ssoConfig)` parses an incoming
 * SAML response POST (base64 string from the IdP) against the org's
 * stored `ssoConfig`. It returns:
 *
 *   { ok: true, profile, email, nameId }                  — verified
 *   { ok: false, status, error, hint? }                   — rejected
 *
 * The profile is normalised so the route layer can mint a Sira
 * session without provider-specific knowledge.
 */

let cachedSdk;
let sdkLoadAttempted = false;
const MAX_SAML_RESPONSE_BASE64_BYTES = 1024 * 1024;

function loadNodeSaml() {
  if (sdkLoadAttempted) return cachedSdk;
  sdkLoadAttempted = true;
  try {
    cachedSdk = require('@node-saml/node-saml');
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
    error: 'saml_lib_missing',
    hint: 'install @node-saml/node-saml to enable SAML response verification',
  };
}

function notConfigured(reason) {
  return {
    ok: false,
    status: 400,
    error: 'saml_not_configured',
    hint: reason || 'org ssoConfig missing required SAML fields',
  };
}

function isReady(ssoConfig) {
  if (!ssoConfig || typeof ssoConfig !== 'object') {
    return { ok: false, problem: notConfigured('ssoConfig missing') };
  }
  if (ssoConfig.provider !== 'saml') {
    return { ok: false, problem: notConfigured('provider is not "saml"') };
  }
  if (!ssoConfig.cert || typeof ssoConfig.cert !== 'string') {
    return { ok: false, problem: notConfigured('SAML cert missing') };
  }
  if (!ssoConfig.entryPoint || !ssoConfig.issuer || !ssoConfig.callbackUrl) {
    return { ok: false, problem: notConfigured('entryPoint/issuer/callbackUrl missing') };
  }
  const sdk = loadNodeSaml();
  if (!sdk) {
    return { ok: false, problem: libMissing() };
  }
  return { ok: true, sdk };
}

function buildSamlClient(sdk, ssoConfig, {
  cacheProvider,
  generateUniqueId,
  requestIdExpirationPeriodMs = DEFAULT_SAML_REQUEST_TTL_MS,
} = {}) {
  // @node-saml/node-saml exports a `SAML` class. We instantiate per-request
  // with the org's config so we never accidentally cross-pollinate certs.
  const SAML = sdk.SAML || sdk.default?.SAML || sdk;
  const options = {
    entryPoint: ssoConfig.entryPoint,
    issuer: ssoConfig.issuer,
    callbackUrl: ssoConfig.callbackUrl,
    idpCert: ssoConfig.cert,
    cert: ssoConfig.cert, // alias for older lib versions
    audience: ssoConfig.audience || ssoConfig.issuer,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: true,
    validateInResponseTo: 'always',
    requestIdExpirationPeriodMs,
    cacheProvider,
    signatureAlgorithm: 'sha256',
    disableRequestedAuthnContext: true,
  };
  if (typeof generateUniqueId === 'function') options.generateUniqueId = generateUniqueId;
  return new SAML(options);
}

function requestStoreUnavailable() {
  return {
    ok: false,
    status: 503,
    error: 'saml_request_store_unavailable',
    retryAfter: 1,
  };
}

function samlRejection(error, hint) {
  return {
    ok: false,
    status: 401,
    error,
    ...(hint ? { hint } : {}),
  };
}

function inspectSamlResponseEnvelope(samlResponse) {
  if (
    typeof samlResponse !== 'string'
    || !samlResponse.trim()
    || Buffer.byteLength(samlResponse, 'utf8') > MAX_SAML_RESPONSE_BASE64_BYTES
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(samlResponse)
  ) {
    throw new Error('SAML_RESPONSE_ENVELOPE_INVALID');
  }

  const xml = Buffer.from(samlResponse, 'base64').toString('utf8');
  if (!xml || Buffer.byteLength(xml, 'utf8') > MAX_SAML_RESPONSE_BASE64_BYTES) {
    throw new Error('SAML_RESPONSE_ENVELOPE_INVALID');
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new Error('SAML_RESPONSE_ENVELOPE_INVALID');
  }

  let parsed;
  try {
    parsed = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      removeNSPrefix: true,
      processEntities: false,
      parseAttributeValue: false,
      trimValues: true,
    }).parse(xml);
  } catch (_error) {
    throw new Error('SAML_RESPONSE_ENVELOPE_INVALID');
  }
  const response = parsed?.Response;
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('SAML_RESPONSE_ENVELOPE_INVALID');
  }
  return {
    destination: typeof response.Destination === 'string' ? response.Destination : null,
    inResponseTo: typeof response.InResponseTo === 'string' ? response.InResponseTo : null,
  };
}

function randomRequestId(randomBytes = crypto.randomBytes) {
  return `_${Buffer.from(randomBytes(20)).toString('hex')}`;
}

async function initiateSamlLogin(ssoConfig, deps = {}) {
  const loader = deps.loadSaml || loadNodeSaml;
  const ready = (() => {
    if (!ssoConfig || typeof ssoConfig !== 'object' || ssoConfig.provider !== 'saml') {
      return { ok: false, problem: notConfigured('provider is not "saml"') };
    }
    if (!ssoConfig.cert || !ssoConfig.entryPoint || !ssoConfig.issuer || !ssoConfig.callbackUrl) {
      return { ok: false, problem: notConfigured('entryPoint/issuer/callbackUrl/cert missing') };
    }
    const sdk = loader();
    return sdk ? { ok: true, sdk } : { ok: false, problem: libMissing() };
  })();
  if (!ready.ok) return ready.problem;

  const orgSlug = String(deps.orgSlug || '').trim().toLowerCase();
  const requestStore = deps.requestStore || getDefaultSamlRequestStore();
  try {
    await requestStore.ensureAvailable();
    const requestId = randomRequestId(deps.randomBytes || crypto.randomBytes);
    const preAuthNonce = createSamlPreAuthNonce(deps.randomBytes || crypto.randomBytes);
    const relayState = await requestStore.issueRelayState({
      orgSlug,
      requestId,
      preAuthNonceHash: hashSamlPreAuthNonce(preAuthNonce),
    });
    const client = buildSamlClient(ready.sdk, ssoConfig, {
      cacheProvider: requestStore.createCacheProvider(orgSlug),
      generateUniqueId: () => requestId,
      requestIdExpirationPeriodMs: requestStore.status().ttlMs,
    });
    const url = await client.getAuthorizeUrlAsync(relayState, undefined, {});
    return {
      ok: true,
      url,
      requestId,
      preAuthNonce,
      ttlMs: requestStore.status().ttlMs,
    };
  } catch (error) {
    if (error?.code === SAML_REQUEST_STORE_UNAVAILABLE) {
      return requestStoreUnavailable();
    }
    return {
      ok: false,
      status: 500,
      error: 'saml_login_initialization_failed',
    };
  }
}

function extractEmailFromProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  // Prefer explicit email claims; fall back to nameID if it parses as email.
  const candidates = [
    profile.email,
    profile.mail,
    profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'],
    profile.nameID,
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
    profile.displayName,
    profile.cn,
    profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'],
    [profile.firstName || profile.givenName, profile.lastName || profile.surname]
      .filter(Boolean)
      .join(' '),
  ];
  for (const raw of candidates) {
    if (typeof raw === 'string' && raw.trim()) return raw.trim().slice(0, 200);
  }
  return null;
}

/**
 * Verify a SAML response POST body against an org's stored ssoConfig.
 *
 * @param {string} samlResponse  base64-encoded SAMLResponse field
 * @param {object} ssoConfig     persisted org.ssoConfig
 * @param {object} [deps]        { loadSaml } — test seam
 * @returns {Promise<{ok:true, profile, email, nameId}|{ok:false,status:number,error:string,hint?:string}>}
 */
async function verifySamlResponse(samlResponse, ssoConfig, deps = {}) {
  const loader = deps.loadSaml || loadNodeSaml;
  // Allow tests to inject a fake SDK via deps without mutating the cache.
  const ready = (() => {
    if (deps.loadSaml) {
      if (!ssoConfig || typeof ssoConfig !== 'object') {
        return { ok: false, problem: notConfigured('ssoConfig missing') };
      }
      if (ssoConfig.provider !== 'saml') {
        return { ok: false, problem: notConfigured('provider is not "saml"') };
      }
      if (!ssoConfig.cert) {
        return { ok: false, problem: notConfigured('SAML cert missing') };
      }
      if (!ssoConfig.entryPoint || !ssoConfig.issuer || !ssoConfig.callbackUrl) {
        return { ok: false, problem: notConfigured('entryPoint/issuer/callbackUrl missing') };
      }
      const sdk = loader();
      if (!sdk) return { ok: false, problem: libMissing() };
      return { ok: true, sdk };
    }
    return isReady(ssoConfig);
  })();

  if (!ready.ok) return ready.problem;

  if (typeof samlResponse !== 'string' || !samlResponse.trim()) {
    return {
      ok: false,
      status: 400,
      error: 'saml_response_missing',
      hint: 'POST body must include a SAMLResponse field',
    };
  }

  const requestStore = deps.requestStore || getDefaultSamlRequestStore();
  const orgSlug = String(deps.orgSlug || '').trim().toLowerCase();
  let requestId;
  let envelope;
  try {
    await requestStore.ensureAvailable();
    if (typeof deps.relayState !== 'string' || !deps.relayState) {
      return samlRejection('saml_relay_state_invalid');
    }
    let preAuthNonceHash;
    try {
      preAuthNonceHash = hashSamlPreAuthNonce(deps.preAuthNonce);
    } catch (_error) {
      return samlRejection('saml_browser_binding_invalid');
    }
    try {
      ({ requestId } = await requestStore.consumeRelayState({
        relayState: deps.relayState,
        orgSlug,
        preAuthNonceHash,
      }));
    } catch (error) {
      if (error?.code === 'SAML_RELAY_STATE_EXPIRED') {
        return samlRejection('saml_relay_state_expired');
      }
      if (error?.code === 'SAML_BROWSER_BINDING_INVALID') {
        return samlRejection('saml_browser_binding_invalid');
      }
      return samlRejection('saml_relay_state_invalid');
    }

    try {
      envelope = inspectSamlResponseEnvelope(samlResponse);
    } catch (_error) {
      return samlRejection('saml_response_invalid', 'invalid SAML response envelope');
    }
    if (!envelope.inResponseTo || envelope.inResponseTo !== requestId) {
      return samlRejection('saml_in_response_to_invalid');
    }
    if (!envelope.destination || envelope.destination !== ssoConfig.callbackUrl) {
      return samlRejection('saml_destination_invalid');
    }

    const client = buildSamlClient(ready.sdk, ssoConfig, {
      cacheProvider: requestStore.createCacheProvider(orgSlug),
      requestIdExpirationPeriodMs: requestStore.status().ttlMs,
    });
    // node-saml exposes `validatePostResponseAsync({ SAMLResponse })`.
    const result = await client.validatePostResponseAsync({ SAMLResponse: samlResponse });
    const profile = (result && (result.profile || result)) || null;
    if (!profile) {
      return { ok: false, status: 401, error: 'saml_response_invalid', hint: 'no profile returned' };
    }
    const email = extractEmailFromProfile(profile);
    if (!email) {
      return { ok: false, status: 401, error: 'saml_email_missing', hint: 'response had no email claim' };
    }
    return {
      ok: true,
      profile,
      email,
      nameId: typeof profile.nameID === 'string' ? profile.nameID : null,
      displayName: extractNameFromProfile(profile),
    };
  } catch (err) {
    if (err?.code === SAML_REQUEST_STORE_UNAVAILABLE) {
      return requestStoreUnavailable();
    }
    return {
      ok: false,
      status: 401,
      error: 'saml_response_invalid',
      hint: err && err.message ? String(err.message).slice(0, 240) : 'verification failed',
    };
  }
}

module.exports = {
  buildSamlClient,
  initiateSamlLogin,
  inspectSamlResponseEnvelope,
  verifySamlResponse,
  extractEmailFromProfile,
  extractNameFromProfile,
  loadNodeSaml,
  __setSdkForTest,
  __resetSdkForTest,
};

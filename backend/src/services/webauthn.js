'use strict';

/**
 * webauthn (scaffold) — ratchet 45, follow-on to cycle 135 TOTP.
 *
 * Lightweight passkey scaffold layered on top of the existing
 * `services/webauthn/` directory (which provides the production
 * router at /api/webauthn). This module exposes a smaller surface
 * intended for the user-scoped + auth-scoped passkey endpoints:
 *
 *   - POST /api/users/me/webauthn/registration-options
 *   - POST /api/users/me/webauthn/registration-verify
 *   - POST /api/auth/webauthn/authentication-options
 *   - POST /api/auth/webauthn/authentication-verify
 *
 * Storage model:
 *   The single source of truth in this scaffold is the new
 *   `User.webauthnCredentials` JSON column (Prisma migration
 *   2026-05-19). Each row is an array of:
 *     { credentialId, publicKey, counter, transports[] }
 *   `credentialId` and `publicKey` are base64url strings. The
 *   column starts null on existing rows and is upserted on
 *   successful registration.
 *
 * Lib gating:
 *   `@simplewebauthn/server` is a heavy optional dependency. When
 *   it isn't installed every function returns a `{ ok: false,
 *   status: 501, error: 'webauthn_lib_missing' }` shape so the
 *   route handlers can surface a clear placeholder without
 *   crashing. The presence check is lazy + cached.
 *
 * Origin / RP config:
 *   Reads WEBAUTHN_RP_ID, WEBAUTHN_RP_NAME, WEBAUTHN_ORIGIN(S)
 *   from the env (same vars as `services/webauthn/webauthn-config`)
 *   so a single operator config wires both surfaces. If the
 *   config is incomplete every function returns `501` with the
 *   `webauthn_not_configured` error — same shape, different code.
 *
 * Challenges:
 *   Held in an in-process Map keyed by `${userId}|${kind}` with a
 *   5-minute TTL. The scaffold does NOT share storage with the
 *   redis-backed challenge store under `services/webauthn/`; the
 *   two stacks are independent so that the new endpoints can ship
 *   without changing the production /api/webauthn surface.
 */

const DEFAULT_RP_NAME = 'siraGPT';
const DEFAULT_TIMEOUT_MS = 60_000;
const CHALLENGE_TTL_MS = 5 * 60_000;

let cachedSdk;
let sdkLoadAttempted = false;

function loadSimpleWebAuthn() {
  if (sdkLoadAttempted) return cachedSdk;
  sdkLoadAttempted = true;
  try {
    cachedSdk = require('@simplewebauthn/server');
  } catch (_err) {
    cachedSdk = null;
  }
  return cachedSdk;
}

// Exposed for tests so they can force the missing-lib path.
function __setSdkForTest(sdk) {
  cachedSdk = sdk;
  sdkLoadAttempted = true;
}

function __resetSdkForTest() {
  cachedSdk = undefined;
  sdkLoadAttempted = false;
}

function parseOrigins(raw) {
  return String(raw || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

function resolveConfig(env = process.env) {
  const rpID = String(env.WEBAUTHN_RP_ID || '').trim();
  const rpName = String(env.WEBAUTHN_RP_NAME || '').trim() || DEFAULT_RP_NAME;
  const origins = parseOrigins(env.WEBAUTHN_ORIGIN || env.WEBAUTHN_ORIGINS);
  const timeoutMs = Number.parseInt(env.WEBAUTHN_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS;
  return {
    rpID,
    rpName,
    origins,
    timeoutMs,
    configured: Boolean(rpID && origins.length > 0),
  };
}

// ────────────────────────────────────────────────────────────
// In-memory challenge store. A Map keyed by `${userId}|${kind}`
// with timestamped values; entries older than CHALLENGE_TTL_MS
// are evicted on access. Keeps the scaffold self-contained.
// ────────────────────────────────────────────────────────────
const challenges = new Map();

function challengeKey(userId, kind) {
  return `${userId || 'anon'}|${kind}`;
}

function putChallenge(userId, kind, value) {
  challenges.set(challengeKey(userId, kind), { value, exp: Date.now() + CHALLENGE_TTL_MS });
}

function takeChallenge(userId, kind) {
  const key = challengeKey(userId, kind);
  const entry = challenges.get(key);
  if (!entry) return null;
  challenges.delete(key);
  if (entry.exp < Date.now()) return null;
  return entry.value;
}

function __clearChallengesForTest() {
  challenges.clear();
}

// ────────────────────────────────────────────────────────────
// Credential helpers — read / write the User.webauthnCredentials
// JSON column. Defensive against legacy rows where the column is
// null, undefined, or a non-array shape.
// ────────────────────────────────────────────────────────────
function readCredentials(user) {
  if (!user) return [];
  const raw = user.webauthnCredentials;
  if (!Array.isArray(raw)) return [];
  return raw.filter((c) => c && typeof c === 'object' && typeof c.credentialId === 'string');
}

function notReady(env) {
  const sdk = loadSimpleWebAuthn();
  if (!sdk) {
    return {
      ok: false,
      status: 501,
      error: 'webauthn_lib_missing',
      hint: 'install @simplewebauthn/server to enable passkey support',
    };
  }
  const config = resolveConfig(env);
  if (!config.configured) {
    return {
      ok: false,
      status: 501,
      error: 'webauthn_not_configured',
      hint: 'set WEBAUTHN_RP_ID and WEBAUTHN_ORIGIN',
    };
  }
  return { sdk, config };
}

/**
 * generateRegistrationOptions — produce the
 * PublicKeyCredentialCreationOptions JSON for the browser to pass
 * to navigator.credentials.create(). Stashes the challenge so the
 * matching verifyRegistration call can replay it.
 *
 * @param {Object} args
 * @param {Object} args.user         — { id, email?, name? }
 * @param {Object} [args.env]        — defaults to process.env
 */
async function generateRegistrationOptions({ user, env = process.env } = {}) {
  if (!user || !user.id) {
    return { ok: false, status: 400, error: 'webauthn_missing_user' };
  }
  const ready = notReady(env);
  if (!ready.sdk) return ready;
  const { sdk, config } = ready;
  try {
    const existing = readCredentials(user);
    const options = await sdk.generateRegistrationOptions({
      rpName: config.rpName,
      rpID: config.rpID,
      userID: Buffer.from(user.id, 'utf8'),
      userName: user.email || user.name || user.id,
      userDisplayName: user.name || user.email || user.id,
      timeout: config.timeoutMs,
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({
        id: c.credentialId,
        type: 'public-key',
        transports: Array.isArray(c.transports) ? c.transports : [],
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });
    putChallenge(user.id, 'registration', options.challenge);
    return { ok: true, options };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: 'webauthn_registration_options_failed',
      message: err && err.message,
    };
  }
}

/**
 * verifyRegistration — verify the AttestationResponse and build
 * the credential record to persist to User.webauthnCredentials.
 * NOTE: this function does NOT touch the database; the route
 * handler is responsible for the upsert so that all DB access
 * remains in the routing layer (mirrors the totp service shape).
 *
 * Returns `{ ok: true, credential, credentials }` on success
 * where `credentials` is the full new array to write to the
 * column (existing + the new one).
 */
async function verifyRegistration({ user, response, label, env = process.env } = {}) {
  if (!user || !user.id) {
    return { ok: false, status: 400, error: 'webauthn_missing_user' };
  }
  if (!response || typeof response !== 'object') {
    return { ok: false, status: 400, error: 'webauthn_missing_response' };
  }
  const ready = notReady(env);
  if (!ready.sdk) return ready;
  const { sdk, config } = ready;
  const expectedChallenge = takeChallenge(user.id, 'registration');
  if (!expectedChallenge) {
    return { ok: false, status: 400, error: 'webauthn_no_pending_challenge' };
  }
  try {
    const verification = await sdk.verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpID,
      requireUserVerification: false,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return { ok: false, status: 400, error: 'webauthn_registration_verify_failed' };
    }
    const info = verification.registrationInfo;
    const credential = {
      credentialId: Buffer.from(info.credential.id).toString('base64url'),
      publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
      counter: Number(info.credential.counter || 0),
      transports: Array.isArray(response?.response?.transports)
        ? response.response.transports.slice()
        : [],
      label: typeof label === 'string' ? label.slice(0, 80) : null,
      createdAt: new Date().toISOString(),
    };
    const existing = readCredentials(user);
    // Idempotency: replace any prior entry with the same credentialId.
    const filtered = existing.filter((c) => c.credentialId !== credential.credentialId);
    const credentials = filtered.concat([credential]);
    return { ok: true, credential, credentials };
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: 'webauthn_registration_verify_failed',
      message: err && err.message,
    };
  }
}

/**
 * generateAuthenticationOptions — produce the
 * PublicKeyCredentialRequestOptions for navigator.credentials.get.
 * Caller passes the (claimed) user so we can scope the
 * `allowCredentials` hint; an unknown user returns an empty list
 * (same response shape) to avoid enumeration.
 */
async function generateAuthenticationOptions({ user, env = process.env } = {}) {
  const ready = notReady(env);
  if (!ready.sdk) return ready;
  const { sdk, config } = ready;
  try {
    const existing = readCredentials(user);
    const options = await sdk.generateAuthenticationOptions({
      timeout: config.timeoutMs,
      allowCredentials: existing.map((c) => ({
        id: c.credentialId,
        type: 'public-key',
        transports: Array.isArray(c.transports) ? c.transports : [],
      })),
      rpID: config.rpID,
      userVerification: 'preferred',
    });
    const challengeOwner = user && user.id ? user.id : 'anon';
    putChallenge(challengeOwner, 'authentication', options.challenge);
    return { ok: true, options };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: 'webauthn_authentication_options_failed',
      message: err && err.message,
    };
  }
}

/**
 * verifyAuthentication — verify the AssertionResponse against the
 * stored credential for the claimed user. On success returns
 * `{ ok: true, credentials }` with the credential array updated
 * to reflect the new authenticator counter (so the route handler
 * can write the column back).
 */
async function verifyAuthentication({ user, response, env = process.env } = {}) {
  if (!user || !user.id) {
    return { ok: false, status: 400, error: 'webauthn_missing_user' };
  }
  if (!response || typeof response !== 'object' || !response.id) {
    return { ok: false, status: 400, error: 'webauthn_missing_response' };
  }
  const ready = notReady(env);
  if (!ready.sdk) return ready;
  const { sdk, config } = ready;
  const expectedChallenge = takeChallenge(user.id, 'authentication');
  if (!expectedChallenge) {
    return { ok: false, status: 400, error: 'webauthn_no_pending_challenge' };
  }
  const credentials = readCredentials(user);
  const stored = credentials.find((c) => c.credentialId === response.id);
  if (!stored) {
    return { ok: false, status: 400, error: 'webauthn_credential_not_found' };
  }
  try {
    const verification = await sdk.verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpID,
      credential: {
        id: stored.credentialId,
        publicKey: Buffer.from(stored.publicKey, 'base64url'),
        counter: Number(stored.counter || 0),
        transports: Array.isArray(stored.transports) ? stored.transports : [],
      },
      requireUserVerification: false,
    });
    if (!verification.verified) {
      return { ok: false, status: 400, error: 'webauthn_authentication_verify_failed' };
    }
    const newCounter = Number(verification.authenticationInfo?.newCounter || 0);
    // Spec rule: counter MUST be monotonic. A non-increase (other
    // than 0→0 for authenticators that don't track it) signals a
    // possible cloned credential — surface distinctly.
    if (Number(stored.counter || 0) > 0 && newCounter <= Number(stored.counter || 0)) {
      return {
        ok: false,
        status: 401,
        error: 'webauthn_counter_regression',
        message: 'credential counter regressed — possible cloned authenticator',
      };
    }
    const updated = credentials.map((c) => (
      c.credentialId === stored.credentialId
        ? { ...c, counter: newCounter, lastUsedAt: new Date().toISOString() }
        : c
    ));
    return { ok: true, userId: user.id, credentialId: stored.credentialId, credentials: updated };
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: 'webauthn_authentication_verify_failed',
      message: err && err.message,
    };
  }
}

module.exports = {
  generateRegistrationOptions,
  verifyRegistration,
  generateAuthenticationOptions,
  verifyAuthentication,
  // helpers exposed for the route handlers + tests
  resolveConfig,
  readCredentials,
  __setSdkForTest,
  __resetSdkForTest,
  __clearChallengesForTest,
};

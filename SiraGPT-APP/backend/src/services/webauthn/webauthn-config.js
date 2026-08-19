'use strict';

/**
 * webauthn-config — env-vars → relying-party config for the
 * `@simplewebauthn/server` SDK. The relying party (RP) is the
 * identity the user's authenticator binds the credential to. In
 * the spec, three values matter:
 *
 *   - rpID:    a domain string (no scheme, no port). Credentials
 *              created for `rpID = "example.com"` work on
 *              app.example.com but NOT on attacker.tld pretending to
 *              be example.com via DNS spoofing — the browser
 *              enforces the binding.
 *
 *   - rpName:  human-readable label shown in the OS / browser UI
 *              ("Sign in to siraGPT?").
 *
 *   - origin:  the full https:// origin(s) the RP serves from.
 *              Multiple origins are supported (production +
 *              staging) so a single credential can authenticate at
 *              both.
 *
 * Disabled by default. The wrapper exposes `enabled` so route
 * handlers can short-circuit with a 404 when the operator has not
 * configured WebAuthn — same pattern as Sentry / Langfuse / E2B.
 *
 * No route is wired in this commit; the scaffold ships the config
 * resolver + (next file) the challenge store. The endpoints
 * themselves land in 8l2 once the operator has decided whether
 * passkeys live alongside passwords (parallel) or replace them.
 */

const DEFAULT_RP_NAME = 'siraGPT';
const DEFAULT_TIMEOUT_MS = 60_000;

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseOrigins(raw) {
  return String(raw || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

function resolveWebAuthnConfig(env = process.env) {
  const rpID = String(env.WEBAUTHN_RP_ID || '').trim();
  const rpName = String(env.WEBAUTHN_RP_NAME || '').trim() || DEFAULT_RP_NAME;
  const origins = parseOrigins(env.WEBAUTHN_ORIGIN || env.WEBAUTHN_ORIGINS);
  const configured = Boolean(rpID && origins.length > 0);
  const explicit = env.WEBAUTHN_ENABLED;
  const enabled = explicit === undefined || explicit === ''
    ? configured
    : parseBoolean(explicit, configured);
  return {
    configured,
    enabled: enabled && configured,
    rpID,
    rpName,
    origins,
    timeoutMs: Number.parseInt(env.WEBAUTHN_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS,
  };
}

/**
 * assertOriginAllowed — verify a request Origin matches one of the
 * configured WebAuthn origins. Used by the (future) registration /
 * authentication endpoints. Exact match (no suffix tricks): the
 * spec requires origin equality, not host suffix matching.
 */
function assertOriginAllowed(requestOrigin, config) {
  if (!config || !config.enabled) return false;
  if (typeof requestOrigin !== 'string' || !requestOrigin) return false;
  return config.origins.includes(requestOrigin);
}

module.exports = {
  resolveWebAuthnConfig,
  assertOriginAllowed,
  DEFAULT_RP_NAME,
  DEFAULT_TIMEOUT_MS,
};

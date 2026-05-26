'use strict';

/**
 * /api/webauthn — passkey registration + authentication endpoints.
 *
 * Four routes implementing the standard WebAuthn ceremony:
 *
 *   POST /register/begin   (auth required)
 *      Generates a registration challenge for the authenticated
 *      user. Returns the PublicKeyCredentialCreationOptions JSON
 *      the browser passes to navigator.credentials.create().
 *
 *   POST /register/finish  (auth required)
 *      Receives the AttestationResponse from the browser.
 *      Verifies the signature against the stored challenge,
 *      persists the new credential. Returns { ok: true,
 *      credentialId, label }.
 *
 *   POST /login/begin
 *      Generates an authentication challenge. Body must include
 *      `userId` (the user attempting to sign in). The endpoint is
 *      INTENTIONALLY un-authenticated — it's the entry point of
 *      the login flow itself. We minimize what's leaked: a request
 *      for an unknown userId still returns a structurally valid
 *      challenge so an attacker can't enumerate users.
 *
 *   POST /login/finish
 *      Receives the AssertionResponse, verifies it against the
 *      stored credential + challenge, increments the counter.
 *      Returns { ok: true, userId } on success. Does NOT issue a
 *      session token here — that belongs in the higher-level
 *      auth flow (which can call this route as a sub-step).
 *
 * Gating:
 *   The router is mounted only when the resolver in
 *   webauthn-config.js declares the deployment ENABLED (RP_ID +
 *   ORIGIN both set). Beyond that, the operator must also flip
 *   WEBAUTHN_ENDPOINTS_ENABLED=true to expose the routes — the
 *   double opt-in matches the pattern used by web.fetch and
 *   code.execute.
 *
 * Storage:
 *   Two stores plug in: webauthn-challenge-store (TTL'd
 *   challenges, Redis-or-memory) and credential-store (durable
 *   per-user credentials). Both are passed via constructor so
 *   tests inject in-memory implementations.
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const {
  resolveWebAuthnConfig,
  assertOriginAllowed,
} = require('../services/webauthn/webauthn-config');
const {
  createWebAuthnChallengeStore,
} = require('../services/webauthn/webauthn-challenge-store');
const {
  createInMemoryCredentialStore,
} = require('../services/webauthn/credential-store');

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function shouldExposeEndpoints(env) {
  return parseBoolean(env.WEBAUTHN_ENDPOINTS_ENABLED, false);
}

function loadSimpleWebAuthn() {
  // Lazy require so a fresh checkout (pre-`npm install`) doesn't
  // crash boot. The router below explicitly checks for the package
  // before mounting handlers; if missing we expose a 503.
  try {
    return require('@simplewebauthn/server');
  } catch (_err) {
    return null;
  }
}

function buildWebAuthnRouter(options = {}) {
  const env = options.env || process.env;
  const router = express.Router();
  const config = resolveWebAuthnConfig(env);

  if (!config.enabled || !shouldExposeEndpoints(env)) {
    router.all('*', (_req, res) => {
      res.status(404).json({
        error: 'webauthn_endpoints_disabled',
        hint: 'set WEBAUTHN_RP_ID, WEBAUTHN_ORIGIN, and WEBAUTHN_ENDPOINTS_ENABLED=true',
      });
    });
    return router;
  }

  // `'sdk' in options` lets a test seam pass `sdk: null` to
  // simulate the missing-package path. A bare `options.sdk ||
  // loadSimpleWebAuthn()` would silently fall through to the real
  // SDK and the test for the 503 path would never fire.
  const sw = ('sdk' in options) ? options.sdk : loadSimpleWebAuthn();
  if (!sw) {
    router.all('*', (_req, res) => {
      res.status(503).json({
        error: 'webauthn_sdk_missing',
        hint: 'install @simplewebauthn/server',
      });
    });
    return router;
  }

  const challengeStore = options.challengeStore
    || createWebAuthnChallengeStore(env);
  const credentialStore = options.credentialStore
    || createInMemoryCredentialStore();

  // ─── POST /register/begin ──────────────────────────────────
  router.post('/register/begin', authenticateToken, async (req, res) => {
    try {
      const user = req.user;
      const existing = await credentialStore.listForUser(user.id);
      const options_ = await sw.generateRegistrationOptions({
        rpName: config.rpName,
        rpID: config.rpID,
        userID: Buffer.from(user.id, 'utf8'),
        userName: user.email || user.name || user.id,
        userDisplayName: user.name || user.email || user.id,
        timeout: config.timeoutMs,
        attestationType: 'none',
        // Prevent the user from registering the same authenticator twice.
        excludeCredentials: existing.map((c) => ({
          id: c.id,
          type: 'public-key',
          transports: c.transports,
        })),
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: 'preferred',
        },
      });
      await challengeStore.put(user.id, 'registration', options_.challenge);
      res.json({ ok: true, options: options_ });
    } catch (err) {
      res.status(500).json({ error: 'webauthn_register_begin_failed', message: err && err.message });
    }
  });

  // ─── POST /register/finish ─────────────────────────────────
  router.post('/register/finish', authenticateToken, async (req, res) => {
    const user = req.user;
    const expectedChallenge = await challengeStore.get(user.id, 'registration');
    if (!expectedChallenge) {
      return res.status(400).json({ error: 'webauthn_no_pending_challenge' });
    }
    try {
      const verification = await sw.verifyRegistrationResponse({
        response: req.body.response,
        expectedChallenge,
        expectedOrigin: config.origins,
        expectedRPID: config.rpID,
        requireUserVerification: false,
      });
      if (!verification.verified || !verification.registrationInfo) {
        return res.status(400).json({ error: 'webauthn_register_verify_failed' });
      }
      const info = verification.registrationInfo;
      const credentialId = Buffer.from(info.credential.id).toString('base64url');
      const publicKey = Buffer.from(info.credential.publicKey).toString('base64url');
      await credentialStore.save({
        id: credentialId,
        userId: user.id,
        publicKey,
        counter: Number(info.credential.counter || 0),
        transports: Array.isArray(req.body.response?.response?.transports)
          ? req.body.response.response.transports
          : [],
        label: typeof req.body.label === 'string' ? req.body.label.slice(0, 80) : null,
      });
      await challengeStore.del(user.id, 'registration');
      res.json({ ok: true, credentialId, label: req.body.label || null });
    } catch (err) {
      res.status(400).json({ error: 'webauthn_register_verify_failed', message: err && err.message });
    }
  });

  // ─── POST /login/begin ─────────────────────────────────────
  router.post('/login/begin', async (req, res) => {
    const userId = String(req.body.userId || '').trim();
    if (!userId) {
      return res.status(400).json({ error: 'webauthn_missing_user' });
    }
    try {
      // Note: we DO list credentials for the user here so the
      // browser knows which authenticators to ask. An unknown user
      // returns an empty allowCredentials list — same shape as a
      // legitimate-but-no-passkey user, so an attacker can't
      // enumerate registered users by response shape.
      const existing = await credentialStore.listForUser(userId);
      const options_ = await sw.generateAuthenticationOptions({
        timeout: config.timeoutMs,
        allowCredentials: existing.map((c) => ({
          id: c.id,
          type: 'public-key',
          transports: c.transports,
        })),
        rpID: config.rpID,
        userVerification: 'preferred',
      });
      await challengeStore.put(userId, 'authentication', options_.challenge);
      res.json({ ok: true, options: options_ });
    } catch (err) {
      res.status(500).json({ error: 'webauthn_login_begin_failed', message: err && err.message });
    }
  });

  // ─── POST /login/finish ────────────────────────────────────
  router.post('/login/finish', async (req, res) => {
    const userId = String(req.body.userId || '').trim();
    const credentialId = String(req.body.response?.id || '').trim();
    if (!userId || !credentialId) {
      return res.status(400).json({ error: 'webauthn_missing_fields' });
    }
    const origin = String(req.headers.origin || '');
    if (!assertOriginAllowed(origin, config)) {
      return res.status(400).json({ error: 'webauthn_origin_not_allowed' });
    }
    const expectedChallenge = await challengeStore.get(userId, 'authentication');
    if (!expectedChallenge) {
      return res.status(400).json({ error: 'webauthn_no_pending_challenge' });
    }
    const stored = await credentialStore.findById(credentialId);
    if (!stored || stored.userId !== userId) {
      return res.status(400).json({ error: 'webauthn_credential_not_found' });
    }
    try {
      const verification = await sw.verifyAuthenticationResponse({
        response: req.body.response,
        expectedChallenge,
        expectedOrigin: config.origins,
        expectedRPID: config.rpID,
        credential: {
          id: stored.id,
          publicKey: Buffer.from(stored.publicKey, 'base64url'),
          counter: stored.counter,
          transports: stored.transports,
        },
        requireUserVerification: false,
      });
      if (!verification.verified) {
        return res.status(400).json({ error: 'webauthn_login_verify_failed' });
      }
      const newCounter = Number(verification.authenticationInfo?.newCounter || 0);
      try {
        await credentialStore.updateCounter(credentialId, newCounter);
      } catch (counterErr) {
        // updateCounter throws on counter regression; surface it
        // distinctly so security monitoring can alert on cloned-key
        // signals.
        return res.status(401).json({
          error: 'webauthn_counter_regression',
          message: counterErr && counterErr.message,
        });
      }
      await challengeStore.del(userId, 'authentication');
      res.json({ ok: true, userId });
    } catch (err) {
      res.status(400).json({ error: 'webauthn_login_verify_failed', message: err && err.message });
    }
  });

  return router;
}

module.exports = {
  buildWebAuthnRouter,
  shouldExposeEndpoints,
};

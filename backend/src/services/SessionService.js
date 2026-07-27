'use strict';

const {
  publishUserSessionsRevoked,
} = require('./auth/user-session-revocation-events');

/**
 * SessionService — owns the session-lifecycle business logic that
 * previously lived inline inside the `POST /refresh` and `POST /logout`
 * handlers of `routes/auth.js`.
 *
 * Responsibilities:
 *  - refresh: re-sign a session token (re-embedding admin claims),
 *    rotate the session row's token + expiry, re-bind the client
 *    fingerprint, and fire a `token_refresh` audit entry.
 *  - revoke: delete the session row bound to a given token and fire
 *    a `logout` audit entry.
 *
 * SOLID:
 *  - SRP: only session-lifecycle policy. No HTTP, cookies, JSON
 *    shaping — those stay in the route. No JWT verification, no
 *    user lookup beyond what the caller already resolved.
 *  - DIP: every collaborator (sessions repo, audit fn, signSessionToken,
 *    computeFingerprint, prisma handle, now, sessionTtlMs) is injected
 *    so unit tests can run without prisma, JWT secret, or req parsing.
 *  - OCP: the planned step-up-auth / refresh-token-rotation work is a
 *    matter of adding a check or a new `refresh()` branch here, without
 *    re-touching the route handler.
 *
 * Result shape (discriminated by `kind`):
 *   refresh(): { ok:true, token, expiresAt }
 *   revoke():  { ok:true }
 *
 * The service does not currently model failure branches — both
 * operations either succeed or throw (matching the legacy handler
 * behaviour, where the route's try/catch maps thrown errors to 500).
 */
class SessionService {
  constructor({
    sessions,
    audit,
    prisma,
    signSessionToken,
    computeFingerprint,
    publishSessionsRevoked = publishUserSessionsRevoked,
    sessionTtlMs = 7 * 24 * 60 * 60 * 1000,
    now = () => new Date(),
    logger = console,
  }) {
    if (!sessions
      || typeof sessions.updateByToken !== 'function'
      || typeof sessions.deleteByToken !== 'function') {
      throw new Error(
        'SessionService: sessions repository (updateByToken/deleteByToken) is required',
      );
    }
    if (typeof audit !== 'function') {
      throw new Error('SessionService: audit fn is required');
    }
    if (typeof signSessionToken !== 'function') {
      throw new Error('SessionService: signSessionToken is required');
    }
    this.sessions = sessions;
    this.audit = audit;
    this.prisma = prisma || null;
    this.signSessionToken = signSessionToken;
    this.computeFingerprint = typeof computeFingerprint === 'function'
      ? computeFingerprint
      : () => null;
    this.publishSessionsRevoked = typeof publishSessionsRevoked === 'function'
      ? publishSessionsRevoked
      : async () => {};
    this.sessionTtlMs = sessionTtlMs;
    this.now = now;
    this.logger = logger;
  }

  /**
   * Re-mint a session token for the already-authenticated `user` and
   * rotate the row identified by `oldToken`. Re-binds the fingerprint
   * to the refreshing client so subsequent verifications track the
   * current network/UA.
   */
  async refresh({ user, oldToken, req }) {
    const newToken = this.signSessionToken({
      userId: user.id,
      isAdmin: Boolean(user.isAdmin),
      isSuperAdmin: Boolean(user.isSuperAdmin),
    });
    const expiresAt = new Date(this.now().getTime() + this.sessionTtlMs);
    const fingerprint = this.computeFingerprint(req);

    await this.sessions.updateByToken(oldToken, {
      newToken,
      expiresAt,
      fingerprint,
    });

    this._fireAudit(req, {
      action: 'token_refresh',
      resource: 'session',
      userId: user.id,
      actorName: user.email,
    });

    return { ok: true, token: newToken, expiresAt };
  }

  /**
   * Revoke the session bound to `token`. Idempotent — `deleteByToken`
   * uses `deleteMany` under the hood so concurrent logout is safe.
   */
  async revoke({ user, token, req }) {
    await this.sessions.deleteByToken(token);
    if (user?.id) {
      await this.publishSessionsRevoked({
        userId: user.id,
        reason: 'session_revoked',
      });
    }

    this._fireAudit(req, {
      action: 'logout',
      resource: 'session',
      userId: user?.id,
      actorName: user?.email,
    });

    return { ok: true };
  }

  /** Fire-and-forget audit — matches the route's prior `void writeAuditLog(...)`
   * style so an audit failure never breaks the request. */
  _fireAudit(req, payload) {
    try { void this.audit(this.prisma, { req, ...payload }); }
    catch (_e) { /* never break the request on audit failure */ }
  }
}

module.exports = { SessionService };

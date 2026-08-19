'use strict';

const bcrypt = require('bcryptjs');

/**
 * RegistrationService — owns the email/password registration pipeline:
 * SSO-domain gate → duplicate check → password hash → user create →
 * session mint. Returns a discriminated result so the route can map
 * each branch to the right HTTP status/body without leaking business
 * decisions back into the request handler.
 *
 * SOLID:
 *  - SRP: only the "create a password-backed account + first session"
 *    pipeline. No HTTP, no cookie setting, no CSRF mint (HTTP-layer
 *    concerns stay in the route).
 *  - DIP: every collaborator (users, sessions, resolveOrgBySsoDomain,
 *    hashPassword, signSessionToken, now) is injected. Defaults match
 *    the production wiring so tests can override surgically.
 *  - OCP: adding a new pre-create gate (e.g. domain allowlist) is "add
 *    a check that returns `{ok:false, kind:'…'}`" — the route's switch
 *    grows by one branch.
 *
 * Result shape (discriminated by `kind`):
 *   { ok: false, kind: 'sso_required',  org: {id, slug} }
 *   { ok: false, kind: 'duplicate' }
 *   { ok: true,  user, token, expiresAt }
 */
class RegistrationService {
  constructor({
    users,
    sessions,
    resolveOrgBySsoDomain,
    signSessionToken,
    hashPassword,
    sessionTtlMs = 7 * 24 * 60 * 60 * 1000,
    bcryptRounds = 12,
    now = () => new Date(),
    logger = console,
  }) {
    if (!users || typeof users.findByEmail !== 'function' || typeof users.createPasswordUser !== 'function') {
      throw new Error('RegistrationService: users repository (findByEmail + createPasswordUser) is required');
    }
    if (!sessions || typeof sessions.create !== 'function') {
      throw new Error('RegistrationService: sessions repository is required');
    }
    if (typeof resolveOrgBySsoDomain !== 'function') {
      throw new Error('RegistrationService: resolveOrgBySsoDomain is required');
    }
    if (typeof signSessionToken !== 'function') {
      throw new Error('RegistrationService: signSessionToken is required');
    }
    this.users = users;
    this.sessions = sessions;
    this.resolveOrgBySsoDomain = resolveOrgBySsoDomain;
    this.signSessionToken = signSessionToken;
    this.hashPassword = hashPassword || ((plain) => bcrypt.hash(plain, bcryptRounds));
    this.sessionTtlMs = sessionTtlMs;
    this.now = now;
    this.logger = logger;
  }

  /**
   * Run the full registration pipeline. Never throws on the expected
   * failure paths (SSO gate, duplicate). Unexpected DB/crypto errors
   * propagate so the route can return 500 — matching the legacy
   * try/catch shape.
   */
  async register({ name, email, password }) {
    // SSO domain claim — if any org claims this email's domain AND
    // has SSO enabled, refuse password-backed registration so the
    // password handler can't bypass the org's IdP.
    const ssoOrg = await this.resolveOrgBySsoDomain(email);
    if (ssoOrg) {
      return { ok: false, kind: 'sso_required', org: { id: ssoOrg.id, slug: ssoOrg.slug } };
    }

    const existingUser = await this.users.findByEmail(email);
    if (existingUser) {
      return { ok: false, kind: 'duplicate' };
    }

    const passwordHash = await this.hashPassword(password);
    const user = await this.users.createPasswordUser({ name, email, passwordHash });

    // Mint session — embed admin claims so the rate-limit bypass +
    // downstream policy checks don't need a DB lookup on the hot
    // path. aud/iss/expiry are added centrally by signSessionToken.
    const token = this.signSessionToken({
      userId: user.id,
      isAdmin: Boolean(user.isAdmin),
      isSuperAdmin: Boolean(user.isSuperAdmin),
    });
    const expiresAt = new Date(this.now().getTime() + this.sessionTtlMs);
    await this.sessions.create({ userId: user.id, token, expiresAt });

    return { ok: true, user, token, expiresAt };
  }
}

module.exports = { RegistrationService };

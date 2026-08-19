'use strict';

const bcrypt = require('bcryptjs');

/**
 * LoginService — owns the email/password login pipeline:
 * SSO-domain gate → account lockout check → user lookup → bcrypt
 * compare → success/failure audit fan-out → org-2FA gate → SMS-2FA
 * gate → TOTP-2FA gate → session mint + persist. Returns a
 * discriminated result so the route can map each branch to an HTTP
 * response without leaking business decisions back into the handler.
 *
 * SOLID:
 *  - SRP: only the credential-login pipeline. No HTTP, no cookies,
 *    no CSRF mint, no JSON shaping — those stay in the route.
 *  - DIP: every collaborator (users, sessions, audit, lockout,
 *    resolveOrgBySsoDomain, signSessionToken, fingerprint fn,
 *    twoFASms, mintPartialSession, requires-2FA gate) is injected.
 *    Defaults mirror production wiring so tests can override
 *    surgically without standing up bcrypt / prisma / SMS.
 *  - OCP: adding a new pre-mint gate (e.g. step-up auth, password
 *    breach check) is "add a check that returns `{ok:false,
 *    kind:'…'}`" — the route's switch grows by one branch.
 *
 * Result shape (discriminated by `kind`):
 *   { ok:false, kind:'sso_required',          org:{id,slug} }
 *   { ok:false, kind:'locked',                retryAfterMs, attempts }
 *   { ok:false, kind:'invalid_credentials' }
 *   { ok:false, kind:'org_2fa_required',      orgId }
 *   { ok:false, kind:'sms_2fa_required',      challengeId, expiresAt, smsSent, smsSkippedReason? }
 *   { ok:false, kind:'sms_2fa_mint_failed' }
 *   { ok:false, kind:'totp_2fa_required',     partialToken, expiresAt }
 *   { ok:false, kind:'totp_partial_mint_failed' }
 *   { ok:true,  user, token, expiresAt, csrfFresh:true }
 *
 * The service writes audit-log entries for the failure / 2FA-gate
 * branches because they depend on the lockout counter we mutate
 * here. The route fires the final `login` success audit so it can
 * tag the request with the freshly-issued session.
 */
class LoginService {
  constructor({
    users,
    sessions,
    audit,
    prisma,
    lockout,
    resolveOrgBySsoDomain,
    signSessionToken,
    comparePassword,
    computeFingerprint,
    userHasTwoFactor,
    orgRequiresTwoFactor,
    twoFASms,
    mintPartialSession,
    sessionTtlMs = 7 * 24 * 60 * 60 * 1000,
    now = () => new Date(),
    logger = console,
  }) {
    if (!users || typeof users.findByEmail !== 'function') {
      throw new Error('LoginService: users repository (findByEmail) is required');
    }
    if (!sessions || typeof sessions.create !== 'function') {
      throw new Error('LoginService: sessions repository (create) is required');
    }
    if (typeof audit !== 'function') {
      throw new Error('LoginService: audit fn is required');
    }
    if (!lockout
      || typeof lockout.isLocked !== 'function'
      || typeof lockout.recordFailure !== 'function'
      || typeof lockout.recordSuccess !== 'function') {
      throw new Error('LoginService: lockout (isLocked/recordFailure/recordSuccess) is required');
    }
    if (typeof resolveOrgBySsoDomain !== 'function') {
      throw new Error('LoginService: resolveOrgBySsoDomain is required');
    }
    if (typeof signSessionToken !== 'function') {
      throw new Error('LoginService: signSessionToken is required');
    }
    if (typeof userHasTwoFactor !== 'function') {
      throw new Error('LoginService: userHasTwoFactor is required');
    }
    if (typeof orgRequiresTwoFactor !== 'function') {
      throw new Error('LoginService: orgRequiresTwoFactor is required');
    }
    this.users = users;
    this.sessions = sessions;
    this.audit = audit;
    this.prisma = prisma || null;
    this.lockout = lockout;
    this.resolveOrgBySsoDomain = resolveOrgBySsoDomain;
    this.signSessionToken = signSessionToken;
    this.comparePassword = comparePassword || ((plain, hash) => bcrypt.compare(plain, hash));
    this.computeFingerprint = typeof computeFingerprint === 'function'
      ? computeFingerprint
      : () => null;
    this.userHasTwoFactor = userHasTwoFactor;
    this.orgRequiresTwoFactor = orgRequiresTwoFactor;
    this.twoFASms = twoFASms || null;
    this.mintPartialSession = typeof mintPartialSession === 'function'
      ? mintPartialSession
      : null;
    this.sessionTtlMs = sessionTtlMs;
    this.now = now;
    this.logger = logger;
  }

  /**
   * Run the full login pipeline. Never throws on the expected failure
   * paths — unexpected errors (bcrypt, DB) propagate so the route's
   * try/catch can return 500 with the legacy body shape.
   */
  async login({ email, password, req }) {
    // SSO domain claim — if any org has claimed the user's email
    // domain AND ssoEnabled = true, bounce password auth so it can't
    // bypass the org's IdP.
    const ssoOrg = await this.resolveOrgBySsoDomain(email);
    if (ssoOrg) {
      this._fireAudit(req, {
        action: 'login_sso_required',
        resource: 'organization',
        resourceId: ssoOrg.id,
        actorName: email,
        metadata: { orgSlug: ssoOrg.slug },
      });
      return { ok: false, kind: 'sso_required', org: { id: ssoOrg.id, slug: ssoOrg.slug } };
    }

    // Account-level lockout — distinct from the per-IP rate limit so
    // distributed credential-stuffing (one attempt per IP) still
    // hits a cap.
    const lockState = this.lockout.isLocked(email);
    if (lockState.locked) {
      this._fireAudit(req, {
        action: 'account_locked',
        resource: 'user',
        actorName: email,
        metadata: { reason: 'too_many_failures', attempts: lockState.attempts },
      });
      return {
        ok: false,
        kind: 'locked',
        retryAfterMs: lockState.retryAfterMs,
        attempts: lockState.attempts,
      };
    }

    const user = await this.users.findByEmail(email);
    if (!user) {
      const after = this.lockout.recordFailure(email);
      this._fireAudit(req, {
        action: 'login_failed',
        resource: 'user',
        actorName: email,
        metadata: { reason: 'unknown_email', attempts: after.attempts },
      });
      if (after.locked) {
        this._fireAudit(req, {
          action: 'account_locked',
          resource: 'user',
          actorName: email,
          metadata: { reason: 'failure_threshold', attempts: after.attempts },
        });
      }
      return { ok: false, kind: 'invalid_credentials' };
    }

    const isValidPassword = await this.comparePassword(password, user.password);
    if (!isValidPassword) {
      const after = this.lockout.recordFailure(email);
      this._fireAudit(req, {
        action: 'login_failed',
        resource: 'user',
        resourceId: user.id,
        actorName: email,
        metadata: { reason: 'bad_password', attempts: after.attempts },
      });
      if (after.locked) {
        this._fireAudit(req, {
          action: 'account_locked',
          resource: 'user',
          resourceId: user.id,
          actorName: email,
          metadata: { reason: 'failure_threshold', attempts: after.attempts },
        });
      }
      return { ok: false, kind: 'invalid_credentials' };
    }
    this.lockout.recordSuccess(email);

    // ─── Org-level 2FA enforcement ───────────────────────────────
    // Refuse to mint a session when the user belongs to an org that
    // requires 2FA and has not enrolled either SMS or TOTP. SMS /
    // TOTP gates below handle users who *have* enrolled.
    const orgGate = await this._checkOrgTwoFactorGate(user, req);
    if (orgGate) return orgGate;

    // ─── SMS 2FA gate ────────────────────────────────────────────
    if (this._shouldGateSms(user)) {
      try {
        const { challengeId, code, expiresAt } = await this.twoFASms.createSmsChallenge(
          this.prisma,
          user,
          user.phone,
        );
        const smsResult = await this.twoFASms.sendSms(user.phone, code);
        this._fireAudit(req, {
          action: 'login_2fa_required',
          resource: 'user',
          resourceId: user.id,
          userId: user.id,
          actorName: user.email,
          metadata: {
            phoneMasked: user.phone.replace(/.(?=.{4})/g, '*'),
            smsSent: Boolean(smsResult.sent),
            smsReason: smsResult.reason || null,
          },
        });
        const result = {
          ok: false,
          kind: 'sms_2fa_required',
          challengeId,
          expiresAt,
          smsSent: Boolean(smsResult.sent),
        };
        if (!smsResult.sent && smsResult.reason) {
          result.smsSkippedReason = smsResult.reason;
        }
        return result;
      } catch (e) {
        this.logger.error?.('[auth/login] 2fa challenge mint failed:', e?.message || e);
        return { ok: false, kind: 'sms_2fa_mint_failed' };
      }
    }

    // ─── TOTP 2FA gate ───────────────────────────────────────────
    if (user.totpEnabled && !user.twoFactorEnabled) {
      if (!this.mintPartialSession) {
        this.logger.error?.('[auth/login] partial-session mint not wired');
        return { ok: false, kind: 'totp_partial_mint_failed' };
      }
      try {
        const partial = await this.mintPartialSession(user.id);
        this._fireAudit(req, {
          action: 'login_totp_required',
          resource: 'user',
          resourceId: user.id,
          userId: user.id,
          actorName: user.email,
        });
        return {
          ok: false,
          kind: 'totp_2fa_required',
          partialToken: partial.token,
          expiresAt: partial.expiresAt,
        };
      } catch (e) {
        this.logger.error?.('[auth/login] partial-session mint failed:', e?.message || e);
        return { ok: false, kind: 'totp_partial_mint_failed' };
      }
    }

    // ─── Mint full session ───────────────────────────────────────
    const token = this.signSessionToken({
      userId: user.id,
      isAdmin: Boolean(user.isAdmin),
      isSuperAdmin: Boolean(user.isSuperAdmin),
    });
    const expiresAt = new Date(this.now().getTime() + this.sessionTtlMs);
    const fingerprint = this.computeFingerprint(req);
    await this.sessions.create({ userId: user.id, token, expiresAt, fingerprint });

    return { ok: true, user, token, expiresAt };
  }

  _shouldGateSms(user) {
    if (!this.twoFASms) return false;
    if (typeof this.twoFASms.isValidPhone !== 'function') return false;
    return Boolean(
      user.twoFactorEnabled
      && user.phoneVerifiedAt
      && user.phone
      && this.twoFASms.isValidPhone(user.phone),
    );
  }

  /** Returns a discriminated `org_2fa_required` result, or null when
   * the gate is satisfied. Fails open on transient DB errors so a
   * flaky read can't lock every tenant out — the per-route enforce
   * hook still blocks org-scoped fetches downstream. */
  async _checkOrgTwoFactorGate(user, req) {
    if (this.userHasTwoFactor(user)) return null;
    const memberships = this.prisma?.orgMembership?.findMany;
    if (typeof memberships !== 'function') return null;
    try {
      const rows = await this.prisma.orgMembership.findMany({
        where: { userId: user.id },
        include: { organization: { select: { id: true, slug: true, settings: true } } },
      });
      const blocking = rows.find((m) => this.orgRequiresTwoFactor(m.organization));
      if (!blocking) return null;
      this._fireAudit(req, {
        action: 'login_blocked_org_2fa',
        resource: 'user',
        resourceId: user.id,
        userId: user.id,
        actorName: user.email,
        metadata: { orgId: blocking.organization.id },
      });
      return { ok: false, kind: 'org_2fa_required', orgId: blocking.organization.id };
    } catch (e) {
      this.logger.error?.('[auth/login] org-2fa check failed:', e?.message || e);
      return null;
    }
  }

  /** Fire-and-forget audit — original code uses `void writeAuditLog(...)`
   * so failures inside the audit util never break login. */
  _fireAudit(req, payload) {
    try { void this.audit(this.prisma, { req, ...payload }); }
    catch (_e) { /* never break the request on audit failure */ }
  }
}

module.exports = { LoginService };

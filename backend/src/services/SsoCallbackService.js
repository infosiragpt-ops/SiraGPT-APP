'use strict';

const bcrypt = require('bcryptjs');

/**
 * SsoCallbackService — orchestrates the SAML/OIDC callback pipeline
 * (resolve org → verify IdP response → apply provisioning policy →
 * find/create user → upsert membership → link SSOIdentity → mint
 * session → audit). The route layer becomes a 6-line wrapper.
 *
 * SOLID:
 *  - SRP: this class owns the SSO login lifecycle. It does not own
 *    transport (the route adapts HTTP req/res), it does not own
 *    crypto for the assertion (samlHandler/oidcHandler do), it does
 *    not own the audit-log persistence (writeAuditLog util does).
 *  - OCP: adding a new provider (e.g. magic-link IdP) is "add a
 *    verifier dep and one branch in _verify"; nothing else changes.
 *  - DIP: every collaborator (prisma, samlHandler, oidcHandler,
 *    audit, resolveOrg, signSessionToken, hashPassword, now, logger)
 *    is injected with safe defaults that match production wiring.
 *
 * The legacy `ssoSamlCallbackHandler(req, res, deps)` keeps its
 * signature exactly so the three existing regression test files
 * (auth-sso-{saml-callback,oidc-callback,provisioning}.test.js)
 * continue to pass without modification — they import that helper
 * from `router.__ssoHelpers`. The wrapper now constructs an instance
 * of this service from `deps` and delegates.
 */
class SsoCallbackService {
  constructor({
    prisma,
    audit,
    samlHandler,
    oidcHandler,
    resolveOrg,
    signSessionToken,
    hashPassword,
    now = () => new Date(),
    logger = console,
  }) {
    if (!prisma) throw new Error('SsoCallbackService: prisma is required');
    if (typeof audit !== 'function') throw new Error('SsoCallbackService: audit fn is required');
    if (!samlHandler || typeof samlHandler.verifySamlResponse !== 'function') {
      throw new Error('SsoCallbackService: samlHandler.verifySamlResponse is required');
    }
    if (!oidcHandler || typeof oidcHandler.verifyOidcCode !== 'function') {
      throw new Error('SsoCallbackService: oidcHandler.verifyOidcCode is required');
    }
    if (typeof resolveOrg !== 'function') throw new Error('SsoCallbackService: resolveOrg is required');
    if (typeof signSessionToken !== 'function') throw new Error('SsoCallbackService: signSessionToken is required');
    this.prisma = prisma;
    this.audit = audit;
    this.samlHandler = samlHandler;
    this.oidcHandler = oidcHandler;
    this.resolveOrg = resolveOrg;
    this.signSessionToken = signSessionToken;
    this.hashPassword = hashPassword || ((plain) => bcrypt.hash(plain, 12));
    this.now = now;
    this.logger = logger;
  }

  /** Single entrypoint used by the route. Translates the result of
   * the pipeline into `res.status(...).json(...)` calls so the
   * route stays free of business decisions. */
  async handle(req, res) {
    const org = await this.resolveOrg(req.params.orgSlug);
    if (!org) return res.status(404).json({ error: 'organization not found' });
    if (!org.ssoEnabled || !org.ssoConfig) {
      return res.status(400).json({ error: 'SSO is not enabled for this organization' });
    }

    const isOidc = (org.ssoConfig && org.ssoConfig.provider) === 'oidc';
    const { samlResponse, oidcCode } = this._extractInput(req, isOidc);
    const policy = this._resolvePolicy(org.ssoConfig);

    // Audit the *attempt* before verify runs so we have a record
    // even when the verify step throws / lib is missing.
    this._fireAudit(req, {
      action: 'sso_login_attempt',
      resource: 'organization',
      resourceId: org.id,
      metadata: {
        orgSlug: org.slug,
        method: isOidc ? 'oidc' : 'saml',
        hasResponse: isOidc ? !!oidcCode : !!samlResponse,
        policy,
      },
    });

    const verified = isOidc
      ? await this.oidcHandler.verifyOidcCode(oidcCode, org.ssoConfig)
      : await this.samlHandler.verifySamlResponse(samlResponse, org.ssoConfig);
    if (!verified.ok) {
      return res.status(verified.status || 401).json({
        ok: false,
        error: verified.error,
        hint: verified.hint || undefined,
        orgSlug: org.slug,
      });
    }

    try {
      const provisioned = await this._provisionUser({ verified, org, policy, req });
      if (provisioned.denied) {
        this._fireAudit(req, {
          action: 'sso_login_denied',
          resource: 'organization',
          resourceId: org.id,
          actorName: verified.email,
          metadata: { orgSlug: org.slug, policy, reason: provisioned.reason },
        });
        return res.status(403).json({
          ok: false,
          error: 'sso_provisioning_denied',
          hint: provisioned.hint,
          orgSlug: org.slug,
        });
      }
      const { user, createdUser, acceptedInvitationId } = provisioned;

      const ssoIdentityId = await this._linkSsoIdentity({ verified, user, org, isOidc });
      const { token } = await this._mintSession(user);

      this._fireAudit(req, {
        action: 'sso_login_success',
        resource: 'organization',
        resourceId: org.id,
        actorName: verified.email,
        metadata: {
          orgSlug: org.slug,
          userId: user.id,
          createdUser,
          method: isOidc ? 'oidc' : 'saml',
          policy,
          ssoIdentityId,
          invitationAccepted: acceptedInvitationId || undefined,
        },
      });

      return res.status(200).json({
        ok: true,
        token,
        user: { id: user.id, email: user.email, name: user.name },
        orgSlug: org.slug,
        createdUser,
        policy,
      });
    } catch (err) {
      this.logger.error?.(
        '[auth/sso] saml login failed:', err && err.message ? err.message : err
      );
      return res.status(500).json({ ok: false, error: 'sso_login_failed' });
    }
  }

  _extractInput(req, isOidc) {
    const samlResponse = !isOidc
      ? (req.body && (req.body.SAMLResponse || req.body.samlResponse)) || null
      : null;
    const oidcCode = isOidc
      ? (req.query && req.query.code)
          || (req.body && req.body.code)
          || null
      : null;
    return { samlResponse, oidcCode };
  }

  /** Three known policies (jit_create, jit_require_invite, manual);
   * anything else falls back to `jit_create` so a typo in the config
   * can never lock a tenant out. */
  _resolvePolicy(ssoConfig) {
    const raw = (ssoConfig && typeof ssoConfig.provisioning === 'string')
      ? ssoConfig.provisioning.toLowerCase()
      : 'jit_create';
    return ['jit_create', 'jit_require_invite', 'manual'].includes(raw) ? raw : 'jit_create';
  }

  /** Fire-and-forget audit — original code uses `void audit(...)`
   * so failures inside the audit util never break login. */
  _fireAudit(req, payload) {
    try { void this.audit(this.prisma, { req, ...payload }); }
    catch (_e) { /* never break the request on audit failure */ }
  }

  /** Find-or-create the local user matched by the asserted email,
   * gated by the org's provisioning policy. Returns either
   * `{denied:true, reason, hint}` or `{user, createdUser, acceptedInvitationId}`.
   */
  async _provisionUser({ verified, org, policy, req: _req }) {
    const db = this.prisma;
    let user = await db.user.findUnique({ where: { email: verified.email } });

    // Check pre-existing membership for the `manual` and invite policies.
    let isMember = false;
    if (user && db.orgMembership && typeof db.orgMembership.findUnique === 'function') {
      try {
        const m = await db.orgMembership.findUnique({
          where: { orgId_userId: { orgId: org.id, userId: user.id } },
        });
        isMember = !!m;
      } catch (_e) { /* non-fatal */ }
    }

    if (policy === 'manual' && !isMember) {
      return {
        denied: true,
        reason: 'not_a_member',
        hint: 'manual provisioning: user is not a member of this organization',
      };
    }

    let acceptedInvitationId = null;
    if (policy === 'jit_require_invite' && !isMember) {
      let pending = null;
      if (db.orgInvitation && typeof db.orgInvitation.findFirst === 'function') {
        try {
          pending = await db.orgInvitation.findFirst({
            where: {
              orgId: org.id,
              email: verified.email,
              acceptedAt: null,
              expiresAt: { gt: this.now() },
            },
          });
        } catch (_e) { /* non-fatal */ }
      }
      if (!pending) {
        return {
          denied: true,
          reason: 'no_pending_invite',
          hint: 'jit_require_invite: no pending invitation for this email',
        };
      }
      acceptedInvitationId = pending.id;
    }

    let createdUser = false;
    if (!user) {
      const randomPassword = `sso:${verified.email}:${Date.now()}:${Math.random()}`;
      user = await db.user.create({
        data: {
          name: verified.displayName || verified.email.split('@')[0],
          email: verified.email,
          // SSO users get an unguessable password they'll never use
          // (the SSO domain lock-out in /login bounces them back here).
          password: await this.hashPassword(randomPassword),
          plan: 'FREE',
          isAdmin: false,
          apiUsage: 0,
          monthlyCallLimit: 3,
          monthlyLimit: 10000,
        },
      });
      createdUser = true;
    }

    // Ensure they're a member (best-effort — orgMembership model
    // may not exist in every test harness).
    if (db.orgMembership && typeof db.orgMembership.upsert === 'function') {
      try {
        await db.orgMembership.upsert({
          where: { orgId_userId: { orgId: org.id, userId: user.id } },
          update: {},
          create: { orgId: org.id, userId: user.id, role: 'MEMBER' },
        });
      } catch (_e) { /* non-fatal */ }
    }

    // Mark the invitation accepted once membership is in place.
    if (acceptedInvitationId
      && db.orgInvitation && typeof db.orgInvitation.update === 'function') {
      try {
        await db.orgInvitation.update({
          where: { id: acceptedInvitationId },
          data: { acceptedAt: this.now() },
        });
      } catch (_e) { /* non-fatal */ }
    }

    return { user, createdUser, acceptedInvitationId };
  }

  /** Find-or-create SSOIdentity by (provider, externalId). External
   * id is `verified.nameId` (SAML nameID / OIDC sub) with a fallback
   * to email so we still get a row to update on subsequent logins.
   * All branches are best-effort — the identity link is metadata,
   * not gating. */
  async _linkSsoIdentity({ verified, user, org, isOidc }) {
    const db = this.prisma;
    const externalId = (verified.nameId && String(verified.nameId)) || verified.email;
    const providerKey = isOidc ? 'oidc' : 'saml';
    if (!db.sSOIdentity || typeof db.sSOIdentity.findUnique !== 'function') return null;
    try {
      const existing = await db.sSOIdentity.findUnique({
        where: { provider_externalId: { provider: providerKey, externalId } },
      });
      if (existing) {
        if (typeof db.sSOIdentity.update === 'function') {
          try {
            await db.sSOIdentity.update({
              where: { id: existing.id },
              data: { lastUsedAt: this.now() },
            });
          } catch (_e) { /* non-fatal */ }
        }
        return existing.id;
      }
      if (typeof db.sSOIdentity.create === 'function') {
        const row = await db.sSOIdentity.create({
          data: { userId: user.id, orgId: org.id, provider: providerKey, externalId },
        });
        return row && row.id ? row.id : null;
      }
    } catch (_e) { /* non-fatal — identity link is best-effort */ }
    return null;
  }

  async _mintSession(user) {
    const token = this.signSessionToken({
      userId: user.id,
      isAdmin: Boolean(user.isAdmin),
      isSuperAdmin: Boolean(user.isSuperAdmin),
    });
    const expiresAt = new Date(this.now().getTime() + 7 * 24 * 60 * 60 * 1000);
    if (this.prisma.session && typeof this.prisma.session.create === 'function') {
      try {
        await this.prisma.session.create({ data: { userId: user.id, token, expiresAt } });
      } catch (_e) { /* non-fatal in test harnesses */ }
    }
    return { token, expiresAt };
  }
}

module.exports = { SsoCallbackService };

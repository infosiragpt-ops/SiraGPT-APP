'use strict';

const {
  assertRbacSystemPrincipalMutable,
} = require('../services/rbac-system-assignments');

/**
 * UserRepository — single-responsibility data access for the `user`
 * table. Owns every prisma.user.* call that the auth flow uses and
 * applies the Accelerate retry policy uniformly so callers never deal
 * with P6008 / connection hiccups directly.
 *
 * SOLID notes:
 *  - SRP: only user persistence. No business rules, no encryption, no
 *    HTTP, no passport plumbing.
 *  - DIP: depends on a `prisma` instance and a `withRetry` callable
 *    passed in via the constructor — both can be swapped/mocked in
 *    tests without touching the file system, env vars or the real DB.
 *  - OCP: adding new lookup/update methods is additive; existing
 *    methods keep their contract.
 *
 * The methods intentionally return Prisma's native shapes so callers
 * (services) decide what to expose. Add explicit projection arguments
 * (`select`) when a caller needs less data.
 */

class UserRepository {
  /**
   * @param {object} deps
   * @param {import('@prisma/client').PrismaClient} deps.prisma
   * @param {<T>(fn: () => Promise<T>, opts?: object) => Promise<T>} deps.withRetry
   */
  constructor({ prisma, withRetry, rbacAssignments = null }) {
    if (!prisma) throw new Error('UserRepository: prisma is required');
    if (typeof withRetry !== 'function') {
      throw new Error('UserRepository: withRetry must be a function');
    }
    this.prisma = prisma;
    this.withRetry = withRetry;
    this.rbacAssignments = rbacAssignments;
  }

  _createUserWithRbac(data) {
    if (!this.rbacAssignments
        || typeof this.rbacAssignments.createLegacyAdminUser !== 'function') {
      const error = new Error('USER_REPOSITORY_RBAC_LIFECYCLE_REQUIRED');
      error.code = 'USER_REPOSITORY_RBAC_LIFECYCLE_REQUIRED';
      throw error;
    }
    return this.rbacAssignments.createLegacyAdminUser({ data });
  }

  findByEmail(email, { select } = {}) {
    return this.withRetry(
      () => this.prisma.user.findUnique({ where: { email }, ...(select ? { select } : {}) }),
      { label: 'user-repo.findByEmail' }
    );
  }

  findById(id, { select } = {}) {
    return this.withRetry(
      () => this.prisma.user.findUnique({ where: { id }, ...(select ? { select } : {}) }),
      { label: 'user-repo.findById' }
    );
  }

  updateGoogleIdentity(userId, { googleId, gmailTokens, googleServicesTokens }) {
    assertRbacSystemPrincipalMutable(userId);
    return this.withRetry(
      () => this.prisma.user.update({
        where: { id: userId },
        data: { googleId, gmailTokens, googleServicesTokens },
      }),
      { label: 'user-repo.updateGoogleIdentity' }
    );
  }

  clearGmailTokens(userId) {
    assertRbacSystemPrincipalMutable(userId);
    return this.withRetry(
      () => this.prisma.user.update({
        where: { id: userId },
        data: { gmailTokens: null },
      }),
      { label: 'user-repo.clearGmailTokens' }
    );
  }

  /**
   * Persist a sealed Gmail token blob. Callers MUST pass the
   * ciphertext from TokenVault.sealProviderTokens — this repo does
   * not encrypt. Pass `null` to disconnect (prefer `clearGmailTokens`
   * for that path to keep intent obvious at the call site).
   */
  updateGmailTokens(userId, sealedBlob) {
    assertRbacSystemPrincipalMutable(userId);
    return this.withRetry(
      () => this.prisma.user.update({
        where: { id: userId },
        data: { gmailTokens: sealedBlob },
        select: { id: true },
      }),
      { label: 'user-repo.updateGmailTokens' }
    );
  }

  /**
   * Persist a sealed Google Services (Calendar + Drive) token blob.
   * Same contract as `updateGmailTokens` — ciphertext only.
   */
  updateGoogleServicesTokens(userId, sealedBlob) {
    assertRbacSystemPrincipalMutable(userId);
    return this.withRetry(
      () => this.prisma.user.update({
        where: { id: userId },
        data: { googleServicesTokens: sealedBlob },
        select: { id: true },
      }),
      { label: 'user-repo.updateGoogleServicesTokens' }
    );
  }

  /**
   * Disconnect Google Services by nulling the token column. Parity
   * with `clearGmailTokens` so disconnect handlers look symmetric.
   */
  clearGoogleServicesTokens(userId) {
    assertRbacSystemPrincipalMutable(userId);
    return this.withRetry(
      () => this.prisma.user.update({
        where: { id: userId },
        data: { googleServicesTokens: null },
      }),
      { label: 'user-repo.clearGoogleServicesTokens' }
    );
  }

  /**
   * Create a password-backed account (email/password signup path).
   * Distinct from `createOAuthUser` because callers shouldn't have to
   * remember to null out the google fields, and the default plan
   * shape lives in one place.
   */
  createPasswordUser({
    name,
    email,
    passwordHash,
    plan = 'FREE',
    isAdmin = false,
    apiUsage = 0,
    monthlyCallLimit = 3,
    monthlyLimit = 10000,
  }) {
    return this.withRetry(
      () => this._createUserWithRbac({
          name,
          email,
          password: passwordHash,
          plan,
          isAdmin,
          isSuperAdmin: false,
          apiUsage,
          monthlyCallLimit,
          monthlyLimit,
      }),
      { label: 'user-repo.createPasswordUser' }
    );
  }

  /**
   * Rewrite the totpRecoveryCodes JSON column. Used after a recovery
   * code is consumed during 2FA verify. Returns only `{id}` since
   * callers don't need the full row.
   */
  updateRecoveryCodes(userId, totpRecoveryCodes) {
    assertRbacSystemPrincipalMutable(userId);
    return this.withRetry(
      () => this.prisma.user.update({
        where: { id: userId },
        data: { totpRecoveryCodes },
        select: { id: true },
      }),
      { label: 'user-repo.updateRecoveryCodes' }
    );
  }

  /**
   * Rewrite the webauthnCredentials JSON column after a successful
   * WebAuthn authentication so the signCount stays monotonic.
   */
  updateWebauthnCredentials(userId, webauthnCredentials) {
    assertRbacSystemPrincipalMutable(userId);
    return this.withRetry(
      () => this.prisma.user.update({
        where: { id: userId },
        data: { webauthnCredentials },
        select: { id: true },
      }),
      { label: 'user-repo.updateWebauthnCredentials' }
    );
  }

  createOAuthUser({
    googleId,
    name,
    email,
    avatar,
    passwordHash,
    gmailTokens,
    googleServicesTokens,
    plan = 'FREE',
    isAdmin = false,
    apiUsage = 0,
    monthlyCallLimit = 3,
    monthlyLimit = 10000,
  }) {
    return this.withRetry(
      () => this._createUserWithRbac({
          googleId,
          name,
          email,
          avatar,
          password: passwordHash,
          plan,
          isAdmin,
          isSuperAdmin: false,
          apiUsage,
          monthlyCallLimit,
          monthlyLimit,
          gmailTokens,
          googleServicesTokens,
      }),
      { label: 'user-repo.createOAuthUser' }
    );
  }
}

module.exports = { UserRepository };

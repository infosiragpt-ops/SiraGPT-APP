'use strict';

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
  constructor({ prisma, withRetry }) {
    if (!prisma) throw new Error('UserRepository: prisma is required');
    if (typeof withRetry !== 'function') {
      throw new Error('UserRepository: withRetry must be a function');
    }
    this.prisma = prisma;
    this.withRetry = withRetry;
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
    return this.withRetry(
      () => this.prisma.user.update({
        where: { id: userId },
        data: { googleId, gmailTokens, googleServicesTokens },
      }),
      { label: 'user-repo.updateGoogleIdentity' }
    );
  }

  clearGmailTokens(userId) {
    return this.withRetry(
      () => this.prisma.user.update({
        where: { id: userId },
        data: { gmailTokens: null },
      }),
      { label: 'user-repo.clearGmailTokens' }
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
      () => this.prisma.user.create({
        data: {
          googleId,
          name,
          email,
          avatar,
          password: passwordHash,
          plan,
          isAdmin,
          apiUsage,
          monthlyCallLimit,
          monthlyLimit,
          gmailTokens,
          googleServicesTokens,
        },
      }),
      { label: 'user-repo.createOAuthUser' }
    );
  }
}

module.exports = { UserRepository };

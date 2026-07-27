'use strict';

const {
  runAuthUserTransaction,
} = require('../services/auth/auth-user-lock');

/**
 * PartialSessionRepository — single-responsibility data access for the
 * `partial_sessions` table. A partial session is a short-lived token
 * minted after a successful password check when 2FA is required; the
 * 2FA verify handler looks it up, consumes it atomically, and only
 * then mints a full session JWT.
 *
 * Owned call sites:
 *   - mintPartialSession        → create
 *   - /2fa/totp/verify          → findByToken + consumeByToken
 *   - sweep-expired job         → countExpired + deleteExpired
 *
 * SOLID notes:
 *  - SRP: only partial-session persistence. No token generation, no
 *    TTL policy, no business validation.
 *  - DIP: prisma + withRetry are injected.
 *  - OCP: new queries (e.g. invalidateForUser) are additive and
 *    inherit the same retry + label convention.
 */

class PartialSessionRepository {
  /**
   * @param {object} deps
   * @param {import('@prisma/client').PrismaClient} deps.prisma
   * @param {<T>(fn: () => Promise<T>, opts?: object) => Promise<T>} deps.withRetry
   * @param {Console} [deps.logger]
   */
  constructor({ prisma, withRetry, logger = console }) {
    if (!prisma) throw new Error('PartialSessionRepository: prisma is required');
    if (typeof withRetry !== 'function') {
      throw new Error('PartialSessionRepository: withRetry must be a function');
    }
    this.prisma = prisma;
    this.withRetry = withRetry;
    this.logger = logger;
  }

  /**
   * Persist a freshly minted partial-session row. Caller owns the
   * token bytes + TTL — this repo only writes.
   */
  create({ token, userId, expiresAt }) {
    return this.withRetry(
      () => {
        const data = { token, userId, expiresAt };
        const supportsAuthTransaction = (
          typeof this.prisma.$transaction === 'function'
          && typeof this.prisma.$queryRawUnsafe === 'function'
          && typeof this.prisma.user?.findUnique === 'function'
        );
        if (!supportsAuthTransaction) {
          return this.prisma.partialSession.create({ data });
        }
        return runAuthUserTransaction(
          this.prisma,
          userId,
          (tx) => tx.partialSession.create({ data }),
        );
      },
      { label: 'partial-session-repo.create' }
    );
  }

  /**
   * Read a row by its unique token. Returns the raw Prisma shape
   * (id, token, userId, expiresAt, consumedAt, createdAt) or null.
   * Callers do their own expiry / consumed checks because the policy
   * (404 vs 409 vs 410) is route-specific.
   */
  findByToken(token) {
    return this.withRetry(
      () => this.prisma.partialSession.findUnique({ where: { token } }),
      { label: 'partial-session-repo.findByToken' }
    );
  }

  /**
   * Atomically mark the row consumed. Uses `updateMany` with a
   * `consumedAt: null` predicate so a concurrent verify cannot
   * double-spend — at most one caller observes count === 1.
   * Returns the Prisma BatchPayload ({ count }).
   */
  consumeByToken(token, { now = new Date() } = {}) {
    return this.withRetry(
      () => this.prisma.partialSession.updateMany({
        where: { token, consumedAt: null },
        data: { consumedAt: now },
      }),
      { label: 'partial-session-repo.consumeByToken' }
    );
  }

  /**
   * Count rows matching an arbitrary `where`. Used by the sweep job
   * in dry-run mode to report how many rows WOULD be deleted.
   */
  count(where) {
    return this.withRetry(
      () => this.prisma.partialSession.count({ where }),
      { label: 'partial-session-repo.count' }
    );
  }

  /**
   * Bulk delete rows matching an arbitrary `where`. Used by the
   * sweep job to purge expired / consumed rows past their grace
   * window. Returns the Prisma BatchPayload ({ count }).
   */
  deleteMany(where) {
    return this.withRetry(
      () => this.prisma.partialSession.deleteMany({ where }),
      { label: 'partial-session-repo.deleteMany' }
    );
  }
}

module.exports = { PartialSessionRepository };

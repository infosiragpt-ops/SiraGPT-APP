'use strict';

const {
  runAuthUserTransaction,
} = require('../services/auth/auth-user-lock');
const {
  createSessionRecord,
  deleteOtherSessionsForUser,
  deleteSessionsByPresentedToken,
  rotateSessionByPresentedToken,
} = require('../services/auth/session-token-persistence');

/**
 * SessionRepository — single-responsibility data access for the
 * `session` table. Owns every prisma.session.* call used by the auth
 * flow (Google callback, signup, login, logout, refresh) and applies
 * two cross-cutting concerns uniformly so callers don't repeat them:
 *
 *   1. Accelerate retry policy via the injected `withRetry`.
 *   2. The "fingerprint column may not exist yet" fallback that lived
 *      duplicated inside the login + refresh handlers — the
 *      `fingerprint` field was introduced in cycle 17 and older
 *      deployments without the column would throw on the first write.
 *      Centralising the fallback here means new session call sites
 *      get it for free.
 *
 * SOLID notes:
 *  - SRP: only session persistence. No JWT signing, no HTTP, no
 *    fingerprint computation (callers still own *what* the
 *    fingerprint is — this class only forwards it).
 *  - DIP: prisma + withRetry are injected.
 *  - OCP: adding a new query (e.g. list-by-user, prune-expired) is
 *    additive and inherits both retry + logging conventions.
 */

class SessionRepository {
  /**
   * @param {object} deps
   * @param {import('@prisma/client').PrismaClient} deps.prisma
   * @param {<T>(fn: () => Promise<T>, opts?: object) => Promise<T>} deps.withRetry
   * @param {Console} [deps.logger]
   */
  constructor({ prisma, withRetry, logger = console, env = process.env }) {
    if (!prisma) throw new Error('SessionRepository: prisma is required');
    if (typeof withRetry !== 'function') {
      throw new Error('SessionRepository: withRetry must be a function');
    }
    this.prisma = prisma;
    this.withRetry = withRetry;
    this.logger = logger;
    this.env = env;
  }

  /**
   * Internal: true when a Prisma error string mentions the
   * `fingerprint` column. Used to retry without the column on
   * environments where the schema hasn't been migrated yet.
   */
  static _isFingerprintColumnMissing(err) {
    return Boolean(err && /fingerprint/i.test(String(err.message)));
  }

  /**
   * Create a session. `fingerprint` is optional — when supplied we
   * attempt the write with it and retry without it if the column is
   * missing (legacy schema). Any other error propagates unchanged.
   */
  async create({ userId, token, expiresAt, fingerprint }) {
    const baseData = { userId, token, expiresAt };
    const dataWithFp = fingerprint != null ? { ...baseData, fingerprint } : baseData;
    const supportsAuthTransaction = (
      typeof this.prisma.$transaction === 'function'
      && typeof this.prisma.$queryRawUnsafe === 'function'
      && typeof this.prisma.user?.findUnique === 'function'
    );
    const createForActiveUser = (data) => {
      if (!supportsAuthTransaction) {
        // Narrow unit-test doubles and legacy repository consumers may expose
        // only `session.create`. The production Prisma client always takes the
        // serialized active-user transaction path above.
        return createSessionRecord(this.prisma, data, { env: this.env });
      }
      return runAuthUserTransaction(
        this.prisma,
        userId,
        (tx) => createSessionRecord(tx, data, { env: this.env }),
      );
    };

    return this.withRetry(async () => {
      try {
        return await createForActiveUser(dataWithFp);
      } catch (err) {
        if (fingerprint != null && SessionRepository._isFingerprintColumnMissing(err)) {
          this.logger.warn?.(
            '[session-repo] fingerprint column missing on create; retrying without it'
          );
          return createForActiveUser(baseData);
        }
        throw err;
      }
    }, { label: 'session-repo.create' });
  }

  /**
   * Delete all sessions for a given token. Returns the Prisma
   * `Payload<count>` shape from deleteMany. Used by logout — using
   * `deleteMany` instead of `delete` keeps it idempotent if the row
   * is already gone (e.g. concurrent logout).
   */
  deleteByToken(token) {
    return this.withRetry(
      () => deleteSessionsByPresentedToken(this.prisma, token),
      { label: 'session-repo.deleteByToken' }
    );
  }

  /**
   * Revoke the complete session family for a user. Authentication paths use
   * this when an account is found soft-deleted so another still-valid token
   * cannot keep the account active.
   */
  deleteAllForUser(userId) {
    return this.withRetry(
      () => this.prisma.session.deleteMany({ where: { userId } }),
      { label: 'session-repo.deleteAllForUser' }
    );
  }

  /**
   * Fetch a single session row by id. Optional `select` projection
   * is forwarded to Prisma so callers can avoid pulling the full
   * token on the listing/management path.
   */
  findById(id, { select } = {}) {
    return this.withRetry(
      () => this.prisma.session.findUnique({ where: { id }, ...(select ? { select } : {}) }),
      { label: 'session-repo.findById' }
    );
  }

  /**
   * Paginated list of active sessions for a user. The shape
   * (createdAt ordering, select projection, expiresAt > now filter)
   * mirrors what the management UI currently asks for; future
   * variants should be additive methods, not arguments here.
   */
  findActiveByUserPaged({ userId, now, page = 1, limit = 20 }) {
    const where = { userId, expiresAt: { gt: now } };
    return this.withRetry(
      () => this.prisma.session.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: { id: true, token: true, createdAt: true, expiresAt: true },
      }),
      { label: 'session-repo.findActiveByUserPaged' }
    );
  }

  /**
   * Count active sessions for a user. Returns `null` when the
   * Prisma client doesn't expose count() (some narrow test mocks),
   * matching the legacy handler behavior.
   */
  countActiveByUser({ userId, now }) {
    if (typeof this.prisma.session.count !== 'function') return Promise.resolve(null);
    return this.withRetry(
      () => this.prisma.session.count({ where: { userId, expiresAt: { gt: now } } }),
      { label: 'session-repo.countActiveByUser' }
    );
  }

  /**
   * Delete a single session by id. Throws if the row doesn't exist —
   * callers must check ownership first (see `findById`).
   */
  deleteById(id) {
    return this.withRetry(
      () => this.prisma.session.delete({ where: { id } }),
      { label: 'session-repo.deleteById' }
    );
  }

  /**
   * Revoke every active session for a user except the one bound to
   * `keepToken`. Returns the Prisma `deleteMany` payload so callers
   * can read `.count`.
   */
  deleteAllForUserExceptToken(userId, keepToken) {
    return this.withRetry(
      () => deleteOtherSessionsForUser(this.prisma, userId, keepToken),
      { label: 'session-repo.deleteAllForUserExceptToken' }
    );
  }

  /**
   * Rotate a session row by old token. Updates token + expiry, and
   * re-binds the fingerprint when supplied. Same fingerprint-column
   * fallback as `create`.
   */
  async updateByToken(oldToken, { newToken, expiresAt, fingerprint }) {
    const baseData = { token: newToken, expiresAt };
    const dataWithFp = fingerprint != null ? { ...baseData, fingerprint } : baseData;

    return this.withRetry(async () => {
      try {
        return await rotateSessionByPresentedToken(
          this.prisma,
          oldToken,
          dataWithFp,
          { env: this.env },
        );
      } catch (err) {
        if (fingerprint != null && SessionRepository._isFingerprintColumnMissing(err)) {
          this.logger.warn?.(
            '[session-repo] fingerprint column missing on update; retrying without it'
          );
          return rotateSessionByPresentedToken(
            this.prisma,
            oldToken,
            baseData,
            { env: this.env },
          );
        }
        throw err;
      }
    }, { label: 'session-repo.updateByToken' });
  }
}

module.exports = { SessionRepository };

'use strict';

/**
 * SessionRepository — single-responsibility data access for the
 * `session` table. Currently exposes only the create() path used by
 * the Google OAuth callback (iteration 1); other session ops in
 * routes/auth.js (delete on logout, update on refresh, fingerprint
 * fallback) move here in iteration 2.
 *
 * SOLID notes mirror UserRepository: SRP (only session rows), DIP
 * (prisma + withRetry injected), OCP (new methods are additive).
 */

class SessionRepository {
  /**
   * @param {object} deps
   * @param {import('@prisma/client').PrismaClient} deps.prisma
   * @param {<T>(fn: () => Promise<T>, opts?: object) => Promise<T>} deps.withRetry
   */
  constructor({ prisma, withRetry }) {
    if (!prisma) throw new Error('SessionRepository: prisma is required');
    if (typeof withRetry !== 'function') {
      throw new Error('SessionRepository: withRetry must be a function');
    }
    this.prisma = prisma;
    this.withRetry = withRetry;
  }

  /**
   * Create a new session row. `fingerprint` is optional — the schema
   * permits null, and the calling code already has a fingerprint
   * fallback path for environments where it fails to compute.
   */
  create({ userId, token, expiresAt, fingerprint }) {
    const data = { userId, token, expiresAt };
    if (fingerprint != null) data.fingerprint = fingerprint;
    return this.withRetry(
      () => this.prisma.session.create({ data }),
      { label: 'session-repo.create' }
    );
  }
}

module.exports = { SessionRepository };

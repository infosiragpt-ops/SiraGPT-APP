'use strict';

/**
 * AuditLogRepository — single-responsibility data access for the
 * `AuditLog` table. The audit log is fire-and-forget by policy:
 * write failures must NEVER break the wrapping request, and reads
 * are best-effort enrichment that degrade silently when the model
 * is unavailable (e.g. narrow test mocks).
 *
 * Owned call sites:
 *   - writeAuditLog util         → safeCreate
 *   - /auth/sessions enrichment  → findRecentForActor
 *
 * SOLID notes:
 *  - SRP: only AuditLog persistence. The richer mapping logic
 *    (actor inference, ip/ua extraction, tag normalisation) stays
 *    in `utils/audit-log.js` — this repo just persists the final
 *    row.
 *  - DIP: prisma + withRetry are injected; absent models surface
 *    as `null` returns, not thrown errors, because the audit
 *    contract is "best effort".
 *  - LSP: every method returns either the raw Prisma shape or a
 *    documented `null` / `[]` — callers never need try/catch.
 */

class AuditLogRepository {
  /**
   * @param {object} deps
   * @param {import('@prisma/client').PrismaClient} deps.prisma
   * @param {<T>(fn: () => Promise<T>, opts?: object) => Promise<T>} deps.withRetry
   * @param {Console} [deps.logger]
   */
  constructor({ prisma, withRetry, logger = console }) {
    if (!prisma) throw new Error('AuditLogRepository: prisma is required');
    if (typeof withRetry !== 'function') {
      throw new Error('AuditLogRepository: withRetry must be a function');
    }
    this.prisma = prisma;
    this.withRetry = withRetry;
    this.logger = logger;
  }

  /**
   * True when the configured Prisma client exposes the AuditLog
   * model. Narrow test mocks omit it deliberately, so every public
   * method guards on this and returns the documented fallback.
   */
  _modelAvailable() {
    return Boolean(
      this.prisma &&
      this.prisma.auditLog &&
      typeof this.prisma.auditLog.create === 'function'
    );
  }

  /**
   * Persist an audit row, swallowing any error. Returns the created
   * row on success, `null` on missing model or write failure. The
   * caller is responsible for shaping `data` to match the Prisma
   * AuditLog schema — this repo does NOT do field mapping (that
   * lives in `utils/audit-log.js`).
   */
  async safeCreate(data) {
    if (!this._modelAvailable()) return null;
    try {
      return await this.withRetry(
        () => this.prisma.auditLog.create({ data }),
        { label: 'audit-log-repo.safeCreate' }
      );
    } catch (err) {
      this.logger.error?.(
        '[AUDIT] write failed:', err?.message || err, 'action=', data?.action
      );
      return null;
    }
  }

  /**
   * Fetch the most recent audit rows for a given actor, optionally
   * filtered by action. Used by /auth/sessions to attribute ip/ua to
   * each session by createdAt proximity. Returns `[]` on missing
   * model or read failure — enrichment must never break the request.
   *
   * @param {{ actorId: string, actions?: string[], take?: number, select?: object }} args
   */
  async findRecentForActor({ actorId, actions, take = 50, select }) {
    if (!this.prisma?.auditLog || typeof this.prisma.auditLog.findMany !== 'function') {
      return [];
    }
    const where = { actorId };
    if (Array.isArray(actions) && actions.length) where.action = { in: actions };
    try {
      return await this.withRetry(
        () => this.prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take,
          ...(select ? { select } : {}),
        }),
        { label: 'audit-log-repo.findRecentForActor' }
      );
    } catch (_) {
      return [];
    }
  }
}

module.exports = { AuditLogRepository };

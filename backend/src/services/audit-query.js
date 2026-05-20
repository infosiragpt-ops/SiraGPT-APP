'use strict';

/**
 * audit-query — composable query DSL over the `AuditLog` Prisma model.
 *
 * The existing helper in `utils/audit-log.js` only knows how to WRITE
 * audit rows. This module is the READ side: a small, chainable builder
 * so admin endpoints, CLI tools, and tests can express things like:
 *
 *   query(prisma)
 *     .byUser('usr_123')
 *     .byAction('grant_credits')
 *     .byDate(new Date('2026-01-01'), new Date('2026-12-31'))
 *     .limit(50)
 *     .run()
 *
 * Design rules:
 *   1. **Pure builder** — every chain method returns a new instance so
 *      the same base query can be branched without aliasing.
 *   2. **No throws on null prisma** — we degrade to `{ items: [] }` so
 *      tests that mock prisma narrowly don't blow up.
 *   3. **Safe input coercion** — bad inputs become no-ops, not 500s.
 */

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function toPositiveInt(v, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

class AuditQuery {
  /**
   * @param {{ auditLog: { findMany: Function, count?: Function } } | null} prisma
   * @param {object} [state]
   */
  constructor(prisma, state = {}) {
    this._prisma = prisma || null;
    this._state = {
      userId: state.userId ?? null,
      action: state.action ?? null,
      resourceType: state.resourceType ?? null,
      resourceId: state.resourceId ?? null,
      orgId: state.orgId ?? null,
      actorType: state.actorType ?? null,
      from: state.from ?? null,
      to: state.to ?? null,
      limit: state.limit ?? DEFAULT_LIMIT,
      page: state.page ?? 1,
      order: state.order ?? 'desc',
    };
  }

  _clone(patch) {
    return new AuditQuery(this._prisma, { ...this._state, ...patch });
  }

  byUser(userId) {
    if (!userId || typeof userId !== 'string') return this;
    return this._clone({ userId });
  }

  byAction(action) {
    if (!action || typeof action !== 'string') return this;
    return this._clone({ action });
  }

  byResource(resourceType, resourceId = null) {
    if (!resourceType || typeof resourceType !== 'string') return this;
    return this._clone({
      resourceType,
      resourceId: resourceId && typeof resourceId === 'string' ? resourceId : null,
    });
  }

  /**
   * Filter by organisation id. The `AuditLog` model has no dedicated
   * `orgId` column today — writers stash it inside the JSON `metadata`
   * payload (see `utils/audit-log.js`). We therefore translate the
   * filter into a Prisma JSON predicate: `metadata: { path: ['orgId'],
   * equals: <id> }`. Returns a no-op for falsy / non-string input so
   * callers can chain `byOrg(req.query.orgId)` without pre-validating.
   */
  byOrg(orgId) {
    if (!orgId || typeof orgId !== 'string') return this;
    return this._clone({ orgId });
  }

  /**
   * Filter to rows produced by a specific API key. Audit writers tag
   * api-key activity with `actorType='api_key'` and `resourceId=<keyId>`
   * (see Cycle 66). This helper composes both predicates so callers can
   * write `query(prisma).byApiKey(keyId).run()` without remembering the
   * tagging convention. Returns a no-op for falsy / non-string input.
   *
   * Note: this overrides any previously-set `actorType` and `resourceId`.
   */
  byApiKey(keyId) {
    if (!keyId || typeof keyId !== 'string') return this;
    return this._clone({ actorType: 'api_key', resourceId: keyId });
  }

  byDate(from, to) {
    const f = toDate(from);
    const t = toDate(to);
    if (!f && !t) return this;
    return this._clone({ from: f, to: t });
  }

  limit(n) {
    const v = Math.min(MAX_LIMIT, toPositiveInt(n, DEFAULT_LIMIT) || DEFAULT_LIMIT);
    return this._clone({ limit: v });
  }

  page(n) {
    const v = Math.max(1, toPositiveInt(n, 1));
    return this._clone({ page: v });
  }

  order(dir) {
    return this._clone({ order: dir === 'asc' ? 'asc' : 'desc' });
  }

  /** Build the Prisma `where` clause from current state. */
  toWhere() {
    const where = {};
    const s = this._state;
    if (s.userId) where.actorId = s.userId;
    if (s.actorType) where.actorType = s.actorType;
    if (s.action) where.action = s.action;
    if (s.resourceType) where.resourceType = s.resourceType;
    if (s.resourceId) where.resourceId = s.resourceId;
    if (s.orgId) {
      // metadata is `Json?` — Prisma JSON path filter. The writer stores
      // `metadata.orgId` as a plain string, so `equals` is the correct
      // operator. We keep this isolated under `where.metadata` so it
      // composes with any future JSON predicates added by callers.
      where.metadata = { path: ['orgId'], equals: s.orgId };
    }
    if (s.from || s.to) {
      where.createdAt = {};
      if (s.from) where.createdAt.gte = s.from;
      if (s.to) where.createdAt.lte = s.to;
    }
    return where;
  }

  /** Plain object snapshot (mainly for tests / logging). */
  toJSON() {
    return { ...this._state, where: this.toWhere() };
  }

  /**
   * Execute the query and return `{ items, total, page, pages, limit }`.
   * `pages` is the total number of pages (ceil(total/limit), min 1) so
   * the admin UI can render a pager without a second round-trip.
   * If the prisma client doesn't have an auditLog model, returns an
   * empty result instead of throwing.
   */
  async run() {
    const limit = this._state.limit;
    const page = this._state.page;
    if (
      !this._prisma ||
      !this._prisma.auditLog ||
      typeof this._prisma.auditLog.findMany !== 'function'
    ) {
      return { items: [], total: 0, page, pages: 1, limit };
    }
    const where = this.toWhere();
    const skip = (page - 1) * limit;
    try {
      const [items, total] = await Promise.all([
        this._prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: this._state.order },
          skip,
          take: limit,
        }),
        typeof this._prisma.auditLog.count === 'function'
          ? this._prisma.auditLog.count({ where })
          : Promise.resolve(null),
      ]);
      const safeTotal = typeof total === 'number' ? total : items.length;
      const pages = limit > 0 ? Math.max(1, Math.ceil(safeTotal / limit)) : 1;
      return {
        items,
        total: safeTotal,
        page,
        pages,
        limit,
      };
    } catch (err) {
      // Read failures must not 500 the entire admin dashboard.
      // eslint-disable-next-line no-console
      console.error('[audit-query] run failed:', err?.message || err);
      return { items: [], total: 0, page, pages: 1, limit, error: 'query_failed' };
    }
  }
}

/** Entry point: `query(prisma).byUser(...).run()`. */
function query(prisma) {
  return new AuditQuery(prisma);
}

module.exports = { query, AuditQuery };

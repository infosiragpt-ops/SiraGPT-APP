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
      tags: Array.isArray(state.tags) ? state.tags.slice() : null,
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

  /**
   * Filter rows whose `metadata.tags` array contains ANY of the provided
   * tags (logical OR). Writers commonly stash classification labels into
   * `metadata.tags` (e.g. `['security','login']`, `['billing','refund']`)
   * so operators can slice the audit feed by topic without inventing new
   * resourceType values. Bad input (non-array, empty, non-strings) is a
   * no-op so callers can pipe `?tags=...` directly into the builder.
   *
   * The Prisma JSON `array_contains` predicate matches when the stored
   * JSON array contains the supplied element. Postgres' jsonb backend
   * accepts either a scalar or an array argument for membership; we emit
   * one predicate per tag and OR them together so any-match semantics
   * hold even when the metadata column is null (the predicate simply
   * fails to match instead of throwing).
   */
  byTags(tags) {
    if (!Array.isArray(tags)) return this;
    const clean = tags
      .filter((t) => typeof t === 'string')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (clean.length === 0) return this;
    // Dedupe while preserving order so the generated where clause is
    // stable across repeated calls with equivalent inputs.
    const seen = new Set();
    const deduped = [];
    for (const t of clean) {
      if (!seen.has(t)) {
        seen.add(t);
        deduped.push(t);
      }
    }
    return this._clone({ tags: deduped });
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
    // metadata is `Json?` — multiple JSON-path predicates may need to be
    // emitted simultaneously (orgId equality + tags OR-match). Prisma
    // doesn't accept two top-level `metadata:` filters in the same
    // object, so we accumulate them under an `AND:` array. The single
    // predicate case is left flat so existing tests / consumers that
    // inspect `where.metadata` directly keep working.
    const metaPredicates = [];
    if (s.orgId) {
      metaPredicates.push({ metadata: { path: ['orgId'], equals: s.orgId } });
    }
    if (Array.isArray(s.tags) && s.tags.length > 0) {
      // `array_contains` is the Postgres jsonb membership operator. We
      // emit one predicate per tag and OR them so any-match semantics
      // hold (a row with tags=['security','login'] matches ?tags=login,
      // ?tags=security, and ?tags=security,login). Empty/null metadata
      // simply fails to match.
      const tagPreds = s.tags.map((t) => ({
        metadata: { path: ['tags'], array_contains: [t] },
      }));
      metaPredicates.push(tagPreds.length === 1 ? tagPreds[0] : { OR: tagPreds });
    }
    if (metaPredicates.length === 1) {
      // Preserve the historical flat shape (`where.metadata = {...}`) so
      // older tests that assert on `where.metadata` directly still pass.
      const only = metaPredicates[0];
      if (only.metadata) where.metadata = only.metadata;
      else where.AND = [only];
    } else if (metaPredicates.length > 1) {
      where.AND = metaPredicates;
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

// ── Ratchet 44 — free-text search ─────────────────────────────────────
// Postgres-only helper. We ILIKE the `action` column (a short verb like
// `grant_credits`) and cast the `metadata` jsonb to text so callers can
// hit any nested value (e.g. an email buried four levels down) without
// listing every path. The query is parameterised — `$1` is the LIKE
// pattern, `$2/$3` are limit/offset — so the operator-supplied `q` can't
// inject SQL.
//
// Ranking is unranked-newest-first (`createdAt DESC`) which matches the
// rest of the audit UI; if we ever want true relevance ranking we can
// switch to `ts_rank` over a stored `tsvector` column.
const SEARCH_LIMIT_DEFAULT = 50;
const SEARCH_LIMIT_MAX = 200;

function clampSearchLimit(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return SEARCH_LIMIT_DEFAULT;
  return Math.min(SEARCH_LIMIT_MAX, n);
}

function clampSearchPage(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

// Escape Postgres ILIKE metacharacters so a `q` containing `%` or `_`
// doesn't widen the match unintentionally. Backslash itself is escaped
// because we don't use a custom ESCAPE clause.
function escapeLikePattern(raw) {
  return String(raw).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Free-text search over AuditLog. Returns the same shape as
 * `AuditQuery.run()` — `{ items, total, page, pages, limit }`. Degrades
 * to an empty result when prisma is missing or `$queryRawUnsafe` /
 * `$queryRaw` aren't available (tests, sqlite fallback).
 *
 * @param {*} prisma  Prisma client (or stub)
 * @param {string} q  Search text (already validated non-empty by caller)
 * @param {{limit?: number, page?: number}} [opts]
 */
async function search(prisma, q, opts = {}) {
  const limit = clampSearchLimit(opts.limit);
  const page = clampSearchPage(opts.page);
  const offset = (page - 1) * limit;
  const empty = { items: [], total: 0, page, pages: 1, limit };

  if (!prisma || typeof q !== 'string' || q.trim().length === 0) return empty;
  if (typeof prisma.$queryRawUnsafe !== 'function') return empty;

  const pattern = `%${escapeLikePattern(q.trim())}%`;
  try {
    // We use `$queryRawUnsafe` with explicit positional parameters so the
    // SQL string itself is static (no interpolation of user input). The
    // table name `AuditLog` is the Prisma default; if a deployment renames
    // it, this query needs to be updated in lockstep.
    const itemsSql =
      'SELECT * FROM "AuditLog" '
      + 'WHERE "action" ILIKE $1 OR ("metadata")::text ILIKE $1 '
      + 'ORDER BY "createdAt" DESC '
      + 'LIMIT $2 OFFSET $3';
    const countSql =
      'SELECT COUNT(*)::int AS count FROM "AuditLog" '
      + 'WHERE "action" ILIKE $1 OR ("metadata")::text ILIKE $1';

    const [items, countRows] = await Promise.all([
      prisma.$queryRawUnsafe(itemsSql, pattern, limit, offset),
      prisma.$queryRawUnsafe(countSql, pattern),
    ]);

    const total =
      Array.isArray(countRows) && countRows[0] && typeof countRows[0].count === 'number'
        ? countRows[0].count
        : Array.isArray(items) ? items.length : 0;
    const pages = limit > 0 ? Math.max(1, Math.ceil(total / limit)) : 1;
    return {
      items: Array.isArray(items) ? items : [],
      total,
      page,
      pages,
      limit,
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[audit-query] search failed:', err?.message || err);
    return { ...empty, error: 'search_failed' };
  }
}

module.exports = {
  query,
  AuditQuery,
  search,
  // Exported for tests + reuse:
  escapeLikePattern,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
};

'use strict';

/**
 * ai-model-catalog — serving layer for the picker catalog (`GET /api/ai/models`).
 *
 * Why this exists
 * ---------------
 * Every time the user picks Imágenes / Voz / Video / Música in the composer,
 * the front-end asks for the active rows of that type with
 * `Cache-Control: no-cache` (an admin activation must show up immediately).
 * Before this module the route answered each of those reads by re-running the
 * static-catalog sync (one UPDATE per manifest model: 51 for VIDEO) and then a
 * fresh `findMany`, so the picker paid ~60 sequential DB round-trips per click.
 *
 * Design
 * ------
 *   - One in-memory snapshot per picker scope (VIDEO / AUDIO / MUSIC /
 *     TEXT+IMAGE / ALL) holding the raw `findMany` rows, with a short TTL.
 *   - Single-flight: concurrent identical reads (the composer and the chat
 *     context both fire on activation) share one DB query.
 *   - Explicit invalidation from every write path (Admin → Modelos IA,
 *     connections sync, scheduled sync, static-catalog sync that changed
 *     rows), so freshness does not depend on the TTL.
 *   - The client's `no-cache` is NOT honoured here on purpose: it exists to
 *     skip the non-invalidated HTTP response cache, and this snapshot is
 *     invalidated by every write path in the process. Kill switch:
 *     `SIRAGPT_AI_MODEL_CATALOG_CACHE_DISABLED=1`.
 *   - Rows are handed out as shallow copies so per-request curation never
 *     mutates the shared snapshot.
 *
 * Per-user work (plan gating, default/fallback flags, connection readiness)
 * stays in the route: it is pure CPU over ≤100 rows.
 */

const { invalidate: invalidateResponseCache } = require('../middleware/response-cache');

const DEFAULT_TTL_MS = 60_000;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 60 * 60_000;

const MEDIA_TYPES = Object.freeze(['IMAGE', 'VIDEO', 'AUDIO', 'MUSIC']);
const PICKER_TYPES = Object.freeze(['TEXT', ...MEDIA_TYPES]);

// Columns the picker needs. Kept identical to the historical route select so
// the public payload does not change.
const PICKER_SELECT = Object.freeze({
  id: true,
  name: true,
  displayName: true,
  provider: true,
  description: true,
  type: true,
  icon: true,
  isActive: true,
  contextLength: true,
});

function resolveTtlMs(env = process.env, override) {
  const raw = Number.isFinite(override) ? override : Number.parseInt(String(env.SIRAGPT_AI_MODEL_CATALOG_TTL_MS || ''), 10);
  if (!Number.isFinite(raw)) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, raw));
}

function isSnapshotDisabled(env = process.env) {
  return /^(1|true|on|yes)$/i.test(String(env.SIRAGPT_AI_MODEL_CATALOG_CACHE_DISABLED || '').trim());
}

/**
 * Normalise the public `type` query into the Prisma where-clause the picker
 * has always used. VOICE is a UI alias (the Voz chip lists the Admin-active
 * AUDIO/TTS rows); TEXT and IMAGE share one scope because legacy rows of
 * either type are curated in JS afterwards.
 */
function buildPickerWhereClause(type) {
  const normalized = String(type || '').trim().toUpperCase();
  const whereClause = { isActive: true };
  if (!normalized) return whereClause;
  if (normalized === 'VOICE') {
    whereClause.type = 'AUDIO';
  } else if (normalized === 'TEXT' || normalized === 'IMAGE') {
    whereClause.type = { in: ['TEXT', 'IMAGE'] };
  } else {
    whereClause.type = normalized;
  }
  return whereClause;
}

/** Snapshot key: one entry per distinct where-clause, not per alias. */
function pickerScopeKey(type) {
  const normalized = String(type || '').trim().toUpperCase();
  if (!normalized) return 'ALL';
  if (normalized === 'VOICE') return 'AUDIO';
  if (normalized === 'TEXT' || normalized === 'IMAGE') return 'TEXT_IMAGE';
  return normalized;
}

class AiModelCatalogSnapshot {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.env = options.env || process.env;
    this.ttlOverride = options.ttlMs;
    this.entries = new Map(); // key -> { rows, storedAt, expiresAt }
    this.flights = new Map(); // key -> Promise<rows>
    // Bumped on every invalidation. A load only stores its rows when the
    // generation it started in is still current, so a read that began before
    // a write can never repopulate the snapshot with pre-write rows.
    this.generation = 0;
    this.stats = { hits: 0, misses: 0, coalesced: 0, invalidations: 0, loads: 0, errors: 0 };
  }

  get ttlMs() {
    return resolveTtlMs(this.env, this.ttlOverride);
  }

  get disabled() {
    return isSnapshotDisabled(this.env);
  }

  /**
   * Return the cached rows for `key`, loading them through `loader` on a
   * miss. Concurrent callers of the same key share the in-flight load.
   * Failures are never memoised: the next call re-runs the loader.
   */
  async get(key, loader, options = {}) {
    if (typeof loader !== 'function') throw new TypeError('loader must be a function');
    const scope = String(key || 'ALL');
    const bypass = options.bypass === true || this.disabled;

    if (!bypass) {
      const entry = this.entries.get(scope);
      if (entry && entry.expiresAt > this.now()) {
        this.stats.hits += 1;
        return entry.rows;
      }
      const inFlight = this.flights.get(scope);
      if (inFlight) {
        this.stats.coalesced += 1;
        return inFlight;
      }
    }

    this.stats.misses += 1;
    const startedGeneration = this.generation;
    const flight = Promise.resolve()
      .then(() => loader())
      .then((rows) => {
        const list = Array.isArray(rows) ? rows : [];
        this.stats.loads += 1;
        if (!bypass && startedGeneration === this.generation) {
          const storedAt = this.now();
          this.entries.set(scope, { rows: list, storedAt, expiresAt: storedAt + this.ttlMs });
        }
        return list;
      })
      .catch((error) => {
        this.stats.errors += 1;
        throw error;
      })
      .finally(() => {
        if (this.flights.get(scope) === flight) this.flights.delete(scope);
      });

    if (!bypass) this.flights.set(scope, flight);
    return flight;
  }

  /**
   * Drop one scope, or every scope when `key` is omitted. Loads already in
   * flight still resolve for their callers but are not stored (generation
   * check in `get`), and are detached so later readers start a fresh load.
   */
  invalidate(key) {
    this.stats.invalidations += 1;
    this.generation += 1;
    if (key === undefined || key === null) {
      const removed = this.entries.size;
      this.entries.clear();
      this.flights.clear();
      return removed;
    }
    const scope = String(key);
    const removed = this.entries.delete(scope) ? 1 : 0;
    this.flights.delete(scope);
    return removed;
  }

  snapshotStats() {
    const scopes = {};
    const now = this.now();
    for (const [scope, entry] of this.entries) {
      scopes[scope] = {
        rows: entry.rows.length,
        ageMs: Math.max(0, now - entry.storedAt),
        fresh: entry.expiresAt > now,
      };
    }
    return {
      ...this.stats,
      ttlMs: this.ttlMs,
      disabled: this.disabled,
      inFlight: this.flights.size,
      scopes,
    };
  }
}

const sharedSnapshot = new AiModelCatalogSnapshot();

function cloneRows(rows) {
  return rows.map((row) => ({ ...row }));
}

/**
 * Active rows for a picker scope, served from the snapshot.
 *
 * @param {object} params
 * @param {object} params.prisma       Prisma client (injectable for tests)
 * @param {string} [params.type]       public type query (TEXT/IMAGE/VIDEO/AUDIO/MUSIC/VOICE or empty)
 * @param {AiModelCatalogSnapshot} [params.snapshot]
 * @param {boolean} [params.bypass]    force a DB read and skip the snapshot
 */
async function loadPickerRows({ prisma, type, snapshot = sharedSnapshot, bypass = false } = {}) {
  if (!prisma || !prisma.aiModel || typeof prisma.aiModel.findMany !== 'function') {
    throw new TypeError('loadPickerRows requires a prisma client with aiModel.findMany');
  }
  const key = pickerScopeKey(type);
  const rows = await snapshot.get(key, () => prisma.aiModel.findMany({
    where: buildPickerWhereClause(type),
    select: { ...PICKER_SELECT },
    orderBy: { createdAt: 'asc' },
  }), { bypass });
  return cloneRows(rows);
}

/**
 * Invalidate every picker-facing cache in this process: the row snapshot AND
 * the HTTP response cache namespace the route sits behind. Call it after any
 * write to `ai_models` that can change what the picker shows.
 */
function invalidateAiModelCatalog(options = {}) {
  const snapshot = options.snapshot || sharedSnapshot;
  const removedRows = snapshot.invalidate();
  let removedResponses = 0;
  try {
    removedResponses = invalidateResponseCache({ namespace: 'ai-models' });
  } catch (_) {
    /* the response cache must never fail a write path */
  }
  return { removedRows, removedResponses, reason: options.reason || null };
}

/**
 * Boot-time warm-up (best-effort, never throws): make sure the static manifest
 * rows exist once, then prime the snapshot for every picker scope so the
 * first click after a deploy does not pay the fal.ai discovery + first read.
 */
async function warmAiModelCatalog(options = {}) {
  const startedAt = Date.now();
  const logger = options.logger || console;
  const types = Array.isArray(options.types) && options.types.length ? options.types : MEDIA_TYPES;
  const snapshot = options.snapshot || sharedSnapshot;
  const summary = { ensured: null, primed: [], errors: [], durationMs: 0 };

  let prisma = options.prisma;
  let modelSyncService = options.modelSyncService;
  try {
    // Lazy requires keep this module import-safe for unit tests without a DB.
    if (!prisma) prisma = require('../config/database');
    if (!modelSyncService) modelSyncService = require('./model-sync-service');
  } catch (error) {
    summary.errors.push(`bootstrap:${error && error.message}`);
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  try {
    if (modelSyncService && typeof modelSyncService.ensureStaticCatalogModelsCached === 'function') {
      summary.ensured = await modelSyncService.ensureStaticCatalogModelsCached({ types });
      if (summary.ensured && (summary.ensured.created || summary.ensured.updated)) {
        snapshot.invalidate();
      }
    }
  } catch (error) {
    summary.errors.push(`ensure:${error && error.message}`);
  }

  const scopes = new Set(['TEXT', ...types].map(pickerScopeKey));
  for (const scope of scopes) {
    const type = scope === 'TEXT_IMAGE' ? 'TEXT' : scope;
    try {
      await loadPickerRows({ prisma, type, snapshot });
      summary.primed.push(scope);
    } catch (error) {
      summary.errors.push(`${scope}:${error && error.message}`);
    }
  }

  summary.durationMs = Date.now() - startedAt;
  try {
    if (summary.errors.length && typeof logger.warn === 'function') {
      logger.warn({ ...summary }, 'ai_model_catalog_warmup_partial');
    } else if (typeof logger.info === 'function') {
      logger.info({ ...summary }, 'ai_model_catalog_warmup_complete');
    }
  } catch (_) {
    /* logging is best-effort */
  }
  return summary;
}

function getAiModelCatalogStats(snapshot = sharedSnapshot) {
  return snapshot.snapshotStats();
}

module.exports = {
  AiModelCatalogSnapshot,
  sharedSnapshot,
  DEFAULT_TTL_MS,
  MEDIA_TYPES,
  PICKER_TYPES,
  PICKER_SELECT,
  resolveTtlMs,
  isSnapshotDisabled,
  buildPickerWhereClause,
  pickerScopeKey,
  loadPickerRows,
  invalidateAiModelCatalog,
  warmAiModelCatalog,
  getAiModelCatalogStats,
};

'use strict';

/**
 * Catalog rows for TypeSafe Jev.
 *
 * `curateVisibleTextModels` only surfaces a curated definition when a
 * matching active `aiModel` row exists, and the production publish refuses
 * schema/migration diffs — so the rows are created from code, idempotently,
 * the first time the TEXT picker is listed while `TYPESAFE_API_KEY` is set.
 * Existing rows are never flipped: once an admin deactivates Jev it stays
 * hidden ("activar = visible" remains admin-authoritative).
 */

const typesafe = require('./providers/typesafe');

const TYPESAFE_CATALOG_ROWS = Object.freeze(typesafe.TYPESAFE_MODELS.map((m) => Object.freeze({
  id: `typesafe-${m.apiModel.replace(/[^a-z0-9]+/gi, '-')}`,
  name: m.id,
  displayName: m.name === 'Jev (latest)' ? 'TypeSafe Jev' : `TypeSafe ${m.name}`,
  provider: 'TypeSafe',
  type: 'TEXT',
  icon: 'TypeSafeLogo',
  description: m.description,
  contextLength: m.contextTokens,
  tags: ['typesafe', 'jev', 'decision', 'calibrated', 'rlcd', 'text'],
})));

let ensured = false;
let inflight = null;

function resetForTests() {
  ensured = false;
  inflight = null;
}

/**
 * Create the Jev rows when missing. Returns { created, skipped }.
 * Fail-open: never throws (the picker must list even if the DB write fails).
 */
async function ensureTypeSafeCatalogRows(prisma, { env = process.env, force = false } = {}) {
  if (!prisma || !prisma.aiModel) return { created: 0, skipped: TYPESAFE_CATALOG_ROWS.length, reason: 'no_prisma' };
  if (!typesafe.isConfigured(env)) return { created: 0, skipped: TYPESAFE_CATALOG_ROWS.length, reason: 'not_configured' };
  if (ensured && !force) return { created: 0, skipped: TYPESAFE_CATALOG_ROWS.length, reason: 'cached' };
  if (inflight) return inflight;
  inflight = (async () => {
    let created = 0;
    let skipped = 0;
    try {
      const existing = await prisma.aiModel.findMany({
        where: { name: { in: TYPESAFE_CATALOG_ROWS.map((r) => r.name) } },
        select: { name: true },
      });
      const have = new Set(existing.map((r) => r.name));
      for (const row of TYPESAFE_CATALOG_ROWS) {
        if (have.has(row.name)) { skipped += 1; continue; }
        try {
          await prisma.aiModel.create({
            data: {
              id: row.id,
              name: row.name,
              displayName: row.displayName,
              provider: row.provider,
              type: row.type,
              icon: row.icon,
              description: row.description,
              contextLength: row.contextLength,
              tags: row.tags,
              // Connection configured ⇒ the model is meant to be usable; this
              // mirrors the Muse Spark publish migration (isActive: true).
              isActive: true,
              syncSource: 'static_manifest',
              lastSynced: new Date(),
            },
          });
          created += 1;
        } catch (err) {
          if (err && err.code === 'P2002') { skipped += 1; continue; }
          throw err;
        }
      }
      ensured = true;
      return { created, skipped, reason: 'ok' };
    } catch (err) {
      console.warn(`[typesafe-catalog] ensure rows failed: ${err && err.message}`);
      return { created, skipped, reason: 'error', error: err && err.message };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

module.exports = { TYPESAFE_CATALOG_ROWS, ensureTypeSafeCatalogRows, resetForTests };

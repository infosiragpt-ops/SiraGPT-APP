'use strict';

/**
 * Persistent app pins per conversation (spec "apps-persistent-pins").
 *
 * Pins are the ONLY server-side truth: the composer rail renders them and
 * every turn re-validates them. Unpinning never touches the underlying
 * OAuth connection — pins and connections are independent layers.
 *
 * Validation rules (enforced here, mirrored by the client):
 *   - every id exists in the catalog
 *   - availability === 'available'
 *   - the user has an active connection (status connected)
 *   - length <= MAX_PINS
 *   - no duplicates
 */

const registry = require('./registry');
const store = require('./store');
const health = require('./health');

const MAX_PINS = 4;

/**
 * Feature flag: apps_persistent_pins. When disabled the backend ignores
 * incoming pinnedAppIds (turns behave exactly like before) and the pin
 * endpoints return 404 so the client rail stays hidden. Kill switch for
 * rollout: SIRAGPT_APPS_PERSISTENT_PINS=0.
 */
const PINS_ENABLED = process.env.SIRAGPT_APPS_PERSISTENT_PINS !== '0';

const PIN_ERRORS = Object.freeze({
  APP_NOT_CONNECTED: 'APP_NOT_CONNECTED',
  APP_UNAVAILABLE: 'APP_UNAVAILABLE',
  PIN_LIMIT: 'PIN_LIMIT',
  APP_NOT_FOUND: 'APP_NOT_FOUND',
  PINS_DISABLED: 'PINS_DISABLED',
  PIN_SET_STALE: 'PIN_SET_STALE',
});

function PinError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.status = code === PIN_ERRORS.PIN_LIMIT ? 422 : 409;
  return err;
}

function normalizePinIds(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const ids = [];
  for (const raw of value) {
    const id = String(raw || '').trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function manifestIsAvailable(appId) {
  const manifest = registry.getManifest(appId);
  if (!manifest) return false;
  return manifest.availability !== 'unavailable';
}

function connectionIsActive(connection) {
  if (!connection) return false;
  const status = String(connection.status || '').trim();
  return status === registry.STATUSES.CONNECTED;
}

/**
 * Validate a proposed pin list against the catalog + the user's live
 * connections. Returns { ok, pins, errors } — errors carry the code for
 * the exact failing app so the client can surface the right chip state.
 */
async function validatePins(prisma, userId, rawPins) {
  if (!PINS_ENABLED) {
    throw PinError(PIN_ERRORS.PINS_DISABLED, 'Pins desactivados (apps_persistent_pins).');
  }
  const pins = normalizePinIds(rawPins);
  if (pins.length > MAX_PINS) {
    throw PinError(PIN_ERRORS.PIN_LIMIT, `Máximo ${MAX_PINS} apps fijadas.`);
  }
  if (pins.length === 0) return { ok: true, pins: [], errors: [] };

  const errors = [];
  const valid = [];
  for (const appId of pins) {
    const manifest = registry.getManifest(appId);
    if (!manifest) {
      errors.push({ appId, code: PIN_ERRORS.APP_NOT_FOUND });
      continue;
    }
    if (!manifestIsAvailable(appId)) {
      errors.push({ appId, code: PIN_ERRORS.APP_UNAVAILABLE });
      continue;
    }
    const row = await store.findByUserAndApp(prisma, userId, appId);
    const connection = row ? store.publicConnection(row) : null;
    if (!connectionIsActive(connection)) {
      errors.push({ appId, code: PIN_ERRORS.APP_NOT_CONNECTED });
      continue;
    }
    valid.push(appId);
  }
  return { ok: errors.length === 0, pins: valid, errors };
}

function publicPins(chat) {
  if (!PINS_ENABLED) return { pinnedAppIds: [], revision: 0 };
  const raw = chat?.pinnedAppIds;
  let pins;
  if (Array.isArray(raw)) pins = normalizePinIds(raw).slice(0, MAX_PINS);
  else if (raw && typeof raw === 'object' && Array.isArray(raw.value)) {
    pins = normalizePinIds(raw.value).slice(0, MAX_PINS);
  } else pins = [];
  return {
    pinnedAppIds: pins,
    // Monotonic revision (spec v2 §2/§6.5): every effective mutation bumps
    // it by one; an idempotent no-op keeps it. The client echoes it back as
    // If-Match on writes so concurrent tabs converge instead of silently
    // overwriting each other.
    revision: Number.isFinite(Number(chat?.pinRevision)) ? Number(chat.pinRevision) : 0,
  };
}

function nextRevision(chat) {
  return publicPins(chat).revision + 1;
}

module.exports = {
  MAX_PINS,
  PINS_ENABLED,
  PIN_ERRORS,
  PinError,
  normalizePinIds,
  manifestIsAvailable,
  connectionIsActive,
  validatePins,
  publicPins,
};

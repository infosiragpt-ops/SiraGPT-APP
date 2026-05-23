/**
 * Prisma-backed UniversalSearchBrain settings.
 *
 * Stores per-user region/mode/email plus optional provider keys. Key values
 * are encrypted with the app encryption utility when ENCRYPTION_KEY is
 * configured. In development/test environments without ENCRYPTION_KEY, the
 * module still supports non-secret settings but refuses to persist keys.
 */

const prisma = require("../../../config/database");
const { REGIONS, DEFAULT_REGION } = require("./types");

const FALLBACK_STORE = new Map();
const KEY_BOX_VERSION = 1;

function defaults() {
  return { region: DEFAULT_REGION, mode: "local", keys: {} };
}

function modelAvailable() {
  if (process.env.SEARCH_BRAIN_SETTINGS_DISABLE_PRISMA === "1") return false;
  return Boolean(prisma && prisma.searchBrainSettings);
}

function encryptionReady() {
  return typeof process.env.ENCRYPTION_KEY === "string" && /^[0-9a-f]{64}$/i.test(process.env.ENCRYPTION_KEY);
}

function encryption() {
  if (!encryptionReady()) return null;
  // Lazy require: backend/src/utils/encryption exits the process if
  // ENCRYPTION_KEY is not present, so only load it after validation.
  // eslint-disable-next-line global-require
  return require("../../../utils/encryption");
}

function normalizeMode(mode) {
  return mode === "cloud" ? "cloud" : "local";
}

function normalizeRegion(region) {
  return REGIONS.includes(region) ? region : DEFAULT_REGION;
}

function boxFromKeys(keys) {
  const enc = encryption();
  if (!enc) {
    if (Object.values(keys || {}).some((v) => typeof v === "string" && v.trim())) {
      throw new Error("ENCRYPTION_KEY is required to persist provider API keys");
    }
    return { version: KEY_BOX_VERSION, values: {} };
  }

  const values = {};
  for (const [provider, raw] of Object.entries(keys || {})) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    values[provider] = enc.encrypt(raw.trim());
  }
  return { version: KEY_BOX_VERSION, values };
}

function keysFromBox(box) {
  if (!box || typeof box !== "object") return {};
  const values = box.values && typeof box.values === "object" ? box.values : box;
  const enc = encryption();
  const out = {};

  for (const [provider, encryptedValue] of Object.entries(values || {})) {
    if (typeof encryptedValue !== "string" || !encryptedValue) continue;
    if (!enc) {
      // Without ENCRYPTION_KEY we can report configured keys from publicView,
      // but we cannot safely decrypt them for outbound provider calls.
      continue;
    }
    try {
      out[provider] = enc.decrypt(encryptedValue);
    } catch {
      // Corrupt or legacy value: omit instead of breaking every search.
    }
  }
  return out;
}

function keyNamesFromBox(box) {
  if (!box || typeof box !== "object") return [];
  const values = box.values && typeof box.values === "object" ? box.values : box;
  return Object.keys(values).filter((k) => typeof values[k] === "string" && values[k].length > 0);
}

function projectRow(row) {
  if (!row) return defaults();
  return {
    region: normalizeRegion(row.region),
    mode: normalizeMode(row.mode),
    userEmail: row.userEmail || undefined,
    keys: keysFromBox(row.keys),
  };
}

function mergeKeys(currentBox, patchKeys) {
  const currentValues = currentBox && typeof currentBox === "object" && currentBox.values && typeof currentBox.values === "object"
    ? { ...currentBox.values }
    : { ...(currentBox || {}) };

  const nextValues = { ...currentValues };
  const keysToEncrypt = {};
  for (const [provider, value] of Object.entries(patchKeys || {})) {
    if (value === "" || value === null) {
      delete nextValues[provider];
    } else if (typeof value === "string" && value.trim()) {
      keysToEncrypt[provider] = value;
    }
  }

  const encryptedPatch = boxFromKeys(keysToEncrypt).values || {};
  return {
    version: KEY_BOX_VERSION,
    values: {
      ...nextValues,
      ...encryptedPatch,
    },
  };
}

async function get(userId) {
  if (!userId) return defaults();
  if (modelAvailable()) {
    const row = await prisma.searchBrainSettings.findUnique({ where: { userId } }).catch(() => null);
    if (row) return projectRow(row);
  }
  const existing = FALLBACK_STORE.get(userId);
  return existing ? { ...existing, keys: { ...existing.keys } } : defaults();
}

async function update(userId, patch = {}) {
  if (!userId) throw new Error("settings.update: userId required");

  if (modelAvailable()) {
    try {
      const existing = await prisma.searchBrainSettings.findUnique({ where: { userId } }).catch(() => null);
      const nextRegion = patch.region ? normalizeRegion(patch.region) : normalizeRegion(existing?.region);
      const nextMode = patch.mode ? normalizeMode(patch.mode) : normalizeMode(existing?.mode);
      const nextEmail = typeof patch.userEmail === "string" ? patch.userEmail.trim() || null : existing?.userEmail || null;
      const nextKeys = patch.keys && typeof patch.keys === "object"
        ? mergeKeys(existing?.keys, patch.keys)
        : (existing?.keys || { version: KEY_BOX_VERSION, values: {} });

      const row = await prisma.searchBrainSettings.upsert({
        where: { userId },
        create: {
          userId,
          region: nextRegion,
          mode: nextMode,
          userEmail: nextEmail,
          keys: nextKeys,
        },
        update: {
          region: nextRegion,
          mode: nextMode,
          userEmail: nextEmail,
          keys: nextKeys,
        },
      });
      return projectRow(row);
    } catch (err) {
      if (err && /ENCRYPTION_KEY/.test(String(err.message || err))) throw err;
      // Database may be unavailable in offline tests or local planning.
      // Fall through to process-local settings so non-DB checks still run.
    }
  }

  const current = FALLBACK_STORE.get(userId) || defaults();
  const next = { ...current, keys: { ...current.keys } };
  if (patch.region) next.region = normalizeRegion(patch.region);
  if (patch.mode) next.mode = normalizeMode(patch.mode);
  if (typeof patch.userEmail === "string") next.userEmail = patch.userEmail.trim() || undefined;
  if (patch.keys && typeof patch.keys === "object") {
    if (!encryptionReady() && Object.values(patch.keys).some((v) => typeof v === "string" && v.trim())) {
      throw new Error("ENCRYPTION_KEY is required to persist provider API keys");
    }
    for (const [provider, value] of Object.entries(patch.keys)) {
      if (value === "" || value === null) delete next.keys[provider];
      else if (typeof value === "string" && value.trim()) next.keys[provider] = value.trim();
    }
  }
  FALLBACK_STORE.set(userId, next);
  return { ...next, keys: { ...next.keys } };
}

async function publicView(userId) {
  if (!userId) return { region: DEFAULT_REGION, mode: "local", userEmail: null, keysConfigured: [] };

  if (modelAvailable()) {
    const row = await prisma.searchBrainSettings.findUnique({ where: { userId } }).catch(() => null);
    if (row) {
      return {
        region: normalizeRegion(row.region),
        mode: normalizeMode(row.mode),
        userEmail: row.userEmail || null,
        keysConfigured: keyNamesFromBox(row.keys),
      };
    }
  }

  const s = FALLBACK_STORE.get(userId) || defaults();
  return {
    region: s.region,
    mode: s.mode,
    userEmail: s.userEmail || null,
    keysConfigured: Object.keys(s.keys || {}),
  };
}

async function clear(userId) {
  if (userId) {
    FALLBACK_STORE.delete(userId);
    if (modelAvailable()) await prisma.searchBrainSettings.deleteMany({ where: { userId } }).catch(() => null);
    return;
  }
  FALLBACK_STORE.clear();
  if (modelAvailable()) await prisma.searchBrainSettings.deleteMany({}).catch(() => null);
}

module.exports = {
  get,
  update,
  clear,
  publicView,
  DEFAULTS: defaults(),
  INTERNAL: {
    boxFromKeys,
    keysFromBox,
    keyNamesFromBox,
    modelAvailable,
    encryptionReady,
  },
};

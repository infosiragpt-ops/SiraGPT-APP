/**
 * settings — persists per-user UniversalSearchBrain preferences.
 *
 * Phase 2a scope: keys + region + mode live in-memory (process-local),
 * gated behind this module so the surface is stable. Phase 2e will
 * swap the store for Prisma-backed rows without touching callers.
 *
 * The "keys" field is a map { providerId → apiKey }. We intentionally
 * do NOT log values — only key *presence* — so a leaked log doesn't
 * leak user credentials.
 */

const { REGIONS, DEFAULT_REGION } = require("./types");

/** @typedef {"local" | "cloud"} Mode */

/**
 * @typedef {object} UserSettings
 * @property {import("./types").Region} region
 * @property {Mode} mode           — "local" = only no-key providers; "cloud" = allow key-gated
 * @property {Record<string, string>} keys
 * @property {string} [userEmail]  — polite-pool (OpenAlex, Unpaywall, …)
 */

/** @type {Map<string, UserSettings>} */
const STORE = new Map();

function defaults() {
  return { region: DEFAULT_REGION, mode: "local", keys: {} };
}

/**
 * @param {string} userId
 * @returns {UserSettings}
 */
function get(userId) {
  if (!userId) return defaults();
  const existing = STORE.get(userId);
  return existing ? { ...existing, keys: { ...existing.keys } } : defaults();
}

/**
 * Partial update. Unknown fields are ignored — we don't crash on
 * forward-compat payloads.
 *
 * @param {string} userId
 * @param {Partial<UserSettings>} patch
 * @returns {UserSettings}
 */
function update(userId, patch) {
  if (!userId) throw new Error("settings.update: userId required");
  const current = STORE.get(userId) || defaults();
  const next = { ...current, keys: { ...current.keys } };
  if (patch.region && REGIONS.includes(patch.region)) next.region = patch.region;
  if (patch.mode === "local" || patch.mode === "cloud") next.mode = patch.mode;
  if (patch.keys && typeof patch.keys === "object") {
    for (const [k, v] of Object.entries(patch.keys)) {
      if (typeof v === "string" && v.length > 0) next.keys[k] = v;
      else if (v === "" || v === null) delete next.keys[k];
    }
  }
  if (typeof patch.userEmail === "string") next.userEmail = patch.userEmail.trim();
  STORE.set(userId, next);
  return { ...next, keys: { ...next.keys } };
}

function clear(userId) {
  if (userId) STORE.delete(userId);
  else STORE.clear();
}

/**
 * Safe projection for the client — never returns raw key values,
 * only which provider IDs have a key configured.
 */
function publicView(userId) {
  const s = get(userId);
  return {
    region: s.region,
    mode: s.mode,
    userEmail: s.userEmail || null,
    keysConfigured: Object.keys(s.keys),
  };
}

module.exports = {
  get,
  update,
  clear,
  publicView,
  DEFAULTS: defaults(),
};

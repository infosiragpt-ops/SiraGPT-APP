/**
 * feature-flags — Tiny env-driven feature flag system.
 *
 * Reads enabled flags from two sources, in priority order:
 *   1. `localStorage.getItem('siragpt.featureFlags')` — comma-separated;
 *      browser-only, intended as a developer override during local work.
 *   2. `process.env.NEXT_PUBLIC_FEATURE_FLAGS` — comma-separated; baked at
 *      build time, so it works on the server and in production bundles.
 *
 * Both sources are merged into a single Set. Whitespace around entries is
 * trimmed and empty entries are dropped. Names are case-insensitive.
 *
 * This module is intentionally scaffolding-only: it does not wire any
 * concrete features. Wire-up should happen incrementally in the call sites
 * via `flags.isEnabled('my-feature')`.
 */

const LOCAL_STORAGE_KEY = 'siragpt.featureFlags';

function parseList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

function readEnvFlags(): string[] {
  // Next.js inlines `NEXT_PUBLIC_*` env vars at build time, so this works
  // identically on server and client.
  const raw = typeof process !== 'undefined' && process.env
    ? process.env.NEXT_PUBLIC_FEATURE_FLAGS
    : undefined;
  return parseList(raw);
}

function readLocalStorageFlags(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    return parseList(raw);
  } catch (_err) {
    // localStorage can throw in private mode / sandboxed iframes — silently
    // ignore so flag lookups never break the page.
    return [];
  }
}

/**
 * Parse the role-gate manifest from `NEXT_PUBLIC_ROLE_GATED_FLAGS`.
 *
 * The env var is a comma-separated list of `flag:role` pairs, e.g.
 * `experimental-ui:admin,beta-export:editor`. Each entry adds a
 * required role to that flag — a flag with no entry has no role gate
 * and behaves like a plain on/off flag. Flag names and roles are
 * normalised to lowercase + trimmed; duplicate roles are deduped.
 */
function readRoleGates(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const raw = typeof process !== 'undefined' && process.env
    ? process.env.NEXT_PUBLIC_ROLE_GATED_FLAGS
    : undefined;
  if (!raw) return map;
  for (const entry of raw.split(',')) {
    const pair = entry.trim();
    if (!pair) continue;
    const idx = pair.indexOf(':');
    if (idx <= 0 || idx === pair.length - 1) continue;
    const flag = pair.slice(0, idx).trim().toLowerCase();
    const role = pair.slice(idx + 1).trim().toLowerCase();
    if (!flag || !role) continue;
    if (!map.has(flag)) map.set(flag, new Set<string>());
    map.get(flag)!.add(role);
  }
  return map;
}

function normaliseUserRoles(user: unknown): Set<string> {
  const out = new Set<string>();
  if (!user || typeof user !== 'object') return out;
  const u = user as Record<string, unknown>;
  const candidates: unknown[] = [];
  if (typeof u.role === 'string') candidates.push(u.role);
  if (Array.isArray(u.roles)) candidates.push(...u.roles);
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) {
      out.add(c.trim().toLowerCase());
    }
  }
  return out;
}

function collectEnabled(): Set<string> {
  const merged = new Set<string>();
  for (const entry of readEnvFlags()) merged.add(entry);
  for (const entry of readLocalStorageFlags()) merged.add(entry);
  return merged;
}

export const flags = {
  /**
   * Returns true when the named flag is enabled in either source.
   * Lookup is case-insensitive.
   */
  isEnabled(name: string): boolean {
    if (typeof name !== 'string' || name.length === 0) return false;
    return collectEnabled().has(name.trim().toLowerCase());
  },

  /**
   * Returns true when the named flag is enabled AND the given user
   * satisfies the role gate declared in `NEXT_PUBLIC_ROLE_GATED_FLAGS`.
   *
   * Behaviour:
   *  - If the flag is not enabled at all (env / localStorage), returns
   *    false — role membership is irrelevant.
   *  - If the flag is enabled but has no role gate declared, returns
   *    true for any user (including `null`).
   *  - If the flag has a role gate, the user must carry at least one
   *    of the listed roles (matched case-insensitively against either
   *    `user.role` or `user.roles[]`).
   *
   * The role-gate env is read on every call so role changes propagate
   * immediately in dev / SSR; the cost is trivial (small comma-list).
   */
  isEnabledForUser(name: string, user: unknown): boolean {
    if (!this.isEnabled(name)) return false;
    const gates = readRoleGates();
    const required = gates.get(name.trim().toLowerCase());
    if (!required || required.size === 0) return true;
    const userRoles = normaliseUserRoles(user);
    if (userRoles.size === 0) return false;
    for (const r of userRoles) {
      if (required.has(r)) return true;
    }
    return false;
  },

  /**
   * Returns the merged list of currently-enabled flag names. Useful for
   * debug overlays and DevTools panels.
   */
  list(): string[] {
    return Array.from(collectEnabled()).sort();
  },

  /**
   * Dev-only helper: enables a flag by appending it to the localStorage
   * override list. No-op outside the browser.
   */
  enableLocal(name: string): void {
    if (typeof window === 'undefined' || !name) return;
    try {
      const current = new Set(parseList(window.localStorage.getItem(LOCAL_STORAGE_KEY)));
      current.add(name.trim().toLowerCase());
      window.localStorage.setItem(LOCAL_STORAGE_KEY, Array.from(current).join(','));
    } catch (_err) {
      // Same rationale as readLocalStorageFlags — never throw from a flag op.
    }
  },

  /**
   * Dev-only helper: removes a flag from the localStorage override list.
   * No-op outside the browser.
   */
  disableLocal(name: string): void {
    if (typeof window === 'undefined' || !name) return;
    try {
      const current = new Set(parseList(window.localStorage.getItem(LOCAL_STORAGE_KEY)));
      current.delete(name.trim().toLowerCase());
      window.localStorage.setItem(LOCAL_STORAGE_KEY, Array.from(current).join(','));
    } catch (_err) {
      // ignored — see above.
    }
  },
};

export default flags;

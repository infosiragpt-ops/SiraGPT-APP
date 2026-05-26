'use strict';

/**
 * feature-flags — small, deterministic feature-flag store. Three
 * targeting modes per flag:
 *
 *   1. boolean:   on / off for everyone
 *   2. percentage: rolled out to N% of actors, deterministic per actor
 *      (sha256(flag + ':' + actorId) → 0..100). An actor stays in the
 *      same bucket across calls — no flicker.
 *   3. attributes: include / exclude maps (tenant=foo, role=admin); a
 *      decision wins as soon as one rule matches.
 *
 * Pairs with the existing flags/ module which is wiring-flag style;
 * this is product-flag style (release management, kill switches,
 * gradual rollouts). Sits at services/flags/feature-flags.js to
 * keep the directory namespace clean.
 *
 * Public API:
 *   const fs = createFeatureFlagStore()
 *   fs.upsert(flagId, { enabled, percentage?, include?, exclude? })
 *   fs.remove(flagId)
 *   fs.evaluate(flagId, ctx) → { enabled, reason }
 *   fs.snapshot()
 *
 *   ctx shape: { actorId?, tenant?, role?, ...arbitrary }
 *   include / exclude: { attr: [allowed values] }
 *   exclude wins over include; include wins over percentage; percentage
 *   only checked when no attribute rule fired and `enabled` is true.
 */

const { createHash } = require('node:crypto');

function bucketOf(flagId, actorId) {
  if (!actorId) return null;
  const h = createHash('sha256').update(`${flagId}:${actorId}`).digest();
  // First 4 bytes → unsigned 32-bit, then mod 100 for percentage.
  const u = h.readUInt32BE(0);
  return u % 100;
}

function attributeMatch(rules, ctx) {
  if (!rules || typeof rules !== 'object') return null;
  for (const [attr, allowed] of Object.entries(rules)) {
    const v = ctx[attr];
    if (v === undefined) continue;
    const list = Array.isArray(allowed) ? allowed : [allowed];
    if (list.includes(v)) return { attr, value: v };
  }
  return null;
}

function createFeatureFlagStore() {
  /** @type {Map<string, {enabled, percentage, include, exclude, updatedAt}>} */
  const flags = new Map();

  function upsert(flagId, def = {}) {
    if (typeof flagId !== 'string' || !flagId) throw new TypeError('feature-flags: flagId required');
    const cleaned = {
      enabled: Boolean(def.enabled),
      percentage: Number.isFinite(def.percentage) ? Math.max(0, Math.min(100, Math.floor(def.percentage))) : null,
      include: def.include && typeof def.include === 'object' ? def.include : null,
      exclude: def.exclude && typeof def.exclude === 'object' ? def.exclude : null,
      updatedAt: Date.now(),
    };
    flags.set(flagId, cleaned);
    return cleaned;
  }

  function remove(flagId) {
    return flags.delete(flagId);
  }

  function evaluate(flagId, ctx = {}) {
    const f = flags.get(flagId);
    if (!f) return { enabled: false, reason: 'unknown_flag' };
    // 1. Exclude wins over everything.
    const excluded = attributeMatch(f.exclude, ctx);
    if (excluded) return { enabled: false, reason: 'excluded', match: excluded };
    // 2. Explicit include short-circuits a true result regardless of %.
    const included = attributeMatch(f.include, ctx);
    if (included) return { enabled: true, reason: 'included', match: included };
    // 3. If global flag is off, deny.
    if (!f.enabled) return { enabled: false, reason: 'disabled' };
    // 4. Percentage rollout when set and actorId available.
    if (f.percentage !== null && f.percentage < 100) {
      const b = bucketOf(flagId, ctx.actorId);
      if (b === null) return { enabled: false, reason: 'no_actor_for_percentage' };
      const inBucket = b < f.percentage;
      return { enabled: inBucket, reason: inBucket ? 'percentage_in' : 'percentage_out', bucket: b };
    }
    return { enabled: true, reason: 'enabled' };
  }

  function snapshot() {
    const out = {};
    for (const [id, f] of flags) {
      out[id] = {
        enabled: f.enabled,
        percentage: f.percentage,
        include: f.include,
        exclude: f.exclude,
        updatedAt: f.updatedAt,
      };
    }
    return { count: flags.size, flags: out };
  }

  return { upsert, remove, evaluate, snapshot };
}

module.exports = {
  createFeatureFlagStore,
  bucketOf,
  attributeMatch,
};

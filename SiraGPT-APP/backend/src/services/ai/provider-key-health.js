'use strict';

/**
 * provider-key-health.js — In-memory health/cooldown tracker for per-provider
 * API keys (auth profiles), composing with auth-profile-rotation.js.
 *
 * Rotating to the "next key" on every failing request is wasteful when a key
 * is known to be dead/exhausted: you keep paying a round-trip to a key that
 * will 401/429 again. OpenClaw's "Model failover" tracks failing auth
 * profiles and rotates around them; this is the same idea — a tiny process-
 * local store that:
 *
 *   - records a per-key failure with a reason-aware exponential-backoff
 *     cooldown (auth keys cool down longer than a transient rate-limit),
 *   - clears a key the moment it succeeds again,
 *   - reorders a profile pool so healthy keys are tried first and keys still
 *     in cooldown drift to the back (soonest-to-recover first).
 *
 * Keys are tracked by a non-reversible sha256 fingerprint, never the raw key.
 * All functions accept an injectable `now` (ms) so behaviour is fully
 * deterministic under test. State is process-local and best-effort — it is a
 * latency/cost optimisation, never a correctness gate (a cold start simply
 * means every key is considered healthy again).
 *
 * Env tunables (all milliseconds, non-negative integers):
 *   SIRAGPT_KEY_COOLDOWN_AUTH_MS        default 300000  (5 min)
 *   SIRAGPT_KEY_COOLDOWN_QUOTA_MS       default 1800000 (30 min)
 *   SIRAGPT_KEY_COOLDOWN_RATELIMIT_MS   default 30000   (30 s)
 *   SIRAGPT_KEY_COOLDOWN_DEFAULT_MS     default 120000  (2 min)
 *   SIRAGPT_KEY_COOLDOWN_MAX_MS         default 3600000 (1 h, backoff cap)
 */

const crypto = require('crypto');

function _envInt(name, def) {
    const v = Number.parseInt(process.env[name] || '', 10);
    return Number.isFinite(v) && v >= 0 ? v : def;
}

function _baseCooldownMs(reason) {
    switch (reason) {
        case 'auth': return _envInt('SIRAGPT_KEY_COOLDOWN_AUTH_MS', 5 * 60_000);
        case 'quota': return _envInt('SIRAGPT_KEY_COOLDOWN_QUOTA_MS', 30 * 60_000);
        case 'rate_limit': return _envInt('SIRAGPT_KEY_COOLDOWN_RATELIMIT_MS', 30_000);
        default: return _envInt('SIRAGPT_KEY_COOLDOWN_DEFAULT_MS', 2 * 60_000);
    }
}

// fingerprint -> { failures, lastReason, lastFailureTs, cooldownUntil }
const _store = new Map();

/** Non-reversible, stable, short id for a raw key. */
function fingerprint(key) {
    return crypto.createHash('sha256').update(String(key || '')).digest('hex').slice(0, 12);
}

/** Resolve the tracking id for a profile (its sha256 fingerprint, or `.id`). */
function _idOf(profileOrId) {
    if (profileOrId && typeof profileOrId === 'object') {
        return profileOrId.fingerprint || profileOrId.id || (profileOrId.key ? fingerprint(profileOrId.key) : '');
    }
    return String(profileOrId || '');
}

/**
 * Record a failure for a key. Cooldown grows exponentially with consecutive
 * failures (reason-aware base), capped by SIRAGPT_KEY_COOLDOWN_MAX_MS.
 */
function recordFailure(profileOrId, reason, now = Date.now()) {
    const id = _idOf(profileOrId);
    if (!id) return null;
    const e = _store.get(id) || { failures: 0, lastReason: null, lastFailureTs: 0, cooldownUntil: 0 };
    e.failures += 1;
    e.lastReason = reason || 'unknown';
    e.lastFailureTs = now;
    const base = _baseCooldownMs(reason);
    const cap = _envInt('SIRAGPT_KEY_COOLDOWN_MAX_MS', 60 * 60_000);
    const backoff = Math.min(base * Math.pow(2, e.failures - 1), cap);
    e.cooldownUntil = now + backoff;
    _store.set(id, e);
    return { id, ...e };
}

/** A key that just worked is healthy — forget any prior failures. */
function recordSuccess(profileOrId) {
    const id = _idOf(profileOrId);
    if (id) _store.delete(id);
    return id;
}

function isInCooldown(profileOrId, now = Date.now()) {
    const e = _store.get(_idOf(profileOrId));
    return !!(e && e.cooldownUntil > now);
}

function statusOf(profileOrId, now = Date.now()) {
    const id = _idOf(profileOrId);
    const e = _store.get(id);
    if (!e) return { id, healthy: true, failures: 0, cooldownMsLeft: 0, lastReason: null };
    return {
        id,
        healthy: e.cooldownUntil <= now,
        failures: e.failures,
        cooldownMsLeft: Math.max(0, e.cooldownUntil - now),
        lastReason: e.lastReason,
    };
}

/**
 * Reorder a profile pool: healthy keys first (original order preserved), then
 * keys still cooling down, soonest-to-recover first. Pure — does not mutate
 * the input array.
 */
function orderProfiles(profiles, now = Date.now()) {
    const healthy = [];
    const cooling = [];
    for (const p of profiles) {
        (isInCooldown(p, now) ? cooling : healthy).push(p);
    }
    cooling.sort((a, b) => {
        const ca = _store.get(_idOf(a))?.cooldownUntil || 0;
        const cb = _store.get(_idOf(b))?.cooldownUntil || 0;
        return ca - cb;
    });
    return [...healthy, ...cooling];
}

/** Snapshot of all tracked keys (non-secret) for diagnostics/telemetry. */
function snapshot(now = Date.now()) {
    const keys = [];
    for (const [id, e] of _store.entries()) {
        keys.push({
            id,
            healthy: e.cooldownUntil <= now,
            failures: e.failures,
            cooldownMsLeft: Math.max(0, e.cooldownUntil - now),
            lastReason: e.lastReason,
        });
    }
    return { tracked: keys.length, cooling: keys.filter(k => !k.healthy).length, keys };
}

/** Drop entries whose cooldown has elapsed (housekeeping). Returns count removed. */
function prune(now = Date.now()) {
    let removed = 0;
    for (const [id, e] of _store.entries()) {
        if (e.cooldownUntil <= now) { _store.delete(id); removed += 1; }
    }
    return removed;
}

/** Test helper — clear all tracked state. */
function _reset() {
    _store.clear();
}

module.exports = {
    fingerprint,
    recordFailure,
    recordSuccess,
    isInCooldown,
    statusOf,
    orderProfiles,
    snapshot,
    prune,
    _reset,
};

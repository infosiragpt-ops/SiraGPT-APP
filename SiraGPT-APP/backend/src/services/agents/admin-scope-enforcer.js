'use strict';

/**
 * admin-scope-enforcer — runtime enforcement of side-effect levels and
 * confirmation requirements declared in a tool manifest.
 *
 * Tool manifests (see services/agents/tool-manifest.js) optionally carry:
 *   - side_effect_level: "none" | "remote-read" | "local-fs" | "remote-write" | "destructive"
 *   - requires_confirmation: boolean
 *   - scopes: ["rag.read", ...]   — OAuth-style scope grants the caller must hold
 *   - data_classes: ["pii", ...]  — data clearance the caller must hold
 *
 * Until now these fields were declarative only. This module enforces them
 * at dispatch:
 *
 *   1. **Effect-level admission.** Every level has a minimum clearance tier
 *      the principal must hold. A caller with `clearance = "user"` cannot
 *      run a tool flagged `destructive`; only `clearance = "admin"` can.
 *
 *   2. **Confirmation gating.** When `requires_confirmation` is true (or
 *      the effect is `destructive`, which auto-implies confirmation), the
 *      caller must present a fresh, unexpired confirmation token bound to
 *      the same tool name and a time window.
 *
 *   3. **Scope intersection.** Manifest-declared `scopes` must be a subset
 *      of the principal's granted scopes.
 *
 *   4. **Data-class clearance.** Manifest-declared `data_classes` must be a
 *      subset of the principal's clearance set.
 *
 * Decisions are returned as structured `Decision` objects so callers (the
 * dispatcher in agent-task-runner) can either throw, log, or surface a
 * HITL prompt to the user.
 *
 * Public API:
 *   - decide({ manifest, principal, confirmationToken? }) → Decision
 *   - enforce(args) — throws AdminScopeError on deny, returns Decision on allow
 *   - issueConfirmationToken({ toolName, ttlMs })
 *   - verifyConfirmationToken({ token, toolName, now? })
 *   - LEVEL_TIERS, CLEARANCE_TIERS — exported for observability
 *   - AdminScopeError
 *
 * Non-goals:
 *   - Authentication. We do not validate JWTs or sessions; the upstream
 *     auth middleware is responsible for materializing `principal`.
 *   - Persistence. Tokens are in-process HMAC; for clustered deployments
 *     swap to an external KV store (out of scope).
 */

const crypto = require('node:crypto');

class AdminScopeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AdminScopeError';
    this.code = code;
    Object.assign(this, details);
  }
}

const LEVEL_TIERS = Object.freeze({
  none: 0,
  'remote-read': 1,
  'local-fs': 2,
  'remote-write': 3,
  destructive: 4,
});

const CLEARANCE_TIERS = Object.freeze({
  guest: 0,
  user: 1,
  power: 2,
  operator: 3,
  admin: 4,
  superadmin: 5,
});

const DEFAULT_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

function deriveTokenSecret() {
  if (process.env.SIRA_CONFIRMATION_TOKEN_SECRET) {
    return process.env.SIRA_CONFIRMATION_TOKEN_SECRET;
  }
  // Dev-only fallback. Production must override via env. We derive a stable
  // value so tokens issued in one process can be verified in the same
  // process; no cross-process portability is intended here.
  return crypto.createHash('sha256').update('siragpt-dev-confirm-secret').digest('hex');
}

function principalClearanceTier(principal) {
  if (!principal) return CLEARANCE_TIERS.guest;
  const c = String(principal.clearance || 'guest').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(CLEARANCE_TIERS, c)) return CLEARANCE_TIERS[c];
  return CLEARANCE_TIERS.guest;
}

function levelTier(level) {
  if (level == null) return LEVEL_TIERS.none;
  const l = String(level).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LEVEL_TIERS, l)) return LEVEL_TIERS[l];
  // Unknown levels default to "destructive" (safest closed-world fallback).
  return LEVEL_TIERS.destructive;
}

/** Minimum clearance tier needed to run a tool with the given effect level. */
function minClearanceFor(level) {
  switch (levelTier(level)) {
    case LEVEL_TIERS.none:
    case LEVEL_TIERS['remote-read']:
    case LEVEL_TIERS['local-fs']:
      return CLEARANCE_TIERS.user;
    case LEVEL_TIERS['remote-write']:
      return CLEARANCE_TIERS.power;
    case LEVEL_TIERS.destructive:
      return CLEARANCE_TIERS.admin;
    default:
      return CLEARANCE_TIERS.admin;
  }
}

function arraySubset(needed, granted) {
  if (!Array.isArray(needed) || needed.length === 0) return true;
  const set = new Set(Array.isArray(granted) ? granted.map(String) : []);
  for (const item of needed) {
    if (!set.has(String(item))) return false;
  }
  return true;
}

/**
 * Decide whether a principal may invoke a tool described by `manifest`.
 *
 * @param {object} args
 * @param {object} args.manifest — must have at least { name }
 * @param {object|null} [args.principal] — { clearance, scopes, data_clearance }
 * @param {string} [args.confirmationToken] — required when manifest.requires_confirmation
 *   is true or side_effect_level === 'destructive'
 * @param {number} [args.now] — timestamp ms (defaults to Date.now())
 * @returns {{allow: boolean, toolName: string, level: string, needsConfirmation: boolean, reasons: Array<{code: string, detail: string}>}}
 */
function decide({ manifest, principal, confirmationToken, now = Date.now() } = {}) {
  if (!manifest || typeof manifest !== 'object' || typeof manifest.name !== 'string' || manifest.name.length === 0) {
    throw new AdminScopeError('manifest_invalid', 'manifest must be an object with a non-empty name');
  }

  const reasons = [];
  let allow = true;

  const tier = levelTier(manifest.side_effect_level);
  const minTier = minClearanceFor(manifest.side_effect_level);
  const haveTier = principalClearanceTier(principal);

  if (haveTier < minTier) {
    allow = false;
    reasons.push({
      code: 'insufficient_clearance',
      detail: `tool requires clearance tier ${minTier} (level=${manifest.side_effect_level || 'none'}); principal has tier ${haveTier}`,
    });
  }

  if (Array.isArray(manifest.scopes) && manifest.scopes.length > 0) {
    if (!arraySubset(manifest.scopes, principal && principal.scopes)) {
      allow = false;
      reasons.push({
        code: 'missing_scope',
        detail: `manifest declares scopes ${JSON.stringify(manifest.scopes)} not held by principal`,
      });
    }
  }

  if (Array.isArray(manifest.data_classes) && manifest.data_classes.length > 0) {
    if (!arraySubset(manifest.data_classes, principal && principal.data_clearance)) {
      allow = false;
      reasons.push({
        code: 'data_class_clearance',
        detail: `manifest declares data classes ${JSON.stringify(manifest.data_classes)} not in principal data_clearance`,
      });
    }
  }

  const needsConfirmation =
    manifest.requires_confirmation === true ||
    tier === LEVEL_TIERS.destructive;

  if (needsConfirmation) {
    if (!confirmationToken) {
      allow = false;
      reasons.push({
        code: 'confirmation_required',
        detail: `tool ${manifest.name} requires a confirmation token`,
      });
    } else {
      const verify = verifyConfirmationToken({
        token: confirmationToken,
        toolName: manifest.name,
        now,
      });
      if (!verify.ok) {
        allow = false;
        reasons.push({ code: 'confirmation_invalid', detail: verify.reason });
      }
    }
  }

  return {
    allow,
    toolName: manifest.name,
    level: manifest.side_effect_level || 'none',
    needsConfirmation,
    reasons,
  };
}

/** Like decide() but throws AdminScopeError when allow=false. */
function enforce(args) {
  const decision = decide(args);
  if (!decision.allow) {
    const first = decision.reasons[0] || { code: 'denied', detail: 'no reason' };
    throw new AdminScopeError(first.code, `admin scope denied: ${first.detail}`, { decision });
  }
  return decision;
}

// ── Confirmation tokens ───────────────────────────────────────────────────

function issueConfirmationToken({ toolName, ttlMs = DEFAULT_TOKEN_TTL_MS, now = Date.now(), nonce } = {}) {
  if (typeof toolName !== 'string' || toolName.length === 0) {
    throw new AdminScopeError('confirmation_invalid', 'toolName required');
  }
  const exp = now + Math.max(1, ttlMs | 0);
  const n = nonce || crypto.randomBytes(8).toString('hex');
  const payload = `${toolName}.${exp}.${n}`;
  const sig = crypto.createHmac('sha256', deriveTokenSecret()).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifyConfirmationToken({ token, toolName, now = Date.now() } = {}) {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'token_missing' };
  }
  // Token format is `${toolName}.${exp}.${nonce}.${sig}`. The toolName itself
  // may legitimately contain dots (e.g. namespaces), so split on the last 3
  // dots only — everything before becomes the toolName, the trailing 3 parts
  // are exp/nonce/sig.
  const dots = [];
  for (let i = 0; i < token.length; i++) {
    if (token[i] === '.') dots.push(i);
  }
  if (dots.length < 3) return { ok: false, reason: 'token_malformed' };
  const expDot = dots[dots.length - 3];
  const nonceDot = dots[dots.length - 2];
  const sigDot = dots[dots.length - 1];
  const tn = token.slice(0, expDot);
  const expStr = token.slice(expDot + 1, nonceDot);
  const nonce = token.slice(nonceDot + 1, sigDot);
  const sig = token.slice(sigDot + 1);

  if (tn !== toolName) return { ok: false, reason: 'token_wrong_tool' };
  const exp = Number(expStr);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'token_bad_exp' };
  if (now > exp) return { ok: false, reason: 'token_expired' };
  if (!nonce) return { ok: false, reason: 'token_bad_nonce' };

  const expected = crypto
    .createHmac('sha256', deriveTokenSecret())
    .update(`${tn}.${expStr}.${nonce}`)
    .digest('hex');
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length === 0 || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'token_bad_signature' };
  }
  return { ok: true, exp };
}

module.exports = {
  AdminScopeError,
  LEVEL_TIERS,
  CLEARANCE_TIERS,
  DEFAULT_TOKEN_TTL_MS,
  decide,
  enforce,
  issueConfirmationToken,
  verifyConfirmationToken,
  minClearanceFor,
  levelTier,
  principalClearanceTier,
};

'use strict';

/**
 * orgs-service — pure helpers for the Organization / OrgMembership
 * model. Kept route-agnostic so it can be unit-tested without a
 * running Express app or Prisma client.
 *
 * Exports:
 *   - slugify(name)         → URL-friendly slug
 *   - generateInviteToken() → 32-byte hex token for magic links
 *   - roleAtLeast(have, need) → role hierarchy check
 *   - ROLE_RANK              → numeric rank for comparisons
 *   - canManageMembers(role) → ADMIN+
 *   - canShareToOrg(role)    → MEMBER+
 *   - assertMembership(prisma, orgId, userId, minRole?) → throws on
 *     missing membership; returns the membership row on success.
 *
 * The role hierarchy is OWNER > ADMIN > MEMBER > VIEWER. Some routes
 * additionally treat OWNER specially (e.g. cannot demote the last
 * owner) — that policy lives next to the route, not in this module.
 */

const crypto = require('crypto');

const ROLE_RANK = Object.freeze({
  VIEWER: 1,
  MEMBER: 2,
  ADMIN: 3,
  OWNER: 4,
});

const VALID_ROLES = Object.freeze(Object.keys(ROLE_RANK));

function slugify(name) {
  if (typeof name !== 'string') return '';
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'org';
}

function generateInviteToken() {
  return crypto.randomBytes(32).toString('hex');
}

function roleAtLeast(have, need) {
  const a = ROLE_RANK[have];
  const b = ROLE_RANK[need];
  if (!a || !b) return false;
  return a >= b;
}

function canManageMembers(role) {
  return roleAtLeast(role, 'ADMIN');
}

function canShareToOrg(role) {
  return roleAtLeast(role, 'MEMBER');
}

function isValidRole(role) {
  return typeof role === 'string' && VALID_ROLES.includes(role);
}

/**
 * Returns true when the org's settings.security.requireTwoFactor flag
 * is enabled. Tolerant to missing/null/object-shape so callers can
 * pass any `organization` row.
 */
function orgRequiresTwoFactor(org) {
  if (!org || typeof org !== 'object') return false;
  const settings = org.settings && typeof org.settings === 'object' && !Array.isArray(org.settings)
    ? org.settings
    : null;
  if (!settings) return false;
  const security = settings.security && typeof settings.security === 'object' && !Array.isArray(settings.security)
    ? settings.security
    : null;
  if (!security) return false;
  return security.requireTwoFactor === true;
}

/**
 * Returns true when the user has any 2FA factor enabled — either SMS
 * (twoFactorEnabled + verified phone) or TOTP (totpEnabled). OWNER /
 * ADMIN role does NOT bypass; the org explicitly opted into the
 * requirement and OWNERS can lift it via POST /api/orgs/:id/security.
 */
function userHasTwoFactor(user) {
  if (!user || typeof user !== 'object') return false;
  const smsOn = Boolean(user.twoFactorEnabled)
    && user.phoneVerifiedAt != null
    && typeof user.phone === 'string'
    && user.phone.trim().length > 0;
  const totpOn = Boolean(user.totpEnabled);
  return smsOn || totpOn;
}

/**
 * Throws a 403 `org_requires_2fa` error when the org demands 2FA and
 * the user has not enrolled. No-op otherwise. The thrown error carries
 * a `code` so handlers can echo it as the response error code.
 */
function assertOrgTwoFactor(org, user) {
  if (!orgRequiresTwoFactor(org)) return;
  if (userHasTwoFactor(user)) return;
  const e = new Error('organization requires two-factor authentication');
  e.status = 403;
  e.code = 'org_requires_2fa';
  throw e;
}

/**
 * Confirm `userId` has an active membership on `orgId`. Returns the
 * row when found; throws an Error with `.status` (404/403) otherwise
 * so callers can `res.status(err.status).json(...)`.
 */
async function assertMembership(prisma, orgId, userId, minRole = 'VIEWER', opts = {}) {
  if (!prisma?.orgMembership?.findUnique) {
    const e = new Error('prisma client unavailable');
    e.status = 500;
    throw e;
  }
  const row = await prisma.orgMembership.findUnique({
    where: { orgId_userId: { orgId, userId } },
    include: { organization: true },
  });
  if (!row) {
    const e = new Error('not a member of this organization');
    e.status = 404;
    throw e;
  }
  if (!roleAtLeast(row.role, minRole)) {
    const e = new Error(`requires role ${minRole}+`);
    e.status = 403;
    throw e;
  }
  // Org-level 2FA enforcement (ratchet 45). Callers may opt-in by
  // passing the authenticated user object; when the org's policy demands
  // 2FA and the user lacks an enrolled factor we throw a 403 with code
  // `org_requires_2fa`. The check is skipped silently when no user is
  // provided to preserve back-compat with handlers that pre-date the
  // policy field.
  if (opts && opts.user) {
    assertOrgTwoFactor(row.organization, opts.user);
  }
  return row;
}

/**
 * Produce a unique slug for a new org. If `base` is taken, appends
 * a short random suffix until a free slug is found (max 5 tries).
 */
async function uniqueSlug(prisma, base) {
  const root = slugify(base);
  let candidate = root;
  for (let i = 0; i < 5; i++) {
    // eslint-disable-next-line no-await-in-loop
    const taken = await prisma.organization.findUnique({ where: { slug: candidate } });
    if (!taken) return candidate;
    candidate = `${root}-${crypto.randomBytes(2).toString('hex')}`;
  }
  return `${root}-${Date.now().toString(36)}`;
}

module.exports = {
  ROLE_RANK,
  VALID_ROLES,
  slugify,
  generateInviteToken,
  roleAtLeast,
  canManageMembers,
  canShareToOrg,
  isValidRole,
  assertMembership,
  uniqueSlug,
  orgRequiresTwoFactor,
  userHasTwoFactor,
  assertOrgTwoFactor,
};

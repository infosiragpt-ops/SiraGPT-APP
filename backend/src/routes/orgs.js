'use strict';

/**
 * /api/orgs — Organization / team management endpoints (cycle 27).
 *
 *   POST   /api/orgs                                    — create org (creator becomes OWNER)
 *   GET    /api/orgs/me                                 — list caller's orgs
 *   POST   /api/orgs/:id/invite                         — invite by email (ADMIN+); returns magic-link
 *   POST   /api/orgs/invitation/:token/accept           — redeem invite (authenticated)
 *   GET    /api/orgs/:id/invitations                    — list pending invitations (ADMIN+)
 *   DELETE /api/orgs/:id/invitations/:token             — revoke invitation (ADMIN+)
 *   GET    /api/orgs/:id/members                        — list members (any member)
 *   POST   /api/orgs/:id/members/:userId/role           — change role (ADMIN+; cannot demote last OWNER)
 *   POST   /api/orgs/:id/transfer-ownership             — hand OWNER role to another MEMBER+ (OWNER only)
 *   POST   /api/orgs/:id/leave                          — self-leave convenience (refuses last OWNER)
 *   DELETE /api/orgs/:id/members/:userId                — remove member (ADMIN+ or self)
 *   POST   /api/orgs/:id/chats/:chatId/share            — share a chat into the org
 *   GET    /api/orgs/:id/chats                          — list chats shared into the org
 *   GET    /api/orgs/:id/audit-logs                     — org-scoped audit feed (ADMIN+; cycle 66)
 *   GET    /api/orgs/:id/members/:userId/activity       — recent audit rows for a single member (ADMIN+; cycle 78)
 *   GET    /api/orgs/:id/events                         — live SSE tail of audit feed (ADMIN+; cycle 78)
 *   GET    /api/orgs/:id/settings                       — read per-org settings (member; cycle 66)
 *   PATCH  /api/orgs/:id/settings                       — merge per-org settings (ADMIN+; cycle 66)
 *
 * Every state-changing route writes an AuditLog row via the shared
 * `writeAuditLog` helper (fire-and-forget).
 */

const express = require('express');
const crypto = require('crypto');
const { authenticateToken } = require('../middleware/auth');
const { writeAuditLog } = require('../utils/audit-log');
const prisma = require('../config/database');
const triggers = require('../services/trigger-registry');
const {
  slugify,
  uniqueSlug,
  generateInviteToken,
  assertMembership,
  canManageMembers,
  canShareToOrg,
  isValidRole,
  roleAtLeast,
} = require('../services/orgs-service');
const { defaultSteps, computeProgress } = require('../services/org-onboarding');
const { responseCache, invalidate: invalidateResponseCache } = require('../middleware/response-cache');
const costTracker = require('../services/ai/cost-tracker');
const { parseOrgSettingsPatch } = require('../schemas/orgs');

const router = express.Router();

// Response cache for the onboarding-progress endpoint (cycle 10 wiring).
// Dashboard widgets refresh frequently; the underlying handler issues 7+
// prisma queries (one per step probe) so caching at 30 s TTL keeps the
// Postgres pressure bounded without making the checklist feel stale.
// Key already varies by request path (which contains the orgId) and by
// authenticated user, so members of different orgs / different users
// within the same org each get their own isolated entries.
const ONBOARDING_PROGRESS_CACHE = responseCache({
  ttlMs: 30_000,
  namespace: 'org-onboarding-progress',
});

// Members-list cache (cycle 45). The members table is read on every
// dashboard mount / sidebar refresh and rarely mutates; a 15 s TTL
// keeps the list snappy without making membership changes feel stale.
// Key already varies by orgId (path) + userId, so each viewer gets
// their own entry. Mutating endpoints (invite-accept, role-change,
// transfer-ownership, leave, remove-member) call
// `invalidateMembersCache(orgId)` after success to drop every cached
// view for that org across all users.
const MEMBERS_CACHE_NAMESPACE = 'org-members';
const MEMBERS_CACHE = responseCache({
  ttlMs: 15_000,
  namespace: MEMBERS_CACHE_NAMESPACE,
});

function invalidateMembersCache(orgId) {
  if (!orgId) return 0;
  // The path segment `/orgs/:id/members` is what uniquely identifies
  // the cached members listing — match on that so we don't accidentally
  // evict the audit-log or settings cache that may share a namespace
  // suffix in the future.
  return invalidateResponseCache({
    namespace: MEMBERS_CACHE_NAMESPACE,
    contains: `/orgs/${orgId}/members`,
  });
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function serializeOrg(org) {
  if (!org) return null;
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    billingPlan: org.billingPlan,
    ownerId: org.ownerId,
    monthlyQuota: typeof org.monthlyQuota === 'bigint' ? org.monthlyQuota.toString() : org.monthlyQuota,
    usedThisMonth: typeof org.usedThisMonth === 'bigint' ? org.usedThisMonth.toString() : org.usedThisMonth,
    createdAt: org.createdAt instanceof Date ? org.createdAt.toISOString() : org.createdAt,
  };
}

// ─── POST /api/orgs ─────────────────────────────────────────────────
router.post('/', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : '';
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const slugBase = req.body?.slug ? slugify(req.body.slug) : slugify(name);
    const slug = await uniqueSlug(prisma, slugBase);

    const org = await prisma.$transaction(async (tx) => {
      const created = await tx.organization.create({
        data: {
          name,
          slug,
          ownerId: userId,
        },
      });
      await tx.orgMembership.create({
        data: { orgId: created.id, userId, role: 'OWNER' },
      });
      return created;
    });

    void writeAuditLog(prisma, {
      action: 'org_create',
      userId,
      resource: 'organization',
      resourceId: org.id,
      after: { name: org.name, slug: org.slug },
      metadata: { orgId: org.id },
      req,
    });

    const payload = serializeOrg(org);
    payload.onboardingSteps = defaultSteps();
    res.status(201).json(payload);
  } catch (err) {
    console.error('[orgs] create failed:', err.message);
    res.status(500).json({ error: 'failed to create organization' });
  }
});

// ─── GET /api/orgs/:id/onboarding-progress ──────────────────────────
// Returns the live onboarding checklist (member count, billing config,
// chats shared, etc.) so the dashboard can render a progress bar
// without polling several endpoints individually.
router.get('/:id/onboarding-progress', authenticateToken, ONBOARDING_PROGRESS_CACHE, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  try {
    // Caller must be a member of the org (any role). `assertMembership`
    // throws with err.status on non-member / forbidden.
    await assertMembership(prisma, orgId, userId);

    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { ownerId: true },
    });
    const progress = await computeProgress({
      prisma,
      orgId,
      ownerId: org?.ownerId || null,
    });
    res.json(progress);
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] onboarding-progress failed:', err.message);
    res.status(500).json({ error: 'failed to compute onboarding progress' });
  }
});

// ─── GET /api/orgs/me ───────────────────────────────────────────────
router.get('/me', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const memberships = await prisma.orgMembership.findMany({
      where: { userId },
      include: { organization: true },
      orderBy: { createdAt: 'asc' },
    });
    const items = memberships
      .filter((m) => m.organization)
      .map((m) => ({
        ...serializeOrg(m.organization),
        role: m.role,
        joinedAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt,
      }));
    res.json({ items });
  } catch (err) {
    console.error('[orgs] list-me failed:', err.message);
    res.status(500).json({ error: 'failed to list organizations' });
  }
});

// ─── POST /api/orgs/invitation/:token/accept (authenticated) ────────
// Placed BEFORE /:id/* so the literal segment "invitation" doesn't
// shadow an org id.
router.post('/invitation/:token/accept', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const userEmail = (req.user.email || '').toLowerCase();
  const token = req.params.token;
  if (!token || token.length < 16) return res.status(400).json({ error: 'invalid token' });

  try {
    const invite = await prisma.orgInvitation.findUnique({
      where: { token },
      include: { organization: true },
    });
    if (!invite) return res.status(404).json({ error: 'invitation not found' });
    if (invite.acceptedAt) return res.status(409).json({ error: 'invitation already accepted' });
    if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
      return res.status(410).json({ error: 'invitation expired' });
    }
    if (invite.email.toLowerCase() !== userEmail) {
      return res.status(403).json({ error: 'invitation email mismatch' });
    }

    const membership = await prisma.$transaction(async (tx) => {
      const existing = await tx.orgMembership.findUnique({
        where: { orgId_userId: { orgId: invite.orgId, userId } },
      });
      if (existing) return existing;
      const created = await tx.orgMembership.create({
        data: { orgId: invite.orgId, userId, role: invite.role },
      });
      await tx.orgInvitation.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
      });
      return created;
    });

    void writeAuditLog(prisma, {
      action: 'org_invite_accept',
      userId,
      resource: 'organization',
      resourceId: invite.orgId,
      metadata: { orgId: invite.orgId, invitationId: invite.id, role: invite.role },
      req,
    });

    // Fire trigger-registry webhook (fire-and-forget). The org-scoped
    // fan-out picks up the `orgId` in the payload so team webhooks /
    // Slack channels receive the event.
    triggers.publish('org.invitation.accepted', {
      orgId: invite.orgId,
      invitationId: invite.id,
      email: invite.email,
      role: invite.role,
      acceptedByUserId: userId,
    }, userId).catch(() => {});

    // New membership row → drop cached member listings for this org.
    invalidateMembersCache(invite.orgId);

    res.json({
      ok: true,
      organization: serializeOrg(invite.organization),
      role: membership.role,
    });
  } catch (err) {
    console.error('[orgs] accept-invite failed:', err.message);
    res.status(500).json({ error: 'failed to accept invitation' });
  }
});

// ─── POST /api/orgs/:id/invite ──────────────────────────────────────
router.post('/:id/invite', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const role = typeof req.body?.role === 'string' ? req.body.role.toUpperCase() : 'MEMBER';
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'valid email required' });
  }
  if (!isValidRole(role) || role === 'OWNER') {
    return res.status(400).json({ error: 'invalid role (cannot invite as OWNER)' });
  }

  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to invite' });
    }

    const token = generateInviteToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    const invite = await prisma.orgInvitation.create({
      data: {
        orgId,
        email,
        role,
        token,
        invitedBy: userId,
        expiresAt,
      },
    });

    void writeAuditLog(prisma, {
      action: 'org_invite_create',
      userId,
      resource: 'organization',
      resourceId: orgId,
      metadata: { orgId, invitationId: invite.id, email, role },
      req,
    });

    triggers.publish('org.invitation.created', {
      orgId,
      invitationId: invite.id,
      email,
      role,
      invitedByUserId: userId,
      expiresAt: invite.expiresAt.toISOString(),
    }, userId).catch(() => {});

    // Build the magic link. The frontend "Accept invite" page will
    // POST to /api/orgs/invitation/:token/accept once the user is
    // signed in. We deliberately do NOT send an actual email here —
    // a separate mailer service consumes the audit-log/event stream.
    const appBase = process.env.APP_BASE_URL || process.env.FRONTEND_URL || '';
    const magicLink = appBase
      ? `${appBase.replace(/\/$/, '')}/orgs/invitation/${token}`
      : `/orgs/invitation/${token}`;

    res.status(201).json({
      id: invite.id,
      email: invite.email,
      role: invite.role,
      token,
      magicLink,
      expiresAt: invite.expiresAt.toISOString(),
    });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] invite failed:', err.message);
    res.status(500).json({ error: 'failed to create invitation' });
  }
});

// ─── GET /api/orgs/:id/invitations (ADMIN+) ─────────────────────────
// Lists pending (not yet accepted, not expired) invitations for the
// org. Each row carries a `daysUntilExpiry` convenience field so the
// dashboard can render a "expires in N days" badge without doing the
// date math client-side.
router.get('/:id/invitations', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to list invitations' });
    }

    const now = new Date();
    const rows = await prisma.orgInvitation.findMany({
      where: {
        orgId,
        acceptedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        role: true,
        createdAt: true,
        expiresAt: true,
      },
    });

    const items = rows.map((r) => {
      const expiresAtMs = r.expiresAt instanceof Date ? r.expiresAt.getTime() : new Date(r.expiresAt).getTime();
      const daysUntilExpiry = Math.max(0, Math.ceil((expiresAtMs - now.getTime()) / (24 * 60 * 60 * 1000)));
      return {
        id: r.id,
        email: r.email,
        role: r.role,
        createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
        expiresAt: r.expiresAt instanceof Date ? r.expiresAt.toISOString() : r.expiresAt,
        daysUntilExpiry,
      };
    });

    res.json({ items });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] list invitations failed:', err.message);
    res.status(500).json({ error: 'failed to list invitations' });
  }
});

// ─── DELETE /api/orgs/:id/invitations/:token (ADMIN+) ───────────────
// Revoke a pending invitation. The token in the URL is the magic-link
// token (same one the invitee would POST to /accept). Already-accepted
// invitations cannot be revoked (409); unknown tokens return 404.
router.delete('/:id/invitations/:token', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  const token = req.params.token;
  if (!token || token.length < 16) return res.status(400).json({ error: 'invalid token' });

  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to revoke invitations' });
    }

    const invite = await prisma.orgInvitation.findUnique({
      where: { token },
      select: { id: true, orgId: true, email: true, role: true, acceptedAt: true },
    });
    if (!invite || invite.orgId !== orgId) {
      return res.status(404).json({ error: 'invitation not found' });
    }
    if (invite.acceptedAt) {
      return res.status(409).json({ error: 'invitation already accepted; cannot revoke' });
    }

    await prisma.orgInvitation.delete({ where: { id: invite.id } });

    void writeAuditLog(prisma, {
      action: 'org_invite_revoke',
      userId,
      resource: 'organization',
      resourceId: orgId,
      before: { invitationId: invite.id, email: invite.email, role: invite.role },
      metadata: { orgId },
      req,
    });

    triggers.publish('org.invitation.revoked', {
      orgId,
      invitationId: invite.id,
      email: invite.email,
      role: invite.role,
      revokedByUserId: userId,
    }, userId).catch(() => {});

    res.json({ ok: true });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] revoke invitation failed:', err.message);
    res.status(500).json({ error: 'failed to revoke invitation' });
  }
});

// ─── GET /api/orgs/:id/members ──────────────────────────────────────
router.get('/:id/members', authenticateToken, MEMBERS_CACHE, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  try {
    await assertMembership(prisma, orgId, userId, 'VIEWER');
    const rows = await prisma.orgMembership.findMany({
      where: { orgId },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { id: true, email: true, name: true, avatar: true } } },
    });
    const items = rows.map((m) => ({
      id: m.id,
      role: m.role,
      joinedAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt,
      user: m.user
        ? { id: m.user.id, email: m.user.email, name: m.user.name, avatar: m.user.avatar }
        : null,
    }));
    res.json({ items });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] members list failed:', err.message);
    res.status(500).json({ error: 'failed to list members' });
  }
});

// ─── POST /api/orgs/:id/members/:userId/role ────────────────────────
router.post('/:id/members/:userId/role', authenticateToken, async (req, res) => {
  const callerId = req.user.id;
  const orgId = req.params.id;
  const targetUserId = req.params.userId;
  const newRole = typeof req.body?.role === 'string' ? req.body.role.toUpperCase() : '';
  if (!isValidRole(newRole)) return res.status(400).json({ error: 'invalid role' });

  try {
    const caller = await assertMembership(prisma, orgId, callerId, 'ADMIN');
    if (!canManageMembers(caller.role)) {
      return res.status(403).json({ error: 'insufficient role' });
    }

    const target = await prisma.orgMembership.findUnique({
      where: { orgId_userId: { orgId, userId: targetUserId } },
    });
    if (!target) return res.status(404).json({ error: 'membership not found' });

    // Only an OWNER may promote/demote OWNER role.
    if ((target.role === 'OWNER' || newRole === 'OWNER') && caller.role !== 'OWNER') {
      return res.status(403).json({ error: 'only OWNER can change OWNER role' });
    }

    // Cannot demote the last OWNER.
    if (target.role === 'OWNER' && newRole !== 'OWNER') {
      const ownerCount = await prisma.orgMembership.count({
        where: { orgId, role: 'OWNER' },
      });
      if (ownerCount <= 1) {
        return res.status(409).json({ error: 'cannot demote the last OWNER' });
      }
    }

    const updated = await prisma.orgMembership.update({
      where: { orgId_userId: { orgId, userId: targetUserId } },
      data: { role: newRole },
    });

    void writeAuditLog(prisma, {
      action: 'org_member_role_change',
      userId: callerId,
      resource: 'organization',
      resourceId: orgId,
      before: { userId: targetUserId, role: target.role },
      after: { userId: targetUserId, role: newRole },
      metadata: { orgId },
      req,
    });

    // Role changed — drop cached member listings so callers see the
    // new role on next fetch instead of waiting for TTL.
    invalidateMembersCache(orgId);

    res.json({ id: updated.id, role: updated.role });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] role change failed:', err.message);
    res.status(500).json({ error: 'failed to change role' });
  }
});

// ─── POST /api/orgs/:id/transfer-ownership (OWNER only) ─────────────
// Hands the OWNER role to another existing MEMBER+ of the org. The
// previous OWNER is demoted to ADMIN so they retain management rights
// without leaving the org rudderless. The whole swap runs inside a
// single prisma.$transaction so we never observe a state with zero or
// two owners.
async function transferOwnershipHandler(req, res, deps = { prisma, writeAuditLog }) {
  const db = deps.prisma || prisma;
  const audit = deps.writeAuditLog || writeAuditLog;
  const callerId = req.user.id;
  const orgId = req.params.id;
  const newOwnerId = typeof req.body?.newOwnerId === 'string' ? req.body.newOwnerId.trim() : '';
  if (!newOwnerId) return res.status(400).json({ error: 'newOwnerId is required' });
  if (newOwnerId === callerId) {
    return res.status(400).json({ error: 'newOwnerId must differ from the current OWNER' });
  }

  try {
    const caller = await assertMembership(db, orgId, callerId, 'OWNER');
    if (caller.role !== 'OWNER') {
      return res.status(403).json({ error: 'only OWNER can transfer ownership' });
    }

    const target = await db.orgMembership.findUnique({
      where: { orgId_userId: { orgId, userId: newOwnerId } },
    });
    if (!target) {
      return res.status(404).json({ error: 'target user is not a member of this organization' });
    }
    if (!roleAtLeast(target.role, 'MEMBER')) {
      return res.status(400).json({ error: 'newOwnerId must be at least a MEMBER of the org' });
    }
    const previousTargetRole = target.role;

    const result = await db.$transaction(async (tx) => {
      // Demote current owner to ADMIN first so the unique role
      // semantics (single OWNER per org) are never violated mid-tx.
      const demoted = await tx.orgMembership.update({
        where: { orgId_userId: { orgId, userId: callerId } },
        data: { role: 'ADMIN' },
      });
      const promoted = await tx.orgMembership.update({
        where: { orgId_userId: { orgId, userId: newOwnerId } },
        data: { role: 'OWNER' },
      });
      const updatedOrg = await tx.organization.update({
        where: { id: orgId },
        data: { ownerId: newOwnerId },
      });
      return { demoted, promoted, updatedOrg };
    });

    void audit(db, {
      action: 'org_ownership_transfer',
      userId: callerId,
      resource: 'organization',
      resourceId: orgId,
      before: { ownerId: callerId, targetRole: previousTargetRole },
      after: { ownerId: newOwnerId, previousOwnerRole: 'ADMIN' },
      metadata: { orgId },
      req,
    });

    // Owner + target roles both flipped — drop members cache.
    invalidateMembersCache(orgId);

    res.json({
      ok: true,
      ownerId: result.updatedOrg.ownerId,
      previousOwnerId: callerId,
      previousOwnerRole: result.demoted.role,
      newOwnerRole: result.promoted.role,
      previousTargetRole,
    });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] transfer-ownership failed:', err.message);
    res.status(500).json({ error: 'failed to transfer ownership' });
  }
}

router.post('/:id/transfer-ownership', authenticateToken, (req, res) => transferOwnershipHandler(req, res));

// ─── POST /api/orgs/:id/leave ───────────────────────────────────────
// Convenience self-leave endpoint. Mirrors DELETE /members/:userId
// for the self-leave case but reads naturally from the client side
// ("leave org") and refuses to strand the org without an OWNER
// (returns 409 with `reason: 'last_owner'`).
async function leaveOrgHandler(req, res, deps = { prisma, writeAuditLog }) {
  const db = deps.prisma || prisma;
  const audit = deps.writeAuditLog || writeAuditLog;
  const userId = req.user.id;
  const orgId = req.params.id;
  try {
    const membership = await assertMembership(db, orgId, userId, 'VIEWER');

    if (membership.role === 'OWNER') {
      const ownerCount = await db.orgMembership.count({
        where: { orgId, role: 'OWNER' },
      });
      if (ownerCount <= 1) {
        return res.status(409).json({
          error: 'cannot leave: you are the last OWNER',
          reason: 'last_owner',
        });
      }
    }

    await db.orgMembership.delete({
      where: { orgId_userId: { orgId, userId } },
    });

    void audit(db, {
      action: 'org_member_leave',
      userId,
      resource: 'organization',
      resourceId: orgId,
      before: { userId, role: membership.role },
      metadata: { orgId },
      req,
    });

    // Membership removed — invalidate cached views.
    invalidateMembersCache(orgId);

    res.json({ ok: true });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] leave failed:', err.message);
    res.status(500).json({ error: 'failed to leave organization' });
  }
}

router.post('/:id/leave', authenticateToken, (req, res) => leaveOrgHandler(req, res));

// ─── DELETE /api/orgs/:id/members/:userId ───────────────────────────
router.delete('/:id/members/:userId', authenticateToken, async (req, res) => {
  const callerId = req.user.id;
  const orgId = req.params.id;
  const targetUserId = req.params.userId;
  const isSelf = callerId === targetUserId;

  try {
    const caller = await assertMembership(prisma, orgId, callerId, 'VIEWER');
    if (!isSelf && !canManageMembers(caller.role)) {
      return res.status(403).json({ error: 'insufficient role to remove members' });
    }

    const target = await prisma.orgMembership.findUnique({
      where: { orgId_userId: { orgId, userId: targetUserId } },
    });
    if (!target) return res.status(404).json({ error: 'membership not found' });

    // Cannot remove the last OWNER.
    if (target.role === 'OWNER') {
      const ownerCount = await prisma.orgMembership.count({
        where: { orgId, role: 'OWNER' },
      });
      if (ownerCount <= 1) {
        return res.status(409).json({ error: 'cannot remove the last OWNER' });
      }
    }

    // Non-OWNER caller cannot remove an OWNER.
    if (target.role === 'OWNER' && caller.role !== 'OWNER') {
      return res.status(403).json({ error: 'only OWNER can remove OWNER' });
    }

    await prisma.orgMembership.delete({
      where: { orgId_userId: { orgId, userId: targetUserId } },
    });

    void writeAuditLog(prisma, {
      action: isSelf ? 'org_member_leave' : 'org_member_remove',
      userId: callerId,
      resource: 'organization',
      resourceId: orgId,
      before: { userId: targetUserId, role: target.role },
      metadata: { orgId },
      req,
    });

    // Member removed — drop cached listings.
    invalidateMembersCache(orgId);

    res.json({ ok: true });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] remove member failed:', err.message);
    res.status(500).json({ error: 'failed to remove member' });
  }
});

// ─── POST /api/orgs/:id/chats/:chatId/share ─────────────────────────
// Mirror of POST /api/chats/:chatId/share-to-org with the org id in
// the path. Kept here for callers that already know the org context.
router.post('/:id/chats/:chatId/share', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  const chatId = req.params.chatId;

  try {
    const membership = await assertMembership(prisma, orgId, userId, 'MEMBER');
    if (!canShareToOrg(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to share' });
    }

    const chat = await prisma.chat.findFirst({
      where: { id: chatId, userId, deletedAt: null },
      select: { id: true, organizationId: true },
    });
    if (!chat) return res.status(404).json({ error: 'chat not found' });

    const updated = await prisma.chat.update({
      where: { id: chatId },
      data: { organizationId: orgId, sharedAt: new Date() },
      select: { id: true, organizationId: true, sharedAt: true },
    });

    void writeAuditLog(prisma, {
      action: 'chat_share_to_org',
      userId,
      resource: 'chat',
      resourceId: chatId,
      after: { organizationId: orgId },
      metadata: { orgId },
      req,
    });

    res.json({
      id: updated.id,
      organizationId: updated.organizationId,
      sharedAt: updated.sharedAt instanceof Date ? updated.sharedAt.toISOString() : updated.sharedAt,
    });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] share chat failed:', err.message);
    res.status(500).json({ error: 'failed to share chat' });
  }
});

// ─── GET /api/orgs/:id/chats ────────────────────────────────────────
router.get('/:id/chats', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

  try {
    await assertMembership(prisma, orgId, userId, 'VIEWER');
    const rows = await prisma.chat.findMany({
      where: { organizationId: orgId, deletedAt: null },
      orderBy: { sharedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        title: true,
        model: true,
        userId: true,
        sharedAt: true,
        updatedAt: true,
        user: { select: { id: true, name: true, email: true, avatar: true } },
      },
    });
    const items = rows.map((c) => ({
      id: c.id,
      title: c.title,
      model: c.model,
      ownerId: c.userId,
      owner: c.user
        ? { id: c.user.id, name: c.user.name, email: c.user.email, avatar: c.user.avatar }
        : null,
      sharedAt: c.sharedAt instanceof Date ? c.sharedAt.toISOString() : c.sharedAt,
      updatedAt: c.updatedAt instanceof Date ? c.updatedAt.toISOString() : c.updatedAt,
    }));
    res.json({ items });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] list org chats failed:', err.message);
    res.status(500).json({ error: 'failed to list org chats' });
  }
});

// ─── Per-org webhook endpoints (cycle 45) ──────────────────────────
// Org-scoped variant of /api/webhooks/endpoints. The trigger registry
// fans out to these endpoints when the publishing payload carries an
// `orgId` matching this org. Listing redacts secrets; create returns
// the secret once. Member+ can list/create; Admin+ can delete.

function genWebhookSecret() {
  return 'whk_' + crypto.randomBytes(24).toString('hex');
}

function redactWebhookSecret(secret) {
  if (!secret || typeof secret !== 'string') return null;
  if (secret.length < 12) return '••••';
  return `${secret.slice(0, 8)}…${secret.slice(-4)}`;
}

function serializeOrgWebhook(ep, { includeSecret = false } = {}) {
  return {
    id: ep.id,
    organizationId: ep.organizationId,
    userId: ep.userId,
    url: ep.url,
    events: Array.isArray(ep.events) ? ep.events : [],
    secret: includeSecret ? ep.secret : redactWebhookSecret(ep.secret),
    isActive: ep.isActive,
    createdAt: ep.createdAt instanceof Date ? ep.createdAt.toISOString() : ep.createdAt,
    lastDeliveryAt: ep.lastDeliveryAt
      ? (ep.lastDeliveryAt instanceof Date ? ep.lastDeliveryAt.toISOString() : ep.lastDeliveryAt)
      : null,
  };
}

function validateWebhookUrl(url) {
  if (typeof url !== 'string' || !url) return 'url required';
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'url must be http(s)';
    return null;
  } catch {
    return 'url is not a valid URL';
  }
}

function validateWebhookEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return 'events must be a non-empty array';
  for (const e of events) {
    if (typeof e !== 'string') return 'events must be strings';
    if (e !== '*' && !triggers.isKnownTrigger(e)) return `unknown event: ${e}`;
  }
  return null;
}

// ─── GET /api/orgs/:id/webhooks ─────────────────────────────────────
router.get('/:id/webhooks', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  try {
    await assertMembership(prisma, orgId, userId, 'MEMBER');
    const rows = await prisma.webhookEndpoint.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ endpoints: rows.map((r) => serializeOrgWebhook(r)) });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] list webhooks failed:', err.message);
    res.status(500).json({ error: 'failed to list webhooks' });
  }
});

// ─── POST /api/orgs/:id/webhooks (MEMBER+) ──────────────────────────
router.post('/:id/webhooks', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  const { url, events } = req.body || {};
  const urlErr = validateWebhookUrl(url);
  if (urlErr) return res.status(400).json({ error: urlErr });
  const eventsErr = validateWebhookEvents(events);
  if (eventsErr) return res.status(400).json({ error: eventsErr });

  try {
    await assertMembership(prisma, orgId, userId, 'MEMBER');
    const secret = genWebhookSecret();
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        userId,
        organizationId: orgId,
        url,
        events,
        secret,
        isActive: true,
      },
    });
    void writeAuditLog(prisma, {
      action: 'org_webhook_create',
      userId,
      resource: 'organization',
      resourceId: orgId,
      after: { endpointId: endpoint.id, url, events },
      metadata: { orgId },
      req,
    });
    res.status(201).json({ endpoint: serializeOrgWebhook(endpoint, { includeSecret: true }) });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] create webhook failed:', err.message);
    res.status(500).json({ error: 'failed to create webhook' });
  }
});

// ─── DELETE /api/orgs/:id/webhooks/:endpointId (ADMIN+) ─────────────
router.delete('/:id/webhooks/:endpointId', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  const endpointId = req.params.endpointId;
  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to delete webhook' });
    }
    const deleted = await prisma.webhookEndpoint.deleteMany({
      where: { id: endpointId, organizationId: orgId },
    });
    if (deleted.count === 0) return res.status(404).json({ error: 'endpoint not found' });
    void writeAuditLog(prisma, {
      action: 'org_webhook_delete',
      userId,
      resource: 'organization',
      resourceId: orgId,
      before: { endpointId },
      metadata: { orgId },
      req,
    });
    res.json({ ok: true });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] delete webhook failed:', err.message);
    res.status(500).json({ error: 'failed to delete webhook' });
  }
});

// ─── Slack integration (cycle 45, org-scoped) ───────────────────────
// Mirrors the per-user endpoints under /api/integrations/slack but
// scopes the SlackIntegration row to the organization. Trigger-registry
// prefers the org-scoped integration when the publish payload carries
// an orgId so org events land in the team channel.
const slack = require('../services/slack-integration');

function isSlackWebhookUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return u.hostname === 'hooks.slack.com' || u.hostname.endsWith('.slack.com');
  } catch { return false; }
}

function serializeOrgSlack(row) {
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organizationId || null,
    channelName: row.channelName || null,
    isEnabled: !!row.isEnabled,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    lastEventAt: row.lastEventAt
      ? (row.lastEventAt instanceof Date ? row.lastEventAt.toISOString() : row.lastEventAt)
      : null,
    webhookUrl: row.webhookUrl ? 'https://hooks.slack.com/services/•••' : null,
  };
}

// GET  /api/orgs/:id/slack — fetch org Slack integration (any member)
router.get('/:id/slack', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  try {
    await assertMembership(prisma, orgId, userId, 'MEMBER');
    const row = await prisma.slackIntegration.findFirst({
      where: { organizationId: orgId },
    });
    res.json({ slack: serializeOrgSlack(row) });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] get slack failed:', err.message);
    res.status(500).json({ error: 'failed to load Slack config' });
  }
});

// POST /api/orgs/:id/slack — connect/update org Slack integration (ADMIN+)
router.post('/:id/slack', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  const { webhookUrl, channelName = null, isEnabled = true } = req.body || {};
  if (!isSlackWebhookUrl(webhookUrl)) {
    return res.status(400).json({ error: 'webhookUrl must be a valid https://hooks.slack.com URL' });
  }
  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to configure Slack' });
    }
    const encrypted = slack.encryptToken(webhookUrl);
    const existing = await prisma.slackIntegration.findFirst({
      where: { organizationId: orgId },
    });
    let row;
    if (existing) {
      row = await prisma.slackIntegration.update({
        where: { id: existing.id },
        data: { webhookUrl: encrypted, channelName, isEnabled: !!isEnabled },
      });
    } else {
      row = await prisma.slackIntegration.create({
        data: {
          userId,
          organizationId: orgId,
          webhookUrl: encrypted,
          channelName,
          isEnabled: !!isEnabled,
        },
      });
    }
    void writeAuditLog(prisma, {
      action: 'org_slack_connect',
      userId,
      resource: 'organization',
      resourceId: orgId,
      after: { slackId: row.id, channelName, isEnabled: !!isEnabled },
      metadata: { orgId },
      req,
    });
    res.status(201).json({ slack: serializeOrgSlack(row) });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] connect slack failed:', err.message);
    res.status(500).json({ error: 'failed to connect Slack' });
  }
});

// POST /api/orgs/:id/slack/test — send a test ping (ADMIN+)
router.post('/:id/slack/test', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to test Slack' });
    }
    const existing = await prisma.slackIntegration.findFirst({
      where: { organizationId: orgId },
    });
    if (!existing) return res.status(404).json({ error: 'no Slack integration configured' });
    const decrypted = slack.decryptToken(existing.webhookUrl);
    if (!decrypted) return res.status(500).json({ error: 'failed to decrypt stored webhook' });
    const out = await slack.sendEventNotification({
      webhookUrl: decrypted,
      event: 'orgs.slack.test',
      userId,
      payload: { orgId, message: 'SiraGPT org Slack integration test ping.' },
    });
    if (out.ok && existing.id) {
      prisma.slackIntegration.update({
        where: { id: existing.id },
        data: { lastEventAt: new Date() },
      }).catch(() => {});
    }
    res.json({ ok: out.ok, status: out.status });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] test slack failed:', err.message);
    res.status(500).json({ error: 'failed to test Slack' });
  }
});

// DELETE /api/orgs/:id/slack — remove org Slack integration (ADMIN+)
router.delete('/:id/slack', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to delete Slack config' });
    }
    await prisma.slackIntegration.deleteMany({ where: { organizationId: orgId } });
    void writeAuditLog(prisma, {
      action: 'org_slack_delete',
      userId,
      resource: 'organization',
      resourceId: orgId,
      metadata: { orgId },
      req,
    });
    res.json({ ok: true });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] delete slack failed:', err.message);
    res.status(500).json({ error: 'failed to delete Slack config' });
  }
});

// ─── Billing (cycle 46) ─────────────────────────────────────────────
// Plan → monthly quota mapping. Kept here (rather than in
// orgs-service) so it lives next to the upgrade endpoint that
// applies it. Values are *requests* per calendar month.
const PLAN_QUOTAS = Object.freeze({
  FREE: 50_000,
  PRO: 500_000,
  PRO_MAX: 1_000_000,
  ENTERPRISE: 10_000_000,
});

// MRR estimate in USD per plan. Used by the billing summary endpoint
// so the dashboard can render a rough revenue line without round-
// tripping to Stripe. Treat as informational only.
const PLAN_MRR_USD = Object.freeze({
  FREE: 0,
  PRO: 29,
  PRO_MAX: 99,
  ENTERPRISE: 499,
});

function quotaForPlan(plan) {
  return PLAN_QUOTAS[plan] ?? PLAN_QUOTAS.FREE;
}

function mrrForPlan(plan) {
  return PLAN_MRR_USD[plan] ?? 0;
}

function isUpgradablePlan(plan) {
  return plan === 'PRO' || plan === 'PRO_MAX' || plan === 'ENTERPRISE';
}

// First day of the NEXT calendar month at 00:00:00 UTC. Used to
// schedule the quota reset so usage windows align with billing
// cycles.
function firstOfNextMonth(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

function toBigIntString(v) {
  if (v == null) return '0';
  return typeof v === 'bigint' ? v.toString() : String(v);
}

function computePercentUsed(used, quota) {
  const u = typeof used === 'bigint' ? Number(used) : Number(used || 0);
  const q = typeof quota === 'bigint' ? Number(quota) : Number(quota || 0);
  if (!q || q <= 0) return 0;
  const pct = (u / q) * 100;
  if (!Number.isFinite(pct)) return 0;
  // Clamp + round to 2 decimals to keep the dashboard tidy.
  return Math.max(0, Math.min(100, Math.round(pct * 100) / 100));
}

// ─── POST /api/orgs/:id/billing/upgrade (OWNER only) ────────────────
router.post('/:id/billing/upgrade', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  const plan = typeof req.body?.plan === 'string' ? req.body.plan.toUpperCase() : '';

  if (!isUpgradablePlan(plan)) {
    return res.status(400).json({ error: 'plan must be PRO, PRO_MAX, or ENTERPRISE' });
  }

  try {
    const membership = await assertMembership(prisma, orgId, userId, 'OWNER');
    if (membership.role !== 'OWNER') {
      return res.status(403).json({ error: 'only OWNER can change the billing plan' });
    }

    const existing = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, billingPlan: true, monthlyQuota: true },
    });
    if (!existing) return res.status(404).json({ error: 'organization not found' });

    const newQuota = quotaForPlan(plan);
    const resetAt = firstOfNextMonth(new Date());

    const updated = await prisma.organization.update({
      where: { id: orgId },
      data: {
        billingPlan: plan,
        monthlyQuota: BigInt(newQuota),
        usedThisMonth: BigInt(0),
        quotaResetAt: resetAt,
      },
    });

    void writeAuditLog(prisma, {
      action: 'org_billing_upgrade',
      userId,
      resource: 'organization',
      resourceId: orgId,
      before: {
        billingPlan: existing.billingPlan,
        monthlyQuota: toBigIntString(existing.monthlyQuota),
      },
      after: {
        billingPlan: updated.billingPlan,
        monthlyQuota: toBigIntString(updated.monthlyQuota),
        quotaResetAt: resetAt.toISOString(),
      },
      metadata: { orgId },
      req,
    });

    res.json({
      ok: true,
      plan: updated.billingPlan,
      monthlyQuota: toBigIntString(updated.monthlyQuota),
      usedThisMonth: toBigIntString(updated.usedThisMonth),
      quotaResetAt: resetAt.toISOString(),
      mrrEstimate: mrrForPlan(updated.billingPlan),
    });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] billing upgrade failed:', err.message);
    res.status(500).json({ error: 'failed to upgrade plan' });
  }
});

// ─── GET /api/orgs/:id/billing (any member) ─────────────────────────
router.get('/:id/billing', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  try {
    await assertMembership(prisma, orgId, userId, 'VIEWER');
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: {
        billingPlan: true,
        monthlyQuota: true,
        usedThisMonth: true,
        quotaResetAt: true,
      },
    });
    if (!org) return res.status(404).json({ error: 'organization not found' });

    res.json({
      plan: org.billingPlan,
      monthlyQuota: toBigIntString(org.monthlyQuota),
      usedThisMonth: toBigIntString(org.usedThisMonth),
      percentUsed: computePercentUsed(org.usedThisMonth, org.monthlyQuota),
      resetAt: org.quotaResetAt instanceof Date
        ? org.quotaResetAt.toISOString()
        : org.quotaResetAt,
      mrrEstimate: mrrForPlan(org.billingPlan),
    });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] billing summary failed:', err.message);
    res.status(500).json({ error: 'failed to load billing summary' });
  }
});

// ─── Audit logs (cycle 66) ──────────────────────────────────────────
// Member-facing audit log feed scoped to a single org. Mirrors the
// super-admin endpoint in routes/admin.js but locks the org filter to
// the path parameter so a member of org A cannot peek at org B's
// trail by passing ?orgId=... . Pagination + action / actor / date
// filters are still honoured. ADMIN+ only — the audit trail can leak
// member emails (in metadata), invitation tokens, etc.
async function listOrgAuditLogsHandler(req, res, deps = { prisma }) {
  const db = deps.prisma || prisma;
  const userId = req.user.id;
  const orgId = req.params.id;
  try {
    const membership = await assertMembership(db, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to view audit logs' });
    }
    const { query: auditQuery } = require('../services/audit-query');
    let q = auditQuery(db).byOrg(orgId);
    if (req.query.userId) q = q.byUser(String(req.query.userId));
    if (req.query.action) q = q.byAction(String(req.query.action));
    if (req.query.resource) {
      q = q.byResource(
        String(req.query.resource),
        req.query.resourceId ? String(req.query.resourceId) : null,
      );
    }
    if (req.query.from || req.query.to) {
      q = q.byDate(req.query.from || null, req.query.to || null);
    }
    if (req.query.page) q = q.page(req.query.page);
    if (req.query.limit) q = q.limit(req.query.limit);
    const result = await q.run();
    res.json(result);
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] audit-logs failed:', err.message);
    res.status(500).json({ error: 'failed to query audit logs' });
  }
}

router.get('/:id/audit-logs', authenticateToken, (req, res) => listOrgAuditLogsHandler(req, res));

// ─── GET /api/orgs/:id/members/:userId/activity (cycle 78) ──────────
// Recent audit-log rows scoped to (this org, this member). Useful for
// compliance ("show me everything user X did inside org Y in the last
// 50 events") and for debugging access incidents. ADMIN+ only — the
// rows can leak invitation tokens, billing snapshots, etc.
async function listMemberActivityHandler(req, res, deps = { prisma }) {
  const db = deps.prisma || prisma;
  const callerId = req.user.id;
  const orgId = req.params.id;
  const memberId = req.params.userId;
  if (!memberId || typeof memberId !== 'string') {
    return res.status(400).json({ error: 'userId is required' });
  }
  try {
    // Caller must be ADMIN+ of *this* org. We deliberately do NOT
    // require the target user to currently be a member — a removed
    // member's history is precisely what an admin needs for compliance.
    const membership = await assertMembership(db, orgId, callerId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to view member activity' });
    }
    const { query: auditQuery } = require('../services/audit-query');
    // Hard ceiling of 50 — the endpoint is meant for a quick activity
    // strip, not deep pagination. Use the org-wide audit-logs endpoint
    // for full pagination + filters.
    const result = await auditQuery(db)
      .byOrg(orgId)
      .byUser(memberId)
      .limit(50)
      .order('desc')
      .run();
    res.json({
      userId: memberId,
      orgId,
      items: Array.isArray(result?.items) ? result.items : [],
      total: typeof result?.total === 'number' ? result.total : 0,
      limit: 50,
    });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] member activity failed:', err.message);
    res.status(500).json({ error: 'failed to query member activity' });
  }
}

router.get(
  '/:id/members/:userId/activity',
  authenticateToken,
  (req, res) => listMemberActivityHandler(req, res),
);

// ─── GET /api/orgs/:id/events (ADMIN+, SSE) ─────────────────────────
// Live tail of audit events for the org. Mechanics:
//   - On connect, emits a `ready` event followed by a backfill of any
//     audit-log rows from the last 30 s (so a freshly-opened tab still
//     sees the most recent activity without waiting for the poll).
//   - Then polls prisma every `POLL_MS` (default 2 s) for rows with a
//     `createdAt` strictly greater than the cursor.
//   - Stops automatically after `MAX_DURATION_MS` (60 s) or after
//     `MAX_EVENTS` (100) audit rows have been delivered — whichever
//     comes first. Both ceilings keep one open connection from
//     monopolising a worker.
//   - Heartbeats every 15 s (`: ping`) so intermediate proxies don't
//     drop the connection mid-window.
// The handler is exported so tests can drive it with a fake prisma and
// a fake `res` without binding the router into Express.
const SSE_EVENTS = Object.freeze({
  POLL_MS: 2_000,
  MAX_DURATION_MS: 60_000,
  MAX_EVENTS: 100,
  BACKFILL_WINDOW_MS: 30_000,
  HEARTBEAT_MS: 15_000,
});

// Process-wide active-subscriber counter for the /api/orgs/:id/events
// SSE feed. Mirrored into the siragpt_org_events_active_subscribers
// gauge on every open/close so /metrics reflects live state.
let _activeOrgEventsSubscribers = 0;

async function streamOrgEventsHandler(req, res, deps = {}) {
  const db = deps.prisma || prisma;
  const cfg = { ...SSE_EVENTS, ...(deps.config || {}) };
  const userId = req.user.id;
  const orgId = req.params.id;

  // Membership gate. ADMIN+ only — the audit feed can leak invitation
  // tokens / emails / before/after snapshots, so we mirror the GET
  // /audit-logs guard rather than the looser VIEWER membership.
  try {
    const membership = await assertMembership(db, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to subscribe to events' });
    }
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: 'failed to verify membership' });
  }

  // Switch the response into SSE mode. We avoid `res.flushHeaders()` on
  // mock `res` objects in tests — only call it when present so the
  // handler is portable.
  res.statusCode = 200;
  if (typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
  }
  if (typeof res.flushHeaders === 'function') {
    try { res.flushHeaders(); } catch { /* mock res — ignore */ }
  }

  const send = (event, data) => {
    if (res.writableEnded || res.destroyed) return false;
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      return false;
    }
  };

  // We use the `query` builder so the metadata.orgId filter is built
  // the same way as the polled REST endpoint (consistency matters when
  // operators correlate the two).
  const { query: auditQuery } = require('../services/audit-query');

  let delivered = 0;
  let cursor = new Date(Date.now() - cfg.BACKFILL_WINDOW_MS);
  const startedAt = Date.now();
  let closed = false;

  // Subscriber gauge + per-org event counter (cycle 79). All metric
  // updates are defensive — instrumentation never breaks the SSE path.
  let metrics = null;
  let subscribed = false;
  try {
    metrics = require('../utils/metrics');
    _activeOrgEventsSubscribers += 1;
    metrics.gauge('siragpt_org_events_active_subscribers', {}, _activeOrgEventsSubscribers);
    subscribed = true;
  } catch { /* metrics module unavailable — skip */ }

  const close = (reason) => {
    if (closed) return;
    closed = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (pollTimer) clearTimeout(pollTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (subscribed && metrics) {
      subscribed = false;
      _activeOrgEventsSubscribers = Math.max(0, _activeOrgEventsSubscribers - 1);
      try { metrics.gauge('siragpt_org_events_active_subscribers', {}, _activeOrgEventsSubscribers); } catch {}
    }
    send('done', { reason, delivered });
    try { res.end(); } catch { /* ignore */ }
  };

  // Initial handshake — gives the frontend a stable point to detach
  // "connecting…" UI before any rows actually arrive.
  send('ready', {
    orgId,
    pollMs: cfg.POLL_MS,
    maxEvents: cfg.MAX_EVENTS,
    maxDurationMs: cfg.MAX_DURATION_MS,
  });

  async function poll() {
    if (closed) return;
    try {
      const result = await auditQuery(db)
        .byOrg(orgId)
        .byDate(cursor, null)
        .limit(Math.max(1, cfg.MAX_EVENTS - delivered))
        .order('asc')
        .run();
      const items = Array.isArray(result?.items) ? result.items : [];
      for (const row of items) {
        // Skip rows we already emitted (cursor is `>=`, so the boundary
        // row reappears on every poll until createdAt advances).
        const rowAt = row.createdAt instanceof Date
          ? row.createdAt
          : (row.createdAt ? new Date(row.createdAt) : null);
        if (rowAt && rowAt.getTime() <= cursor.getTime()) continue;
        const ok = send('audit', {
          id: row.id,
          action: row.action,
          actorId: row.actorId,
          actorType: row.actorType,
          resourceType: row.resourceType,
          resourceId: row.resourceId,
          metadata: row.metadata || null,
          before: row.before || null,
          after: row.after || null,
          createdAt: rowAt ? rowAt.toISOString() : null,
        });
        if (!ok) { close('write_failed'); return; }
        delivered += 1;
        if (metrics) {
          try { metrics.counter('siragpt_org_events_streamed_total', { orgId }, 1); } catch {}
        }
        if (rowAt) cursor = rowAt;
        if (delivered >= cfg.MAX_EVENTS) { close('max_events'); return; }
      }
    } catch (err) {
      send('error', { message: err?.message || 'poll_failed' });
    }
    if (closed) return;
    if (Date.now() - startedAt >= cfg.MAX_DURATION_MS) { close('timeout'); return; }
    pollTimer = setTimeout(poll, cfg.POLL_MS);
  }

  // Heartbeat keeps intermediaries from dropping the connection
  // between actual audit events.
  const heartbeatTimer = setInterval(() => {
    if (closed || res.writableEnded) return;
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }, cfg.HEARTBEAT_MS);
  if (heartbeatTimer.unref) heartbeatTimer.unref();

  // Hard deadline — guarantees we don't outlive MAX_DURATION_MS even
  // if the poll loop stalls (e.g. prisma hangs on a slow query).
  const deadlineTimer = setTimeout(() => close('timeout'), cfg.MAX_DURATION_MS);
  if (deadlineTimer.unref) deadlineTimer.unref();

  // Client disconnect — release timers promptly.
  if (req && typeof req.on === 'function') {
    req.on('close', () => close('client_closed'));
  }

  let pollTimer = setTimeout(poll, 0);
  if (pollTimer.unref) pollTimer.unref();

  // For test harnesses that want to await full completion deterministically.
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (closed) { clearInterval(interval); resolve(); }
    }, 5);
    if (interval.unref) interval.unref();
  });
}

router.get('/:id/events', authenticateToken, (req, res) => streamOrgEventsHandler(req, res));

// ─── Settings (cycle 66) ────────────────────────────────────────────
// Per-org JSON settings bag. Read is open to any member; write is
// ADMIN+ and performs a shallow merge so callers can PATCH a single
// key without round-tripping the full object. Every write produces an
// audit log row carrying the merged before/after for compliance.

function sanitizeSettings(input) {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) return null;
  return input;
}

function mergeSettings(current, patch) {
  const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete out[k]; // explicit null = remove key
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function getOrgSettingsHandler(req, res, deps = { prisma }) {
  const db = deps.prisma || prisma;
  const userId = req.user.id;
  const orgId = req.params.id;
  try {
    await assertMembership(db, orgId, userId, 'VIEWER');
    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { settings: true },
    });
    if (!org) return res.status(404).json({ error: 'organization not found' });
    res.json({ settings: org.settings && typeof org.settings === 'object' ? org.settings : {} });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] get settings failed:', err.message);
    res.status(500).json({ error: 'failed to load settings' });
  }
}

async function patchOrgSettingsHandler(req, res, deps = { prisma, writeAuditLog }) {
  const db = deps.prisma || prisma;
  const audit = deps.writeAuditLog || writeAuditLog;
  const userId = req.user.id;
  const orgId = req.params.id;
  const patch = sanitizeSettings(req.body?.settings ?? req.body);
  if (patch === null) {
    return res.status(400).json({ error: 'settings must be a JSON object' });
  }
  // Zod shape-check on the known keys. Unknown keys are tolerated for
  // forward-compat but are surfaced as `warnings` on the response so the
  // FE / ops know when callers are sending undeclared fields. A failed
  // parse on a *known* key (e.g. `responseStyle: 'verbose'`) is a hard
  // 400 — that's the whole point of the schema.
  const parsed = parseOrgSettingsPatch(patch);
  if (parsed.error) {
    return res.status(400).json({
      error: parsed.error.message,
      issues: parsed.error.issues || undefined,
    });
  }
  const warnings = parsed.warnings;
  if (warnings.length) {
    // Log once per PATCH for observability — bounded by the unknown-key
    // count which is tiny in practice.
    console.warn('[orgs] settings patch had unknown keys:', warnings.join(','));
  }
  try {
    const membership = await assertMembership(db, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to update settings' });
    }
    const existing = await db.organization.findUnique({
      where: { id: orgId },
      select: { settings: true },
    });
    if (!existing) return res.status(404).json({ error: 'organization not found' });
    const before = existing.settings && typeof existing.settings === 'object' ? existing.settings : {};
    const merged = mergeSettings(before, patch);
    const updated = await db.organization.update({
      where: { id: orgId },
      data: { settings: merged },
      select: { settings: true },
    });
    void audit(db, {
      action: 'org_settings_update',
      userId,
      resource: 'organization',
      resourceId: orgId,
      before,
      after: updated.settings || {},
      metadata: { orgId },
      req,
    });
    const responseBody = { settings: updated.settings || {} };
    if (warnings.length) responseBody.warnings = warnings;
    res.json(responseBody);
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] patch settings failed:', err.message);
    res.status(500).json({ error: 'failed to update settings' });
  }
}

router.get('/:id/settings', authenticateToken, (req, res) => getOrgSettingsHandler(req, res));
router.patch('/:id/settings', authenticateToken, (req, res) => patchOrgSettingsHandler(req, res));

// ─── GET /api/orgs/:id/usage-trend (cycle 45) ───────────────────────
// Returns a 30-day daily breakdown of AI cost / token / request usage
// for the organisation. Aggregated from the in-memory cost-tracker by
// filtering on the set of current org members. Any member can read
// the trend — billing dashboards need it for all roles.
//
// Response shape:
//   { orgId, from, to, days: [{ date: 'YYYY-MM-DD', tokens, costUSD, requests }] }
//
// `days` is always exactly 30 entries (UTC days, oldest → newest);
// missing days yield zeroed rows so chart widgets don't need to gap-fill.
function utcDayKey(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfUtcDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

async function usageTrendHandler(req, res, deps = { prisma, costTracker }) {
  const db = deps.prisma || prisma;
  const tracker = deps.costTracker || costTracker;
  const userId = req.user.id;
  const orgId = req.params.id;
  try {
    await assertMembership(db, orgId, userId, 'VIEWER');

    // 30-day window ending at end-of-today (UTC); inclusive of today so
    // partial-day usage shows up in real time.
    const now = new Date();
    const todayStart = startOfUtcDay(now);
    const windowStart = new Date(todayStart.getTime() - 29 * 24 * 60 * 60 * 1000);
    const windowEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000 - 1);

    // Fetch member ids — only userIds currently in the org. Removed
    // members' historical usage is intentionally excluded (matches the
    // existing billing summary semantics).
    const memberships = await db.orgMembership.findMany({
      where: { orgId },
      select: { userId: true },
    });
    const memberIds = new Set(memberships.map((m) => String(m.userId)));

    // Seed empty buckets so the response always has 30 rows.
    const buckets = new Map();
    for (let i = 0; i < 30; i += 1) {
      const dayStart = new Date(windowStart.getTime() + i * 24 * 60 * 60 * 1000);
      buckets.set(utcDayKey(dayStart), { tokens: 0, costUSD: 0, requests: 0 });
    }

    if (memberIds.size > 0 && typeof tracker.report === 'function') {
      const result = tracker.report({
        from: windowStart.toISOString(),
        to: windowEnd.toISOString(),
        includeRecords: true,
      });
      const records = Array.isArray(result?.records) ? result.records : [];
      for (const r of records) {
        if (!r || !memberIds.has(String(r.userId))) continue;
        const ts = new Date(r.ts);
        if (Number.isNaN(ts.getTime())) continue;
        const key = utcDayKey(ts);
        const bucket = buckets.get(key);
        if (!bucket) continue;
        bucket.tokens += (Number(r.inputTokens) || 0) + (Number(r.outputTokens) || 0);
        bucket.costUSD = Math.round((bucket.costUSD + (Number(r.costUSD) || 0)) * 1_000_000) / 1_000_000;
        bucket.requests += 1;
      }
    }

    const days = [];
    for (let i = 0; i < 30; i += 1) {
      const dayStart = new Date(windowStart.getTime() + i * 24 * 60 * 60 * 1000);
      const key = utcDayKey(dayStart);
      const b = buckets.get(key) || { tokens: 0, costUSD: 0, requests: 0 };
      days.push({ date: key, tokens: b.tokens, costUSD: b.costUSD, requests: b.requests });
    }

    res.json({
      orgId,
      from: windowStart.toISOString(),
      to: windowEnd.toISOString(),
      days,
    });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] usage-trend failed:', err.message);
    res.status(500).json({ error: 'failed to load usage trend' });
  }
}

router.get('/:id/usage-trend', authenticateToken, (req, res) => usageTrendHandler(req, res));

// Expose constants for tests/inspection.
router.__roleAtLeast = roleAtLeast;
router.__handlers = {
  transferOwnership: transferOwnershipHandler,
  leaveOrg: leaveOrgHandler,
  listOrgAuditLogs: listOrgAuditLogsHandler,
  listMemberActivity: listMemberActivityHandler,
  getOrgSettings: getOrgSettingsHandler,
  patchOrgSettings: patchOrgSettingsHandler,
  streamOrgEvents: streamOrgEventsHandler,
  usageTrend: usageTrendHandler,
};
router.__invalidateMembersCache = invalidateMembersCache;
router.__sseConfig = SSE_EVENTS;
router.__settingsHelpers = { sanitizeSettings, mergeSettings };
router.__billing = {
  PLAN_QUOTAS,
  PLAN_MRR_USD,
  quotaForPlan,
  mrrForPlan,
  isUpgradablePlan,
  firstOfNextMonth,
  computePercentUsed,
  toBigIntString,
};

module.exports = router;

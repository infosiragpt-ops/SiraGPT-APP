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
const { responseCache } = require('../middleware/response-cache');

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
      metadata: { invitationId: invite.id, role: invite.role },
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
      metadata: { invitationId: invite.id, email, role },
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
router.get('/:id/members', authenticateToken, async (req, res) => {
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
      req,
    });

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
      req,
    });

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
      req,
    });

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
      req,
    });

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

// Expose constants for tests/inspection.
router.__roleAtLeast = roleAtLeast;
router.__handlers = {
  transferOwnership: transferOwnershipHandler,
  leaveOrg: leaveOrgHandler,
};
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

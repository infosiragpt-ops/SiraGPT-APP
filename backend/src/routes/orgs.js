'use strict';

/**
 * /api/orgs — Organization / team management endpoints (cycle 27).
 *
 *   POST   /api/orgs                                    — create org (creator becomes OWNER)
 *   GET    /api/orgs/me                                 — list caller's orgs
 *   POST   /api/orgs/:id/invite                         — invite by email (ADMIN+); returns magic-link
 *   POST   /api/orgs/invitation/:token/accept           — redeem invite (authenticated)
 *   GET    /api/orgs/:id/members                        — list members (any member)
 *   POST   /api/orgs/:id/members/:userId/role           — change role (ADMIN+; cannot demote last OWNER)
 *   DELETE /api/orgs/:id/members/:userId                — remove member (ADMIN+ or self)
 *   POST   /api/orgs/:id/chats/:chatId/share            — share a chat into the org
 *   GET    /api/orgs/:id/chats                          — list chats shared into the org
 *
 * Every state-changing route writes an AuditLog row via the shared
 * `writeAuditLog` helper (fire-and-forget).
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { writeAuditLog } = require('../utils/audit-log');
const prisma = require('../config/database');
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

const router = express.Router();

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

    res.status(201).json(serializeOrg(org));
  } catch (err) {
    console.error('[orgs] create failed:', err.message);
    res.status(500).json({ error: 'failed to create organization' });
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

// Expose constants for tests/inspection.
router.__roleAtLeast = roleAtLeast;

module.exports = router;

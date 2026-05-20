'use strict';

/**
 * /api/orgs — Organization / team management endpoints (cycle 27).
 *
 *   POST   /api/orgs                                    — create org (creator becomes OWNER)
 *   GET    /api/orgs/me                                 — list caller's orgs
 *   POST   /api/orgs/:id/invite                         — invite by email (ADMIN+); returns magic-link
 *   POST   /api/orgs/:id/members/bulk-invite            — bulk-invite up to 50 emails (ADMIN+; ratchet 45)
 *   GET    /api/orgs/:id/members.csv                    — RFC4180 CSV export of roster (ADMIN+; ratchet 45)
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
 *   GET    /api/orgs/:id/limits                         — plan caps + member/quota usage (member; ratchet 45)
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
  orgRequiresTwoFactor,
  userHasTwoFactor,
  assertOrgTwoFactor,
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
    await assertMembership(prisma, orgId, userId, 'VIEWER', { user: req.user });

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
    if (err && err.status) {
      const body = { error: err.message };
      if (err.code) body.code = err.code;
      return res.status(err.status).json(body);
    }
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

    // Ratchet 45 — gate full membership acceptance on a verified
    // email. If the inviter typed a fresh address into the invite
    // form and that user signed up with the same address, we still
    // want a proof-of-control step before the user can read shared
    // org chats / files. We mint a fresh verification token, send the
    // magic link, and return `needs_verification` so the FE can show
    // a "check your inbox" screen. The invitation row is left as
    // pending (not accepted) so the same token can be redeemed again
    // after verification succeeds.
    if (!req.user.emailVerifiedAt) {
      try {
        const { createVerificationToken } = require('../services/email-verification');
        const emailService = require('../services/email');
        const retryQueue = require('../services/failed-email-retry');
        const { token: vToken, expiresAt } = await createVerificationToken(prisma, userId);
        // Fire-and-forget — SMTP failures must not block the API
        // response. The FE will offer a "resend" affordance. Failed
        // sends are queued for the 06:00 UTC retry cron (critical
        // email per ratchet 45).
        const userArg = { name: req.user.name, email: req.user.email };
        retryQueue.enqueueIfFailed(
          prisma,
          'verification',
          { user: userArg, token: vToken },
          Promise.resolve(emailService.sendEmailVerification(userArg, vToken)),
        ).catch(() => {});
        return res.status(202).json({
          ok: false,
          needs_verification: true,
          expiresAt,
          message: 'Email verification required before joining the organization',
        });
      } catch (verifyErr) {
        console.error('[orgs] verification mint failed:', verifyErr && verifyErr.message ? verifyErr.message : verifyErr);
        return res.status(500).json({ error: 'failed to start email verification' });
      }
    }

    // Ratchet 45 — re-check the member-count cap on accept. Catches
    // the race where multiple invites were minted under PRO and the
    // org has since been downgraded to FREE, or where several invitees
    // accept concurrently. Already-a-member shortcuts the check.
    const alreadyMember = await prisma.orgMembership.findUnique({
      where: { orgId_userId: { orgId: invite.orgId, userId } },
    });
    if (!alreadyMember) {
      const plan = invite.organization?.billingPlan || 'FREE';
      const cap = memberCapForPlan(plan);
      if (Number.isFinite(cap)) {
        const memberCount = await prisma.orgMembership.count({ where: { orgId: invite.orgId } });
        if (memberCount >= cap) {
          return res.status(402).json({
            error: 'member quota exceeded for current plan',
            plan,
            cap,
            used: memberCount,
          });
        }
      }
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

    // Fire-and-forget welcome email. No-op when SMTP is unconfigured
    // or when the user has opted out of `invitations` notifications.
    // Failures are persisted into the failed-email retry queue so a
    // transient SMTP outage doesn't silently break onboarding —
    // critical email per ratchet 45. The boolean result feeds into the
    // audit log so operators can tell whether the user actually
    // received the welcome message.
    let welcomeEmailSent = false;
    try {
      const emailService = require('../services/email');
      const emailPrefs = require('../services/email-preferences');
      const retryQueue = require('../services/failed-email-retry');
      const optIn = await emailPrefs.shouldSendEmail(prisma, userId, 'invitations');
      if (
        optIn
        && emailService.isConfigured
        && emailService.isConfigured()
      ) {
        const userArg = { name: req.user.name, email: req.user.email };
        const orgArg = invite.organization;
        // enqueueIfFailed swallows the promise — keeps the route fire-
        // and-forget but persists a retry row on rejection.
        retryQueue.enqueueIfFailed(
          prisma,
          'invitation',
          { user: userArg, org: orgArg },
          Promise.resolve(emailService.sendOrgWelcome(userArg, orgArg)),
        ).catch(() => {});
        welcomeEmailSent = true;
      }
    } catch (_) { /* ignore */ }

    void writeAuditLog(prisma, {
      action: 'org_invite_accept',
      userId,
      resource: 'organization',
      resourceId: invite.orgId,
      metadata: {
        orgId: invite.orgId,
        invitationId: invite.id,
        role: invite.role,
        welcomeEmailSent,
      },
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

    // Ratchet 45 — member-count quota per billing plan. Count current
    // members + pending (not yet accepted, not expired) invitations so
    // an admin can't sidestep the cap by spamming invites. ENTERPRISE
    // is unlimited (Infinity). Returns 402 Payment Required with the
    // plan + cap so the FE can prompt for an upgrade.
    const plan = membership.organization?.billingPlan || 'FREE';
    const cap = memberCapForPlan(plan);
    if (Number.isFinite(cap)) {
      const now = new Date();
      const [memberCount, pendingInvites] = await Promise.all([
        prisma.orgMembership.count({ where: { orgId } }),
        prisma.orgInvitation.count({
          where: { orgId, acceptedAt: null, expiresAt: { gt: now } },
        }),
      ]);
      if (memberCount + pendingInvites >= cap) {
        return res.status(402).json({
          error: 'member quota exceeded for current plan',
          plan,
          cap,
          used: memberCount + pendingInvites,
        });
      }
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

// ─── POST /api/orgs/:id/members/bulk-invite (ADMIN+) ────────────────
// Ratchet 45 — accept up to BULK_INVITE_MAX emails in a single call and
// mint an OrgInvitation per address. Each entry is processed in order
// and classified into one of three buckets:
//   - invited[]: { email, role, token, invitationId, magicLink, expiresAt }
//   - skipped[]: { email, reason }   // already-member | pending-invite | duplicate-in-request
//   - errors[]:  { email, error }    // invalid-email | quota-exceeded | unexpected
// Plan member-cap is enforced incrementally so we don't blow past the
// limit mid-batch: as soon as (currentMembers + pendingInvites + invited.length)
// would reach the cap, the remaining addresses bucket into errors with
// `quota-exceeded`. ENTERPRISE skips the cap check (Infinity).
const BULK_INVITE_MAX = 50;

router.post('/:id/members/bulk-invite', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  const rawEmails = Array.isArray(req.body?.emails) ? req.body.emails : null;
  const role = typeof req.body?.role === 'string' ? req.body.role.toUpperCase() : 'MEMBER';

  if (!rawEmails || rawEmails.length === 0) {
    return res.status(400).json({ error: 'emails[] is required' });
  }
  if (rawEmails.length > BULK_INVITE_MAX) {
    return res.status(400).json({ error: `too many emails (max ${BULK_INVITE_MAX} per call)` });
  }
  if (!isValidRole(role) || role === 'OWNER') {
    return res.status(400).json({ error: 'invalid role (cannot invite as OWNER)' });
  }

  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to invite' });
    }

    const plan = membership.organization?.billingPlan || 'FREE';
    const cap = memberCapForPlan(plan);

    // Normalise + dedupe within the request body.
    const seen = new Set();
    const invited = [];
    const skipped = [];
    const errors = [];
    const normalised = []; // [{ original, email }]
    for (const raw of rawEmails) {
      const original = raw;
      if (typeof raw !== 'string') {
        errors.push({ email: String(raw ?? ''), error: 'invalid-email' });
        continue;
      }
      const email = raw.trim().toLowerCase();
      if (!email || !email.includes('@')) {
        errors.push({ email: original, error: 'invalid-email' });
        continue;
      }
      if (seen.has(email)) {
        skipped.push({ email, reason: 'duplicate-in-request' });
        continue;
      }
      seen.add(email);
      normalised.push({ original, email });
    }

    // Snapshot current usage so we can enforce the plan cap as we go.
    const now = new Date();
    const [memberCount, pendingInvites] = await Promise.all([
      prisma.orgMembership.count({ where: { orgId } }),
      prisma.orgInvitation.count({
        where: { orgId, acceptedAt: null, expiresAt: { gt: now } },
      }),
    ]);
    let usedSlots = memberCount + pendingInvites;

    // Look up existing members + pending invites for the candidate emails
    // in two queries so we don't N+1 the DB per address.
    const candidateEmails = normalised.map((n) => n.email);
    const [existingMembers, existingInvites] = candidateEmails.length
      ? await Promise.all([
          prisma.user.findMany({
            where: { email: { in: candidateEmails } },
            select: { id: true, email: true },
          }).then((users) =>
            users.length
              ? prisma.orgMembership.findMany({
                  where: { orgId, userId: { in: users.map((u) => u.id) } },
                  select: { userId: true, user: { select: { email: true } } },
                })
              : [],
          ),
          prisma.orgInvitation.findMany({
            where: {
              orgId,
              email: { in: candidateEmails },
              acceptedAt: null,
              expiresAt: { gt: now },
            },
            select: { email: true },
          }),
        ])
      : [[], []];

    const memberEmails = new Set(
      existingMembers.map((m) => (m.user?.email || '').toLowerCase()).filter(Boolean),
    );
    const pendingEmails = new Set(
      existingInvites.map((i) => (i.email || '').toLowerCase()),
    );

    const appBase = process.env.APP_BASE_URL || process.env.FRONTEND_URL || '';

    for (const { email } of normalised) {
      if (memberEmails.has(email)) {
        skipped.push({ email, reason: 'already-member' });
        continue;
      }
      if (pendingEmails.has(email)) {
        skipped.push({ email, reason: 'pending-invite' });
        continue;
      }
      if (Number.isFinite(cap) && usedSlots >= cap) {
        errors.push({ email, error: 'quota-exceeded' });
        continue;
      }

      try {
        const token = generateInviteToken();
        const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
        const invite = await prisma.orgInvitation.create({
          data: { orgId, email, role, token, invitedBy: userId, expiresAt },
        });
        usedSlots += 1;
        // Block subsequent duplicates from racing into the loop again.
        pendingEmails.add(email);

        const magicLink = appBase
          ? `${appBase.replace(/\/$/, '')}/orgs/invitation/${token}`
          : `/orgs/invitation/${token}`;

        invited.push({
          email,
          role,
          token,
          invitationId: invite.id,
          magicLink,
          expiresAt: invite.expiresAt instanceof Date
            ? invite.expiresAt.toISOString()
            : new Date(invite.expiresAt).toISOString(),
        });

        void writeAuditLog(prisma, {
          action: 'org_invite_create',
          userId,
          resource: 'organization',
          resourceId: orgId,
          metadata: { orgId, invitationId: invite.id, email, role, bulk: true },
          req,
        });

        triggers.publish('org.invitation.created', {
          orgId,
          invitationId: invite.id,
          email,
          role,
          invitedByUserId: userId,
          expiresAt: invite.expiresAt instanceof Date
            ? invite.expiresAt.toISOString()
            : new Date(invite.expiresAt).toISOString(),
        }, userId).catch(() => {});
      } catch (innerErr) {
        console.error('[orgs] bulk-invite single failed:', innerErr.message);
        errors.push({ email, error: 'unexpected' });
      }
    }

    res.status(207).json({ invited, skipped, errors });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] bulk-invite failed:', err.message);
    res.status(500).json({ error: 'failed to bulk-invite' });
  }
});

// ─── GET /api/orgs/:id/members.csv (ADMIN+) ─────────────────────────
// Ratchet 45 — exports the current membership roster as RFC4180 CSV
// for HR/compliance imports. Columns: userId, email, name, role,
// joinedAt, lastActiveAt. `lastActiveAt` is read from the related User
// row (the OrgMembership table itself does not track activity). Null
// `lastActiveAt` renders as an empty field. Quoting follows the same
// rules as the audit-log CSV exporter: wrap in double quotes when the
// value contains ", \r, \n, or , and double internal quotes.
const MEMBERS_CSV_COLUMNS = ['userId', 'email', 'name', 'role', 'joinedAt', 'lastActiveAt'];

function membersCsvEscape(value) {
  if (value === null || value === undefined) return '';
  let s;
  if (value instanceof Date) s = value.toISOString();
  else s = String(value);
  if (/[",\r\n]/.test(s)) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function membersToCsv(rows) {
  const header = MEMBERS_CSV_COLUMNS.join(',');
  const lines = [header];
  for (const row of rows) {
    const cells = MEMBERS_CSV_COLUMNS.map((col) => membersCsvEscape(row?.[col]));
    lines.push(cells.join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

router.get('/:id/members.csv', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to export members' });
    }

    const rows = await prisma.orgMembership.findMany({
      where: { orgId },
      orderBy: { createdAt: 'asc' },
      include: {
        user: { select: { id: true, email: true, name: true, lastActiveAt: true } },
      },
    });

    const items = rows.map((m) => ({
      userId: m.user?.id || m.userId,
      email: m.user?.email || '',
      name: m.user?.name || '',
      role: m.role,
      joinedAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt,
      lastActiveAt: m.user?.lastActiveAt instanceof Date
        ? m.user.lastActiveAt.toISOString()
        : (m.user?.lastActiveAt || ''),
    }));

    void writeAuditLog(prisma, {
      action: 'org_members_export',
      userId,
      resource: 'organization',
      resourceId: orgId,
      metadata: { orgId, format: 'csv', count: items.length },
      req,
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="org-${orgId}-members-${Date.now()}.csv"`,
    );
    res.write(membersToCsv(items));
    res.end();
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] members.csv export failed:', err.message);
    res.status(500).json({ error: 'failed to export members' });
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

    // Snapshot the previous role BEFORE update — needed by the
    // notification email and audit-log change record below.
    const previousRole = target.role;

    const updated = await prisma.orgMembership.update({
      where: { orgId_userId: { orgId, userId: targetUserId } },
      data: { role: newRole },
    });

    // Fire-and-forget role-change notification. Only attempts to send
    // when SMTP is configured AND the role actually changed. Resolves
    // the audit-log `roleChangeEmailSent` boolean synchronously so the
    // audit row records whether the user was notified.
    let roleChangeEmailSent = false;
    if (previousRole !== newRole) {
      try {
        const emailService = require('../services/email');
        const emailPrefs = require('../services/email-preferences');
        if (emailService.isConfigured && emailService.isConfigured()) {
          const [targetUser, orgRow] = await Promise.all([
            prisma.user.findUnique({
              where: { id: targetUserId },
              select: { id: true, email: true, name: true },
            }).catch(() => null),
            prisma.organization.findUnique({
              where: { id: orgId },
              select: { id: true, name: true, slug: true },
            }).catch(() => null),
          ]);
          const optIn = targetUser
            ? await emailPrefs.shouldSendEmail(prisma, targetUser.id, 'role_changes')
            : false;
          if (targetUser && targetUser.email && optIn) {
            Promise.resolve(
              emailService.sendRoleChangeNotification(
                targetUser,
                orgRow || { id: orgId },
                previousRole,
                newRole,
              ),
            ).catch(() => {});
            roleChangeEmailSent = true;
          }
        }
      } catch (_) { /* ignore */ }
    }

    void writeAuditLog(prisma, {
      action: 'org_member_role_change',
      userId: callerId,
      resource: 'organization',
      resourceId: orgId,
      before: { userId: targetUserId, role: previousRole },
      after: { userId: targetUserId, role: newRole },
      metadata: { orgId, roleChangeEmailSent },
      req,
    });

    // Role changed — drop cached member listings so callers see the
    // new role on next fetch instead of waiting for TTL.
    invalidateMembersCache(orgId);

    // Ratchet 45, Task 1 — fan out trigger so inbox + webhooks +
    // Slack receive the role change. Fire-and-forget.
    if (previousRole !== newRole) {
      triggers.publish('org.member.role_changed', {
        orgId,
        targetUserId,
        previousRole,
        newRole,
        changedByUserId: callerId,
      }, callerId).catch(() => {});
    }

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

    // Fire-and-forget ownership-transfer notifications. Sends one
    // email to the demoted previous owner and one to the promoted
    // new owner. Records a single `transferEmailSent` audit flag —
    // true when at least one email was handed off to the transporter.
    let transferEmailSent = false;
    try {
      const emailService = require('../services/email');
      if (
        emailService.isConfigured
        && emailService.isConfigured()
        && typeof emailService.sendOwnershipTransfer === 'function'
      ) {
        const [previousOwner, newOwner, orgRow] = await Promise.all([
          db.user.findUnique({
            where: { id: callerId },
            select: { id: true, email: true, name: true },
          }).catch(() => null),
          db.user.findUnique({
            where: { id: newOwnerId },
            select: { id: true, email: true, name: true },
          }).catch(() => null),
          db.organization.findUnique({
            where: { id: orgId },
            select: { id: true, name: true, slug: true },
          }).catch(() => null),
        ]);
        const orgSafe = orgRow || { id: orgId };
        const emailPrefs = require('../services/email-preferences');
        const [prevOptIn, newOptIn] = await Promise.all([
          previousOwner ? emailPrefs.shouldSendEmail(db, previousOwner.id, 'ownership') : false,
          newOwner ? emailPrefs.shouldSendEmail(db, newOwner.id, 'ownership') : false,
        ]);
        if (previousOwner && previousOwner.email && prevOptIn) {
          Promise.resolve(
            emailService.sendOwnershipTransfer(previousOwner, orgSafe, {
              role: 'previousOwner',
              previousOwner,
              newOwner,
            }),
          ).catch(() => {});
          transferEmailSent = true;
        }
        if (newOwner && newOwner.email && newOptIn) {
          Promise.resolve(
            emailService.sendOwnershipTransfer(newOwner, orgSafe, {
              role: 'newOwner',
              previousOwner,
              newOwner,
            }),
          ).catch(() => {});
          transferEmailSent = true;
        }
      }
    } catch (_) { /* ignore */ }

    void audit(db, {
      action: 'org_ownership_transfer',
      userId: callerId,
      resource: 'organization',
      resourceId: orgId,
      before: { ownerId: callerId, targetRole: previousTargetRole },
      after: { ownerId: newOwnerId, previousOwnerRole: 'ADMIN' },
      metadata: { orgId, transferEmailSent },
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

    // Fire-and-forget removal notification — only emitted for admin
    // removals (not self-leave) and when SMTP is configured. Resolves
    // the `removalEmailSent` audit flag synchronously so the audit
    // row records whether the user was notified.
    let removalEmailSent = false;
    if (!isSelf) {
      try {
        const emailService = require('../services/email');
        if (emailService.isConfigured && emailService.isConfigured()) {
          const [targetUser, orgRow, removedBy] = await Promise.all([
            prisma.user.findUnique({
              where: { id: targetUserId },
              select: { id: true, email: true, name: true },
            }).catch(() => null),
            prisma.organization.findUnique({
              where: { id: orgId },
              select: { id: true, name: true, slug: true },
            }).catch(() => null),
            prisma.user.findUnique({
              where: { id: callerId },
              select: { id: true, email: true, name: true },
            }).catch(() => null),
          ]);
          const emailPrefs = require('../services/email-preferences');
          const optIn = targetUser
            ? await emailPrefs.shouldSendEmail(prisma, targetUser.id, 'removal')
            : false;
          if (
            targetUser
            && targetUser.email
            && optIn
            && typeof emailService.sendOrgRemoval === 'function'
          ) {
            Promise.resolve(
              emailService.sendOrgRemoval(
                targetUser,
                orgRow || { id: orgId },
                removedBy || { id: callerId },
              ),
            ).catch(() => {});
            removalEmailSent = true;
          }
        }
      } catch (_) { /* ignore */ }
    }

    void writeAuditLog(prisma, {
      action: isSelf ? 'org_member_leave' : 'org_member_remove',
      userId: callerId,
      resource: 'organization',
      resourceId: orgId,
      before: { userId: targetUserId, role: target.role },
      metadata: { orgId, removalEmailSent },
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
// Ratchet 45 (Task 1) — paginated. Supports ?page=&limit= with default
// limit=50, max=200. Response shape mirrors the api-keys listing:
// `{ items, total, page, pages, endpoints }`. The legacy `endpoints`
// field is preserved for back-compat with older clients.
router.get('/:id/webhooks', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  try {
    await assertMembership(prisma, orgId, userId, 'MEMBER');

    const rawLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 200)
      : 50;
    const rawPage = Number.parseInt(req.query.page, 10);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

    const where = { organizationId: orgId };
    const total = await prisma.webhookEndpoint.count({ where });
    const pages = total === 0 ? 0 : Math.ceil(total / limit);
    const rows = await prisma.webhookEndpoint.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const items = rows.map((r) => serializeOrgWebhook(r));
    res.json({ items, total, page, pages, endpoints: items });
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

// ─── POST /api/orgs/:id/webhooks/:endpointId/rotate-secret (ADMIN+) ──
// Ratchet 45 (Task 1) — mint a fresh HMAC secret for an existing
// WebhookEndpoint. The freshly-minted secret is returned EXACTLY ONCE
// in the response (just like create + the API-key rotate flow above).
// The previous secret is parked in `previousSecret` until
// `previousSecretExpiresAt`, which defaults to now + WEBHOOK_SECRET_-
// GRACE_HOURS (env, default 24h; clamped to 0..168h). During that
// window the dispatcher's verifier accepts EITHER the new or the old
// secret, so receivers can roll their stored secret without dropped
// deliveries. Setting WEBHOOK_SECRET_GRACE_HOURS=0 disables the grace
// window (immediate cutover).
function parseWebhookGraceHours(input) {
  const raw = input ?? process.env.WEBHOOK_SECRET_GRACE_HOURS;
  if (raw === undefined || raw === null || raw === '') return 24;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 24;
  return Math.min(n, 168);
}

router.post('/:id/webhooks/:endpointId/rotate-secret', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  const endpointId = req.params.endpointId;

  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to rotate webhook secret' });
    }

    const existing = await prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, organizationId: orgId },
    });
    if (!existing) return res.status(404).json({ error: 'endpoint not found' });

    const graceHours = parseWebhookGraceHours(req.body?.graceHours);
    const newSecret = genWebhookSecret();
    const previousSecretExpiresAt = graceHours > 0
      ? new Date(Date.now() + graceHours * 3600 * 1000)
      : null;

    const updated = await prisma.webhookEndpoint.update({
      where: { id: existing.id },
      data: {
        secret: newSecret,
        previousSecret: graceHours > 0 ? existing.secret : null,
        previousSecretExpiresAt,
      },
    });

    void writeAuditLog(prisma, {
      action: 'org_webhook_rotate_secret',
      userId,
      resource: 'organization',
      resourceId: orgId,
      before: { endpointId: existing.id, prefix: redactWebhookSecret(existing.secret) },
      after: {
        endpointId: existing.id,
        prefix: redactWebhookSecret(updated.secret),
        graceHours,
        previousSecretExpiresAt: previousSecretExpiresAt
          ? previousSecretExpiresAt.toISOString()
          : null,
      },
      metadata: { orgId },
      req,
    });

    res.status(200).json({
      endpoint: serializeOrgWebhook(updated, { includeSecret: true }),
      grace: previousSecretExpiresAt
        ? {
            hours: graceHours,
            previousSecretExpiresAt: previousSecretExpiresAt.toISOString(),
          }
        : null,
    });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] rotate webhook secret failed:', err.message);
    res.status(500).json({ error: 'failed to rotate webhook secret' });
  }
});

// ─── POST /api/orgs/:id/webhooks/:endpointId/toggle (ADMIN+) ────────
// Ratchet 45 (Task 2) — flip `isActive` on an org-scoped WebhookEndpoint.
// The cycle 65 schema already carries `isActive`; this route just
// inverts the current value so admins can pause/resume deliveries
// without rotating secrets or recreating the endpoint. Audit logged.
router.post('/:id/webhooks/:endpointId/toggle', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  const endpointId = req.params.endpointId;

  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to toggle webhook' });
    }

    const existing = await prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, organizationId: orgId },
    });
    if (!existing) return res.status(404).json({ error: 'endpoint not found' });

    const nextActive = !existing.isActive;
    const updated = await prisma.webhookEndpoint.update({
      where: { id: existing.id },
      data: { isActive: nextActive },
    });

    void writeAuditLog(prisma, {
      action: 'org_webhook_toggle',
      userId,
      resource: 'organization',
      resourceId: orgId,
      before: { endpointId: existing.id, isActive: existing.isActive },
      after: { endpointId: existing.id, isActive: updated.isActive },
      metadata: { orgId },
      req,
    });

    res.json({ endpoint: serializeOrgWebhook(updated) });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] toggle webhook failed:', err.message);
    res.status(500).json({ error: 'failed to toggle webhook' });
  }
});

// ─── POST /api/orgs/:id/webhooks/bulk-toggle (ADMIN+) ────────────────
// Ratchet 44 — bulk-set `isActive` across up to 50 endpoints in a single
// call. Body shape: `{ ids: string[], enabled: bool }`. Ids must belong
// to the caller's org; unknown ids are returned in `notFound` so the
// caller can reconcile state. Each successful flip writes its own audit
// entry (action `org_webhook_bulk_toggle`) so the audit trail mirrors
// the per-endpoint toggle route above.
const WEBHOOK_BULK_MAX = 50;

function _normalizeBulkIds(raw) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  const out = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const id = v.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

router.post('/:id/webhooks/bulk-toggle', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to toggle webhooks' });
    }

    const ids = _normalizeBulkIds(req.body && req.body.ids);
    if (!ids) return res.status(400).json({ error: 'ids must be an array of strings' });
    if (ids.length === 0) return res.status(400).json({ error: 'ids must not be empty' });
    if (ids.length > WEBHOOK_BULK_MAX) {
      return res.status(400).json({ error: `at most ${WEBHOOK_BULK_MAX} ids per request` });
    }
    if (typeof (req.body && req.body.enabled) !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    const enabled = req.body.enabled;

    const existing = await prisma.webhookEndpoint.findMany({
      where: { id: { in: ids }, organizationId: orgId },
    });
    const existingById = new Map(existing.map((e) => [e.id, e]));
    const updated = [];
    const notFound = [];

    for (const id of ids) {
      const ep = existingById.get(id);
      if (!ep) {
        notFound.push(id);
        continue;
      }
      const next = await prisma.webhookEndpoint.update({
        where: { id: ep.id },
        data: { isActive: enabled },
      });
      updated.push(next.id);
      void writeAuditLog(prisma, {
        action: 'org_webhook_bulk_toggle',
        userId,
        resource: 'organization',
        resourceId: orgId,
        before: { endpointId: ep.id, isActive: ep.isActive },
        after: { endpointId: ep.id, isActive: enabled },
        metadata: { orgId },
        req,
      });
    }

    res.json({ updated, notFound });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] bulk-toggle webhooks failed:', err.message);
    res.status(500).json({ error: 'failed to bulk-toggle webhooks' });
  }
});

// ─── POST /api/orgs/:id/webhooks/bulk-delete (ADMIN+) ────────────────
// Ratchet 44 — hard-delete up to 50 endpoints by id. Unknown ids surface
// in `notFound`. One audit entry per successful delete (action
// `org_webhook_bulk_delete`) to match the per-endpoint delete route.
router.post('/:id/webhooks/bulk-delete', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to delete webhooks' });
    }

    const ids = _normalizeBulkIds(req.body && req.body.ids);
    if (!ids) return res.status(400).json({ error: 'ids must be an array of strings' });
    if (ids.length === 0) return res.status(400).json({ error: 'ids must not be empty' });
    if (ids.length > WEBHOOK_BULK_MAX) {
      return res.status(400).json({ error: `at most ${WEBHOOK_BULK_MAX} ids per request` });
    }

    const existing = await prisma.webhookEndpoint.findMany({
      where: { id: { in: ids }, organizationId: orgId },
    });
    const existingById = new Map(existing.map((e) => [e.id, e]));
    const deleted = [];
    const notFound = [];

    for (const id of ids) {
      const ep = existingById.get(id);
      if (!ep) {
        notFound.push(id);
        continue;
      }
      const result = await prisma.webhookEndpoint.deleteMany({
        where: { id: ep.id, organizationId: orgId },
      });
      if (result && result.count > 0) {
        deleted.push(ep.id);
        void writeAuditLog(prisma, {
          action: 'org_webhook_bulk_delete',
          userId,
          resource: 'organization',
          resourceId: orgId,
          before: { endpointId: ep.id, url: ep.url },
          metadata: { orgId },
          req,
        });
      } else {
        notFound.push(id);
      }
    }

    res.json({ updated: deleted, notFound });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] bulk-delete webhooks failed:', err.message);
    res.status(500).json({ error: 'failed to bulk-delete webhooks' });
  }
});

// ─── GET /api/orgs/:id/webhooks/stats (ADMIN+) ──────────────────────
// Ratchet 45 (Task 2) — per-endpoint delivery stats over the last 24h.
// Joins the org's WebhookEndpoint rows against the in-memory delivery
// ring buffer kept by `services/webhook-dispatcher`. For each endpoint
// we surface:
//   - url               : the configured target URL
//   - events            : subscribed event list (or ['*'])
//   - last24hDelivered  : terminal-success count in the window
//   - last24hFailed     : terminal-failure count in the window
//   - p95Ms             : 95th percentile of `durationMs` over both
//                         delivered + failed entries (0 when no data)
//
// Caveat: the dispatcher's store is in-memory + per-process; in a
// multi-instance deployment this endpoint reflects the LOCAL instance.
// Once a `WebhookDelivery` Prisma model lands the query swaps to the
// database without changing the response shape.
const webhookDispatcherForStats = require('../services/webhook-dispatcher');

function _p95(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

router.get('/:id/webhooks/stats', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to view webhook stats' });
    }

    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const windowMs = 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - windowMs;

    // Pull a large slice of deliveries once; filter per endpoint in
    // JS. Bounded by the dispatcher's ring buffer (default 2048) so
    // this is cheap even on a busy instance.
    let allDeliveries = [];
    try {
      allDeliveries = webhookDispatcherForStats.listDeliveries({ limit: 10_000 }) || [];
    } catch (_e) {
      allDeliveries = [];
    }

    const stats = endpoints.map((ep) => {
      let delivered = 0;
      let failed = 0;
      const durations = [];
      for (const d of allDeliveries) {
        if (!d || d.url !== ep.url) continue;
        const t = d.createdAt ? new Date(d.createdAt).getTime() : NaN;
        if (!Number.isFinite(t) || t < cutoff) continue;
        if (d.status === 'delivered') {
          delivered += 1;
          if (typeof d.durationMs === 'number') durations.push(d.durationMs);
        } else if (d.status === 'failed') {
          failed += 1;
          if (typeof d.durationMs === 'number') durations.push(d.durationMs);
        }
      }
      return {
        id: ep.id,
        url: ep.url,
        events: Array.isArray(ep.events) ? ep.events : [],
        isActive: ep.isActive,
        last24hDelivered: delivered,
        last24hFailed: failed,
        p95Ms: _p95(durations),
      };
    });

    res.json({
      orgId,
      windowMs,
      generatedAt: new Date().toISOString(),
      endpoints: stats,
    });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] webhook stats failed:', err.message);
    res.status(500).json({ error: 'failed to load webhook stats' });
  }
});

// ─── GET /api/orgs/:id/webhooks/dlq (ADMIN+) ────────────────────────
// Ratchet 45 — org-scoped view of the webhook dead-letter queue. The
// underlying DLQ (services/webhook-dispatcher) is process-wide and
// indexed by `url`; we filter the in-memory items down to those whose
// `url` matches a WebhookEndpoint owned by this org. Mirrors the admin
// endpoint shape:
//   { items: DLQItem[], stats: { total, scoped, bufferSize, redisBacked } }
// `stats.total` keeps the global ring-buffer total (for capacity sizing)
// and `stats.scoped` reports the count visible to THIS org.
router.get('/:id/webhooks/dlq', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to view webhook DLQ' });
    }

    const rawLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 500)
      : 100;
    const event = req.query.event ? String(req.query.event) : null;

    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { organizationId: orgId },
      select: { id: true, url: true },
    });
    const orgUrls = new Set(endpoints.map((e) => e.url));

    // Pull a large slice so org-filtering doesn't truncate the window;
    // bounded by the dispatcher's DLQ ring (default 1024).
    let raw = [];
    try {
      raw = webhookDispatcherForStats.listDLQ({ limit: 10_000, event }) || [];
    } catch (_e) {
      raw = [];
    }

    const scopedItems = raw.filter((d) => d && orgUrls.has(d.url));
    const items = scopedItems.slice(0, limit);
    const baseStats = webhookDispatcherForStats.dlqStats();
    res.json({
      items,
      stats: { ...baseStats, scoped: scopedItems.length },
    });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] list webhook DLQ failed:', err.message);
    res.status(500).json({ error: 'failed to list webhook DLQ' });
  }
});

// ─── POST /api/orgs/:id/webhooks/dlq/:dlqId/retry (ADMIN+) ──────────
// Ratchet 45 — retry a single DLQ item, but only when its `url` belongs
// to a WebhookEndpoint owned by this org. The endpoint's stored secret
// is used for HMAC signing so the receiver still verifies cleanly.
// Audit logged (`org_webhook_dlq_retry`).
router.post('/:id/webhooks/dlq/:dlqId/retry', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  const dlqId = req.params.dlqId;
  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to retry webhook DLQ item' });
    }

    // Locate the DLQ item via the same listing the GET handler uses so
    // tests that stub the dispatcher see a consistent view.
    let dlqItem = null;
    try {
      const raw = webhookDispatcherForStats.listDLQ({ limit: 10_000 }) || [];
      dlqItem = raw.find((d) => d && String(d.id) === String(dlqId)) || null;
    } catch (_e) {
      dlqItem = null;
    }
    if (!dlqItem) return res.status(404).json({ error: 'DLQ item not found' });

    const endpoint = await prisma.webhookEndpoint.findFirst({
      where: { organizationId: orgId, url: dlqItem.url },
      select: { id: true, secret: true, url: true },
    });
    if (!endpoint) {
      // The DLQ item exists, but not for this org — don't leak it.
      return res.status(404).json({ error: 'DLQ item not found' });
    }

    const result = await webhookDispatcherForStats.retryDLQItem(dlqId, {
      secret: endpoint.secret,
    });

    void writeAuditLog(prisma, {
      action: 'org_webhook_dlq_retry',
      userId,
      resource: 'organization',
      resourceId: orgId,
      before: {
        dlqId,
        endpointId: endpoint.id,
        url: endpoint.url,
        event: dlqItem.event,
      },
      after: { status: result?.result?.status || 'unknown' },
      metadata: { orgId },
      req,
    });

    res.json(result);
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] retry webhook DLQ failed:', err.message);
    res.status(500).json({ error: 'failed to retry webhook DLQ item' });
  }
});

// ─── API keys (ratchet 45, org-scoped) ──────────────────────────────
// Bearer tokens for programmatic access. Created by an ADMIN+ member;
// the full plaintext is returned exactly once. List + delete are
// gated to the same role. See services/api-keys-service.js.
const apiKeysService = require('../services/api-keys-service');

function validateApiKeyName(name) {
  if (typeof name !== 'string') return 'name is required';
  const trimmed = name.trim();
  if (!trimmed) return 'name is required';
  if (trimmed.length > 80) return 'name too long (max 80)';
  return null;
}

function validateApiKeyScopes(scopes) {
  if (scopes === undefined || scopes === null) return { ok: true, value: [] };
  if (!Array.isArray(scopes)) return { ok: false, error: 'scopes must be an array' };
  if (scopes.length > 32) return { ok: false, error: 'too many scopes (max 32)' };
  const out = [];
  for (const s of scopes) {
    if (typeof s !== 'string') return { ok: false, error: 'each scope must be a string' };
    const trimmed = s.trim();
    if (!trimmed) continue;
    if (trimmed.length > 64) return { ok: false, error: 'scope too long (max 64)' };
    if (!/^[a-z0-9:_.-]+$/i.test(trimmed)) return { ok: false, error: 'invalid scope format' };
    out.push(trimmed);
  }
  return { ok: true, value: out };
}

function validateApiKeyExpiresAt(input) {
  if (input === undefined || input === null || input === '') return { ok: true, value: null };
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return { ok: false, error: 'expiresAt must be a valid date' };
  if (d.getTime() <= Date.now()) return { ok: false, error: 'expiresAt must be in the future' };
  return { ok: true, value: d };
}

// ─── POST /api/orgs/:id/api-keys (ADMIN+) ───────────────────────────
router.post('/:id/api-keys', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;

  const nameErr = validateApiKeyName(req.body?.name);
  if (nameErr) return res.status(400).json({ error: nameErr });
  const scopesResult = validateApiKeyScopes(req.body?.scopes);
  if (!scopesResult.ok) return res.status(400).json({ error: scopesResult.error });
  const expiresResult = validateApiKeyExpiresAt(req.body?.expiresAt);
  if (!expiresResult.ok) return res.status(400).json({ error: expiresResult.error });

  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to create api keys' });
    }

    const minted = apiKeysService.generateToken();
    const row = await prisma.apiKey.create({
      data: {
        name: req.body.name.trim(),
        prefix: minted.prefix,
        tokenHash: minted.tokenHash,
        organizationId: orgId,
        userId,
        scopes: scopesResult.value,
        expiresAt: expiresResult.value,
      },
    });

    void writeAuditLog(prisma, {
      action: 'org_api_key_create',
      userId,
      resource: 'organization',
      resourceId: orgId,
      after: { apiKeyId: row.id, prefix: row.prefix, scopes: row.scopes },
      metadata: { orgId },
      req,
    });

    res.status(201).json({ apiKey: apiKeysService.presentNewKey(row, minted.token) });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] create api key failed:', err.message);
    res.status(500).json({ error: 'failed to create api key' });
  }
});

// ─── GET /api/orgs/:id/api-keys (ADMIN+) ────────────────────────────
// Supports ?page= (1-based) & ?limit= (default 50, max 200) and ?q=
// for filtering by name (case-insensitive contains) or exact prefix
// match. The two filters are combinable with pagination.
router.get('/:id/api-keys', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to list api keys' });
    }

    const rawLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 200)
      : 50;
    const rawPage = Number.parseInt(req.query.page, 10);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    // Ratchet 45 (TrueDelete) — hide soft-deleted (tombstoned) keys from
    // the org-facing list. Admins who need to see purged keys hit the
    // dedicated admin endpoint.
    const baseWhere = { organizationId: orgId, deletedAt: null };
    const where = q
      ? {
          ...baseWhere,
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { prefix: q },
          ],
        }
      : baseWhere;

    const total = await prisma.apiKey.count({ where });
    const pages = total === 0 ? 0 : Math.ceil(total / limit);
    const rows = await prisma.apiKey.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const items = rows.map((r) => apiKeysService.redactKey(r));
    // Keep the legacy `apiKeys` field for back-compat with older clients
    // while exposing the new {items,total,page,pages} shape.
    res.json({ items, total, page, pages, apiKeys: items });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] list api keys failed:', err.message);
    res.status(500).json({ error: 'failed to list api keys' });
  }
});

// ─── POST /api/orgs/:id/api-keys/bulk-revoke (ADMIN+, ratchet 45) ───
// Bulk soft-delete up to 50 keys in a single round-trip. Body: { ids:
// string[] }. Returns { revoked: string[], notFound: string[] } so the
// caller can reconcile which ids were actually tombstoned vs. were
// already deleted / belong to another org. We intentionally do NOT
// fail the whole request when some ids are unknown — partial success
// is the useful behaviour here (e.g. a stale UI list). Each successful
// revocation gets its own audit-log entry, matching the single-delete
// endpoint. Must be declared BEFORE the `:keyId` route so Express
// doesn't treat "bulk-revoke" as a key id.
router.post('/:id/api-keys/bulk-revoke', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;

  const ids = req.body && Array.isArray(req.body.ids) ? req.body.ids : null;
  if (!ids) return res.status(400).json({ error: 'ids must be an array' });
  if (ids.length === 0) return res.status(400).json({ error: 'ids must not be empty' });
  if (ids.length > 50) return res.status(400).json({ error: 'too many ids (max 50)' });
  for (const id of ids) {
    if (typeof id !== 'string' || !id) {
      return res.status(400).json({ error: 'each id must be a non-empty string' });
    }
  }

  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to revoke api keys' });
    }

    // Dedupe to avoid double-counting when callers pass the same id twice.
    const uniqueIds = Array.from(new Set(ids));
    const revoked = [];
    const notFound = [];
    for (const keyId of uniqueIds) {
      // eslint-disable-next-line no-await-in-loop
      const tombstoned = await prisma.apiKey.updateMany({
        where: { id: keyId, organizationId: orgId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      if (tombstoned.count === 0) {
        notFound.push(keyId);
        continue;
      }
      revoked.push(keyId);
      void writeAuditLog(prisma, {
        action: 'org_api_key_delete',
        userId,
        resource: 'organization',
        resourceId: orgId,
        before: { apiKeyId: keyId },
        metadata: { orgId, softDelete: true, bulk: true },
        req,
      });
    }
    res.json({ revoked, notFound });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] bulk revoke api keys failed:', err.message);
    res.status(500).json({ error: 'failed to bulk revoke api keys' });
  }
});

// ─── GET /api/orgs/:id/api-keys.csv (ADMIN+, ratchet 45) ────────────
// Export all org API keys (including tombstoned) as RFC4180 CSV. The
// shape mirrors redactKey() minus the unique secret bits — id, name,
// prefix, scopes (joined with `;`), createdAt, lastUsedAt, expiresAt,
// isDeleted. Returns the full set in createdAt-desc order without
// pagination because this is an export, not a paged read.
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  // RFC4180: wrap in double-quotes when the field contains a quote,
  // comma, CR or LF; double any embedded quotes.
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toIsoOrEmpty(d) {
  if (!d) return '';
  if (d instanceof Date) return d.toISOString();
  return String(d);
}

router.get('/:id/api-keys.csv', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to export api keys' });
    }

    const rows = await prisma.apiKey.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
    });

    const header = ['id', 'name', 'prefix', 'scopes', 'createdAt', 'lastUsedAt', 'expiresAt', 'isDeleted'];
    const lines = [header.join(',')];
    for (const r of rows) {
      const scopes = Array.isArray(r.scopes) ? r.scopes.join(';') : '';
      lines.push([
        csvEscape(r.id),
        csvEscape(r.name),
        csvEscape(r.prefix),
        csvEscape(scopes),
        csvEscape(toIsoOrEmpty(r.createdAt)),
        csvEscape(toIsoOrEmpty(r.lastUsedAt)),
        csvEscape(toIsoOrEmpty(r.expiresAt)),
        csvEscape(r.deletedAt ? 'true' : 'false'),
      ].join(','));
    }
    // RFC4180 uses CRLF line endings.
    const body = lines.join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="org-${orgId}-api-keys.csv"`);
    res.status(200).send(body);
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] export api keys csv failed:', err.message);
    res.status(500).json({ error: 'failed to export api keys' });
  }
});

// ─── DELETE /api/orgs/:id/api-keys/:keyId (ADMIN+) ──────────────────
router.delete('/:id/api-keys/:keyId', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  const keyId = req.params.keyId;
  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to delete api keys' });
    }
    // Ratchet 45 (TrueDelete) — soft-delete: stamp `deletedAt` instead
    // of removing the row so audit log / cost rows referencing this key
    // remain attributable. The auth middleware rejects any key whose
    // `deletedAt` is set, so revocation is immediate. We scope the
    // update to (id, organizationId, deletedAt:null) so a double-delete
    // returns a clean 404 instead of silently no-op'ing.
    const tombstoned = await prisma.apiKey.updateMany({
      where: { id: keyId, organizationId: orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (tombstoned.count === 0) return res.status(404).json({ error: 'api key not found' });
    void writeAuditLog(prisma, {
      action: 'org_api_key_delete',
      userId,
      resource: 'organization',
      resourceId: orgId,
      before: { apiKeyId: keyId },
      metadata: { orgId, softDelete: true },
      req,
    });
    res.json({ ok: true, softDeleted: true });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] delete api key failed:', err.message);
    res.status(500).json({ error: 'failed to delete api key' });
  }
});

// ─── POST /api/orgs/:id/api-keys/:keyId/rotate (ADMIN+) ─────────────
// Mints a fresh secret for an existing key. The full plaintext is
// returned exactly once, exactly like creation. The row's tokenHash +
// prefix are replaced atomically so the previous secret stops
// authenticating immediately — unless the operator opts into a short
// grace window via the API_KEY_GRACE_HOURS env var (≤ 168h / 7d). The
// grace window is implemented by cloning the *old* hash into a new
// short-lived ApiKey row tagged `<name> (rotated grace)` with the
// requested expiresAt, so existing callers keep working while they
// roll out the new token. The grace clone is org/user-scoped exactly
// like the parent row.
function parseGraceHours(input) {
  // Caller override wins; otherwise read env. Anything <= 0 disables
  // the grace window. Clamp at 168h (one week) to avoid leaving stale
  // hashes lying around indefinitely.
  const raw = input ?? process.env.API_KEY_GRACE_HOURS;
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 168);
}

router.post('/:id/api-keys/:keyId/rotate', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  const keyId = req.params.keyId;

  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to rotate api keys' });
    }

    const existing = await prisma.apiKey.findFirst({
      where: { id: keyId, organizationId: orgId },
    });
    if (!existing) return res.status(404).json({ error: 'api key not found' });

    const graceHours = parseGraceHours(req.body?.graceHours);
    const minted = apiKeysService.generateToken();

    // Snapshot old hash/prefix BEFORE we overwrite the row so we can
    // optionally seed the grace clone with the original secret.
    const oldHash = existing.tokenHash;
    const oldPrefix = existing.prefix;

    // Replace the secret in-place. Keep name, scopes, expiresAt etc.
    const updated = await prisma.apiKey.update({
      where: { id: existing.id },
      data: { prefix: minted.prefix, tokenHash: minted.tokenHash, lastUsedAt: null },
    });

    let graceRow = null;
    if (graceHours > 0) {
      const expiresAt = new Date(Date.now() + graceHours * 3600 * 1000);
      try {
        graceRow = await prisma.apiKey.create({
          data: {
            name: `${existing.name} (rotated grace)`,
            prefix: oldPrefix,
            tokenHash: oldHash,
            organizationId: existing.organizationId,
            userId: existing.userId,
            scopes: Array.isArray(existing.scopes) ? [...existing.scopes] : [],
            expiresAt,
          },
        });
      } catch (e) {
        // Grace is best-effort — if the clone insert collides on the
        // unique(tokenHash) index (extremely unlikely with 240-bit
        // entropy, but possible if a previous rotation already created
        // a grace row for the same key) we log and continue. The
        // rotation itself still succeeds.
        console.warn('[orgs] api key grace clone failed:', e && e.message);
      }
    }

    void writeAuditLog(prisma, {
      action: 'org_api_key_rotate',
      userId,
      resource: 'organization',
      resourceId: orgId,
      before: { apiKeyId: existing.id, prefix: oldPrefix },
      after: {
        apiKeyId: existing.id,
        prefix: updated.prefix,
        graceHours,
        graceKeyId: graceRow ? graceRow.id : null,
      },
      metadata: { orgId },
      req,
    });

    res.status(200).json({
      apiKey: apiKeysService.presentNewKey(updated, minted.token),
      grace: graceRow
        ? {
            apiKeyId: graceRow.id,
            expiresAt: graceRow.expiresAt instanceof Date
              ? graceRow.expiresAt.toISOString()
              : graceRow.expiresAt,
            hours: graceHours,
          }
        : null,
    });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] rotate api key failed:', err.message);
    res.status(500).json({ error: 'failed to rotate api key' });
  }
});

// ─── GET /api/orgs/:id/api-keys/:keyId/usage (ADMIN+, ratchet 45) ───
// Surfaces the sampled per-scope + per-endpoint usage aggregates that
// requireScope() populates fire-and-forget. Counts are upscaled
// approximations (1-in-50 sampler), not exact totals. Returns 404 when
// the key isn't part of this org or has been soft-deleted.
router.get('/:id/api-keys/:keyId/usage', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  const keyId = req.params.keyId;
  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to read api key usage' });
    }
    const row = await prisma.apiKey.findFirst({
      where: { id: keyId, organizationId: orgId, deletedAt: null },
      select: { id: true, prefix: true, name: true, usedScopes: true, usedEndpoints: true, lastUsedAt: true },
    });
    if (!row) return res.status(404).json({ error: 'api key not found' });
    res.json({
      apiKeyId: row.id,
      prefix: row.prefix,
      name: row.name,
      lastUsedAt: row.lastUsedAt,
      usedScopes: row.usedScopes && typeof row.usedScopes === 'object' ? row.usedScopes : {},
      usedEndpoints: row.usedEndpoints && typeof row.usedEndpoints === 'object' ? row.usedEndpoints : {},
    });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] api key usage failed:', err.message);
    res.status(500).json({ error: 'failed to load api key usage' });
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

// Plan → maximum org member count (ratchet 45). FREE tops out at 3 so
// hobby orgs can't silently become full teams; ENTERPRISE is unlimited
// (represented as null in API responses, +Infinity for arithmetic).
// `/api/orgs/:id/invite` and the invitation-accept route both check
// `(currentMembers + pendingInvites)` against this cap and return 402
// Payment Required when an invite would push the org over.
const PLAN_MEMBER_CAPS = Object.freeze({
  FREE: 3,
  PRO: 10,
  PRO_MAX: 50,
  ENTERPRISE: Infinity,
});

function quotaForPlan(plan) {
  return PLAN_QUOTAS[plan] ?? PLAN_QUOTAS.FREE;
}

function memberCapForPlan(plan) {
  const cap = PLAN_MEMBER_CAPS[plan];
  return typeof cap === 'number' ? cap : PLAN_MEMBER_CAPS.FREE;
}

// Serializer for the API: Infinity is not valid JSON, so represent
// "no cap" as null. Finite numbers are passed through verbatim.
function serializeMemberCap(cap) {
  return Number.isFinite(cap) ? cap : null;
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

// ─── GET /api/orgs/:id/limits (any member; ratchet 45) ──────────────
// Aggregated quota/usage snapshot the dashboard renders next to the
// "Upgrade" CTA. Returns the plan, current member-count usage + cap,
// and the monthly request quota usage + cap. ENTERPRISE returns
// `cap: null` for unlimited tiers (Infinity is not valid JSON).
router.get('/:id/limits', authenticateToken, async (req, res) => {
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
      },
    });
    if (!org) return res.status(404).json({ error: 'organization not found' });

    const plan = org.billingPlan || 'FREE';
    const now = new Date();
    const [memberCount, pendingInvites] = await Promise.all([
      prisma.orgMembership.count({ where: { orgId } }),
      prisma.orgInvitation.count({
        where: { orgId, acceptedAt: null, expiresAt: { gt: now } },
      }),
    ]);
    const cap = memberCapForPlan(plan);

    res.json({
      plan,
      members: {
        used: memberCount + pendingInvites,
        active: memberCount,
        pending: pendingInvites,
        cap: serializeMemberCap(cap),
      },
      monthlyQuota: {
        used: toBigIntString(org.usedThisMonth),
        cap: toBigIntString(org.monthlyQuota),
        percentUsed: computePercentUsed(org.usedThisMonth, org.monthlyQuota),
      },
    });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] limits summary failed:', err.message);
    res.status(500).json({ error: 'failed to load limits' });
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
    await assertMembership(db, orgId, userId, 'VIEWER', { user: req.user });
    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { settings: true },
    });
    if (!org) return res.status(404).json({ error: 'organization not found' });
    res.json({ settings: org.settings && typeof org.settings === 'object' ? org.settings : {} });
  } catch (err) {
    if (err && err.status) {
      const body = { error: err.message };
      if (err.code) body.code = err.code;
      return res.status(err.status).json(body);
    }
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
    const membership = await assertMembership(db, orgId, userId, 'ADMIN', { user: req.user });
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
    if (err && err.status) {
      const body = { error: err.message };
      if (err.code) body.code = err.code;
      return res.status(err.status).json(body);
    }
    console.error('[orgs] patch settings failed:', err.message);
    res.status(500).json({ error: 'failed to update settings' });
  }
}

router.get('/:id/settings', authenticateToken, (req, res) => getOrgSettingsHandler(req, res));
router.patch('/:id/settings', authenticateToken, (req, res) => patchOrgSettingsHandler(req, res));

// ─── Security policy (ratchet 45) ───────────────────────────────────
// POST /api/orgs/:id/security — OWNER-only. Toggles the org-level 2FA
// enforcement flag, persisted under `settings.security.requireTwoFactor`.
// When enabled, members without an enrolled SMS or TOTP factor are
// blocked from creating sessions or fetching org-scoped data — they
// receive a 403 with error code `org_requires_2fa` so the FE can route
// them to the 2FA enrolment flow before retrying.
//
// Body: { requireTwoFactor: boolean }
async function postOrgSecurityHandler(req, res, deps = { prisma, writeAuditLog }) {
  const db = deps.prisma || prisma;
  const audit = deps.writeAuditLog || writeAuditLog;
  const userId = req.user.id;
  const orgId = req.params.id;
  const body = req.body || {};
  if (typeof body.requireTwoFactor !== 'boolean') {
    return res.status(400).json({ error: 'requireTwoFactor must be a boolean' });
  }
  try {
    const caller = await assertMembership(db, orgId, userId, 'OWNER');
    if (caller.role !== 'OWNER') {
      return res.status(403).json({ error: 'only OWNER can change security policy' });
    }
    const existing = await db.organization.findUnique({
      where: { id: orgId },
      select: { settings: true },
    });
    if (!existing) return res.status(404).json({ error: 'organization not found' });
    const before = existing.settings && typeof existing.settings === 'object' && !Array.isArray(existing.settings)
      ? existing.settings
      : {};
    const security = before.security && typeof before.security === 'object' && !Array.isArray(before.security)
      ? before.security
      : {};
    const nextSecurity = { ...security, requireTwoFactor: body.requireTwoFactor };
    const merged = { ...before, security: nextSecurity };
    const updated = await db.organization.update({
      where: { id: orgId },
      data: { settings: merged },
      select: { settings: true },
    });
    void audit(db, {
      action: 'org_security_update',
      userId,
      resource: 'organization',
      resourceId: orgId,
      before: { security },
      after: { security: nextSecurity },
      metadata: { orgId, requireTwoFactor: body.requireTwoFactor },
      req,
    });
    res.json({
      security: (updated.settings && updated.settings.security) || nextSecurity,
    });
  } catch (err) {
    if (err && err.status) {
      const body = { error: err.message };
      if (err.code) body.code = err.code;
      return res.status(err.status).json(body);
    }
    console.error('[orgs] post security failed:', err.message);
    res.status(500).json({ error: 'failed to update security policy' });
  }
}

router.post('/:id/security', authenticateToken, (req, res) => postOrgSecurityHandler(req, res));

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

// ─── SSO scaffold (ratchet 45) ──────────────────────────────────────
// Minimal data-model + endpoints for org-level SAML/OIDC SSO. The actual
// SAML / OIDC handshake is **not** implemented yet — these handlers only
// persist the provider configuration on the org row and return 501 from
// the login / callback endpoints (registered in routes/auth.js) so the
// FE can wire its config UI and integration tests can assert the
// contract without a real IdP.
//
// Body shape (POST /api/orgs/:id/sso):
//   {
//     provider:    'saml' | 'oidc',
//     entryPoint:  string  (SAML SSO URL or OIDC authorize URL),
//     issuer:      string  (SP entityId / OIDC client_id),
//     callbackUrl: string  (absolute https URL we'll register with IdP),
//     cert?:       string  (PEM-encoded x509 — SAML),
//     clientSecret?: string (OIDC),
//     audience?:   string,
//     enabled?:    boolean (defaults to current value or false),
//   }
//
// Validation here is shape-only; the contents are stored verbatim as a
// JSON bag so we can add provider-specific knobs later without another
// migration. Owners only.

const SSO_PROVIDERS = Object.freeze(['saml', 'oidc']);

function sanitizeSsoConfig(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    const e = new Error('sso config must be a JSON object');
    e.status = 400;
    throw e;
  }
  const provider = typeof input.provider === 'string' ? input.provider.trim().toLowerCase() : '';
  if (!SSO_PROVIDERS.includes(provider)) {
    const e = new Error(`provider must be one of ${SSO_PROVIDERS.join(',')}`);
    e.status = 400;
    throw e;
  }
  const requireStr = (key, max = 2048) => {
    const v = input[key];
    if (typeof v !== 'string' || !v.trim()) {
      const e = new Error(`${key} is required`);
      e.status = 400;
      throw e;
    }
    if (v.length > max) {
      const e = new Error(`${key} too long`);
      e.status = 400;
      throw e;
    }
    return v.trim();
  };
  const optStr = (key, max = 16384) => {
    const v = input[key];
    if (v == null) return undefined;
    if (typeof v !== 'string') {
      const e = new Error(`${key} must be a string`);
      e.status = 400;
      throw e;
    }
    if (v.length > max) {
      const e = new Error(`${key} too long`);
      e.status = 400;
      throw e;
    }
    return v.trim();
  };
  const entryPoint = requireStr('entryPoint');
  const issuer = requireStr('issuer', 512);
  const callbackUrl = requireStr('callbackUrl');
  if (!/^https?:\/\//i.test(entryPoint) || !/^https?:\/\//i.test(callbackUrl)) {
    const e = new Error('entryPoint and callbackUrl must be http(s) URLs');
    e.status = 400;
    throw e;
  }
  const config = {
    provider,
    entryPoint,
    issuer,
    callbackUrl,
  };
  const cert = optStr('cert');
  if (cert !== undefined) config.cert = cert;
  const clientSecret = optStr('clientSecret', 1024);
  if (clientSecret !== undefined) config.clientSecret = clientSecret;
  const audience = optStr('audience', 512);
  if (audience !== undefined) config.audience = audience;
  return config;
}

function redactSsoConfig(config) {
  if (!config || typeof config !== 'object') return null;
  const out = { ...config };
  if (typeof out.clientSecret === 'string' && out.clientSecret.length > 0) {
    out.clientSecret = '***redacted***';
  }
  if (typeof out.cert === 'string' && out.cert.length > 0) {
    // Surface only the first/last few chars so admins can confirm the
    // right cert is installed without exposing it wholesale on every read.
    out.cert = `${out.cert.slice(0, 32)}…${out.cert.slice(-32)}`;
  }
  return out;
}

async function configureOrgSsoHandler(req, res, deps = { prisma, writeAuditLog }) {
  const db = deps.prisma || prisma;
  const audit = deps.writeAuditLog || writeAuditLog;
  const userId = req.user.id;
  const orgId = req.params.id;
  try {
    const membership = await assertMembership(db, orgId, userId, 'OWNER');
    if (membership.role !== 'OWNER') {
      return res.status(403).json({ error: 'only the OWNER can configure SSO' });
    }
    let config;
    try {
      config = sanitizeSsoConfig(req.body);
    } catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message });
      throw e;
    }
    const enabled = typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined;
    const existing = await db.organization.findUnique({
      where: { id: orgId },
      select: { ssoConfig: true, ssoEnabled: true },
    });
    if (!existing) return res.status(404).json({ error: 'organization not found' });
    const nextEnabled = enabled == null ? !!existing.ssoEnabled : enabled;
    const updated = await db.organization.update({
      where: { id: orgId },
      data: { ssoConfig: config, ssoEnabled: nextEnabled },
      select: { ssoConfig: true, ssoEnabled: true },
    });
    void audit(db, {
      action: 'org_sso_configure',
      userId,
      resource: 'organization',
      resourceId: orgId,
      before: { ssoConfigured: !!existing.ssoConfig, ssoEnabled: !!existing.ssoEnabled },
      after: { ssoConfigured: !!updated.ssoConfig, ssoEnabled: !!updated.ssoEnabled, provider: config.provider },
      metadata: { orgId, provider: config.provider },
      req,
    });
    // Scaffold only — flag the response so callers/tests know the
    // handshake itself is not implemented yet.
    res.status(501).json({
      ok: true,
      implemented: false,
      message: 'SSO configuration stored; SAML/OIDC handshake not implemented',
      ssoEnabled: !!updated.ssoEnabled,
      ssoConfig: redactSsoConfig(updated.ssoConfig),
    });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] configure sso failed:', err.message);
    res.status(500).json({ error: 'failed to configure sso' });
  }
}

router.post('/:id/sso', authenticateToken, (req, res) => configureOrgSsoHandler(req, res));

// ─── SSO domain claim (ratchet 45) ──────────────────────────────────
// Owners can register/unregister email domains that route to this org's
// SSO. At login time, if the user's email domain matches a claimed
// domain on an org with `ssoEnabled = true`, the password handler
// short-circuits with a 501 SSO-redirect placeholder (the actual
// SAML/OIDC handshake still ships in a later ratchet).
//
// Body shape (POST /api/orgs/:id/sso/domains):
//   {
//     add?:    string[]   // domains to add (e.g. ["acme.com"])
//     remove?: string[]   // domains to remove
//   }
// Domains are lowercased + stripped of any leading "@" or scheme.
// At least one of `add` / `remove` must be a non-empty array.

const SSO_DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const MAX_SSO_DOMAINS = 32;

function normalizeSsoDomain(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  // Strip leading "@" (so "@acme.com" works) and any scheme/path the
  // caller might paste from an IdP config screen.
  s = s.replace(/^@+/, '');
  s = s.replace(/^https?:\/\//, '');
  s = s.split('/')[0];
  s = s.split(':')[0]; // drop port if any
  if (!SSO_DOMAIN_RE.test(s)) return null;
  return s;
}

function sanitizeSsoDomainList(input, field) {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    const e = new Error(`${field} must be an array of domain strings`);
    e.status = 400;
    throw e;
  }
  const out = [];
  for (const raw of input) {
    const norm = normalizeSsoDomain(raw);
    if (!norm) {
      const e = new Error(`${field}: invalid domain "${String(raw).slice(0, 64)}"`);
      e.status = 400;
      throw e;
    }
    if (!out.includes(norm)) out.push(norm);
  }
  return out;
}

async function configureOrgSsoDomainsHandler(req, res, deps = { prisma, writeAuditLog }) {
  const db = deps.prisma || prisma;
  const audit = deps.writeAuditLog || writeAuditLog;
  const userId = req.user.id;
  const orgId = req.params.id;
  try {
    const membership = await assertMembership(db, orgId, userId, 'OWNER');
    if (membership.role !== 'OWNER') {
      return res.status(403).json({ error: 'only the OWNER can manage SSO domains' });
    }
    let toAdd;
    let toRemove;
    try {
      toAdd = sanitizeSsoDomainList(req.body?.add, 'add');
      toRemove = sanitizeSsoDomainList(req.body?.remove, 'remove');
    } catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message });
      throw e;
    }
    if (toAdd.length === 0 && toRemove.length === 0) {
      return res.status(400).json({ error: 'provide at least one domain to add or remove' });
    }
    const existing = await db.organization.findUnique({
      where: { id: orgId },
      select: { ssoDomains: true },
    });
    if (!existing) return res.status(404).json({ error: 'organization not found' });
    const before = Array.isArray(existing.ssoDomains) ? existing.ssoDomains.slice() : [];
    const removeSet = new Set(toRemove);
    const next = before.filter((d) => !removeSet.has(d));
    for (const d of toAdd) {
      if (!next.includes(d)) next.push(d);
    }
    if (next.length > MAX_SSO_DOMAINS) {
      return res.status(400).json({ error: `at most ${MAX_SSO_DOMAINS} SSO domains allowed` });
    }
    const updated = await db.organization.update({
      where: { id: orgId },
      data: { ssoDomains: next },
      select: { ssoDomains: true, ssoEnabled: true },
    });
    void audit(db, {
      action: 'org_sso_domains_update',
      userId,
      resource: 'organization',
      resourceId: orgId,
      before: { ssoDomains: before },
      after: { ssoDomains: updated.ssoDomains },
      metadata: { orgId, added: toAdd, removed: toRemove },
      req,
    });
    res.json({
      ok: true,
      ssoEnabled: !!updated.ssoEnabled,
      ssoDomains: updated.ssoDomains,
    });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] sso domains update failed:', err.message);
    res.status(500).json({ error: 'failed to update SSO domains' });
  }
}

router.post('/:id/sso/domains', authenticateToken, (req, res) => configureOrgSsoDomainsHandler(req, res));

// ─── Org-wide announcements (ratchet 45) ────────────────────────────
// ADMIN+ members can broadcast banner-style messages to every member
// of the org. The GET feed is open to any member of the org and only
// returns non-expired rows.
const ANNOUNCEMENT_SEVERITIES = new Set(['info', 'warn', 'critical']);
const ANNOUNCEMENT_TITLE_MAX = 200;
const ANNOUNCEMENT_BODY_MAX = 10_000;

function serializeAnnouncement(row) {
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.orgId,
    title: row.title,
    body: row.body,
    severity: row.severity,
    createdById: row.createdById,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    expiresAt: row.expiresAt
      ? row.expiresAt instanceof Date
        ? row.expiresAt.toISOString()
        : row.expiresAt
      : null,
  };
}

/**
 * Fire-and-forget bulk email broadcast for a `critical`-severity org
 * announcement (ratchet 45, Task 2). Loads every member of the org,
 * filters by the per-user `announcements` opt-out from email
 * preferences, then sends one message per opted-in member. Errors on
 * individual sends are swallowed so a single bad inbox doesn't poison
 * the whole broadcast. Returns the count of attempted/sent messages
 * for tests + audit-log consumers (exposed via `router.__announcements`).
 */
async function broadcastCriticalAnnouncement(db, orgId, created, content) {
  const emailService = require('../services/email');
  const emailPrefs = require('../services/email-preferences');
  if (!emailService.isConfigured || !emailService.isConfigured()) {
    return { attempted: 0, sent: 0, optedOut: 0 };
  }
  let members = [];
  let org = null;
  try {
    [members, org] = await Promise.all([
      db.orgMembership.findMany({
        where: { orgId },
        include: { user: { select: { id: true, email: true, name: true } } },
      }),
      db.organization.findUnique({
        where: { id: orgId },
        select: { id: true, name: true, slug: true },
      }).catch(() => null),
    ]);
  } catch (err) {
    console.error('[orgs] announcement broadcast load failed:', err?.message || err);
    return { attempted: 0, sent: 0, optedOut: 0 };
  }
  const orgRow = org || { id: orgId };
  const announcement = {
    id: created.id,
    title: content.title,
    body: content.body,
    severity: 'critical',
  };
  let attempted = 0;
  let sent = 0;
  let optedOut = 0;
  for (const m of members) {
    const u = m && m.user;
    if (!u || !u.email) continue;
    let optIn = true;
    try {
      optIn = await emailPrefs.shouldSendEmail(db, u.id, 'announcements');
    } catch (_) {
      optIn = true;
    }
    if (!optIn) { optedOut += 1; continue; }
    attempted += 1;
    try {
      const ok = await emailService.sendOrgAnnouncement(u, orgRow, announcement);
      if (ok) sent += 1;
    } catch (_) { /* per-recipient errors swallowed */ }
  }
  return { attempted, sent, optedOut };
}

// POST /api/orgs/:id/announcements (ADMIN+)
router.post('/:id/announcements', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to create announcements' });
    }

    const body = req.body || {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const text = typeof body.body === 'string' ? body.body.trim() : '';
    const severity = typeof body.severity === 'string' ? body.severity : 'info';
    if (!title || title.length > ANNOUNCEMENT_TITLE_MAX) {
      return res.status(400).json({ error: 'invalid title' });
    }
    if (!text || text.length > ANNOUNCEMENT_BODY_MAX) {
      return res.status(400).json({ error: 'invalid body' });
    }
    if (!ANNOUNCEMENT_SEVERITIES.has(severity)) {
      return res.status(400).json({ error: 'invalid severity' });
    }

    let expiresAt = null;
    if (body.expiresAt !== undefined && body.expiresAt !== null && body.expiresAt !== '') {
      const parsed = new Date(body.expiresAt);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ error: 'invalid expiresAt' });
      }
      if (parsed.getTime() <= Date.now()) {
        return res.status(400).json({ error: 'expiresAt must be in the future' });
      }
      expiresAt = parsed;
    }

    const created = await prisma.orgAnnouncement.create({
      data: {
        orgId,
        title,
        body: text,
        severity,
        createdById: userId,
        expiresAt,
      },
    });

    void writeAuditLog(prisma, {
      action: 'org_announcement_create',
      userId,
      resource: 'organization',
      resourceId: orgId,
      after: { announcementId: created.id, title, severity, expiresAt },
      metadata: { orgId },
      req,
    });

    // Ratchet 45, Task 1 — fan out a Zapier-style trigger so org
    // webhooks + Slack integrations receive the announcement. Fire-
    // and-forget; failures must not block the response.
    triggers.publish('org.announcement.created', {
      orgId,
      announcementId: created.id,
      title,
      severity,
      createdById: userId,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
    }, userId).catch(() => {});

    // Ratchet 45, Task 2 — critical announcements also email every
    // member of the org (respecting the per-user `announcements`
    // opt-out from email-preferences). Strictly fire-and-forget so a
    // slow SMTP path can't delay the 201; the broadcast runs on the
    // event loop after the response is sent.
    if (severity === 'critical') {
      setImmediate(() => {
        broadcastCriticalAnnouncement(prisma, orgId, created, { title, body: text })
          .catch((err) => console.error('[orgs] announcement broadcast failed:', err?.message || err));
      });
    }

    res.status(201).json({ announcement: serializeAnnouncement(created) });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] create announcement failed:', err.message);
    res.status(500).json({ error: 'failed to create announcement' });
  }
});

// GET /api/orgs/:id/announcements — any member, only non-expired rows.
// Ratchet 45 (Task 1) — paginated. Supports ?page=&limit= with default
// limit=20, max=100. Response shape: `{ items, total, page, pages }`.
router.get('/:id/announcements', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  try {
    await assertMembership(prisma, orgId, userId, 'VIEWER');

    const rawLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 100)
      : 20;
    const rawPage = Number.parseInt(req.query.page, 10);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

    const now = new Date();
    const where = {
      orgId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    };
    const total = typeof prisma.orgAnnouncement.count === 'function'
      ? await prisma.orgAnnouncement.count({ where })
      : (await prisma.orgAnnouncement.findMany({ where })).length;
    const pages = total === 0 ? 0 : Math.ceil(total / limit);
    const rows = await prisma.orgAnnouncement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });

    // Ratchet 45 — per-user read acknowledgements. Join against
    // OrgAnnouncementRead for the requesting user so each item exposes
    // `acknowledgedByCurrentUser`. Falls back to `false` when the
    // table/model isn't available (older test fakes).
    let ackedIds = new Set();
    if (rows.length && prisma.orgAnnouncementRead && typeof prisma.orgAnnouncementRead.findMany === 'function') {
      try {
        const reads = await prisma.orgAnnouncementRead.findMany({
          where: { userId, announcementId: { in: rows.map((r) => r.id) } },
          select: { announcementId: true },
        });
        ackedIds = new Set(reads.map((r) => r.announcementId));
      } catch (_) { /* swallow — degrade to all-false */ }
    }

    const items = rows.map((row) => ({
      ...serializeAnnouncement(row),
      acknowledgedByCurrentUser: ackedIds.has(row.id),
    }));
    res.json({ items, total, page, pages });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] list announcements failed:', err.message);
    res.status(500).json({ error: 'failed to list announcements' });
  }
});

// GET /api/orgs/:id/announcements/unread — any member.
// Ratchet 45 (Task 2) — returns non-expired announcements for the org
// that the requesting user has NOT yet acknowledged. Used by the UI
// badge / inbox. Newest-first. No pagination — callers should keep the
// unread list small by acking; we cap the response at 100 items.
router.get('/:id/announcements/unread', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  try {
    await assertMembership(prisma, orgId, userId, 'VIEWER');

    const now = new Date();
    const where = {
      orgId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    };
    const rows = await prisma.orgAnnouncement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    let ackedIds = new Set();
    if (rows.length && prisma.orgAnnouncementRead && typeof prisma.orgAnnouncementRead.findMany === 'function') {
      try {
        const reads = await prisma.orgAnnouncementRead.findMany({
          where: { userId, announcementId: { in: rows.map((r) => r.id) } },
          select: { announcementId: true },
        });
        ackedIds = new Set(reads.map((r) => r.announcementId));
      } catch (_) { /* degrade — treat all as unread */ }
    }

    const items = rows
      .filter((row) => !ackedIds.has(row.id))
      .slice(0, 100)
      .map((row) => serializeAnnouncement(row));
    res.json({ items, total: items.length });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] list unread announcements failed:', err.message);
    res.status(500).json({ error: 'failed to list unread announcements' });
  }
});

// GET /api/orgs/:id/announcements/:announcementId/reads (ADMIN+)
// Ratchet 45 (Task 1) — returns per-announcement read statistics:
// `{ announcementId, readCount, totalMembers, percentRead, readers }`.
// `readers` is the array of `{ userId, email, readAt }` for members who
// have acknowledged. `percentRead` is an integer 0..100.
router.get('/:id/announcements/:announcementId/reads', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  const announcementId = req.params.announcementId;
  if (!announcementId) return res.status(400).json({ error: 'invalid announcementId' });

  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to read announcement stats' });
    }

    const existing = await prisma.orgAnnouncement.findUnique({
      where: { id: announcementId },
      select: { id: true, orgId: true },
    });
    if (!existing || existing.orgId !== orgId) {
      return res.status(404).json({ error: 'announcement not found' });
    }

    // Total member count for the org.
    let totalMembers = 0;
    if (typeof prisma.orgMembership.count === 'function') {
      try {
        totalMembers = await prisma.orgMembership.count({ where: { orgId } });
      } catch (_) { totalMembers = 0; }
    }
    if (!totalMembers && typeof prisma.orgMembership.findMany === 'function') {
      try {
        const ms = await prisma.orgMembership.findMany({ where: { orgId }, select: { id: true } });
        totalMembers = Array.isArray(ms) ? ms.length : 0;
      } catch (_) { /* leave as 0 */ }
    }

    // Load read receipts (with user email for the readers list).
    let reads = [];
    if (prisma.orgAnnouncementRead && typeof prisma.orgAnnouncementRead.findMany === 'function') {
      try {
        reads = await prisma.orgAnnouncementRead.findMany({
          where: { announcementId },
          include: { user: { select: { id: true, email: true } } },
        });
      } catch (_) {
        // Fall back to plain findMany (no join) if `include` not supported.
        try {
          reads = await prisma.orgAnnouncementRead.findMany({ where: { announcementId } });
        } catch (_) { reads = []; }
      }
    }
    if (!Array.isArray(reads)) reads = [];

    const readers = reads.map((r) => {
      const u = r && r.user;
      return {
        userId: r.userId,
        email: u && u.email ? u.email : null,
        readAt: r.readAt instanceof Date
          ? r.readAt.toISOString()
          : (r.readAt || null),
      };
    });
    const readCount = readers.length;
    const percentRead = totalMembers > 0
      ? Math.round((readCount / totalMembers) * 100)
      : 0;

    res.json({
      announcementId,
      readCount,
      totalMembers,
      percentRead,
      readers,
    });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] read announcement stats failed:', err.message);
    res.status(500).json({ error: 'failed to load announcement reads' });
  }
});

// POST /api/orgs/:id/announcements/:announcementId/ack — any member.
// Ratchet 45 — records a per-user read receipt and fires the
// `org.announcement.acknowledged` trigger. Idempotent: repeat acks
// from the same user return the existing receipt and do NOT re-fire
// the trigger so webhooks don't see duplicates.
router.post('/:id/announcements/:announcementId/ack', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  const announcementId = req.params.announcementId;
  if (!announcementId) return res.status(400).json({ error: 'invalid announcementId' });

  try {
    await assertMembership(prisma, orgId, userId, 'VIEWER');

    const existing = await prisma.orgAnnouncement.findUnique({
      where: { id: announcementId },
      select: { id: true, orgId: true },
    });
    if (!existing || existing.orgId !== orgId) {
      return res.status(404).json({ error: 'announcement not found' });
    }

    // Idempotency — look for an existing read receipt before insert.
    let alreadyAcked = false;
    let receipt = null;
    if (prisma.orgAnnouncementRead && typeof prisma.orgAnnouncementRead.findUnique === 'function') {
      try {
        receipt = await prisma.orgAnnouncementRead.findUnique({
          where: { announcementId_userId: { announcementId, userId } },
        });
        if (receipt) alreadyAcked = true;
      } catch (_) { /* fall through to create */ }
    }

    if (!receipt) {
      try {
        receipt = await prisma.orgAnnouncementRead.create({
          data: { announcementId, userId },
        });
      } catch (err) {
        // Unique-constraint race → treat as already-acked.
        if (err && (err.code === 'P2002' || /unique/i.test(err.message || ''))) {
          alreadyAcked = true;
          if (prisma.orgAnnouncementRead && typeof prisma.orgAnnouncementRead.findUnique === 'function') {
            receipt = await prisma.orgAnnouncementRead.findUnique({
              where: { announcementId_userId: { announcementId, userId } },
            }).catch(() => null);
          }
        } else {
          throw err;
        }
      }
    }

    // Fire-and-forget trigger only on first ack to avoid webhook spam.
    if (!alreadyAcked) {
      triggers.publish('org.announcement.acknowledged', {
        orgId,
        announcementId,
        userId,
      }, userId).catch(() => {});
    }

    res.status(alreadyAcked ? 200 : 201).json({
      ok: true,
      alreadyAcked,
      readAt: receipt && receipt.readAt
        ? (receipt.readAt instanceof Date ? receipt.readAt.toISOString() : receipt.readAt)
        : new Date().toISOString(),
    });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] ack announcement failed:', err.message);
    res.status(500).json({ error: 'failed to acknowledge announcement' });
  }
});

// PUT /api/orgs/:id/announcements/:announcementId (ADMIN+)
// Ratchet 45 (Task 2) — update title/body/severity/expiresAt. Audited.
router.put('/:id/announcements/:announcementId', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  const announcementId = req.params.announcementId;
  if (!announcementId) return res.status(400).json({ error: 'invalid announcementId' });

  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to update announcements' });
    }

    const existing = await prisma.orgAnnouncement.findUnique({
      where: { id: announcementId },
    });
    if (!existing || existing.orgId !== orgId) {
      return res.status(404).json({ error: 'announcement not found' });
    }

    const body = req.body || {};
    const data = {};

    if (body.title !== undefined) {
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!title || title.length > ANNOUNCEMENT_TITLE_MAX) {
        return res.status(400).json({ error: 'invalid title' });
      }
      data.title = title;
    }

    if (body.body !== undefined) {
      const text = typeof body.body === 'string' ? body.body.trim() : '';
      if (!text || text.length > ANNOUNCEMENT_BODY_MAX) {
        return res.status(400).json({ error: 'invalid body' });
      }
      data.body = text;
    }

    if (body.severity !== undefined) {
      if (typeof body.severity !== 'string' || !ANNOUNCEMENT_SEVERITIES.has(body.severity)) {
        return res.status(400).json({ error: 'invalid severity' });
      }
      data.severity = body.severity;
    }

    if (body.expiresAt !== undefined) {
      if (body.expiresAt === null || body.expiresAt === '') {
        data.expiresAt = null;
      } else {
        const parsed = new Date(body.expiresAt);
        if (Number.isNaN(parsed.getTime())) {
          return res.status(400).json({ error: 'invalid expiresAt' });
        }
        if (parsed.getTime() <= Date.now()) {
          return res.status(400).json({ error: 'expiresAt must be in the future' });
        }
        data.expiresAt = parsed;
      }
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'no fields to update' });
    }

    const updated = await prisma.orgAnnouncement.update({
      where: { id: existing.id },
      data,
    });

    void writeAuditLog(prisma, {
      action: 'org_announcement_update',
      userId,
      resource: 'organization',
      resourceId: orgId,
      before: {
        announcementId: existing.id,
        title: existing.title,
        body: existing.body,
        severity: existing.severity,
        expiresAt: existing.expiresAt,
      },
      after: {
        announcementId: updated.id,
        title: updated.title,
        body: updated.body,
        severity: updated.severity,
        expiresAt: updated.expiresAt,
      },
      metadata: { orgId },
      req,
    });

    res.json({ announcement: serializeAnnouncement(updated) });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] update announcement failed:', err.message);
    res.status(500).json({ error: 'failed to update announcement' });
  }
});

// DELETE /api/orgs/:id/announcements/:announcementId (ADMIN+)
router.delete('/:id/announcements/:announcementId', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const orgId = req.params.id;
  const announcementId = req.params.announcementId;
  if (!announcementId) return res.status(400).json({ error: 'invalid announcementId' });

  try {
    const membership = await assertMembership(prisma, orgId, userId, 'ADMIN');
    if (!canManageMembers(membership.role)) {
      return res.status(403).json({ error: 'insufficient role to delete announcements' });
    }

    const existing = await prisma.orgAnnouncement.findUnique({
      where: { id: announcementId },
      select: { id: true, orgId: true, title: true, severity: true },
    });
    if (!existing || existing.orgId !== orgId) {
      return res.status(404).json({ error: 'announcement not found' });
    }

    await prisma.orgAnnouncement.delete({ where: { id: existing.id } });

    void writeAuditLog(prisma, {
      action: 'org_announcement_delete',
      userId,
      resource: 'organization',
      resourceId: orgId,
      before: { announcementId: existing.id, title: existing.title, severity: existing.severity },
      metadata: { orgId },
      req,
    });

    res.json({ ok: true });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[orgs] delete announcement failed:', err.message);
    res.status(500).json({ error: 'failed to delete announcement' });
  }
});

// Expose constants for tests/inspection.
router.__roleAtLeast = roleAtLeast;
router.__handlers = {
  transferOwnership: transferOwnershipHandler,
  leaveOrg: leaveOrgHandler,
  listOrgAuditLogs: listOrgAuditLogsHandler,
  listMemberActivity: listMemberActivityHandler,
  getOrgSettings: getOrgSettingsHandler,
  patchOrgSettings: patchOrgSettingsHandler,
  postOrgSecurity: postOrgSecurityHandler,
  streamOrgEvents: streamOrgEventsHandler,
  usageTrend: usageTrendHandler,
};
router.__invalidateMembersCache = invalidateMembersCache;
router.__sseConfig = SSE_EVENTS;
router.__settingsHelpers = { sanitizeSettings, mergeSettings };
router.__ssoHelpers = { sanitizeSsoConfig, redactSsoConfig, SSO_PROVIDERS };
router.__ssoDomainHelpers = { normalizeSsoDomain, sanitizeSsoDomainList, MAX_SSO_DOMAINS };
router.__handlers.configureOrgSso = configureOrgSsoHandler;
router.__handlers.configureOrgSsoDomains = configureOrgSsoDomainsHandler;
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

router.__announcements = {
  ANNOUNCEMENT_SEVERITIES,
  ANNOUNCEMENT_TITLE_MAX,
  ANNOUNCEMENT_BODY_MAX,
  serializeAnnouncement,
  broadcastCriticalAnnouncement,
};

module.exports = router;
module.exports.INTERNAL_MEMBERS_CSV = {
  membersToCsv,
  membersCsvEscape,
  MEMBERS_CSV_COLUMNS,
  BULK_INVITE_MAX,
};

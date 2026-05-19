'use strict';

/**
 * org-onboarding — suggested next-action checklist for newly created
 * organizations (cycle 45).
 *
 * Each step has:
 *   - id            stable identifier
 *   - label         human-readable label
 *   - getProgress() async fn that probes the DB and returns `completed: boolean`
 *                   plus optional `metadata` (e.g. memberCount).
 *
 * Steps fail-soft: if the probe throws (mocked prisma in tests, table
 * missing in migration window, etc.), the step is reported `completed:
 * false` with a `_probeError` flag so the caller can still serialize.
 */

const STEPS = [
  {
    id: 'invite_team',
    label: 'Invite teammates',
    async getProgress({ prisma, orgId }) {
      if (!prisma?.orgMembership?.count) return { completed: false };
      const count = await prisma.orgMembership.count({ where: { orgId } });
      return { completed: count > 1, metadata: { memberCount: count } };
    },
  },
  {
    id: 'configure_billing',
    label: 'Configure billing',
    async getProgress({ prisma, orgId }) {
      if (!prisma?.organization?.findUnique) return { completed: false };
      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { billingPlan: true, stripeCustomerId: true },
      });
      if (!org) return { completed: false };
      const completed =
        (org.billingPlan && org.billingPlan !== 'FREE') || Boolean(org.stripeCustomerId);
      return { completed, metadata: { plan: org.billingPlan || 'FREE' } };
    },
  },
  {
    id: 'share_first_chat',
    label: 'Share a chat with the team',
    async getProgress({ prisma, orgId }) {
      if (!prisma?.orgChat?.count) return { completed: false };
      const count = await prisma.orgChat.count({ where: { orgId } });
      return { completed: count > 0, metadata: { chatCount: count } };
    },
  },
  {
    id: 'connect_integration',
    label: 'Connect an external integration',
    async getProgress({ prisma, orgId }) {
      if (!prisma?.orgIntegration?.count) return { completed: false };
      const count = await prisma.orgIntegration.count({ where: { orgId } });
      return { completed: count > 0, metadata: { integrationCount: count } };
    },
  },
  {
    id: 'set_owner_profile',
    label: 'Complete owner profile',
    async getProgress({ prisma, ownerId }) {
      if (!ownerId || !prisma?.user?.findUnique) return { completed: false };
      const user = await prisma.user.findUnique({
        where: { id: ownerId },
        select: { name: true, email: true },
      });
      if (!user) return { completed: false };
      const completed = Boolean(user.name && String(user.name).trim().length >= 2);
      return { completed };
    },
  },
  {
    // Checks whether the org owner has explicitly accepted the latest
    // Terms of Service. Probes PolicyAcceptance for the latest version
    // record keyed by the owner. Fail-soft when the table / relation
    // is missing (e.g. mocked prisma in tests).
    id: 'accept_legal',
    label: 'Accept latest Terms of Service',
    async getProgress({ prisma, ownerId }) {
      if (!ownerId || !prisma?.policyAcceptance?.findFirst) return { completed: false };
      const record = await prisma.policyAcceptance.findFirst({
        where: { userId: ownerId, document: 'terms-of-service', version: 'latest' },
      });
      return { completed: Boolean(record) };
    },
  },
  {
    // Placeholder for the 2FA enrollment step. The full flow lives in
    // user-security (cycle TBD); for the onboarding checklist we just
    // peek at the owner's `settings.twoFactorEnabled` flag.
    id: 'enable_2fa',
    label: 'Enable two-factor authentication',
    async getProgress({ prisma, ownerId }) {
      if (!ownerId || !prisma?.user?.findUnique) return { completed: false };
      const user = await prisma.user.findUnique({
        where: { id: ownerId },
        select: { settings: true },
      });
      const completed = Boolean(user?.settings?.twoFactorEnabled === true);
      return { completed };
    },
  },
];

/**
 * Build the default (all uncompleted) onboarding step list — used as
 * the immediate response of `POST /api/orgs` so the UI can render the
 * checklist before any progress probe runs.
 */
function defaultSteps() {
  return STEPS.map((s) => ({ id: s.id, label: s.label, completed: false }));
}

/**
 * Compute live progress for an org. Each step is probed independently
 * so a single failure doesn't poison the whole report.
 *
 * @param {object} args
 * @param {object} args.prisma
 * @param {string} args.orgId
 * @param {string} [args.ownerId]
 */
async function computeProgress({ prisma, orgId, ownerId }) {
  if (!orgId || typeof orgId !== 'string') {
    return { steps: defaultSteps(), completedCount: 0, totalCount: STEPS.length };
  }
  const probed = await Promise.all(
    STEPS.map(async (s) => {
      try {
        const r = await s.getProgress({ prisma, orgId, ownerId });
        return {
          id: s.id,
          label: s.label,
          completed: Boolean(r?.completed),
          ...(r?.metadata ? { metadata: r.metadata } : {}),
        };
      } catch (err) {
        return {
          id: s.id,
          label: s.label,
          completed: false,
          _probeError: err?.message || String(err),
        };
      }
    }),
  );
  const completedCount = probed.filter((s) => s.completed).length;
  return { steps: probed, completedCount, totalCount: STEPS.length };
}

module.exports = { defaultSteps, computeProgress, STEPS };

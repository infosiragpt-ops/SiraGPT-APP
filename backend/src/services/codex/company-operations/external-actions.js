'use strict';

const { createHash } = require('node:crypto');
const policy = require('./external-action-policy');
const { loadGmailClientForUser } = require('../../gmail-user-client');
const companyOperatingProfile = require('../company-operating-profile');

const EXTERNAL_ACTION_LOCK_CLASS = 0x0ea71;
const localLocks = new Map();

function hashInt32(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash | 0;
}

async function withLocalLock(key, operation) {
  const previous = localLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => gate);
  localLocks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (localLocks.get(key) === queued) localLocks.delete(key);
  }
}

function actionKey({ projectId, kind, targetRef }) {
  return createHash('sha256')
    .update(`${projectId}:${kind}:${targetRef}`)
    .digest('hex');
}

async function completedToday({ prisma, projectId, kind, now = new Date() }) {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  return prisma.codexExternalAction.count({
    where: {
      projectId,
      kind,
      status: { in: ['executing', 'completed'] },
      OR: [
        { executedAt: { gte: start } },
        { executedAt: null, updatedAt: { gte: start } },
      ],
    },
  });
}

async function ensureExternalAction({
  prisma,
  project,
  kind,
  targetRef,
  payload,
  status = 'pending_review',
}) {
  const idempotencyKey = actionKey({ projectId: project.id, kind, targetRef });
  const existing = await prisma.codexExternalAction.findUnique({
    where: { idempotencyKey },
  });
  if (existing) return { record: existing, created: false };
  try {
    const record = await prisma.codexExternalAction.create({
      data: {
        projectId: project.id,
        userId: project.userId,
        kind,
        targetRef,
        idempotencyKey,
        status,
        payload: status === 'approved'
          ? { ...payload, _approval: 'policy_auto' }
          : payload,
        approvedAt: status === 'approved' ? new Date() : null,
      },
    });
    return { record, created: true };
  } catch (error) {
    if (error?.code !== 'P2002') throw error;
    const winner = await prisma.codexExternalAction.findUnique({
      where: { idempotencyKey },
    });
    if (!winner) throw error;
    return { record: winner, created: false };
  }
}

async function createExternalAction(args) {
  const ensured = await ensureExternalAction(args);
  return ensured.record;
}

async function updateExternalActionPayload({ prisma, project, actionId, patch }) {
  const existing = await prisma.codexExternalAction.findFirst({
    where: { id: actionId, projectId: project.id, userId: project.userId },
  });
  if (!existing) return null;
  return prisma.codexExternalAction.update({
    where: { id: existing.id },
    data: { payload: { ...(existing.payload || {}), ...(patch || {}) } },
  });
}

async function findExternalAction({ prisma, project, kind, targetRef }) {
  const idempotencyKey = actionKey({ projectId: project.id, kind, targetRef });
  return prisma.codexExternalAction.findFirst({
    where: {
      idempotencyKey,
      projectId: project.id,
      userId: project.userId,
    },
  });
}

async function executeExternalAction({
  prisma,
  project,
  actionId,
  gmailLoader = loadGmailClientForUser,
  now = () => new Date(),
  env = process.env,
  companyContext = null,
}) {
  const key = String(project.id);
  const claim = await withLocalLock(key, async () => {
    const apply = async (client) => {
      const action = await client.codexExternalAction.findFirst({
        where: {
          id: actionId,
          projectId: project.id,
          userId: project.userId,
        },
      });
      if (!action) return { action: 'not_found', record: null };
      if (action.status === 'completed') return { action: 'already_completed', record: action };
      if (action.status === 'executing') return { action: 'already_executing', record: action };
      if (action.status !== 'approved') return { action: 'approval_required', record: action };

      const start = new Date(now());
      start.setUTCHours(0, 0, 0, 0);
      const [freshProject, user, sentToday] = await Promise.all([
        client.codexProject?.findFirst
          ? client.codexProject.findFirst({
            where: { id: project.id, userId: project.userId },
          })
          : project,
        client.user?.findUnique
          ? client.user.findUnique({
            where: { id: project.userId },
            select: { gmailTokens: true },
          })
          : null,
        client.codexExternalAction.count({
          where: {
            projectId: project.id,
            kind: action.kind,
            status: { in: ['executing', 'completed'] },
            OR: [
              { executedAt: { gte: start } },
              { executedAt: null, updatedAt: { gte: start } },
            ],
          },
        }),
      ]);
      const liveContext = freshProject
        ? {
          profile: companyOperatingProfile.readCompanyProfile(freshProject, { now: now() }),
          readiness: {
            evidence: {
              gmailConnected: user
                ? Boolean(user.gmailTokens)
                : Boolean(companyContext?.readiness?.evidence?.gmailConnected ?? true),
            },
          },
        }
        : companyContext;
      const decision = policy.decideExternalAction({
        companyContext: liveContext,
        kind: action.kind,
        connected: Boolean(liveContext?.readiness?.evidence?.gmailConnected),
        sentToday,
        env,
      });
      const humanApproved = action.payload?._approval === 'human';
      const allowed = decision.allowed && (decision.mode === 'auto' || humanApproved);
      if (!allowed) {
        const reason = decision.allowed ? 'human_review_required' : decision.reason;
        const record = await client.codexExternalAction.update({
          where: { id: action.id },
          data: { status: 'pending_review', error: reason },
        });
        return { action: reason, record, policy: decision };
      }

      const record = await client.codexExternalAction.update({
        where: { id: action.id },
        data: { status: 'executing', error: null },
      });
      return { action: 'claimed', record, policy: decision };
    };

    const canLock = typeof prisma.$transaction === 'function'
      && typeof prisma.$queryRawUnsafe === 'function';
    if (!canLock) return apply(prisma);
    return prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'WITH _lock AS (SELECT pg_advisory_xact_lock($1::int, $2::int)) SELECT 1::int AS locked FROM _lock',
        EXTERNAL_ACTION_LOCK_CLASS,
        hashInt32(project.id),
      );
      return apply(tx);
    });
  });
  if (claim.action !== 'claimed') return claim;
  const action = claim.record;

  try {
    const { client } = await gmailLoader({ prisma, userId: project.userId });
    let result;
    if (action.kind === 'email_reply') {
      result = action.payload.providerDraftId
        ? await client.sendDraft({ draftId: action.payload.providerDraftId })
        : await client.replyToEmail({
          threadId: action.payload.threadId,
          messageId: action.payload.messageId,
          body: action.payload.body,
        });
      await prisma.codexCompanyInboxItem.updateMany({
        where: {
          projectId: project.id,
          userId: project.userId,
          externalId: action.payload.messageId,
        },
        data: {
          status: 'sent',
          sentMessageId: result.messageId || null,
        },
      });
    } else if (action.kind === 'lead_outreach') {
      result = action.payload.providerDraftId
        ? await client.sendDraft({ draftId: action.payload.providerDraftId })
        : await client.sendEmail({
          to: action.payload.to,
          subject: action.payload.subject,
          body: action.payload.body,
        });
      await prisma.codexCompanyLead.updateMany({
        where: {
          id: action.targetRef,
          projectId: project.id,
          userId: project.userId,
        },
        data: {
          status: 'contacted',
          lastContactedAt: now(),
        },
      });
    } else {
      throw new Error(`unsupported external action: ${action.kind}`);
    }
    const record = await prisma.codexExternalAction.update({
      where: { id: action.id },
      data: {
        status: 'completed',
        result,
        executedAt: now(),
        error: null,
      },
    });
    return { action: 'completed', record };
  } catch (error) {
    const record = await prisma.codexExternalAction.update({
      where: { id: action.id },
      data: {
        status: 'error',
        error: String(error?.message || error).slice(0, 2000),
      },
    });
    return { action: 'error', record };
  }
}

async function approveExternalAction({ prisma, project, actionId, ...deps }) {
  const existing = await prisma.codexExternalAction.findFirst({
    where: {
      id: actionId,
      projectId: project.id,
      userId: project.userId,
    },
  });
  if (!existing) return { action: 'not_found', record: null };
  if (existing.status === 'completed') return { action: 'already_completed', record: existing };
  if (!['pending_review', 'error', 'approved'].includes(existing.status)) {
    return { action: 'not_approvable', record: existing };
  }
  if (existing.status !== 'approved' || existing.payload?._approval !== 'human') {
    await prisma.codexExternalAction.update({
      where: { id: existing.id },
      data: {
        payload: { ...(existing.payload || {}), _approval: 'human' },
        status: 'approved',
        approvedAt: new Date(),
        error: null,
      },
    });
  }
  return executeExternalAction({ prisma, project, actionId, ...deps });
}

async function markExternalActionError({ prisma, project, actionId, error }) {
  return prisma.codexExternalAction.updateMany({
    where: {
      id: actionId,
      projectId: project.id,
      userId: project.userId,
      status: { in: ['pending_review', 'approved'] },
    },
    data: {
      status: 'error',
      error: String(error?.message || error).slice(0, 2000),
    },
  });
}

async function rejectExternalAction({ prisma, project, actionId }) {
  const result = await prisma.codexExternalAction.updateMany({
    where: {
      id: actionId,
      projectId: project.id,
      userId: project.userId,
      status: { in: ['pending_review', 'approved', 'error'] },
    },
    data: { status: 'rejected', error: null },
  });
  return { action: result?.count ? 'rejected' : 'not_rejectable' };
}

async function decisionForAction({ prisma, project, companyContext, kind, env, now = new Date() }) {
  const sentToday = await completedToday({ prisma, projectId: project.id, kind, now });
  return policy.decideExternalAction({
    companyContext,
    kind,
    connected: Boolean(companyContext?.readiness?.evidence?.gmailConnected),
    sentToday,
    env,
  });
}

module.exports = {
  actionKey,
  approveExternalAction,
  completedToday,
  createExternalAction,
  decisionForAction,
  ensureExternalAction,
  executeExternalAction,
  findExternalAction,
  markExternalActionError,
  rejectExternalAction,
  updateExternalActionPayload,
};

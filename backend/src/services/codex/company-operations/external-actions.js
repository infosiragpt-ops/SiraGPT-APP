'use strict';

const { createHash } = require('node:crypto');
const policy = require('./external-action-policy');
const { loadGmailClientForUser } = require('../../gmail-user-client');
const companyOperatingProfile = require('../company-operating-profile');
const resourceAccess = require('./company-resource-access');

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
  socialReplySender = null,
  now = () => new Date(),
  env = process.env,
  companyContext = null,
  fetchImpl = globalThis.fetch,
  vault = null,
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

      let authorized;
      try {
        authorized = await resourceAccess.requireExternalActionResourceAccess({
          prisma: client,
          project,
          kind: action.kind,
          payload: action.payload,
        });
      } catch (error) {
        if (!(error instanceof resourceAccess.CompanyResourceAccessError)) throw error;
        const record = await client.codexExternalAction.update({
          where: { id: action.id },
          data: { status: 'pending_review', error: error.code },
        });
        return { action: error.code, record };
      }

      const start = new Date(now());
      start.setUTCHours(0, 0, 0, 0);
      const sentToday = await client.codexExternalAction.count({
        where: {
          projectId: project.id,
          kind: action.kind,
          status: { in: ['executing', 'completed'] },
          OR: [
            { executedAt: { gte: start } },
            { executedAt: null, updatedAt: { gte: start } },
          ],
        },
      });
      const freshProject = authorized.project;
      const user = authorized.user || null;
      const socialConnection = authorized.socialConnection || null;
      const existingEvidence = companyContext?.readiness?.evidence || {};
      const socialConnections = socialConnection
        ? [{
          platform: socialConnection.platform,
          accountName: socialConnection.accountName || null,
        }]
        : [];
      const liveContext = {
        profile: companyOperatingProfile.readCompanyProfile(freshProject, { now: now() }),
        readiness: {
          evidence: {
            ...existingEvidence,
            gmailConnected: action.kind === 'social_reply'
              ? false
              : Boolean(user?.gmailTokens),
            socialConnections,
          },
        },
      };
      const connected = action.kind === 'social_reply'
        ? Boolean(socialConnection)
        : Boolean(liveContext?.readiness?.evidence?.gmailConnected);
      const decision = policy.decideExternalAction({
        companyContext: liveContext,
        kind: action.kind,
        connected,
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
  let action = claim.record;

  try {
    let result;
    if (action.kind === 'email_reply') {
      const { client } = await gmailLoader({ prisma, userId: project.userId });
      action = await prisma.codexExternalAction.findFirst({
        where: {
          id: action.id,
          projectId: project.id,
          userId: project.userId,
          status: 'executing',
        },
      });
      if (!action) return { action: 'not_executing', record: claim.record };
      await resourceAccess.requireExternalActionResourceAccess({
        prisma,
        project,
        kind: action.kind,
        payload: action.payload,
      });
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
      const { client } = await gmailLoader({ prisma, userId: project.userId });
      action = await prisma.codexExternalAction.findFirst({
        where: {
          id: action.id,
          projectId: project.id,
          userId: project.userId,
          status: 'executing',
        },
      });
      if (!action) return { action: 'not_executing', record: claim.record };
      await resourceAccess.requireExternalActionResourceAccess({
        prisma,
        project,
        kind: action.kind,
        payload: action.payload,
      });
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
    } else if (action.kind === 'social_reply') {
      action = await prisma.codexExternalAction.findFirst({
        where: {
          id: action.id,
          projectId: project.id,
          userId: project.userId,
          status: 'executing',
        },
      });
      if (!action) return { action: 'not_executing', record: claim.record };
      const authorized = await resourceAccess.requireExternalActionResourceAccess({
        prisma,
        project,
        kind: action.kind,
        payload: action.payload,
      });
      const connection = authorized.socialConnection;
      const sender = socialReplySender
        || require('../../social-company/conversations').sendSocialReply;
      result = await sender({
        connection,
        interaction: {
          id: action.payload?.interactionId,
          threadId: action.payload?.threadId,
          parentId: action.payload?.parentId,
          authorId: action.payload?.authorId,
          platform: action.payload?.platform,
          metadata: action.payload?.metadata && typeof action.payload.metadata === 'object'
            ? action.payload.metadata
            : {},
        },
        text: action.payload?.body,
        prisma,
        env,
        fetchImpl,
        vault,
      });
      await prisma.codexCompanyInboxItem.updateMany({
        where: {
          projectId: project.id,
          userId: project.userId,
          provider: action.payload?.platform,
          externalId: action.payload?.interactionId,
        },
        data: {
          status: 'sent',
          sentMessageId: result?.externalId || result?.messageId || null,
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
    const accessDenied = error instanceof resourceAccess.CompanyResourceAccessError;
    const record = await prisma.codexExternalAction.update({
      where: { id: action.id },
      data: {
        status: accessDenied ? 'pending_review' : 'error',
        error: accessDenied
          ? error.code
          : String(error?.message || error).slice(0, 2000),
      },
    });
    return { action: accessDenied ? error.code : 'error', record };
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
  try {
    await resourceAccess.requireExternalActionResourceAccess({
      prisma,
      project,
      kind: existing.kind,
      payload: existing.payload,
    });
  } catch (error) {
    if (!(error instanceof resourceAccess.CompanyResourceAccessError)) throw error;
    return { action: error.code, record: existing };
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

async function decisionForAction({
  prisma,
  project,
  companyContext,
  kind,
  payload = null,
  env,
  now = new Date(),
}) {
  await resourceAccess.requireExternalActionResourceAccess({
    prisma,
    project,
    kind,
    payload,
  });
  const sentToday = await completedToday({ prisma, projectId: project.id, kind, now });
  return policy.decideExternalAction({
    companyContext,
    kind,
    connected: true,
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

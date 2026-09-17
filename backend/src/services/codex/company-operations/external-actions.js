'use strict';

const { createHash } = require('node:crypto');
const policy = require('./external-action-policy');
const { loadGmailClientForUser } = require('../../gmail-user-client');
const companyOperatingProfile = require('../company-operating-profile');
const resourceAccess = require('./company-resource-access');

const EXTERNAL_ACTION_LOCK_CLASS = 0x0ea71;
const EMAIL_MUTATION_KINDS = new Set([
  'email_reply',
  'email_send',
  'email_forward',
  'lead_outreach',
]);
const ACTION_VERSION = 1;
const APPROVAL_TTL_MS = 15 * 60 * 1000;
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

function actionKey({ projectId, kind, targetRef, payload = null, attemptId = null }) {
  const fingerprint = isEmailMutationKind(kind)
    ? actionHash({
      kind,
      targetRef,
      payload: actionPayloadForIdempotency(payload),
      attemptId,
    })
    : '';
  return createHash('sha256')
    .update(`${projectId}:${kind}:${targetRef}:${fingerprint}:${attemptId || ''}`)
    .digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value;
}

function actionPayloadForHash(payload) {
  if (!payload || typeof payload !== 'object') return {};
  return Object.keys(payload).sort().reduce((result, key) => {
    // Approval state is mutable bookkeeping. Provider draft identity remains
    // bound to the review record even though execution uses approved fields.
    if (key === '_approval' || key === 'providerDraftError') return result;
    result[key] = payload[key];
    return result;
  }, {});
}

function actionPayloadForIdempotency(payload) {
  if (!payload || typeof payload !== 'object') return {};
  return Object.keys(payload).sort().reduce((result, key) => {
    if (key === '_approval' || key === 'providerDraftId' || key === 'providerDraftError') return result;
    result[key] = payload[key];
    return result;
  }, {});
}

function actionHash({ kind, targetRef, payload, attemptId = null }) {
  return createHash('sha256')
    .update(JSON.stringify(stableValue({
      kind,
      targetRef,
      attemptId: attemptId || null,
      payload: actionPayloadForHash(payload),
    })))
    .digest('hex');
}

function isEmailMutationKind(kind) {
  return EMAIL_MUTATION_KINDS.has(String(kind || ''));
}

function humanApprovalForAction({
  kind,
  action,
  actorId = null,
  actionHash: expectedHash = null,
  actionVersion: expectedVersion = null,
}) {
  if (!isEmailMutationKind(kind)) return { allowed: true, reason: 'not_email_mutation' };
  const payload = action?.payload || {};
  const approval = payload._approval && typeof payload._approval === 'object'
    ? payload._approval
    : {};
  const currentHash = actionHash({
    kind,
    targetRef: action?.targetRef,
    payload,
    attemptId: action?.attemptId || approval.attemptId || null,
  });
  const version = Number(approval.version);
  const hashMatches = approval.actionHash === currentHash
    && (!expectedHash || expectedHash === currentHash);
  const versionMatches = version === ACTION_VERSION
    && (!expectedVersion || Number(expectedVersion) === version);
  const approvedByHuman = approval.mode === 'human'
    && typeof approval.actorId === 'string'
    && approval.actorId.length > 0;
  const actorMatches = !actorId || approval.actorId === actorId;
  if (approvedByHuman && hashMatches && versionMatches && actorMatches) {
    return {
      allowed: true,
      reason: 'human_approved',
      actorId: approval.actorId,
      actionHash: currentHash,
      actionVersion: version,
    };
  }
  return {
    allowed: false,
    reason: 'human_review_required',
    actionHash: currentHash,
    actionVersion: Number.isFinite(version) ? version : ACTION_VERSION,
  };
}

function requireHumanApproval(args = {}) {
  return humanApprovalForAction(args);
}

function pendingApprovalPayload(payload, metadata = {}) {
  return {
    ...(payload || {}),
    _approval: {
      version: ACTION_VERSION,
      actionHash: metadata.actionHash,
      mode: 'pending_review',
      actorId: null,
      expiresAt: metadata.expiresAt || null,
      attemptId: metadata.attemptId || null,
    },
  };
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
  attemptId = null,
  now = () => new Date(),
}) {
  const stableAttemptId = String(attemptId || payload?.attemptId || 'attempt-1');
  const idempotencyKey = actionKey({
    projectId: project.id, kind, targetRef, payload, attemptId: stableAttemptId,
  });
  const existing = await prisma.codexExternalAction.findUnique({
    where: { idempotencyKey },
  });
  if (existing) return { record: existing, created: false };
  const expiresAt = new Date(new Date(now()).getTime() + APPROVAL_TTL_MS);
  const normalizedPayload = isEmailMutationKind(kind)
    ? pendingApprovalPayload(payload, {
      actionHash: actionHash({ kind, targetRef, payload, attemptId: stableAttemptId }),
      expiresAt: expiresAt.toISOString(),
      attemptId: stableAttemptId,
    })
    : payload;
  const safeStatus = isEmailMutationKind(kind) ? 'pending_review' : status;
  try {
    const record = await prisma.codexExternalAction.create({
      data: {
        projectId: project.id,
        userId: project.userId,
        kind,
        targetRef,
        idempotencyKey,
        status: safeStatus,
        payload: normalizedPayload,
        expiresAt: isEmailMutationKind(kind) ? expiresAt : null,
        consumedAt: null,
        attemptId: isEmailMutationKind(kind) ? stableAttemptId : null,
        revokedAt: null,
        approvedAt: null,
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
  const payload = { ...(existing.payload || {}), ...(patch || {}) };
  const data = { payload };
  if (isEmailMutationKind(existing.kind)) {
    const nextHash = actionHash({
      kind: existing.kind,
      targetRef: existing.targetRef,
      payload,
      attemptId: existing.attemptId || null,
    });
    const currentApproval = existing.payload?._approval && typeof existing.payload._approval === 'object'
      ? existing.payload._approval
      : {};
    const changed = currentApproval.actionHash !== nextHash;
    data.payload = {
      ...payload,
      _approval: {
        version: ACTION_VERSION,
        actionHash: nextHash,
        mode: changed ? 'pending_review' : (currentApproval.mode || 'pending_review'),
        actorId: changed ? null : (currentApproval.actorId || null),
        expiresAt: existing.expiresAt?.toISOString?.() || currentApproval.expiresAt || null,
        attemptId: existing.attemptId || currentApproval.attemptId || null,
      },
    };
    if (changed && !['completed', 'delivery_uncertain'].includes(existing.status)) {
      data.status = 'pending_review';
      data.approvedAt = null;
      data.consumedAt = null;
      data.revokedAt = null;
    }
  }
  return prisma.codexExternalAction.update({
    where: { id: existing.id },
    data,
  });
}

async function findExternalAction({ prisma, project, kind, targetRef, payload = null, attemptId = null }) {
  const idempotencyKey = actionKey({
    projectId: project.id, kind, targetRef, payload, attemptId,
  });
  if (!payload && isEmailMutationKind(kind)) {
    return prisma.codexExternalAction.findFirst({
      where: {
        projectId: project.id,
        userId: project.userId,
        kind,
        targetRef,
        status: { in: ['pending_review', 'approved', 'executing', 'delivery_uncertain'] },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }
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
  claimedAttemptId = null,
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
      if (action.status === 'delivery_uncertain') return { action: 'delivery_uncertain', record: action };
      const claimedEmailAction = isEmailMutationKind(action.kind)
        && action.status === 'executing'
        && action.consumedAt
        && claimedAttemptId
        && action.attemptId === claimedAttemptId;
      if (!claimedEmailAction && action.status === 'executing') return { action: 'already_executing', record: action };
      if (!claimedEmailAction && action.status !== 'approved') return { action: 'approval_required', record: action };

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
      const countedToday = await client.codexExternalAction.count({
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
      const sentToday = Math.max(0, countedToday - (claimedEmailAction ? 1 : 0));
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
      const approval = humanApprovalForAction({ kind: action.kind, action });
      const allowed = decision.allowed && (
        isEmailMutationKind(action.kind)
          ? approval.allowed
          : (decision.mode === 'auto' || approval.allowed)
      );
      if (!allowed) {
        const reason = decision.allowed ? approval.reason : decision.reason;
        const record = await client.codexExternalAction.update({
          where: { id: action.id },
          data: { status: 'pending_review', error: reason },
        });
        return { action: reason, record, policy: decision };
      }

      if (claimedEmailAction) return { action: 'claimed', record: action, policy: decision };

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
  let providerInvoked = false;

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
      providerInvoked = true;
      result = await client.replyToEmail({
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
    } else if (action.kind === 'email_send' || action.kind === 'email_forward') {
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
      if (action.kind === 'email_send') {
        providerInvoked = true;
        result = await client.sendEmail({
          to: action.payload.to,
          subject: action.payload.subject,
          body: action.payload.body,
        });
      } else if (typeof client.forwardEmail === 'function') {
        providerInvoked = true;
        result = await client.forwardEmail({
          threadId: action.payload.threadId,
          messageId: action.payload.messageId,
          to: action.payload.to,
          body: action.payload.body,
        });
      } else {
        throw new Error('Gmail forward provider is unavailable');
      }
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
      providerInvoked = true;
      result = await client.sendEmail({
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
    const deliveryUncertain = providerInvoked && isEmailMutationKind(action.kind);
    const nextStatus = deliveryUncertain ? 'delivery_uncertain' : (accessDenied ? 'pending_review' : 'error');
    const message = accessDenied
      ? error.code
      : String(error?.message || error).slice(0, 2000);
    let record;
    try {
      record = await prisma.codexExternalAction.update({
        where: { id: action.id },
        data: {
          status: nextStatus,
          error: message,
          ...(deliveryUncertain ? {} : { consumedAt: null }),
        },
      });
    } catch (persistenceError) {
      record = { ...action, status: nextStatus, error: message };
    }
    return {
      action: deliveryUncertain ? 'delivery_uncertain' : (accessDenied ? error.code : 'error'),
      record,
    };
  }
}

async function approveExternalAction({ prisma, project, actionId, ...deps }) {
  const expectedHash = deps.actionHash;
  const expectedVersion = deps.actionVersion;
  const actorId = deps.actorId;
  const now = new Date(deps.now ? deps.now() : Date.now());
  const key = String(project.id);
  let claimedAttemptId = null;
  let existing;

  const outcome = await withLocalLock(key, async () => {
    const action = await prisma.codexExternalAction.findFirst({
      where: { id: actionId, projectId: project.id, userId: project.userId },
    });
    existing = action;
    if (!action) return { action: 'not_found', record: null };
    if (action.status === 'completed') return { action: 'already_completed', record: action };
    if (action.status === 'delivery_uncertain') return { action: 'delivery_uncertain', record: action };
    if (action.consumedAt) return { action: 'approval_consumed', record: action };
    if (action.revokedAt || action.status === 'rejected') return { action: 'approval_revoked', record: action };
    if (!['pending_review', 'error'].includes(action.status)) {
      return { action: 'not_approvable', record: action };
    }

    if (isEmailMutationKind(action.kind)) {
      if (typeof actorId !== 'string' || actorId.length === 0
        || !/^[a-f0-9]{64}$/i.test(String(expectedHash || ''))
        || typeof expectedVersion !== 'number'
        || !Number.isInteger(expectedVersion)
        || expectedVersion !== ACTION_VERSION) {
        return { action: 'approval_invalid', record: action };
      }
      const expiresAt = action.expiresAt ? new Date(action.expiresAt) : null;
      if (!expiresAt || !Number.isFinite(expiresAt.getTime()) || expiresAt <= now) {
        const record = await prisma.codexExternalAction.update({
          where: { id: action.id },
          data: { status: 'expired', error: 'approval_expired' },
        });
        return { action: 'approval_expired', record };
      }
      const currentHash = actionHash({
        kind: action.kind,
        targetRef: action.targetRef,
        payload: action.payload,
        attemptId: action.attemptId || action.payload?._approval?.attemptId || null,
      });
      const currentVersion = Number(action.payload?._approval?.version);
      if (String(expectedHash).toLowerCase() !== currentHash
        || expectedVersion !== currentVersion) {
        return { action: 'approval_stale', record: action };
      }
      try {
        await resourceAccess.requireExternalActionResourceAccess({
          prisma,
          project,
          kind: action.kind,
          payload: action.payload,
        });
      } catch (error) {
        if (!(error instanceof resourceAccess.CompanyResourceAccessError)) throw error;
        return { action: error.code, record: action };
      }
      const attemptId = String(action.attemptId || action.payload?._approval?.attemptId || 'attempt-1');
      const payload = {
        ...(action.payload || {}),
        _approval: {
          ...(action.payload?._approval || {}),
          version: ACTION_VERSION,
          actionHash: currentHash,
          mode: 'human',
          actorId,
          approvedAt: now.toISOString(),
        },
      };
      const claimWhere = {
        id: action.id,
        projectId: project.id,
        userId: project.userId,
        status: { in: ['pending_review', 'error'] },
        consumedAt: null,
        expiresAt: { gt: now },
        payload: { equals: action.payload },
      };
      const claimed = typeof prisma.codexExternalAction.updateMany === 'function'
        ? await prisma.codexExternalAction.updateMany({
          where: claimWhere,
          data: {
            payload,
            status: 'executing',
            consumedAt: now,
            attemptId,
            approvedAt: now,
            error: null,
          },
        })
        : { count: 0 };
      if (!claimed?.count) {
        const current = await prisma.codexExternalAction.findFirst({
          where: { id: action.id, projectId: project.id, userId: project.userId },
        });
        return {
          action: current?.consumedAt ? 'approval_consumed' : 'approval_stale',
          record: current || action,
        };
      }
      claimedAttemptId = attemptId;
      return { action: 'claimed', record: { ...action, ...payload, payload, status: 'executing', consumedAt: now, attemptId } };
    }

    const currentApproval = humanApprovalForAction({ kind: action.kind, action, actorId });
    if (!currentApproval.allowed) return { action: 'human_review_required', record: action };
    await prisma.codexExternalAction.update({
      where: { id: action.id },
      data: { status: 'approved', approvedAt: now, error: null },
    });
    return { action: 'approved', record: action };
  });

  if (outcome.action !== 'claimed' && !isEmailMutationKind(existing?.kind)) {
    if (outcome.action !== 'approved') return outcome;
  }
  if (outcome.action !== 'claimed' && isEmailMutationKind(existing?.kind)) return outcome;
  return executeExternalAction({ prisma, project, actionId, ...deps, claimedAttemptId });
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
    data: { status: 'rejected', revokedAt: new Date(), error: null },
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
  const decision = policy.decideExternalAction({
    companyContext,
    kind,
    connected: true,
    sentToday,
    env,
  });
  if (isEmailMutationKind(kind) && decision.allowed) {
    return {
      ...decision,
      mode: 'review',
      action: 'review',
      reason: 'human_review_required',
    };
  }
  return decision;
}

module.exports = {
  ACTION_VERSION,
  actionKey,
  actionHash,
  approveExternalAction,
  completedToday,
  createExternalAction,
  decisionForAction,
  ensureExternalAction,
  executeExternalAction,
  findExternalAction,
  humanApprovalForAction,
  isEmailMutationKind,
  markExternalActionError,
  rejectExternalAction,
  updateExternalActionPayload,
  requireHumanApproval,
};

'use strict';

const { writeAuditLog } = require('../../utils/audit-log');
const {
  loadActiveOwnedCompanyProject,
  marketingSocialPlatforms,
} = require('../codex/company-resources');
const { runAutopilot } = require('./autopilot');
const { prepareMediaForPost } = require('./media');
const { cleanPlatform } = require('./platforms');
const { readPolicy, resolvePolicyScopeId } = require('./policy');
const { publishPostToPlatform } = require('./publisher');

const DEFAULT_INTERVAL_MS = 30_000;
const STALE_PUBLISHING_MS = 10 * 60_000;
const MAX_BATCH = 20;
const SOCIAL_DAILY_LIMIT_LOCK_CLASS = 1_397_705_290;
const AUTONOMOUS_SOURCES = new Set(['ceo_autopilot', 'proactive_marketing']);
let timer = null;
let ticking = false;

function configFor(post) {
  return post?.config && typeof post.config === 'object' && !Array.isArray(post.config)
    ? post.config
    : {};
}

function normalizedPostPlatforms(post) {
  const raw = Array.isArray(post?.platforms) ? post.platforms : [];
  return [...new Set(raw.map(cleanPlatform).filter(Boolean))];
}

function completedPlatforms(config) {
  const results = config.publicationResults && typeof config.publicationResults === 'object'
    ? config.publicationResults
    : {};
  return new Set(
    Object.entries(results)
      .filter(([, result]) => result?.status === 'published')
      .map(([platform]) => platform),
  );
}

function isApproved(post, policy) {
  const config = configFor(post);
  return config.approved === true || (policy.enabled && policy.mode === 'auto');
}

function hashInt32(value) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(String(value))) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

async function claimPost(prisma, post, now = new Date()) {
  const result = await prisma.scheduledPost.updateMany({
    where: {
      id: post.id,
      userId: post.userId,
      status: post.status,
      scheduledAt: { lte: now },
    },
    data: { status: 'publishing', lastError: null, updatedAt: now },
  });
  return Number(result.count || 0) === 1;
}

async function countPublishedToday(prisma, userId, now = new Date(), scope = null) {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const scopeId = resolvePolicyScopeId(scope);
  return prisma.scheduledPost.count({
    where: {
      userId,
      ...(scopeId ? { config: { path: ['workspaceId'], equals: scopeId } } : {}),
      status: 'published',
      publishedAt: { gte: start },
    },
  });
}

async function claimWithinDailyLimit({
  prisma,
  post,
  scope,
  dailyLimit,
  now = new Date(),
}) {
  const scopeId = resolvePolicyScopeId(scope);
  if (!scopeId) return { claimed: false, reason: 'scope_required' };
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const enforce = async (client) => {
    const reserved = await client.scheduledPost.count({
      where: {
        userId: post.userId,
        config: { path: ['workspaceId'], equals: scopeId },
        OR: [
          { status: 'published', publishedAt: { gte: start } },
          { status: 'publishing', updatedAt: { gte: start } },
        ],
      },
    });
    if (reserved >= dailyLimit) {
      return { claimed: false, reason: 'daily_limit', reserved };
    }
    const claimed = await claimPost(client, post, now);
    return { claimed, reason: claimed ? null : 'already_claimed', reserved };
  };

  const canLock = typeof prisma?.$transaction === 'function'
    && typeof prisma?.$queryRawUnsafe === 'function';
  if (!canLock) return enforce(prisma);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'WITH _lock AS (SELECT pg_advisory_xact_lock($1::int, $2::int)) SELECT 1::int AS locked FROM _lock',
      SOCIAL_DAILY_LIMIT_LOCK_CLASS,
      hashInt32(`${post.userId}:${scopeId}`),
    );
    return enforce(tx);
  });
}

async function recoverStalePublishing(prisma, now = new Date()) {
  const cutoff = new Date(now.getTime() - STALE_PUBLISHING_MS);
  const result = await prisma.scheduledPost.updateMany({
    where: {
      status: 'publishing',
      updatedAt: { lt: cutoff },
    },
    data: {
      status: 'failed',
      lastError: 'Publication was interrupted. Review before retrying to avoid duplicate external posts.',
    },
  });
  return Number(result.count || 0);
}

async function failClaimedPost(prisma, post, config, code, message) {
  const updated = await prisma.scheduledPost.update({
    where: { id: post.id },
    data: {
      status: 'failed',
      lastError: message,
      publishedAt: null,
      config: {
        ...config,
        authorizationError: {
          code,
          message,
          failedAt: new Date().toISOString(),
        },
        lastAttemptAt: new Date().toISOString(),
      },
    },
  });
  return {
    action: 'failed',
    postId: post.id,
    published: 0,
    failed: normalizedPostPlatforms(post).length,
    code,
    post: updated,
  };
}

async function activeMarketingAuthorization(prisma, post, projectId) {
  const project = await loadActiveOwnedCompanyProject({
    prisma,
    projectId,
    userId: post.userId,
  });
  const connections = project
    ? await prisma.socialConnection.findMany({
      where: {
        userId: post.userId,
        platform: { in: normalizedPostPlatforms(post) },
      },
    })
    : [];
  return {
    project,
    allowed: project ? marketingSocialPlatforms(project, connections) : new Set(),
    connections: new Map(connections.map((connection) => [connection.platform, connection])),
  };
}

function livePolicyAuthorization(post, config, policy, platform) {
  if (!policy.enabled) {
    return {
      code: 'SOCIAL_PUBLISHING_PAUSED',
      message: 'Autonomous publishing was paused before the provider call.',
    };
  }
  if (!isApproved(post, policy)) {
    return {
      code: 'SOCIAL_REVIEW_REQUIRED',
      message: 'The post now requires explicit review.',
    };
  }
  if (
    AUTONOMOUS_SOURCES.has(String(config.source || ''))
    && (policy.mode !== 'auto' || policy.autopilot !== true)
  ) {
    return {
      code: 'SOCIAL_AUTOPILOT_REVOKED',
      message: 'Autopilot or automatic mode was revoked before publication.',
    };
  }
  if (policy.platforms[platform] === false) {
    return {
      code: 'SOCIAL_PLATFORM_PAUSED',
      message: `${platform} was disabled before publication.`,
    };
  }
  return null;
}

async function readLivePublishingPost(prisma, post, policyScopeId) {
  const current = await prisma.scheduledPost.findFirst({
    where: {
      id: post.id,
      userId: post.userId,
    },
  });
  if (!current) {
    return {
      ok: false,
      action: 'skipped_claim_lost',
      post: null,
    };
  }
  const currentConfig = configFor(current);
  const currentScopeId = resolvePolicyScopeId({
    workspaceId: currentConfig.workspaceId,
    projectId: currentConfig.projectId,
  });
  if (currentScopeId !== policyScopeId) {
    return {
      ok: false,
      action: 'skipped_scope_changed',
      post: current,
    };
  }
  if (current.status !== 'publishing') {
    return {
      ok: false,
      action: current.status === 'cancelled' ? 'cancelled' : 'skipped_claim_lost',
      post: current,
    };
  }
  return { ok: true, post: current };
}

async function processPost({
  prisma,
  post,
  env = process.env,
  fetchImpl = globalThis.fetch,
  vault = null,
  chatComplete = null,
  imageGenerator = null,
  mediaPreparer = prepareMediaForPost,
  logger = console,
} = {}) {
  const config = configFor(post);
  const policyScopeId = resolvePolicyScopeId({
    workspaceId: config.workspaceId,
    projectId: config.projectId,
  });
  const hasPolicyScope = config.workspaceId != null || config.projectId != null;
  if (hasPolicyScope && !policyScopeId) {
    return { action: 'skipped_invalid_scope', postId: post.id };
  }
  if (!policyScopeId) {
    // No external effect can be authorized without an owned, active Company
    // Project. This deliberately fails closed even for old approved rows.
    return { action: 'skipped_policy_scope_required', postId: post.id };
  }
  const policy = await readPolicy(prisma, post.userId, policyScopeId);
  if (!isApproved(post, policy)) return { action: 'skipped_review', postId: post.id };
  if (!policy.enabled) return { action: 'skipped_paused', postId: post.id };

  const claim = await claimWithinDailyLimit({
    prisma,
    post,
    scope: policyScopeId,
    dailyLimit: policy.dailyLimit,
  });
  if (claim.reason === 'daily_limit') {
    return { action: 'skipped_daily_limit', postId: post.id };
  }
  if (!claim.claimed) return { action: 'skipped_claimed', postId: post.id };

  const initialAuthorization = await activeMarketingAuthorization(prisma, post, policyScopeId);
  if (!initialAuthorization.project) {
    return failClaimedPost(
      prisma,
      post,
      config,
      'SOCIAL_COMPANY_INACTIVE',
      'The company is deleted, inactive, unowned, or no longer durably associated.',
    );
  }

  const publicationResults = {
    ...(config.publicationResults && typeof config.publicationResults === 'object'
      ? config.publicationResults
      : {}),
  };
  const alreadyPublished = completedPlatforms(config);
  const requestedPlatforms = normalizedPostPlatforms(post);
  const revokedPlatforms = requestedPlatforms
    .filter((platform) => !initialAuthorization.allowed.has(platform));
  for (const platform of revokedPlatforms) {
    publicationResults[platform] = {
      status: 'failed',
      code: 'SOCIAL_RESOURCE_REVOKED',
      message: `${platform} is no longer assigned to Marketing for this company.`,
      failedAt: new Date().toISOString(),
    };
  }
  const platforms = requestedPlatforms
    .filter((platform) => initialAuthorization.allowed.has(platform))
    .filter((platform) => policy.platforms[platform] !== false);
  const pendingPlatforms = platforms.filter((platform) => !alreadyPublished.has(platform));
  const pendingConnections = new Map(await Promise.all(
    pendingPlatforms.map(async (platform) => [
      platform,
      await prisma.socialConnection.findUnique({
        where: { userId_platform: { userId: post.userId, platform } },
      }),
    ]),
  ));
  const connectedPendingPlatforms = pendingPlatforms
    .filter((platform) => pendingConnections.get(platform));
  const prepared = connectedPendingPlatforms.length > 0
    ? await mediaPreparer({ post, imageGenerator })
    : {
      media: null,
      metadata: {
        status: pendingPlatforms.length > 0 ? 'no_connected_targets' : 'not_needed',
      },
    };
  if (prepared.metadata?.status === 'failed') {
    logger.warn?.(`[social-worker] media generation failed for ${post.id}: ${prepared.metadata.code}`);
  }
  let failed = revokedPlatforms.length;
  let published = 0;

  for (const platform of platforms) {
    if (alreadyPublished.has(platform)) {
      published += 1;
      continue;
    }
    try {
      // Re-read the durable Company ↔ CodexProject association and Marketing
      // assignment immediately before each irreversible provider call. A
      // trash/revocation that happens while media is prepared takes effect
      // without waiting for the next scheduler tick.
      // eslint-disable-next-line no-await-in-loop
      const liveAuthorization = await activeMarketingAuthorization(prisma, post, policyScopeId);
      if (!liveAuthorization.project) {
        const error = new Error('The company is no longer active.');
        error.code = 'SOCIAL_COMPANY_INACTIVE';
        throw error;
      }
      if (!liveAuthorization.allowed.has(platform)) {
        const error = new Error(`${platform} is no longer assigned to Marketing.`);
        error.code = 'SOCIAL_RESOURCE_REVOKED';
        throw error;
      }
      // Policy and credentials are mutable kill switches. Read both after all
      // media/LLM preparation and immediately before the external request.
      // eslint-disable-next-line no-await-in-loop
      const livePolicy = await readPolicy(prisma, post.userId, policyScopeId);
      const policyError = livePolicyAuthorization(post, config, livePolicy, platform);
      if (policyError) {
        const error = new Error(policyError.message);
        error.code = policyError.code;
        throw error;
      }
      const connection = liveAuthorization.connections.get(platform);
      if (!connection) {
        const error = new Error(`No connected ${platform} account`);
        error.code = 'SOCIAL_CONNECTION_REQUIRED';
        throw error;
      }
      // Cancellation is a durable kill switch too. Re-read the owned,
      // correctly-scoped row as the final operation before crossing the
      // provider boundary. Returning here deliberately bypasses the normal
      // finalizer so a concurrent `cancel` status is never overwritten.
      // eslint-disable-next-line no-await-in-loop
      const liveClaim = await readLivePublishingPost(
        prisma,
        post,
        policyScopeId,
      );
      if (!liveClaim.ok) {
        return {
          action: liveClaim.action,
          postId: post.id,
          published,
          failed,
          post: liveClaim.post,
        };
      }
      // eslint-disable-next-line no-await-in-loop
      const result = await publishPostToPlatform({
        platform,
        connection,
        post: {
          ...post,
          ...liveClaim.post,
          config: {
            ...configFor(post),
            ...configFor(liveClaim.post),
          },
        },
        env,
        fetchImpl,
        vault,
        prisma,
        media: prepared.media,
      });
      publicationResults[platform] = { status: 'published', ...result };
      published += 1;
    } catch (error) {
      failed += 1;
      publicationResults[platform] = {
        status: 'failed',
        code: String(error?.code || 'SOCIAL_PUBLISH_FAILED').slice(0, 80),
        message: String(error?.message || 'Publish failed').slice(0, 240),
        failedAt: new Date().toISOString(),
      };
      logger.warn?.(`[social-worker] ${platform} publish failed for ${post.id}: ${error?.code || error?.message}`);
    }
  }

  const noTargets = platforms.length === 0;
  const status = !noTargets && failed === 0 ? 'published' : 'failed';
  const lastError = status === 'failed'
    ? (noTargets ? 'No enabled social platforms' : `${failed} platform publication(s) failed`)
    : null;
  const updated = await prisma.scheduledPost.update({
    where: { id: post.id },
    data: {
      status,
      lastError,
      publishedAt: status === 'published' ? new Date() : null,
      config: {
        ...config,
        publicationResults,
        mediaGeneration: prepared.metadata,
        lastAttemptAt: new Date().toISOString(),
      },
    },
  });
  void writeAuditLog(prisma, {
    actorType: 'system',
    userId: post.userId,
    action: status === 'published' ? 'social_post_published' : 'social_post_failed',
    resource: 'scheduled_post',
    resourceId: post.id,
    metadata: {
      platforms,
      published,
      failed,
      source: config.source || 'scheduled',
      mediaStatus: prepared.metadata?.status || 'not_requested',
    },
    tags: ['social', 'autonomous-company'],
  });
  return { action: status, postId: post.id, published, failed, post: updated };
}

async function runOnce({
  prisma: explicitPrisma,
  env = process.env,
  fetchImpl = globalThis.fetch,
  vault = null,
  chatComplete = null,
  imageGenerator = null,
  mediaPreparer = prepareMediaForPost,
  logger = console,
  limit = MAX_BATCH,
} = {}) {
  // eslint-disable-next-line global-require
  const prisma = explicitPrisma || require('../../config/database');
  const recoveredStale = await recoverStalePublishing(prisma);
  const generated = await runAutopilot({
    prisma,
    chatComplete,
    logger,
  });
  const due = await prisma.scheduledPost.findMany({
    where: {
      status: 'scheduled',
      scheduledAt: { lte: new Date() },
    },
    orderBy: { scheduledAt: 'asc' },
    take: Math.max(1, Math.min(Number(limit) || MAX_BATCH, MAX_BATCH)),
  });
  const results = [];
  for (const post of due) {
    try {
      // eslint-disable-next-line no-await-in-loop
      results.push(await processPost({
        prisma,
        post,
        env,
        fetchImpl,
        vault,
        imageGenerator,
        mediaPreparer,
        logger,
      }));
    } catch (error) {
      results.push({
        action: 'error',
        postId: post.id,
        error: String(error?.message || error).slice(0, 200),
      });
    }
  }
  return { recoveredStale, generated, publications: results };
}

function workerEnabled(env = process.env) {
  if (String(env.SOCIAL_PUBLICATION_WORKER_ENABLED || '').toLowerCase() === 'true') return true;
  if (String(env.SOCIAL_PUBLICATION_WORKER_ENABLED || '').toLowerCase() === 'false') return false;
  return env.NODE_ENV === 'production';
}

function start({ env = process.env, deps = {}, logger = console } = {}) {
  if (!workerEnabled(env) || timer) return false;
  const configured = Number(env.SOCIAL_PUBLICATION_WORKER_INTERVAL_MS);
  const intervalMs = Number.isFinite(configured)
    ? Math.max(10_000, Math.min(configured, 10 * 60_000))
    : DEFAULT_INTERVAL_MS;
  timer = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      await runOnce({ ...deps, env, logger });
    } catch (error) {
      logger.warn?.(`[social-worker] tick failed: ${error?.message || error}`);
    } finally {
      ticking = false;
    }
  }, intervalMs);
  timer.unref?.();
  return true;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  ticking = false;
}

module.exports = {
  claimWithinDailyLimit,
  claimPost,
  configFor,
  countPublishedToday,
  isApproved,
  livePolicyAuthorization,
  normalizedPostPlatforms,
  processPost,
  readLivePublishingPost,
  recoverStalePublishing,
  runOnce,
  start,
  stop,
  workerEnabled,
};

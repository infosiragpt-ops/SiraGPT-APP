'use strict';

const { writeAuditLog } = require('../../utils/audit-log');
const { runAutopilot } = require('./autopilot');
const { prepareMediaForPost } = require('./media');
const { cleanPlatform } = require('./platforms');
const { readPolicy } = require('./policy');
const { publishPostToPlatform } = require('./publisher');

const DEFAULT_INTERVAL_MS = 30_000;
const STALE_PUBLISHING_MS = 10 * 60_000;
const MAX_BATCH = 20;
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

async function claimPost(prisma, post) {
  const result = await prisma.scheduledPost.updateMany({
    where: {
      id: post.id,
      userId: post.userId,
      status: post.status,
      scheduledAt: { lte: new Date() },
    },
    data: { status: 'publishing', lastError: null },
  });
  return Number(result.count || 0) === 1;
}

async function countPublishedToday(prisma, userId, now = new Date()) {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  return prisma.scheduledPost.count({
    where: {
      userId,
      status: 'published',
      publishedAt: { gte: start },
    },
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
  const policy = await readPolicy(prisma, post.userId);
  if (!isApproved(post, policy)) return { action: 'skipped_review', postId: post.id };
  if (!policy.enabled) return { action: 'skipped_paused', postId: post.id };

  const publishedToday = await countPublishedToday(prisma, post.userId);
  if (publishedToday >= policy.dailyLimit) {
    return { action: 'skipped_daily_limit', postId: post.id };
  }
  if (!(await claimPost(prisma, post))) return { action: 'skipped_claimed', postId: post.id };

  const config = configFor(post);
  const publicationResults = {
    ...(config.publicationResults && typeof config.publicationResults === 'object'
      ? config.publicationResults
      : {}),
  };
  const alreadyPublished = completedPlatforms(config);
  const platforms = normalizedPostPlatforms(post)
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
  let failed = 0;
  let published = 0;

  for (const platform of platforms) {
    if (alreadyPublished.has(platform)) {
      published += 1;
      continue;
    }
    try {
      const connection = pendingConnections.get(platform);
      if (!connection) {
        const error = new Error(`No connected ${platform} account`);
        error.code = 'SOCIAL_CONNECTION_REQUIRED';
        throw error;
      }
      // eslint-disable-next-line no-await-in-loop
      const result = await publishPostToPlatform({
        platform,
        connection,
        post,
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
  claimPost,
  configFor,
  isApproved,
  normalizedPostPlatforms,
  processPost,
  recoverStalePublishing,
  runOnce,
  start,
  stop,
  workerEnabled,
};

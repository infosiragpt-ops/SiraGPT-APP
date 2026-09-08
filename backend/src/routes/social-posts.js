'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { body, validationResult } = require('express-validator');
const prisma = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const {
  isOAuthStateInfrastructureError,
  sendOAuthStateUnavailable,
} = require('../services/auth/oauth-state-http');
const { writeAuditLog } = require('../utils/audit-log');
const socialOAuth = require('../services/social-company/oauth');
const {
  PLATFORM_IDS,
  cleanPlatform,
  postCallbackUrl,
  publicProviderStatus,
} = require('../services/social-company/platforms');
const {
  readPolicy,
  resolvePolicyScopeId,
  writePolicy,
} = require('../services/social-company/policy');
const {
  loadActiveOwnedCompanyProject,
  marketingSocialPlatforms,
} = require('../services/codex/company-resources');
const { processPost } = require('../services/social-company/worker');

const router = express.Router();
const LEGACY_PLATFORMS = new Set([
  'facebook',
  'instagram',
  'youtube',
  'tiktok',
  'linkedin',
  'x',
]);
const LEGACY_ASSIGNABLE_STATUSES = new Set([
  'draft',
  'scheduled',
  'published',
  'failed',
  'cancelled',
]);

function validationFail(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return true;
  }
  return false;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function normalizePlatforms(raw) {
  const platforms = Array.isArray(raw) && raw.length
    ? raw
      .filter((platform) => typeof platform === 'string')
      .map((platform) => platform.toLowerCase() === 'twitter' ? 'x' : platform.toLowerCase())
      .filter((platform) => LEGACY_PLATFORMS.has(platform))
      .slice(0, 8)
    : ['facebook'];
  return [...new Set(platforms)];
}

function buildSeriesPostData({
  userId,
  prompt,
  paletteName,
  days,
  platforms,
  start,
  batchId,
  referenceImages,
  workspaceId = null,
}) {
  const rows = [];
  for (let i = 0; i < days; i += 1) {
    rows.push({
      userId,
      prompt: `${prompt.trim()}\n\nDía ${i + 1} de ${days}: genera una variación profesional coherente con la serie.`,
      caption: null,
      platforms,
      scheduledAt: addDays(start, i),
      status: 'scheduled',
      batchId,
      referenceImages,
      config: {
        paletteName: paletteName || 'Profesional',
        generationMode: 'automatic_series',
        dayIndex: i + 1,
        totalDays: days,
        approved: false,
        source: 'ceo_office_series',
        workspaceId,
      },
    });
  }
  return rows;
}

function safeConnection(connection) {
  if (!connection) return null;
  const profile = connection.profile && typeof connection.profile === 'object'
    ? connection.profile
    : {};
  return {
    id: connection.id,
    platform: connection.platform,
    accountId: connection.accountId,
    accountName: connection.accountName,
    profile,
    scopes: Array.isArray(connection.scopes) ? connection.scopes : [],
    expiresAt: connection.expiresAt,
    updatedAt: connection.updatedAt,
    connected: profile.status === 'connected' && Boolean(connection.accessToken),
  };
}

function validRemoteImageUrl(value) {
  if (value == null || value === '') return null;
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function scheduledPostScopeWhere(scope) {
  const scopeId = resolvePolicyScopeId(scope);
  return scopeId
    ? { config: { path: ['workspaceId'], equals: scopeId } }
    : {};
}

function requestedPolicyScope(input) {
  const source = input && typeof input === 'object' ? input : {};
  const provided = ['workspaceId', 'projectId']
    .some((field) => Object.prototype.hasOwnProperty.call(source, field));
  return {
    provided,
    scopeId: resolvePolicyScopeId(source),
  };
}

async function authorizeMarketingPlatforms({ userId, projectId, platforms }) {
  const context = await loadMarketingAuthorization({ userId, projectId });
  if (!context.ok) return context;
  const denied = platforms.filter((platform) => !context.allowed.has(platform));
  if (denied.length > 0) {
    return {
      ok: false,
      status: 403,
      code: 'social_resource_not_assigned',
      error: 'One or more social channels are not assigned to Marketing for this company',
      denied,
    };
  }
  return context;
}

async function loadMarketingAuthorization({ userId, projectId }) {
  const project = await loadActiveOwnedCompanyProject({
    prisma,
    projectId,
    userId,
  });
  if (!project) {
    return {
      ok: false,
      status: 404,
      code: 'company_project_not_found',
      error: 'The active company project was not found',
    };
  }
  const connections = await prisma.socialConnection.findMany({
    where: {
      userId,
      platform: { in: PLATFORM_IDS },
    },
    select: {
      id: true,
      platform: true,
      accountId: true,
      accessToken: true,
      profile: true,
    },
  });
  const allowed = marketingSocialPlatforms(project, connections);
  return { ok: true, project, allowed, connections };
}

function sendMarketingAuthorization(res, authorization) {
  return res.status(authorization.status).json({
    error: authorization.error,
    code: authorization.code,
    ...(authorization.denied ? { denied: authorization.denied } : {}),
  });
}

function normalizedStoredPlatforms(post) {
  return [...new Set(
    (Array.isArray(post?.platforms) ? post.platforms : [])
      .map(cleanPlatform)
      .filter(Boolean),
  )];
}

function isLegacyUnscopedPost(post) {
  const config = post?.config && typeof post.config === 'object' && !Array.isArray(post.config)
    ? post.config
    : {};
  return !resolvePolicyScopeId({
    workspaceId: config.workspaceId,
    projectId: config.projectId,
  });
}

function assessLegacyPost(post, allowedPlatforms) {
  if (!LEGACY_ASSIGNABLE_STATUSES.has(String(post?.status || ''))) {
    return { assignable: false, reason: 'status_not_assignable', denied: [] };
  }
  const platforms = normalizedStoredPlatforms(post);
  if (platforms.length === 0) {
    return { assignable: false, reason: 'no_supported_platforms', denied: [] };
  }
  const denied = platforms.filter((platform) => !allowedPlatforms.has(platform));
  if (denied.length > 0) {
    return { assignable: false, reason: 'resources_not_authorized', denied };
  }
  return { assignable: true, reason: null, denied: [], platforms };
}

async function listLegacyOwnedPosts(userId) {
  const posts = await prisma.scheduledPost.findMany({
    where: { userId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      userId: true,
      status: true,
      platforms: true,
      config: true,
      batchId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return posts.filter(isLegacyUnscopedPost);
}

function summarizeLegacyPosts(posts, allowedPlatforms) {
  const reasons = {};
  const deniedPlatforms = new Set();
  let assignable = 0;
  for (const post of posts) {
    const assessment = assessLegacyPost(post, allowedPlatforms);
    if (assessment.assignable) {
      assignable += 1;
      continue;
    }
    reasons[assessment.reason] = Number(reasons[assessment.reason] || 0) + 1;
    for (const platform of assessment.denied) deniedPlatforms.add(platform);
  }
  return {
    total: posts.length,
    assignable,
    skipped: posts.length - assignable,
    skippedByReason: reasons,
    deniedPlatforms: [...deniedPlatforms].sort(),
  };
}

// OAuth callback is public. User identity comes exclusively from the signed,
// one-time state token, so the provider redirect does not depend on cookies.
router.get('/oauth/:platform/callback', async (req, res) => {
  const platform = cleanPlatform(req.params.platform);
  if (!platform) return res.status(400).json({ error: 'Unsupported social platform' });
  if (req.query.error) return res.redirect(postCallbackUrl(platform, 'denied'));
  if (!req.query.code || !req.query.state) {
    return res.redirect(postCallbackUrl(platform, 'invalid'));
  }
  try {
    const result = await socialOAuth.completeAuthorization({
      platform,
      code: String(req.query.code),
      state: String(req.query.state),
      prisma,
    });
    void writeAuditLog(prisma, {
      actorType: 'user',
      userId: result.userId,
      action: 'social_connection_created',
      resource: 'social_connection',
      resourceId: result.connection.id,
      metadata: { platform },
      tags: ['social', 'oauth'],
    });
    if (platform === 'linkedin' || platform === 'x') {
      try {
        const apps = require('../services/apps');
        await apps.upsertFromOAuth(prisma, {
          userId: result.userId,
          appId: platform,
          sourceId: result.connection.id,
          accountLabel: result.connection.accountName || null,
          scopes: result.connection.scopes,
          expiresAt: result.connection.expiresAt,
        });
        await apps.auditAppEvent(prisma, {
          userId: result.userId,
          action: 'app_connected',
          appId: platform,
          connectionId: result.connection.id,
        });
      } catch (syncErr) {
        console.warn(`[social-posts] ${platform} app connection sync failed:`, syncErr.message);
      }
    }
    return res.redirect(postCallbackUrl(platform, 'connected'));
  } catch (error) {
    if (isOAuthStateInfrastructureError(error)) {
      return sendOAuthStateUnavailable(res, { provider: `social_${platform}`, error });
    }
    console.warn(`[social-posts] ${platform} OAuth callback failed:`, error?.code || error?.message);
    return res.redirect(postCallbackUrl(platform, error?.code === 'SOCIAL_FACEBOOK_PAGE_REQUIRED' ? 'page_required' : 'error'));
  }
});

router.use(authenticateToken);

router.get('/', async (req, res) => {
  try {
    const batchId = typeof req.query.batchId === 'string' && req.query.batchId.trim()
      ? req.query.batchId.trim()
      : undefined;
    const policyScope = requestedPolicyScope(req.query);
    if (policyScope.provided && !policyScope.scopeId) {
      return res.status(400).json({
        error: 'workspaceId or projectId is invalid',
        code: 'social_policy_scope_invalid',
      });
    }
    const policyScopeId = policyScope.scopeId;
    const posts = await prisma.scheduledPost.findMany({
      where: {
        userId: req.user.id,
        ...scheduledPostScopeWhere(policyScopeId),
        ...(batchId ? { batchId } : {}),
      },
      orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'desc' }],
      take: 100,
    });
    res.json({ posts });
  } catch (error) {
    console.error('[social-posts] list error:', error);
    res.status(500).json({ error: 'Failed to list scheduled posts' });
  }
});

router.get('/connections', async (req, res) => {
  try {
    const connections = await prisma.socialConnection.findMany({
      where: { userId: req.user.id },
      orderBy: { updatedAt: 'desc' },
    });
    res.json({ connections: connections.map(safeConnection) });
  } catch (error) {
    console.error('[social-posts] connections error:', error);
    res.status(500).json({ error: 'Failed to list social connections' });
  }
});

router.get('/legacy', async (req, res) => {
  try {
    const scope = requestedPolicyScope(req.query);
    if (!scope.provided || !scope.scopeId) {
      return res.status(400).json({
        error: 'workspaceId is required to inspect legacy posts',
        code: 'social_policy_scope_required',
      });
    }
    const authorization = await loadMarketingAuthorization({
      userId: req.user.id,
      projectId: scope.scopeId,
    });
    if (!authorization.ok) return sendMarketingAuthorization(res, authorization);
    const posts = await listLegacyOwnedPosts(req.user.id);
    return res.json({
      workspaceId: scope.scopeId,
      legacy: summarizeLegacyPosts(posts, authorization.allowed),
    });
  } catch (error) {
    console.error('[social-posts] legacy summary error:', error);
    return res.status(500).json({ error: 'Failed to inspect legacy social posts' });
  }
});

router.post(
  '/legacy/assign',
  [
    body('workspaceId').isString().trim().isLength({ min: 1, max: 180 }),
    body('confirm').custom((value) => value === true),
  ],
  async (req, res) => {
    if (validationFail(req, res)) return;
    try {
      const workspaceId = resolvePolicyScopeId({ workspaceId: req.body.workspaceId });
      if (!workspaceId) {
        return res.status(400).json({
          error: 'workspaceId is invalid',
          code: 'social_policy_scope_invalid',
        });
      }
      const authorization = await loadMarketingAuthorization({
        userId: req.user.id,
        projectId: workspaceId,
      });
      if (!authorization.ok) return sendMarketingAuthorization(res, authorization);

      const candidates = await listLegacyOwnedPosts(req.user.id);
      const skippedByReason = {};
      const deniedPlatforms = new Set();
      let assigned = 0;
      let skipped = 0;

      for (const candidate of candidates) {
        // Re-read every owned row immediately before the conditional update.
        // Approval/retry/cancel may legitimately change the row while this
        // explicit migration is open in another tab.
        // eslint-disable-next-line no-await-in-loop
        const current = await prisma.scheduledPost.findFirst({
          where: { id: candidate.id, userId: req.user.id },
        });
        if (!current || !isLegacyUnscopedPost(current)) {
          skipped += 1;
          skippedByReason.changed = Number(skippedByReason.changed || 0) + 1;
          continue;
        }
        const assessment = assessLegacyPost(current, authorization.allowed);
        if (!assessment.assignable) {
          skipped += 1;
          skippedByReason[assessment.reason] = Number(skippedByReason[assessment.reason] || 0) + 1;
          for (const platform of assessment.denied) deniedPlatforms.add(platform);
          continue;
        }
        const config = current.config && typeof current.config === 'object' && !Array.isArray(current.config)
          ? current.config
          : {};
        const isPublishedHistory = current.status === 'published';
        const migratedConfig = {
          ...config,
          workspaceId,
          legacyScopeAssignedAt: new Date().toISOString(),
          legacyScopeAssignedBy: req.user.id,
          ...(!isPublishedHistory ? {
            approved: false,
            approvedAt: null,
            legacyApprovalRevokedAt: new Date().toISOString(),
          } : {}),
        };
        // updatedAt is the optimistic concurrency token. A concurrent worker
        // or user action wins and this row is reported as skipped instead of
        // having its newer config overwritten.
        // eslint-disable-next-line no-await-in-loop
        const update = await prisma.scheduledPost.updateMany({
          where: {
            id: current.id,
            userId: req.user.id,
            updatedAt: current.updatedAt,
          },
          data: {
            config: migratedConfig,
            ...(!isPublishedHistory ? {
              status: 'draft',
              scheduledAt: null,
              lastError: null,
            } : {}),
          },
        });
        if (Number(update.count || 0) === 1) {
          assigned += 1;
        } else {
          skipped += 1;
          skippedByReason.changed = Number(skippedByReason.changed || 0) + 1;
        }
      }

      await writeAuditLog(prisma, {
        req,
        action: 'social_legacy_posts_assigned',
        resource: 'codex_project',
        resourceId: workspaceId,
        metadata: {
          total: candidates.length,
          assigned,
          skipped,
          skippedByReason,
          deniedPlatforms: [...deniedPlatforms].sort(),
        },
        tags: ['social', 'legacy', 'explicit-migration'],
      });
      return res.json({
        workspaceId,
        total: candidates.length,
        assigned,
        skipped,
        skippedByReason,
        deniedPlatforms: [...deniedPlatforms].sort(),
      });
    } catch (error) {
      console.error('[social-posts] legacy assignment error:', error);
      return res.status(500).json({ error: 'Failed to assign legacy social posts' });
    }
  },
);

router.get('/operations', async (req, res) => {
  try {
    const policyScope = requestedPolicyScope(req.query);
    if (policyScope.provided && !policyScope.scopeId) {
      return res.status(400).json({
        error: 'workspaceId or projectId is invalid',
        code: 'social_policy_scope_invalid',
      });
    }
    const policyScopeId = policyScope.scopeId;
    const [connections, policy, queued, publishedToday] = await Promise.all([
      prisma.socialConnection.findMany({
        where: { userId: req.user.id, platform: { in: PLATFORM_IDS } },
        orderBy: { updatedAt: 'desc' },
      }),
      readPolicy(prisma, req.user.id, policyScopeId),
      prisma.scheduledPost.count({
        where: {
          userId: req.user.id,
          ...scheduledPostScopeWhere(policyScopeId),
          status: { in: ['draft', 'scheduled', 'publishing', 'failed'] },
        },
      }),
      prisma.scheduledPost.count({
        where: {
          userId: req.user.id,
          ...scheduledPostScopeWhere(policyScopeId),
          status: 'published',
          publishedAt: { gte: new Date(new Date().setUTCHours(0, 0, 0, 0)) },
        },
      }),
    ]);
    return res.json({
      policy,
      providers: PLATFORM_IDS.map((platform) => ({
        ...publicProviderStatus(platform),
        connection: safeConnection(connections.find((row) => row.platform === platform)),
      })),
      metrics: { queued, publishedToday },
    });
  } catch (error) {
    console.error('[social-posts] operations error:', error);
    return res.status(500).json({ error: 'Failed to read autonomous publishing operations' });
  }
});

router.patch(
  '/operations/policy',
  [
    body('enabled').optional().isBoolean(),
    body('mode').optional().isIn(['review', 'auto']),
    body('autopilot').optional().isBoolean(),
    body('objective').optional().isString().isLength({ max: 2_000 }),
    body('dailyLimit').optional().isInt({ min: 1, max: 20 }),
    body('platforms').optional().isObject(),
    body('workspaceId').optional({ nullable: true }).isString().isLength({ max: 180 }),
    body('projectId').optional({ nullable: true }).isString().isLength({ max: 180 }),
    body('confirmAutopublish').optional().isBoolean(),
  ],
  async (req, res) => {
    if (validationFail(req, res)) return;
    try {
      const policyScopeId = requestedPolicyScope(req.body).scopeId;
      if (!policyScopeId) {
        return res.status(400).json({
          error: 'workspaceId or projectId is required to update a social policy',
          code: 'social_policy_scope_required',
        });
      }
      const current = await readPolicy(prisma, req.user.id, policyScopeId);
      const requestedMode = req.body.mode || current.mode;
      const requestedEnabled = req.body.enabled ?? current.enabled;
      const requestedAutopilot = req.body.autopilot ?? current.autopilot;
      if (
        requestedEnabled
        && (requestedMode === 'auto' || requestedAutopilot)
        && req.body.confirmAutopublish !== true
      ) {
        return res.status(409).json({
          error: 'Explicit confirmation is required to enable autonomous publishing',
          code: 'social_autopublish_confirmation_required',
        });
      }
      const before = current;
      const policy = await writePolicy(prisma, req.user.id, {
        ...current,
        ...req.body,
        workspaceId: policyScopeId,
        platforms: {
          ...current.platforms,
          ...(req.body.platforms && typeof req.body.platforms === 'object'
            ? req.body.platforms
            : {}),
        },
      }, policyScopeId);
      await writeAuditLog(prisma, {
        req,
        action: 'social_policy_updated',
        resource: 'social_policy',
        resourceId: req.user.id,
        before,
        after: policy,
        tags: ['social', 'autonomous-company'],
      });
      return res.json({ policy });
    } catch (error) {
      console.error('[social-posts] policy update error:', error);
      return res.status(500).json({ error: 'Failed to update autonomous publishing policy' });
    }
  },
);

router.get('/connect/:platform', async (req, res) => {
  const platform = cleanPlatform(req.params.platform);
  if (!platform) return res.status(400).json({ error: 'Unsupported social platform' });
  try {
    const authorization = await socialOAuth.beginAuthorization({
      userId: req.user.id,
      platform,
    });
    if (String(req.query.redirect || '') === '1') return res.redirect(authorization.url);
    return res.json(authorization);
  } catch (error) {
    if (error?.code === 'SOCIAL_PROVIDER_NOT_CONFIGURED') {
      return res.status(503).json({
        error: `${publicProviderStatus(platform)?.label || platform} OAuth is not configured on the server`,
        code: 'social_provider_not_configured',
      });
    }
    if (isOAuthStateInfrastructureError(error)) {
      return sendOAuthStateUnavailable(res, { provider: `social_${platform}`, error });
    }
    console.error('[social-posts] connect error:', error);
    return res.status(500).json({ error: 'Failed to start social OAuth' });
  }
});

router.delete('/connections/:platform', async (req, res) => {
  const platform = cleanPlatform(req.params.platform);
  if (!platform) return res.status(400).json({ error: 'Unsupported social platform' });
  const existing = await prisma.socialConnection.findUnique({
    where: { userId_platform: { userId: req.user.id, platform } },
  });
  if (!existing) return res.status(204).end();
  if (platform === 'linkedin' || platform === 'x') {
    try {
      const apps = require('../services/apps');
      await apps.disconnectApp(prisma, { userId: req.user.id, appId: platform, req });
    } catch (syncErr) {
      console.warn(`[social-posts] ${platform} app disconnect failed:`, syncErr.message);
      await prisma.socialConnection.delete({ where: { id: existing.id } }).catch(() => {});
    }
  } else {
    await prisma.socialConnection.delete({ where: { id: existing.id } });
  }
  await writeAuditLog(prisma, {
    req,
    action: 'social_connection_deleted',
    resource: 'social_connection',
    resourceId: existing.id,
    metadata: { platform },
    tags: ['social', 'oauth'],
  });
  return res.status(204).end();
});

router.post(
  '/queue',
  [
    body('caption').trim().isLength({ min: 1, max: 5_000 }),
    body('prompt').optional().isString().isLength({ max: 12_000 }),
    body('platforms').isArray({ min: 1, max: 3 }),
    body('scheduledAt').optional().isISO8601(),
    body('imageUrl').optional({ nullable: true }).isString().isLength({ max: 4_000 }),
    body('approved').optional().isBoolean(),
    body('workspaceId').isString().trim().isLength({ min: 1, max: 180 }),
  ],
  async (req, res) => {
    if (validationFail(req, res)) return;
    const platforms = [...new Set(req.body.platforms.map(cleanPlatform).filter(Boolean))];
    if (platforms.length === 0) return res.status(400).json({ error: 'At least one supported platform is required' });
    const imageUrl = validRemoteImageUrl(req.body.imageUrl);
    if (req.body.imageUrl && !imageUrl) {
      return res.status(400).json({ error: 'imageUrl must be a public HTTPS URL' });
    }
    const workspaceId = resolvePolicyScopeId(req.body.workspaceId);
    if (!workspaceId) {
      return res.status(400).json({
        error: 'workspaceId is required',
        code: 'social_policy_scope_required',
      });
    }
    const authorization = await authorizeMarketingPlatforms({
      userId: req.user.id,
      projectId: workspaceId,
      platforms,
    });
    if (!authorization.ok) return sendMarketingAuthorization(res, authorization);
    const scheduledAt = req.body.scheduledAt ? new Date(req.body.scheduledAt) : new Date();
    const post = await prisma.scheduledPost.create({
      data: {
        userId: req.user.id,
        prompt: String(req.body.prompt || req.body.caption).trim(),
        caption: req.body.caption.trim(),
        imageUrl,
        platforms,
        scheduledAt,
        status: 'scheduled',
        config: {
          approved: req.body.approved === true,
          source: 'ceo_office',
          workspaceId,
        },
      },
    });
    await writeAuditLog(prisma, {
      req,
      action: 'social_post_queued',
      resource: 'scheduled_post',
      resourceId: post.id,
      metadata: { platforms, approved: req.body.approved === true },
      tags: ['social', 'ceo-office'],
    });
    return res.status(201).json({ post });
  },
);

router.post(
  '/series',
  [
    body('prompt').trim().isLength({ min: 2, max: 12_000 }),
    body('paletteName').optional().isString().isLength({ max: 120 }),
    body('days').optional().isInt({ min: 1, max: 60 }),
    body('platforms').optional().isArray({ min: 1, max: 8 }),
    body('referenceImages').optional().isArray({ max: 8 }),
    body('workspaceId').isString().trim().isLength({ min: 1, max: 180 }),
  ],
  async (req, res) => {
    try {
      if (validationFail(req, res)) return;
      const days = Math.min(Math.max(Number(req.body.days || 1), 1), 60);
      const platforms = [...new Set(
        (Array.isArray(req.body.platforms) ? req.body.platforms : [])
          .map(cleanPlatform)
          .filter(Boolean),
      )];
      if (platforms.length === 0) return res.status(400).json({ error: 'At least one supported platform is required' });
      const workspaceId = resolvePolicyScopeId(req.body.workspaceId);
      if (!workspaceId) {
        return res.status(400).json({
          error: 'workspaceId is required',
          code: 'social_policy_scope_required',
        });
      }
      const authorization = await authorizeMarketingPlatforms({
        userId: req.user.id,
        projectId: workspaceId,
        platforms,
      });
      if (!authorization.ok) return sendMarketingAuthorization(res, authorization);
      const start = req.body.startDate
        ? new Date(`${req.body.startDate}T14:00:00.000Z`)
        : new Date(Date.now() + 24 * 60 * 60 * 1000);
      const batchId = crypto.randomUUID();
      const referenceImages = Array.isArray(req.body.referenceImages)
        ? req.body.referenceImages.slice(0, 8)
        : [];
      const rows = buildSeriesPostData({
        userId: req.user.id,
        prompt: req.body.prompt,
        paletteName: req.body.paletteName,
        days,
        platforms,
        start,
        batchId,
        referenceImages,
        workspaceId,
      });
      const posts = await prisma.scheduledPost.createManyAndReturn({ data: rows });
      return res.status(201).json({ batchId, posts });
    } catch (error) {
      console.error('[social-posts] create series error:', error);
      return res.status(500).json({ error: 'Failed to create scheduled series' });
    }
  },
);

async function ownedPost(req, res) {
  const post = await prisma.scheduledPost.findFirst({
    where: { id: req.params.id, userId: req.user.id },
  });
  if (!post) {
    res.status(404).json({ error: 'Scheduled post not found' });
    return null;
  }
  return post;
}

router.post('/:id/approve', async (req, res) => {
  const post = await ownedPost(req, res);
  if (!post) return;
  const config = post.config && typeof post.config === 'object' ? post.config : {};
  const updated = await prisma.scheduledPost.update({
    where: { id: post.id },
    data: {
      status: 'scheduled',
      config: { ...config, approved: true, approvedAt: new Date().toISOString() },
    },
  });
  await writeAuditLog(prisma, {
    req,
    action: 'social_post_approved',
    resource: 'scheduled_post',
    resourceId: post.id,
    tags: ['social', 'review'],
  });
  return res.json({ post: updated });
});

router.post('/:id/retry', async (req, res) => {
  const post = await ownedPost(req, res);
  if (!post) return;
  if (!['failed', 'cancelled'].includes(post.status)) {
    return res.status(409).json({ error: 'Only failed or cancelled posts can be retried' });
  }
  const updated = await prisma.scheduledPost.update({
    where: { id: post.id },
    data: { status: 'scheduled', scheduledAt: new Date(), lastError: null },
  });
  return res.json({ post: updated });
});

router.post('/:id/cancel', async (req, res) => {
  const post = await ownedPost(req, res);
  if (!post) return;
  if (post.status === 'published') {
    return res.status(409).json({ error: 'Published posts cannot be cancelled from SiraGPT' });
  }
  const result = await prisma.scheduledPost.updateMany({
    where: {
      id: post.id,
      userId: req.user.id,
      status: { not: 'published' },
    },
    data: { status: 'cancelled' },
  });
  if (Number(result.count || 0) !== 1) {
    const current = await prisma.scheduledPost.findFirst({
      where: { id: post.id, userId: req.user.id },
    });
    if (!current) {
      return res.status(404).json({ error: 'Scheduled post not found' });
    }
    return res.status(409).json({
      error: current.status === 'published'
        ? 'Published posts cannot be cancelled from SiraGPT'
        : 'The scheduled post changed before cancellation could be applied',
    });
  }
  const updated = await prisma.scheduledPost.findFirst({
    where: { id: post.id, userId: req.user.id },
  });
  await writeAuditLog(prisma, {
    req,
    action: 'social_post_cancelled',
    resource: 'scheduled_post',
    resourceId: post.id,
    tags: ['social'],
  });
  return res.json({ post: updated });
});

router.post('/:id/publish-now', async (req, res) => {
  const post = await ownedPost(req, res);
  if (!post) return;
  const config = post.config && typeof post.config === 'object' ? post.config : {};
  const policyScopeId = resolvePolicyScopeId({
    workspaceId: config.workspaceId,
    projectId: config.projectId,
  });
  if (!policyScopeId) {
    return res.status(409).json({
      error: 'The scheduled post has no active company scope',
      code: 'social_policy_scope_required',
    });
  }
  const platforms = [...new Set(
    (Array.isArray(post.platforms) ? post.platforms : [])
      .map(cleanPlatform)
      .filter(Boolean),
  )];
  const authorization = await authorizeMarketingPlatforms({
    userId: req.user.id,
    projectId: policyScopeId,
    platforms,
  });
  if (!authorization.ok) return sendMarketingAuthorization(res, authorization);
  const policy = await readPolicy(prisma, req.user.id, policyScopeId);
  if (!policy.enabled) {
    return res.status(409).json({
      error: 'Autonomous publishing is paused',
      code: 'social_publishing_paused',
    });
  }
  const ready = await prisma.scheduledPost.update({
    where: { id: post.id },
    data: {
      status: 'scheduled',
      scheduledAt: new Date(),
      config: { ...config, approved: true, approvedAt: new Date().toISOString() },
    },
  });
  const result = await processPost({ prisma, post: ready });
  return res.json({ result });
});

module.exports = router;
module.exports.INTERNAL = {
  addDays,
  assessLegacyPost,
  authorizeMarketingPlatforms,
  buildSeriesPostData,
  isLegacyUnscopedPost,
  normalizePlatforms,
  normalizedStoredPlatforms,
  requestedPolicyScope,
  safeConnection,
  scheduledPostScopeWhere,
  summarizeLegacyPosts,
  validRemoteImageUrl,
};

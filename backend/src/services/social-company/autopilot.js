'use strict';

const { writeAuditLog } = require('../../utils/audit-log');
const companyResources = require('../codex/company-resources');
const departmentPools = require('../codex/department-pools');
const usageLedger = require('../codex/usage-ledger');
const { PLATFORM_IDS } = require('./platforms');
const {
  POLICY_PREFIX,
  parsePolicyRow,
  readPolicy,
} = require('./policy');

const SOCIAL_AUTOPILOT_LOCK_CLASS = 1_397_705_289;

function dayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function hashInt32(value) {
  let hash = 0x811c9dc5;
  const bytes = Buffer.from(String(value));
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

async function createScheduledPostOnce({ prisma, userId, batchId, data }) {
  const create = async (client) => {
    const existing = await client.scheduledPost.findFirst({
      where: { userId, batchId },
      select: { id: true, status: true },
    });
    if (existing) return { post: existing, created: false };
    return {
      post: await client.scheduledPost.create({ data }),
      created: true,
    };
  };

  const canLock = typeof prisma?.$transaction === 'function'
    && typeof prisma?.$queryRawUnsafe === 'function';
  if (!canLock) return create(prisma);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'WITH _lock AS (SELECT pg_advisory_xact_lock($1::int, $2::int)) SELECT 1::int AS locked FROM _lock',
      SOCIAL_AUTOPILOT_LOCK_CLASS,
      hashInt32(`${userId}:${batchId}`),
    );
    return create(tx);
  });
}

function extractJson(text) {
  const raw = String(text || '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function generateContent({
  policy,
  platforms,
  chatComplete,
  project = null,
  ledger = [],
  objectives = [],
  usageContext = null,
}) {
  const callId = usageLedger.createUsageCallId();
  const result = await chatComplete({
    messages: [
      {
        role: 'system',
        content: [
          'Eres el director de Marketing de una empresa autónoma coordinada por CEO Office.',
          'Genera una publicación profesional, específica, comprobable y sin inventar cifras.',
          'Responde SOLO JSON con {"caption":"...","mediaBrief":"..."}.',
          platforms.includes('x')
            ? 'caption debe tener máximo 260 caracteres para que pueda publicarse también en X.'
            : 'caption debe tener máximo 900 caracteres.',
          'mediaBrief describe una imagen editorial profesional sin logos ni texto ilegible; no afirmes que la imagen ya fue creada.',
        ].join(' '),
      },
      {
        role: 'user',
        content: [
          `Objetivo vigente de CEO Office: ${policy.objective}`,
          project ? `Producto: ${project.name || project.id}` : null,
          objectives.length
            ? `OKR activos:\n${objectives.slice(0, 5).map((item) => `- ${item.title}${item.target ? ` · meta ${item.target}` : ''}`).join('\n')}`
            : null,
          ledger.length
            ? `Resultados reales recientes:\n${ledger.slice(-6).map((item) => `- [${item.outcome}] ${item.task || item.runId} · +${item.diffstat?.additions || 0}/-${item.diffstat?.deletions || 0}`).join('\n')}`
            : null,
          `Canales conectados: ${platforms.join(', ')}`,
          'Crea la siguiente pieza de contenido más útil para avanzar ese objetivo hoy.',
        ].filter(Boolean).join('\n'),
      },
    ],
    temperature: 0.4,
    maxTokens: 500,
  });
  if (usageContext) {
    await usageLedger.recordCompletionUsage({
      ...usageContext,
      source: 'social_autopilot',
      completion: result,
      callId,
    });
  }
  const parsed = extractJson(result?.content);
  if (!parsed || typeof parsed.caption !== 'string' || !parsed.caption.trim()) return null;
  const maxCaption = platforms.includes('x') ? 260 : 900;
  return {
    caption: Array.from(parsed.caption.trim()).slice(0, maxCaption).join(''),
    mediaBrief: typeof parsed.mediaBrief === 'string'
      ? parsed.mediaBrief.trim().slice(0, 1_000)
      : '',
  };
}

/**
 * Bridge used by the proactive Marketing department. It never publishes
 * directly: review mode creates an unapproved draft; auto mode creates an
 * approved scheduled post that the existing 30s publisher still validates.
 */
async function generateDepartmentPost({
  prisma,
  project,
  ledger = [],
  objectives = [],
  allowedPlatforms = null,
  chatComplete: explicitChatComplete,
  now = () => new Date(),
  departmentPoolId = null,
  env = process.env,
} = {}) {
  if (!prisma || !project?.userId || !project?.id) {
    return { action: 'skipped_invalid_project' };
  }
  const activeProject = await companyResources.loadActiveOwnedCompanyProject({
    prisma,
    projectId: project.id,
    userId: project.userId,
  });
  if (!activeProject) {
    return { action: 'skipped_project_not_found' };
  }
  const policy = await readPolicy(prisma, activeProject.userId, activeProject.id);
  if (!policy.enabled || !policy.autopilot || !policy.objective) {
    return {
      action: 'skipped_policy',
      mode: policy.mode,
      reason: !policy.enabled ? 'disabled' : !policy.autopilot ? 'autopilot_disabled' : 'objective_missing',
    };
  }
  const batchId = `proactive-marketing:${dayKey(now())}:${activeProject.userId}:${activeProject.id}`;
  const exists = await prisma.scheduledPost.findFirst({
    where: { userId: activeProject.userId, batchId },
    select: { id: true, status: true },
  });
  if (exists) return { action: 'already_generated', postId: exists.id, status: exists.status, batchId };

  const connections = await prisma.socialConnection.findMany({
    where: { userId: activeProject.userId, platform: { in: PLATFORM_IDS } },
    select: {
      id: true,
      platform: true,
      accountId: true,
      accessToken: true,
      profile: true,
    },
  });
  const connected = new Set(connections.map((row) => row.platform));
  const assigned = companyResources.marketingSocialPlatforms(activeProject, connections);
  const requestedAllowlist = allowedPlatforms == null
    ? null
    : new Set(Array.isArray(allowedPlatforms) ? allowedPlatforms : []);
  const platforms = PLATFORM_IDS.filter(
    (platform) => connected.has(platform)
      && policy.platforms[platform] !== false
      && assigned.has(platform)
      && (requestedAllowlist === null || requestedAllowlist.has(platform)),
  );
  if (platforms.length === 0) return { action: 'skipped_no_connections', batchId };

  const chatComplete = explicitChatComplete
    || ((args) => require('../codex/llm-provider').chatComplete(args));
  const budget = await departmentPools.requireOperationBudget({
    prisma,
    project: activeProject,
    departmentId: companyResources.MARKETING_DEPARTMENT_ID,
    departmentPoolId,
    env,
    now: now(),
  });
  const usagePool = budget.pool;
  const content = await generateContent({
    policy,
    platforms,
    chatComplete,
    project: activeProject,
    ledger,
    objectives,
    usageContext: {
      prisma,
      projectId: activeProject.id,
      departmentPoolId: usagePool?.id || null,
      sourceId: batchId,
      env,
    },
  });
  if (!content) return { action: 'skipped_invalid_content', batchId };

  const auto = policy.mode === 'auto';
  const createdAt = now();
  const data = {
      userId: activeProject.userId,
      prompt: policy.objective,
      caption: content.caption,
      platforms,
      scheduledAt: auto ? createdAt : null,
      status: auto ? 'scheduled' : 'draft',
      batchId,
      config: {
        approved: auto,
        source: 'proactive_marketing',
        projectId: activeProject.id,
        workspaceId: policy.workspaceId,
        mediaBrief: content.mediaBrief,
        generateImage: Boolean(content.mediaBrief),
        mediaMode: content.mediaBrief ? 'generated' : 'text',
        generatedAt: createdAt.toISOString(),
        policyMode: policy.mode,
      },
  };
  const creation = await createScheduledPostOnce({
    prisma,
    userId: activeProject.userId,
    batchId,
    data,
  });
  const post = creation.post;
  if (!creation.created) {
    return {
      action: 'already_generated',
      postId: post.id,
      status: post.status,
      batchId,
    };
  }
  void writeAuditLog(prisma, {
    actorType: 'system',
    userId: activeProject.userId,
    action: auto ? 'social_post_scheduled' : 'social_post_drafted',
    resource: 'scheduled_post',
    resourceId: post.id,
    metadata: {
      source: 'proactive_marketing',
      projectId: activeProject.id,
      platforms,
      policyMode: policy.mode,
    },
    tags: ['social', 'autonomous-company', 'marketing'],
  });
  return {
    action: auto ? 'scheduled_auto' : 'drafted_review',
    postId: post.id,
    batchId,
    platforms,
    status: post.status,
  };
}

async function runAutopilot({
  prisma: explicitPrisma,
  chatComplete: explicitChatComplete,
  now = () => new Date(),
  logger = console,
  maxUsers = 25,
  env = process.env,
} = {}) {
  // eslint-disable-next-line global-require
  const prisma = explicitPrisma || require('../../config/database');
  const pageSize = Math.max(1, Math.min(Number(maxUsers) || 25, 100));
  const rows = [];
  const seenPolicyKeys = new Set();
  let cursor = null;
  for (;;) {
    // Read every page before deduplication so a legacy row can never mask a
    // newer v2 policy merely because the two records straddle a page boundary.
    // eslint-disable-next-line no-await-in-loop
    const page = await prisma.systemSettings.findMany({
      where: { key: { startsWith: POLICY_PREFIX } },
      orderBy: { key: 'asc' },
      take: pageSize,
      ...(cursor ? { cursor: { key: cursor }, skip: 1 } : {}),
    });
    const fresh = page.filter((row) => (
      row && typeof row.key === 'string' && !seenPolicyKeys.has(row.key)
    ));
    for (const row of fresh) {
      seenPolicyKeys.add(row.key);
      rows.push(row);
    }
    if (page.length < pageSize || fresh.length === 0) break;
    cursor = page[page.length - 1].key;
  }
  const policiesByScope = new Map();
  for (const entry of rows.map(parsePolicyRow).filter(Boolean)) {
    // A user-wide legacy value cannot safely authorize an arbitrary company.
    if (!entry.workspaceId) continue;
    const scopeKey = `${entry.userId}\u0000${entry.workspaceId}`;
    const current = policiesByScope.get(scopeKey);
    if (!current || entry.storageVersion > current.storageVersion) {
      policiesByScope.set(scopeKey, entry);
    }
  }
  const policies = [...policiesByScope.values()];
  const results = [];
  for (const entry of policies) {
    const { userId, workspaceId, policy } = entry;
    if (!policy.enabled || policy.mode !== 'auto' || !policy.autopilot || !policy.objective) {
      continue;
    }
    const batchId = `ceo-autopilot:${dayKey(now())}:${userId}:${workspaceId}`;
    try {
      // workspaceId is the owned CodexProject boundary for v2 policies.
      // eslint-disable-next-line no-await-in-loop
      const project = await companyResources.loadActiveOwnedCompanyProject({
        prisma,
        projectId: workspaceId,
        userId,
      });
      if (!project) {
        results.push({ action: 'skipped_project_not_found', userId, workspaceId });
        continue;
      }
      // One CEO-generated publication per company and UTC day. The scoped
      // daily limit still applies in the publisher alongside manual content.
      // eslint-disable-next-line no-await-in-loop
      const exists = await prisma.scheduledPost.findFirst({
        where: { userId, batchId },
        select: { id: true, status: true },
      });
      if (exists) {
        results.push({
          action: 'already_generated',
          userId,
          workspaceId,
          postId: exists.id,
        });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const connections = await prisma.socialConnection.findMany({
        where: { userId, platform: { in: PLATFORM_IDS } },
        select: {
          id: true,
          platform: true,
          accountId: true,
          accessToken: true,
          profile: true,
        },
      });
      const connected = new Set(connections.map((row) => row.platform));
      const allowedPlatforms = companyResources.marketingSocialPlatforms(project, connections);
      const platforms = PLATFORM_IDS.filter(
        (platform) => connected.has(platform)
          && policy.platforms[platform] !== false
          && allowedPlatforms.has(platform),
      );
      if (platforms.length === 0) {
        results.push({ action: 'skipped_no_connections', userId, workspaceId });
        continue;
      }
      // eslint-disable-next-line global-require
      const chatComplete = explicitChatComplete
        || ((args) => require('../codex/llm-provider').chatComplete(args));
      // Enforce both project and Marketing-pool budgets before spending tokens.
      // eslint-disable-next-line no-await-in-loop
      const budget = await departmentPools.requireOperationBudget({
        prisma,
        project,
        departmentId: companyResources.MARKETING_DEPARTMENT_ID,
        env,
        now: now(),
      });
      const usagePool = budget.pool;
      // eslint-disable-next-line no-await-in-loop
      const content = await generateContent({
        policy,
        platforms,
        chatComplete,
        project,
        usageContext: {
          prisma,
          projectId: project.id,
          departmentPoolId: usagePool?.id || null,
          sourceId: batchId,
          env,
        },
      });
      if (!content) {
        results.push({ action: 'skipped_invalid_content', userId, workspaceId });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const data = {
          userId,
          prompt: policy.objective,
          caption: content.caption,
          platforms,
          scheduledAt: now(),
          status: 'scheduled',
          batchId,
          config: {
            approved: true,
            source: 'ceo_autopilot',
            mediaBrief: content.mediaBrief,
            generateImage: Boolean(content.mediaBrief),
            mediaMode: content.mediaBrief ? 'generated' : 'text',
            workspaceId,
            generatedAt: now().toISOString(),
          },
      };
      // eslint-disable-next-line no-await-in-loop
      const creation = await createScheduledPostOnce({
        prisma,
        userId,
        batchId,
        data,
      });
      const post = creation.post;
      if (!creation.created) {
        results.push({
          action: 'already_generated',
          userId,
          workspaceId,
          postId: post.id,
        });
        continue;
      }
      void writeAuditLog(prisma, {
        actorType: 'system',
        userId,
        action: 'social_post_generated',
        resource: 'scheduled_post',
        resourceId: post.id,
        metadata: { source: 'ceo_autopilot', platforms, workspaceId },
        tags: ['social', 'autonomous-company', 'ceo-office'],
      });
      results.push({
        action: 'generated',
        userId,
        workspaceId,
        postId: post.id,
        platforms,
      });
    } catch (error) {
      logger.warn?.(`[social-autopilot] generation failed for ${userId}/${workspaceId}: ${error?.message || error}`);
      results.push({
        action: 'error',
        userId,
        workspaceId,
        error: String(error?.message || error).slice(0, 200),
      });
    }
  }
  return results;
}

module.exports = {
  createScheduledPostOnce,
  dayKey,
  extractJson,
  generateContent,
  generateDepartmentPost,
  hashInt32,
  runAutopilot,
};

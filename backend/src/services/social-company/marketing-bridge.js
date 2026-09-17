'use strict';

/**
 * marketing-bridge — D16 puente Marketing → publicador social.
 *
 * Convierte el trabajo real de la empresa (entradas del ledger: qué se
 * construyó esta semana y qué se aprendió) en contenido social encolado
 * SIEMPRE bajo la policy de la compañía. Nunca publica directo: en modo
 * review crea un borrador sin aprobar; en modo auto crea un post
 * `scheduled` que el publisher existente (worker de 30s) sigue validando
 * contra la policy antes de tocar cualquier red social.
 *
 * Contrato:
 *   runMarketingCycle({ project, ledgerEntries, deps }) →
 *     { action: 'drafted' | 'skipped_policy' | 'skipped_budget'
 *             | 'skipped_duplicate', postId? }
 */

const crypto = require('node:crypto');

const { writeAuditLog } = require('../../utils/audit-log');
const { PLATFORM_IDS } = require('./platforms');
const {
  createScheduledPostOnce,
  dayKey,
  generateContent: defaultGenerateContent,
} = require('./autopilot');
const { readPolicy: defaultReadPolicy } = require('./policy');

const BATCH_PREFIX = 'marketing-bridge';
const MAX_LEDGER_ENTRIES = 6;
const MAX_TITLE_CHARS = 200;
const MAX_OUTCOME_CHARS = 80;
const MAX_LEARNINGS_CHARS = 300;

function normalizeLedgerEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      title: typeof entry.title === 'string' ? entry.title.trim().slice(0, MAX_TITLE_CHARS) : '',
      outcome: typeof entry.outcome === 'string' ? entry.outcome.trim().slice(0, MAX_OUTCOME_CHARS) : '',
      learnings: typeof entry.learnings === 'string' ? entry.learnings.trim().slice(0, MAX_LEARNINGS_CHARS) : '',
    }))
    .filter((entry) => entry.title || entry.outcome || entry.learnings)
    .slice(-MAX_LEDGER_ENTRIES);
}

/**
 * Human-readable summary of what the company actually built, injected
 * into the generation prompt so the post talks about real work instead
 * of generic marketing filler.
 */
function buildLedgerContext(entries) {
  if (!entries.length) return '';
  const lines = entries.map((entry) => {
    const parts = [entry.title || 'trabajo sin título'];
    if (entry.outcome) parts.push(`resultado: ${entry.outcome}`);
    if (entry.learnings) parts.push(`aprendizaje: ${entry.learnings}`);
    return `- ${parts.join(' · ')}`;
  });
  return `Esta semana la empresa construyó:\n${lines.join('\n')}`;
}

/** sha256(projectId + contenido + día UTC) — idempotency key per day. */
function contentHashFor({ projectId, caption, day }) {
  return crypto
    .createHash('sha256')
    .update(`${String(projectId)}\n${String(caption)}\n${String(day)}`)
    .digest('hex');
}

function marketingBatchId({ day, hash }) {
  return `${BATCH_PREFIX}:${day}:${hash.slice(0, 32)}`;
}

function utcDayRange(now) {
  const day = dayKey(now);
  const start = new Date(`${day}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { day, start, end };
}

async function countPostsForDay(prisma, userId, start, end) {
  const where = { userId, createdAt: { gte: start, lt: end } };
  if (typeof prisma.scheduledPost.count === 'function') {
    const total = await prisma.scheduledPost.count({ where });
    return Number.isFinite(total) ? total : 0;
  }
  const rows = await prisma.scheduledPost.findMany({ where, select: { id: true } });
  return Array.isArray(rows) ? rows.length : 0;
}

/**
 * Runs one Marketing cycle for a company project: reads the policy,
 * enforces the daily budget, generates content grounded on the ledger
 * and enqueues exactly one ScheduledPost row — draft (review) or
 * approved-scheduled (auto). Idempotent per (project, content, UTC day).
 */
async function runMarketingCycle({ project, ledgerEntries = [], deps = {} } = {}) {
  // eslint-disable-next-line global-require
  const prisma = deps.prisma || require('../../config/database');
  const readPolicy = deps.readPolicy || defaultReadPolicy;
  const generateContent = deps.generateContent || defaultGenerateContent;
  const now = typeof deps.now === 'function'
    ? deps.now
    : deps.now instanceof Date ? () => deps.now : () => new Date();

  if (!project || !project.id || !project.userId) {
    return { action: 'skipped_invalid_project' };
  }

  const policy = await readPolicy(prisma, project.userId, project.id);
  if (!policy || policy.enabled !== true) {
    return { action: 'skipped_policy', reason: 'disabled', mode: policy?.mode };
  }
  if (!policy.objective) {
    return { action: 'skipped_policy', reason: 'objective_missing', mode: policy.mode };
  }
  const platforms = PLATFORM_IDS.filter(
    (platform) => policy.platforms?.[platform] !== false,
  );
  if (platforms.length === 0) {
    return { action: 'skipped_policy', reason: 'no_platforms', mode: policy.mode };
  }

  const { day, start, end } = utcDayRange(now());
  const dailyLimit = Number.isFinite(Number(policy.dailyLimit))
    ? Math.max(1, Math.floor(Number(policy.dailyLimit)))
    : 3;
  const postedToday = await countPostsForDay(prisma, project.userId, start, end);
  if (postedToday >= dailyLimit) {
    return {
      action: 'skipped_budget',
      postedToday,
      dailyLimit,
    };
  }

  const ledger = normalizeLedgerEntries(ledgerEntries);
  const ledgerContext = buildLedgerContext(ledger);
  const chatComplete = deps.chatComplete
    || ((args) => require('../codex/llm-provider').chatComplete(args));
  const content = await generateContent({
    policy,
    platforms,
    project,
    chatComplete,
    // Shape the default autopilot generator understands (`task` label),
    // while custom generators also receive the ready-made context block.
    ledger: ledger.map((entry) => ({
      task: entry.title,
      outcome: entry.outcome,
      learnings: entry.learnings,
    })),
    ledgerContext,
  });
  if (!content || typeof content.caption !== 'string' || !content.caption.trim()) {
    return { action: 'skipped_invalid_content' };
  }
  const maxCaption = platforms.includes('x') ? 260 : 900;
  const caption = Array.from(content.caption.trim()).slice(0, maxCaption).join('');
  const mediaBrief = typeof content.mediaBrief === 'string'
    ? content.mediaBrief.trim().slice(0, 1_000)
    : '';

  const contentHash = contentHashFor({ projectId: project.id, caption, day });
  const batchId = marketingBatchId({ day, hash: contentHash });
  const existing = await prisma.scheduledPost.findFirst({
    where: { userId: project.userId, batchId },
    select: { id: true, status: true },
  });
  if (existing) {
    return {
      action: 'skipped_duplicate',
      postId: existing.id,
      status: existing.status,
      batchId,
    };
  }

  const auto = policy.mode === 'auto';
  const createdAt = now();
  const creation = await createScheduledPostOnce({
    prisma,
    userId: project.userId,
    batchId,
    data: {
      userId: project.userId,
      prompt: policy.objective,
      caption,
      platforms,
      scheduledAt: auto ? createdAt : null,
      status: auto ? 'scheduled' : 'draft',
      batchId,
      config: {
        approved: auto,
        source: 'marketing_bridge',
        projectId: project.id,
        workspaceId: policy.workspaceId || project.id,
        contentHash,
        ledgerContext,
        mediaBrief,
        generateImage: Boolean(mediaBrief),
        mediaMode: mediaBrief ? 'generated' : 'text',
        generatedAt: createdAt.toISOString(),
        policyMode: policy.mode,
      },
    },
  });
  const post = creation.post;
  if (!creation.created) {
    return {
      action: 'skipped_duplicate',
      postId: post.id,
      status: post.status,
      batchId,
    };
  }
  void writeAuditLog(prisma, {
    actorType: 'system',
    userId: project.userId,
    action: auto ? 'social_post_scheduled' : 'social_post_drafted',
    resource: 'scheduled_post',
    resourceId: post.id,
    metadata: {
      source: 'marketing_bridge',
      projectId: project.id,
      platforms,
      policyMode: policy.mode,
      ledgerEntries: ledger.length,
    },
    tags: ['social', 'autonomous-company', 'marketing'],
  });
  return {
    action: 'drafted',
    postId: post.id,
    status: post.status || (auto ? 'scheduled' : 'draft'),
    batchId,
    platforms,
    contentHash,
  };
}

module.exports = {
  buildLedgerContext,
  contentHashFor,
  marketingBatchId,
  normalizeLedgerEntries,
  runMarketingCycle,
};

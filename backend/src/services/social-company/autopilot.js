'use strict';

const { writeAuditLog } = require('../../utils/audit-log');
const { PLATFORM_IDS } = require('./platforms');
const { POLICY_PREFIX, parsePolicyRow } = require('./policy');

function dayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
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

async function generateContent({ policy, platforms, chatComplete }) {
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
          `Canales conectados: ${platforms.join(', ')}`,
          'Crea la siguiente pieza de contenido más útil para avanzar ese objetivo hoy.',
        ].join('\n'),
      },
    ],
    temperature: 0.4,
    maxTokens: 500,
  });
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

async function runAutopilot({
  prisma: explicitPrisma,
  chatComplete: explicitChatComplete,
  now = () => new Date(),
  logger = console,
  maxUsers = 25,
} = {}) {
  // eslint-disable-next-line global-require
  const prisma = explicitPrisma || require('../../config/database');
  const rows = await prisma.systemSettings.findMany({
    where: { key: { startsWith: POLICY_PREFIX } },
    take: Math.max(1, Math.min(Number(maxUsers) || 25, 100)),
  });
  const policies = rows.map(parsePolicyRow).filter(Boolean);
  const results = [];
  for (const entry of policies) {
    const { userId, policy } = entry;
    if (!policy.enabled || policy.mode !== 'auto' || !policy.autopilot || !policy.objective) {
      continue;
    }
    const batchId = `ceo-autopilot:${dayKey(now())}:${userId}`;
    try {
      // One CEO-generated publication per UTC day. The user's daily limit still
      // applies in the publisher and can be used for manually queued content.
      // eslint-disable-next-line no-await-in-loop
      const exists = await prisma.scheduledPost.findFirst({
        where: { userId, batchId },
        select: { id: true, status: true },
      });
      if (exists) {
        results.push({ action: 'already_generated', userId, postId: exists.id });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const connections = await prisma.socialConnection.findMany({
        where: { userId, platform: { in: PLATFORM_IDS } },
        select: { platform: true },
      });
      const connected = new Set(connections.map((row) => row.platform));
      const platforms = PLATFORM_IDS.filter(
        (platform) => connected.has(platform) && policy.platforms[platform] !== false,
      );
      if (platforms.length === 0) {
        results.push({ action: 'skipped_no_connections', userId });
        continue;
      }
      // eslint-disable-next-line global-require
      const chatComplete = explicitChatComplete
        || ((args) => require('../codex/llm-provider').chatComplete(args));
      // eslint-disable-next-line no-await-in-loop
      const content = await generateContent({ policy, platforms, chatComplete });
      if (!content) {
        results.push({ action: 'skipped_invalid_content', userId });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const post = await prisma.scheduledPost.create({
        data: {
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
            workspaceId: policy.workspaceId,
            generatedAt: now().toISOString(),
          },
        },
      });
      void writeAuditLog(prisma, {
        actorType: 'system',
        userId,
        action: 'social_post_generated',
        resource: 'scheduled_post',
        resourceId: post.id,
        metadata: { source: 'ceo_autopilot', platforms, workspaceId: policy.workspaceId },
        tags: ['social', 'autonomous-company', 'ceo-office'],
      });
      results.push({ action: 'generated', userId, postId: post.id, platforms });
    } catch (error) {
      logger.warn?.(`[social-autopilot] generation failed for ${userId}: ${error?.message || error}`);
      results.push({
        action: 'error',
        userId,
        error: String(error?.message || error).slice(0, 200),
      });
    }
  }
  return results;
}

module.exports = {
  dayKey,
  extractJson,
  generateContent,
  runAutopilot,
};

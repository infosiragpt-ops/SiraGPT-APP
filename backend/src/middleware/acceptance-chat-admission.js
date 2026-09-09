'use strict';

// Operator-scoped acceptance, not an alternative auth or application policy.
// Keep the real authenticated text route, but reject unaccredited tools,
// documents and persisted contexts before enrichment can create paid work.
const defaultSpend = require('../services/ai/acceptance-spend-guard');
const { MODEL } = defaultSpend;
const COPY = 'Esta prueba solo admite chat de texto en la conversación acreditada.';
const KEYS = new Set(['provider', 'model', 'prompt', 'chatId', 'streamId', 'idempotencyKey',
  'reasoningEffort', 'permission', 'toolPermission', 'disableAgentic', 'files', 'mentionedApps',
  'pinnedAppIds', 'regenerate', 'regenerationAttempt']);
const DIRECT = /^\s*(?:responde|contesta|reply|answer)\s+(?:únicamente|unicamente|solo|solamente|only)\s*:?[\s\S]{1,120}$/i;
const PERMISSIONS = ['default', 'read', 'protected', 'workspace', 'full'];
const COUNT_KEYS = ['agentTasks', 'goalRuns', 'generatedArtifacts', 'runs', 'coworkRuns'];
const CHAT_SELECT = {
  userId: true, model: true, deletedAt: true, isArchived: true, isShared: true,
  customGptId: true, projectId: true, coworkWorkspaceId: true, organizationId: true,
  pinnedAppIds: true, contextSummary: true, googleCalendarContext: true,
  isWordConnectorChat: true, isExcelConnectorChat: true, wordContent: true, excelContent: true,
  _count: { select: Object.fromEntries(COUNT_KEYS.map(key => [key, true])) },
  messages: { take: 21, select: { role: true, content: true, files: true, agentMetadata: true } },
};

function emptyList(value) { return value == null || (Array.isArray(value) && value.length === 0); }

function requestAccredited(body) {
  return body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).every(key => KEYS.has(key))
    && body.provider === 'Meta' && body.model === MODEL
    && typeof body.chatId === 'string' && body.chatId.length > 0
    && typeof body.prompt === 'string' && DIRECT.test(body.prompt)
    && body.disableAgentic === true
    && ['files', 'mentionedApps', 'pinnedAppIds'].every(key => emptyList(body[key]))
    && ['permission', 'toolPermission'].every(key => body[key] === undefined || PERMISSIONS.includes(body[key]))
    && (body.reasoningEffort === undefined || (typeof body.reasoningEffort === 'string' && body.reasoningEffort.length <= 16))
    && ['streamId', 'idempotencyKey'].every(key => typeof body[key] === 'string' && body[key].trim().length > 0 && body[key].length <= 200)
    // Regeneration has a separate persistence/UI lifecycle and is not part of
    // this accredited new-turn flow. Reject it before any billable work.
    && (body.regenerate === undefined || body.regenerate === false)
    && (body.regenerationAttempt === undefined || body.regenerationAttempt === 0);
}

function chatAccredited(chat, userId) {
  return chat && chat.userId === userId && chat.model === MODEL
    && !chat.deletedAt && !chat.isArchived && !chat.isShared
    && !chat.customGptId && !chat.projectId && !chat.coworkWorkspaceId && !chat.organizationId
    && emptyList(chat.pinnedAppIds) && !chat.contextSummary && !chat.googleCalendarContext
    && !chat.isWordConnectorChat && !chat.isExcelConnectorChat && !chat.wordContent && !chat.excelContent
    && chat._count && COUNT_KEYS.every(key => chat._count[key] === 0)
    && Array.isArray(chat.messages) && chat.messages.length <= 20
    && chat.messages.every(message => ['USER', 'ASSISTANT'].includes(message.role)
      && typeof message.content === 'string' && message.content.length <= 100_000
      && emptyList(message.files) && !message.agentMetadata
      && !/\[CREATE_DOCUMENT\b|<artifact\b|agent-task-state/i.test(message.content));
}

function createAcceptanceChatAdmission({ prisma, spend = defaultSpend }) {
  return async function acceptanceChatAdmission(req, res, next) {
    if (!spend.isActive()) return next();
    const reject = () => res.status(402).json({ code: 'E_QUOTA', error: COPY, message: COPY, retryable: false });
    if (!req.user?.id || req.headers?.['x-sira-gateway'] || req.headers?.['x-org-id']
      || req.orgContext?.orgId || !requestAccredited(req.body)) return reject();
    try {
      // Unlike the legacy read-side best-effort lookup, campaign admission is
      // closed on missing chats, DB errors and unrecognised persisted state.
      const chat = await prisma.chat.findUnique({ where: { id: req.body.chatId }, select: CHAT_SELECT });
      if (!chatAccredited(chat, req.user.id) || spend.status().available !== true) return reject();
    } catch (_) { return reject(); }
    // Same-origin chat transport may recover a partial EOF without treating
    // it as success. Only the admitted private scope gets this boolean; no
    // user, chat or policy identifier is exposed and ordinary streams do not
    // change their recovery behavior.
    res.setHeader('X-Sira-Acceptance', '1');
    // Preserve existing exposure headers if an already-authorized web client
    // uses a separate API origin; do not alter allowed origins/credentials.
    res.append('Access-Control-Expose-Headers', 'X-Sira-Acceptance');
    return next();
  };
}

module.exports = { createAcceptanceChatAdmission, requestAccredited, chatAccredited };

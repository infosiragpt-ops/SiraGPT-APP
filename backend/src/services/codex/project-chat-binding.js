'use strict';

const { throwIfAborted } = require('../../utils/abort-signal');

/**
 * project-chat-binding — vínculo 1:1 entre un chat de /agentes y un
 * CodexProject durable, sin migración: el chatId vive en `brief` (Json).
 *
 * `publicProject` filtra `brief` a propósito, así que el match se hace con
 * una consulta JSON owner-scoped por DB y se devuelve la forma pública
 * vía project-service. El ownership lo garantiza el filtro `userId`: un
 * chatId ajeno nunca resuelve proyecto de otro usuario.
 */

function cleanChatId(chatId) {
  const id = String(chatId || '').trim();
  if (!id || id.length > 64) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return id;
}

function briefChatId(brief) {
  if (!brief || typeof brief !== 'object' || Array.isArray(brief)) return null;
  const id = brief.chatId;
  return typeof id === 'string' ? id : null;
}

function requireDb(db) {
  const prisma = db || null;
  if (!prisma?.codexProject?.findMany) {
    const err = new Error('Project store unavailable.');
    err.status = 503;
    err.code = 'codex_store_unavailable';
    throw err;
  }
  return prisma;
}

async function findProjectIdForChat({ userId, chatId, db }) {
  const clean = cleanChatId(chatId);
  if (!userId || !clean) return null;
  const prisma = requireDb(db);
  const rows = await prisma.codexProject.findMany({
    where: { userId: String(userId), deletedAt: null, brief: { path: ['chatId'], equals: clean } },
    select: { id: true, brief: true },
    orderBy: { updatedAt: 'desc' },
    take: 1,
  });
  const hit = (Array.isArray(rows) ? rows : []).find((r) => briefChatId(r && r.brief) === clean);
  return hit ? hit.id : null;
}

async function findProjectForChat({ userId, chatId, db = null, projects = null }) {
  const prisma = db || null;
  const projectId = await findProjectIdForChat({ userId, chatId, db: prisma });
  if (!projectId) return null;
  const svc = projects || require('./project-service');
  return svc.getProject({ userId, id: projectId, db: prisma || undefined });
}

function bindingError(code, status, message) {
  return Object.assign(new Error(message), { code, status });
}

async function requireOwnedChat({ userId, chatId, db }) {
  if (!userId) throw bindingError('user_required', 401, 'Inicia sesión para programar.');
  const clean = cleanChatId(chatId);
  if (!clean) throw bindingError('invalid_chat_id', 400, 'chatId inválido.');
  if (!db?.chat?.findFirst) throw bindingError('codex_store_unavailable', 503, 'No se pudo comprobar el chat.');
  const chat = await db.chat.findFirst({
    where: { id: clean, userId: String(userId), deletedAt: null }, select: { id: true },
  });
  if (!chat) throw bindingError('coding_chat_not_found', 404, 'No se encontró el chat.');
  return clean;
}

// Reuse the existing cross-worker PostgreSQL mutation lock. The creation row,
// runner provisioning and ready/error transition commit together, so another
// request cannot observe an absent binding and provision a second workspace.
// Both the manual create route and repository import share this chat key.
async function withChatProjectLock({ userId, chatId, db, signal }, work) {
  throwIfAborted(signal);
  const clean = await requireOwnedChat({ userId, chatId, db });
  throwIfAborted(signal);
  const { withProjectMutationLock } = require('./checkpoint-service');
  return withProjectMutationLock(db, `chat:${String(userId)}:${clean}`, async (lockedDb) => {
    throwIfAborted(signal);
    await requireOwnedChat({ userId, chatId: clean, db: lockedDb });
    throwIfAborted(signal);
    return work(lockedDb, clean);
  });
}

async function findOrCreateProjectForChat({ userId, chatId, name = null, instructions = null, db = null, projects = null, signal }) {
  const result = await withChatProjectLock({ userId, chatId, db, signal }, async (lockedDb, clean) => {
    const found = await findProjectForChat({ userId, chatId: clean, db: lockedDb, projects });
    throwIfAborted(signal);
    if (found) return { project: found, reused: true };
    const svc = projects || require('./project-service');
    const label = String(name || '').trim().slice(0, 80) || 'Mi app web';
    const brief = { chatId: clean, source: 'agentes' };
    // The chat already stores the prompt. Persist only the provisioning need,
    // never a second copy that could include accidentally pasted credentials.
    if (typeof instructions === 'string') {
      const { hasFullStackIntent } = require('./project-service');
      brief.instructions = hasFullStackIntent(instructions) ? 'frontend y backend' : 'frontend';
    }
    const project = await svc.createProject({ userId, name: label, brief, db: lockedDb, signal });
    return { project, reused: false };
  });
  throwIfAborted(signal);
  return result;
}

module.exports = {
  cleanChatId,
  briefChatId,
  findProjectIdForChat,
  findProjectForChat,
  findOrCreateProjectForChat,
  requireOwnedChat,
  withChatProjectLock,
};

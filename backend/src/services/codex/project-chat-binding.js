'use strict';

/**
 * project-chat-binding — vínculo 1:1 entre un chat de /agentes y un
 * CodexProject durable, sin migración: el chatId vive en `brief` (Json).
 *
 * `publicProject` filtra `brief` a propósito, así que el match se hace con
 * una consulta mínima `{id, brief}` por DB y se devuelve la forma pública
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
    where: { userId: String(userId) },
    select: { id: true, brief: true },
    orderBy: { updatedAt: 'desc' },
    take: 50,
  });
  const hit = (Array.isArray(rows) ? rows : []).find((r) => briefChatId(r && r.brief) === clean);
  return hit ? hit.id : null;
}

async function findProjectForChat({ userId, chatId, db = null, projects = null }) {
  const prisma = db || null;
  const projectId = await findProjectIdForChat({ userId, chatId, db: prisma }).catch(() => null);
  if (!projectId) return null;
  const svc = projects || require('./project-service');
  return svc.getProject({ userId, id: projectId, db: prisma || undefined });
}

async function findOrCreateProjectForChat({ userId, chatId, name = null, db = null, projects = null }) {
  const clean = cleanChatId(chatId);
  if (!userId) {
    const err = new Error('user_required');
    err.status = 401;
    err.code = 'user_required';
    throw err;
  }
  if (!clean) {
    const err = new Error('chatId inválido.');
    err.status = 400;
    err.code = 'invalid_chat_id';
    throw err;
  }
  const found = await findProjectForChat({ userId, chatId: clean, db, projects });
  if (found) return { project: found, reused: true };
  const svc = projects || require('./project-service');
  const label = String(name || '').trim().slice(0, 80) || 'Mi app web';
  const project = await svc.createProject({
    userId,
    name: label,
    brief: { chatId: clean, source: 'agentes' },
    db: db || undefined,
  });
  return { project, reused: false };
}

module.exports = {
  cleanChatId,
  briefChatId,
  findProjectIdForChat,
  findProjectForChat,
  findOrCreateProjectForChat,
};

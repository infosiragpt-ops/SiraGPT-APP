'use strict';

/**
 * chat-task-scope — enforce per-conversation agent isolation.
 * Background agent runs require a chatId unless scopeMode === 'global'.
 */

async function assertChatScopeForAgentTask({ prisma, userId, body = {} } = {}) {
  const scopeMode = String(body.scopeMode || 'chat').trim().toLowerCase();
  if (scopeMode === 'global') {
    return { ok: true, chatId: null, scopeMode: 'global' };
  }

  const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
  if (!chatId) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'chatId_required',
        message: 'chatId is required for scoped agent runs. Pass scopeMode=global only for cross-chat orchestration.',
      },
    };
  }

  if (prisma && userId) {
    const chat = await prisma.chat.findFirst({
      where: { id: chatId, userId: String(userId) },
      select: { id: true },
    });
    if (!chat) {
      return {
        ok: false,
        status: 404,
        body: { error: 'chat_not_found', message: 'Chat not found or access denied.' },
      };
    }
  }

  return { ok: true, chatId, scopeMode: 'chat' };
}

module.exports = {
  assertChatScopeForAgentTask,
};

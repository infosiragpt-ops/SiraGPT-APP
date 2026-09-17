'use strict';

const crypto = require('crypto');

function safeSlug(value, fallback = 'member') {
  const slug = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
  return slug || fallback;
}

function ownerIds(env = process.env) {
  return String(env.AGENT_COMPUTER_OWNER_USER_IDS || 'cmqcv09q10000qu01lxftg1r7')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function ownerSlug(env = process.env) {
  return safeSlug(env.AGENT_COMPUTER_OWNER_SLUG || 'luis', 'luis');
}

function memberKey(user, env = process.env) {
  const id = String((user && (user.id || user.userId)) || '').trim();
  if (id && ownerIds(env).includes(id)) return ownerSlug(env);
  if (id) return safeSlug(id, ownerSlug(env));
  return safeSlug(env.AGENT_COMPUTER_DEFAULT_USER || ownerSlug(env), ownerSlug(env));
}

function conversationSlug(conversationId) {
  return safeSlug(conversationId, '');
}

/**
 * Bind a desktop session to one chat without inventing a second VM
 * protocol. The orchestrator already keys sessions by userId; we
 * suffix the member key with a conversation slug so chat A and chat B
 * do not reuse the same session id.
 *
 * If conversationId is missing, conversationBound is false — callers
 * must label the desktop as member-shared.
 */
function conversationSessionKey(member, conversationId) {
  const base = safeSlug(member, 'member');
  const chat = conversationSlug(conversationId);
  if (!chat) return base;
  const combined = `${base}_c_${chat}`;
  if (combined.length <= 48) return combined;
  const hash = crypto.createHash('sha256').update(combined).digest('hex').slice(0, 12);
  return safeSlug(`${base.slice(0, 24)}_c_${hash}`, base).slice(0, 48);
}

function resolveSessionIdentity(user, conversationId, env = process.env) {
  const member = memberKey(user, env);
  const chat = conversationSlug(conversationId);
  if (!chat) {
    return {
      userId: member,
      memberKey: member,
      conversationId: null,
      conversationBound: false,
      sessionKey: member,
    };
  }
  const sessionKey = conversationSessionKey(member, chat);
  return {
    userId: sessionKey,
    memberKey: member,
    conversationId: chat,
    conversationBound: true,
    sessionKey,
  };
}

module.exports = {
  safeSlug,
  ownerIds,
  ownerSlug,
  memberKey,
  conversationSlug,
  conversationSessionKey,
  resolveSessionIdentity,
};

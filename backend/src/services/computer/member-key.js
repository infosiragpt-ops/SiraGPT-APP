'use strict';

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

module.exports = { safeSlug, ownerIds, ownerSlug, memberKey };

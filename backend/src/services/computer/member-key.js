'use strict';

const FALLBACK_OWNER_ID = 'cmqcv09q10000qu01lxftg1r7';
const FALLBACK_OWNER_SLUG = 'luis';
let fallbackWarned = false;

function warnFallbackOnce(kind) {
  if (fallbackWarned) return;
  fallbackWarned = true;
  // eslint-disable-next-line no-console
  console.warn(
    `[security] member-key: using built-in ${kind} fallback because the corresponding ` +
    'AGENT_COMPUTER_* env var is unset. Set it explicitly so membership is not ' +
    'granted by silent defaults.',
  );
}

function safeSlug(value, fallback = 'member') {
  const slug = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
  return slug || fallback;
}

function ownerIds(env = process.env) {
  const raw = env.AGENT_COMPUTER_OWNER_USER_IDS;
  if (!raw) {
    warnFallbackOnce('owner-user-ids');
    return [FALLBACK_OWNER_ID];
  }
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function ownerSlug(env = process.env) {
  const raw = env.AGENT_COMPUTER_OWNER_SLUG;
  if (!raw) {
    warnFallbackOnce('owner-slug');
    return FALLBACK_OWNER_SLUG;
  }
  return safeSlug(raw);
}

function memberKey(user, env = process.env) {
  const id = String((user && (user.id || user.userId)) || '').trim();
  if (id && ownerIds(env).includes(id)) return ownerSlug(env);
  if (id) return safeSlug(id, ownerSlug(env));
  const rawDefault = env.AGENT_COMPUTER_DEFAULT_USER;
  if (!rawDefault) {
    warnFallbackOnce('default-user');
    return ownerSlug(env);
  }
  return safeSlug(rawDefault, ownerSlug(env));
}

module.exports = { safeSlug, ownerIds, ownerSlug, memberKey };

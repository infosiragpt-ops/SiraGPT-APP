'use strict';

/**
 * codex/user-memory — the user's Hermes memory (durable facts + curated
 * frozen block) as a system-prompt section for the codex build loop.
 *
 * The chat path has injected this memory for a long time; the coding agent
 * never received it, so a user who told the chat "siempre uso pnpm y
 * TypeScript estricto" got a codex build that ignored it. Best-effort by
 * contract: any failure yields '' and the run continues without memory.
 *
 *   CODEX_USER_MEMORY=0             → disabled
 *   CODEX_USER_MEMORY_MAX_CHARS     → cap of the injected block (default 3000)
 *   CODEX_USER_MEMORY_LIMIT         → facts requested from the store (default 12)
 */

const DEFAULT_MAX_CHARS = 3000;
const DEFAULT_LIMIT = 12;

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function userMemoryEnabled(env = process.env) {
  return String(env.CODEX_USER_MEMORY ?? '1').trim() !== '0';
}

/**
 * @returns {string} memory block ('' when disabled, no user, empty memory or
 *   any error). Synchronous: the Hermes bridge reads from in-memory stores.
 */
function loadUserMemory({ userId, chatId = null, env = process.env, bridge = null } = {}) {
  if (!userMemoryEnabled(env)) return '';
  const uid = String(userId || '').trim();
  if (!uid) return '';
  try {
    // Lazy require: the bridge pulls the active/curated memory stores, which
    // the codex loop must not depend on at module load.
    // eslint-disable-next-line global-require
    const memory = bridge || require('../agents/hermes-memory-bridge');
    if (typeof memory.buildMemoryPrompt !== 'function') return '';
    const text = memory.buildMemoryPrompt(uid, {
      limit: positiveInt(env.CODEX_USER_MEMORY_LIMIT, DEFAULT_LIMIT),
      chatId: chatId || null,
    });
    const clean = String(text || '').trim();
    if (!clean) return '';
    const max = positiveInt(env.CODEX_USER_MEMORY_MAX_CHARS, DEFAULT_MAX_CHARS);
    return clean.length > max ? `${clean.slice(0, max)}\n…[memoria recortada]` : clean;
  } catch (err) {
    if (env.NODE_ENV !== 'test') console.warn('[codex user-memory] unavailable:', err?.message || err);
    return '';
  }
}

module.exports = { loadUserMemory, userMemoryEnabled, DEFAULT_MAX_CHARS, DEFAULT_LIMIT };

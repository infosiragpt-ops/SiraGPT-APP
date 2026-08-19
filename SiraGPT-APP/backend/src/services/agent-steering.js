'use strict';

/**
 * agent-steering — mid-task steering queue for agentic runs (F25/E2).
 *
 * Today, talking to an in-flight agent aborts the run. This module gives
 * each chat a small FIFO queue of user notes that the agent loop drains
 * BETWEEN steps (the injection point already exists: the harness wraps
 * every tool execute). The loop is wired up separately — this file is
 * pure state management, no routes, no loop changes.
 *
 * Public API (via createSteeringService({ store, now })):
 *   push({ chatId, userId, note })  — queue a sanitized note
 *                                     → { ok:true, queued } | { ok:false, error }
 *   drain({ chatId })               — FIFO drain; empties the queue and
 *                                     discards notes older than the TTL
 *                                     → [{ note, userId, ts }]
 *   peekCount(chatId)               — non-mutating count of live notes
 *   setPaused({ chatId, paused, userId }) — pause/resume flag the loop
 *                                     respects between steps
 *   isPaused(chatId)                — current pause flag
 *   formatForPrompt(notes)          — Spanish prompt block
 *                                     "[NOTAS DEL USUARIO A MITAD DE TAREA]"
 *   clear(chatId)                   — drop the chat's queue + pause state
 *
 * The store is injectable (Map-like: get/set/delete/clear) so a Redis
 * adapter can slot in later; createMemoryStore() is the default.
 * `now` is an injectable clock (fn → epoch ms) for deterministic tests.
 */

const MAX_NOTES_PER_CHAT = 10;
const MAX_NOTE_CHARS = 2000;
const NOTE_TTL_MS = 30 * 60 * 1000; // notes not drained within 30min are stale

/**
 * Minimal in-memory store. Same surface a Redis-backed adapter would
 * implement: get/set/delete/clear keyed by chatId.
 */
function createMemoryStore() {
  const map = new Map();
  return {
    get(key) {
      return map.get(key);
    },
    set(key, value) {
      map.set(key, value);
    },
    delete(key) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}

/**
 * Sanitize a raw user note for safe prompt injection:
 *  - strip fenced code blocks (``` ... ``` including the fences) — a
 *    steering note is guidance, not a code payload, and fences would
 *    break the prompt block formatting;
 *  - drop any stray/unpaired fence markers;
 *  - collapse all whitespace runs (incl. newlines) to single spaces so
 *    each note renders as one "- " bullet;
 *  - cap at MAX_NOTE_CHARS.
 * Returns '' when nothing meaningful survives.
 */
function sanitizeNote(raw) {
  if (typeof raw !== 'string') return '';
  let text = raw.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/```/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > MAX_NOTE_CHARS) text = text.slice(0, MAX_NOTE_CHARS);
  return text;
}

function normalizeChatId(chatId) {
  if (typeof chatId === 'number' && Number.isFinite(chatId)) return String(chatId);
  if (typeof chatId === 'string' && chatId.trim() !== '') return chatId.trim();
  return null;
}

/**
 * Render drained notes as the Spanish prompt block the model receives
 * between steps. Empty input → '' (caller injects nothing).
 */
function formatForPrompt(notes) {
  if (!Array.isArray(notes) || notes.length === 0) return '';
  const bullets = notes
    .map((entry) => {
      const text = entry && typeof entry.note === 'string' ? entry.note : '';
      return text ? `- ${text}` : null;
    })
    .filter(Boolean);
  if (bullets.length === 0) return '';
  return `[NOTAS DEL USUARIO A MITAD DE TAREA]\n${bullets.join('\n')}`;
}

function createSteeringService({ store = createMemoryStore(), now = Date.now } = {}) {
  const clock = typeof now === 'function' ? now : Date.now;

  function getEntry(key) {
    return store.get(key) || null;
  }

  function ensureEntry(key) {
    let entry = store.get(key);
    if (!entry) {
      entry = { notes: [], paused: false, pausedBy: null, pausedAt: null };
      store.set(key, entry);
    }
    return entry;
  }

  function liveNotes(entry, nowMs) {
    if (!entry || !Array.isArray(entry.notes)) return [];
    const cutoff = nowMs - NOTE_TTL_MS;
    return entry.notes.filter((n) => n && typeof n.ts === 'number' && n.ts > cutoff);
  }

  function push({ chatId, userId = null, note } = {}) {
    const key = normalizeChatId(chatId);
    if (!key) return { ok: false, error: 'invalid_chat_id' };

    const sanitized = sanitizeNote(note);
    if (!sanitized) return { ok: false, error: 'empty_note' };

    const entry = ensureEntry(key);
    const nowMs = clock();
    // Expired notes should not hold seats in the queue.
    entry.notes = liveNotes(entry, nowMs);
    if (entry.notes.length >= MAX_NOTES_PER_CHAT) {
      store.set(key, entry);
      return { ok: false, error: 'queue_full' };
    }

    entry.notes.push({ note: sanitized, userId: userId ?? null, ts: nowMs });
    store.set(key, entry);
    return { ok: true, queued: entry.notes.length };
  }

  function drain({ chatId } = {}) {
    const key = normalizeChatId(chatId);
    if (!key) return [];
    const entry = getEntry(key);
    if (!entry) return [];

    const survivors = liveNotes(entry, clock());
    entry.notes = [];
    store.set(key, entry); // preserve pause state, empty the queue
    return survivors;
  }

  function peekCount(chatId) {
    const key = normalizeChatId(chatId);
    if (!key) return 0;
    return liveNotes(getEntry(key), clock()).length;
  }

  function setPaused({ chatId, paused, userId = null } = {}) {
    const key = normalizeChatId(chatId);
    if (!key) return { ok: false, error: 'invalid_chat_id' };
    const entry = ensureEntry(key);
    entry.paused = Boolean(paused);
    entry.pausedBy = entry.paused ? userId ?? null : null;
    entry.pausedAt = entry.paused ? clock() : null;
    store.set(key, entry);
    return { ok: true, paused: entry.paused };
  }

  function isPaused(chatId) {
    const key = normalizeChatId(chatId);
    if (!key) return false;
    const entry = getEntry(key);
    return Boolean(entry && entry.paused);
  }

  function clear(chatId) {
    const key = normalizeChatId(chatId);
    if (!key) return;
    store.delete(key);
  }

  return {
    push,
    drain,
    peekCount,
    setPaused,
    isPaused,
    formatForPrompt,
    clear,
  };
}

module.exports = {
  createSteeringService,
  createMemoryStore,
  formatForPrompt,
  sanitizeNote,
  MAX_NOTES_PER_CHAT,
  MAX_NOTE_CHARS,
  NOTE_TTL_MS,
};

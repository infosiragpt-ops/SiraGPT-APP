'use strict';

/**
 * Hermes curated memory — bounded MEMORY + USER stores with a frozen snapshot.
 *
 * Adapted from NousResearch/hermes-agent (MIT), tools/memory_tool.py:
 *   https://github.com/NousResearch/hermes-agent
 *
 * Pattern adopted (not a dump of the Python module):
 *   - Two stores: `memory` (agent notes) and `user` (profile / prefs)
 *   - Character limits, §-delimited entries, exact-duplicate rejection
 *   - add / replace / remove via unique substring match
 *   - Frozen system-prompt snapshot at session start (prefix-cache stable)
 *   - Mid-session writes persist immediately; the snapshot refreshes next chat
 *   - Scan before accept + neutralize before prompt injection
 *
 * Isolation: every read/write is keyed by userId. One user can never see or
 * mutate another user's stores. Optional chatId only keys the frozen snapshot
 * (same user, new chat → fresh snapshot from disk; other users stay isolated).
 */

const diskPersistence = require('../cowork-disk-persistence');
const {
  checkFactSize,
  checkWriteRate,
  storeOverflowError,
} = require('./memory-write-guard');

const ENTRY_DELIMITER = '\n§\n';
const MEMORY_CHAR_LIMIT = 2200;
const USER_CHAR_LIMIT = 1375;
const VALID_TARGETS = new Set(['memory', 'user']);
const USER_CATEGORIES = new Set([
  'preference', 'preferences', 'personal', 'instruction', 'language', 'profile',
]);

const PII_OR_SECRET = [
  /[\w.+-]+@[\w-]+\.[\w.-]+/,
  /\b(?:\+?\d[\s().-]?){9,}\b/,
  /\b(?:\d[ -]?){13,19}\b/,
  /\b(?:sk|pk|rk|ghp|gho|xox[bp]|Bearer)[-_ ]?[A-Za-z0-9._-]{12,}\b/i,
  /\bBEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY\b/,
  /\b(?:contrase\u00f1a|password|api[_\s-]?key|secret|token|tarjeta|cvv)\b/i,
];

const INVISIBLE_UNICODE = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/;

const liveByUser = new Map();
const hydratedUsers = new Set();
const snapshots = new Map();

function normalizeUserId(userId) {
  const id = String(userId || '').trim();
  return id || null;
}

function sessionKey(userId, chatId) {
  return `${userId}::${chatId ? String(chatId).slice(0, 80) : '_default'}`;
}

function emptyStores() {
  return { memory: [], user: [], notes: [] };
}

function storesFor(userId) {
  const id = normalizeUserId(userId);
  if (!id) return emptyStores();
  hydrateUser(id);
  let stores = liveByUser.get(id);
  if (!stores) {
    stores = emptyStores();
    liveByUser.set(id, stores);
  }
  if (!Array.isArray(stores.notes)) stores.notes = [];
  return stores;
}

function hydrateUser(userId) {
  if (!userId || hydratedUsers.has(userId)) return;
  hydratedUsers.add(userId);
  try {
    const saved = diskPersistence.loadCuratedMemory(userId);
    liveByUser.set(userId, {
      memory: dedupe(saved.memory),
      user: dedupe(saved.user),
      notes: Array.isArray(saved.notes) ? saved.notes.filter(Boolean) : [],
    });
  } catch {
    liveByUser.set(userId, emptyStores());
  }
}

function persistUser(userId) {
  const id = normalizeUserId(userId);
  if (!id) return;
  const stores = liveByUser.get(id) || emptyStores();
  if (!Array.isArray(stores.notes)) stores.notes = [];
  try {
    diskPersistence.saveCuratedMemory(id, stores);
  } catch {
    // Persistence is best-effort; live state still answers this process.
  }
}

function dedupe(entries) {
  return [...new Set((Array.isArray(entries) ? entries : []).map((e) => String(e)))];
}

function entriesFor(stores, target) {
  return target === 'user' ? stores.user : stores.memory;
}

function charLimit(target) {
  return target === 'user' ? USER_CHAR_LIMIT : MEMORY_CHAR_LIMIT;
}

function charCount(entries) {
  if (!entries.length) return 0;
  return entries.join(ENTRY_DELIMITER).length;
}

function looksLikePiiOrSecret(text) {
  const value = String(text || '');
  return PII_OR_SECRET.some((re) => re.test(value));
}

function scanMemoryContent(content) {
  const text = String(content || '');
  if (!text.trim()) return 'Content cannot be empty.';
  if (INVISIBLE_UNICODE.test(text)) {
    return 'Blocked: invisible Unicode characters.';
  }
  if (looksLikePiiOrSecret(text)) {
    return 'Blocked: looks like a secret, credential, or contact PII.';
  }
  try {
    const { analyzePrompt } = require('../adversarial-prompt-detector');
    const report = analyzePrompt(text);
    if (report.verdict === 'high_risk' || report.verdict === 'medium_risk') {
      const cats = Object.keys(report.categories || {}).join(', ') || report.topCategory || 'adversarial';
      return `Blocked: ${report.verdict} pattern (${cats}).`;
    }
  } catch {
    // Detector unavailable — still apply the local PII / unicode gates above.
  }
  return null;
}

function neutralizeForPrompt(text) {
  return String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/</g, '\u2039')
    .replace(/>/g, '\u203a')
    .trim();
}

function sanitizeEntriesForSnapshot(entries, filename) {
  return (entries || []).map((entry) => {
    if (!entry || String(entry).startsWith('[BLOCKED:')) return entry;
    const blocked = scanMemoryContent(entry);
    if (blocked) {
      return `[BLOCKED: ${filename} entry removed from system prompt. Use memory(action=read) to inspect and memory(action=remove) to delete.]`;
    }
    return neutralizeForPrompt(entry);
  });
}

function renderBlock(target, entries) {
  const limit = charLimit(target);
  const used = charCount(entries);
  const pct = limit === 0 ? 0 : Math.min(100, Math.round((used / limit) * 100));
  const title = target === 'user' ? 'USER PROFILE' : 'MEMORY (your personal notes)';
  const header = `══════════════════════════════════════════════\n${title} [${pct}% — ${used}/${limit} chars]\n══════════════════════════════════════════════`;
  if (!entries.length) return `${header}\n(empty)`;
  return `${header}\n${entries.join(ENTRY_DELIMITER)}`;
}

function resolveTarget(target) {
  const value = String(target || 'memory').toLowerCase();
  return VALID_TARGETS.has(value) ? value : null;
}

function usagePayload(stores, target) {
  const entries = entriesFor(stores, target);
  const used = charCount(entries);
  const limit = charLimit(target);
  return {
    target,
    usage: `${used}/${limit}`,
    used,
    limit,
    entries: [...entries],
    count: entries.length,
  };
}

function tryFoldLog(userId, opts = {}) {
  try {
    const compaction = require('./hermes-memory-compaction');
    const result = compaction.compactLog(userId, {
      nextText: opts.nextText,
      keepRecent: opts.keepRecent,
    });
    if (result && typeof result.then === 'function') return { ok: false, skipped: true };
    return result;
  } catch {
    return { ok: false };
  }
}

function rewriteTarget(userId, target, entries) {
  const id = normalizeUserId(userId);
  if (!id) return { ok: false, success: false, error: 'userId required' };
  const resolved = resolveTarget(target);
  if (!resolved) return { ok: false, success: false, error: 'target must be "memory" or "user"' };
  const stores = storesFor(id);
  const next = dedupe(entries);
  if (resolved === 'user') stores.user = next;
  else stores.memory = next;
  persistUser(id);
  return { ok: true, success: true, ...usagePayload(stores, resolved) };
}

function listNotes(userId) {
  const id = normalizeUserId(userId);
  if (!id) return [];
  const stores = storesFor(id);
  if (!Array.isArray(stores.notes)) stores.notes = [];
  return stores.notes;
}

function setNotes(userId, notes) {
  const id = normalizeUserId(userId);
  if (!id) return { ok: false };
  const stores = storesFor(id);
  stores.notes = (Array.isArray(notes) ? notes : []).filter((note) => note && note.text);
  persistUser(id);
  return { ok: true, count: stores.notes.length };
}

function successResponse(userId, target, message) {
  const stores = storesFor(userId);
  return {
    ok: true,
    success: true,
    message,
    ...usagePayload(stores, target),
  };
}

function add(userId, { target = 'memory', content, now, maxWrites, windowMs, rateLimit } = {}) {
  const id = normalizeUserId(userId);
  if (!id) return { ok: false, success: false, error: 'userId required' };
  const resolved = resolveTarget(target);
  if (!resolved) return { ok: false, success: false, error: 'target must be "memory" or "user"' };

  const text = String(content || '').trim();
  if (!text) return { ok: false, success: false, error: 'Content cannot be empty.' };
  const scanError = scanMemoryContent(text);
  if (scanError) return { ok: false, success: false, error: scanError };

  const size = checkFactSize(text);
  if (!size.ok) return size;

  const stores = storesFor(id);
  const entries = entriesFor(stores, resolved);
  if (entries.includes(text)) {
    return successResponse(id, resolved, 'Entry already exists (no duplicate added).');
  }

  const next = [...entries, text];
  const limit = charLimit(resolved);
  const newTotal = charCount(next);
  if (newTotal > limit) {
    const rateOpts = { now, maxWrites, windowMs };
    if (rateLimit !== false) {
      const ratePeek = checkWriteRate(id, { ...rateOpts, record: false });
      if (!ratePeek.ok) return ratePeek;
    }
    if (resolved === 'memory') {
      const folded = tryFoldLog(id, { nextText: text });
      if (folded && folded.ok) {
        const after = entriesFor(storesFor(id), resolved);
        const retry = [...after, text];
        if (charCount(retry) <= limit) {
          if (rateLimit !== false) {
            const rate = checkWriteRate(id, rateOpts);
            if (!rate.ok) return rate;
          }
          storesFor(id).memory = retry;
          persistUser(id);
          return successResponse(id, resolved, 'Entry added.');
        }
      }
    }
    const current = charCount(entriesFor(storesFor(id), resolved));
    if (resolved === 'user') {
      return {
        ok: false,
        success: false,
        code: 'E_PARAMS',
        status: 400,
        used: current,
        limit,
        error: `El perfil está lleno (${current}/${limit}). No se compactan los datos de perfil.`,
        current_entries: [...entriesFor(storesFor(id), resolved)],
        usage: `${current}/${limit}`,
      };
    }
    return {
      ...storeOverflowError({ current, limit, added: text.length }),
      current_entries: [...entriesFor(storesFor(id), resolved)],
      usage: `${current}/${limit}`,
    };
  }

  if (rateLimit !== false) {
    const rate = checkWriteRate(id, { now, maxWrites, windowMs });
    if (!rate.ok) return rate;
  }

  if (resolved === 'user') stores.user = next;
  else stores.memory = next;
  persistUser(id);
  return successResponse(id, resolved, 'Entry added.');
}

function findUniqueMatch(entries, oldText) {
  const needle = String(oldText || '').trim();
  if (!needle) return { error: 'old_text cannot be empty.' };
  const matches = entries
    .map((entry, index) => ({ index, entry }))
    .filter(({ entry }) => entry.includes(needle));
  if (!matches.length) return { error: `No entry matched '${needle}'.` };
  const unique = new Set(matches.map((m) => m.entry));
  if (unique.size > 1) {
    return {
      error: `Multiple entries matched '${needle}'. Be more specific.`,
      matches: matches.map((m) => (m.entry.length > 80 ? `${m.entry.slice(0, 80)}...` : m.entry)),
    };
  }
  return { index: matches[0].index, entry: matches[0].entry };
}

function replace(userId, { target = 'memory', old_text, oldText, content, now, maxWrites, windowMs, rateLimit } = {}) {
  const id = normalizeUserId(userId);
  if (!id) return { ok: false, success: false, error: 'userId required' };
  const resolved = resolveTarget(target);
  if (!resolved) return { ok: false, success: false, error: 'target must be "memory" or "user"' };

  const nextText = String(content || '').trim();
  if (!nextText) {
    return { ok: false, success: false, error: "new_content cannot be empty. Use 'remove' to delete entries." };
  }
  const scanError = scanMemoryContent(nextText);
  if (scanError) return { ok: false, success: false, error: scanError };

  const size = checkFactSize(nextText);
  if (!size.ok) return size;

  const stores = storesFor(id);
  const entries = entriesFor(stores, resolved);
  const match = findUniqueMatch(entries, old_text || oldText);
  if (match.error) return { ok: false, success: false, ...match };

  const test = [...entries];
  test[match.index] = nextText;
  const limit = charLimit(resolved);
  const newTotal = charCount(test);
  if (newTotal > limit) {
    return storeOverflowError({ current: charCount(entries), limit, added: nextText.length });
  }

  if (rateLimit !== false) {
    const rate = checkWriteRate(id, { now, maxWrites, windowMs });
    if (!rate.ok) return rate;
  }

  if (resolved === 'user') stores.user = test;
  else stores.memory = test;
  persistUser(id);
  return successResponse(id, resolved, 'Entry replaced.');
}

function remove(userId, { target = 'memory', old_text, oldText } = {}) {
  const id = normalizeUserId(userId);
  if (!id) return { ok: false, success: false, error: 'userId required' };
  const resolved = resolveTarget(target);
  if (!resolved) return { ok: false, success: false, error: 'target must be "memory" or "user"' };

  const stores = storesFor(id);
  const entries = entriesFor(stores, resolved);
  const match = findUniqueMatch(entries, old_text || oldText);
  if (match.error) return { ok: false, success: false, ...match };

  const next = entries.filter((_, index) => index !== match.index);
  if (resolved === 'user') stores.user = next;
  else stores.memory = next;
  persistUser(id);
  return successResponse(id, resolved, 'Entry removed.');
}

function read(userId, { target } = {}) {
  const id = normalizeUserId(userId);
  if (!id) return { ok: false, success: false, error: 'userId required' };
  const stores = storesFor(id);
  if (target) {
    const resolved = resolveTarget(target);
    if (!resolved) return { ok: false, success: false, error: 'target must be "memory" or "user"' };
    return { ok: true, success: true, ...usagePayload(stores, resolved) };
  }
  return {
    ok: true,
    success: true,
    memory: usagePayload(stores, 'memory'),
    user: usagePayload(stores, 'user'),
  };
}

function beginSession(userId, opts = {}) {
  const id = normalizeUserId(userId);
  if (!id) return null;
  const key = sessionKey(id, opts.chatId);
  if (!opts.refresh && snapshots.has(key)) return snapshots.get(key);

  const stores = storesFor(id);
  let notesBlock = '';
  try {
    notesBlock = require('./hermes-memory-compaction').renderNotesBlock(id);
  } catch {
    notesBlock = '';
  }
  const snap = {
    userId: id,
    chatId: opts.chatId || null,
    frozenAt: Date.now(),
    memory: renderBlock('memory', sanitizeEntriesForSnapshot(stores.memory, 'MEMORY.md')),
    user: renderBlock('user', sanitizeEntriesForSnapshot(stores.user, 'USER.md')),
    notes: notesBlock,
  };
  snapshots.set(key, snap);
  return snap;
}

function getFrozenPromptBlock(userId, opts = {}) {
  const id = normalizeUserId(userId);
  if (!id) return '';
  const stores = storesFor(id);
  if (!stores.memory.length && !stores.user.length && !(stores.notes && stores.notes.length)) return '';
  const snap = beginSession(id, opts);
  if (!snap) return '';
  return [snap.memory, snap.user, snap.notes].filter(Boolean).join('\n\n');
}

function inferTarget(entry) {
  const category = String(entry?.category || '').toLowerCase();
  if (USER_CATEGORIES.has(category)) return 'user';
  const fact = String(entry?.fact || '');
  if (/\b(prefiero|i prefer|me gusta|my name|mi nombre|respuestas en|comunicación|communication style)\b/i.test(fact)) {
    return 'user';
  }
  return 'memory';
}

function shouldLearnFromEntry(entry) {
  if (!entry?.userId || !entry?.fact) return false;
  if (entry.category === 'skill_candidate') return false;
  if (USER_CATEGORIES.has(String(entry.category || '').toLowerCase())) return true;
  if (inferTarget(entry) === 'user') return true;
  // Explicit tool/bridge remembers become agent notes (MEMORY.md).
  return String(entry.source || '') === 'hermes-memory-bridge';
}

function learnFromEntry(entry) {
  if (!shouldLearnFromEntry(entry)) {
    return { ok: false, skipped: true, reason: 'not_learnable' };
  }
  return add(entry.userId, {
    target: inferTarget(entry),
    content: String(entry.fact).trim(),
    rateLimit: false,
  });
}

function learnFromFacts(userId, facts) {
  const results = [];
  for (const fact of Array.isArray(facts) ? facts : []) {
    const text = typeof fact === 'string' ? fact : fact?.fact;
    if (!text) continue;
    results.push(add(userId, {
      target: inferTarget({ fact: text, category: fact?.category }),
      content: String(text).trim(),
      rateLimit: false,
    }));
  }
  return results;
}

function forgetMatching(userId, query) {
  const id = normalizeUserId(userId);
  if (!id || !query) return { removed: 0 };
  const needle = String(query).trim();
  if (!needle) return { removed: 0 };
  const stores = storesFor(id);
  let removed = 0;
  for (const target of ['memory', 'user']) {
    const entries = entriesFor(stores, target);
    const next = entries.filter((entry) => {
      if (entry.toLowerCase().includes(needle.toLowerCase())) {
        removed += 1;
        return false;
      }
      return true;
    });
    if (target === 'user') stores.user = next;
    else stores.memory = next;
  }
  const notes = Array.isArray(stores.notes) ? stores.notes : [];
  const nextNotes = notes.filter((note) => {
    if (String(note.text || '').toLowerCase().includes(needle.toLowerCase())) {
      removed += 1;
      return false;
    }
    return true;
  });
  stores.notes = nextNotes;
  if (removed) persistUser(id);
  return { removed };
}

function invalidateSnapshots(userId) {
  const id = normalizeUserId(userId);
  if (!id) return 0;
  let removed = 0;
  for (const key of snapshots.keys()) {
    if (key.startsWith(`${id}::`)) {
      snapshots.delete(key);
      removed += 1;
    }
  }
  return removed;
}

function clearUser(userId) {
  const id = normalizeUserId(userId);
  if (!id) return { cleared: 0 };
  const stores = storesFor(id);
  const cleared = stores.memory.length + stores.user.length + (stores.notes ? stores.notes.length : 0);
  liveByUser.set(id, emptyStores());
  persistUser(id);
  invalidateSnapshots(id);
  return { cleared };
}

function status(userId) {
  const id = normalizeUserId(userId);
  const base = {
    pattern: 'hermes-frozen-snapshot',
    stores: ['memory', 'user'],
    memoryCharLimit: MEMORY_CHAR_LIMIT,
    userCharLimit: USER_CHAR_LIMIT,
  };
  if (!id) return base;
  const stores = storesFor(id);
  return {
    ...base,
    memory: usagePayload(stores, 'memory'),
    user: usagePayload(stores, 'user'),
    snapshots: [...snapshots.keys()].filter((key) => key.startsWith(`${id}::`)).length,
  };
}

function resetForTests() {
  liveByUser.clear();
  hydratedUsers.clear();
  snapshots.clear();
}

module.exports = {
  ENTRY_DELIMITER,
  MEMORY_CHAR_LIMIT,
  USER_CHAR_LIMIT,
  add,
  replace,
  remove,
  read,
  rewriteTarget,
  listNotes,
  setNotes,
  beginSession,
  getFrozenPromptBlock,
  learnFromEntry,
  learnFromFacts,
  forgetMatching,
  invalidateSnapshots,
  clearUser,
  status,
  scanMemoryContent,
  resetForTests,
};

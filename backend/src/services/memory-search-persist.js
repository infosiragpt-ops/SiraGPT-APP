'use strict';

/**
 * 3H-BE-012 — Hermes idea rewritten: searchable memory that survives process restart.
 * 3H2-BE-018 leftover: actual search, TTL prune, never cross-user.
 * File under /app/data (scheduler_data volume). Scoped by userId. Never throws.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = process.env.SIRAGPT_MEMORY_SEARCH_PATH || '/app/data/memory-search.json';
const MAX_PER_USER = 200;
const MAX_TEXT = 4000;
const MAX_QUERY_CHARS = 200;
const MAX_ITEMS_PER_USER = 200;
const MAX_CHAT_ID_CHARS = 128;
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function loadIndex(file = DEFAULT_PATH) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveIndex(index, file = DEFAULT_PATH) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

function pruneUserList(list, now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  const arr = (Array.isArray(list) ? list : []).filter((e) => e && (now - Number(e.at || 0)) <= ttlMs);
  if (arr.length > MAX_ITEMS_PER_USER) return arr.slice(arr.length - MAX_ITEMS_PER_USER);
  return arr;
}

function persistEpisode({ userId, chatId = null, text, file = DEFAULT_PATH } = {}) {
  // 3H3-BE-017 leftover: cap per-user episodes (TTL prune already shipped).
  const uid = String(userId || '').trim();
  const rawText = String(text || '').trim();
  if (!uid) return { indexed: 0, error: 'user_required' };
  if (!rawText) return { indexed: 0, error: 'empty_text' };
  // 3H15 leftover: oversized text fail-closed (never silent slice into identity).
  if (rawText.length > MAX_TEXT) return { indexed: 0, error: 'payload_too_long' };
  const body = rawText;
  const index = loadIndex(file);
  const list = pruneUserList(index[uid]);
  const cidRaw = chatId == null || chatId === '' ? null : String(chatId);
  // 3H15 leftover: oversized chatId fail-closed (never identity).
  if (cidRaw && cidRaw.length > MAX_CHAT_ID_CHARS) return { indexed: 0, error: 'chat_id_too_long' };
  const cid = cidRaw;
  const last = list.length ? list[list.length - 1] : null;
  // 3H14 leftover: duplicate skip (same text+chatId) — never double-index a retry.
  if (last && last.text === body && String(last.chatId || '') === String(cid || '')) {
    return { indexed: 0, duplicate: true, size: list.length, persisted: true };
  }
  list.push({ userId: uid, chatId: cid, text: body, at: Date.now() });
  index[uid] = pruneUserList(list);
  saveIndex(index, file);
  return { indexed: 1, size: index[uid].length, persisted: true };
}

function loadUserEpisodes(userId, file = DEFAULT_PATH) {
  const uid = String(userId || '').trim();
  if (!uid) return [];
  const index = loadIndex(file);
  const list = pruneUserList(index[uid]);
  if (index[uid] && list.length !== index[uid].length) {
    index[uid] = list;
    saveIndex(index, file);
  }
  return list;
}

function searchUserEpisodes({ userId, query, limit = 8, chatId = null, file = DEFAULT_PATH } = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return [];
  const q = String(query || '').trim().toLowerCase().slice(0, MAX_QUERY_CHARS);
  if (!q) return [];
  const terms = q.split(/\s+/).filter((t) => t.length >= 2).slice(0, 8);
  const list = loadUserEpisodes(uid, file);
  const cid = chatId == null || chatId === '' ? null : String(chatId);
  const scored = [];
  for (const ep of list) {
    if (ep && ep.userId && ep.userId !== uid) continue; // never cross-user
    if (cid && String(ep.chatId || '') !== cid) continue;
    const hay = String(ep && ep.text || '').toLowerCase();
    let score = 0;
    for (const t of terms) {
      let idx = 0;
      while ((idx = hay.indexOf(t, idx)) !== -1) { score += 1; idx += t.length; }
    }
    if (score > 0) scored.push({ ...ep, score });
  }
  scored.sort((a, b) => (b.score - a.score) || (b.at - a.at));
  return scored.slice(0, Math.max(1, Math.min(40, Number(limit) || 8)));
}

function deleteUserEpisodes({ userId, chatId = null, file = DEFAULT_PATH } = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return { deleted: 0, error: 'user_required' };
  const index = loadIndex(file);
  const list = Array.isArray(index[uid]) ? index[uid] : [];
  const cid = chatId == null || chatId === '' ? null : String(chatId);
  const kept = cid ? list.filter((e) => String(e && e.chatId || '') !== cid) : [];
  const deleted = list.length - kept.length;
  if (!cid) index[uid] = [];
  else index[uid] = kept;
  saveIndex(index, file);
  return { ok: true, deleted, userId: uid, chatId: cid };
}

module.exports = {
  persistEpisode,
  loadUserEpisodes,
  searchUserEpisodes,
  deleteUserEpisodes,
  pruneUserList,
  loadIndex,
  saveIndex,
  DEFAULT_PATH,
  MAX_PER_USER,
  MAX_QUERY_CHARS,
  MAX_TEXT,
  MAX_CHAT_ID_CHARS,
  DEFAULT_TTL_MS,
};

'use strict';

/**
 * memory/chat-history-search — the "past chats" rung of agentic search.
 *
 * Full-text search over the user's own messages (Postgres `content_tsv`,
 * `websearch_to_tsquery`), the same query the /api/search route runs, exposed
 * as a service so the agent's `chat_history_search` tool and subagents can
 * reach it. ILIKE fallback when the tsvector column is absent (SQLite/dev).
 */

const FTS_LANGS = new Set(['spanish', 'english', 'simple', 'portuguese', 'french', 'german', 'italian']);

const deps = { prisma: null, log: console };
function setDeps(next = {}) { Object.assign(deps, next); }
function resetForTests() { deps.prisma = null; }

function prisma() {
  if (deps.prisma) return deps.prisma;
  try {
    // eslint-disable-next-line global-require
    deps.prisma = require('../../config/database');
  } catch { deps.prisma = null; }
  return deps.prisma;
}

function buildFtsQuery({ userId, query, lang = 'spanish', chatId = null, excludeChatId = null, limit = 8 }) {
  const params = [FTS_LANGS.has(lang) ? lang : 'spanish', String(query || '').slice(0, 400), userId];
  let sql = `
    SELECT m."id"        AS "messageId",
           m."chatId"    AS "chatId",
           c."title"     AS "chatTitle",
           m."role"      AS "role",
           m."timestamp" AS "timestamp",
           ts_rank(m."content_tsv", websearch_to_tsquery($1::regconfig, $2)) AS "rank",
           ts_headline($1::regconfig, m."content", websearch_to_tsquery($1::regconfig, $2),
                       'MaxFragments=2, MaxWords=24, MinWords=6, StartSel=«, StopSel=»') AS "snippet"
      FROM "messages" m
      JOIN "chats"    c ON c."id" = m."chatId"
     WHERE c."userId"    = $3
       AND c."deletedAt" IS NULL
       AND m."deletedAt" IS NULL
       AND m."content_tsv" @@ websearch_to_tsquery($1::regconfig, $2)`;
  if (chatId) { params.push(chatId); sql += `\n       AND m."chatId" = $${params.length}`; }
  if (excludeChatId) { params.push(excludeChatId); sql += `\n       AND m."chatId" <> $${params.length}`; }
  params.push(Math.max(1, Math.min(30, Number(limit) || 8)));
  sql += `\n     ORDER BY "rank" DESC, m."timestamp" DESC\n     LIMIT $${params.length}`;
  return { sql, params };
}

function buildIlikeQuery({ userId, query, chatId = null, excludeChatId = null, limit = 8 }) {
  const params = [userId, `%${String(query || '').slice(0, 200)}%`];
  let sql = `
    SELECT m."id" AS "messageId", m."chatId" AS "chatId", c."title" AS "chatTitle", m."role" AS "role",
           m."timestamp" AS "timestamp", 0.1 AS "rank", LEFT(m."content", 240) AS "snippet"
      FROM "messages" m JOIN "chats" c ON c."id" = m."chatId"
     WHERE c."userId" = $1 AND c."deletedAt" IS NULL AND m."deletedAt" IS NULL AND m."content" ILIKE $2`;
  if (chatId) { params.push(chatId); sql += ` AND m."chatId" = $${params.length}`; }
  if (excludeChatId) { params.push(excludeChatId); sql += ` AND m."chatId" <> $${params.length}`; }
  params.push(Math.max(1, Math.min(30, Number(limit) || 8)));
  sql += ` ORDER BY m."timestamp" DESC LIMIT $${params.length}`;
  return { sql, params };
}

function normalizeRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    messageId: r.messageId,
    chatId: r.chatId,
    chatTitle: r.chatTitle || null,
    role: r.role,
    timestamp: r.timestamp ? new Date(r.timestamp).toISOString() : null,
    rank: Number(r.rank || 0),
    snippet: String(r.snippet || '').replace(/\s+/g, ' ').trim(),
  }));
}

/**
 * Search the user's past chats. `{ ok, mode: 'fts'|'ilike', results[] }`. Never throws.
 */
async function searchUserMessages(userId, query, { lang = 'spanish', chatId = null, excludeChatId = null, limit = 8 } = {}) {
  const q = String(query || '').trim();
  if (!userId || q.length < 2) return { ok: false, error: 'query_too_short', results: [] };
  const db = prisma();
  if (!db || typeof db.$queryRawUnsafe !== 'function') return { ok: false, error: 'db_unavailable', results: [] };
  try {
    const { sql, params } = buildFtsQuery({ userId, query: q, lang, chatId, excludeChatId, limit });
    const rows = await db.$queryRawUnsafe(sql, ...params);
    return { ok: true, mode: 'fts', results: normalizeRows(rows) };
  } catch (err) {
    deps.log.warn?.(`[chat-history-search] fts failed (${err && err.message}); falling back to ILIKE`);
    try {
      const { sql, params } = buildIlikeQuery({ userId, query: q, chatId, excludeChatId, limit });
      const rows = await db.$queryRawUnsafe(sql, ...params);
      return { ok: true, mode: 'ilike', results: normalizeRows(rows) };
    } catch (err2) {
      deps.log.warn?.(`[chat-history-search] ilike failed: ${err2 && err2.message}`);
      return { ok: false, error: 'search_failed', results: [] };
    }
  }
}

module.exports = { searchUserMessages, buildFtsQuery, buildIlikeQuery, normalizeRows, FTS_LANGS, setDeps, resetForTests };

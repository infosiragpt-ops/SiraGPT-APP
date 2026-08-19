'use strict';

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;
const MESSAGE_FETCH_MULTIPLIER = 6;
const SNIPPET_RADIUS = 180;

function normalizeForSearch(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Mark}+/gu, '');
}

function clampLimit(value, fallback = DEFAULT_LIMIT) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.max(1, Math.min(Math.floor(n), MAX_LIMIT));
}

function tokenize(value) {
  return normalizeForSearch(value)
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function rawTokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function uniqueTokens(value) {
  return [...new Set(tokenize(value))];
}

function uniqueSearchTerms(value) {
  return [...new Set([...rawTokens(value), ...tokenize(value)])];
}

function scoreContent(content, terms) {
  const text = normalizeForSearch(content);
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = text.match(new RegExp(escaped, 'gi'));
    if (matches) score += matches.length;
  }
  return score;
}

function makeSnippet(content, terms, maxChars = 420) {
  const raw = String(content || '').replace(/\s+/g, ' ').trim();
  if (raw.length <= maxChars) return raw;
  const lower = normalizeForSearch(raw);
  const firstHit = terms
    .map((term) => lower.indexOf(normalizeForSearch(term)))
    .filter((idx) => idx >= 0)
    .sort((a, b) => a - b)[0];
  const center = firstHit >= 0 ? firstHit : 0;
  const start = Math.max(0, center - SNIPPET_RADIUS);
  const end = Math.min(raw.length, start + maxChars);
  return `${start > 0 ? '...' : ''}${raw.slice(start, end)}${end < raw.length ? '...' : ''}`;
}

function normalizeMessage(row, terms) {
  const chat = row.chat || {};
  return {
    messageId: row.id,
    sessionId: row.chatId,
    sessionTitle: chat.title || '',
    role: row.role,
    at: row.timestamp,
    score: scoreContent(row.content, terms),
    snippet: makeSnippet(row.content, terms),
  };
}

async function searchSessions(args = {}, ctx = {}, deps = {}) {
  const prisma = deps.prisma || require('../config/database');
  const userId = ctx.userId || args.userId;
  if (!userId) throw new Error('session_search: ctx.userId required');

  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return { error: 'missing "query"', results: [] };

  const limit = clampLimit(args.limit);
  const terms = uniqueTokens(query);
  if (terms.length === 0) return { error: 'query has no searchable terms', results: [] };

  const includeArchived = Boolean(args.includeArchived);
  const sessionId = typeof args.sessionId === 'string' && args.sessionId.trim()
    ? args.sessionId.trim()
    : null;

  const chatWhere = {
    userId,
    deletedAt: null,
    ...(includeArchived ? {} : { isArchived: false }),
    ...(sessionId ? { id: sessionId } : {}),
  };

  const orTerms = uniqueSearchTerms(query).slice(0, 12).map((term) => ({
    content: { contains: term, mode: 'insensitive' },
  }));

  const rows = await prisma.message.findMany({
    where: {
      deletedAt: null,
      OR: orTerms,
      chat: chatWhere,
    },
    orderBy: { timestamp: 'desc' },
    take: Math.max(limit * MESSAGE_FETCH_MULTIPLIER, limit),
    select: {
      id: true,
      chatId: true,
      role: true,
      content: true,
      timestamp: true,
      chat: {
        select: {
          id: true,
          title: true,
          updatedAt: true,
        },
      },
    },
  });

  const scored = rows
    .map((row) => normalizeMessage(row, terms))
    .filter((row) => row.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.at).getTime() - new Date(a.at).getTime();
    })
    .slice(0, limit);

  return {
    query,
    count: scored.length,
    results: scored,
  };
}

module.exports = {
  searchSessions,
  _internal: {
    clampLimit,
    makeSnippet,
    normalizeForSearch,
    rawTokens,
    scoreContent,
    tokenize,
    uniqueSearchTerms,
    uniqueTokens,
  },
};

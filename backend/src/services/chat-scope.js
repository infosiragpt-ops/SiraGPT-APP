function parsePositiveInt(value, fallback, { min = 1, max = 100 } = {}) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function parseBoolean(value) {
  return value === true || value === 'true' || value === '1';
}

function tokenizeSearchQuery(search) {
  return String(search || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 8);
}

function buildChatListWhere({ userId, projectId = null, includeProjects = false, search = '' }) {
  if (!userId) throw new Error('userId is required');

  const where = { userId };

  if (projectId) {
    where.projectId = projectId;
  } else if (!includeProjects) {
    where.projectId = null;
  }

  const tokens = tokenizeSearchQuery(search);
  if (tokens.length === 1) {
    const q = tokens[0];
    where.OR = [
      { title: { contains: q, mode: 'insensitive' } },
      { messages: { some: { content: { contains: q, mode: 'insensitive' } } } },
    ];
  } else if (tokens.length > 1) {
    // Every token must match title OR a message — tighter relevance for multi-word queries
    where.AND = tokens.map((token) => ({
      OR: [
        { title: { contains: token, mode: 'insensitive' } },
        { messages: { some: { content: { contains: token, mode: 'insensitive' } } } },
      ],
    }));
  }

  return where;
}

module.exports = {
  buildChatListWhere,
  parseBoolean,
  parsePositiveInt,
  tokenizeSearchQuery,
};

function parsePositiveInt(value, fallback, { min = 1, max = 100 } = {}) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function parseBoolean(value) {
  return value === true || value === 'true' || value === '1';
}

function buildChatListWhere({
  userId,
  projectId = null,
  includeProjects = false,
  includeArchived = false,
  search = '',
}) {
  if (!userId) throw new Error('userId is required');

  const where = { userId };

  if (!includeArchived) {
    where.isArchived = false;
  }

  if (projectId) {
    where.projectId = projectId;
  } else if (!includeProjects) {
    where.projectId = null;
  }

  const q = String(search || '').trim();
  if (q) {
    where.OR = [
      { title: { contains: q, mode: 'insensitive' } },
      { messages: { some: { content: { contains: q, mode: 'insensitive' } } } },
    ];
  }

  return where;
}

module.exports = {
  buildChatListWhere,
  parseBoolean,
  parsePositiveInt,
};

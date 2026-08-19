const test = require('node:test');
const assert = require('node:assert/strict');

const {
  searchSessions,
  _internal,
} = require('../src/services/session-search');

test('session_search searches only sessions owned by the current user', async () => {
  const calls = [];
  const prisma = {
    message: {
      findMany: async (query) => {
        calls.push(query);
        return [
          {
            id: 'm1',
            chatId: 'c1',
            role: 'user',
            content: 'La tesis tiene un pago pendiente y anexos por revisar.',
            timestamp: new Date('2026-06-01T10:00:00Z'),
            chat: { id: 'c1', title: 'Tesis RSN', updatedAt: new Date('2026-06-01T11:00:00Z') },
          },
          {
            id: 'm2',
            chatId: 'c2',
            role: 'assistant',
            content: 'Mensaje sin relación con la consulta.',
            timestamp: new Date('2026-05-30T10:00:00Z'),
            chat: { id: 'c2', title: 'Otro chat', updatedAt: new Date('2026-05-30T11:00:00Z') },
          },
        ];
      },
    },
  };

  const out = await searchSessions(
    { query: 'TÉSIS pago', limit: 2 },
    { userId: 'u1' },
    { prisma },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].where.chat.userId, 'u1');
  assert.equal(calls[0].where.chat.deletedAt, null);
  assert.equal(calls[0].where.chat.isArchived, false);
  assert.ok(calls[0].where.OR.some((entry) => entry.content.contains === 'tésis'));
  assert.ok(calls[0].where.OR.some((entry) => entry.content.contains === 'tesis'));
  assert.equal(calls[0].take, 12);
  assert.equal(out.count, 1);
  assert.equal(out.results[0].messageId, 'm1');
  assert.equal(out.results[0].sessionId, 'c1');
  assert.equal(out.results[0].sessionTitle, 'Tesis RSN');
  assert.match(out.results[0].snippet, /tesis tiene un pago/i);
});

test('session_search supports sessionId and archived opt-in', async () => {
  let captured = null;
  const prisma = {
    message: {
      findMany: async (query) => {
        captured = query;
        return [];
      },
    },
  };

  await searchSessions(
    { query: 'anexo', sessionId: 'chat_123', includeArchived: true, limit: 99 },
    { userId: 'u1' },
    { prisma },
  );

  assert.equal(captured.where.chat.id, 'chat_123');
  assert.equal(Object.hasOwn(captured.where.chat, 'isArchived'), false);
  assert.equal(captured.take, 150);
});

test('session_search validates query and user scope', async () => {
  const prisma = {
    message: {
      findMany: async () => {
        throw new Error('should not query');
      },
    },
  };

  const empty = await searchSessions({ query: '   ' }, { userId: 'u1' }, { prisma });
  assert.equal(empty.error, 'missing "query"');
  assert.deepEqual(empty.results, []);

  await assert.rejects(
    () => searchSessions({ query: 'tesis' }, {}, { prisma }),
    /ctx\.userId required/,
  );
});

test('session_search scoring is accent-insensitive', () => {
  assert.equal(_internal.normalizeForSearch('TÉSIS Jurídica'), 'tesis juridica');
  assert.deepEqual(_internal.uniqueSearchTerms('TÉSIS jurídica'), ['tésis', 'jurídica', 'tesis', 'juridica']);
  assert.equal(_internal.scoreContent('Tésis TESIS tesis', ['tesis']), 3);
});

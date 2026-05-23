const assert = require('node:assert/strict');
const test = require('node:test');
const request = require('supertest');
const {
  buildRouteTestApp,
  installAuthSessionMock,
  mockResolvedModule,
  reloadModule,
} = require('./http-test-utils');
const prisma = require('../src/config/database');

function makeRun(overrides = {}) {
  return {
    id: 'run-1',
    chatId: 'chat-1',
    userId: 'user-1',
    status: 'running',
    model: 'Gema4 31B',
    provider: 'local',
    messageId: 'msg-1',
    partialContent: 'hello world',
    startedAt: new Date('2026-05-23T10:00:00.000Z'),
    lastChunkAt: new Date('2026-05-23T10:00:01.000Z'),
    completedAt: null,
    cancelledAt: null,
    cancelReason: null,
    attempt: 1,
    error: null,
    updatedAt: new Date('2026-05-23T10:00:01.000Z'),
    ...overrides,
  };
}

function createMockStore() {
  const chats = new Map([
    ['chat-1', { id: 'chat-1', userId: 'user-1', deletedAt: null, isPinned: false, isArchived: false }],
    ['chat-2', { id: 'chat-2', userId: 'other-user', deletedAt: null, isPinned: false, isArchived: false }],
  ]);
  const runs = new Map([
    ['run-1', makeRun()],
    ['run-2', makeRun({ id: 'run-2', chatId: 'chat-1', status: 'completed', partialContent: 'done' })],
    ['run-3', makeRun({ id: 'run-3', chatId: 'chat-2', userId: 'other-user', status: 'running' })],
  ]);

  return { chats, runs };
}

function matchesWhere(record, where = {}) {
  for (const [key, expected] of Object.entries(where)) {
    const actual = record[key];
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if (Array.isArray(expected.in)) {
        if (!expected.in.includes(actual)) return false;
        continue;
      }
      if (expected.equals !== undefined && actual !== expected.equals) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

function sortRows(rows, orderBy) {
  if (!orderBy) return rows;
  const [[field, direction]] = Object.entries(orderBy);
  return rows.sort((a, b) => {
    const aValue = a[field] instanceof Date ? a[field].getTime() : a[field];
    const bValue = b[field] instanceof Date ? b[field].getTime() : b[field];
    if (aValue === bValue) return 0;
    return direction === 'desc' ? (aValue > bValue ? -1 : 1) : (aValue > bValue ? 1 : -1);
  });
}

function selectFields(record, select) {
  if (!select) return { ...record };
  return Object.fromEntries(Object.keys(select).map((key) => [key, record[key]]));
}

test.describe('chat run HTTP endpoints', () => {
  let app;
  let auth;
  let originalChat;
  let originalChatRun;
  let restoreTriggers;
  let store;

  test.beforeEach(() => {
    store = createMockStore();
    auth = installAuthSessionMock({ id: 'user-1', email: 'user-1@example.com' });
    restoreTriggers = mockResolvedModule(require.resolve('../src/services/trigger-registry'), {
      publish: async () => {},
    });
    delete require.cache[require.resolve('../src/routes/chats')];
    app = buildRouteTestApp('/api/chats', reloadModule('../src/routes/chats'));

    originalChat = prisma.chat;
    originalChatRun = prisma.chatRun;

    prisma.chat = {
      findFirst: async ({ where, select } = {}) => {
        const chat = Array.from(store.chats.values()).find((row) => matchesWhere(row, where));
        return chat ? selectFields(chat, select) : null;
      },
      update: async ({ where, data, select } = {}) => {
        const chat = store.chats.get(where.id);
        if (!chat) throw new Error('chat not found');
        const updated = { ...chat, ...data };
        store.chats.set(where.id, updated);
        return selectFields(updated, select);
      },
    };

    prisma.chatRun = {
      findMany: async ({ where, orderBy, take } = {}) => {
        const rows = Array.from(store.runs.values()).filter((row) => matchesWhere(row, where));
        return sortRows(rows, orderBy).slice(0, take || rows.length);
      },
      findFirst: async ({ where, orderBy } = {}) => {
        return sortRows(
          Array.from(store.runs.values()).filter((row) => matchesWhere(row, where)),
          orderBy,
        )[0] || null;
      },
      findUnique: async ({ where } = {}) => store.runs.get(where.id) || null,
      update: async ({ where, data } = {}) => {
        const run = store.runs.get(where.id);
        if (!run) throw new Error('run not found');
        const updated = { ...run, ...data };
        store.runs.set(where.id, updated);
        return updated;
      },
    };
  });

  test.afterEach(() => {
    prisma.chat = originalChat;
    prisma.chatRun = originalChatRun;
    restoreTriggers();
    auth.restore();
    delete require.cache[require.resolve('../src/routes/chats')];
  });

  test('lists only non-terminal active runs for the authenticated user', async () => {
    store.runs.set('run-4', makeRun({
      id: 'run-4',
      partialContent: 'x'.repeat(300),
      updatedAt: new Date('2026-05-23T10:01:00.000Z'),
    }));

    const response = await request(app)
      .get('/api/chats/active-runs')
      .set('Authorization', auth.authHeader)
      .expect(200);

    assert.equal(response.body.runs.length, 2);
    assert.equal(response.body.runs[0].runId, 'run-4');
    assert.equal(response.body.runs[0].snippet.length, 240);
    assert.equal(response.body.runs.some((run) => run.runId === 'run-2'), false);
    assert.equal(response.body.runs.some((run) => Object.hasOwn(run, 'partialContent')), false);
  });

  test('returns the latest active run for an owned chat', async () => {
    const response = await request(app)
      .get('/api/chats/chat-1/run/active')
      .set('Authorization', auth.authHeader)
      .expect(200);

    assert.equal(response.body.run.runId, 'run-1');
    assert.equal(response.body.run.chatId, 'chat-1');
  });

  test('does not expose active runs for another user chat', async () => {
    await request(app)
      .get('/api/chats/chat-2/run/active')
      .set('Authorization', auth.authHeader)
      .expect(404);
  });

  test('cancels a non-terminal run with a bounded reason', async () => {
    const response = await request(app)
      .post('/api/chats/chat-1/run/run-1/cancel')
      .set('Authorization', auth.authHeader)
      .send({ reason: 'r'.repeat(300) })
      .expect(200);

    assert.equal(response.body.ok, true);
    assert.equal(response.body.run.status, 'cancelled');
    assert.equal(response.body.run.cancelReason.length, 256);
    assert.equal(store.runs.get('run-1').status, 'cancelled');
  });

  test('returns noop when cancelling a terminal run', async () => {
    const response = await request(app)
      .post('/api/chats/chat-1/run/run-2/cancel')
      .set('Authorization', auth.authHeader)
      .send({ reason: 'late' })
      .expect(200);

    assert.equal(response.body.noop, true);
    assert.equal(response.body.run.status, 'completed');
    assert.equal(store.runs.get('run-2').status, 'completed');
  });

  test('streams a terminal snapshot and done event', async () => {
    const response = await request(app)
      .get('/api/chats/chat-1/run/run-2/stream')
      .set('Authorization', auth.authHeader)
      .buffer(true)
      .parse((res, callback) => {
        res.setEncoding('utf8');
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => callback(null, data));
      })
      .expect(200);

    const streamBody = response.text || response.body;
    assert.equal(typeof streamBody, 'string');
    assert.match(streamBody, /event: snapshot/);
    assert.match(streamBody, /event: done/);
    assert.match(streamBody, /"status":"completed"/);
  });

  test('updates pin state for an owned chat', async () => {
    const response = await request(app)
      .patch('/api/chats/chat-1/pin')
      .set('Authorization', auth.authHeader)
      .send({ pinned: true })
      .expect(200);

    assert.equal(response.body.chat.isPinned, true);
    assert.ok(response.body.chat.pinnedAt);

    const unpinned = await request(app)
      .patch('/api/chats/chat-1/pin')
      .set('Authorization', auth.authHeader)
      .send({ pinned: 'false' })
      .expect(200);

    assert.equal(unpinned.body.chat.isPinned, false);
    assert.equal(store.chats.get('chat-1').pinnedAt, null);
  });

  test('updates archive state for an owned chat', async () => {
    const response = await request(app)
      .patch('/api/chats/chat-1/archive')
      .set('Authorization', auth.authHeader)
      .send({ archived: true })
      .expect(200);

    assert.equal(response.body.chat.isArchived, true);

    const restored = await request(app)
      .patch('/api/chats/chat-1/archive')
      .set('Authorization', auth.authHeader)
      .send({ archived: 'false' })
      .expect(200);

    assert.equal(restored.body.chat.isArchived, false);
  });
});

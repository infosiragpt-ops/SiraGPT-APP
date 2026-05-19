// Bookmark folders — cycle 23 extension.
//
// We mount the real router and stub the prisma client methods the
// route touches (message.findFirst, bookmark.upsert/findMany/
// findUnique/update). Auth is mocked via the shared helper. The tests
// assert the wire contract — query/body parsing, folder filter
// semantics, PUT field surface — without needing a real database.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const prisma = require('../src/config/database');
const {
  buildRouteTestApp,
  installAuthSessionMock,
  reloadModule,
} = require('./http-test-utils');

describe('Bookmark folders', () => {
  let auth;
  let originals;

  beforeEach(() => {
    auth = installAuthSessionMock();
    delete require.cache[require.resolve('../src/routes/bookmarks')];

    // Preserve whatever the prisma stub had so we can restore later.
    // The Prisma client in this codebase already exposes these
    // namespaces; tests just swap the function bodies.
    prisma.bookmark = prisma.bookmark || {};
    prisma.message = prisma.message || {};
    originals = {
      bookmarkUpsert: prisma.bookmark.upsert,
      bookmarkFindMany: prisma.bookmark.findMany,
      bookmarkFindUnique: prisma.bookmark.findUnique,
      bookmarkUpdate: prisma.bookmark.update,
      bookmarkDelete: prisma.bookmark.delete,
      messageFindFirst: prisma.message.findFirst,
    };
  });

  afterEach(() => {
    auth.restore();
    Object.assign(prisma.bookmark, {
      upsert: originals.bookmarkUpsert,
      findMany: originals.bookmarkFindMany,
      findUnique: originals.bookmarkFindUnique,
      update: originals.bookmarkUpdate,
      delete: originals.bookmarkDelete,
    });
    prisma.message.findFirst = originals.messageFindFirst;
    delete require.cache[require.resolve('../src/routes/bookmarks')];
  });

  function buildApp() {
    return buildRouteTestApp('/api/bookmarks', reloadModule('../src/routes/bookmarks'));
  }

  test('POST persists folder when provided', async () => {
    prisma.message.findFirst = async () => ({ id: 'msg-1' });
    let upsertArgs = null;
    prisma.bookmark.upsert = async (args) => {
      upsertArgs = args;
      return {
        id: 'bk-1',
        userId: auth.user.id,
        messageId: 'msg-1',
        note: null,
        folder: 'Prompts',
        createdAt: new Date('2026-05-19T00:00:00Z'),
      };
    };

    const res = await request(buildApp())
      .post('/api/bookmarks')
      .set('Authorization', auth.authHeader)
      .send({ messageId: 'msg-1', folder: 'Prompts' });

    assert.equal(res.status, 201);
    assert.equal(res.body.folder, 'Prompts');
    assert.equal(upsertArgs.create.folder, 'Prompts');
    assert.equal(upsertArgs.update.folder, 'Prompts');
  });

  test('POST trims/truncates folder and treats blank as null', async () => {
    prisma.message.findFirst = async () => ({ id: 'msg-1' });
    let captured;
    prisma.bookmark.upsert = async (args) => {
      captured = args;
      return {
        id: 'bk-1', userId: auth.user.id, messageId: 'msg-1',
        note: null, folder: null, createdAt: new Date(),
      };
    };

    const res = await request(buildApp())
      .post('/api/bookmarks')
      .set('Authorization', auth.authHeader)
      .send({ messageId: 'msg-1', folder: '   ' });

    assert.equal(res.status, 201);
    // empty after trim → undefined in update payload (so we don't
    // accidentally clobber an existing folder on re-star)
    assert.equal(captured.create.folder, undefined);
    assert.equal(captured.update.folder, undefined);
  });

  test('GET ?folder=Prompts filters by exact folder', async () => {
    let observedWhere;
    prisma.bookmark.findMany = async (args) => {
      observedWhere = args.where;
      return [];
    };

    const res = await request(buildApp())
      .get('/api/bookmarks?folder=Prompts')
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 200);
    assert.deepEqual(observedWhere, { userId: auth.user.id, folder: 'Prompts' });
  });

  test('GET ?folder=__none__ matches NULL folder rows', async () => {
    let observedWhere;
    prisma.bookmark.findMany = async (args) => {
      observedWhere = args.where;
      return [];
    };

    const res = await request(buildApp())
      .get('/api/bookmarks?folder=__none__')
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 200);
    assert.deepEqual(observedWhere, { userId: auth.user.id, folder: null });
  });

  test('GET without folder param does not add a folder predicate', async () => {
    let observedWhere;
    prisma.bookmark.findMany = async (args) => {
      observedWhere = args.where;
      return [];
    };

    const res = await request(buildApp())
      .get('/api/bookmarks')
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 200);
    assert.deepEqual(observedWhere, { userId: auth.user.id });
  });

  test('PUT updates folder and returns 404 for other users', async () => {
    prisma.bookmark.findUnique = async () => ({
      id: 'bk-1', userId: 'someone-else', messageId: 'msg-1', folder: null, note: null,
      createdAt: new Date(),
    });

    const res = await request(buildApp())
      .put('/api/bookmarks/bk-1')
      .set('Authorization', auth.authHeader)
      .send({ folder: 'Bugs' });

    assert.equal(res.status, 404);
  });

  test('PUT updates folder when owned and echoes the new value', async () => {
    prisma.bookmark.findUnique = async () => ({
      id: 'bk-1', userId: auth.user.id, messageId: 'msg-1', folder: null, note: null,
      createdAt: new Date('2026-05-19T00:00:00Z'),
    });
    let updateArgs;
    prisma.bookmark.update = async (args) => {
      updateArgs = args;
      return {
        id: 'bk-1', userId: auth.user.id, messageId: 'msg-1',
        folder: 'Bugs', note: null, createdAt: new Date('2026-05-19T00:00:00Z'),
      };
    };

    const res = await request(buildApp())
      .put('/api/bookmarks/bk-1')
      .set('Authorization', auth.authHeader)
      .send({ folder: 'Bugs' });

    assert.equal(res.status, 200);
    assert.equal(res.body.folder, 'Bugs');
    assert.deepEqual(updateArgs, { where: { id: 'bk-1' }, data: { folder: 'Bugs' } });
  });

  test('PUT accepts explicit null to clear folder', async () => {
    prisma.bookmark.findUnique = async () => ({
      id: 'bk-1', userId: auth.user.id, messageId: 'msg-1', folder: 'Prompts', note: null,
      createdAt: new Date(),
    });
    let updateArgs;
    prisma.bookmark.update = async (args) => {
      updateArgs = args;
      return { id: 'bk-1', userId: auth.user.id, messageId: 'msg-1', folder: null, note: null, createdAt: new Date() };
    };

    const res = await request(buildApp())
      .put('/api/bookmarks/bk-1')
      .set('Authorization', auth.authHeader)
      .send({ folder: null });

    assert.equal(res.status, 200);
    assert.equal(res.body.folder, null);
    assert.equal(updateArgs.data.folder, null);
  });

  test('PUT empty body returns 400 (no updatable fields)', async () => {
    const res = await request(buildApp())
      .put('/api/bookmarks/bk-1')
      .set('Authorization', auth.authHeader)
      .send({});
    assert.equal(res.status, 400);
  });

  test('PUT requires JWT — x-user-id alone is rejected', async () => {
    const res = await request(buildApp())
      .put('/api/bookmarks/bk-1')
      .set('x-user-id', auth.user.id)
      .send({ folder: 'Bugs' });
    assert.equal(res.status, 401);
  });
});

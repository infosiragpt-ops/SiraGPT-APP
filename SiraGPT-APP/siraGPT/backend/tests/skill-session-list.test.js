'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const prisma = require('../src/config/database');
const skill = require('../src/skills/session_list/handler');

const realFindMany = prisma.chat?.findMany;

function installChatStub(stub) {
  if (!prisma.chat) prisma.chat = {};
  prisma.chat.findMany = stub;
}

test.afterEach(() => {
  if (prisma.chat) prisma.chat.findMany = realFindMany;
});

test('exports an execute function', () => {
  assert.equal(typeof skill.execute, 'function');
});

test('execute throws when ctx.userId is missing', async () => {
  await assert.rejects(() => skill.execute({}, {}), /ctx\.userId required/);
  await assert.rejects(() => skill.execute({}, null), /ctx\.userId required/);
  await assert.rejects(() => skill.execute({}, undefined), /ctx\.userId required/);
});

test('execute uses the default limit of 10 when args.limit is absent', async () => {
  let received = null;
  installChatStub(async (q) => { received = q; return []; });
  await skill.execute({}, { userId: 'u-1' });
  assert.equal(received.take, 10);
  assert.equal(received.where.userId, 'u-1');
  assert.equal(received.where.deletedAt, null);
  assert.equal(received.where.isArchived, false, 'includeArchived defaults off');
});

test('execute clamps limit to the [1, 50] range', async () => {
  let received = null;
  installChatStub(async (q) => { received = q; return []; });

  await skill.execute({ limit: 0 }, { userId: 'u-1' });
  // 0 falls back to DEFAULT_LIMIT=10 via `||` because Math.max(1, ...) only
  // floors NaN paths. With limit=0 the `(Number(0)||10)` resolves to 10.
  assert.equal(received.take, 10);

  await skill.execute({ limit: 999 }, { userId: 'u-1' });
  assert.equal(received.take, 50, 'limit must be capped at MAX_LIMIT');

  await skill.execute({ limit: 7 }, { userId: 'u-1' });
  assert.equal(received.take, 7);
});

test('execute passes includeArchived through to the where clause', async () => {
  let received = null;
  installChatStub(async (q) => { received = q; return []; });
  await skill.execute({ includeArchived: true }, { userId: 'u-1' });
  assert.ok(!('isArchived' in received.where), 'includeArchived:true must drop isArchived filter');
});

test('execute orders by updatedAt desc', async () => {
  let received = null;
  installChatStub(async (q) => { received = q; return []; });
  await skill.execute({}, { userId: 'u-1' });
  assert.deepEqual(received.orderBy, { updatedAt: 'desc' });
});

test('execute projects the row fields into the documented session shape', async () => {
  const now = new Date();
  installChatStub(async () => [
    {
      id: 'c1',
      title: 'first chat',
      model: 'gpt-4o',
      createdAt: now,
      updatedAt: now,
      isArchived: false,
      isShared: true,
      _count: { messages: 12 },
    },
  ]);
  const out = await skill.execute({}, { userId: 'u-1' });
  assert.equal(out.sessions.length, 1);
  const s = out.sessions[0];
  assert.equal(s.id, 'c1');
  assert.equal(s.title, 'first chat');
  assert.equal(s.model, 'gpt-4o');
  assert.equal(s.messages, 12);
  assert.equal(s.archived, false);
  assert.equal(s.shared, true);
});

test('execute defaults messages to 0 when _count is missing', async () => {
  installChatStub(async () => [
    { id: 'c1', title: 't', model: 'm', createdAt: new Date(), updatedAt: new Date(), isArchived: false, isShared: false },
  ]);
  const out = await skill.execute({}, { userId: 'u-1' });
  assert.equal(out.sessions[0].messages, 0);
});

test('execute returns sessions:[] when prisma yields no rows', async () => {
  installChatStub(async () => []);
  const out = await skill.execute({}, { userId: 'u-1' });
  assert.deepEqual(out.sessions, []);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const prisma = require('../src/config/database');
const skill = require('../src/skills/session_history/handler');

const realChatFindUnique = prisma.chat?.findUnique;
const realMessageFindMany = prisma.message?.findMany;

function stub({ chat, messages }) {
  if (!prisma.chat) prisma.chat = {};
  if (!prisma.message) prisma.message = {};
  prisma.chat.findUnique = async () => chat;
  prisma.message.findMany = async () => messages || [];
}

test.afterEach(() => {
  if (prisma.chat) prisma.chat.findUnique = realChatFindUnique;
  if (prisma.message) prisma.message.findMany = realMessageFindMany;
});

test('exports an execute function', () => {
  assert.equal(typeof skill.execute, 'function');
});

test('execute throws when ctx.userId is missing', async () => {
  await assert.rejects(() => skill.execute({}, {}), /ctx\.userId required/);
});

test('execute returns error when sessionId is missing', async () => {
  const out = await skill.execute({}, { userId: 'u-1' });
  assert.equal(out.error, 'missing sessionId');
});

test('execute returns "session not found" when prisma yields null', async () => {
  stub({ chat: null });
  const out = await skill.execute({ sessionId: 'cX' }, { userId: 'u-1' });
  assert.equal(out.error, 'session not found');
});

test('execute returns "not your session" when ownership mismatches', async () => {
  stub({ chat: { userId: 'u-other', title: 'x' } });
  const out = await skill.execute({ sessionId: 'c1' }, { userId: 'u-1' });
  assert.equal(out.error, 'not your session');
});

test('execute returns messages in chronological order (oldest first)', async () => {
  stub({
    chat: { userId: 'u-1', title: 'My chat' },
    // Prisma returns DESC; the skill should reverse to ASC for the caller.
    messages: [
      { id: 'm3', role: 'assistant', content: 'reply 2', timestamp: new Date('2026-05-21T03:00:00Z') },
      { id: 'm2', role: 'user', content: 'message 2', timestamp: new Date('2026-05-21T02:00:00Z') },
      { id: 'm1', role: 'user', content: 'message 1', timestamp: new Date('2026-05-21T01:00:00Z') },
    ],
  });
  const out = await skill.execute({ sessionId: 'c1' }, { userId: 'u-1' });
  assert.equal(out.sessionId, 'c1');
  assert.equal(out.title, 'My chat');
  assert.equal(out.messages.length, 3);
  // Chronological: m1 first, m3 last
  assert.equal(out.messages[0].id, 'm1');
  assert.equal(out.messages[2].id, 'm3');
});

test('execute caps message content at 1200 chars + flags truncated:true', async () => {
  const huge = 'x'.repeat(2000);
  stub({
    chat: { userId: 'u-1', title: 't' },
    messages: [
      { id: 'm1', role: 'user', content: huge, timestamp: new Date() },
      { id: 'm2', role: 'assistant', content: 'short', timestamp: new Date() },
    ],
  });
  const out = await skill.execute({ sessionId: 'c1' }, { userId: 'u-1' });
  const big = out.messages.find((m) => m.id === 'm1');
  const small = out.messages.find((m) => m.id === 'm2');
  assert.equal(big.content.length, 1200);
  assert.equal(big.truncated, true);
  assert.equal(small.truncated, false);
});

test('execute applies the [1, 50] limit clamp', async () => {
  let received = null;
  if (!prisma.chat) prisma.chat = {};
  prisma.chat.findUnique = async () => ({ userId: 'u-1', title: 't' });
  if (!prisma.message) prisma.message = {};
  prisma.message.findMany = async (q) => { received = q; return []; };

  await skill.execute({ sessionId: 'c1' }, { userId: 'u-1' });
  assert.equal(received.take, 20, 'default limit is 20');

  await skill.execute({ sessionId: 'c1', limit: 999 }, { userId: 'u-1' });
  assert.equal(received.take, 50, 'over-cap clamps to MAX_LIMIT=50');

  await skill.execute({ sessionId: 'c1', limit: 5 }, { userId: 'u-1' });
  assert.equal(received.take, 5);
});

test('execute tolerates null content without crashing', async () => {
  stub({
    chat: { userId: 'u-1', title: 't' },
    messages: [{ id: 'm1', role: 'user', content: null, timestamp: new Date() }],
  });
  const out = await skill.execute({ sessionId: 'c1' }, { userId: 'u-1' });
  assert.equal(out.messages[0].content, '');
  assert.equal(out.messages[0].truncated, false);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const tg = require('../src/services/telegram/telegram-control');

test('getTelegramConfig / isTelegramConfigured', () => {
  assert.equal(tg.isTelegramConfigured({}), false);
  const cfg = tg.getTelegramConfig({
    TELEGRAM_BOT_TOKEN: '123:abc',
    TELEGRAM_WEBHOOK_SECRET: 's3cr3t',
    TELEGRAM_ALLOWED_CHAT_IDS: '10, 20 ,30',
    TELEGRAM_AGENT_USER_ID: 'user-1',
    TELEGRAM_WEBHOOK_URL: 'https://x/api/telegram/webhook',
  });
  assert.equal(cfg.enabled, true);
  assert.deepEqual(cfg.allowedChatIds, ['10', '20', '30']);
  assert.equal(cfg.agentUserId, 'user-1');
  assert.equal(tg.isTelegramConfigured({ TELEGRAM_BOT_TOKEN: 't' }), true);
});

test('isChatAllowed — open when no allow-list, restricted otherwise', () => {
  assert.equal(tg.isChatAllowed({ allowedChatIds: [] }, 999), true);
  assert.equal(tg.isChatAllowed({ allowedChatIds: ['10'] }, 10), true);
  assert.equal(tg.isChatAllowed({ allowedChatIds: ['10'] }, 11), false);
});

test('verifyWebhookSecret — fails closed with no secret, constant-time match otherwise', () => {
  // No secret configured → reject (fail closed; endpoint would otherwise be open).
  assert.equal(tg.verifyWebhookSecret('anything', { webhookSecret: '' }), false);
  assert.equal(tg.verifyWebhookSecret('anything', {}), false);
  assert.equal(tg.verifyWebhookSecret('anything', null), false);
  // Matching secret → accept; mismatch (incl. length differences) → reject.

  assert.equal(tg.verifyWebhookSecret('s3cr3t', { webhookSecret: 's3cr3t' }), true);
  assert.equal(tg.verifyWebhookSecret('nope', { webhookSecret: 's3cr3t' }), false);
  assert.equal(tg.verifyWebhookSecret('', { webhookSecret: 's3cr3t' }), false);
  assert.equal(tg.verifyWebhookSecret('s3cr3t-longer', { webhookSecret: 's3cr3t' }), false);
});

test('parseCommand', () => {
  assert.deepEqual(tg.parseCommand('/help'), { command: 'help', args: '' });
  assert.deepEqual(tg.parseCommand('/code crea una landing'), { command: 'code', args: 'crea una landing' });
  assert.deepEqual(tg.parseCommand('/status abc-123'), { command: 'status', args: 'abc-123' });
  assert.deepEqual(tg.parseCommand('/code@MyBot hola mundo'), { command: 'code', args: 'hola mundo' });
  assert.deepEqual(tg.parseCommand('haz una web'), { command: 'message', args: 'haz una web' });
  assert.deepEqual(tg.parseCommand('   '), { command: null, args: '' });
});

test('formatRunUpdate', () => {
  assert.match(tg.formatRunUpdate(null), /No encontré/);
  const txt = tg.formatRunUpdate({ runId: 'r1', status: 'running', phase: 'execute', percent: 42 });
  assert.match(txt, /r1/);
  assert.match(txt, /running/);
  assert.match(txt, /execute/);
  assert.match(txt, /42%/);
  assert.match(tg.formatRunUpdate({ runId: 'r2', status: 'completed' }), /✅/);
  assert.match(tg.formatRunUpdate({ runId: 'r3', status: 'failed' }), /❌/);
});

test('handleTelegramUpdate — ignores non-message updates', async () => {
  const out = await tg.handleTelegramUpdate({}, {});
  assert.equal(out.handled, false);
});

test('handleTelegramUpdate — /help replies with usage', async () => {
  const sent = [];
  const out = await tg.handleTelegramUpdate(
    { message: { chat: { id: 5 }, text: '/help' } },
    { config: { allowedChatIds: [] }, send: (id, t) => { sent.push([id, t]); } },
  );
  assert.equal(out.action, 'help');
  assert.equal(sent[0][0], 5);
  assert.match(sent[0][1], /siraGPT/);
});

test('handleTelegramUpdate — denies unauthorized chat', async () => {
  const sent = [];
  const out = await tg.handleTelegramUpdate(
    { message: { chat: { id: 99 }, text: '/code build me an app' } },
    { config: { allowedChatIds: ['1'] }, send: (id, t) => sent.push(t) },
  );
  assert.equal(out.action, 'denied');
  assert.match(sent[0], /no autorizado/i);
});

test('handleTelegramUpdate — rejects too-short goals', async () => {
  const sent = [];
  const out = await tg.handleTelegramUpdate(
    { message: { chat: { id: 1 }, text: '/code hi' } },
    { config: { allowedChatIds: [] }, send: (id, t) => sent.push(t) },
  );
  assert.equal(out.action, 'too_short');
});

test('handleTelegramUpdate — enqueues a run for a valid goal', async () => {
  const sent = [];
  const calls = [];
  const out = await tg.handleTelegramUpdate(
    { message: { chat: { id: 7 }, text: '/code crea una landing con tailwind' } },
    {
      config: { allowedChatIds: [] },
      send: (id, t) => sent.push(t),
      resolveUser: async () => ({ id: 'u1' }),
      enqueueRun: async (p) => { calls.push(p); return { runId: 'run-42' }; },
    },
  );
  assert.equal(out.action, 'enqueued');
  assert.equal(out.runId, 'run-42');
  assert.equal(calls[0].user.id, 'u1');
  assert.equal(calls[0].goal, 'crea una landing con tailwind');
  assert.equal(calls[0].chatId, 7);
  assert.match(sent.join('\n'), /run-42/);
});

test('handleTelegramUpdate — /code without a configured user explains setup', async () => {
  const sent = [];
  const out = await tg.handleTelegramUpdate(
    { message: { chat: { id: 1 }, text: '/code make a todo app please' } },
    { config: { allowedChatIds: [] }, send: (id, t) => sent.push(t), resolveUser: async () => null },
  );
  assert.equal(out.action, 'no_user');
  assert.match(sent[0], /TELEGRAM_AGENT_USER_ID/);
});

test('handleTelegramUpdate — /status reports run state', async () => {
  const sent = [];
  const out = await tg.handleTelegramUpdate(
    { message: { chat: { id: 1 }, text: '/status run-9' } },
    {
      config: { allowedChatIds: [] },
      send: (id, t) => sent.push(t),
      readRun: async (rid) => ({ runId: rid, status: 'running', phase: 'plan', percent: 5 }),
    },
  );
  assert.equal(out.action, 'status');
  assert.match(sent[0], /run-9/);
  assert.match(sent[0], /plan/);
});

// ── Conversational relay (plain text = chat with the assistant) ──────────────

test('handleTelegramUpdate — plain text routes to chatReply, not enqueueRun', async () => {
  const sent = [];
  const runs = [];
  const chats = [];
  const out = await tg.handleTelegramUpdate(
    { message: { chat: { id: 1 }, text: 'hola, ¿qué es un ORM?' } },
    {
      config: { allowedChatIds: [] },
      send: (id, t) => sent.push(t),
      resolveUser: async () => ({ id: 'u1', name: 'Luis' }),
      enqueueRun: async (p) => { runs.push(p); return { runId: 'nope' }; },
      chatReply: async ({ user, text, chatId }) => { chats.push({ user, text, chatId }); return 'Un ORM mapea objetos a tablas.'; },
    },
  );
  assert.equal(out.action, 'chat');
  assert.equal(runs.length, 0, 'a greeting must NEVER launch a codex run');
  assert.equal(chats.length, 1);
  assert.equal(chats[0].text, 'hola, ¿qué es un ORM?');
  assert.equal(chats[0].chatId, 1);
  assert.equal(chats[0].user.name, 'Luis');
  assert.equal(sent[0], 'Un ORM mapea objetos a tablas.');
});

test('handleTelegramUpdate — chatReply failure yields a polite retry message', async () => {
  const sent = [];
  const out = await tg.handleTelegramUpdate(
    { message: { chat: { id: 1 }, text: 'hola' } },
    {
      config: { allowedChatIds: [] },
      send: (id, t) => sent.push(t),
      chatReply: async () => { throw new Error('all providers failed'); },
    },
  );
  assert.equal(out.action, 'chat_error');
  assert.match(sent[0], /No pude responder/);
});

test('handleTelegramUpdate — plain text without chatReply explains and suggests /code', async () => {
  const sent = [];
  const out = await tg.handleTelegramUpdate(
    { message: { chat: { id: 1 }, text: 'hola' } },
    { config: { allowedChatIds: [] }, send: (id, t) => sent.push(t) },
  );
  assert.equal(out.action, 'chat_unavailable');
  assert.match(sent[0], /\/code/);
});

test('createChatMemory — caps turns per chat and evicts the least-recent chat', () => {
  const mem = tg.createChatMemory({ maxTurns: 4, maxChats: 2 });
  for (let i = 1; i <= 6; i++) mem.remember('a', i % 2 ? 'user' : 'assistant', `m${i}`);
  const hist = mem.history('a');
  assert.equal(hist.length, 4, 'oldest turns dropped at the cap');
  assert.equal(hist[0].content, 'm3');
  assert.equal(hist[3].content, 'm6');

  mem.remember('b', 'user', 'hi');
  mem.history('a'); // refresh 'a' recency → 'b' is now least-recent
  mem.remember('c', 'user', 'yo'); // maxChats=2 → evicts 'b'
  assert.equal(mem.history('b').length, 0, 'least-recent chat evicted');
  assert.equal(mem.history('a').length, 4, 'recently-used chat survives');

  mem.reset('a');
  assert.equal(mem.history('a').length, 0);
  assert.equal(typeof mem.size(), 'number');
});

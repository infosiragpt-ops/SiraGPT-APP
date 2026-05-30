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

test('verifyWebhookSecret', () => {
  assert.equal(tg.verifyWebhookSecret('anything', { webhookSecret: '' }), true);
  assert.equal(tg.verifyWebhookSecret('s3cr3t', { webhookSecret: 's3cr3t' }), true);
  assert.equal(tg.verifyWebhookSecret('nope', { webhookSecret: 's3cr3t' }), false);
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

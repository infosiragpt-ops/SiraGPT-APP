'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const telegramRoutes = require('../src/routes/telegram');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/telegram', telegramRoutes);
  return app;
}

// Snapshot + restore the Telegram env so each test is isolated.
function withTelegramEnv(env, fn) {
  const keys = [
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_WEBHOOK_SECRET',
    'TELEGRAM_ALLOWED_CHAT_IDS',
    'TELEGRAM_AGENT_USER_ID',
    'TELEGRAM_WEBHOOK_URL',
  ];
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    });
}

test('POST /api/telegram/webhook — 503 when the bot is not configured', () =>
  withTelegramEnv({}, async () => {
    const res = await request(buildApp())
      .post('/api/telegram/webhook')
      .send({ message: { chat: { id: 1 }, text: '/code build me an app now' } });
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'telegram_not_configured');
  }));

test('POST /api/telegram/webhook — 403 webhook_secret_required when token set but no secret (fail closed)', () =>
  withTelegramEnv({ TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_AGENT_USER_ID: 'user-1' }, async () => {
    const res = await request(buildApp())
      .post('/api/telegram/webhook')
      .send({ message: { chat: { id: 1 }, text: '/code build me an app now' } });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'webhook_secret_required');
  }));

test('POST /api/telegram/webhook — 403 forbidden when secret set but header wrong/missing', () =>
  withTelegramEnv({ TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_WEBHOOK_SECRET: 's3cr3t' }, async () => {
    const app = buildApp();
    const missing = await request(app)
      .post('/api/telegram/webhook')
      .send({ message: { chat: { id: 1 }, text: '/help' } });
    assert.equal(missing.status, 403);
    assert.equal(missing.body.error, 'forbidden');

    const wrong = await request(app)
      .post('/api/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', 'nope')
      .send({ message: { chat: { id: 1 }, text: '/help' } });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.error, 'forbidden');
  }));

test('POST /api/telegram/webhook — 200 ack when secret matches', () =>
  withTelegramEnv({ TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_WEBHOOK_SECRET: 's3cr3t' }, async () => {
    // /help never reaches enqueueRun (no agent user needed); the handler runs
    // async after the 200 ack and sendTelegramMessage no-ops without a real API.
    const res = await request(buildApp())
      .post('/api/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', 's3cr3t')
      .send({ message: { chat: { id: 1 }, text: '/help' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  }));

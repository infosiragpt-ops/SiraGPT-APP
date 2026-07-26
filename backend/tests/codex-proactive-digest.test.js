'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  formatDigest,
  sendDailyDigest,
} = require('../src/services/codex/proactive-digest');

const PROJECTS = [{
  id: 'p1',
  name: 'SiraGPT',
  brief: {
    proactive: { enabled: true },
    ledger: [{
      runId: 'r1',
      department: 'Producto',
      outcome: 'passed',
      task: 'Gate de navegador',
      diffstat: { additions: 12, deletions: 3 },
      costUsd: 0.125,
      createdAt: '2026-07-26T10:00:00.000Z',
    }],
  },
}];

test('formatDigest summarizes only activity from the current UTC day', () => {
  const text = formatDigest(PROJECTS, new Date('2026-07-26T20:00:00.000Z'));
  assert.match(text, /SiraGPT Proactivo/);
  assert.match(text, /1 ciclos, 1 ok, 0 fallidos/);
  assert.match(text, /Cambios \+12\/-3/);
  assert.equal(formatDigest(PROJECTS, new Date('2026-07-27T01:00:00.000Z')), null);
});

test('sendDailyDigest delivers once and persists its idempotency key only after success', async () => {
  const settings = new Map();
  const sends = [];
  const prisma = {
    systemSettings: {
      findUnique: async ({ where }) => settings.get(where.key) || null,
      upsert: async ({ where, create, update }) => {
        const row = settings.has(where.key) ? update : create;
        settings.set(where.key, row);
        return row;
      },
    },
    codexProject: { findMany: async () => PROJECTS },
  };
  const args = {
    prisma,
    env: { TELEGRAM_BOT_TOKEN: 'token', TELEGRAM_DIGEST_CHAT_ID: '42' },
    now: () => new Date('2026-07-26T20:00:00.000Z'),
    sendMessage: async (token, chatId, text) => {
      sends.push({ token, chatId, text });
      return { ok: true };
    },
  };
  const first = await sendDailyDigest(args);
  const second = await sendDailyDigest(args);
  assert.equal(first.action, 'sent');
  assert.equal(second.action, 'already_sent');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].chatId, '42');
});

test('sendDailyDigest is inert when Telegram credentials are absent', async () => {
  const result = await sendDailyDigest({
    prisma: {},
    env: {},
    now: () => new Date('2026-07-26T20:00:00.000Z'),
  });
  assert.equal(result.action, 'skipped_not_configured');
});

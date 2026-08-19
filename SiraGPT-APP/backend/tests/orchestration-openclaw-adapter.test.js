'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createOpenClawAdapter, resolveOpenClawConfig } = require('../src/orchestration/multichannel/openclaw-adapter');

test('resolveOpenClawConfig defaults to disabled', () => {
  const config = resolveOpenClawConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.apiKeyConfigured, false);
  assert.deepEqual(config.allowedChannels, [
    'whatsapp', 'telegram', 'slack', 'discord', 'signal', 'imessage',
  ]);
});

test('resolveOpenClawConfig enables with env var', () => {
  const config = resolveOpenClawConfig({
    OPENCLAW_ENABLED: 'true',
    OPENCLAW_GATEWAY_URL: 'http://localhost:8787',
    OPENCLAW_API_KEY: 'test-key',
    OPENCLAW_CHANNELS: 'whatsapp,telegram',
  });
  assert.equal(config.enabled, true);
  assert.equal(config.apiKeyConfigured, true);
  assert.equal(config.endpoint, 'http://localhost:8787');
  assert.deepEqual(config.allowedChannels, ['whatsapp', 'telegram']);
});

test('resolveOpenClawConfig handles yes/on/1 values', () => {
  ['yes', 'on', '1', 'true'].forEach(val => {
    assert.equal(resolveOpenClawConfig({ OPENCLAW_ENABLED: val }).enabled, true);
  });
});

test('createOpenClawAdapter rejects messages when disabled', async () => {
  const adapter = createOpenClawAdapter({ env: {} });
  const result = await adapter.handleInboundMessage({ channel: 'whatsapp' });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'openclaw_disabled');
});

test('createOpenClawAdapter rejects messages without API key', async () => {
  const adapter = createOpenClawAdapter({
    env: { OPENCLAW_ENABLED: 'true' },
  });
  const result = await adapter.handleInboundMessage({ channel: 'whatsapp' });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'missing_OPENCLAW_API_KEY');
});

test('createOpenClawAdapter accepts messages when fully configured', async () => {
  const adapter = createOpenClawAdapter({
    env: {
      OPENCLAW_ENABLED: 'true',
      OPENCLAW_API_KEY: 'test-key',
      OPENCLAW_GATEWAY_URL: 'http://localhost:8787',
      SIRAGPT_INTERNAL_API_URL: 'http://localhost:5000',
    },
  });
  const result = await adapter.handleInboundMessage({
    userId: 'ext-user-1',
    channel: 'telegram',
    content: 'Hello from Telegram',
  });
  assert.equal(result.accepted, true);
  assert.equal(result.userId, 'ext-user-1');
  assert.equal(result.channel, 'telegram');
  assert.equal(result.route, 'siragpt-orchestration');
});

test('adapter falls back to senderId when userId is missing', async () => {
  const adapter = createOpenClawAdapter({
    env: {
      OPENCLAW_ENABLED: 'true',
      OPENCLAW_API_KEY: 'test-key',
    },
  });
  const result = await adapter.handleInboundMessage({
    senderId: 'tg-12345',
    channel: 'whatsapp',
  });
  assert.equal(result.accepted, true);
  assert.equal(result.userId, 'tg-12345');
});
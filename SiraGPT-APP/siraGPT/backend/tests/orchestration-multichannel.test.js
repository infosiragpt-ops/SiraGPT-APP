'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');

const { createOpenClawAdapter, resolveOpenClawConfig } = require('../src/orchestration/multichannel/openclaw-adapter');

test('resolveOpenClawConfig parses env vars correctly', () => {
  const config = resolveOpenClawConfig({
    OPENCLAW_ENABLED: 'true',
    OPENCLAW_GATEWAY_URL: 'https://openclaw.example.com',
    OPENCLAW_API_KEY: 'sk-test',
    OPENCLAW_CHANNELS: 'whatsapp, telegram, slack , discord,signal,imessage',
  });
  assert.equal(config.enabled, true);
  assert.equal(config.endpoint, 'https://openclaw.example.com');
  assert.equal(config.apiKeyConfigured, true);
  assert.deepEqual(config.allowedChannels, ['whatsapp', 'telegram', 'slack', 'discord', 'signal', 'imessage']);
});

test('resolveOpenClawConfig default disabled', () => {
  const config = resolveOpenClawConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.apiKeyConfigured, false);
  assert.deepEqual(config.allowedChannels, ['whatsapp', 'telegram', 'slack', 'discord', 'signal', 'imessage']);
});

test('createOpenClawAdapter rejects when disabled', async () => {
  const adapter = createOpenClawAdapter({ env: { OPENCLAW_ENABLED: 'false' } });
  const result = await adapter.handleInboundMessage({ userId: 'u1', channel: 'whatsapp' });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'openclaw_disabled');
});

test('createOpenClawAdapter rejects when missing API key', async () => {
  const adapter = createOpenClawAdapter({ env: { OPENCLAW_ENABLED: 'true' } });
  const result = await adapter.handleInboundMessage({ userId: 'u1' });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'missing_OPENCLAW_API_KEY');
});

test('createOpenClawAdapter accepts when configured', async () => {
  const adapter = createOpenClawAdapter({
    env: {
      OPENCLAW_ENABLED: 'true',
      OPENCLAW_API_KEY: 'sk-test',
      SIRAGPT_INTERNAL_API_URL: 'http://localhost:5000',
    },
  });
  const result = await adapter.handleInboundMessage({ userId: 'u1', channel: 'telegram' });
  assert.equal(result.accepted, true);
  assert.equal(result.route, 'siragpt-orchestration');
  assert.equal(result.userId, 'u1');
  assert.equal(result.channel, 'telegram');
});

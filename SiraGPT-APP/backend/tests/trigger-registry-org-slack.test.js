'use strict';

/**
 * Cycle 45 — org-scoped Slack integration fan-out tests.
 * Verifies that when the publish payload carries an orgId, the trigger
 * registry prefers the org's SlackIntegration row over the publishing
 * user's row, falling back to the user's row when no org row exists.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const triggers = require('../src/services/trigger-registry');

function buildSlackPrisma(slackRows) {
  return {
    webhookEndpoint: {
      findMany: async () => [],
      update: async () => ({}),
    },
    slackIntegration: {
      findFirst: async ({ where }) => {
        return slackRows.find((r) => {
          if (where.isEnabled !== undefined && r.isEnabled !== where.isEnabled) return false;
          if (where.organizationId && r.organizationId !== where.organizationId) return false;
          if (where.userId && r.userId !== where.userId) return false;
          if (where.organizationId && !r.organizationId) return false;
          if (!where.organizationId && where.userId && r.organizationId) return false;
          return true;
        }) || null;
      },
      update: async () => ({}),
    },
  };
}

describe('trigger-registry · org-scoped Slack (cycle 45)', () => {
  beforeEach(() => triggers.resetForTests());

  test('prefers org Slack when payload carries orgId', async () => {
    const rows = [
      { id: 's-org', organizationId: 'org-A', userId: 'admin', webhookUrl: 'https://hooks.slack.com/services/T/B/org', isEnabled: true },
      { id: 's-usr', organizationId: null, userId: 'u1', webhookUrl: 'https://hooks.slack.com/services/T/B/user', isEnabled: true },
    ];
    triggers.__setPrisma(buildSlackPrisma(rows));
    const sent = [];
    triggers.__setSlackSender({
      decryptToken: (value) => value,
      sendEventNotification: async (opts) => { sent.push(opts); return { ok: true, status: 200 }; },
    });

    const result = await triggers.publish('chat.created', { chatId: 'c1', orgId: 'org-A' }, 'u1');
    assert.equal(result.dispatched, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].webhookUrl, 'https://hooks.slack.com/services/T/B/org');
  });

  test('falls back to user Slack when payload has orgId but no org integration', async () => {
    const rows = [
      { id: 's-usr', organizationId: null, userId: 'u1', webhookUrl: 'https://hooks.slack.com/services/T/B/user', isEnabled: true },
    ];
    triggers.__setPrisma(buildSlackPrisma(rows));
    const sent = [];
    triggers.__setSlackSender({
      decryptToken: (value) => value,
      sendEventNotification: async (opts) => { sent.push(opts); return { ok: true, status: 200 }; },
    });

    const result = await triggers.publish('chat.created', { chatId: 'c1', orgId: 'org-A' }, 'u1');
    assert.equal(result.dispatched, 1);
    assert.equal(sent[0].webhookUrl, 'https://hooks.slack.com/services/T/B/user');
  });

  test('uses user Slack when payload has no orgId', async () => {
    const rows = [
      { id: 's-org', organizationId: 'org-A', userId: 'admin', webhookUrl: 'https://hooks.slack.com/services/T/B/org', isEnabled: true },
      { id: 's-usr', organizationId: null, userId: 'u1', webhookUrl: 'https://hooks.slack.com/services/T/B/user', isEnabled: true },
    ];
    triggers.__setPrisma(buildSlackPrisma(rows));
    const sent = [];
    triggers.__setSlackSender({
      decryptToken: (value) => value,
      sendEventNotification: async (opts) => { sent.push(opts); return { ok: true, status: 200 }; },
    });

    const result = await triggers.publish('chat.created', { chatId: 'c1' }, 'u1');
    assert.equal(result.dispatched, 1);
    assert.equal(sent[0].webhookUrl, 'https://hooks.slack.com/services/T/B/user');
  });

  test('skips Slack entirely when neither user nor org integration exists', async () => {
    triggers.__setPrisma(buildSlackPrisma([]));
    let called = 0;
    triggers.__setSlackSender({
      decryptToken: (value) => value,
      sendEventNotification: async () => { called++; return { ok: true, status: 200 }; },
    });
    const result = await triggers.publish('chat.created', { chatId: 'c1', orgId: 'org-A' }, 'u1');
    assert.equal(called, 0);
    assert.equal(result.dispatched, 0);
  });

  test('respects isEnabled=false for org integration (falls back to user)', async () => {
    const rows = [
      { id: 's-org', organizationId: 'org-A', userId: 'admin', webhookUrl: 'https://hooks.slack.com/services/T/B/org', isEnabled: false },
      { id: 's-usr', organizationId: null, userId: 'u1', webhookUrl: 'https://hooks.slack.com/services/T/B/user', isEnabled: true },
    ];
    triggers.__setPrisma(buildSlackPrisma(rows));
    const sent = [];
    triggers.__setSlackSender({
      decryptToken: (value) => value,
      sendEventNotification: async (opts) => { sent.push(opts); return { ok: true, status: 200 }; },
    });
    const result = await triggers.publish('chat.created', { chatId: 'c1', orgId: 'org-A' }, 'u1');
    assert.equal(result.dispatched, 1);
    assert.equal(sent[0].webhookUrl, 'https://hooks.slack.com/services/T/B/user');
  });
});

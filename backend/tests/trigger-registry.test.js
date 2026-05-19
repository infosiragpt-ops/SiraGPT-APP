'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const triggers = require('../src/services/trigger-registry');

function buildFakePrisma({ endpoints = [], slack = null } = {}) {
  return {
    webhookEndpoint: {
      findMany: async () => endpoints,
      update: async () => ({}),
    },
    slackIntegration: {
      findFirst: async () => slack,
      update: async () => ({}),
    },
  };
}

describe('trigger-registry · publish', () => {
  beforeEach(() => triggers.resetForTests());

  test('exposes the canonical TRIGGERS list', () => {
    assert.ok(triggers.TRIGGERS.includes('chat.created'));
    assert.ok(triggers.TRIGGERS.includes('payment.succeeded'));
    assert.ok(triggers.isKnownTrigger('chat.archived'));
    assert.equal(triggers.isKnownTrigger('not.a.thing'), false);
  });

  test('fans out to matching webhook endpoints', async () => {
    const calls = [];
    triggers.__setPrisma(buildFakePrisma({
      endpoints: [
        { id: 'e1', url: 'https://a.example/x', events: ['chat.created'], secret: 's1', isActive: true },
        { id: 'e2', url: 'https://b.example/y', events: ['payment.succeeded'], secret: 's2', isActive: true },
        { id: 'e3', url: 'https://c.example/z', events: ['*'], secret: 's3', isActive: true },
      ],
    }));
    triggers.__setDispatcher({
      dispatch: async (opts) => {
        calls.push(opts);
        return { id: 'd1', status: 'delivered', attempts: 1 };
      },
    });
    triggers.__setSlackSender({ sendEventNotification: async () => ({ ok: true, status: 200 }) });

    const result = await triggers.publish('chat.created', { chatId: 'c1' }, 'u1');
    assert.equal(result.deduped, false);
    assert.equal(calls.length, 2); // e1 + e3 (wildcard); e2 skipped
    assert.equal(calls[0].event, 'chat.created');
    assert.equal(result.dispatched, 2);
  });

  test('skips duplicate publishes via idempotency hash', async () => {
    let dispatched = 0;
    triggers.__setPrisma(buildFakePrisma({
      endpoints: [{ id: 'e1', url: 'https://a/x', events: ['chat.created'], secret: 's', isActive: true }],
    }));
    triggers.__setDispatcher({ dispatch: async () => { dispatched++; return { status: 'delivered' }; } });
    triggers.__setSlackSender(null);

    const r1 = await triggers.publish('chat.created', { chatId: 'c1' }, 'u1');
    const r2 = await triggers.publish('chat.created', { chatId: 'c1' }, 'u1');
    assert.equal(r1.deduped, false);
    assert.equal(r2.deduped, true);
    assert.equal(dispatched, 1);
  });

  test('different payloads produce different hashes', async () => {
    let dispatched = 0;
    triggers.__setPrisma(buildFakePrisma({
      endpoints: [{ id: 'e1', url: 'https://a/x', events: ['chat.created'], secret: 's', isActive: true }],
    }));
    triggers.__setDispatcher({ dispatch: async () => { dispatched++; return { status: 'delivered' }; } });
    triggers.__setSlackSender(null);

    await triggers.publish('chat.created', { chatId: 'c1' }, 'u1');
    await triggers.publish('chat.created', { chatId: 'c2' }, 'u1');
    assert.equal(dispatched, 2);
  });

  test('fires Slack when configured + enabled', async () => {
    let slackCalls = 0;
    triggers.__setPrisma(buildFakePrisma({
      endpoints: [],
      slack: { id: 's1', userId: 'u1', webhookUrl: 'https://hooks.slack.com/x', isEnabled: true },
    }));
    triggers.__setDispatcher({ dispatch: async () => ({ status: 'delivered' }) });
    triggers.__setSlackSender({
      sendEventNotification: async () => { slackCalls++; return { ok: true, status: 200 }; },
    });
    const r = await triggers.publish('chat.created', { chatId: 'c1' }, 'u1');
    assert.equal(slackCalls, 1);
    assert.equal(r.dispatched, 1);
  });
});

describe('trigger-registry · publishDebounced', () => {
  beforeEach(() => triggers.resetForTests());

  test('collapses bursts into a single publish', async () => {
    let count = 0;
    triggers.__setPrisma(buildFakePrisma({
      endpoints: [{ id: 'e1', url: 'https://a/x', events: ['chat.message_sent'], secret: 's', isActive: true }],
    }));
    triggers.__setDispatcher({ dispatch: async () => { count++; return { status: 'delivered' }; } });
    triggers.__setSlackSender(null);

    const opts = { delayMs: 20, dedupeKey: 'chat:c1' };
    await Promise.all([
      triggers.publishDebounced('chat.message_sent', { msg: 'a' }, 'u1', opts),
      new Promise((r) => setTimeout(() => r(triggers.publishDebounced('chat.message_sent', { msg: 'b' }, 'u1', opts)), 5)),
    ]);
    // Wait a bit past the debounce window for the trailing dispatch.
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(count, 1);
  });
});

describe('trigger-registry · _eventHash', () => {
  test('is deterministic for the same input', () => {
    const a = triggers._eventHash('chat.created', 'u1', { id: 1 });
    const b = triggers._eventHash('chat.created', 'u1', { id: 1 });
    assert.equal(a, b);
    const c = triggers._eventHash('chat.created', 'u1', { id: 2 });
    assert.notEqual(a, c);
  });
});

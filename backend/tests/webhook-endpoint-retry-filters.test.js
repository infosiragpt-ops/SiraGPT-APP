'use strict';

// Ratchet 44 — per-endpoint retry override + delivery filters.
// Validates that trigger-registry.publish() honours WebhookEndpoint.maxRetries
// and WebhookEndpoint.filters (events include-list + excludeUsers).

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const triggers = require('../src/services/trigger-registry');

function fakePrisma(endpoints) {
  return {
    webhookEndpoint: {
      findMany: async () => endpoints,
      update: async () => ({}),
    },
    slackIntegration: {
      findFirst: async () => null,
      update: async () => ({}),
    },
  };
}

describe('trigger-registry · endpointFiltersAllow (Task 2)', () => {
  test('allows when filters is null/empty/object-missing-fields', () => {
    assert.equal(triggers.endpointFiltersAllow({ filters: null }, 'chat.created', 'u1'), true);
    assert.equal(triggers.endpointFiltersAllow({ filters: {} }, 'chat.created', 'u1'), true);
    // Non-object filters payloads must NOT silently block delivery.
    assert.equal(triggers.endpointFiltersAllow({ filters: 'oops' }, 'chat.created', 'u1'), true);
    assert.equal(triggers.endpointFiltersAllow({ filters: [1, 2] }, 'chat.created', 'u1'), true);
  });

  test('events include-list gates by exact + glob match', () => {
    const ep = { filters: { events: ['chat.created', 'payment.*'] } };
    assert.equal(triggers.endpointFiltersAllow(ep, 'chat.created', 'u1'), true);
    assert.equal(triggers.endpointFiltersAllow(ep, 'payment.succeeded', 'u1'), true);
    assert.equal(triggers.endpointFiltersAllow(ep, 'chat.archived', 'u1'), false);
  });

  test('malformed events entries do not create an accidental deny-all filter', () => {
    assert.equal(
      triggers.endpointFiltersAllow({ filters: { events: [null, 42, ''] } }, 'chat.created', 'u1'),
      true,
    );
    assert.equal(
      triggers.endpointFiltersAllow({ filters: { events: [null, 'payment.*'] } }, 'payment.succeeded', 'u1'),
      true,
    );
    assert.equal(
      triggers.endpointFiltersAllow({ filters: { events: [null, 'payment.*'] } }, 'chat.created', 'u1'),
      false,
    );
  });

  test('excludeUsers drops matching userIds', () => {
    const ep = { filters: { excludeUsers: ['banned-1', 'banned-2'] } };
    assert.equal(triggers.endpointFiltersAllow(ep, 'chat.created', 'banned-1'), false);
    assert.equal(triggers.endpointFiltersAllow(ep, 'chat.created', 'ok'), true);
    // Missing userId should pass even if the list is non-empty.
    assert.equal(triggers.endpointFiltersAllow(ep, 'chat.created', null), true);
  });

  test('AND-composes events include-list with excludeUsers', () => {
    const ep = { filters: { events: ['chat.*'], excludeUsers: ['banned'] } };
    assert.equal(triggers.endpointFiltersAllow(ep, 'chat.created', 'ok'), true);
    assert.equal(triggers.endpointFiltersAllow(ep, 'payment.succeeded', 'ok'), false);
    assert.equal(triggers.endpointFiltersAllow(ep, 'chat.created', 'banned'), false);
  });
});

describe('trigger-registry · publish honours filters + maxRetries (Task 1+2)', () => {
  beforeEach(() => triggers.resetForTests());

  test('skips endpoint when filters.events excludes the event', async () => {
    const calls = [];
    triggers.__setPrisma(fakePrisma([
      {
        id: 'e1', url: 'https://a/x', events: ['*'], secret: 's', isActive: true,
        filters: { events: ['payment.*'] },
      },
    ]));
    triggers.__setDispatcher({
      dispatch: async (o) => { calls.push(o); return { status: 'delivered' }; },
    });
    triggers.__setSlackSender(null);

    const r = await triggers.publish('chat.created', { chatId: 'c1' }, 'u1');
    assert.equal(calls.length, 0);
    assert.equal(r.dispatched, 0);
  });

  test('skips endpoint when filters.excludeUsers matches publisher', async () => {
    const calls = [];
    triggers.__setPrisma(fakePrisma([
      {
        id: 'e1', url: 'https://a/x', events: ['chat.created'], secret: 's', isActive: true,
        filters: { excludeUsers: ['u-bad'] },
      },
    ]));
    triggers.__setDispatcher({
      dispatch: async (o) => { calls.push(o); return { status: 'delivered' }; },
    });
    triggers.__setSlackSender(null);

    const r = await triggers.publish('chat.created', { chatId: 'c1' }, 'u-bad');
    assert.equal(calls.length, 0);
    assert.equal(r.dispatched, 0);
  });

  test('forwards per-endpoint maxRetries override to dispatcher', async () => {
    const observed = [];
    triggers.__setPrisma(fakePrisma([
      {
        id: 'e1', url: 'https://a/x', events: ['chat.created'], secret: 's', isActive: true,
        maxRetries: 7,
      },
    ]));
    triggers.__setDispatcher({
      dispatch: async (o) => { observed.push(o.maxRetries); return { status: 'delivered' }; },
    });
    triggers.__setSlackSender(null);

    await triggers.publish('chat.created', { chatId: 'c1' }, 'u1');
    assert.equal(observed.length, 1);
    assert.equal(observed[0], 7);
  });

  test('omits maxRetries when endpoint leaves it null (dispatcher default applies)', async () => {
    const observed = [];
    triggers.__setPrisma(fakePrisma([
      {
        id: 'e1', url: 'https://a/x', events: ['chat.created'], secret: 's', isActive: true,
        maxRetries: null,
      },
    ]));
    triggers.__setDispatcher({
      dispatch: async (o) => { observed.push(o); return { status: 'delivered' }; },
    });
    triggers.__setSlackSender(null);

    await triggers.publish('chat.created', { chatId: 'c1' }, 'u1');
    assert.equal(observed.length, 1);
    // The override key must not be present so dispatcher.dispatch can
    // fall through to its declared default (3 retries).
    assert.equal(Object.prototype.hasOwnProperty.call(observed[0], 'maxRetries'), false);
  });

  test('rejects negative maxRetries (treats as missing)', async () => {
    const observed = [];
    triggers.__setPrisma(fakePrisma([
      {
        id: 'e1', url: 'https://a/x', events: ['chat.created'], secret: 's', isActive: true,
        maxRetries: -1,
      },
    ]));
    triggers.__setDispatcher({
      dispatch: async (o) => { observed.push(o); return { status: 'delivered' }; },
    });
    triggers.__setSlackSender(null);

    await triggers.publish('chat.created', { chatId: 'c1' }, 'u1');
    assert.equal(Object.prototype.hasOwnProperty.call(observed[0], 'maxRetries'), false);
  });

  test('maxRetries:0 is honoured (no retries)', async () => {
    const observed = [];
    triggers.__setPrisma(fakePrisma([
      {
        id: 'e1', url: 'https://a/x', events: ['chat.created'], secret: 's', isActive: true,
        maxRetries: 0,
      },
    ]));
    triggers.__setDispatcher({
      dispatch: async (o) => { observed.push(o.maxRetries); return { status: 'delivered' }; },
    });
    triggers.__setSlackSender(null);

    await triggers.publish('chat.created', { chatId: 'c1' }, 'u1');
    assert.equal(observed[0], 0);
  });
});

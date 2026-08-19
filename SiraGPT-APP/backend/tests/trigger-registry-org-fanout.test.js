'use strict';

/**
 * Cycle 45 — org-scoped webhook fan-out tests.
 * Verifies that when the publishing payload carries an `orgId`, the
 * trigger registry also fans out to WebhookEndpoint rows scoped to that
 * organization (in addition to the per-user fan-out). Endpoints
 * matching both scopes must be de-duplicated by id.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const triggers = require('../src/services/trigger-registry');

function buildOrgAwarePrisma(rows) {
  return {
    webhookEndpoint: {
      findMany: async ({ where }) => {
        return rows.filter((r) => {
          if (where.isActive !== undefined && r.isActive !== where.isActive) return false;
          if (where.userId && r.userId !== where.userId) return false;
          if (where.organizationId && r.organizationId !== where.organizationId) return false;
          return true;
        });
      },
      update: async () => ({}),
    },
    slackIntegration: {
      findFirst: async () => null,
      update: async () => ({}),
    },
  };
}

describe('trigger-registry · org-scoped fan-out (cycle 45)', () => {
  beforeEach(() => triggers.resetForTests());

  test('fans out to org endpoints when payload carries orgId', async () => {
    const rows = [
      // org-only endpoint (no userId match with publisher)
      { id: 'org1', userId: 'admin', organizationId: 'org-A', url: 'https://o/x', events: ['chat.created'], secret: 's', isActive: true },
      // user endpoint
      { id: 'usr1', userId: 'u1', organizationId: null, url: 'https://u/y', events: ['chat.created'], secret: 's', isActive: true },
      // different-org endpoint — should NOT receive
      { id: 'org2', userId: 'admin', organizationId: 'org-B', url: 'https://o2/z', events: ['chat.created'], secret: 's', isActive: true },
    ];
    triggers.__setPrisma(buildOrgAwarePrisma(rows));
    const dispatched = [];
    triggers.__setDispatcher({
      dispatch: async (opts) => { dispatched.push(opts); return { status: 'delivered' }; },
    });
    triggers.__setSlackSender(null);

    const result = await triggers.publish(
      'chat.created',
      { chatId: 'c1', orgId: 'org-A' },
      'u1',
    );
    assert.equal(result.dispatched, 2, 'should dispatch to user + org endpoints');
    const ids = dispatched.map((d) => d.url).sort();
    assert.deepEqual(ids, ['https://o/x', 'https://u/y']);
  });

  test('dedupes endpoints that match both userId and orgId', async () => {
    const rows = [
      { id: 'both', userId: 'u1', organizationId: 'org-A', url: 'https://both/x', events: ['chat.created'], secret: 's', isActive: true },
    ];
    triggers.__setPrisma(buildOrgAwarePrisma(rows));
    let count = 0;
    triggers.__setDispatcher({
      dispatch: async () => { count++; return { status: 'delivered' }; },
    });
    triggers.__setSlackSender(null);

    const result = await triggers.publish(
      'chat.created',
      { chatId: 'c1', orgId: 'org-A' },
      'u1',
    );
    assert.equal(count, 1, 'endpoint scoped to both user+org must fire once');
    assert.equal(result.dispatched, 1);
  });

  test('skips org fan-out when payload has no orgId', async () => {
    const rows = [
      { id: 'org1', userId: 'admin', organizationId: 'org-A', url: 'https://o/x', events: ['chat.created'], secret: 's', isActive: true },
    ];
    triggers.__setPrisma(buildOrgAwarePrisma(rows));
    let count = 0;
    triggers.__setDispatcher({
      dispatch: async () => { count++; return { status: 'delivered' }; },
    });
    triggers.__setSlackSender(null);

    const result = await triggers.publish('chat.created', { chatId: 'c1' }, 'u1');
    assert.equal(count, 0);
    assert.equal(result.dispatched, 0);
  });

  test('dispatch payload includes orgId field', async () => {
    const rows = [
      { id: 'org1', userId: 'admin', organizationId: 'org-A', url: 'https://o/x', events: ['*'], secret: 's', isActive: true },
    ];
    triggers.__setPrisma(buildOrgAwarePrisma(rows));
    let captured = null;
    triggers.__setDispatcher({
      dispatch: async (opts) => { captured = opts; return { status: 'delivered' }; },
    });
    triggers.__setSlackSender(null);

    await triggers.publish('chat.created', { chatId: 'c1', orgId: 'org-A' }, 'u-other');
    assert.ok(captured);
    assert.equal(captured.payload.orgId, 'org-A');
  });
});

'use strict';

/**
 * Ratchet 45 — email-preferences helper tests.
 *
 * Pure-JS unit tests against the new `services/email-preferences.js`
 * helper. No DB, no HTTP — exercises every branch of the public API
 * (extractNotifications, isOptedOut, mergeNotificationsPatch,
 * loadNotifications, shouldSendEmail).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const prefs = require('../src/services/email-preferences');

describe('email-preferences.extractNotifications', () => {
  test('returns {} for null / undefined / primitive settings', () => {
    assert.deepEqual(prefs.extractNotifications(null), {});
    assert.deepEqual(prefs.extractNotifications(undefined), {});
    assert.deepEqual(prefs.extractNotifications(42), {});
    assert.deepEqual(prefs.extractNotifications('x'), {});
  });

  test('returns {} when notifications key missing or non-object', () => {
    assert.deepEqual(prefs.extractNotifications({}), {});
    assert.deepEqual(prefs.extractNotifications({ notifications: null }), {});
    assert.deepEqual(prefs.extractNotifications({ notifications: 'x' }), {});
    assert.deepEqual(prefs.extractNotifications({ notifications: [] }), {});
  });

  test('returns the notifications sub-object when present', () => {
    const n = { invitations: false, billing: true };
    assert.deepEqual(prefs.extractNotifications({ notifications: n }), n);
  });
});

describe('email-preferences.isOptedOut', () => {
  test('false (opt-in) by default for all categories', () => {
    for (const cat of prefs.VALID_CATEGORIES) {
      assert.equal(prefs.isOptedOut({}, cat), false, `default opt-in for ${cat}`);
    }
  });

  test('true only when the category is strictly === false', () => {
    assert.equal(prefs.isOptedOut({ invitations: false }, 'invitations'), true);
    // Anything else is treated as opt-in (preserves the existing
    // behaviour for partially-populated settings blobs).
    assert.equal(prefs.isOptedOut({ invitations: 0 }, 'invitations'), false);
    assert.equal(prefs.isOptedOut({ invitations: null }, 'invitations'), false);
    assert.equal(prefs.isOptedOut({ invitations: undefined }, 'invitations'), false);
    assert.equal(prefs.isOptedOut({ invitations: 'false' }, 'invitations'), false);
    assert.equal(prefs.isOptedOut({ invitations: true }, 'invitations'), false);
  });

  test('unknown category never opts out (defensive default)', () => {
    assert.equal(prefs.isOptedOut({ bogus: false }, 'bogus'), false);
  });
});

describe('email-preferences.mergeNotificationsPatch', () => {
  test('writes known categories, ignores unknown keys', () => {
    const out = prefs.mergeNotificationsPatch(
      { invitations: false },
      { billing: false, role_changes: true, bogus: 'x' },
    );
    assert.deepEqual(out, {
      invitations: false,
      billing: false,
      role_changes: true,
    });
  });

  test('coerces non-bool values by dropping them', () => {
    const out = prefs.mergeNotificationsPatch({}, {
      invitations: 'no',
      billing: 1,
      role_changes: false,
    });
    assert.deepEqual(out, { role_changes: false });
  });

  test('null value clears the category (back to default opt-in)', () => {
    const out = prefs.mergeNotificationsPatch(
      { invitations: false, billing: false },
      { invitations: null },
    );
    assert.deepEqual(out, { billing: false });
  });

  test('null / non-object patches are no-ops', () => {
    assert.deepEqual(prefs.mergeNotificationsPatch({ billing: false }, null),
      { billing: false });
    assert.deepEqual(prefs.mergeNotificationsPatch({ billing: false }, 'x'),
      { billing: false });
  });

  test('null current treated as empty object', () => {
    assert.deepEqual(
      prefs.mergeNotificationsPatch(null, { billing: false }),
      { billing: false },
    );
  });
});

describe('email-preferences.loadNotifications + shouldSendEmail', () => {
  function makePrisma(user) {
    return {
      user: {
        findUnique: async () => user,
      },
    };
  }

  test('loadNotifications returns {} when prisma is missing', async () => {
    assert.deepEqual(await prefs.loadNotifications(null, 'u1'), {});
  });

  test('loadNotifications returns {} when userId is missing', async () => {
    const prisma = makePrisma({ settings: { notifications: { billing: false } } });
    assert.deepEqual(await prefs.loadNotifications(prisma, null), {});
  });

  test('loadNotifications returns notifications blob from settings', async () => {
    const prisma = makePrisma({ settings: { notifications: { billing: false } } });
    assert.deepEqual(await prefs.loadNotifications(prisma, 'u1'), { billing: false });
  });

  test('loadNotifications swallows DB errors → {}', async () => {
    const prisma = {
      user: { findUnique: async () => { throw new Error('boom'); } },
    };
    assert.deepEqual(await prefs.loadNotifications(prisma, 'u1'), {});
  });

  test('shouldSendEmail returns true by default', async () => {
    const prisma = makePrisma({ settings: null });
    assert.equal(await prefs.shouldSendEmail(prisma, 'u1', 'invitations'), true);
  });

  test('shouldSendEmail returns false when opted out', async () => {
    const prisma = makePrisma({ settings: { notifications: { invitations: false } } });
    assert.equal(await prefs.shouldSendEmail(prisma, 'u1', 'invitations'), false);
  });

  test('shouldSendEmail is unaffected by opt-out on a different category', async () => {
    const prisma = makePrisma({ settings: { notifications: { billing: false } } });
    assert.equal(await prefs.shouldSendEmail(prisma, 'u1', 'invitations'), true);
  });
});

describe('email-preferences.VALID_CATEGORIES', () => {
  test('exports the five known categories in stable order', () => {
    assert.deepEqual(prefs.VALID_CATEGORIES, [
      'invitations',
      'role_changes',
      'removal',
      'ownership',
      'billing',
    ]);
  });

  test('the export is frozen', () => {
    assert.equal(Object.isFrozen(prefs.VALID_CATEGORIES), true);
  });
});

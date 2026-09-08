'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const pins = require('../src/services/apps/pins');

function fakePrisma(rows) {
  return {
    appConnection: {
      findUnique: async ({ where }) =>
        rows.find((row) => row.appId === where.userId_appId.appId) || null,
    },
  };
}

const connectedRow = (appId) => ({
  appId,
  status: 'connected',
});

test('normalizePinIds strips dupes, empties and casing', () => {
  assert.deepEqual(pins.normalizePinIds(['GitHub', 'github', '', '  x  ', null]), ['github', 'x']);
  assert.deepEqual(pins.normalizePinIds(undefined), []);
  assert.deepEqual(pins.normalizePinIds('github'), []);
});

test('publicPins reads the JSONB column with caps, dedupe and revision', () => {
  assert.deepEqual(pins.publicPins({ pinnedAppIds: ['github', 'x', 'github'] }), {
    pinnedAppIds: ['github', 'x'],
    revision: 0,
  });
  assert.deepEqual(pins.publicPins({ pinnedAppIds: ['a', 'b', 'c', 'd', 'e'] }), {
    pinnedAppIds: ['a', 'b', 'c', 'd'],
    revision: 0,
  });
  assert.deepEqual(pins.publicPins({ pinnedAppIds: ['a'], pinRevision: 7 }), {
    pinnedAppIds: ['a'],
    revision: 7,
  });
  assert.deepEqual(pins.publicPins({ pinnedAppIds: null }), { pinnedAppIds: [], revision: 0 });
  assert.deepEqual(pins.publicPins({}), { pinnedAppIds: [], revision: 0 });
});

test('validatePins accepts connected available apps', async () => {
  const prisma = fakePrisma([connectedRow('github'), connectedRow('x')]);
  const result = await pins.validatePins(prisma, 'u1', ['github', 'x']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.pins, ['github', 'x']);
});

test('validatePins rejects apps without an active connection', async () => {
  const prisma = fakePrisma([connectedRow('github')]);
  const result = await pins.validatePins(prisma, 'u1', ['github', 'linkedin']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ appId: 'linkedin', code: pins.PIN_ERRORS.APP_NOT_CONNECTED }]);
  assert.deepEqual(result.pins, ['github']);
});

test('validatePins rejects unknown apps', async () => {
  const prisma = fakePrisma([]);
  const result = await pins.validatePins(prisma, 'u1', ['made-up-app']);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, pins.PIN_ERRORS.APP_NOT_FOUND);
});

test('validatePins rejects over the limit with PIN_LIMIT', async () => {
  const prisma = fakePrisma(['a', 'b', 'c', 'd', 'e'].map(connectedRow));
  await assert.rejects(
    () => pins.validatePins(prisma, 'u1', ['a', 'b', 'c', 'd', 'e']),
    (err) => err.code === pins.PIN_ERRORS.PIN_LIMIT,
  );
});

test('validatePins drops duplicate ids before validation', async () => {
  const prisma = fakePrisma([connectedRow('github')]);
  const result = await pins.validatePins(prisma, 'u1', ['github', 'github', 'github']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.pins, ['github']);
});

test('connectionIsActive only trusts status connected', () => {
  assert.equal(pins.connectionIsActive({ status: 'connected' }), true);
  assert.equal(pins.connectionIsActive({ status: 'expired' }), false);
  assert.equal(pins.connectionIsActive({ status: 'revoked' }), false);
  assert.equal(pins.connectionIsActive(null), false);
});

test('PINS_ENABLED defaults on and flips off via env kill switch', async () => {
  const { PINS_ENABLED } = require('../src/services/apps/pins');
  assert.equal(PINS_ENABLED, true);
  const previous = process.env.SIRAGPT_APPS_PERSISTENT_PINS;
  process.env.SIRAGPT_APPS_PERSISTENT_PINS = '0';
  delete require.cache[require.resolve('../src/services/apps/pins')];
  const disabled = require('../src/services/apps/pins');
  assert.equal(disabled.PINS_ENABLED, false);
  assert.deepEqual(disabled.publicPins({ pinnedAppIds: ['github'] }), { pinnedAppIds: [], revision: 0 });
  await assert.rejects(
    () => disabled.validatePins(fakePrisma([connectedRow('github')]), 'u1', ['github']),
    (err) => err.code === 'PINS_DISABLED',
  );
  if (previous === undefined) delete process.env.SIRAGPT_APPS_PERSISTENT_PINS;
  else process.env.SIRAGPT_APPS_PERSISTENT_PINS = previous;
  delete require.cache[require.resolve('../src/services/apps/pins')];
});

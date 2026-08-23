'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const runtimeOverrides = require('../src/services/flags/runtime-overrides');

function freshModule() {
  // Reset module state between tests without spawning processes.
  runtimeOverrides.invalidateRuntimeCache();
  runtimeOverrides.setTtlMs(runtimeOverrides.DEFAULT_TTL_MS);
  runtimeOverrides.setPrisma(null);
}

function prismaWith(rowValue) {
  return {
    systemSettings: {
      findUnique: async () => (rowValue === undefined ? null : { key: 'runtime_flag_overrides', value: rowValue }),
      upsert: async ({ update }) => update,
    },
  };
}

test('parseStoredValue accepts valid JSON and normalizes flags', () => {
  const parsed = runtimeOverrides._internal.parseStoredValue(
    JSON.stringify({ flags: { A: true, B: 'yes', C: false }, updatedAt: 't', updatedBy: 'u' })
  );
  assert.deepEqual(parsed.flags, { A: true, C: false });
  assert.equal(parsed.updatedAt, 't');
});

test('parseStoredValue rejects junk', () => {
  assert.equal(runtimeOverrides._internal.parseStoredValue('not json'), null);
  assert.equal(runtimeOverrides._internal.parseStoredValue(null), null);
  // Malformed flag maps normalize to "no overrides" rather than failing.
  assert.deepEqual(
    runtimeOverrides._internal.parseStoredValue(JSON.stringify({ flags: [] })).flags,
    {}
  );
});

test('wrapIsEnabled falls through to env when no override loaded', async () => {
  freshModule();
  const base = (env) => env.MY_FLAG === '1';
  const wrapped = runtimeOverrides.wrapIsEnabled('MY_FLAG', base);
  assert.equal(wrapped({ MY_FLAG: '1' }), true);
  assert.equal(wrapped({}), false);
});

test('override beats env once cache is loaded', async () => {
  freshModule();
  const prisma = prismaWith(JSON.stringify({ flags: { MY_FLAG: false } }));
  await runtimeOverrides.readOverrides(prisma, { force: true });
  const wrapped = runtimeOverrides.wrapIsEnabled('MY_FLAG', () => true);
  assert.equal(wrapped({}), false);
});

test('stale-while-error: DB failure serves last-known overrides', async () => {
  freshModule();
  const good = prismaWith(JSON.stringify({ flags: { KILL_ME: true } }));
  await runtimeOverrides.readOverrides(good, { force: true });

  const broken = {
    systemSettings: {
      findUnique: async () => { throw new Error('db down'); },
      upsert: async () => ({}),
    },
  };
  const state = await runtimeOverrides.readOverrides(broken, { force: true });
  assert.deepEqual(state.flags, { KILL_ME: true });
});

test('writeOverrides merges, persists, and reloads cache', async () => {
  freshModule();
  let stored = null;
  const prisma = {
    systemSettings: {
      findUnique: async () => (stored ? { key: 'k', value: stored } : null),
      upsert: async ({ create, update }) => { stored = update ? update.value : create.value; return update; },
    },
  };
  const first = await runtimeOverrides.writeOverrides(prisma, {
    flags: { F1: true },
    actorId: 'admin-1',
  });
  assert.deepEqual(first.flags, { F1: true });

  const second = await runtimeOverrides.writeOverrides(prisma, {
    flags: { F2: false },
    actorId: 'admin-2',
  });
  assert.deepEqual(second.flags, { F1: true, F2: false });

  const removed = await runtimeOverrides.writeOverrides(prisma, {
    remove: ['F1'],
    actorId: 'admin-2',
  });
  assert.deepEqual(removed.flags, { F2: false });

  // Cache was invalidated+reloaded by write: sync getter sees the new state.
  const wrapped = runtimeOverrides.wrapIsEnabled('F2', () => true);
  assert.equal(wrapped({}), false);
});

test('getOverrideSync returns undefined with cold cache', () => {
  freshModule();
  assert.equal(runtimeOverrides.getOverrideSync('ANY'), undefined);
});

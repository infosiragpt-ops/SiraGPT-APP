'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function loadOptional(specifier) {
  try {
    return require(specifier);
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
}

const versionModule = loadOptional('../src/services/rbac-permission-version');

function feature(name) {
  assert.ok(versionModule, 'RBAC permission version service has not been implemented');
  assert.equal(typeof versionModule[name], 'function', `${name} has not been implemented`);
  return versionModule[name];
}

test('permission-version bump uses one atomic SystemSettings upsert statement', async () => {
  const bump = feature('bumpRbacPermissionVersion');
  const calls = [];
  const tx = {
    async $queryRawUnsafe(sql, ...params) {
      calls.push({ sql, params });
      return [{ version: '42' }];
    },
  };

  const version = await bump(tx);

  assert.equal(version, '42');
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT\s+INTO\s+"system_settings"/i);
  assert.match(calls[0].sql, /ON\s+CONFLICT\s*\("key"\)\s+DO\s+UPDATE/i);
  assert.match(calls[0].sql, /RETURNING/i);
  assert.ok(calls[0].params.includes(versionModule.PERMISSION_VERSION_KEY));
});

test('permission-version reader normalizes missing and malformed values', async () => {
  const read = feature('readRbacPermissionVersion');
  const values = [null, { value: 'not-a-number' }, { value: '7' }];
  const prisma = {
    systemSettings: {
      async findUnique({ where }) {
        assert.equal(where.key, versionModule.PERMISSION_VERSION_KEY);
        return values.shift();
      },
    },
  };

  assert.equal(await read(prisma), '0');
  assert.equal(await read(prisma), '0');
  assert.equal(await read(prisma), '7');
});

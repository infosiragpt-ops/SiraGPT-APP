'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isInvalidEnvironmentAlias,
  isProductionLike,
  normalizeEnvironmentName,
} = require('../src/utils/environment');

test('isProductionLike recognizes only the literal production name case-insensitively', () => {
  for (const value of ['production', 'PRODUCTION', ' production ']) {
    assert.equal(isProductionLike({ NODE_ENV: value }), true, value);
  }
  assert.equal(isProductionLike({ NODE_ENV: 'prod' }), false);
});

test('isProductionLike rejects non-production environments', () => {
  for (const value of [undefined, '', 'development', 'test', 'staging']) {
    assert.equal(isProductionLike({ NODE_ENV: value }), false, String(value));
  }
});

test('normalizeEnvironmentName provides the shared canonical environment name', () => {
  assert.equal(normalizeEnvironmentName({ NODE_ENV: 'prod' }), 'invalid');
  assert.equal(normalizeEnvironmentName({ NODE_ENV: 'stage' }), 'staging');
  assert.equal(normalizeEnvironmentName({ NODE_ENV: 'test' }), 'test');
  assert.equal(normalizeEnvironmentName({}), 'development');
});

test('prod is an unsupported production alias rather than a partial production mode', () => {
  assert.equal(isInvalidEnvironmentAlias({ NODE_ENV: 'prod' }), true);
  assert.equal(isInvalidEnvironmentAlias({ NODE_ENV: ' PROD ' }), true);
  assert.equal(isInvalidEnvironmentAlias({ NODE_ENV: 'production' }), false);
  assert.equal(isInvalidEnvironmentAlias({ NODE_ENV: 'development' }), false);
});

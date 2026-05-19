// Tests for src/utils/config-validator.js (cycle 34)

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { validateConfig, resolveEnvName } = require('../src/utils/config-validator');

test('resolveEnvName maps NODE_ENV variants', () => {
  assert.strictEqual(resolveEnvName({ NODE_ENV: 'production' }), 'production');
  assert.strictEqual(resolveEnvName({ NODE_ENV: 'PROD' }), 'production');
  assert.strictEqual(resolveEnvName({ NODE_ENV: 'staging' }), 'staging');
  assert.strictEqual(resolveEnvName({ NODE_ENV: 'test' }), 'test');
  assert.strictEqual(resolveEnvName({}), 'development');
});

test('production requires DATABASE_URL / SESSION_SECRET / JWT_SECRET', () => {
  const r = validateConfig({ NODE_ENV: 'production' });
  assert.strictEqual(r.ok, false);
  const keys = r.errors.map((e) => e.key);
  assert.ok(keys.includes('DATABASE_URL'));
  assert.ok(keys.includes('SESSION_SECRET'));
  assert.ok(keys.includes('JWT_SECRET'));
});

test('production with valid required vars passes (with warnings allowed)', () => {
  const r = validateConfig({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://user:pw@db.internal:5432/sira',
    SESSION_SECRET: 'a'.repeat(64),
    JWT_SECRET: 'b'.repeat(64),
  });
  assert.strictEqual(r.ok, true);
});

test('production + localhost DATABASE_URL is a blocking error', () => {
  const r = validateConfig({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://user:pw@localhost:5432/sira',
    SESSION_SECRET: 'a'.repeat(64),
    JWT_SECRET: 'b'.repeat(64),
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.key === 'DATABASE_URL'));
});

test('production with CORS_ORIGIN=* emits warning', () => {
  const r = validateConfig({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://user:pw@db.internal:5432/sira',
    SESSION_SECRET: 'a'.repeat(64),
    JWT_SECRET: 'b'.repeat(64),
    CORS_ORIGIN: '*',
  });
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.some((w) => w.key === 'CORS_ORIGIN'));
});

test('development requires only DATABASE_URL', () => {
  const r = validateConfig({ NODE_ENV: 'development', DATABASE_URL: 'postgres://localhost/dev' });
  assert.strictEqual(r.ok, true);
});

test('short SESSION_SECRET in production warns', () => {
  const r = validateConfig({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://user:pw@db.internal:5432/sira',
    SESSION_SECRET: 'short',
    JWT_SECRET: 'b'.repeat(64),
  });
  assert.ok(r.warnings.some((w) => w.key === 'SESSION_SECRET'));
});

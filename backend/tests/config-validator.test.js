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

test('production requires PRISMA_DATABASE_URL / SESSION_SECRET / JWT_SECRET', () => {
  const r = validateConfig({ NODE_ENV: 'production' });
  assert.strictEqual(r.ok, false);
  const keys = r.errors.map((e) => e.key);
  assert.ok(keys.includes('PRISMA_DATABASE_URL'));
  assert.ok(keys.includes('SESSION_SECRET'));
  assert.ok(keys.includes('JWT_SECRET'));
});

test('production with valid required vars passes (with warnings allowed)', () => {
  const r = validateConfig({
    NODE_ENV: 'production',
    PRISMA_DATABASE_URL: 'postgres://user:pw@db.internal:5432/sira',
    SESSION_SECRET: 'a'.repeat(64),
    JWT_SECRET: 'b'.repeat(64),
  });
  assert.strictEqual(r.ok, true);
});

test('production + localhost PRISMA_DATABASE_URL warns by default', () => {
  const r = validateConfig({
    NODE_ENV: 'production',
    PRISMA_DATABASE_URL: 'postgres://user:pw@localhost:5432/sira',
    SESSION_SECRET: 'a'.repeat(64),
    JWT_SECRET: 'b'.repeat(64),
  });
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.some((w) => w.key === 'PRISMA_DATABASE_URL'));
});

test('production + localhost PRISMA_DATABASE_URL can be blocked by policy', () => {
  const r = validateConfig({
    NODE_ENV: 'production',
    DATABASE_URL_LOCALHOST_POLICY: 'block',
    PRISMA_DATABASE_URL: 'postgres://user:pw@localhost:5432/sira',
    SESSION_SECRET: 'a'.repeat(64),
    JWT_SECRET: 'b'.repeat(64),
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.key === 'PRISMA_DATABASE_URL'));
});

test('production + localhost PRISMA_DATABASE_URL is allowed in CI smoke tests', () => {
  const r = validateConfig({
    NODE_ENV: 'production',
    CI: 'true',
    PRISMA_DATABASE_URL: 'postgres://user:pw@localhost:5432/sira',
    SESSION_SECRET: 'a'.repeat(64),
    JWT_SECRET: 'b'.repeat(64),
  });
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.some((w) => w.key === 'PRISMA_DATABASE_URL'));
});

test('production with CORS_ORIGINS=* emits warning', () => {
  const r = validateConfig({
    NODE_ENV: 'production',
    PRISMA_DATABASE_URL: 'postgres://user:pw@db.internal:5432/sira',
    SESSION_SECRET: 'a'.repeat(64),
    JWT_SECRET: 'b'.repeat(64),
    CORS_ORIGINS: '*',
  });
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.some((w) => w.key === 'CORS_ORIGINS'));
});

test('development requires only PRISMA_DATABASE_URL', () => {
  const r = validateConfig({ NODE_ENV: 'development', PRISMA_DATABASE_URL: 'postgres://localhost/dev' });
  assert.strictEqual(r.ok, true);
});

test('short SESSION_SECRET in production warns', () => {
  const r = validateConfig({
    NODE_ENV: 'production',
    PRISMA_DATABASE_URL: 'postgres://user:pw@db.internal:5432/sira',
    SESSION_SECRET: 'short',
    JWT_SECRET: 'b'.repeat(64),
  });
  assert.ok(r.warnings.some((w) => w.key === 'SESSION_SECRET'));
});

test('PRISMA_DATABASE_URL takes precedence over legacy DATABASE_URL diagnostics', () => {
  const r = validateConfig({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://user:pw@localhost:5432/sira',
    PRISMA_DATABASE_URL: 'postgres://user:pw@db.internal:5432/sira',
    SESSION_SECRET: 'a'.repeat(64),
    JWT_SECRET: 'b'.repeat(64),
  });
  assert.strictEqual(r.ok, true);
  assert.equal(r.errors.length, 0);
});

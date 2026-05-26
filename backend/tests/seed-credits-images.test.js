'use strict';

// F1 PR3 — Static contract test for the credits + images migration.
// Asserts the table shape, enums, idempotency safeguards, and FK
// wiring that F2 (credits endpoints + chargeCredits middleware) and
// F4 (image worker) depend on. Static-only — no live DB required.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATION_PATH = path.resolve(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20260524020000_add_credits_and_images_tables',
  'migration.sql',
);

function readMigration() {
  return fs.readFileSync(MIGRATION_PATH, 'utf8');
}

test('credits+images migration: file exists', () => {
  assert.ok(fs.existsSync(MIGRATION_PATH), `missing migration at ${MIGRATION_PATH}`);
});

test('credits+images migration: declares both enums', () => {
  const sql = readMigration();
  assert.match(sql, /CREATE TYPE "CreditTransactionType" AS ENUM/);
  for (const v of ['GRANT', 'REFILL', 'SPEND', 'REFUND', 'ADMIN_ADJUSTMENT', 'EXPIRY']) {
    assert.match(sql, new RegExp(`'${v}'`), `CreditTransactionType value ${v} missing`);
  }
  assert.match(sql, /CREATE TYPE "ImageJobStatus" AS ENUM/);
  for (const v of ['PENDING', 'RUNNING', 'READY', 'FAILED', 'MODERATED']) {
    assert.match(sql, new RegExp(`'${v}'`), `ImageJobStatus value ${v} missing`);
  }
});

test('credits+images migration: creates all three tables', () => {
  const sql = readMigration();
  for (const table of ['credits', 'credit_transactions', 'generated_images']) {
    assert.match(
      sql,
      new RegExp(`CREATE TABLE IF NOT EXISTS "${table}"`),
      `table ${table} not created`,
    );
  }
});

test('credits table: balance/reservedBalance/lifetime columns + unique userId', () => {
  const sql = readMigration();
  for (const col of [
    'balance',
    'reservedBalance',
    'lifetimeGranted',
    'lifetimeSpent',
    'lastRefillAt',
    'nextRefillAt',
  ]) {
    assert.match(sql, new RegExp(`"${col}"`), `credits column ${col} missing`);
  }
  // BIGINT for all credit balances (avoids overflow at scale).
  assert.match(sql, /"balance"\s+BIGINT NOT NULL/);
  assert.match(sql, /"reservedBalance"\s+BIGINT NOT NULL/);
  // userId is unique (one row per user).
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "credits_userId_key"/);
});

test('credit_transactions: idempotencyKey partial unique index', () => {
  const sql = readMigration();
  assert.match(
    sql,
    /CREATE UNIQUE INDEX IF NOT EXISTS "credit_transactions_idempotencyKey_key"[\s\S]+?WHERE "idempotencyKey" IS NOT NULL/,
    'idempotencyKey unique index must be partial (allow NULLs)',
  );
});

test('credit_transactions: composite indexes for typical queries', () => {
  const sql = readMigration();
  for (const idx of [
    'credit_transactions_userId_createdAt_idx',
    'credit_transactions_orgId_createdAt_idx',
    'credit_transactions_type_createdAt_idx',
  ]) {
    assert.match(sql, new RegExp(idx), `index ${idx} missing`);
  }
  // amount must be BIGINT (can be positive for credits, negative for debits).
  assert.match(sql, /"amount"\s+BIGINT NOT NULL/);
  // metadata is JSONB with empty-object default.
  assert.match(sql, /"metadata"\s+JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
});

test('generated_images: prompt + provider + model + status + kind + parent FK', () => {
  const sql = readMigration();
  for (const col of [
    'prompt',
    'negativePrompt',
    'provider',
    'model',
    'size',
    'n',
    'seed',
    'quality',
    'style',
    'status',
    'costCredits',
    'errorMessage',
    'assetIds',
    'parentImageId',
    'kind',
    'deletedAt',
  ]) {
    assert.match(sql, new RegExp(`"${col}"`), `generated_images column ${col} missing`);
  }
  // status uses the new enum + default PENDING.
  assert.match(sql, /"status"\s+"ImageJobStatus" NOT NULL DEFAULT 'PENDING'/);
  // assetIds is a TEXT[] for the resulting file IDs.
  assert.match(sql, /"assetIds"\s+TEXT\[\]/);
  // Self-FK for variations/upscale tree.
  assert.match(sql, /generated_images_parentImageId_fkey[\s\S]+?REFERENCES "generated_images"\("id"\)[\s\S]+?ON DELETE SET NULL/);
});

test('generated_images: deletedAt enables soft-delete', () => {
  const sql = readMigration();
  assert.match(sql, /"deletedAt"\s+TIMESTAMP\(3\)/);
});

test('credits+images migration: foreign keys cascade from users', () => {
  const sql = readMigration();
  for (const fk of [
    'credits_userId_fkey',
    'credit_transactions_userId_fkey',
    'generated_images_userId_fkey',
  ]) {
    assert.match(sql, new RegExp(fk), `fk ${fk} missing`);
  }
  // Each must reference users.id with CASCADE on delete.
  assert.match(
    sql,
    /credits_userId_fkey[\s\S]+?REFERENCES "users"\("id"\)[\s\S]+?ON DELETE CASCADE/,
  );
});

test('credits+images migration: contains no destructive operations', () => {
  const sql = readMigration();
  assert.doesNotMatch(sql, /\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)\b/i);
  assert.doesNotMatch(sql, /\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i);
  assert.doesNotMatch(sql, /\bRENAME\s+(COLUMN|TO)\b/i);
});

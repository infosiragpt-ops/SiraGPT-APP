'use strict';

// F1 PR1 — Static contract test for the `plans` catalog migration.
//
// Verifies the migration SQL ships the table shape + the four canonical
// seed rows the rest of the roadmap depends on (F2 reads them, F3
// surfaces them, F4 charges credits from them). Static-only: parses the
// SQL file so it runs without a live Postgres and works in any CI
// environment.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATION_PATH = path.resolve(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20260523210000_add_plan_table',
  'migration.sql',
);

function readMigration() {
  return fs.readFileSync(MIGRATION_PATH, 'utf8');
}

test('plans migration: file exists', () => {
  assert.ok(fs.existsSync(MIGRATION_PATH), `missing migration at ${MIGRATION_PATH}`);
});

test('plans migration: creates the table with required columns', () => {
  const sql = readMigration();
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "plans"/i);
  for (const column of [
    'code',
    'name',
    'description',
    'priceMonthlyCents',
    'priceYearlyCents',
    'currency',
    'monthlyCredits',
    'trialDays',
    'features',
    'stripePriceIdMonthly',
    'stripePriceIdYearly',
    'isActive',
    'displayOrder',
    'createdAt',
    'updatedAt',
  ]) {
    assert.match(sql, new RegExp(`"${column}"`), `column ${column} missing`);
  }
});

test('plans migration: declares the unique index on code + the active index', () => {
  const sql = readMigration();
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "plans_code_key"/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS "plans_isActive_displayOrder_idx"/i);
});

test('plans migration: seeds the four canonical tiers with ON CONFLICT guard', () => {
  const sql = readMigration();
  assert.match(sql, /INSERT INTO "plans"/i);
  assert.match(sql, /ON CONFLICT \("code"\) DO NOTHING/i);
  for (const code of ['FREE', 'PRO', 'PRO_MAX', 'ENTERPRISE']) {
    assert.match(sql, new RegExp(`'${code}'`), `seed for code ${code} missing`);
  }
});

test('plans migration: monthlyCredits ladder matches the roadmap defaults', () => {
  const sql = readMigration();
  // Each seed line uses `'CODE', 'Name', 'desc', N, displayOrder)`. Test
  // the credit ladder against the spec without locking the description
  // wording.
  const freeRow = sql.match(/'plan_free',\s*'FREE',[^)]+/);
  const proRow = sql.match(/'plan_pro',\s*'PRO',[^)]+/);
  const proMaxRow = sql.match(/'plan_pro_max',\s*'PRO_MAX',[^)]+/);
  const entRow = sql.match(/'plan_enterprise',\s*'ENTERPRISE',[^)]+/);
  assert.ok(freeRow, 'FREE seed row missing');
  assert.ok(proRow, 'PRO seed row missing');
  assert.ok(proMaxRow, 'PRO_MAX seed row missing');
  assert.ok(entRow, 'ENTERPRISE seed row missing');
  assert.match(freeRow[0], /,\s*0,/, 'FREE monthlyCredits expected 0');
  assert.match(proRow[0], /,\s*500,/, 'PRO monthlyCredits expected 500');
  assert.match(proMaxRow[0], /,\s*5000,/, 'PRO_MAX monthlyCredits expected 5000');
  assert.match(entRow[0], /,\s*50000,/, 'ENTERPRISE monthlyCredits expected 50000');
});

test('plans migration: contains no destructive operations', () => {
  const sql = readMigration();
  assert.doesNotMatch(sql, /\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)\b/i);
  assert.doesNotMatch(sql, /\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i);
  assert.doesNotMatch(sql, /\bRENAME\s+(COLUMN|TO)\b/i);
});

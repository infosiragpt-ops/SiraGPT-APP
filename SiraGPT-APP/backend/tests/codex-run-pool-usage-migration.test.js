'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.join(
  __dirname,
  '../prisma/migrations/20260728210000_add_codex_run_pool_usage_ledger/migration.sql',
);
const sql = fs.readFileSync(migrationPath, 'utf8');

test('run attribution and usage-ledger migration is additive and idempotent', () => {
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "idempotencyKey"/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "departmentPoolId"/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "swarmTaskId"/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "codex_usage_entries"/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "codex_usage_entries_idempotencyKey_key"/);
  assert.match(sql, /WHERE conname = 'codex_usage_entries_projectId_fkey'/);
});

test('usage-ledger migration preserves existing data', () => {
  assert.doesNotMatch(sql, /\bDROP\s+(?:TABLE|COLUMN|INDEX)\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(sql, /\bUPDATE\s+"codex_runs"\b/i);
});

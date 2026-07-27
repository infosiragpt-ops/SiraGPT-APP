'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.join(
  __dirname,
  '../prisma/migrations/20260727230000_add_company_codex_tenant_links/migration.sql',
);
const sql = fs.readFileSync(migrationPath, 'utf8');

test('company association migration is additive and idempotent', () => {
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "organizationId"/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "company_codex_project_links"/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "project_connector_assignments"/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "company_codex_project_links_projectId_key"/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "company_codex_project_links_codexProjectId_key"/);
});

test('migration deliberately contains no guessed legacy backfill', () => {
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+"company_codex_project_links"/i);
  assert.doesNotMatch(sql, /UPDATE\s+"projects"\s+SET\s+"organizationId"/i);
  assert.doesNotMatch(sql, /localStorage/i);
});

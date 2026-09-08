'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20260727210000_add_codex_mission_evidence',
  'migration.sql',
);

test('mission evidence migration is additive and creates the durable review chain', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  for (const table of [
    'codex_missions',
    'codex_mission_artifacts',
    'codex_activity_reports',
    'codex_ceo_approvals',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE "${table}"`));
  }
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE)\b|DELETE\s+FROM/i);
  assert.doesNotMatch(sql, /ALTER TABLE "(?!codex_(?:missions|mission_artifacts|activity_reports|ceo_approvals)")/);
  assert.match(sql, /codex_missions_projectId_sourceRef_key/);
  assert.match(sql, /codex_ceo_approvals_resourceType_resourceId_createdAt_idx/);
});

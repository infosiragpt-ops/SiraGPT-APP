'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('external action approval migration is additive and durable', () => {
  const migration = fs.readFileSync(path.join(
    root,
    'prisma/migrations/20260730150000_harden_codex_external_action_approvals/migration.sql',
  ), 'utf8');
  for (const column of ['expiresAt', 'consumedAt', 'attemptId', 'revokedAt']) {
    assert.match(migration, new RegExp(`ADD COLUMN "${column}"`));
  }
  assert.match(migration, /CREATE INDEX/);
  assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE|DELETE FROM)\b/i);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.join(
  __dirname,
  '../prisma/migrations/20260727120000_add_codex_company_operations/migration.sql',
);

test('company operations migration targets the mapped users table', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  const userReferences = sql.match(/REFERENCES "users"\("id"\)/g) || [];

  assert.equal(userReferences.length, 3);
  assert.doesNotMatch(sql, /REFERENCES "User"\("id"\)/);
  assert.match(sql, /REFERENCES "codex_projects"\("id"\)/);
});

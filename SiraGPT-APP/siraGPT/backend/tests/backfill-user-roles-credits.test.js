'use strict';

// F1 PR4 — Static contract test for the user_roles + credits backfill.
// Asserts the data migration's structure so downstream PRs (F2 credits
// endpoints, F2 RBAC middleware) can rely on every existing user
// having (a) a GLOBAL role assignment, (b) an ORG role per membership,
// and (c) a credits row.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATION_PATH = path.resolve(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20260524030000_backfill_user_roles_and_credits',
  'migration.sql',
);

function readMigration() {
  return fs.readFileSync(MIGRATION_PATH, 'utf8');
}

test('backfill migration: file exists', () => {
  assert.ok(fs.existsSync(MIGRATION_PATH), `missing migration at ${MIGRATION_PATH}`);
});

test('backfill migration: three INSERTs into the three target tables', () => {
  const sql = readMigration();
  // 2 INSERTs into user_roles (GLOBAL + ORG), 1 into credits.
  const userRoleInserts = sql.match(/INSERT INTO "user_roles"/g) || [];
  const creditInserts = sql.match(/INSERT INTO "credits"/g) || [];
  assert.equal(userRoleInserts.length, 2, 'expected 2 INSERTs into user_roles');
  assert.equal(creditInserts.length, 1, 'expected 1 INSERT into credits');
});

test('backfill migration: every INSERT is idempotent via WHERE NOT EXISTS', () => {
  const sql = readMigration();
  const inserts = sql.match(/INSERT INTO (?:"user_roles"|"credits")/g) || [];
  const guards = sql.match(/WHERE NOT EXISTS \(\s*SELECT 1 FROM/g) || [];
  assert.equal(
    guards.length,
    inserts.length,
    'each INSERT must have a WHERE NOT EXISTS guard for replay safety',
  );
});

test('backfill migration: maps isSuperAdmin to SUPERADMIN role and others to USER', () => {
  const sql = readMigration();
  assert.match(
    sql,
    /CASE WHEN u\."isSuperAdmin" THEN 'SUPERADMIN' ELSE 'USER' END/,
    'global role assignment must branch on isSuperAdmin',
  );
});

test('backfill migration: maps every OrgRole enum value to the matching role code', () => {
  const sql = readMigration();
  for (const [orgRole, roleCode] of [
    ['OWNER', 'ORG_OWNER'],
    ['ADMIN', 'ORG_ADMIN'],
    ['MEMBER', 'ORG_MEMBER'],
    ['VIEWER', 'ORG_VIEWER'],
  ]) {
    assert.match(
      sql,
      new RegExp(`WHEN '${orgRole}'\\s+THEN '${roleCode}'`),
      `OrgRole ${orgRole} must map to ${roleCode}`,
    );
  }
});

test('backfill migration: org-scoped assignment populates scopeId from orgId', () => {
  const sql = readMigration();
  // The ORG INSERT must use 'ORG'::"RoleScope" and store om."orgId" in scopeId.
  const orgInsertBlock = sql.match(/INSERT INTO "user_roles"[\s\S]+?FROM "org_memberships"[\s\S]+?(?=INSERT INTO|$)/);
  assert.ok(orgInsertBlock, 'org membership insert block not found');
  assert.match(orgInsertBlock[0], /'ORG'::"RoleScope"/);
  assert.match(orgInsertBlock[0], /om\."orgId"/);
});

test('backfill migration: credit balance is sourced from plans.monthlyCredits via plan enum', () => {
  const sql = readMigration();
  assert.match(
    sql,
    /LEFT JOIN "plans" p ON p\.code = u\.plan::TEXT/,
    'must LEFT JOIN plans on the user.plan enum coerced to text',
  );
  assert.match(
    sql,
    /COALESCE\(p\."monthlyCredits", 0\)/,
    'must fall back to 0 if the user plan code is not in the catalog',
  );
});

test('backfill migration: credits nextRefillAt is one month forward', () => {
  const sql = readMigration();
  assert.match(sql, /CURRENT_TIMESTAMP \+ INTERVAL '1 month'/);
});

test('backfill migration: contains no destructive operations', () => {
  const sql = readMigration();
  assert.doesNotMatch(sql, /\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)\b/i);
  assert.doesNotMatch(sql, /\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i);
  assert.doesNotMatch(sql, /\bRENAME\s+(COLUMN|TO)\b/i);
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\s+"(users|org_memberships|credits|user_roles)"/i);
  assert.doesNotMatch(sql, /\bUPDATE\s+"(users|org_memberships)"/i);
});

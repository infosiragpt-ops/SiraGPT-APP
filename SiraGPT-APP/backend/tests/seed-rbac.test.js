'use strict';

// F1 PR2 — Static contract test for the RBAC catalog migration.
// Parses the migration SQL and asserts the shape + mappings the rest of
// the roadmap depends on: 6 system roles, the full permission catalog,
// and the canonical role→permission grants per the spec. Static-only:
// runs without a live Postgres so it works in any CI environment.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATION_PATH = path.resolve(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20260524010000_add_role_permission_tables',
  'migration.sql',
);

function readMigration() {
  return fs.readFileSync(MIGRATION_PATH, 'utf8');
}

const SYSTEM_ROLES = [
  'SUPERADMIN',
  'ORG_OWNER',
  'ORG_ADMIN',
  'ORG_MEMBER',
  'ORG_VIEWER',
  'USER',
];

// Subset of the catalog that downstream PRs depend on. The full set is
// larger; this test pins the load-bearing ones so accidental deletions
// fail fast.
const CRITICAL_PERMISSIONS = [
  'users.read',
  'users.impersonate',
  'admin.users.read',
  'admin.metrics.read',
  'credits.read',
  'credits.adjust',
  'credits.refund',
  'org.billing.manage',
  'org.members.invite',
  'images.generate',
  'images.upscale',
  'images.moderate',
  'video.generate',
  'paraphrase.use',
  'chat.read',
  'chat.create',
  'rbac.manage',
  'plans.manage',
  'metrics.read',
  'audit.read',
  'search.semantic',
  'embeddings.manage',
];

test('rbac migration: file exists', () => {
  assert.ok(fs.existsSync(MIGRATION_PATH), `missing migration at ${MIGRATION_PATH}`);
});

test('rbac migration: creates the four tables', () => {
  const sql = readMigration();
  for (const table of ['roles', 'permissions', 'role_permissions', 'user_roles']) {
    assert.match(
      sql,
      new RegExp(`CREATE TABLE IF NOT EXISTS "${table}"`),
      `table ${table} not created`,
    );
  }
});

test('rbac migration: declares the RoleScope enum', () => {
  const sql = readMigration();
  assert.match(sql, /CREATE TYPE "RoleScope" AS ENUM \('GLOBAL', 'ORG'\)/);
});

test('rbac migration: foreign keys reference parent tables', () => {
  const sql = readMigration();
  for (const fk of [
    'role_permissions_roleId_fkey',
    'role_permissions_permissionId_fkey',
    'user_roles_userId_fkey',
    'user_roles_roleId_fkey',
  ]) {
    assert.match(sql, new RegExp(fk), `fkey ${fk} missing`);
  }
});

test('rbac migration: seeds all six system roles', () => {
  const sql = readMigration();
  for (const code of SYSTEM_ROLES) {
    assert.match(sql, new RegExp(`'${code}'`), `role ${code} seed missing`);
  }
  // All seeded roles must be isSystem TRUE so they cannot be dropped by
  // the admin UI accidentally.
  const roleSeedBlock = sql.match(/INSERT INTO "roles"[\s\S]+?ON CONFLICT/);
  assert.ok(roleSeedBlock, 'role seed block not found');
  assert.match(roleSeedBlock[0], /TRUE\)[,\s]/, 'roles must be marked isSystem=TRUE');
});

test('rbac migration: seeds all critical permissions', () => {
  const sql = readMigration();
  for (const code of CRITICAL_PERMISSIONS) {
    assert.match(sql, new RegExp(`'${code.replace(/\./g, '\\.')}'`), `permission ${code} missing`);
  }
});

test('rbac migration: SUPERADMIN gets all permissions via cartesian join', () => {
  const sql = readMigration();
  assert.match(
    sql,
    /CROSS JOIN "permissions" p[\s\S]+?r\."code" = 'SUPERADMIN'/,
    'SUPERADMIN must receive all permissions via CROSS JOIN',
  );
});

test('rbac migration: ORG_ADMIN explicitly excludes billing.manage and org.delete', () => {
  const sql = readMigration();
  const orgAdminBlock = sql.match(/code" = 'ORG_ADMIN'[\s\S]+?ON CONFLICT/);
  assert.ok(orgAdminBlock, 'ORG_ADMIN block not found');
  // Need to look at the preceding IN(...) clause for ORG_ADMIN.
  const orgAdminInsert = sql.match(/'rp_org_admin_'[\s\S]+?WHERE r\."code" = 'ORG_ADMIN'/);
  assert.ok(orgAdminInsert, 'ORG_ADMIN insert block not found');
  assert.doesNotMatch(
    orgAdminInsert[0],
    /'org\.billing\.manage'/,
    'ORG_ADMIN must NOT have org.billing.manage',
  );
  assert.doesNotMatch(
    orgAdminInsert[0],
    /'org\.delete'/,
    'ORG_ADMIN must NOT have org.delete',
  );
});

test('rbac migration: ORG_VIEWER is strictly read-only', () => {
  const sql = readMigration();
  const orgViewerInsert = sql.match(/'rp_org_viewer_'[\s\S]+?WHERE r\."code" = 'ORG_VIEWER'/);
  assert.ok(orgViewerInsert, 'ORG_VIEWER insert block not found');
  for (const writeishCode of [
    'chat.create',
    'chat.update',
    'chat.delete',
    'project.create',
    'images.generate',
    'video.generate',
    'paraphrase.use',
    'thesis.use',
    'rbac.manage',
  ]) {
    assert.doesNotMatch(
      orgViewerInsert[0],
      new RegExp(`'${writeishCode.replace(/\./g, '\\.')}'`),
      `ORG_VIEWER must NOT have ${writeishCode}`,
    );
  }
});

test('rbac migration: every role_permissions insert is idempotent', () => {
  const sql = readMigration();
  const inserts = sql.match(/INSERT INTO "role_permissions"/g) || [];
  const onConflicts = sql.match(/ON CONFLICT \("roleId", "permissionId"\) DO NOTHING/g) || [];
  assert.ok(inserts.length >= 6, `expected ≥6 role_permissions inserts, got ${inserts.length}`);
  assert.equal(
    inserts.length,
    onConflicts.length,
    'every role_permissions insert must have an ON CONFLICT guard',
  );
});

test('rbac migration: contains no destructive operations', () => {
  const sql = readMigration();
  assert.doesNotMatch(sql, /\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)\b/i);
  assert.doesNotMatch(sql, /\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i);
  assert.doesNotMatch(sql, /\bRENAME\s+(COLUMN|TO)\b/i);
});

'use strict';

// F1 PR5 + U2 — Drift detection for the committed RBAC matrix snapshot.
// Re-builds the matrix from the runtime source-of-truth catalog and compares against
// `docs/architecture/rbac-matrix.md`. Fails if a role_permissions
// change lands without regenerating the snapshot.
//
// To fix a failure: `node scripts/dump-permissions.js --update`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'dump-permissions.js');
const SNAPSHOT = path.join(ROOT, 'docs', 'architecture', 'rbac-matrix.md');

test('rbac matrix: dump script exists', () => {
  assert.ok(fs.existsSync(SCRIPT), `missing ${SCRIPT}`);
});

test('rbac matrix: snapshot exists', () => {
  assert.ok(fs.existsSync(SNAPSHOT), `missing ${SNAPSHOT}`);
});

test('rbac matrix: snapshot matches the source migration', () => {
  // Re-build from the runtime catalog via the script's module exports.
  const { buildMatrix } = require(SCRIPT);
  const current = fs.readFileSync(SNAPSHOT, 'utf8').trimEnd();
  const fresh = buildMatrix().trimEnd();
  assert.equal(
    fresh,
    current,
    'RBAC matrix snapshot is out of date — run `node scripts/dump-permissions.js --update`',
  );
});

test('rbac matrix: runtime catalog includes least-privilege PLATFORM_ADMIN', () => {
  const { buildMatrix } = require(SCRIPT);
  const matrix = buildMatrix();
  const lines = matrix.split('\n');
  const header = lines.find((line) => line.startsWith('| Permission |'));
  assert.ok(header, 'permission matrix header missing');
  const columns = header.split('|').map((cell) => cell.trim()).filter(Boolean);
  const platformIndex = columns.indexOf('PLATFORM_ADMIN');
  assert.ok(platformIndex > 0, 'PLATFORM_ADMIN column missing');
  assert.match(
    matrix,
    /Source: backend\/src\/services\/rbac-catalog\.js\./,
    'matrix must identify the runtime catalog as its source of truth',
  );

  function platformGrant(permission) {
    const row = lines.find((line) => line.startsWith(`| \`${permission}\` |`));
    assert.ok(row, `permission row missing: ${permission}`);
    const cells = row.split('|').map((cell) => cell.trim()).filter((_, index, all) =>
      index > 0 && index < all.length - 1);
    return cells[platformIndex];
  }

  assert.equal(platformGrant('admin.users.read'), '✓');
  assert.equal(platformGrant('users.impersonate'), '');
  assert.equal(platformGrant('rbac.manage'), '');
});

test('PLATFORM_ADMIN covers every non-superadmin admin route and excludes sensitive-only grants', () => {
  const { ROLE_PERMISSIONS } = require('../src/services/rbac-catalog');
  const { ADMIN_ROUTE_POLICIES } = require('../src/services/admin-route-policy');
  const platformPermissions = new Set(ROLE_PERMISSIONS.PLATFORM_ADMIN);
  const nonSuperadminPermissions = new Set(
    Object.values(ADMIN_ROUTE_POLICIES)
      .filter((policy) => policy.superAdmin === false)
      .map((policy) => policy.permission),
  );

  for (const permission of nonSuperadminPermissions) {
    assert.equal(
      platformPermissions.has(permission),
      true,
      `PLATFORM_ADMIN is missing non-superadmin surface permission ${permission}`,
    );
  }
  for (const permission of [
    'rbac.manage',
    'users.impersonate',
    'users.password.reset',
    'credits.adjust',
    'credits.refund',
    'admin.queues.manage',
    'admin.api_keys.manage',
    'webhooks.manage',
  ]) {
    assert.equal(
      platformPermissions.has(permission),
      false,
      `PLATFORM_ADMIN must exclude sensitive permission ${permission}`,
    );
  }
});

test('rbac matrix: per-role counts match the documented spec', () => {
  const { buildMatrix, extractRolePermissions, extractAllPermissionCodes } = require(SCRIPT);
  const fs2 = require('node:fs');
  const sql = fs2.readFileSync(
    path.join(
      ROOT,
      'backend',
      'prisma',
      'migrations',
      '20260524010000_add_role_permission_tables',
      'migration.sql',
    ),
    'utf8',
  );
  const allPerms = extractAllPermissionCodes(sql);
  // SUPERADMIN must own every permission (sanity check on the cartesian
  // join path inside the dump script).
  assert.equal(
    extractRolePermissions(sql, 'SUPERADMIN').length,
    allPerms.length,
    'SUPERADMIN must include every permission',
  );
  // ORG_VIEWER is the most restrictive — must have at most 6 read-only
  // permissions; a regression that adds write perms here is a security
  // bug we want to catch loudly.
  const viewerPerms = extractRolePermissions(sql, 'ORG_VIEWER');
  assert.ok(
    viewerPerms.length <= 6,
    `ORG_VIEWER must stay read-only (≤6 perms), got ${viewerPerms.length}: ${viewerPerms.join(', ')}`,
  );
  for (const p of viewerPerms) {
    assert.ok(
      /\.(read)$/.test(p) || p === 'org.read',
      `ORG_VIEWER must not have non-read permission ${p}`,
    );
  }
  // ORG_ADMIN must NOT have org.billing.manage (spec invariant).
  assert.ok(
    !extractRolePermissions(sql, 'ORG_ADMIN').includes('org.billing.manage'),
    'ORG_ADMIN must NOT have org.billing.manage',
  );
  // Build the matrix and assert the header is what downstream tools expect.
  assert.match(
    buildMatrix(),
    /^# RBAC Permission Matrix \(auto-generated\)/,
  );
});

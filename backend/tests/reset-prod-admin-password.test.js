'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  MIN_ADMIN_PASSWORD_LENGTH,
  readResetConfig,
  validateResetConfig,
  rotateAdminCredential,
} = require('../scripts/reset-prod-admin-password');

const repoRoot = path.resolve(__dirname, '..', '..');

test('reset config has no default identity or password', () => {
  assert.deepEqual(readResetConfig({}), {
    email: '',
    password: '',
  });
  assert.throws(
    () => validateResetConfig(readResetConfig({})),
    /RESET_ADMIN_EMAIL is required/,
  );
  assert.throws(
    () =>
      validateResetConfig({
        email: 'admin@example.com',
        password: 'short',
      }),
    new RegExp(String(MIN_ADMIN_PASSWORD_LENGTH)),
  );
});

test('credential rotation updates only the password and revokes sessions', async () => {
  const calls = [];
  const prisma = {
    async $transaction(callback) {
      return callback({
        user: {
          async update(args) {
            calls.push(['update', args]);
            return { id: 'admin-user' };
          },
        },
        session: {
          async deleteMany(args) {
            calls.push(['deleteMany', args]);
            return { count: 2 };
          },
        },
      });
    },
  };

  const result = await rotateAdminCredential({
    prisma,
    config: {
      email: 'admin@example.com',
      password: 'x'.repeat(MIN_ADMIN_PASSWORD_LENGTH),
    },
    hashPassword: async () => 'bcrypt-hash',
  });

  assert.deepEqual(result, { rotated: 1, sessionsRevoked: 2 });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0][1].where, { email: 'admin@example.com' });
  assert.equal(calls[0][1].data.password, 'bcrypt-hash');
  assert.ok(calls[0][1].data.updatedAt instanceof Date);
  assert.deepEqual(Object.keys(calls[0][1].data).sort(), ['password', 'updatedAt']);
  assert.deepEqual(calls[1][1], { where: { userId: 'admin-user' } });
});

test('production deploy never mutates admin credentials', () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, '.github', 'workflows', 'deploy.yml'),
    'utf8',
  );
  assert.doesNotMatch(workflow, /reset-prod-admin-password/);
  assert.doesNotMatch(workflow, /RESET_ADMIN_PASSWORD/);
});

test('reset script never embeds or logs a password fallback', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'backend', 'scripts', 'reset-prod-admin-password.js'),
    'utf8',
  );
  assert.doesNotMatch(source, /RESET_ADMIN_PASSWORD\s*\|\|\s*['"][^'"]+/);
  assert.doesNotMatch(source, /default:/i);
  assert.doesNotMatch(source, /isSuperAdmin:\s*true/);
  assert.doesNotMatch(source, /twoFactorEnabled:\s*false/);
  assert.doesNotMatch(source, /totpEnabled:\s*false/);
});

test('a terminal migration retires the legacy bootstrap identity', () => {
  const migrationsDir = path.join(repoRoot, 'backend', 'prisma', 'migrations');
  const retirementName = '20260731233000_retire_legacy_bootstrap_admin';
  const resetNames = [
    '20260524033500_ensure_prod_admin_account',
    '20260527000000_reset_admin_password',
    '20260628171000_force_reset_prod_admin_password',
  ];
  const migrationNames = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.ok(migrationNames.includes(retirementName));
  for (const resetName of resetNames) {
    assert.ok(
      migrationNames.indexOf(retirementName) > migrationNames.indexOf(resetName),
      `${retirementName} must run after ${resetName}`,
    );
  }

  const migration = fs.readFileSync(
    path.join(migrationsDir, retirementName, 'migration.sql'),
    'utf8',
  );
  assert.match(migration, /DELETE FROM "sessions"/);
  assert.match(migration, /DELETE FROM "user_roles"/);
  assert.match(migration, /"isAdmin" = FALSE/);
  assert.match(migration, /"isSuperAdmin" = FALSE/);
  assert.match(migration, /column_name = 'isSuperAdmin'/);
  assert.match(migration, /"deletedAt" = COALESCE/);
  assert.match(migration, /"id" = 'prod_admin_admin_gmail_com'/);
  assert.match(migration, /"email" = 'admin@gmail\.com'/);
});

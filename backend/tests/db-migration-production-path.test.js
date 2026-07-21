'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..', '..');
const BACKEND = path.join(ROOT, 'backend');

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('CI uses prisma migrate deploy (not db push alone) for the shared production path', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /prisma migrate deploy --schema prisma\/schema\.prisma/);
  assert.match(ci, /CI and production share the same `prisma migrate deploy` path \(U0\)/);
  // Residual schema.prisma alignment for the test suite is allowed only AFTER
  // migrate deploy succeeds — never as a substitute for migration history.
  const deployIdx = ci.indexOf('prisma migrate deploy --schema prisma/schema.prisma');
  const pushIdx = ci.indexOf('prisma db push --schema prisma/schema.prisma');
  assert.ok(deployIdx >= 0);
  assert.ok(pushIdx > deployIdx);
});

test('boot and migrate-only never call migrate resolve and reject P3005 without baseline', () => {
  const wrapper = fs.readFileSync(
    path.join(BACKEND, 'scripts', 'start-with-migrations.js'),
    'utf8',
  );
  assert.doesNotMatch(wrapper, /["']migrate["']\s*,\s*["']resolve["']/);
  assert.doesNotMatch(wrapper, /MIGRATION_ALLOW_EQUIVALENT_UNBASELINED/);
  assert.doesNotMatch(wrapper, /verifyEquivalentUnbaselinedSchema/);
  assert.match(wrapper, /MIGRATION_HISTORY_BASELINE_REQUIRED/);
  assert.match(wrapper, /baseline-migration-history\.js/);
});

test('reviewed baseline script exists and is confirm-gated outside boot', () => {
  const script = fs.readFileSync(
    path.join(BACKEND, 'scripts', 'baseline-migration-history.js'),
    'utf8',
  );
  assert.match(script, /I_REVIEWED_PRODUCTION_SCHEMA/);
  assert.match(script, /MIGRATION_BASELINE_CONFIRM/);
  assert.match(script, /migrate['"]\s*,\s*['"]resolve['"]/);
  assert.match(script, /Never invoke from boot or --migrate-only/);
  assert.doesNotMatch(
    fs.readFileSync(path.join(BACKEND, 'scripts', 'start-with-migrations.js'), 'utf8'),
    /require\(['"]\.\/baseline-migration-history['"]\)/,
  );
});

test('deploy workflow wires deploy-production-baseline-* to the reviewed one-off', () => {
  const workflow = read('.github/workflows/deploy.yml');
  assert.match(workflow, /startsWith\(github\.ref_name, 'deploy-production-baseline-'\)/);
  assert.match(workflow, /ALLOW_MIGRATION_BASELINE:\s+\$\{\{/);
  assert.match(workflow, /envs: DEPLOY_GH_TOKEN,TARGET_SHA,ALLOW_MIGRATION_BASELINE/);
  assert.match(workflow, /baseline-migration-history\.js/);
  assert.match(workflow, /MIGRATION_BASELINE_CONFIRM=I_REVIEWED_PRODUCTION_SCHEMA/);
  assert.match(workflow, /MIGRATION_BASELINE_SYNC_SCHEMA=1/);
  assert.doesNotMatch(workflow, /ALLOW_EQUIVALENT_UNBASELINED/);
  assert.doesNotMatch(workflow, /MIGRATION_ALLOW_EQUIVALENT_UNBASELINED/);
  assert.doesNotMatch(workflow, /deploy-production-equivalent-/);
});

test('health readiness remains critical for failed migration rows', () => {
  const health = fs.readFileSync(
    path.join(BACKEND, 'src', 'services', 'observability', 'health-check.js'),
    'utf8',
  );
  assert.match(health, /_prisma_migrations/);
  assert.match(health, /migrationsFailed/);
  assert.match(health, /finished_at IS NULL AND rolled_back_at IS NULL/);
});

test('rollout docs describe U0 reviewed one-off before schema-bearing units', () => {
  const envDocs = read('docs/operations/ENVIRONMENT.md');
  const plan = read('docs/plans/2026-07-10-001-feat-platform-improvements-program-plan.md');
  const deployment = read('docs/deployment.md');
  for (const source of [envDocs, plan]) {
    assert.match(source, /U0/i);
    assert.match(source, /reviewed one-off/i);
    assert.match(source, /before schema-bearing units/i);
  }
  assert.match(envDocs, /baseline-migration-history\.js/);
  assert.match(envDocs, /deploy-production-baseline-/);
  assert.doesNotMatch(envDocs, /Temporary no-schema U1 compatibility/);
  assert.match(deployment, /U0/);
  assert.match(deployment, /baseline-migration-history/);
});

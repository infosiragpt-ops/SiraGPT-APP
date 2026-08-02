'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('backup script falls back to PRISMA_DATABASE_URL', () => {
  const script = fs.readFileSync(path.join(root, 'backend/scripts/backup-db.sh'), 'utf8');
  assert.match(script, /PRISMA_DATABASE_URL/);
  assert.match(script, /DATABASE_URL="\$\{DATABASE_URL:-\$\{PRISMA_DATABASE_URL:-\}\}"/);
});

test('db backup workflow reads the resolved runtime database URL without sourcing env files', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/db-backup.yml'), 'utf8');
  assert.match(workflow, /cd \/opt\/siragpt/);
  assert.doesNotMatch(workflow, /\/root\/siraNew\/siraGPT/);
  assert.doesNotMatch(workflow, /(?:^|[;\s])\.\s+(?:backend\/)?\.env/m);
  assert.doesNotMatch(workflow, /source\s+(?:backend\/)?\.env/);
  assert.match(workflow, /com\.docker\.compose\.service=backend/);
  assert.match(workflow, /docker exec "\$\{BACKEND_CONTAINER\}"/);
  assert.match(workflow, /refusing to guess database credentials/);
  assert.match(workflow, /DATABASE_URL\/PRISMA_DATABASE_URL/);
  assert.match(workflow, /PRISMA_DATABASE_URL/);
  assert.match(workflow, /127\.0\.0\.1:5432/);
  assert.match(workflow, /DATABASE_URL="\$\{DATABASE_URL\/\/@db:5432\/@127\.0\.0\.1:5432\}"/);
});

test('db backup workflow skips S3 upload when backup secrets are absent', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/db-backup.yml'), 'utf8');
  assert.match(workflow, /gzip -t "\$\{LATEST\}"/);
  assert.match(workflow, /sha256sum "\$\{LATEST\}" > "\$\{LATEST\}\.sha256"/);
  assert.match(workflow, /s3 cp "\$\{LATEST\}\.sha256"/);
  assert.match(workflow, /BACKUP_BUCKET \/ BACKUP_ACCESS_KEY_ID \/ BACKUP_SECRET_ACCESS_KEY are not fully configured/);
  assert.match(workflow, /exit 0/);
});

test('production deploy proves a release backup restore before baseline or migrations', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8');
  const checkpoint = workflow.indexOf('bash backend/scripts/pre-deploy-db-backup.sh');
  const baseline = workflow.indexOf('backend node scripts/baseline-migration-history.js');
  const migration = workflow.indexOf('backend node scripts/start-with-migrations.js --migrate-only');

  assert.ok(checkpoint > 0, 'expected the mandatory release checkpoint');
  assert.ok(checkpoint < baseline, 'checkpoint must precede the optional baseline');
  assert.ok(checkpoint < migration, 'checkpoint must precede migrate-only');
  assert.match(workflow, /RELEASE_SHA="\$\{TARGET_SHA\}"/);
  assert.match(workflow, /BACKUP_DIR="\$\{APP_DIR\}\/backups\/releases"/);
  assert.match(workflow, /Pre-migration database restore proof passed/);
});

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

test('restore drill workflow exists and runs monthly against the VPS', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/db-restore-drill.yml'), 'utf8');
  assert.match(workflow, /cron: '30 5 1 \* \*'/);
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /appleboy\/ssh-action@7eaf76671a0d7eec5d98ee897acda4f968735a17/);
  assert.match(workflow, /secrets\.VPS_HOST/);
  assert.match(workflow, /secrets\.BACKUP_BUCKET/);
  assert.match(workflow, /concurrency:\n {2}group: db-restore-drill/);
});

test('restore drill never touches the live database', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/db-restore-drill.yml'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'scripts/restore-db.sh'), 'utf8');
  assert.match(script, /siragpt_drill_/);
  // The drill creates and drops ONLY its prefixed scratch database.
  assert.doesNotMatch(script, /DROP DATABASE (?!\\?")(?:IF EXISTS )?(?!\\?")siragpt(?!_drill)/m);
  assert.doesNotMatch(workflow, /docker compose[^\n]*down/i);
  assert.doesNotMatch(workflow, /restart[^\n]*(backend|db|frontend)/i);
  // No hard-coded production DB names (the db-snapshot.yml smell).
  assert.doesNotMatch(script, /siraGPTNew|siragpt_new/);
});

test('restore drill reads credentials from runtime and verifies before restoring', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/restore-db.sh'), 'utf8');
  // Same credential contract as backup-db.sh.
  assert.match(script, /DATABASE_URL="\$\{DATABASE_URL:-\$\{PRISMA_DATABASE_URL:-\}\}"/);
  // Integrity gates precede any psql usage. Checksum is compared directly
  // (`sha256sum -c` exit status is unreliable across implementations).
  const shaIdx = script.indexOf('ACTUAL_SHA="$(sha256sum "${BACKUP_FILE}"');
  const gzipIdx = script.indexOf('gzip -t');
  const createIdx = script.indexOf('CREATE DATABASE');
  assert.ok(shaIdx !== -1, 'checksum gate missing');
  assert.ok(gzipIdx !== -1, 'gzip integrity gate missing');
  assert.ok(createIdx > gzipIdx, 'must validate gzip before creating the drill DB');
  // Content verification thresholds.
  assert.match(script, /DRILL_MIN_TABLES:-100/);
  assert.match(script, /DRILL_CORE_TABLES:-users,chats,messages/);
  assert.match(script, /information_schema\.tables/);
});

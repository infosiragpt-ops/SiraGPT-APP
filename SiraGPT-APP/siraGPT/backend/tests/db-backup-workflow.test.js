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

test('db backup workflow skips S3 upload when backup secrets are absent', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/db-backup.yml'), 'utf8');
  assert.match(workflow, /PRISMA_DATABASE_URL/);
  assert.match(workflow, /BACKUP_BUCKET \/ BACKUP_ACCESS_KEY_ID \/ BACKUP_SECRET_ACCESS_KEY are not fully configured/);
  assert.match(workflow, /exit 0/);
});

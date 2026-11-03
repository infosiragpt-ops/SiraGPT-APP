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

test('db backup workflow dumps the live Lenovo iliagpt database, not the legacy VPS', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/db-backup.yml'), 'utf8');
  // Runs next to production, on the same runner as the publish workflow.
  assert.match(workflow, /runs-on: \[self-hosted, linux, siragpt-lenovo\]/);
  // The legacy VPS path picked the first `backend`-labelled container, which
  // is stuck restarting there, so every run failed before pg_dump.
  assert.doesNotMatch(workflow, /secrets\.VPS_HOST/);
  assert.doesNotMatch(workflow, /cd \/opt\/siragpt/);
  assert.doesNotMatch(workflow, /com\.docker\.compose\.service=backend/);
  assert.doesNotMatch(workflow, /\/root\/siraNew\/siraGPT/);
  // Same compose project and in-container credentials as publish-reviewed.sh.
  assert.match(workflow, /docker compose -p iliagpt -f "\$DEPLOY\/compose\.yaml" --env-file "\$DEPLOY\/\.env"/);
  assert.match(workflow, /ps -q db/);
  assert.match(workflow, /\{\{\.State\.Status\}\}/);
  assert.match(workflow, /exec -T db sh -c 'exec pg_dump --no-owner --no-acl -U "\$POSTGRES_USER" -d "\$POSTGRES_DB"'/);
  // Never reads, sources or prints connection strings.
  assert.doesNotMatch(workflow, /DATABASE_URL/);
  assert.doesNotMatch(workflow, /(?:^|[;\s])\.\s+(?:\S*\/)?\.env/m);
  assert.doesNotMatch(workflow, /source\s+\S*\.env/);
  assert.doesNotMatch(workflow, /cat\s+"?\$DEPLOY\/\.env/);
  // Never takes the publication lock (publish refuses to start while it exists).
  assert.doesNotMatch(workflow, /mkdir\s+"?\$PUBLISH_LOCK/);
});

test('db backup workflow verifies the dump and skips S3 upload when backup secrets are absent', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/db-backup.yml'), 'utf8');
  assert.match(workflow, /gzip -t "\$\{LATEST\}"/);
  assert.match(workflow, /PostgreSQL database dump complete/);
  assert.match(workflow, /sha256sum "\$NAME" > "\$NAME\.sha256"/);
  assert.match(workflow, /s3_put "\$\{LATEST\}\.sha256"/);
  assert.match(workflow, /siraGPT_\$\{KIND\}_\$\{TIMESTAMP\}\.sql\.gz/);
  assert.match(workflow, /BACKUP_BUCKET \/ BACKUP_ACCESS_KEY_ID \/ BACKUP_SECRET_ACCESS_KEY are not fully configured/);
  assert.match(workflow, /exit 0/);
  // Credentials reach the aws container by variable name only.
  assert.match(workflow, /-e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY/);
});

test('restore drill workflow runs monthly on the Lenovo runner, not the legacy VPS', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/db-restore-drill.yml'), 'utf8');
  assert.match(workflow, /cron: '30 5 1 \* \*'/);
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /runs-on: \[self-hosted, linux, siragpt-lenovo\]/);
  assert.doesNotMatch(workflow, /secrets\.VPS_HOST/);
  assert.doesNotMatch(workflow, /cd \/opt\/siragpt/);
  assert.match(workflow, /secrets\.BACKUP_BUCKET/);
  assert.match(workflow, /concurrency:\n {2}group: db-restore-drill/);
  assert.match(workflow, /bash scripts\/restore-db\.sh/);
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
  // Restores into a throwaway, network-less container from the live db image;
  // psql only ever reaches that container's own loopback.
  assert.match(workflow, /--network none --memory 2g --cpus 1/);
  assert.match(workflow, /\{\{\.Config\.Image\}\}/);
  assert.match(workflow, /exec docker exec -i "\$\{DRILL_CONTAINER:\?\}" psql "\$@"/);
  assert.match(workflow, /DATABASE_URL='postgresql:\/\/postgres:scratch@127\.0\.0\.1:5432\/postgres'/);
  assert.doesNotMatch(workflow, /exec -T db|docker exec [^\n]*\$db_id/);
  assert.match(workflow, /if: always\(\)[\s\S]*docker rm -f -v "\$DRILL_CONTAINER"/);
});

test('restore drill rejects a stale newest backup', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/restore-db.sh'), 'utf8');
  assert.match(script, /MAX_AGE_HOURS="\$\{DRILL_MAX_AGE_HOURS:-48\}"/);
  const ageIdx = script.indexOf('AGE_HOURS > MAX_AGE_HOURS');
  const downloadIdx = script.indexOf('s3 cp "s3://${BACKUP_BUCKET}/${LATEST_KEY}"');
  assert.ok(ageIdx !== -1 && downloadIdx !== -1 && ageIdx < downloadIdx, 'freshness gate must run before download');
});

test('volumes backup archives the live Lenovo backend volumes, never the database volume', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/volumes-backup.yml'), 'utf8');
  assert.match(workflow, /runs-on: \[self-hosted, linux, siragpt-lenovo\]/);
  assert.doesNotMatch(workflow, /secrets\.VPS_HOST/);
  assert.doesNotMatch(workflow, /\/opt\/siragpt/);
  assert.match(workflow, /docker compose -p iliagpt -f "\$DEPLOY\/compose\.yaml" --env-file "\$DEPLOY\/\.env"/);
  assert.match(workflow, /ps -q backend\)/);
  assert.doesNotMatch(workflow, /ps -q db\)/);
  assert.doesNotMatch(workflow, /pgdata/);
  assert.match(workflow, /-v "\$\{volume\}:\/src:ro"/);
  assert.match(workflow, /--network none/);
  assert.match(workflow, /gzip -t "\$out"/);
  assert.match(workflow, /BACKUP_BUCKET \/ BACKUP_ACCESS_KEY_ID \/ BACKUP_SECRET_ACCESS_KEY are not fully configured/);
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

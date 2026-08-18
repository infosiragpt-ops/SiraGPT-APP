'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const script = path.join(root, 'backend/scripts/pre-deploy-db-backup.sh');
const releaseSha = 'a'.repeat(40);
const imageId = `sha256:${'b'.repeat(64)}`;

function writeFakeDocker(directory) {
  const executable = path.join(directory, 'fake-docker');
  fs.writeFileSync(executable, `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\\n');
const output = (value) => process.stdout.write(String(value));
if (args[0] === 'ps') output('siragpt-db-1\\n');
else if (args[0] === 'inspect') output('${imageId}\\n');
else if (args[0] === 'image' && args[1] === 'inspect') process.exit(0);
else if (args[0] === 'run') output('restore-container-id\\n');
else if (args[0] === 'stop' || args[0] === 'rm') process.exit(0);
else if (args[0] === 'exec') {
  let index = 1;
  while (args[index] && args[index].startsWith('-')) index += 1;
  const container = args[index];
  const command = args.slice(index + 1);
  const joined = command.join(' ');
  if (container === 'siragpt-db-1' && command[0] === 'sh') output('postgres\\nsiragpt\\n');
  else if (container === 'siragpt-db-1' && command[0] === 'pg_dump') {
    output('CREATE TABLE public.sample (id integer);\\nCREATE TABLE public."_prisma_migrations" (id text);\\nINSERT INTO public."_prisma_migrations" VALUES (\\'m1\\');\\n'.repeat(4));
  } else if (command[0] === 'pg_isready') process.exit(0);
  else if (command[0] === 'psql' && !command.includes('--command')) {
    process.stdin.resume();
    process.stdin.on('end', () => process.exit(process.env.FAKE_RESTORE_FAIL === '1' ? 7 : 0));
  } else if (command[0] === 'psql' && joined.includes('pg_catalog.pg_tables')) output('2\\n');
  else if (command[0] === 'psql' && joined.includes('to_regclass')) output('present\\n');
  else if (command[0] === 'psql' && joined.includes('_prisma_migrations')) output('1\\n');
  else process.exit(9);
} else process.exit(8);
`);
  fs.chmodSync(executable, 0o755);
  return executable;
}

function executeFixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-release-backup-'));
  const backupDir = path.join(directory, 'backups');
  const dockerLog = path.join(directory, 'docker.log');
  fs.writeFileSync(dockerLog, '');
  const docker = writeFakeDocker(directory);
  const result = spawnSync('bash', [script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      DOCKER_BIN: docker,
      FAKE_DOCKER_LOG: dockerLog,
      RELEASE_SHA: releaseSha,
      BACKUP_DIR: backupDir,
      RESTORE_TIMEOUT_SECONDS: '3',
      MIN_BACKUP_BYTES: '100',
      ...extraEnv,
    },
  });
  return { directory, backupDir, dockerLog, result };
}

test('creates a release-scoped checksum and isolated restore proof', (t) => {
  const fixture = executeFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));

  assert.equal(fixture.result.status, 0, fixture.result.stderr || fixture.result.stdout);
  const files = fs.readdirSync(fixture.backupDir);
  const backup = files.find((name) => name.endsWith('.sql.gz'));
  assert.ok(backup);
  assert.ok(files.includes(`${backup}.sha256`));
  assert.ok(files.includes(`${backup}.manifest`));

  const manifest = fs.readFileSync(path.join(fixture.backupDir, `${backup}.manifest`), 'utf8');
  assert.match(manifest, new RegExp(`release_sha=${releaseSha}`));
  assert.match(manifest, /public_tables=2/);
  assert.match(manifest, /prisma_migrations=1/);
  assert.match(manifest, /restore_network=none/);

  const calls = fs.readFileSync(fixture.dockerLog, 'utf8');
  assert.match(calls, /"run","-d","--rm","--network","none"/);
  assert.match(calls, /"pg_dump"/);
  assert.match(calls, /"psql","-X","-v","ON_ERROR_STOP=1"/);
});

test('fails closed when the isolated restore rejects the dump', (t) => {
  const fixture = executeFixture({ FAKE_RESTORE_FAIL: '1' });
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));

  assert.notEqual(fixture.result.status, 0);
  assert.match(fixture.result.stderr, /isolated restore failed/);
  const files = fs.readdirSync(fixture.backupDir);
  assert.equal(files.some((name) => name.endsWith('.manifest')), false);
  assert.match(fs.readFileSync(fixture.dockerLog, 'utf8'), /"stop","--time","5"/);
});

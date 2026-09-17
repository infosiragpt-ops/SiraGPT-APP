'use strict';

// Operator-coordinated, isolated PostgreSQL rehearsal. No Docker/SSH, app boot,
// provider calls, production URLs, service lifecycle, db push or migration resolve.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

const MIGRATION = '20260905000000_doc_sandbox_core';
const SQL_SHA256 = 'a699ad981695f8dd4d48b327ba6fe77c4cc0b7e0f2b0c3183fbf33c0b369ba21';
const HOST = 'doc-sandbox-rehearsal-postgres';
const APP = '/workspace/backend';
const EVIDENCE = '/evidence';
const FORMAT = 'siragpt-phase1-migration-rehearsal-v1';
const NEW_TABLES = ['doc_job_artifacts', 'doc_job_events', 'doc_jobs'];
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const quoteIdentifier = name => '"' + name.replaceAll('"', '""') + '"';
const canonical = value => JSON.stringify(value);
function options(args) {
  const result = {};
  for (const arg of args) {
    const match = /^--(phase|database|candidate-sha|backup-sha256|source-manifest-sha256)=(.+)$/.exec(arg);
    assert.ok(match && !Object.hasOwn(result, match[1]), 'REHEARSAL_ARGUMENTS');
    result[match[1]] = match[2];
  }
  assert.ok(['baseline', 'upgrade', 'recovered'].includes(result.phase), 'REHEARSAL_PHASE');
  assert.match(result.database || '', /^doc_sandbox_rehearsal_[a-f0-9]{32}$/);
  assert.match(result['candidate-sha'] || '', /^[a-f0-9]{40}$/);
  assert.match(result['backup-sha256'] || '', /^[a-f0-9]{64}$/);
  assert.match(result['source-manifest-sha256'] || '', /^[a-f0-9]{64}$/);
  return result;
}
function connection(database) {
  assert.match(database, /^doc_sandbox_rehearsal_[a-f0-9]{32}$/);
  return { host: HOST, port: 5432, database, user: 'doc_fixture', password: 'fixture-only-isolated',
    application_name: 'phase1-migration-rehearsal', connectionTimeoutMillis: 10_000,
    query_timeout: 65_000, statement_timeout: 60_000, lock_timeout: 5_000 };
}
function regular(filename) {
  const stat = fs.lstatSync(filename);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'REHEARSAL_REGULAR_FILE_REQUIRED');
  return stat;
}
function manifest(directory) {
  const result = {};
  for (const name of fs.readdirSync(directory).sort()) {
    const entry = path.join(directory, name); const stat = fs.lstatSync(entry);
    assert.ok(!stat.isSymbolicLink(), 'REHEARSAL_MIGRATION_SYMLINK');
    if (name === 'migration_lock.toml') { assert.ok(stat.isFile()); continue; }
    assert.ok(stat.isDirectory() && /^\d{14}_[a-z0-9_]+$/.test(name), 'REHEARSAL_MIGRATION_NAME');
    const filename = path.join(entry, 'migration.sql'); regular(filename);
    result[name] = digest(fs.readFileSync(filename));
  }
  assert.equal(result[MIGRATION], SQL_SHA256, 'REHEARSAL_PHASE1_SQL_CHANGED');
  assert.ok(Object.keys(result).length > 1, 'REHEARSAL_HISTORY_REQUIRED');
  return result;
}
/** Run on the checkout BEFORE transfer, without network; no secrets or data. */
function sourceAttestation(repository, candidateSha) {
  assert.match(candidateSha, /^[a-f0-9]{40}$/);
  const git = args => {
    const result = spawnSync('git', ['-C', repository, ...args], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
    assert.ok(!result.error && result.status === 0, 'REHEARSAL_GIT_SOURCE_UNAVAILABLE');
    return result.stdout;
  };
  const migrationManifest = manifest(path.join(repository, 'backend/prisma/migrations'));
  const files = ['backend/prisma/schema.prisma', 'backend/package.json', 'backend/package-lock.json', 'backend/prisma/migrations/migration_lock.toml',
    ...Object.keys(migrationManifest).map(name => `backend/prisma/migrations/${name}/migration.sql`)];
  const tracked = git(['ls-tree', '-r', '--name-only', candidateSha, '--', 'backend/prisma/migrations']).toString('utf8').trim().split('\n').filter(name => name.endsWith('/migration.sql')).sort();
  assert.deepEqual(tracked, files.filter(name => name.endsWith('/migration.sql')).sort(), 'REHEARSAL_SOURCE_HISTORY_DRIFT');
  const hashes = {};
  for (const name of files) {
    regular(path.join(repository, name)); const bytes = fs.readFileSync(path.join(repository, name));
    assert.ok(git(['show', `${candidateSha}:${name}`]).equals(bytes), 'REHEARSAL_UNCOMMITTED_SOURCE');
    hashes[name] = digest(bytes);
  }
  return { format: `${FORMAT}-sources`, candidateSha, migrationManifest, hashes, harnessSha256: digest(fs.readFileSync(__filename)) };
}
function verifySourceAttestation(attestation, candidateSha, repository) {
  assert.equal(attestation.format, `${FORMAT}-sources`, 'REHEARSAL_SOURCE_MANIFEST_FORMAT');
  assert.equal(attestation.candidateSha, candidateSha, 'REHEARSAL_SOURCE_COMMIT_MISMATCH');
  assert.equal(attestation.harnessSha256, digest(fs.readFileSync(__filename)), 'REHEARSAL_HARNESS_CHANGED');
  assert.deepEqual(attestation.migrationManifest, manifest(path.join(repository, 'backend/prisma/migrations')), 'REHEARSAL_SOURCE_HISTORY_DRIFT');
  const names = ['backend/prisma/schema.prisma', 'backend/package.json', 'backend/package-lock.json', 'backend/prisma/migrations/migration_lock.toml',
    ...Object.keys(attestation.migrationManifest).map(name => `backend/prisma/migrations/${name}/migration.sql`)];
  assert.deepEqual(Object.keys(attestation.hashes).sort(), names.sort(), 'REHEARSAL_SOURCE_FILES_MISMATCH');
  for (const name of names) { regular(path.join(repository, name)); assert.equal(digest(fs.readFileSync(path.join(repository, name))), attestation.hashes[name], 'REHEARSAL_SOURCE_BYTES_CHANGED'); }
}
function verifyHistory(rows, source, upgraded) {
  const expected = Object.keys(source).filter(name => upgraded || name !== MIGRATION).sort();
  assert.deepEqual(rows.map(row => row.migration_name).sort(), expected, 'REHEARSAL_HISTORY_MISMATCH');
  for (const row of rows) {
    assert.ok(row.finished_at && !row.rolled_back_at, 'REHEARSAL_INCOMPLETE_MIGRATION');
    assert.equal(row.checksum, source[row.migration_name], 'REHEARSAL_HISTORY_CHECKSUM');
  }
}
function verifyUpgrade(before, after) {
  assert.deepEqual(after.tables.map(table => table.name).filter(name => !before.tables.some(table => table.name === name)).sort(), NEW_TABLES);
  for (const table of before.tables) {
    const current = after.tables.find(row => row.name === table.name);
    assert.ok(current, 'REHEARSAL_TABLE_REMOVED');
    if (table.name !== '_prisma_migrations') assert.deepEqual(current, table, 'REHEARSAL_EXISTING_TABLE_CHANGED');
    else assert.deepEqual(current.structure, table.structure, 'REHEARSAL_HISTORY_STRUCTURE_CHANGED');
  }
  assert.deepEqual(after.sequences, before.sequences, 'REHEARSAL_SEQUENCE_CHANGED');
  assert.deepEqual(after.enums, before.enums, 'REHEARSAL_ENUM_CHANGED');
  assert.deepEqual(after.extensions, before.extensions, 'REHEARSAL_EXTENSION_CHANGED');
  assert.deepEqual(after.catalogSha256, before.catalogSha256, 'REHEARSAL_CATALOG_CHANGED');
  assert.deepEqual(after.history.filter(row => row.migration_name !== MIGRATION), before.history, 'REHEARSAL_OLD_HISTORY_CHANGED');
}
function privateRead(name) {
  const filename = path.join(EVIDENCE, name); const stat = regular(filename);
  assert.ok((stat.mode & 0o077) === 0 && stat.uid === process.getuid() && stat.size < 20 * 1024 * 1024, 'REHEARSAL_PRIVATE_EVIDENCE');
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}
function save(name, value) {
  const fd = fs.openSync(path.join(EVIDENCE, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, canonical(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
async function history(db) {
  return (await db.query('SELECT id,migration_name,checksum,finished_at,rolled_back_at,started_at,applied_steps_count FROM "_prisma_migrations" ORDER BY migration_name')).rows;
}
async function snapshot(db, omitNewUserColumn) {
  // Refuse unsupported data locations rather than silently excluding them from proof.
  const others = (await db.query("SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','f','m') AND n.nspname NOT IN ('public','information_schema') AND n.nspname !~ '^pg_' LIMIT 1")).rows;
  assert.equal(others.length, 0, 'REHEARSAL_UNSUPPORTED_NONPUBLIC_DATA');
  assert.equal((await db.query('SELECT count(*)::text AS count FROM pg_largeobject_metadata')).rows[0].count, '0', 'REHEARSAL_UNSUPPORTED_LARGE_OBJECTS');
  assert.equal((await db.query("SELECT count(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('f','m')")).rows[0].count, '0', 'REHEARSAL_UNSUPPORTED_RELATION');
  const names = (await db.query("SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename COLLATE \"C\"")).rows.map(row => row.name);
  assert.ok(names.includes('users') && names.includes('_prisma_migrations'), 'REHEARSAL_APPLICATION_SCHEMA_REQUIRED');
  const tables = [];
  for (const name of names) {
    const qualified = `public.${quoteIdentifier(name)}`;
    const columns = (await db.query(`SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS notnull,
      pg_get_expr(d.adbin,d.adrelid) AS default,a.attidentity AS identity,a.attgenerated AS generated
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [qualified])).rows;
    const indexes = (await db.query('SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename=$2 ORDER BY indexname', ['public', name])).rows;
    const constraints = (await db.query('SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass ORDER BY conname', [qualified])).rows;
    const expression = omitNewUserColumn && name === 'users' ? "to_jsonb(t)-'docQuotaEpoch'" : 'to_jsonb(t)';
    await db.query(`DECLARE rehearsal_rows NO SCROLL CURSOR FOR SELECT (${expression})::text AS value FROM ${qualified} t ORDER BY (${expression})::text COLLATE "C"`);
    const hash = crypto.createHash('sha256'); let count = 0;
    for (;;) {
      const rows = (await db.query('FETCH FORWARD 500 FROM rehearsal_rows')).rows;
      if (!rows.length) break;
      for (const row of rows) { const bytes = Buffer.from(row.value); hash.update(String(bytes.length) + ':'); hash.update(bytes); count++; }
    }
    await db.query('CLOSE rehearsal_rows');
    tables.push({ name, count, sha256: hash.digest('hex'), structure: { columns: columns.filter(column => !(omitNewUserColumn && name === 'users' && column.name === 'docQuotaEpoch')), indexes, constraints } });
  }
  const sequences = [];
  const sequenceNames = (await db.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows;
  for (const { sequencename } of sequenceNames) sequences.push({ name: sequencename, ...(await db.query(`SELECT last_value::text,is_called FROM public.${quoteIdentifier(sequencename)}`)).rows[0] });
  const enums = (await db.query("SELECT t.typname,e.enumlabel,e.enumsortorder FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' ORDER BY t.typname,e.enumsortorder")).rows;
  const extensions = (await db.query('SELECT extname,extversion FROM pg_extension ORDER BY extname')).rows;
  // Definitions are hashed in memory, never included as source text in evidence.
  const routines = (await db.query(`SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p')
    ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)`)).rows;
  const views = (await db.query("SELECT viewname,definition FROM pg_views WHERE schemaname='public' ORDER BY viewname")).rows;
  const triggers = (await db.query(`SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`)).rows;
  const policies = (await db.query("SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname")).rows;
  const catalogSha256 = digest(canonical({ routines, views, triggers, policies }));
  return { tables, sequences, enums, extensions, catalogSha256, history: await history(db) };
}
async function consistentSnapshot(db, omitNewUserColumn = false) {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try { const result = await snapshot(db, omitNewUserColumn); await db.query('COMMIT'); return result; }
  catch (error) { await db.query('ROLLBACK'); throw error; }
}
function deployMigration(database, source) {
  const directory = fs.mkdtempSync('/tmp/phase1-prisma-rehearsal-'); fs.chmodSync(directory, 0o700);
  const expected = manifest(path.join(source, 'migrations'));
  fs.copyFileSync(path.join(source, 'schema.prisma'), path.join(directory, 'schema.prisma'), fs.constants.COPYFILE_EXCL);
  fs.mkdirSync(path.join(directory, 'migrations'));
  for (const name of Object.keys(expected)) {
    fs.mkdirSync(path.join(directory, 'migrations', name));
    fs.copyFileSync(path.join(source, 'migrations', name, 'migration.sql'), path.join(directory, 'migrations', name, 'migration.sql'), fs.constants.COPYFILE_EXCL);
  }
  const lock = path.join(source, 'migrations', 'migration_lock.toml'); regular(lock);
  fs.copyFileSync(lock, path.join(directory, 'migrations', 'migration_lock.toml'), fs.constants.COPYFILE_EXCL);
  assert.deepEqual(manifest(path.join(directory, 'migrations')), expected);
  // Never use application startup: it may load dotenv or start background jobs.
  const url = new URL(`postgresql://${HOST}:5432/${database}`);
  url.username = 'doc_fixture'; url.password = 'fixture-only-isolated'; url.searchParams.set('schema', 'public');
  const result = spawnSync(process.execPath, [path.join(APP, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema', path.join(directory, 'schema.prisma')],
    { cwd: directory, env: { PATH: process.env.PATH, DATABASE_URL: url.toString(), NODE_ENV: 'test', CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      timeout: 180_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
  assert.ok(!result.error && result.status === 0 && !result.signal, 'REHEARSAL_PRISMA_DEPLOY_FAILED');
}
async function rejectSql(db, sql, args, code) {
  let caught;
  try { await db.query(sql, args); } catch (error) { caught = error; }
  assert.equal(caught?.code, code, 'REHEARSAL_CONSTRAINT_NOT_ENFORCED');
}
async function syntheticObligations(db) {
  const owner = `rehearsal-${crypto.randomUUID()}`;
  await db.query('INSERT INTO users(id,email,name,password,"updatedAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP)',
    [owner, `${owner}@example.invalid`, 'Synthetic restore fixture', 'not-a-login-password']);
  const job = `rehearsal-${crypto.randomUUID()}`;
  const insert = `INSERT INTO doc_jobs(id,user_id,model_tier,requested_model,token_budget,instructions_key,input_keys,idempotency_key,payload_hash,prompt_version,expires_at)
    VALUES($1,$2,'mechanical','synthetic-no-provider',137,'synthetic/instructions',ARRAY['synthetic/input'],'synthetic-restore-idempotency',$3,'synthetic-v1',CURRENT_TIMESTAMP+interval '1 day')`;
  await rejectSql(db, insert, [`${job}-missing`, `${owner}-missing`, 'a'.repeat(64)], '23503');
  await db.query(insert, [job, owner, 'a'.repeat(64)]);
  await rejectSql(db, insert, [`${job}-duplicate`, owner, 'a'.repeat(64)], '23505');
  await rejectSql(db, "UPDATE doc_jobs SET status='done',outcome='edited' WHERE id=$1", [job], '23514');
  await db.query(`UPDATE doc_jobs SET status='cancelled',deleted_at=CURRENT_TIMESTAMP,cleanup_pending=true,quota_reserved_tokens=137,
    cost_usd=0.10,max_cost_usd=1.00,cost_reservations=$2::jsonb,provider_containers=$3::jsonb WHERE id=$1`,
    [job, JSON.stringify([{ requestId: 'synthetic-unresolved-request', attempt: 1, reservedUsd: '0.25', actualUsd: null, actualTokens: null }]),
      JSON.stringify([{ id: 'synthetic-no-provider-container', expiresAt: null, stage: 'plan' }])]);
  await db.query("INSERT INTO doc_job_events(id,job_id,seq,type,payload,outbox) VALUES($1,$2,1,'cancelled','{}','cleanup')", [`${job}-event`, job]);
  await db.query(`INSERT INTO doc_job_artifacts(id,job_id,attempt,kind,storage_key,filename,mime,size,sha256,published)
    VALUES($1,$2,0,'input',$3,'synthetic.txt','text/plain',9,$4,false)`, [`${job}-artifact`, job, `synthetic/${job}/input`, 'b'.repeat(64)]);
  await rejectSql(db, 'DELETE FROM users WHERE id=$1', [owner], '23503');
}
async function main() {
  const opt = options(process.argv.slice(2));
  assert.equal(process.env.NODE_ENV, 'test');
  const sourceStat = regular('/source-manifest.json');
  assert.ok((sourceStat.mode & 0o077) === 0 && sourceStat.size < 20 * 1024 * 1024, 'REHEARSAL_PRIVATE_SOURCE_MANIFEST');
  const sourceBytes = fs.readFileSync('/source-manifest.json');
  assert.equal(digest(sourceBytes), opt['source-manifest-sha256'], 'REHEARSAL_SOURCE_MANIFEST_HASH');
  verifySourceAttestation(JSON.parse(sourceBytes), opt['candidate-sha'], path.dirname(APP));
  const metadata = fs.lstatSync(EVIDENCE);
  assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink() && (metadata.mode & 0o077) === 0 && metadata.uid === process.getuid(), 'REHEARSAL_PRIVATE_DIRECTORY');
  const source = path.join(APP, 'prisma'); regular(path.join(source, 'schema.prisma'));
  const sourceManifest = manifest(path.join(source, 'migrations'));
  const requireApp = createRequire(path.join(APP, 'package.json'));
  assert.equal(requireApp('prisma/package.json').version, '6.19.3', 'REHEARSAL_UNREVIEWED_PRISMA_VERSION');
  const { Client } = requireApp('pg');
  const db = new Client(connection(opt.database));
  try {
    await db.connect();
    const postgresVersion = Number((await db.query('SHOW server_version_num')).rows[0].server_version_num);
    assert.ok(postgresVersion >= 160000 && postgresVersion < 170000, 'REHEARSAL_REQUIRES_POSTGRES16');
    const identity = (await db.query('SELECT current_database() AS database,system_identifier::text AS system_identifier FROM pg_control_system()')).rows[0];
    assert.equal(identity.database, opt.database);
    const proof = { format: FORMAT, candidateSha: opt['candidate-sha'], sourceBackupSha256: opt['backup-sha256'], phase1SqlSha256: SQL_SHA256,
      harnessSha256: digest(fs.readFileSync(__filename)), prismaSchemaSha256: digest(fs.readFileSync(path.join(source, 'schema.prisma'))),
      sourceAttestationSha256: opt['source-manifest-sha256'],
      sourceManifest, database: opt.database, postgresSystemIdentifier: identity.system_identifier,
      startedAt: new Date().toISOString(), noApplicationStarted: true, providerRequests: 0 };
    if (opt.phase === 'baseline') {
      verifyHistory(await history(db), sourceManifest, false);
      proof.snapshot = await consistentSnapshot(db);
      assert.ok(!proof.snapshot.tables.some(table => NEW_TABLES.includes(table.name)), 'REHEARSAL_NOT_A_PREF1_BACKUP');
    } else {
      const before = privateRead('baseline.json');
      for (const key of ['format', 'candidateSha', 'sourceBackupSha256', 'phase1SqlSha256', 'sourceManifest', 'postgresSystemIdentifier', 'harnessSha256', 'prismaSchemaSha256', 'sourceAttestationSha256']) assert.deepEqual(proof[key], before[key], 'REHEARSAL_EVIDENCE_MISMATCH');
      if (opt.phase === 'upgrade') {
        assert.equal(opt.database, before.database);
        assert.deepEqual(canonical(await consistentSnapshot(db)), canonical(before.snapshot), 'REHEARSAL_BASELINE_DRIFT');
        // Bounds apply to subsequent Prisma connections to this test database only.
        await db.query(`ALTER DATABASE ${quoteIdentifier(opt.database)} SET lock_timeout='5s'`);
        await db.query(`ALTER DATABASE ${quoteIdentifier(opt.database)} SET statement_timeout='60s'`);
        deployMigration(opt.database, source);
        const after = await consistentSnapshot(db, true);
        verifyHistory(after.history, sourceManifest, true);
        verifyUpgrade(before.snapshot, JSON.parse(canonical(after)));
        assert.equal((await db.query('SELECT count(*)::text AS count FROM users WHERE "docQuotaEpoch" IS DISTINCT FROM 0')).rows[0].count, '0');
        await syntheticObligations(db);
        proof.snapshot = await consistentSnapshot(db);
        deployMigration(opt.database, source);
        assert.equal(canonical(await consistentSnapshot(db)), canonical(proof.snapshot), 'REHEARSAL_SECOND_DEPLOY_CHANGED_DATA');
        proof.preservedExistingData = true; proof.constraints = ['23503', '23505', '23514']; proof.idempotentMigration = true;
      } else {
        const upgraded = privateRead('upgrade.json');
        assert.notEqual(opt.database, before.database, 'REHEARSAL_RECOVERY_REQUIRES_ANOTHER_DATABASE');
        for (const key of ['format', 'candidateSha', 'sourceBackupSha256', 'phase1SqlSha256', 'sourceManifest', 'postgresSystemIdentifier', 'harnessSha256', 'prismaSchemaSha256', 'sourceAttestationSha256']) assert.deepEqual(upgraded[key], proof[key], 'REHEARSAL_UPGRADE_EVIDENCE_MISMATCH');
        proof.snapshot = await consistentSnapshot(db);
        assert.equal(canonical(proof.snapshot), canonical(upgraded.snapshot), 'REHEARSAL_RESTORE_DATA_OR_SCHEMA_CHANGED');
        proof.postAdmissionLedgerAndTombstonesRetained = true;
      }
    }
    proof.completedAt = new Date().toISOString(); proof.status = 'passed';
    proof.applicationDowngradeVerified = false; proof.productionMigrationExecuted = false;
    save(`${opt.phase}.json`, proof);
    console.log(JSON.stringify({ phase: opt.phase, status: 'passed', tables: proof.snapshot.tables.length,
      migrationCount: proof.snapshot.history.length, productionMigrationExecuted: false, applicationDowngradeVerified: false }));
  } finally { await db.end(); }
}
if (require.main === module) main().catch(error => {
  // Never print SQL, client rows, provider credentials, URLs or arbitrary error.message.
  const reason = typeof error.message === 'string' ? /^(REHEARSAL_[A-Z0-9_]+)(?:\n|$)/.exec(error.message)?.[1] : undefined;
  console.error(JSON.stringify({ status: 'failed', code: typeof error.code === 'string' && /^[A-Z0-9_]{2,64}$/.test(error.code) ? error.code : 'REHEARSAL_FAILED', ...(reason ? { reason } : {}) }));
  process.exitCode = 1;
});
module.exports = { MIGRATION, SQL_SHA256, HOST, FORMAT, NEW_TABLES, options, connection, manifest, sourceAttestation, verifySourceAttestation, verifyHistory, verifyUpgrade, digest, quoteIdentifier };

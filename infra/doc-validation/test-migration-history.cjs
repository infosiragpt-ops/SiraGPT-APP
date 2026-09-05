'use strict';
// Synthetic PostgreSQL history verification. Invoked only by the scoped shell
// wrapper; no production URL, data, credentials, db push, or migration resolve.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const SOURCE = '/workspace';
const EVIDENCE = '/evidence';
const F1 = '20260905000000_doc_sandbox_core';
const { Client } = require(path.join(SOURCE, 'backend/node_modules/pg'));
const prismaCli = path.join(SOURCE, 'backend/node_modules/prisma/build/index.js');
const credentials = { host: 'doc-sandbox-history-postgres', port: 5432, user: 'doc_fixture', password: 'fixture-only-isolated' };
const database = `doc_sandbox_history_${crypto.randomBytes(8).toString('hex')}`;
const report = { startedAt: new Date().toISOString(), scope: 'synthetic-isolated-test', database,
  baseCommit: process.argv[2], candidateCommit: process.argv[3], noProductionData: true, databaseRetained: false, steps: [] };
const save = () => fs.writeFileSync(path.join(EVIDENCE, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
function step(name, details = {}) { report.steps.push({ name, ...details }); save(); console.log(JSON.stringify({ stage: name, ...details })); }
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function migrations(directory) {
  return fs.readdirSync(directory).filter(name => /^\d{14}_/.test(name) && fs.existsSync(path.join(directory, name, 'migration.sql'))).sort();
}
function prisma(label, schema, command = ['migrate', 'deploy']) {
  const result = cp.spawnSync(process.execPath, [prismaCli, ...command, '--schema', schema], {
    cwd: path.dirname(schema), encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: '/tmp', NODE_ENV: 'test', CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1',
      DATABASE_URL: `postgresql://${credentials.user}:${credentials.password}@${credentials.host}:${credentials.port}/${database}?schema=public` },
  });
  const safeOutput = `${result.stdout || ''}\n${result.stderr || ''}`.replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[synthetic database URL]');
  fs.writeFileSync(path.join(EVIDENCE, `${label}.log`), safeOutput, { mode: 0o600 });
  step(label, { exitCode: result.status, errorCode: result.error?.code || null });
  assert.equal(result.error, undefined, `${label}: ${result.error?.code}`);
  assert.equal(result.status, 0, `${label} failed; inspect ${label}.log`);
}
async function history(client, expected, directory) {
  const { rows } = await client.query('SELECT migration_name, checksum, finished_at, rolled_back_at, applied_steps_count FROM "_prisma_migrations" ORDER BY migration_name');
  assert.deepEqual(rows.map(row => row.migration_name), expected);
  for (const row of rows) {
    assert.ok(row.finished_at && row.rolled_back_at === null, `incomplete migration: ${row.migration_name}`);
    assert.equal(row.checksum, sha256(fs.readFileSync(path.join(directory, row.migration_name, 'migration.sql'))));
  }
  return rows;
}
async function rejected(client, text, values, code) {
  try { await client.query(text, values); assert.fail(`SQL expected to reject with ${code}`); }
  catch (error) { assert.equal(error.code, code); }
}
async function main() {
  assert.match(report.baseCommit || '', /^[a-f0-9]{40}$/);
  assert.match(report.candidateCommit || '', /^[a-f0-9]{40}$/);
  assert.equal(process.env.NODE_ENV, 'test');
  const base = path.join(EVIDENCE, 'base/backend/prisma');
  const candidate = '/tmp/doc-sandbox-history-candidate';
  fs.mkdirSync(candidate, { mode: 0o700 });
  fs.cpSync(path.join(SOURCE, 'backend/prisma/schema.prisma'), path.join(candidate, 'schema.prisma'));
  fs.cpSync(path.join(SOURCE, 'backend/prisma/migrations'), path.join(candidate, 'migrations'), { recursive: true });
  const baseNames = migrations(path.join(base, 'migrations'));
  const candidateNames = migrations(path.join(candidate, 'migrations'));
  assert.deepEqual(candidateNames.filter(name => !baseNames.includes(name)), [F1]);
  for (const name of baseNames) assert.equal(
    sha256(fs.readFileSync(path.join(base, 'migrations', name, 'migration.sql'))),
    sha256(fs.readFileSync(path.join(candidate, 'migrations', name, 'migration.sql'))), `historical SQL changed: ${name}`);
  step('immutable-source-history-verified', { baseMigrationCount: baseNames.length, candidateMigrationCount: candidateNames.length,
    phase1Sha256: sha256(fs.readFileSync(path.join(candidate, 'migrations', F1, 'migration.sql'))) });
  const admin = new Client({ ...credentials, database: 'doc_sandbox_fixture' });
  const db = new Client({ ...credentials, database });
  try {
    await admin.connect();
    const vector = await admin.query("SELECT name, default_version FROM pg_available_extensions WHERE name = 'vector'");
    assert.equal(vector.rows.length, 1, 'pgvector extension is unavailable on the isolated test server');
    report.pgvectorAvailable = vector.rows[0];
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
    report.databaseRetained = true;
    await db.connect();
    report.postgresVersion = (await db.query('SELECT version() AS version')).rows[0].version;
    assert.equal((await db.query("SELECT count(*)::integer AS count FROM information_schema.tables WHERE table_schema='public'")).rows[0].count, 0);
    step('empty-synthetic-database-created', { database, pgvector: vector.rows[0].default_version });
    prisma('base-migrate-deploy', path.join(base, 'schema.prisma'));
    await history(db, baseNames, path.join(base, 'migrations'));
    const baseTables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name")).rows.map(row => row.table_name);
    assert.ok(!baseTables.includes('doc_jobs'));
    const userId = `migration-history-${crypto.randomBytes(8).toString('hex')}`;
    await db.query('INSERT INTO users (id, email, name, password, "updatedAt") VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)',
      [userId, `${userId}@example.invalid`, 'Synthetic migration preservation fixture', 'not-a-login-password']);
    const beforeUser = (await db.query('SELECT to_jsonb(users) AS value FROM users WHERE id=$1', [userId])).rows[0].value;
    step('base-history-and-synthetic-row-verified', { migrationCount: baseNames.length, tableCount: baseTables.length });
    prisma('phase1-migrate-deploy', path.join(candidate, 'schema.prisma'));
    const firstHistory = await history(db, candidateNames, path.join(candidate, 'migrations'));
    const afterUser = (await db.query('SELECT to_jsonb(users) AS value FROM users WHERE id=$1', [userId])).rows[0].value;
    assert.equal(afterUser.docQuotaEpoch, 0);
    delete afterUser.docQuotaEpoch;
    assert.deepEqual(afterUser, beforeUser);
    const candidateTables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name")).rows.map(row => row.table_name);
    assert.deepEqual(candidateTables.filter(name => !baseTables.includes(name)).sort(), ['doc_job_artifacts', 'doc_job_events', 'doc_jobs']);
    assert.deepEqual(baseTables.filter(name => !candidateTables.includes(name)), []);
    const insertJob = `INSERT INTO doc_jobs (id, user_id, model_tier, requested_model, token_budget, instructions_key, input_keys,
      idempotency_key, payload_hash, prompt_version, expires_at) VALUES ($1,$2,'mechanical','synthetic-model',100,'fixture/instructions',
      ARRAY['fixture/input'],$3,$4,'fixture-v1',CURRENT_TIMESTAMP + interval '1 day')`;
    const payloadHash = 'a'.repeat(64);
    await rejected(db, insertJob, ['missing-owner', 'nonexistent-fixture-owner', 'missing-owner', payloadHash], '23503');
    await db.query(insertJob, ['synthetic-history-job', userId, 'synthetic-idempotency', payloadHash]);
    await rejected(db, insertJob, ['synthetic-history-duplicate', userId, 'synthetic-idempotency', payloadHash], '23505');
    await rejected(db, "UPDATE doc_jobs SET status='done',outcome='edited' WHERE id='synthetic-history-job'", [], '23514');
    step('phase1-upgrade-preserves-base-and-enforces-constraints', { newTables: ['doc_job_artifacts', 'doc_job_events', 'doc_jobs'],
      preservedFixture: true, foreignKey: '23503', idempotencyConstraint: '23505', publicationConstraint: '23514' });
    prisma('idempotent-migrate-deploy', path.join(candidate, 'schema.prisma'));
    assert.deepEqual(await history(db, candidateNames, path.join(candidate, 'migrations')), firstHistory);
    assert.equal((await db.query("SELECT count(*)::integer AS count FROM doc_jobs WHERE id='synthetic-history-job'")).rows[0].count, 1);
    prisma('final-migrate-status', path.join(candidate, 'schema.prisma'), ['migrate', 'status']);
    report.pgvectorInstalled = (await db.query("SELECT extversion FROM pg_extension WHERE extname='vector'")).rows[0]?.extversion;
    assert.ok(report.pgvectorInstalled);
    report.status = 'passed';
    report.migrationCount = candidateNames.length;
    report.fixtureUserId = userId;
    step('full-history-upgrade-and-idempotence-passed', { migrationCount: candidateNames.length, database });
  } finally {
    await db.end().catch(() => {});
    await admin.end().catch(() => {});
  }
}
main().catch(error => {
  report.status = 'failed'; report.error = { code: error.code || error.name, message: error.message };
  console.error(JSON.stringify({ failed: true, code: report.error.code, message: report.error.message })); process.exitCode = 1;
}).finally(() => { report.completedAt = new Date().toISOString(); save(); });

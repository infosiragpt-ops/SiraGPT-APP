#!/usr/bin/env node
'use strict';
// CI-only, isolated BASE→HEAD migration rehearsal. Never app boot/db push/
// migrate resolve. Baseline drift is exposed, not converted into a blanket waiver.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { scanRepository } = require('./check-migration-safety');
const { consistentSnapshot, digest, quoteIdentifier } = require('../tests/phase1-migration-rehearsal.cjs');
const ROOT = path.resolve(__dirname, '..');
const MIGRATION_PATH = 'backend/prisma/migrations';
const PRISMA = path.join(ROOT, 'backend/node_modules/prisma/build/index.js');

function normalizeDrift(sql) {
  // Prisma's generated DDL has stable quoting; split only outside literals,
  // identifiers and dollar bodies. Whitespace/comments are not a schema change.
  const statements = []; let value = ''; let quote = null; let dollar = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]; const next = sql[i + 1];
    if (dollar) {
      if (sql.startsWith(dollar, i)) { value += dollar; i += dollar.length - 1; dollar = null; }
      else value += c;
    } else if (quote) {
      value += c;
      if (c === quote) { if (next === quote) { value += next; i++; } else quote = null; }
    } else if (c === "'" || c === '"') { quote = c; value += c; }
    else if (c === '$' && /^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/.test(sql.slice(i))) {
      dollar = /^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/.exec(sql.slice(i))[0]; value += dollar; i += dollar.length - 1;
    } else if (c === '-' && next === '-') { while (i < sql.length && sql[i] !== '\n') i++; value += ' '; }
    else if (c === '/' && next === '*') { const end = sql.indexOf('*/', i + 2); assert.ok(end >= 0, 'UPGRADE_UNTERMINATED_SQL_COMMENT'); i = end + 1; value += ' '; }
    else if (c === ';') { if (value.trim()) statements.push(value.trim()); value = ''; }
    else if (/\s/.test(c)) { if (value && !value.endsWith(' ')) value += ' '; }
    else value += c;
  }
  assert.ok(!quote && !dollar, 'UPGRADE_UNTERMINATED_SQL_LITERAL');
  if (value.trim()) statements.push(value.trim());
  return statements.sort();
}
function compareDrift(baselineSql, upgradedSql) {
  const baseline = normalizeDrift(baselineSql); const upgraded = normalizeDrift(upgradedSql);
  const remaining = baseline.slice(); const added = [];
  for (const statement of upgraded) {
    const index = remaining.indexOf(statement);
    if (index < 0) added.push(statement); else remaining.splice(index, 1);
  }
  return { baseline, upgraded, added, removed: remaining };
}
function verifyAdditiveUpgrade(before, after) {
  for (const table of before.tables) {
    const current = after.tables.find(row => row.name === table.name);
    assert.ok(current, 'UPGRADE_EXISTING_TABLE_REMOVED');
    if (table.name !== '_prisma_migrations') {
      assert.equal(current.count, table.count, 'UPGRADE_EXISTING_ROW_COUNT_CHANGED');
      assert.equal(current.sha256, table.sha256, 'UPGRADE_EXISTING_DATA_CHANGED');
    }
    for (const oldColumn of table.structure.columns) {
      const column = current.structure.columns.find(row => row.name === oldColumn.name);
      assert.ok(column, 'UPGRADE_EXISTING_COLUMN_REMOVED');
      // Relaxing NOT NULL is additive; changing type/default/identity is not.
      assert.deepEqual({ ...column, notnull: oldColumn.notnull }, oldColumn, 'UPGRADE_EXISTING_COLUMN_CHANGED');
      assert.ok(!column.notnull || oldColumn.notnull, 'UPGRADE_EXISTING_COLUMN_CONSTRAINED');
    }
    for (const index of table.structure.indexes) assert.ok(current.structure.indexes.some(row => JSON.stringify(row) === JSON.stringify(index)), 'UPGRADE_EXISTING_INDEX_CHANGED');
    for (const constraint of table.structure.constraints) {
      // PostgreSQL18 materializes NOT NULL constraints in pg_constraint.
      const relaxed = table.structure.columns.some(column => column.notnull
        && !current.structure.columns.find(row => row.name === column.name)?.notnull
        && [`NOT NULL ${column.name}`, `NOT NULL ${quoteIdentifier(column.name)}`].includes(constraint.definition));
      assert.ok(relaxed || current.structure.constraints.some(row => JSON.stringify(row) === JSON.stringify(constraint)), 'UPGRADE_EXISTING_CONSTRAINT_CHANGED');
    }
  }
  for (const oldEnum of before.enums) assert.ok(after.enums.some(row => JSON.stringify(row) === JSON.stringify(oldEnum)), 'UPGRADE_EXISTING_ENUM_CHANGED');
  assert.deepEqual(after.extensions, before.extensions, 'UPGRADE_EXISTING_EXTENSION_CHANGED');
  assert.deepEqual(after.catalogSha256, before.catalogSha256, 'UPGRADE_EXISTING_ROUTINE_OR_POLICY_CHANGED');
  assert.deepEqual(after.sequences.filter(row => before.sequences.some(old => old.name === row.name)), before.sequences, 'UPGRADE_EXISTING_SEQUENCE_CHANGED');
  assert.deepEqual(after.history.filter(row => before.history.some(old => old.migration_name === row.migration_name)), before.history, 'UPGRADE_EXISTING_HISTORY_CHANGED');
}
function migrationManifest(directory) {
  return Object.fromEntries(fs.readdirSync(directory).sort().filter(name => name !== 'migration_lock.toml').map(name => {
    const entry = path.join(directory, name); assert.ok(fs.lstatSync(entry).isDirectory() && !fs.lstatSync(entry).isSymbolicLink(), 'UPGRADE_UNSAFE_MIGRATION');
    const file = path.join(entry, 'migration.sql'); assert.ok(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(), 'UPGRADE_UNSAFE_SQL');
    return [name, digest(fs.readFileSync(file))];
  }));
}
function verifyHistory(history, manifest) {
  assert.deepEqual(history.map(row => row.migration_name).sort(), Object.keys(manifest).sort(), 'UPGRADE_HISTORY_MISMATCH');
  for (const row of history) { assert.ok(row.finished_at && !row.rolled_back_at, 'UPGRADE_INCOMPLETE_MIGRATION'); assert.equal(row.checksum, manifest[row.migration_name], 'UPGRADE_HISTORY_CHECKSUM'); }
}
function extractPrisma(baseSha, target, root = ROOT) {
  const git = args => execFileSync('git', ['-C', root, ...args], { maxBuffer: 32 * 1024 * 1024 });
  const paths = git(['ls-tree', '-r', '-z', '--name-only', baseSha, '--', 'backend/prisma']).toString().split('\0')
    .filter(file => file === 'backend/prisma/schema.prisma' || file.startsWith(`${MIGRATION_PATH}/`));
  for (const file of paths) { const output = path.join(target, file.slice('backend/prisma/'.length)); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, git(['show', `${baseSha}:${file}`])); }
}
function runPrisma(args, databaseUrl, schema, cwd) {
  const result = spawnSync(process.execPath, [PRISMA, ...args, '--schema', schema], { cwd,
    env: { PATH: process.env.PATH, DATABASE_URL: databaseUrl, NODE_ENV: 'test', CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    timeout: 180_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
  assert.ok(!result.error && !result.signal && result.status === 0, 'UPGRADE_PRISMA_DEPLOY_FAILED');
}
function drift(databaseUrl, schema, cwd) {
  const result = spawnSync(process.execPath, [PRISMA, 'migrate', 'diff', '--from-url', databaseUrl, '--to-schema-datamodel', schema, '--script', '--exit-code'], { cwd,
    env: { PATH: process.env.PATH, DATABASE_URL: databaseUrl, NODE_ENV: 'test', CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    timeout: 90_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
  assert.ok(!result.error && !result.signal && [0, 2].includes(result.status), 'UPGRADE_PRISMA_DIFF_FAILED');
  return result.stdout;
}
async function seedFixtures(db) {
  const owner = 'migration-upgrade-owner';
  await db.query('INSERT INTO users(id,email,name,password,"updatedAt","gemaTokenUsage","docQuotaEpoch") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP,937,3)', [owner, `${owner}@example.invalid`, 'Synthetic upgrade fixture', 'not-a-login-password']);
  await db.query('INSERT INTO chats(id,"userId",title,model,"updatedAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP)', ['migration-chat', owner, 'Preserve conversation', 'synthetic-no-provider']);
  await db.query('INSERT INTO messages(id,"chatId",role,content,metadata) VALUES($1,$2,$3,$4,$5)', ['migration-message', 'migration-chat', 'ASSISTANT', 'Nonempty persistent answer', { artifacts: ['synthetic.txt'], unicode: 'á漢字' }]);
  await db.query('INSERT INTO credits(id,"userId",balance,"reservedBalance","lifetimeGranted","lifetimeSpent") VALUES($1,$2,12345,937,15000,2655)', ['migration-credit', owner]);
  await db.query('INSERT INTO api_usage(id,"userId",model,tokens,cost) VALUES($1,$2,$3,937,0.314159)', ['migration-usage', owner, 'synthetic-no-provider']);
  await db.query('INSERT INTO webhook_endpoints(id,"userId",url,events,secret) VALUES($1,$2,$3,$4,$5)', ['migration-endpoint', owner, 'https://synthetic.example.invalid/hook', ['agent.task.*'], 'synthetic-test-only']);
  // Existing FK enforcement, checked before and after actual deploy.
  return { owner, chat: 'migration-chat', endpoint: 'migration-endpoint' };
}
async function rejectSql(db, sql, args, expected) {
  await assert.rejects(db.query(sql, args), error => error.code === expected, 'UPGRADE_CONSTRAINT_NOT_ENFORCED');
}
async function constraints(db, fixture, tables) {
  await rejectSql(db, 'INSERT INTO messages(id,"chatId",role,content) VALUES($1,$2,$3,$4)', ['orphan-upgrade', 'missing-upgrade-chat', 'USER', 'synthetic'], '23503');
  if (tables.includes('webhook_deliveries')) {
    const sql = 'INSERT INTO webhook_deliveries(id,endpoint_id,endpoint_user_id,url,event,payload,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7)';
    await rejectSql(db, sql, ['missing-endpoint-delivery', 'missing-endpoint', fixture.owner, 'https://synthetic.example.invalid/hook', 'test', '{}', 'missing-endpoint-key'], '23503');
    await db.query(sql, ['upgrade-outbox', fixture.endpoint, fixture.owner, 'https://synthetic.example.invalid/hook', 'test', '{}', 'upgrade-key']);
    await rejectSql(db, sql, ['upgrade-duplicate', fixture.endpoint, fixture.owner, 'https://synthetic.example.invalid/hook', 'test', '{}', 'upgrade-key'], '23505');
    await rejectSql(db, "UPDATE webhook_deliveries SET status='invalid' WHERE id='upgrade-outbox'", [], '23514');
  }
  if (tables.includes('media_jobs')) {
    const sql = "INSERT INTO media_jobs(id,user_id,lane,kind,idempotency_key,payload_hash,payload) VALUES($1,$2,'image','image',$3,$4,'{}')";
    await rejectSql(db, sql, ['missing-owner-media', 'missing-owner', 'missing-owner-key', 'a'.repeat(64)], '23503');
    await db.query(sql, ['upgrade-media', fixture.owner, 'upgrade-media-key', 'a'.repeat(64)]);
    await rejectSql(db, sql, ['upgrade-media-duplicate', fixture.owner, 'upgrade-media-key', 'a'.repeat(64)], '23505');
    await rejectSql(db, "UPDATE media_jobs SET progress=101 WHERE id='upgrade-media'", [], '23514');
  }
}
async function runUpgrade({ baseRef, adminUrl, artifacts, root = ROOT } = {}) {
  const target = new URL(adminUrl);
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname), 'UPGRADE_TEST_LOOPBACK_ONLY');
  assert.ok(!target.search || target.searchParams.get('schema') === 'public', 'UPGRADE_TEST_PUBLIC_SCHEMA_ONLY');
  const safety = scanRepository(baseRef, { root });
  assert.ok(safety.baseRef && !safety.findings.length, 'UPGRADE_STATIC_SAFETY_FAILED');
  fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-upgrade-'));
  const base = path.join(workspace, 'base'); const head = path.join(workspace, 'head'); fs.mkdirSync(base); fs.mkdirSync(head);
  extractPrisma(safety.baseRef, base, root);
  fs.copyFileSync(path.join(root, 'backend/prisma/schema.prisma'), path.join(head, 'schema.prisma'));
  fs.cpSync(path.join(root, MIGRATION_PATH), path.join(head, 'migrations'), { recursive: true, dereference: false });
  const baseManifest = migrationManifest(path.join(base, 'migrations')); const headManifest = migrationManifest(path.join(head, 'migrations'));
  const database = `sira_upgrade_${crypto.randomBytes(8).toString('hex')}`;
  const { Client } = require(path.join(root, 'backend/node_modules/pg'));
  const admin = new Client({ connectionString: target.toString(), connectionTimeoutMillis: 10_000 });
  try { await admin.connect(); await admin.query(`CREATE DATABASE ${quoteIdentifier(database)}`); } finally { await admin.end(); }
  target.pathname = `/${database}`; target.search = ''; const databaseUrl = target.toString();
  const db = new Client({ connectionString: databaseUrl, application_name: 'siragpt-ci-migration-upgrade', connectionTimeoutMillis: 10_000, query_timeout: 65_000, statement_timeout: 60_000 });
  const report = { baseRef: safety.baseRef, database, baseMigrations: Object.keys(baseManifest).length, headMigrations: Object.keys(headManifest).length,
    sourceSchemaSha256: digest(fs.readFileSync(path.join(head, 'schema.prisma'))), noDbPush: true, noApplicationStarted: true, providerRequests: 0,
    baselineDriftIsNotDeploymentApproval: true, publisherSchemaGateUnchanged: true, startedAt: new Date().toISOString() };
  try {
    await db.connect();
    await db.query(`ALTER DATABASE ${quoteIdentifier(database)} SET lock_timeout='5s'`);
    await db.query(`ALTER DATABASE ${quoteIdentifier(database)} SET statement_timeout='60s'`);
    runPrisma(['migrate', 'deploy'], databaseUrl, path.join(base, 'schema.prisma'), base);
    const fixture = await seedFixtures(db); await constraints(db, fixture, []);
    const before = await consistentSnapshot(db); verifyHistory(before.history, baseManifest);
    const baselineSql = drift(databaseUrl, path.join(base, 'schema.prisma'), base);
    fs.writeFileSync(path.join(artifacts, 'baseline-drift.sql'), baselineSql, { mode: 0o600 });
    fs.writeFileSync(path.join(artifacts, 'baseline-snapshot.json'), JSON.stringify(before, null, 2), { mode: 0o600 });
    runPrisma(['migrate', 'deploy'], databaseUrl, path.join(head, 'schema.prisma'), head);
    const columns = Object.fromEntries(before.tables.map(table => [table.name, table.structure.columns.map(column => column.name)]));
    const after = await consistentSnapshot(db, false, columns); verifyHistory(after.history, headManifest);
    fs.writeFileSync(path.join(artifacts, 'upgraded-snapshot.json'), JSON.stringify(after, null, 2), { mode: 0o600 });
    verifyAdditiveUpgrade(before, after); report.preservedExistingRowsAndStructure = true;
    const upgradedSql = drift(databaseUrl, path.join(head, 'schema.prisma'), head);
    fs.writeFileSync(path.join(artifacts, 'upgraded-drift.sql'), upgradedSql, { mode: 0o600 });
    const changes = compareDrift(baselineSql, upgradedSql);
    report.drift = { baselineStatements: changes.baseline.length, upgradedStatements: changes.upgraded.length,
      newOrChanged: changes.added, removed: changes.removed, baselineSha256: digest(baselineSql), upgradedSha256: digest(upgradedSql) };
    assert.equal(changes.added.length, 0, 'UPGRADE_NEW_OR_CHANGED_SCHEMA_DRIFT');
    await constraints(db, fixture, after.tables.map(table => table.name)); report.constraintsVerified = true;
    const committed = await consistentSnapshot(db);
    runPrisma(['migrate', 'deploy'], databaseUrl, path.join(head, 'schema.prisma'), head);
    assert.deepEqual(await consistentSnapshot(db), committed, 'UPGRADE_SECOND_DEPLOY_CHANGED_DATA'); report.idempotentDeploy = true;
    report.status = 'passed'; report.completedAt = new Date().toISOString();
  } catch (error) { report.status = 'failed'; report.code = /^UPGRADE_[A-Z_]+/.exec(error.message || '')?.[0] || 'UPGRADE_FAILED'; throw error; }
  finally { fs.writeFileSync(path.join(artifacts, 'upgrade-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 }); await db.end(); }
  return report;
}
if (require.main === module) {
  const argv = process.argv.slice(2); const get = name => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  runUpgrade({ baseRef: get('base-ref'), adminUrl: process.env.DOC_SANDBOX_TEST_DATABASE_URL || process.env.DATABASE_URL,
    artifacts: path.resolve(get('artifacts') || path.join(ROOT, 'migration-upgrade-artifacts')) })
    .then(report => console.log(JSON.stringify({ status: report.status, baseMigrations: report.baseMigrations, headMigrations: report.headMigrations,
      preservedExistingRowsAndStructure: report.preservedExistingRowsAndStructure, drift: { baseline: report.drift.baselineStatements, upgraded: report.drift.upgradedStatements, new: report.drift.newOrChanged.length },
      publisherSchemaGateUnchanged: true })))
    .catch(error => { console.error(JSON.stringify({ status: 'failed', code: /^UPGRADE_[A-Z_]+/.exec(error.message || '')?.[0] || 'UPGRADE_FAILED' })); process.exitCode = 1; });
}
module.exports = { normalizeDrift, compareDrift, verifyAdditiveUpgrade, migrationManifest, verifyHistory, extractPrisma, runUpgrade };

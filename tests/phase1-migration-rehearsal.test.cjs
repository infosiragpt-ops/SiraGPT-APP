'use strict';
// Pure guard tests only. These are NOT pg_dump/restore/Prisma execution evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { MIGRATION, SQL_SHA256, HOST, NEW_TABLES, options, connection, manifest, sourceAttestation, verifySourceAttestation, verifyHistory, verifyUpgrade, digest, quoteIdentifier } = require('./phase1-migration-rehearsal.cjs');
const valid = ['--phase=baseline', '--database=doc_sandbox_rehearsal_' + 'a'.repeat(32), '--candidate-sha=' + 'b'.repeat(40), '--backup-sha256=' + 'c'.repeat(64), '--source-manifest-sha256=' + 'd'.repeat(64)];
test('requires explicit phase, random scoped database and full source identities', () => {
  assert.equal(options(valid).phase, 'baseline');
  for (const phase of ['upgrade', 'recovered']) assert.equal(options([`--phase=${phase}`, ...valid.slice(1)]).phase, phase);
  for (let index = 0; index < valid.length; index++) assert.throws(() => options(valid.filter((_, current) => index !== current)));
  assert.throws(() => options([...valid, '--phase=upgrade']));
  assert.throws(() => options([...valid, '--url=postgresql://production']));
  assert.throws(() => options(['--phase=deploy', ...valid.slice(1)]));
});
test('connection cannot accept production URL, other host, db or SQL identifier injection', () => {
  const result = connection('doc_sandbox_rehearsal_' + 'a'.repeat(32));
  assert.equal(result.host, HOST); assert.equal(result.user, 'doc_fixture');
  for (const value of ['iliagpt', 'postgres', 'doc_sandbox_rehearsal_', 'postgresql://prod/db', 'doc_sandbox_rehearsal_' + 'A'.repeat(32), 'doc_sandbox_rehearsal_' + 'a'.repeat(32) + ';DROP DATABASE production']) assert.throws(() => connection(value));
  assert.equal(quoteIdentifier('safe"name'), '"safe""name"');
});
test('real repository manifest pins the exact SQL and keeps all historical migrations', () => {
  const result = manifest(path.join(__dirname, '../backend/prisma/migrations'));
  assert.equal(result[MIGRATION], SQL_SHA256); assert.ok(Object.keys(result).length > 100);
});
test('source attestation compares real checked-out bytes to the exact git candidate', () => {
  const repository = path.join(__dirname, '..');
  const git = spawnSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  assert.equal(git.status, 0); const sha = git.stdout.trim();
  const proof = sourceAttestation(repository, sha);
  verifySourceAttestation(proof, sha, repository);
  assert.throws(() => verifySourceAttestation({ ...proof, candidateSha: 'a'.repeat(40) }, sha, repository), /REHEARSAL_SOURCE_COMMIT_MISMATCH/);
  assert.throws(() => verifySourceAttestation({ ...proof, harnessSha256: '0'.repeat(64) }, sha, repository), /REHEARSAL_HARNESS_CHANGED/);
  const changed = structuredClone(proof); changed.hashes['backend/prisma/schema.prisma'] = '0'.repeat(64);
  assert.throws(() => verifySourceAttestation(changed, sha, repository), /REHEARSAL_SOURCE_BYTES_CHANGED/);
});
test('manifest fails for altered SQL, unrecognized directories and symlinked SQL', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-migration-guards-'));
  try {
    fs.mkdirSync(path.join(directory, MIGRATION));
    fs.writeFileSync(path.join(directory, MIGRATION, 'migration.sql'), 'SELECT 1;');
    assert.throws(() => manifest(directory), /REHEARSAL_PHASE1_SQL_CHANGED/);
    fs.mkdirSync(path.join(directory, 'unknown-migration'));
    assert.throws(() => manifest(directory), /REHEARSAL_MIGRATION_NAME/);
    fs.rmdirSync(path.join(directory, 'unknown-migration'));
    fs.unlinkSync(path.join(directory, MIGRATION, 'migration.sql'));
    fs.symlinkSync(path.join(__dirname, '../backend/prisma/migrations', MIGRATION, 'migration.sql'), path.join(directory, MIGRATION, 'migration.sql'));
    assert.throws(() => manifest(directory), /REHEARSAL_REGULAR_FILE_REQUIRED/);
  } finally { fs.rmSync(directory, { recursive: true }); }
});
const source = { '20260101000000_base': digest(Buffer.from('base')), [MIGRATION]: SQL_SHA256 };
const row = { migration_name: '20260101000000_base', checksum: source['20260101000000_base'], finished_at: '2026-09-05', rolled_back_at: null };
test('restored history must contain exactly every predecessor once and no F1 yet', () => {
  verifyHistory([row], source, false);
  for (const rows of [[], [row, row], [{ ...row, migration_name: '20260101000000_unknown' }], [{ ...row, checksum: 'f'.repeat(64) }], [{ ...row, finished_at: null }], [{ ...row, rolled_back_at: '2026-09-05' }]]) assert.throws(() => verifyHistory(rows, source, false));
  const upgraded = [row, { ...row, migration_name: MIGRATION, checksum: SQL_SHA256 }];
  verifyHistory(upgraded, source, true);
  assert.throws(() => verifyHistory(upgraded, source, false));
});
function table(name) { return { name, count: 1, sha256: 'a'.repeat(64), structure: { columns: [{ name: 'id', type: 'text' }], indexes: [], constraints: [] } }; }
function snapshots() {
  const before = { tables: [table('_prisma_migrations'), table('users')], sequences: [{ name: 'x', last_value: '12', is_called: true }], enums: ['A'], extensions: ['vector'], catalogSha256: 'e'.repeat(64), history: [row] };
  const after = structuredClone(before);
  after.tables.push(...NEW_TABLES.map(table)); after.tables[0].count++;
  after.history.push({ ...row, migration_name: MIGRATION, checksum: SQL_SHA256 });
  return { before, after };
}
test('upgrade allows only the three F1 tables and the reviewed history addition', () => {
  const { before, after } = snapshots(); verifyUpgrade(before, after);
});
for (const [name, mutate] of [
  ['existing row changed', value => { value.tables[1].sha256 = 'b'.repeat(64); }],
  ['existing row deleted', value => { value.tables[1].count--; }],
  ['old column changed', value => { value.tables[1].structure.columns[0].type = 'integer'; }],
  ['unreviewed table added', value => { value.tables.push(table('another_feature')); }],
  ['old table removed', value => { value.tables.splice(1, 1); }],
  ['sequence reset', value => { value.sequences[0].last_value = '1'; }],
  ['enum changed', value => { value.enums.push('B'); }],
  ['extension removed', value => { value.extensions.pop(); }],
  ['routine or trigger changed', value => { value.catalogSha256 = 'f'.repeat(64); }],
  ['old history rewritten', value => { value.history[0].checksum = 'd'.repeat(64); }],
]) test(`preservation comparison rejects ${name}`, () => {
  const { before, after } = snapshots(); mutate(after); assert.throws(() => verifyUpgrade(before, after));
});

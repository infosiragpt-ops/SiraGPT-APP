// Tests for scripts/check-migration-safety.js (cycle 34)
// Uses the exported scanFile() against on-the-fly tmp SQL files.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scanFile } = require('../../scripts/check-migration-safety.js');

function writeTmp(sql) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migsafety-'));
  const file = path.join(dir, 'migration.sql');
  fs.writeFileSync(file, sql);
  return file;
}

test('flags DROP TABLE', () => {
  const f = writeTmp('DROP TABLE "User";');
  const findings = scanFile(f);
  assert.ok(findings.some((x) => x.ruleId === 'drop-table'));
});

test('flags DROP COLUMN', () => {
  const f = writeTmp('ALTER TABLE "User" DROP COLUMN "legacyField";');
  const findings = scanFile(f);
  assert.ok(findings.some((x) => x.ruleId === 'drop-column'));
});

test('flags ALTER COLUMN TYPE', () => {
  const f = writeTmp('ALTER TABLE "User" ALTER COLUMN "age" TYPE BIGINT;');
  const findings = scanFile(f);
  assert.ok(findings.some((x) => x.ruleId === 'alter-type'));
});

test('flags SET NOT NULL without DEFAULT', () => {
  const f = writeTmp('ALTER TABLE "User" ALTER COLUMN "email" SET NOT NULL;');
  const findings = scanFile(f);
  assert.ok(findings.some((x) => x.ruleId === 'set-not-null-no-default'));
});

test('does NOT flag SET NOT NULL when DEFAULT present in same statement', () => {
  const f = writeTmp('ALTER TABLE "User" ALTER COLUMN "email" SET DEFAULT \'\' , ALTER COLUMN "email" SET NOT NULL;');
  // The simple scanner treats the whole statement as containing DEFAULT — accept that.
  const findings = scanFile(f);
  assert.ok(!findings.some((x) => x.ruleId === 'set-not-null-no-default'));
});

test('allow-destructive marker silences DROP COLUMN', () => {
  const f = writeTmp(
    '-- migration-safety: allow-destructive reason="planned drop"\nALTER TABLE "User" DROP COLUMN "x";',
  );
  const findings = scanFile(f);
  assert.ok(!findings.some((x) => x.ruleId === 'drop-column'));
});

test('RENAME COLUMN flagged as two-phase', () => {
  const f = writeTmp('ALTER TABLE "User" RENAME COLUMN "a" TO "b";');
  const findings = scanFile(f);
  assert.ok(findings.some((x) => x.ruleId === 'rename-column' && x.severity === 'two-phase'));
});

test('allow-rename marker silences rename two-phase rule', () => {
  const f = writeTmp(
    '-- migration-safety: allow-rename reason="phase 1 dual-write done"\nALTER TABLE "User" RENAME COLUMN "a" TO "b";',
  );
  const findings = scanFile(f);
  assert.ok(!findings.some((x) => x.ruleId === 'rename-column'));
});

test('clean additive migration produces no findings', () => {
  const f = writeTmp('ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "newField" TEXT;');
  const findings = scanFile(f);
  assert.deepStrictEqual(findings, []);
});

test('flags credential hashes in migration SQL', () => {
  const f = writeTmp("SELECT '$2b$12$fixture-only-not-a-real-hash';");
  const findings = scanFile(f);
  assert.ok(findings.some((x) => x.ruleId === 'credential-hash-literal' && x.severity === 'forbidden'));
});

test('flags user password mutations without a literal hash', () => {
  const f = writeTmp('UPDATE "users" SET "password" = current_setting(\'app.bootstrap_password\');');
  const findings = scanFile(f);
  assert.ok(findings.some((x) => x.ruleId === 'user-password-dml' && x.severity === 'forbidden'));
});

const { execFileSync } = require('node:child_process');
const { scanRepository } = require('../../scripts/check-migration-safety');
function historyFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-history-'));
  const old = path.join(root, 'backend/prisma/migrations/20260101000000_base/migration.sql');
  fs.mkdirSync(path.dirname(old), { recursive: true }); fs.writeFileSync(old, 'CREATE TABLE immutable_history(id TEXT);');
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Migration test', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  return { root, old };
}
test('base-ref scans actual new SQL only, while immutable historical changes cannot be overridden', () => {
  const { root, old } = historyFixture();
  const next = path.join(root, 'backend/prisma/migrations/20260102000000_new/migration.sql');
  fs.mkdirSync(path.dirname(next)); fs.writeFileSync(next, 'ALTER TABLE immutable_history ADD COLUMN optional TEXT;');
  assert.equal(scanRepository('HEAD', { root }).files.length, 1);
  assert.deepStrictEqual(scanRepository('HEAD', { root }).findings, []);
  fs.appendFileSync(old, '\n-- migration-safety: allow-destructive reason="not valid for history"');
  assert.ok(scanRepository('HEAD', { root }).findings.some(row => row.ruleId === 'migration-history-mutated' && row.severity === 'forbidden'));
  fs.unlinkSync(old);
  assert.ok(scanRepository('HEAD', { root }).findings.some(row => row.ruleId === 'migration-history-mutated'));
});
test('base-ref rejects newly destructive or backdated migrations', () => {
  const { root } = historyFixture();
  const next = path.join(root, 'backend/prisma/migrations/20250101000000_backdated/migration.sql');
  fs.mkdirSync(path.dirname(next)); fs.writeFileSync(next, 'TRUNCATE immutable_history;');
  const findings = scanRepository('HEAD', { root }).findings;
  assert.ok(findings.some(row => row.ruleId === 'migration-history-backdated'));
  assert.ok(findings.some(row => row.ruleId === 'truncate-data'));
});
test('adding required columns without backfill/default is unsafe on populated tables', () => {
  assert.ok(scanFile(writeTmp('ALTER TABLE users ADD COLUMN required TEXT NOT NULL;')).some(row => row.ruleId === 'add-required-no-default'));
});

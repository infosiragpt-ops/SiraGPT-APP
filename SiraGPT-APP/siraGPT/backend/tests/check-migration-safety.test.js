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

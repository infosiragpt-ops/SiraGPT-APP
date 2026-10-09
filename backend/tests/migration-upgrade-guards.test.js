'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDrift, compareDrift, verifyAdditiveUpgrade } = require('../../scripts/check-migration-upgrade.cjs');

test('drift comparison is statement-aware, preserves literals and fails any new/changed SQL', () => {
  const old = `-- comment\nALTER TABLE "users" ADD COLUMN "x" TEXT DEFAULT 'a;  b';\nCREATE INDEX "x" ON "users"("x");`;
  const same = `CREATE INDEX "x" ON "users"("x"); /* formatting */ ALTER   TABLE "users" ADD COLUMN "x" TEXT DEFAULT 'a;  b';`;
  assert.deepEqual(compareDrift(old, same).added, []);
  assert.equal(normalizeDrift(old).length, 2);
  const changed = same.replace("'a;  b'", "'a; b'");
  assert.equal(compareDrift(old, changed).added.length, 1);
  assert.equal(compareDrift(old, same + 'DROP TABLE users;').added.length, 1);
  assert.equal(compareDrift(old, '').removed.length, 2);
});
function baseline() {
  return { tables: [{ name: 'users', count: 1, sha256: 'rows-unchanged', structure: {
    columns: [{ name: 'id', type: 'text', notnull: true, default: null, identity: '', generated: '' }],
    indexes: [{ indexdef: 'CREATE UNIQUE INDEX users_pk ON users(id)' }], constraints: [{ conname: 'users_pk', definition: 'PRIMARY KEY(id)' }],
  } }], enums: [], extensions: [{ extname: 'plpgsql' }], catalogSha256: 'catalog', sequences: [], history: [] };
}
test('upgrade preserves projected existing values/FKs while accepting additive columns and relaxed NOT NULL', () => {
  const before = baseline(); const after = structuredClone(before);
  after.tables[0].structure.columns[0].notnull = false;
  after.tables[0].structure.columns.push({ name: 'optional', type: 'text', notnull: false });
  assert.doesNotThrow(() => verifyAdditiveUpgrade(before, after));
  const changed = structuredClone(after); changed.tables[0].sha256 = 'lost-or-mutated-row';
  assert.throws(() => verifyAdditiveUpgrade(before, changed), /UPGRADE_EXISTING_DATA_CHANGED/);
  changed.tables[0].sha256 = before.tables[0].sha256; changed.tables[0].structure.constraints = [];
  assert.throws(() => verifyAdditiveUpgrade(before, changed), /UPGRADE_EXISTING_CONSTRAINT_CHANGED/);
  changed.tables[0].structure.constraints = before.tables[0].structure.constraints; changed.tables[0].structure.columns[0].type = 'integer';
  assert.throws(() => verifyAdditiveUpgrade(before, changed), /UPGRADE_EXISTING_COLUMN_CHANGED/);
});

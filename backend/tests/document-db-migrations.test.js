'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-db-migrations');
const { extractDbMigrations, buildDbMigrationsForFiles, renderDbMigrationsBlock, _internal } = engine;
const { classifyMigration } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractDbMigrations('').total, 0);
  assert.equal(extractDbMigrations(null).total, 0);
});

test('classifyMigration: flyway', () => {
  assert.equal(classifyMigration('V001__init.sql'), 'flyway');
});

test('detects Flyway migration', () => {
  const r = extractDbMigrations('Apply V001__create_users.sql');
  assert.ok(r.entries.some((e) => e.framework === 'flyway'));
});

test('detects Rails migration', () => {
  const r = extractDbMigrations('Run db/migrate/20240115120000_create_users.rb');
  assert.ok(r.entries.some((e) => e.framework === 'rails'));
});

test('detects Knex.js migration', () => {
  const r = extractDbMigrations('migrations/20240115120000_add_index.js');
  assert.ok(r.entries.some((e) => /knex/.test(e.framework)));
});

test('detects Django migration', () => {
  const r = extractDbMigrations('0001_initial.py created');
  assert.ok(r.entries.some((e) => e.framework === 'django'));
});

test('detects Goose migration', () => {
  const r = extractDbMigrations('001_create_users.up.sql executed');
  assert.ok(r.entries.some((e) => e.framework === 'goose'));
});

test('detects Alembic migration', () => {
  const r = extractDbMigrations('abc123def456_add_column.py');
  assert.ok(r.entries.some((e) => e.framework === 'alembic'));
});

test('detects Prisma migration', () => {
  const r = extractDbMigrations('20240115120000_init/migration.sql');
  assert.ok(r.entries.some((e) => e.framework === 'prisma'));
});

test('detects Sqitch deploy file', () => {
  const r = extractDbMigrations('deploy/create_users.sql in sqitch project');
  assert.ok(r.entries.some((e) => e.framework === 'squitch'));
});

test('dedupes identical entries', () => {
  const r = extractDbMigrations('V001__init.sql and V001__init.sql');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 1; i <= 25; i++) text += `V${i.toString().padStart(3, '0')}__name${i}.sql `;
  const r = extractDbMigrations(text);
  assert.ok(r.entries.length <= 20);
});

test('counts totals by framework', () => {
  const r = extractDbMigrations(`
    V001__init.sql
    20240115120000_create.rb
    0001_initial.py
  `);
  assert.ok(r.totals.flyway >= 1);
  assert.ok(r.totals.rails >= 1);
  assert.ok(r.totals.django >= 1);
});

test('buildDbMigrationsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'V001__init.sql' },
    { name: 'b', extractedText: '20240115120000_create.rb' },
  ];
  const r = buildDbMigrationsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderDbMigrationsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'migrations.md', extractedText: 'V001__init.sql' }];
  const r = buildDbMigrationsForFiles(files);
  const md = renderDbMigrationsBlock(r);
  assert.match(md, /^## DATABASE MIGRATION/);
});

test('renderDbMigrationsBlock empty when nothing surfaces', () => {
  assert.equal(renderDbMigrationsBlock({ perFile: [] }), '');
  assert.equal(renderDbMigrationsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildDbMigrationsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'V001__init.sql' },
  ]);
  assert.equal(r.perFile.length, 1);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-sql');
const { extractSql, buildSqlForFiles, renderSqlBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractSql('').total, 0);
  assert.equal(extractSql(null).total, 0);
});

test('detects CREATE TABLE', () => {
  const r = extractSql('CREATE TABLE users (id SERIAL PRIMARY KEY);');
  assert.ok(r.statements.some((s) => s.type === 'CREATE TABLE' && s.table === 'users'));
  assert.equal(r.byKind.ddl, 1);
});

test('detects CREATE INDEX', () => {
  const r = extractSql('CREATE UNIQUE INDEX idx_users_email ON users (email);');
  assert.ok(r.statements.some((s) => s.type === 'CREATE INDEX'));
});

test('detects ALTER TABLE', () => {
  const r = extractSql('ALTER TABLE orders ADD COLUMN status TEXT;');
  assert.ok(r.statements.some((s) => s.type === 'ALTER TABLE' && s.table === 'orders'));
});

test('detects DROP TABLE IF EXISTS', () => {
  const r = extractSql('DROP TABLE IF EXISTS old_data;');
  assert.ok(r.statements.some((s) => s.type === 'DROP TABLE' && s.table === 'old_data'));
});

test('detects INSERT INTO', () => {
  const r = extractSql('INSERT INTO orders (id, status) VALUES (1, \'pending\');');
  assert.ok(r.statements.some((s) => s.type === 'INSERT INTO' && s.table === 'orders'));
  assert.equal(r.byKind.dml, 1);
});

test('detects UPDATE table SET', () => {
  const r = extractSql('UPDATE users SET active = true WHERE id = 1;');
  assert.ok(r.statements.some((s) => s.type === 'UPDATE' && s.table === 'users'));
});

test('detects DELETE FROM', () => {
  const r = extractSql('DELETE FROM sessions WHERE expired_at < NOW();');
  assert.ok(r.statements.some((s) => s.type === 'DELETE FROM' && s.table === 'sessions'));
});

test('detects MERGE INTO', () => {
  const r = extractSql('MERGE INTO target USING source ON target.id = source.id WHEN MATCHED THEN UPDATE SET ...');
  assert.ok(r.statements.some((s) => s.type === 'MERGE INTO' && s.table === 'target'));
});

test('detects TRUNCATE', () => {
  const r = extractSql('TRUNCATE TABLE logs;');
  assert.ok(r.statements.some((s) => s.type === 'TRUNCATE' && s.table === 'logs'));
});

test('detects SELECT FROM', () => {
  const r = extractSql('SELECT id, email FROM users WHERE active = true;');
  assert.ok(r.statements.some((s) => s.type === 'SELECT FROM' && s.table === 'users'));
  assert.equal(r.byKind.dql, 1);
});

test('detects GRANT', () => {
  const r = extractSql('GRANT SELECT, INSERT ON orders TO app_user;');
  assert.ok(r.statements.some((s) => s.type === 'GRANT' && s.table === 'orders'));
});

test('detects REVOKE', () => {
  const r = extractSql('REVOKE DELETE ON orders FROM app_user;');
  assert.ok(r.statements.some((s) => s.type === 'REVOKE' && s.table === 'orders'));
});

test('detects BEGIN / COMMIT / ROLLBACK TCL', () => {
  const r = extractSql('BEGIN;\nUPDATE users SET x = 1;\nCOMMIT;');
  assert.ok(r.statements.some((s) => s.type === 'BEGIN'));
  assert.ok(r.statements.some((s) => s.type === 'COMMIT'));
  assert.ok(r.byKind.tcl >= 2);
});

test('handles schema-qualified table names', () => {
  const r = extractSql('CREATE TABLE public.users (id INT);');
  assert.ok(r.statements.some((s) => s.table === 'public.users'));
});

test('handles quoted identifiers', () => {
  const r = extractSql('CREATE TABLE "weird_name" (id INT);');
  assert.ok(r.statements.some((s) => s.table === 'weird_name'));
});

test('detects CREATE VIEW', () => {
  const r = extractSql('CREATE OR REPLACE VIEW active_users AS SELECT * FROM users WHERE active;');
  assert.ok(r.statements.some((s) => s.type === 'CREATE VIEW'));
});

test('caps statements per file', () => {
  let text = '';
  for (let i = 0; i < 35; i++) text += `INSERT INTO log_${i} VALUES (1);\n`;
  const r = extractSql(text);
  assert.ok(r.statements.length <= 24);
});

test('dedupes identical type+table pairs', () => {
  const r = extractSql('SELECT * FROM users; SELECT id FROM users;');
  assert.equal(r.statements.filter((s) => s.type === 'SELECT FROM' && s.table === 'users').length, 1);
});

test('buildSqlForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'CREATE TABLE foo (id INT);' },
    { name: 'b.md', extractedText: 'INSERT INTO bar VALUES (1);' },
  ];
  const r = buildSqlForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderSqlBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'CREATE TABLE foo (id INT);' }];
  const r = buildSqlForFiles(files);
  const md = renderSqlBlock(r);
  assert.match(md, /^## SQL STATEMENTS/);
});

test('renderSqlBlock includes by-kind breakdown', () => {
  const files = [{ name: 'doc.md', extractedText: 'CREATE TABLE foo (id INT); INSERT INTO foo VALUES (1);' }];
  const r = buildSqlForFiles(files);
  const md = renderSqlBlock(r);
  assert.match(md, /By kind/);
});

test('renderSqlBlock empty when nothing surfaces', () => {
  assert.equal(renderSqlBlock({ perFile: [] }), '');
  assert.equal(renderSqlBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildSqlForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'CREATE TABLE x (id INT);' },
  ]);
  assert.equal(r.perFile.length, 1);
});

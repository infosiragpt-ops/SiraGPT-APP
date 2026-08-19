'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-sql-windows');
const { extractSqlWindows, buildSqlWindowsForFiles, renderSqlWindowsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractSqlWindows('').total, 0);
  assert.equal(extractSqlWindows(null).total, 0);
});

test('detects ROW_NUMBER()', () => {
  const r = extractSqlWindows('SELECT ROW_NUMBER() OVER (ORDER BY id) FROM users');
  assert.ok(r.entries.some((e) => e.kind === 'windowFn' && e.name === 'ROW_NUMBER'));
});

test('detects RANK() / DENSE_RANK()', () => {
  const r = extractSqlWindows('RANK() OVER (...) and DENSE_RANK() OVER (...)');
  assert.ok(r.entries.filter((e) => e.kind === 'windowFn').length >= 2);
});

test('detects LAG / LEAD', () => {
  const r = extractSqlWindows('LAG(x, 1) OVER (ORDER BY t) AS prev_x');
  assert.ok(r.entries.some((e) => e.name === 'LAG'));
});

test('detects OVER (PARTITION BY ...)', () => {
  const r = extractSqlWindows('SUM(x) OVER (PARTITION BY group_id ORDER BY t)');
  assert.ok(r.entries.some((e) => e.kind === 'over'));
});

test('detects CTE WITH name AS (...)', () => {
  const r = extractSqlWindows('WITH ranked AS (SELECT * FROM users)');
  assert.ok(r.entries.some((e) => e.kind === 'cte' && e.name === 'ranked'));
});

test('detects WITH RECURSIVE', () => {
  const r = extractSqlWindows('WITH RECURSIVE tree AS (SELECT ...)');
  assert.ok(r.entries.some((e) => e.kind === 'cte' && e.name === 'tree'));
});

test('detects aggregate with OVER', () => {
  const r = extractSqlWindows('SUM(amount) OVER (PARTITION BY user_id) AS total_per_user');
  assert.ok(r.entries.some((e) => e.kind === 'aggregate'));
});

test('detects ROWS BETWEEN frame', () => {
  const r = extractSqlWindows('ROWS BETWEEN 1 PRECEDING AND CURRENT ROW');
  assert.ok(r.entries.some((e) => e.kind === 'frame'));
});

test('detects RANGE BETWEEN frame', () => {
  const r = extractSqlWindows('RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW');
  assert.ok(r.entries.some((e) => e.kind === 'frame'));
});

test('dedupes identical entries', () => {
  const r = extractSqlWindows('ROW_NUMBER() OVER (ORDER BY id) and ROW_NUMBER() OVER (ORDER BY x)');
  assert.equal(r.entries.filter((e) => e.kind === 'windowFn' && e.name === 'ROW_NUMBER').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `WITH cte_${i} AS (SELECT 1)\n`;
  const r = extractSqlWindows(text);
  assert.ok(r.entries.length <= 18);
});

test('counts totals by kind', () => {
  const r = extractSqlWindows(
    'WITH x AS (SELECT ROW_NUMBER() OVER (ORDER BY id) FROM t)'
  );
  assert.ok(r.totals.windowFn >= 1);
  assert.ok(r.totals.over >= 1);
  assert.ok(r.totals.cte >= 1);
});

test('buildSqlWindowsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.sql', extractedText: 'ROW_NUMBER() OVER (ORDER BY id)' },
    { name: 'b.sql', extractedText: 'WITH x AS (SELECT 1)' },
  ];
  const r = buildSqlWindowsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderSqlWindowsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'query.sql', extractedText: 'ROW_NUMBER() OVER (ORDER BY id)' }];
  const r = buildSqlWindowsForFiles(files);
  const md = renderSqlWindowsBlock(r);
  assert.match(md, /^## SQL WINDOW/);
});

test('renderSqlWindowsBlock empty when nothing surfaces', () => {
  assert.equal(renderSqlWindowsBlock({ perFile: [] }), '');
  assert.equal(renderSqlWindowsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildSqlWindowsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'ROW_NUMBER() OVER (ORDER BY id)' },
  ]);
  assert.equal(r.perFile.length, 1);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-tables');
const { extractTables, buildTablesForFiles, renderTablesBlock, _internal } = engine;
const { parseRow, findCaption } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractTables('').total, 0);
  assert.equal(extractTables(null).total, 0);
});

test('parseRow strips outer pipes and trims cells', () => {
  assert.deepEqual(parseRow('| a | b | c |'), ['a', 'b', 'c']);
});

test('findCaption picks a preceding **bold** line', () => {
  const before = 'Some intro.\n\n**Quarterly results**\n';
  assert.equal(findCaption(before), 'Quarterly results');
});

test('findCaption picks a "Table N:" line', () => {
  const before = 'Lorem ipsum.\nTable 1: Headcount by region\n';
  assert.match(findCaption(before), /Headcount by region/);
});

test('extracts a single markdown table with header + separator + body', () => {
  const text = `| col1 | col2 |
| --- | --- |
| a | 1 |
| b | 2 |`;
  const r = extractTables(text);
  assert.equal(r.tables.length, 1);
  assert.deepEqual(r.tables[0].header, ['col1', 'col2']);
  assert.deepEqual(r.tables[0].rows, [['a', '1'], ['b', '2']]);
});

test('captures table caption from preceding heading', () => {
  const text = `### Q1 metrics
| region | revenue |
| --- | --- |
| EMEA | 100 |
| APAC | 200 |`;
  const r = extractTables(text);
  assert.equal(r.tables.length, 1);
  assert.match(r.tables[0].caption, /Q1 metrics/);
});

test('limits preview rows to MAX_ROWS_PREVIEW', () => {
  const head = '| h1 |\n| --- |\n';
  let body = '';
  for (let i = 0; i < 12; i++) body += `| row${i} |\n`;
  const r = extractTables(head + body);
  assert.equal(r.tables.length, 1);
  assert.ok(r.tables[0].rows.length <= 5);
  assert.ok(r.tables[0].rowCount >= 10);
});

test('caps tables per file', () => {
  let text = '';
  for (let i = 0; i < 10; i++) text += `| col${i} |\n| --- |\n| v${i} |\n\n`;
  const r = extractTables(text);
  assert.ok(r.tables.length <= 6);
});

test('buildTablesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '| h |\n| --- |\n| v |\n' },
    { name: 'b.md', extractedText: '| x |\n| --- |\n| y |\n' },
  ];
  const r = buildTablesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderTablesBlock returns markdown when tables exist', () => {
  const files = [{ name: 'doc.md', extractedText: '| col1 |\n| --- |\n| v1 |\n' }];
  const r = buildTablesForFiles(files);
  const md = renderTablesBlock(r);
  assert.match(md, /^## EMBEDDED TABLES/);
});

test('renderTablesBlock empty when nothing surfaces', () => {
  assert.equal(renderTablesBlock({ perFile: [] }), '');
  assert.equal(renderTablesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildTablesForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: '| h |\n| --- |\n| v |\n' }]);
  assert.equal(r.perFile.length, 1);
});

test('ignores prose containing pipes but no table separator', () => {
  const text = 'Some text | with pipes | inside but not a table.';
  const r = extractTables(text);
  assert.equal(r.tables.length, 0);
});

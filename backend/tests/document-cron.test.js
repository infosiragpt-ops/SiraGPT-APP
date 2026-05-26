'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-cron');
const { extractCron, buildCronForFiles, renderCronBlock, _internal } = engine;
const { isLikelyCron } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractCron('').total, 0);
  assert.equal(extractCron(null).total, 0);
});

test('isLikelyCron: valid 5-field', () => {
  assert.equal(isLikelyCron('0 3 * * *'), true);
  assert.equal(isLikelyCron('*/15 * * * *'), true);
  assert.equal(isLikelyCron('30 1 * * 1-5'), true);
});

test('isLikelyCron: rejects too-short or too-long', () => {
  assert.equal(isLikelyCron('0 3'), false);
  assert.equal(isLikelyCron('0 3 * * * * * * *'), false);
});

test('isLikelyCron: rejects all-digits (likely not a cron)', () => {
  assert.equal(isLikelyCron('2024 12 31 15 30'), false);
});

test('detects 5-field cron', () => {
  const r = extractCron('Runs at 0 3 * * * each day.');
  assert.ok(r.entries.some((e) => e.kind === '5-field' && e.expression === '0 3 * * *'));
});

test('detects */15 step expression', () => {
  const r = extractCron('Pulls every */15 * * * * minutes.');
  assert.ok(r.entries.some((e) => /\/15/.test(e.expression)));
});

test('detects @daily named expression', () => {
  const r = extractCron('Schedule: @daily run.');
  assert.ok(r.entries.some((e) => e.kind === 'named' && e.expression === '@daily'));
});

test('detects @hourly / @weekly / @monthly', () => {
  const r = extractCron('Cron uses @hourly for X, @weekly for Y, @monthly for Z.');
  const exprs = r.entries.map((e) => e.expression);
  assert.ok(exprs.includes('@hourly'));
  assert.ok(exprs.includes('@weekly'));
  assert.ok(exprs.includes('@monthly'));
});

test('detects @reboot', () => {
  const r = extractCron('@reboot start the daemon.');
  assert.ok(r.entries.some((e) => e.expression === '@reboot'));
});

test('detects K8s schedule: yaml line', () => {
  const r = extractCron('schedule: "0 3 * * *"');
  assert.ok(r.entries.some((e) => e.kind === 'scheduleLine'));
});

test('dedupes identical expressions', () => {
  const r = extractCron('Use 0 3 * * * here and 0 3 * * * there.');
  assert.equal(r.entries.filter((e) => e.expression === '0 3 * * *').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `${i % 60} ${i % 24} * * * \n`;
  const r = extractCron(text);
  assert.ok(r.entries.length <= 16);
});

test('totals reports kinds', () => {
  const r = extractCron('0 3 * * *\n@daily\n@hourly\nschedule: "0 0 * * *"');
  assert.ok(r.totals['5-field'] >= 1);
  assert.ok(r.totals.named >= 2);
  assert.ok(r.totals.scheduleLine >= 1);
});

test('handles ranges and lists in cron fields', () => {
  const r = extractCron('Run 0 9-17 * * 1-5 weekday business hours.');
  assert.ok(r.entries.some((e) => e.kind === '5-field' && /9-17/.test(e.expression)));
});

test('rejects all-digit dates that look like cron', () => {
  const r = extractCron('Date: 2024 12 31 15 30');
  assert.equal(r.entries.filter((e) => e.kind === '5-field').length, 0);
});

test('buildCronForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '@daily' },
    { name: 'b.md', extractedText: '0 0 * * *' },
  ];
  const r = buildCronForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderCronBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: '@daily backup' }];
  const r = buildCronForFiles(files);
  const md = renderCronBlock(r);
  assert.match(md, /^## CRON \/ SCHEDULING/);
});

test('renderCronBlock empty when nothing surfaces', () => {
  assert.equal(renderCronBlock({ perFile: [] }), '');
  assert.equal(renderCronBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildCronForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '@daily backup' },
  ]);
  assert.equal(r.perFile.length, 1);
});

test('detects @midnight as named', () => {
  const r = extractCron('Schedule: @midnight cleanup task.');
  assert.ok(r.entries.some((e) => e.expression === '@midnight'));
});

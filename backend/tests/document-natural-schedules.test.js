'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-natural-schedules');
const { extractNaturalSchedules, buildNaturalSchedulesForFiles, renderNaturalSchedulesBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractNaturalSchedules('').total, 0);
  assert.equal(extractNaturalSchedules(null).total, 0);
});

test('detects "every Monday at 9am"', () => {
  const r = extractNaturalSchedules('Meet every Monday at 9am.');
  assert.ok(r.entries.some((e) => e.kind === 'everyDay' && /monday/.test(e.normalised)));
});

test('detects "every Friday" without time', () => {
  const r = extractNaturalSchedules('Standups happen every Friday.');
  assert.ok(r.entries.some((e) => e.kind === 'everyDay'));
});

test('detects "every 15 minutes"', () => {
  const r = extractNaturalSchedules('Probe runs every 15 minutes.');
  assert.ok(r.entries.some((e) => e.kind === 'everyInterval' && /15-minute/.test(e.normalised)));
});

test('detects "every 2 hours"', () => {
  const r = extractNaturalSchedules('Backups run every 2 hours.');
  assert.ok(r.entries.some((e) => e.kind === 'everyInterval' && /2-hour/.test(e.normalised)));
});

test('detects "daily" recurrence', () => {
  const r = extractNaturalSchedules('Reports are sent daily at 3pm.');
  assert.ok(r.entries.some((e) => e.kind === 'recurrence' && /daily/.test(e.normalised)));
});

test('detects "weekly"', () => {
  const r = extractNaturalSchedules('Process is reviewed weekly.');
  assert.ok(r.entries.some((e) => e.kind === 'recurrence'));
});

test('detects "biweekly"', () => {
  const r = extractNaturalSchedules('Retrospectives are biweekly.');
  assert.ok(r.entries.some((e) => e.kind === 'recurrence' && /biweekly/.test(e.normalised)));
});

test('detects "twice a week"', () => {
  const r = extractNaturalSchedules('Updates posted twice a week.');
  assert.ok(r.entries.some((e) => e.kind === 'multiplicity'));
});

test('detects "on the first day of the month"', () => {
  const r = extractNaturalSchedules('Invoices on the first day of the month.');
  assert.ok(r.entries.some((e) => e.kind === 'specificDay'));
});

test('dedupes identical expressions', () => {
  const r = extractNaturalSchedules('every Monday at 9am. Later, every Monday at 9am.');
  assert.equal(r.entries.filter((e) => e.kind === 'everyDay').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `every ${i + 1} minutes\n`;
  const r = extractNaturalSchedules(text);
  assert.ok(r.entries.length <= 16);
});

test('counts totals by kind', () => {
  const r = extractNaturalSchedules(
    'every Monday at 9am. every 15 minutes. daily at 3pm. twice a week.'
  );
  assert.ok(r.totals.everyDay >= 1);
  assert.ok(r.totals.everyInterval >= 1);
  assert.ok(r.totals.recurrence >= 1);
  assert.ok(r.totals.multiplicity >= 1);
});

test('buildNaturalSchedulesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'every Monday at 9am' },
    { name: 'b', extractedText: 'daily at 3pm' },
  ];
  const r = buildNaturalSchedulesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderNaturalSchedulesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'runbook.md', extractedText: 'every Monday at 9am' }];
  const r = buildNaturalSchedulesForFiles(files);
  const md = renderNaturalSchedulesBlock(r);
  assert.match(md, /^## NATURAL/);
});

test('renderNaturalSchedulesBlock empty when nothing surfaces', () => {
  assert.equal(renderNaturalSchedulesBlock({ perFile: [] }), '');
  assert.equal(renderNaturalSchedulesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildNaturalSchedulesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'every Monday at 9am' },
  ]);
  assert.equal(r.perFile.length, 1);
});

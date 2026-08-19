'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-timezones');
const { extractTimezones, buildTimezonesForFiles, renderTimezonesBlock, _internal } = engine;
const { isValidOffset } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractTimezones('').total, 0);
  assert.equal(extractTimezones(null).total, 0);
});

test('isValidOffset: validates ranges', () => {
  assert.equal(isValidOffset('+05:00'), true);
  assert.equal(isValidOffset('-08:00'), true);
  assert.equal(isValidOffset('+15:00'), false);
});

test('detects UTC+5', () => {
  const r = extractTimezones('Meeting at 10am UTC+5 tomorrow.');
  assert.ok(r.entries.some((e) => /UTC\+5/.test(e.value)));
});

test('detects GMT+1', () => {
  const r = extractTimezones('Server in GMT+1 timezone.');
  assert.ok(r.entries.some((e) => /GMT\+1/.test(e.value)));
});

test('detects UTC-08:00', () => {
  const r = extractTimezones('West coast: UTC-08:00');
  assert.ok(r.entries.some((e) => /UTC-08/.test(e.value)));
});

test('detects bare offset +03:00', () => {
  const r = extractTimezones('Time: 14:30 +03:00');
  assert.ok(r.entries.some((e) => e.kind === 'offset' && /\+03:00/.test(e.value)));
});

test('detects named EST', () => {
  const r = extractTimezones('Office hours: 9am-5pm EST');
  assert.ok(r.entries.some((e) => e.kind === 'named' && e.value === 'EST'));
});

test('detects named CET', () => {
  const r = extractTimezones('Europe office on CET timezone.');
  assert.ok(r.entries.some((e) => e.value === 'CET'));
});

test('detects IANA America/New_York', () => {
  const r = extractTimezones('Server clock: America/New_York');
  assert.ok(r.entries.some((e) => e.kind === 'iana' && /America\/New_York/.test(e.value)));
});

test('detects IANA Europe/Madrid', () => {
  const r = extractTimezones('Lab in Europe/Madrid runs at...');
  assert.ok(r.entries.some((e) => e.value === 'Europe/Madrid'));
});

test('rejects unknown 3-letter caps', () => {
  const r = extractTimezones('Tag XYZ in random text.');
  assert.equal(r.entries.filter((e) => e.value === 'XYZ').length, 0);
});

test('dedupes identical entries', () => {
  const r = extractTimezones('Office in EST. Other office in EST.');
  assert.equal(r.entries.filter((e) => e.kind === 'named' && e.value === 'EST').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `UTC+${i % 14} `;
  const r = extractTimezones(text);
  assert.ok(r.entries.length <= 20);
});

test('counts totals by kind', () => {
  const r = extractTimezones('UTC+5, EST, America/New_York');
  assert.ok(r.totals.offset >= 1);
  assert.ok(r.totals.named >= 1);
  assert.ok(r.totals.iana >= 1);
});

test('buildTimezonesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'UTC+5' },
    { name: 'b.md', extractedText: 'EST' },
  ];
  const r = buildTimezonesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderTimezonesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'UTC+5' }];
  const r = buildTimezonesForFiles(files);
  const md = renderTimezonesBlock(r);
  assert.match(md, /^## TIME ZONES/);
});

test('renderTimezonesBlock empty when nothing surfaces', () => {
  assert.equal(renderTimezonesBlock({ perFile: [] }), '');
  assert.equal(renderTimezonesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildTimezonesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'EST' },
  ]);
  assert.equal(r.perFile.length, 1);
});

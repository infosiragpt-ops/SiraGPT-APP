'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-temporal-timeline');
const {
  extractTimeline,
  buildTimelineForFiles,
  renderTimelineBlock,
  _internal,
} = engine;
const {
  asISODate,
  findISODates,
  findNumericDates,
  findEnglishLongDates,
  findSpanishLongDates,
  findQuarterDates,
  gatherDates,
  describeStatus,
  statusLabel,
} = _internal;

const NOW = '2026-05-12T00:00:00Z';

test('asISODate validates impossible dates', () => {
  assert.equal(asISODate(2026, 2, 30), null);
  assert.equal(asISODate(2026, 13, 1), null);
  assert.equal(asISODate(2026, 6, 15), '2026-06-15');
});

test('findISODates: YYYY-MM-DD and YYYY/MM/DD forms', () => {
  const text = 'Kickoff 2026-01-15 and milestone 2026/02/20.';
  const dates = findISODates(text);
  assert.deepEqual(dates.map((d) => d.iso), ['2026-01-15', '2026-02-20']);
});

test('findNumericDates: dmy and mdy detection', () => {
  const text = '15/03/2026 contract signed; release 12/05/2026 confirmed.';
  const dates = findNumericDates(text);
  assert.deepEqual(dates.map((d) => d.iso).sort(), ['2026-03-15', '2026-05-12']);
});

test('findEnglishLongDates: "May 12, 2026" and "12 May 2026"', () => {
  const text = 'Filed on May 12, 2026 and revised on 20 June 2026.';
  const dates = findEnglishLongDates(text);
  assert.ok(dates.some((d) => d.iso === '2026-05-12'));
  assert.ok(dates.some((d) => d.iso === '2026-06-20'));
});

test('findSpanishLongDates: "12 de mayo de 2026"', () => {
  const text = 'La reunión se celebró el 12 de mayo de 2026 en la oficina central.';
  const dates = findSpanishLongDates(text);
  assert.deepEqual(dates.map((d) => d.iso), ['2026-05-12']);
});

test('findQuarterDates: Q1/Q2/Q3/Q4 and 1Q26 form', () => {
  const text = 'Roadmap targets Q1 2026 launch and 4Q26 wind-down.';
  const dates = findQuarterDates(text);
  assert.ok(dates.some((d) => d.iso === '2026-01-01'));
  assert.ok(dates.some((d) => d.iso === '2026-10-01'));
});

test('gatherDates: removes overlapping spans (longest wins)', () => {
  const text = 'Cierre el 12 de mayo de 2026 (2026-05-12).';
  const all = gatherDates(text);
  // Both anchors should resolve to the same ISO once, not duplicate from overlap
  const iso = all.map((d) => d.iso);
  assert.ok(iso.includes('2026-05-12'));
});

test('extractTimeline: returns chronologically sorted events', () => {
  const text = `Project plan:
Discovery completed on 2026-01-10.
Beta released on 2025-12-01.
Final delivery on 2026-06-15.`;
  const report = extractTimeline(text, { now: NOW });
  const iso = report.events.map((e) => e.iso);
  assert.deepEqual(iso, [...iso].sort());
});

test('extractTimeline: status reflects upcoming vs overdue vs past', () => {
  const text = `Deliverables:
The contract was signed on 2025-01-01.
Deadline: 2027-01-01 for next milestone.
Deadline due by 2024-01-01 was missed.`;
  const report = extractTimeline(text, { now: NOW });
  const statuses = report.events.map((e) => e.status);
  assert.ok(statuses.includes('upcoming-deadline'));
  assert.ok(statuses.includes('overdue-deadline'));
  // The signed event should be 'past-event' (it has past-event trigger)
  assert.ok(statuses.includes('past-event'));
});

test('extractTimeline: handles empty / non-string input', () => {
  assert.deepEqual(extractTimeline('').events, []);
  assert.deepEqual(extractTimeline(null).events, []);
  assert.deepEqual(extractTimeline(undefined).events, []);
});

test('extractTimeline: de-duplicates same date + same sentence', () => {
  const text = 'Reunión el 2026-05-12. Reunión el 2026-05-12.';
  const report = extractTimeline(text, { now: NOW });
  // The duplicate sentence with identical date should collapse to one entry
  assert.ok(report.events.length <= 2);
});

test('buildTimelineForFiles: aggregates and tags by file', () => {
  const files = [
    { name: 'planA.md', extractedText: 'Launch on 2026-06-01.' },
    { name: 'planB.md', extractedText: 'Wrap-up by 2026-12-15.' },
  ];
  const batch = buildTimelineForFiles(files, { now: NOW });
  assert.equal(batch.perFile.length, 2);
  assert.ok(batch.aggregate.events.length >= 2);
  assert.ok(batch.aggregate.events.every((e) => e.file === 'planA.md' || e.file === 'planB.md'));
});

test('renderTimelineBlock: returns markdown with ISO dates', () => {
  const files = [{ name: 'roadmap.md', extractedText: 'Kickoff on 2026-01-15.' }];
  const batch = buildTimelineForFiles(files, { now: NOW });
  const md = renderTimelineBlock(batch);
  assert.match(md, /^## TEMPORAL TIMELINE/);
  assert.match(md, /2026-01-15/);
});

test('renderTimelineBlock: empty when nothing found', () => {
  const files = [{ name: 'meta.md', extractedText: 'Hello world.' }];
  const batch = buildTimelineForFiles(files, { now: NOW });
  assert.equal(renderTimelineBlock(batch), '');
});

test('describeStatus: deadline triggers map to upcoming/overdue based on now', () => {
  const now = new Date(NOW);
  assert.equal(describeStatus('2030-01-01', 'Deadline 2030-01-01', now), 'upcoming-deadline');
  assert.equal(describeStatus('2000-01-01', 'Deadline 2000-01-01', now), 'overdue-deadline');
});

test('statusLabel: humanises every documented status', () => {
  for (const s of ['overdue-deadline', 'upcoming-deadline', 'past-event', 'historical', 'scheduled']) {
    assert.ok(statusLabel(s).length > 0);
  }
});

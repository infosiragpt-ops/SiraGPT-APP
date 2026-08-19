'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-ical-events');
const { extractIcalEvents, buildIcalEventsForFiles, renderIcalEventsBlock, _internal } = engine;
const { maskMailto } = _internal;

const SIMPLE_EVENT = `BEGIN:VEVENT
UID:abc123@example.com
SUMMARY:Team Sync
DTSTART:20251020T100000Z
DTEND:20251020T110000Z
LOCATION:Zoom
END:VEVENT`;

const RRULE_EVENT = `BEGIN:VEVENT
UID:weekly@example.com
SUMMARY:Weekly Standup
DTSTART:20251020T090000Z
DTEND:20251020T093000Z
RRULE:FREQ=WEEKLY;BYDAY=MO
END:VEVENT`;

const ATTENDEE_EVENT = `BEGIN:VEVENT
UID:bigmeeting@example.com
SUMMARY:Quarterly Review
DTSTART:20251101T140000Z
ATTENDEE;CN=Alice:mailto:alice@example.com
ATTENDEE;CN=Bob:mailto:bob@example.com
ORGANIZER:mailto:carol@example.com
END:VEVENT`;

test('empty / non-string tolerated', () => {
  assert.equal(extractIcalEvents('').total, 0);
  assert.equal(extractIcalEvents(null).total, 0);
});

test('maskMailto: masks local part', () => {
  assert.equal(maskMailto('mailto:alice@example.com'), 'mailto:a***e@example.com');
});

test('detects simple VEVENT', () => {
  const r = extractIcalEvents(SIMPLE_EVENT);
  assert.ok(r.entries.some((e) => e.summary === 'Team Sync'));
});

test('captures DTSTART and DTEND', () => {
  const r = extractIcalEvents(SIMPLE_EVENT);
  const entry = r.entries[0];
  assert.ok(entry.dtStart);
  assert.ok(entry.dtEnd);
});

test('captures LOCATION', () => {
  const r = extractIcalEvents(SIMPLE_EVENT);
  assert.equal(r.entries[0].location, 'Zoom');
});

test('detects RRULE', () => {
  const r = extractIcalEvents(RRULE_EVENT);
  assert.match(r.entries[0].rrule, /FREQ=WEEKLY/);
});

test('detects multiple attendees', () => {
  const r = extractIcalEvents(ATTENDEE_EVENT);
  assert.ok(r.entries[0].attendees.length >= 2);
});

test('Attendee emails are masked', () => {
  const r = extractIcalEvents(ATTENDEE_EVENT);
  for (const att of r.entries[0].attendees) {
    assert.ok(!/alice@/.test(att));
    assert.ok(!/bob@/.test(att));
  }
});

test('Organizer email is masked', () => {
  const r = extractIcalEvents(ATTENDEE_EVENT);
  assert.ok(!/carol@/.test(r.entries[0].organizer));
});

test('detects multiple events in feed', () => {
  const r = extractIcalEvents(`${SIMPLE_EVENT}\n${RRULE_EVENT}`);
  assert.equal(r.entries.length, 2);
});

test('dedupes identical UID+DTSTART', () => {
  const r = extractIcalEvents(`${SIMPLE_EVENT}\n${SIMPLE_EVENT}`);
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) {
    text += `BEGIN:VEVENT\nUID:e${i}@x.com\nSUMMARY:Event ${i}\nDTSTART:202510${(20 + i).toString().padStart(2, '0')}T100000Z\nEND:VEVENT\n`;
  }
  const r = extractIcalEvents(text);
  assert.ok(r.entries.length <= 12);
});

test('counts totals correctly', () => {
  const r = extractIcalEvents(`${SIMPLE_EVENT}\n${RRULE_EVENT}\n${ATTENDEE_EVENT}`);
  assert.equal(r.totals.events, 3);
  assert.equal(r.totals.withRrule, 1);
  assert.ok(r.totals.withAttendees >= 1);
});

test('buildIcalEventsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.ics', extractedText: SIMPLE_EVENT },
    { name: 'b.ics', extractedText: RRULE_EVENT },
  ];
  const r = buildIcalEventsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderIcalEventsBlock returns markdown when events exist', () => {
  const files = [{ name: 'cal.ics', extractedText: SIMPLE_EVENT }];
  const r = buildIcalEventsForFiles(files);
  const md = renderIcalEventsBlock(r);
  assert.match(md, /^## CALENDAR EVENTS/);
});

test('renderIcalEventsBlock NEVER contains full attendee email', () => {
  const files = [{ name: 'cal.ics', extractedText: ATTENDEE_EVENT }];
  const r = buildIcalEventsForFiles(files);
  const md = renderIcalEventsBlock(r);
  assert.ok(!/alice@example/.test(md));
});

test('renderIcalEventsBlock empty when nothing surfaces', () => {
  assert.equal(renderIcalEventsBlock({ perFile: [] }), '');
  assert.equal(renderIcalEventsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildIcalEventsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: SIMPLE_EVENT },
  ]);
  assert.equal(r.perFile.length, 1);
});

'use strict';

/**
 * document-ical-events.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects iCalendar (RFC 5545) VEVENT blocks within text. Extracts SUMMARY,
 * DTSTART, DTEND, LOCATION, ATTENDEE, ORGANIZER, RRULE, STATUS. Useful for
 * meeting-invite triage / calendar feeds.
 *
 * Public API:
 *   extractIcalEvents(text)             → { entries, totals, total }
 *   buildIcalEventsForFiles(files)      → { perFile, aggregate, totals }
 *   renderIcalEventsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 120_000;
const MAX_PER_FILE = 12;
const MAX_AGGREGATE = 16;
const MAX_BLOCK_CHARS = 4800;

const VEVENT_RE = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/g;
const PROP_RE = /^([A-Z][A-Z0-9-]*)(?:;[^:]+)?:(.+?)$/gm;

const RELEVANT_PROPS = new Set([
  'SUMMARY', 'DTSTART', 'DTEND', 'DURATION', 'LOCATION', 'ATTENDEE',
  'ORGANIZER', 'RRULE', 'STATUS', 'CATEGORIES', 'CLASS', 'UID',
  'CREATED', 'LAST-MODIFIED', 'TRANSP',
]);

function maskMailto(s) {
  const m = /mailto:([^<>@\s]+)@([A-Za-z0-9.-]+)/i.exec(s);
  if (!m) return s.slice(0, 80);
  const local = m[1];
  const masked = local.length < 2 ? '*' :
                 local.length === 2 ? `${local[0]}*` :
                 `${local[0]}***${local[local.length - 1]}`;
  return `mailto:${masked}@${m[2]}`;
}

function parseEvent(eventText) {
  const props = {};
  const attendees = [];
  PROP_RE.lastIndex = 0;
  let m;
  while ((m = PROP_RE.exec(eventText))) {
    const name = m[1];
    const value = m[2].trim();
    if (!RELEVANT_PROPS.has(name)) continue;
    if (name === 'ATTENDEE') {
      const masked = maskMailto(value);
      if (attendees.length < 6) attendees.push(masked);
    } else if (name === 'ORGANIZER') {
      props[name] = maskMailto(value);
    } else if (!props[name]) {
      props[name] = value.length > 120 ? `${value.slice(0, 120)}…` : value;
    }
  }
  if (attendees.length) props.ATTENDEES = attendees;
  return props;
}

function extractIcalEvents(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { events: 0, withRrule: 0, withAttendees: 0, withLocation: 0 };

  VEVENT_RE.lastIndex = 0;
  let m;
  while ((m = VEVENT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const props = parseEvent(m[1]);
    if (!props.SUMMARY && !props.UID && !props.DTSTART) continue;
    const key = `${props.UID || props.SUMMARY || ''}:${props.DTSTART || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      summary: props.SUMMARY || '(no summary)',
      dtStart: props.DTSTART || null,
      dtEnd: props.DTEND || null,
      duration: props.DURATION || null,
      location: props.LOCATION || null,
      organizer: props.ORGANIZER || null,
      attendees: props.ATTENDEES || [],
      rrule: props.RRULE || null,
      status: props.STATUS || null,
      uid: props.UID || null,
    });
    totals.events += 1;
    if (props.RRULE) totals.withRrule += 1;
    if (props.ATTENDEES) totals.withAttendees += 1;
    if (props.LOCATION) totals.withLocation += 1;
  }

  return { entries, totals, total: entries.length };
}

function buildIcalEventsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { events: 0, withRrule: 0, withAttendees: 0, withLocation: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractIcalEvents(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.uid || e.summary}:${e.dtStart}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      totals.events += 1;
      if (e.rrule) totals.withRrule += 1;
      if (e.attendees && e.attendees.length) totals.withAttendees += 1;
      if (e.location) totals.withLocation += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderIcalEventsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## CALENDAR EVENTS (iCal)', '- Attendee email locals masked first-1…last-1'];
  const t = report.totals || {};
  const parts = [];
  if (t.events) parts.push(`events: ${t.events}`);
  if (t.withRrule) parts.push(`recurring: ${t.withRrule}`);
  if (t.withAttendees) parts.push(`with-attendees: ${t.withAttendees}`);
  if (t.withLocation) parts.push(`with-location: ${t.withLocation}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 6)) {
      const range = e.dtEnd ? ` ${e.dtStart} → ${e.dtEnd}` : (e.dtStart ? ` ${e.dtStart}` : '');
      lines.push(`- "${e.summary}"${range}${e.location ? ` @${e.location}` : ''}`);
      if (e.attendees && e.attendees.length) lines.push(`  - attendees: ${e.attendees.length}`);
      if (e.rrule) lines.push(`  - rrule: ${e.rrule}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractIcalEvents,
  buildIcalEventsForFiles,
  renderIcalEventsBlock,
  _internal: { maskMailto, parseEvent },
};

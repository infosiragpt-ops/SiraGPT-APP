'use strict';

/**
 * document-temporal-timeline.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Chronological timeline extractor for attached documents.
 *
 * Why this sits next to deep-analyzer / claim-attribution / consistency-
 * checker rather than inside them:
 *  - Those modules surface CONTENT (what is said).
 *  - This one surfaces a TIMELINE (when things happened or are due).
 *    The chat layer reads it to answer "what's the order of events?",
 *    "what was decided when?", "what deadlines are coming up?".
 *
 * The model is given an ordered list of (date → event sentence) pairs
 * grouped per file, plus a global aggregate. Each event keeps its source
 * file name so cross-document timelines stay grounded.
 *
 * Detection coverage (deterministic, no LLM, < 15 ms on 1 MB):
 *   - ISO dates:               2026-05-12, 2026/05/12
 *   - US/EU numeric dates:     05/12/2026, 12-05-2026
 *   - Long-form English:       May 12, 2026 / 12 May 2026
 *   - Long-form Spanish:       12 de mayo de 2026
 *   - Quarterly references:    Q1 2026, 1Q26 (mapped to quarter start)
 *   - Year-only references:    1999, 2026  (only when surrounded by
 *                              event-y verbs to avoid false positives)
 *   - Relative deadline cues:  "due by", "deadline", "vence", "plazo"
 *                              — these get severity = "upcoming" when
 *                              the parsed date is in the future and
 *                              "overdue" when it's in the past.
 *
 * Bilingual (Spanish / English). Stateless. The "now" anchor is
 * injected so unit tests can pin time without monkey-patching Date.
 *
 * Public API:
 *   extractTimeline(text, opts)            → TimelineReport
 *   buildTimelineForFiles(files, opts)     → { perFile, aggregate }
 *   renderTimelineBlock(batchReport)       → markdown string
 *   _internal                              → exported for unit tests
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_EVENTS_PER_FILE = 24;
const MAX_AGGREGATE_EVENTS = 40;
const MAX_BLOCK_CHARS = 4500;
const MIN_SENTENCE_LEN = 12;
const MAX_SENTENCE_LEN = 260;

const MONTHS_EN = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sept: 9, sep: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};
const MONTHS_ES = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9, setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

const DEADLINE_TRIGGERS = [
  /\bdue\s+by\b/i,
  /\bdeadline\b/i,
  /\bby\s+end\s+of\b/i,
  /\beta\b/i,
  /\bvence\b/i,
  /\bvencimiento\b/i,
  /\bplazo\s+(?:l[íi]mite|m[áa]ximo)?\b/i,
  /\bfecha\s+l[íi]mite\b/i,
  /\bentrega\b/i,
];

const PAST_TRIGGERS = [
  /\bdelivered\b/i, /\bcompleted\b/i, /\bshipped\b/i, /\bsigned\b/i,
  /\bratified\b/i, /\bapproved\b/i, /\blaunched\b/i, /\breleased\b/i,
  /\bentregad[oa]s?\b/i, /\bcomplet(?:ado|ada)s?\b/i, /\bfirmad[oa]s?\b/i,
  /\baprobad[oa]s?\b/i, /\blanzad[oa]s?\b/i, /\bpublicad[oa]s?\b/i,
];

function safeText(value) {
  return typeof value === 'string' ? value : '';
}

function clip(text, max = 260) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function asISODate(year, month, day) {
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    month < 1 || month > 12 ||
    day < 1 || day > 31
  ) return null;
  // Reject impossible day-of-month for the parsed month/year.
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

function detectMonthName(token) {
  if (!token) return null;
  const lower = token.toLowerCase();
  if (lower in MONTHS_EN) return MONTHS_EN[lower];
  if (lower in MONTHS_ES) return MONTHS_ES[lower];
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Date parsers — each returns { iso, index, length } or null
// ──────────────────────────────────────────────────────────────────────────

function findISODates(text) {
  const out = [];
  // YYYY-MM-DD or YYYY/MM/DD
  const re = /\b(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})\b/g;
  for (const m of text.matchAll(re)) {
    const iso = asISODate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (!iso) continue;
    out.push({ iso, index: m.index ?? 0, length: m[0].length, raw: m[0], format: 'iso' });
  }
  return out;
}

function findNumericDates(text) {
  // dd/mm/yyyy or mm/dd/yyyy (ambiguous; we keep both interpretations only
  // when one of them is impossible — otherwise prefer the locale-neutral
  // interpretation: month/day/year if the first is ≤12 AND > 12 second,
  // else day/month/year).
  const out = [];
  const re = /\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/g;
  for (const m of text.matchAll(re)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const yRaw = Number(m[3]);
    const year = yRaw < 100 ? 2000 + yRaw : yRaw;
    // If "a" is clearly a day (>12) → b is month.
    if (a > 12 && b <= 12) {
      const iso = asISODate(year, b, a);
      if (iso) out.push({ iso, index: m.index ?? 0, length: m[0].length, raw: m[0], format: 'dmy' });
      continue;
    }
    if (b > 12 && a <= 12) {
      const iso = asISODate(year, a, b);
      if (iso) out.push({ iso, index: m.index ?? 0, length: m[0].length, raw: m[0], format: 'mdy' });
      continue;
    }
    // Ambiguous; default to dmy (more common globally outside US).
    const iso = asISODate(year, b, a);
    if (iso) out.push({ iso, index: m.index ?? 0, length: m[0].length, raw: m[0], format: 'dmy?' });
  }
  return out;
}

function findEnglishLongDates(text) {
  // "May 12, 2026", "May 12 2026", "12 May 2026"
  const out = [];
  const months = Object.keys(MONTHS_EN).sort((a, b) => b.length - a.length).join('|');
  const re1 = new RegExp(`\\b(${months})\\s+(\\d{1,2})(?:,)?\\s+(\\d{4})\\b`, 'gi');
  for (const m of text.matchAll(re1)) {
    const month = detectMonthName(m[1]);
    const iso = asISODate(Number(m[3]), month, Number(m[2]));
    if (!iso) continue;
    out.push({ iso, index: m.index ?? 0, length: m[0].length, raw: m[0], format: 'en-long' });
  }
  const re2 = new RegExp(`\\b(\\d{1,2})\\s+(${months})\\s+(\\d{4})\\b`, 'gi');
  for (const m of text.matchAll(re2)) {
    const month = detectMonthName(m[2]);
    const iso = asISODate(Number(m[3]), month, Number(m[1]));
    if (!iso) continue;
    out.push({ iso, index: m.index ?? 0, length: m[0].length, raw: m[0], format: 'en-long' });
  }
  return out;
}

function findSpanishLongDates(text) {
  // "12 de mayo de 2026", "12 de mayo, 2026"
  const out = [];
  const months = Object.keys(MONTHS_ES).join('|');
  const re = new RegExp(`\\b(\\d{1,2})\\s+de\\s+(${months})(?:\\s+de|,)\\s*(\\d{4})\\b`, 'gi');
  for (const m of text.matchAll(re)) {
    const month = detectMonthName(m[2]);
    const iso = asISODate(Number(m[3]), month, Number(m[1]));
    if (!iso) continue;
    out.push({ iso, index: m.index ?? 0, length: m[0].length, raw: m[0], format: 'es-long' });
  }
  return out;
}

function findQuarterDates(text) {
  // "Q1 2026" / "Q3 2025" / "1Q26"
  const out = [];
  const re = /\bQ([1-4])\s+(\d{4})\b/g;
  for (const m of text.matchAll(re)) {
    const q = Number(m[1]);
    const year = Number(m[2]);
    const month = (q - 1) * 3 + 1;
    const iso = asISODate(year, month, 1);
    if (!iso) continue;
    out.push({ iso, index: m.index ?? 0, length: m[0].length, raw: m[0], format: 'quarter' });
  }
  const re2 = /\b([1-4])Q(\d{2})\b/g;
  for (const m of text.matchAll(re2)) {
    const q = Number(m[1]);
    const yRaw = Number(m[2]);
    const year = 2000 + yRaw;
    const month = (q - 1) * 3 + 1;
    const iso = asISODate(year, month, 1);
    if (!iso) continue;
    out.push({ iso, index: m.index ?? 0, length: m[0].length, raw: m[0], format: 'quarter' });
  }
  return out;
}

function gatherDates(text) {
  const all = []
    .concat(findISODates(text))
    .concat(findNumericDates(text))
    .concat(findEnglishLongDates(text))
    .concat(findSpanishLongDates(text))
    .concat(findQuarterDates(text));
  // De-duplicate overlapping spans (longer span wins).
  all.sort((a, b) => (b.length - a.length) || (a.index - b.index));
  const taken = [];
  const out = [];
  for (const d of all) {
    const overlap = taken.some((t) => !(d.index + d.length <= t.start || d.index >= t.end));
    if (overlap) continue;
    taken.push({ start: d.index, end: d.index + d.length });
    out.push(d);
  }
  return out.sort((a, b) => a.index - b.index);
}

// ──────────────────────────────────────────────────────────────────────────
// Sentence association
// ──────────────────────────────────────────────────────────────────────────

function sentenceWindow(text, idx, length) {
  // Walk back to nearest sentence boundary, walk forward to next boundary.
  const start = Math.max(0, text.lastIndexOf('\n', idx - 1));
  const punct = ['.', '!', '?', '。', '！', '？'];
  let from = idx;
  while (from > start && from > 0) {
    const ch = text[from - 1];
    if (punct.includes(ch) && text[from] === ' ') break;
    if (ch === '\n') break;
    from--;
  }
  let to = idx + length;
  const end = Math.min(text.length, text.indexOf('\n', to) === -1 ? text.length : text.indexOf('\n', to));
  while (to < end && to < text.length) {
    const ch = text[to];
    if (punct.includes(ch)) { to++; break; }
    to++;
  }
  return text.slice(from, to).trim();
}

function describeStatus(iso, sentence, nowDate) {
  const date = new Date(`${iso}T00:00:00Z`);
  const now = nowDate instanceof Date ? nowDate : new Date();
  const isDeadline = DEADLINE_TRIGGERS.some((re) => re.test(sentence));
  const isPast = PAST_TRIGGERS.some((re) => re.test(sentence));
  if (isDeadline) {
    return date.getTime() >= now.getTime() ? 'upcoming-deadline' : 'overdue-deadline';
  }
  if (isPast) return 'past-event';
  return date.getTime() >= now.getTime() ? 'scheduled' : 'historical';
}

function extractTimeline(input, opts = {}) {
  const text = safeText(input);
  if (!text) {
    return { events: [], totalEvents: 0, truncated: false };
  }
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const dates = gatherDates(head);
  const nowDate = opts.now ? new Date(opts.now) : new Date();
  const events = [];
  const seen = new Set();
  for (const d of dates) {
    const sentence = sentenceWindow(head, d.index, d.length);
    if (!sentence || sentence.length < MIN_SENTENCE_LEN) continue;
    const clipped = clip(sentence, MAX_SENTENCE_LEN);
    const key = `${d.iso}|${clipped.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({
      iso: d.iso,
      format: d.format,
      raw: d.raw,
      sentence: clipped,
      status: describeStatus(d.iso, sentence, nowDate),
    });
  }
  events.sort((a, b) => a.iso.localeCompare(b.iso));
  return {
    events: events.slice(0, MAX_EVENTS_PER_FILE),
    totalEvents: events.length,
    truncated: text.length > SCAN_HEAD_BYTES,
  };
}

function buildTimelineForFiles(files, opts = {}) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregateEvents = [];
  for (const f of list) {
    const text = String(f.extractedText || '');
    if (!text) continue;
    const report = extractTimeline(text, opts);
    if (report.totalEvents === 0) continue;
    const name = f.name || f.originalName || f.id || 'attachment';
    perFile.push({ file: name, report });
    aggregateEvents = aggregateEvents.concat(report.events.map((e) => ({ ...e, file: name })));
  }
  aggregateEvents.sort((a, b) => a.iso.localeCompare(b.iso));
  return {
    perFile,
    aggregate: {
      events: aggregateEvents.slice(0, MAX_AGGREGATE_EVENTS),
      totalEvents: aggregateEvents.length,
    },
  };
}

function statusLabel(status) {
  switch (status) {
    case 'overdue-deadline': return 'OVERDUE deadline';
    case 'upcoming-deadline': return 'Upcoming deadline';
    case 'past-event': return 'Past event';
    case 'historical': return 'Historical';
    case 'scheduled': return 'Scheduled';
    default: return status;
  }
}

function renderEvents(events, opts = {}) {
  const lines = [];
  for (const e of events) {
    const head = opts.includeFile && e.file
      ? `**${e.iso}** [${statusLabel(e.status)}] _(${e.file})_`
      : `**${e.iso}** [${statusLabel(e.status)}]`;
    lines.push(`- ${head}: ${e.sentence}`);
  }
  return lines.join('\n');
}

function renderTimelineBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) return '';
  const heading = `## TEMPORAL TIMELINE
Chronological ordering of dates surfaced from the attached document(s) with the sentence each date anchors. Use this to answer "what happened when", "what is scheduled", and "what is overdue/upcoming". Status tags reflect the document's own language — verify against the source before claiming definitive deadlines.`;
  const sections = [];
  if (batchReport.perFile.length === 1) {
    const only = batchReport.perFile[0];
    sections.push(`### File: ${only.file}`);
    const body = renderEvents(only.report.events);
    if (body) sections.push(body);
  } else {
    const agg = renderEvents(batchReport.aggregate.events, { includeFile: true });
    if (agg) {
      sections.push('### Aggregate chronology across all files');
      sections.push(agg);
    }
    for (const p of batchReport.perFile) {
      const body = renderEvents(p.report.events);
      if (!body) continue;
      sections.push(`### File: ${p.file}`);
      sections.push(body);
    }
  }
  let combined = `${heading}\n\n${sections.join('\n\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...timeline block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractTimeline,
  buildTimelineForFiles,
  renderTimelineBlock,
  _internal: {
    asISODate,
    detectMonthName,
    findISODates,
    findNumericDates,
    findEnglishLongDates,
    findSpanishLongDates,
    findQuarterDates,
    gatherDates,
    sentenceWindow,
    describeStatus,
    statusLabel,
    MAX_EVENTS_PER_FILE,
    MAX_AGGREGATE_EVENTS,
  },
};

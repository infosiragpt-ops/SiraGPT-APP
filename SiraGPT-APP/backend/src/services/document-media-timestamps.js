'use strict';

/**
 * document-media-timestamps.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects timestamps used in audio/video transcripts, subtitles, podcast notes:
 *
 *   - HH:MM:SS         (1:23:45)
 *   - MM:SS            (12:34)
 *   - [00:00:00]       (bracketed)
 *   - (12:34)          (parenthesised)
 *   - HH:MM:SS,mmm     (SRT subtitle)
 *   - HH:MM:SS.mmm     (WebVTT)
 *
 * Public API:
 *   extractMediaTimestamps(text)             → { entries, totals, total }
 *   buildMediaTimestampsForFiles(files)      → { perFile, aggregate, totals }
 *   renderMediaTimestampsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

const HHMMSS_BRACKET_RE = /\[(\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?)\]/g;
const HHMMSS_PAREN_RE = /\((\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?)\)/g;
const HHMMSS_RAW_RE = /(?<![0-9:])(\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?)(?![0-9:])/g;
const MMSS_BRACKET_RE = /\[(\d{1,3}:\d{2})\]/g;
const MMSS_PAREN_RE = /\((\d{1,3}:\d{2})\)/g;
const SRT_RANGE_RE = /(\d{1,2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2},\d{3})/g;
const VTT_RANGE_RE = /(\d{1,2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}\.\d{3})/g;

function toSeconds(ts) {
  const parts = ts.replace(/[.,]\d+$/, '').split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

function classify(ts) {
  if (/-->/.test(ts)) return 'subtitle-range';
  if (/^\d{1,2}:\d{2}:\d{2}/.test(ts)) return 'hh-mm-ss';
  if (/^\d{1,3}:\d{2}$/.test(ts)) return 'mm-ss';
  return 'other';
}

function extractMediaTimestamps(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { 'hh-mm-ss': 0, 'mm-ss': 0, 'subtitle-range': 0, bracketed: 0, parenthesised: 0 };

  function push(ts, kind, source) {
    const key = `${kind}:${ts}`;
    if (seen.has(key)) return;
    seen.add(key);
    const seconds = toSeconds(ts);
    entries.push({ timestamp: ts, kind, source, seconds });
    if (totals[kind] != null) totals[kind] += 1;
    if (totals[source] != null) totals[source] += 1;
  }

  // SRT/VTT ranges first
  SRT_RANGE_RE.lastIndex = 0;
  let m;
  while ((m = SRT_RANGE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push(`${m[1]} → ${m[2]}`, 'subtitle-range', 'srt');
  }
  if (entries.length < MAX_PER_FILE) {
    VTT_RANGE_RE.lastIndex = 0;
    while ((m = VTT_RANGE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push(`${m[1]} → ${m[2]}`, 'subtitle-range', 'vtt');
    }
  }

  // Bracketed
  if (entries.length < MAX_PER_FILE) {
    HHMMSS_BRACKET_RE.lastIndex = 0;
    while ((m = HHMMSS_BRACKET_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push(m[1], 'hh-mm-ss', 'bracketed');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    MMSS_BRACKET_RE.lastIndex = 0;
    while ((m = MMSS_BRACKET_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push(m[1], 'mm-ss', 'bracketed');
    }
  }

  // Parenthesised
  if (entries.length < MAX_PER_FILE) {
    HHMMSS_PAREN_RE.lastIndex = 0;
    while ((m = HHMMSS_PAREN_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push(m[1], 'hh-mm-ss', 'parenthesised');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    MMSS_PAREN_RE.lastIndex = 0;
    while ((m = MMSS_PAREN_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push(m[1], 'mm-ss', 'parenthesised');
    }
  }

  // Bare HH:MM:SS (last — most permissive)
  if (entries.length < MAX_PER_FILE) {
    HHMMSS_RAW_RE.lastIndex = 0;
    while ((m = HHMMSS_RAW_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push(m[1], 'hh-mm-ss', 'bare');
    }
  }

  return { entries, totals, total: entries.length };
}

function buildMediaTimestampsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { 'hh-mm-ss': 0, 'mm-ss': 0, 'subtitle-range': 0, bracketed: 0, parenthesised: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractMediaTimestamps(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.timestamp}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderMediaTimestampsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## MEDIA TIMESTAMPS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      const sec = e.seconds != null ? ` (${e.seconds}s)` : '';
      lines.push(`- [${e.source}] \`${e.timestamp}\`${sec}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractMediaTimestamps,
  buildMediaTimestampsForFiles,
  renderMediaTimestampsBlock,
  _internal: { toSeconds, classify },
};

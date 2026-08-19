'use strict';

/**
 * document-media.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects audio / video / podcast media references:
 *
 *   - Filenames with media extensions: .mp3, .wav, .ogg, .m4a, .flac,
 *     .mp4, .mov, .avi, .webm, .mkv, .opus
 *   - HTML5: <audio src="..."> / <video src="...">
 *   - "Duration: 1h23m45s" / "[12:34]" timecode markers
 *   - Podcast / episode markers: "Episode 5", "S2E3"
 *
 * Different from document-file-paths (general file paths) by surfacing
 * media-specific kind. Routes "what audio?" / "what video?" / "podcast?"
 * to a citeable list.
 *
 * Public API:
 *   extractMedia(text)         → MediaReport
 *   buildMediaForFiles(files)  → { perFile, aggregate, totals }
 *   renderMediaBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_KIND = 10;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;
const MAX_VALUE_LEN = 100;

const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'wma', 'opus', 'aiff'];
const VIDEO_EXTS = ['mp4', 'mov', 'avi', 'webm', 'mkv', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', '3gp'];

const AUDIO_FILE_RE = new RegExp(`(?:^|[\\s\`'"<>(,;:])([\\w./\\-]+\\.(${AUDIO_EXTS.join('|')}))(?=[\\s\`'"<>):,;.!?]|$)`, 'gi');
const VIDEO_FILE_RE = new RegExp(`(?:^|[\\s\`'"<>(,;:])([\\w./\\-]+\\.(${VIDEO_EXTS.join('|')}))(?=[\\s\`'"<>):,;.!?]|$)`, 'gi');
const AUDIO_TAG_RE = /<audio\s+[^>]*src\s*=\s*["']([^"'\n]{1,300})["']/gi;
const VIDEO_TAG_RE = /<video\s+[^>]*src\s*=\s*["']([^"'\n]{1,300})["']/gi;
const TIMECODE_RE = /(?:^|[\s`'"<>(\[])(\[?\d{1,3}:\d{2}(?::\d{2})?\]?)(?=[\s`'"<>):,;.!?\]]|$)/g;
const EPISODE_RE = /\b(Episode\s+\d+|Episodio\s+\d+|S\d+E\d+|Cap[íi]tulo\s+\d+|Ep\.?\s*\d+)\b/gi;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipValue(s) {
  const t = String(s || '').trim();
  if (t.length <= MAX_VALUE_LEN) return t;
  return `${t.slice(0, MAX_VALUE_LEN - 1)}…`;
}

function emptyTotals() {
  return { audio: 0, video: 0, timecode: 0, episode: 0 };
}

function extractMedia(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = emptyTotals();

  function add(kind, value) {
    if (entries.length >= MAX_PER_FILE) return;
    if (totals[kind] >= MAX_PER_KIND) return;
    const v = clipValue(value);
    if (!v) return;
    const key = `${kind}|${v.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, value: v });
    totals[kind] += 1;
  }

  for (const m of head.matchAll(AUDIO_FILE_RE)) add('audio', m[1]);
  for (const m of head.matchAll(VIDEO_FILE_RE)) add('video', m[1]);
  for (const m of head.matchAll(AUDIO_TAG_RE)) add('audio', m[1]);
  for (const m of head.matchAll(VIDEO_TAG_RE)) add('video', m[1]);
  for (const m of head.matchAll(TIMECODE_RE)) add('timecode', m[1]);
  for (const m of head.matchAll(EPISODE_RE)) add('episode', m[1]);

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildMediaForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractMedia(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, totals: r.totals });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    for (const k of Object.keys(totals)) totals[k] += r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- [${e.kind}] \`${e.value}\`${file}`;
}

function renderMediaBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = Object.keys(totals)
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## AUDIO / VIDEO / PODCAST MEDIA
Media references detected in the document(s): audio filenames (mp3/wav/ogg/m4a/flac/opus/...), video filenames (mp4/mov/avi/webm/mkv/...), HTML5 <audio>/<video> tags, timecodes ([12:34], 1:23:45), and episode markers (Episode 5, S2E3, Capítulo 4). Routes "what audio?" / "what video?" / "podcast?" to a citeable list.

**Totals:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate media across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...media block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractMedia,
  buildMediaForFiles,
  renderMediaBlock,
  _internal: {
    AUDIO_FILE_RE,
    VIDEO_FILE_RE,
    AUDIO_TAG_RE,
    VIDEO_TAG_RE,
    TIMECODE_RE,
    EPISODE_RE,
    AUDIO_EXTS,
    VIDEO_EXTS,
  },
};

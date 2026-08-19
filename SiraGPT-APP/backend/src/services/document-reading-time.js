'use strict';

/**
 * document-reading-time.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Estimates per-file reading time + word/character counts.
 *
 *   - Word count (Unicode-aware tokenization)
 *   - Char count
 *   - Reading time at typical WPM bands:
 *     * 200 WPM (slow / non-native)
 *     * 250 WPM (average)
 *     * 350 WPM (fast / skim)
 *   - Returns formatted "X min Y s" times
 *
 * Different from document-readability-analyzer (Flesch / FK grade) by
 * being a quick size/time summary. Routes "how long to read?" /
 * "word count?" to a citeable summary.
 *
 * Public API:
 *   extractReadingTime(text)         → ReadingTimeReport
 *   buildReadingTimeForFiles(files)  → { perFile }
 *   renderReadingTimeBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 200_000;
const MAX_BLOCK_CHARS = 3500;

const WPM_BANDS = { slow: 200, average: 250, fast: 350 };

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function tokenize(text) {
  return text.match(/[a-zA-ZÀ-ÿ0-9]+/g) || [];
}

function formatTime(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds - minutes * 60);
  return rem > 0 ? `${minutes}m ${rem}s` : `${minutes}m`;
}

function extractReadingTime(input) {
  const text = safeText(input);
  if (!text) return { words: 0, chars: 0, times: {} };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const tokens = tokenize(head);
  const words = tokens.length;
  const chars = head.length;
  const times = {};
  for (const [label, wpm] of Object.entries(WPM_BANDS)) {
    const seconds = words > 0 ? (words / wpm) * 60 : 0;
    times[label] = { wpm, seconds: Math.round(seconds), formatted: formatTime(seconds) };
  }
  return { words, chars, times, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildReadingTimeForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  for (const f of list) {
    const r = extractReadingTime(safeText(f.extractedText));
    if (r.words === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, ...r });
  }
  return { perFile };
}

function renderEntry(e) {
  const lines = [`### File: ${e.file}`];
  lines.push(`- words: **${e.words.toLocaleString()}** chars: ${e.chars.toLocaleString()}`);
  lines.push(`- read time (slow 200 wpm): **${e.times.slow.formatted}**`);
  lines.push(`- read time (avg 250 wpm): **${e.times.average.formatted}**`);
  lines.push(`- read time (fast 350 wpm): **${e.times.fast.formatted}**`);
  return lines.join('\n');
}

function renderReadingTimeBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## READING TIME / SIZE
Per-file word + char count and reading time at three WPM bands — slow (200 wpm, non-native), average (250 wpm), fast (350 wpm, skim). Routes "how long to read?" / "word count?" to a citeable summary.`;
  const sections = report.perFile.map(renderEntry);
  let combined = `${heading}\n\n${sections.join('\n\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...reading time block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractReadingTime,
  buildReadingTimeForFiles,
  renderReadingTimeBlock,
  _internal: {
    WPM_BANDS,
    tokenize,
    formatTime,
  },
};

'use strict';

/**
 * document-ansi-escapes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects ANSI escape sequences in terminal output / logs:
 *
 *   - SGR (Select Graphic Rendition): \x1b[Nm — colors, bold, underline
 *   - cursor movement: \x1b[H, \x1b[2J
 *   - title set: \x1b]0;...
 *   - control sequences (CSI / OSC / DCS)
 *
 * Decodes SGR codes into human-readable categories.
 *
 * Public API:
 *   extractAnsiEscapes(text)             → { entries, totals, total }
 *   buildAnsiEscapesForFiles(files)      → { perFile, aggregate, totals }
 *   renderAnsiEscapesBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4500;

// Match \x1b, \033, ESC literal, plus the escape sequence
const SGR_RE = /(?:\\x1[bB]|\\033|)\[([0-9;]{1,40})m/g;
const CSI_RE = /(?:\\x1[bB]|\\033|)\[([0-9;]{0,20}[A-HJKSTfn])/g;
const OSC_RE = /(?:\\x1[bB]|\\033|)\]([0-9;]{1,40};[^]{1,200})/g;

function decodeSgr(code) {
  const n = parseInt(code, 10);
  if (n === 0) return 'reset';
  if (n === 1) return 'bold';
  if (n === 2) return 'dim';
  if (n === 3) return 'italic';
  if (n === 4) return 'underline';
  if (n === 5) return 'blink';
  if (n === 7) return 'reverse';
  if (n === 8) return 'hidden';
  if (n === 9) return 'strikethrough';
  if (n >= 30 && n <= 37) return `fg-${['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'][n - 30]}`;
  if (n === 38) return 'fg-256/truecolor';
  if (n === 39) return 'fg-default';
  if (n >= 40 && n <= 47) return `bg-${['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'][n - 40]}`;
  if (n === 48) return 'bg-256/truecolor';
  if (n === 49) return 'bg-default';
  if (n >= 90 && n <= 97) return `fg-bright-${['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'][n - 90]}`;
  if (n >= 100 && n <= 107) return `bg-bright-${['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'][n - 100]}`;
  return `sgr-${n}`;
}

function extractAnsiEscapes(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { sgr: 0, cursor: 0, osc: 0 };

  SGR_RE.lastIndex = 0;
  let m;
  while ((m = SGR_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const codes = m[1].split(';').filter(Boolean);
    const decoded = codes.map(decodeSgr).join(',');
    const key = `sgr:${m[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'sgr', sequence: m[0].slice(0, 40), decoded });
    totals.sgr += 1;
  }

  if (entries.length < MAX_PER_FILE) {
    CSI_RE.lastIndex = 0;
    while ((m = CSI_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      // Skip SGR (m terminator)
      if (m[1].endsWith('m')) continue;
      const key = `csi:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind: 'cursor', sequence: m[0].slice(0, 40), decoded: `csi-${m[1]}` });
      totals.cursor += 1;
    }
  }

  if (entries.length < MAX_PER_FILE) {
    OSC_RE.lastIndex = 0;
    while ((m = OSC_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `osc:${m[1].slice(0, 30)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind: 'osc', sequence: m[0].slice(0, 40), decoded: m[1].slice(0, 30) });
      totals.osc += 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildAnsiEscapesForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { sgr: 0, cursor: 0, osc: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractAnsiEscapes(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.decoded}`;
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

function renderAnsiEscapesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## ANSI ESCAPE CODES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- [${e.kind}] ${e.decoded}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractAnsiEscapes,
  buildAnsiEscapesForFiles,
  renderAnsiEscapesBlock,
  _internal: { decodeSgr },
};

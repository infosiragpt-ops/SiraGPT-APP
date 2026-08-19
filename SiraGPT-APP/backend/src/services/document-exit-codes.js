'use strict';

/**
 * document-exit-codes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects shell exit codes:
 *
 *   - exit 0 / exit 1 / exit 130
 *   - "exit code: N" / "rc=N" / "$?=N"
 *   - "process exited with N"
 *   - Standard codes: 0 success, 1 general error, 2 misuse, 126 not executable,
 *     127 not found, 128 invalid argument, 130 SIGINT (Ctrl-C), 137 SIGKILL,
 *     143 SIGTERM, 255 EXIT-OUT-OF-RANGE
 *
 * Public API:
 *   extractExitCodes(text)             → { entries, totals, total }
 *   buildExitCodesForFiles(files)      → { perFile, aggregate, totals }
 *   renderExitCodesBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 18;
const MAX_BLOCK_CHARS = 4500;

const STANDARD_CODES = {
  0: 'success',
  1: 'general-error',
  2: 'misuse',
  126: 'not-executable',
  127: 'command-not-found',
  128: 'invalid-argument',
  130: 'SIGINT (Ctrl-C)',
  137: 'SIGKILL (128+9)',
  139: 'SIGSEGV (128+11)',
  143: 'SIGTERM (128+15)',
  255: 'exit-out-of-range',
};

const EXIT_KW_RE = /\bexit(?:\s+code)?[\s:=]+(\d{1,3})\b/gi;
const RC_RE = /\b(?:rc|return\s+code|return\s+value)\s*[:=]\s*(\d{1,3})\b/gi;
const DOLLAR_QUESTION_RE = /\$\?\s*[:=]\s*(\d{1,3})\b/g;
const EXITED_WITH_RE = /\b(?:process|command|script|child)\s+exited\s+with\s+(?:code\s+|status\s+)?(\d{1,3})\b/gi;

function describeCode(code) {
  return STANDARD_CODES[code] || (code === 0 ? 'success' : code < 64 ? 'app-defined' : 'app-defined-extended');
}

function extractExitCodes(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { success: 0, error: 0, signal: 0, other: 0 };

  function push(code, source) {
    const n = parseInt(code, 10);
    if (isNaN(n) || n < 0 || n > 255) return;
    const description = describeCode(n);
    const key = `${n}:${source}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ code: n, description, source });
    const bucket = n === 0 ? 'success' :
                   /SIG/.test(description) ? 'signal' :
                   n <= 128 ? 'error' : 'other';
    if (totals[bucket] != null) totals[bucket] += 1;
  }

  EXIT_KW_RE.lastIndex = 0;
  let m;
  while ((m = EXIT_KW_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push(m[1], 'exit-keyword');
  }
  if (entries.length < MAX_PER_FILE) {
    RC_RE.lastIndex = 0;
    while ((m = RC_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push(m[1], 'rc-label');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    DOLLAR_QUESTION_RE.lastIndex = 0;
    while ((m = DOLLAR_QUESTION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push(m[1], '$?-variable');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    EXITED_WITH_RE.lastIndex = 0;
    while ((m = EXITED_WITH_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push(m[1], 'exited-with');
    }
  }

  return { entries, totals, total: entries.length };
}

function buildExitCodesForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { success: 0, error: 0, signal: 0, other: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractExitCodes(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.code}:${e.source}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      const bucket = e.code === 0 ? 'success' :
                     /SIG/.test(e.description) ? 'signal' :
                     e.code <= 128 ? 'error' : 'other';
      if (totals[bucket] != null) totals[bucket] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderExitCodesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## SHELL EXIT CODES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- exit ${e.code} — ${e.description} (${e.source})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractExitCodes,
  buildExitCodesForFiles,
  renderExitCodesBlock,
  _internal: { STANDARD_CODES, describeCode },
};

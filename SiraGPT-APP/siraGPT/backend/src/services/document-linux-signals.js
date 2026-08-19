'use strict';

/**
 * document-linux-signals.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Linux/POSIX signal references:
 *
 *   - by name:   SIGTERM, SIGKILL, SIGINT, SIGHUP, SIGQUIT, SIGSEGV, …
 *   - by number: kill -9 / kill -15 / signal 11
 *   - labeled:   "Received signal SIGTERM" / "signal: 15"
 *
 * Public API:
 *   extractLinuxSignals(text)             → { entries, totals, total }
 *   buildLinuxSignalsForFiles(files)      → { perFile, aggregate, totals }
 *   renderLinuxSignalsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 18;
const MAX_BLOCK_CHARS = 4500;

const SIGNALS = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5,
  SIGABRT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10,
  SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
  SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21,
  SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26,
  SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPWR: 30, SIGSYS: 31,
};

const NAME_RE = new RegExp(`\\b(${Object.keys(SIGNALS).join('|')})\\b`, 'g');
const KILL_RE = /\bkill\s+(?:-([A-Z]{2,8}|\d{1,2}))\s+(\d+)/g;
const LABELED_RE = /\b(?:signal|received\s+signal|caught\s+signal)\s*(?:[:=]?\s*|number\s+)(SIG[A-Z]{2,8}|\d{1,2})\b/gi;

function nameFromNumber(n) {
  for (const [k, v] of Object.entries(SIGNALS)) if (v === n) return k;
  return null;
}

function extractLinuxSignals(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = {};

  function push(name, source, ctx) {
    const key = `${name}:${source}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ signal: name, source, context: ctx });
    totals[name] = (totals[name] || 0) + 1;
  }

  NAME_RE.lastIndex = 0;
  let m;
  while ((m = NAME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push(m[1], 'name', 'bare-name');
  }

  if (entries.length < MAX_PER_FILE) {
    KILL_RE.lastIndex = 0;
    while ((m = KILL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const sig = m[1];
      let name = null;
      if (/^\d+$/.test(sig)) {
        name = nameFromNumber(parseInt(sig, 10));
      } else {
        const upper = `SIG${sig.toUpperCase().replace(/^SIG/, '')}`;
        if (SIGNALS[upper] != null) name = upper;
      }
      if (!name) continue;
      push(name, 'kill', `kill -${sig} ${m[2]}`);
    }
  }

  if (entries.length < MAX_PER_FILE) {
    LABELED_RE.lastIndex = 0;
    while ((m = LABELED_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const sig = m[1];
      let name = null;
      if (/^\d+$/.test(sig)) {
        name = nameFromNumber(parseInt(sig, 10));
      } else if (/^SIG/.test(sig)) {
        name = SIGNALS[sig] != null ? sig : null;
      }
      if (!name) continue;
      push(name, 'labeled', m[0].slice(0, 50));
    }
  }

  return { entries, totals, total: entries.length };
}

function buildLinuxSignalsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {};
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractLinuxSignals(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.signal}:${e.source}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      totals[e.signal] = (totals[e.signal] || 0) + 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderLinuxSignalsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## LINUX SIGNALS'];
  const t = report.totals || {};
  const top = Object.entries(t).sort(([, a], [, b]) => b - a).slice(0, 10);
  if (top.length) lines.push(`- Top: ${top.map(([k, v]) => `${k}×${v}`).join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 6)) {
      lines.push(`- ${e.signal} (${e.source}): \`${e.context}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractLinuxSignals,
  buildLinuxSignalsForFiles,
  renderLinuxSignalsBlock,
  _internal: { SIGNALS, nameFromNumber },
};

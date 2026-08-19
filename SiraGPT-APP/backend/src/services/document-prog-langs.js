'use strict';

/**
 * document-prog-langs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects programming language + version references:
 *
 *   - "Python 3.12" / "Python 3.11.5"
 *   - "Node 20" / "Node.js 18.19"
 *   - "Go 1.21" / "Golang 1.22"
 *   - "Rust 1.75" / "Ruby 3.3" / "PHP 8.3"
 *   - "Java 17" / "Java 21" / "JDK 17"
 *   - "TypeScript 5.3" / "Kotlin 1.9" / "Swift 5.9"
 *
 * Public API:
 *   extractProgLangs(text)             → { entries, totals, total }
 *   buildProgLangsForFiles(files)      → { perFile, aggregate, totals }
 *   renderProgLangsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4500;

const LANG_PATTERNS = [
  { re: /\bPython\s+(\d+(?:\.\d+){0,2})\b/g, name: 'Python', family: 'scripting' },
  { re: /\b(?:Node(?:\.js)?|NodeJS)\s+(?:v)?(\d+(?:\.\d+){0,2})\b/gi, name: 'Node.js', family: 'js-runtime' },
  { re: /\b(?:Go(?:lang)?)\s+(?:version\s+)?(\d+(?:\.\d+){0,2})\b/g, name: 'Go', family: 'compiled' },
  { re: /\bRust\s+(\d+(?:\.\d+){0,2})\b/g, name: 'Rust', family: 'compiled' },
  { re: /\bRuby\s+(\d+(?:\.\d+){0,2})\b/g, name: 'Ruby', family: 'scripting' },
  { re: /\bPHP\s+(\d+(?:\.\d+){0,2})\b/g, name: 'PHP', family: 'scripting' },
  { re: /\b(?:Java|JDK)\s+(\d+(?:\.\d+){0,2})\b/g, name: 'Java', family: 'jvm' },
  { re: /\bKotlin\s+(\d+(?:\.\d+){0,2})\b/g, name: 'Kotlin', family: 'jvm' },
  { re: /\bScala\s+(\d+(?:\.\d+){0,2})\b/g, name: 'Scala', family: 'jvm' },
  { re: /\bClojure\s+(\d+(?:\.\d+){0,2})\b/g, name: 'Clojure', family: 'jvm' },
  { re: /\bGroovy\s+(\d+(?:\.\d+){0,2})\b/g, name: 'Groovy', family: 'jvm' },
  { re: /\bTypeScript\s+(\d+(?:\.\d+){0,2})\b/g, name: 'TypeScript', family: 'js-typed' },
  { re: /\bSwift\s+(\d+(?:\.\d+){0,2})\b/g, name: 'Swift', family: 'apple' },
  { re: /\bObjective-C(?:\s+(\d+(?:\.\d+){0,2}))?\b/g, name: 'Objective-C', family: 'apple' },
  { re: /\b(?:C\+\+|CPP)\s+(?:(?:1[1-9]|2[0-3]|0x))\b/g, name: 'C++', family: 'compiled' },
  { re: /\bC#\s+(\d+(?:\.\d+){0,2})\b/g, name: 'C#', family: '.net' },
  { re: /\bF#\s+(\d+(?:\.\d+){0,2})\b/g, name: 'F#', family: '.net' },
  { re: /\bVisual Basic\s+(\d+(?:\.\d+){0,2})\b/gi, name: 'VB', family: '.net' },
  { re: /\bElixir\s+(\d+(?:\.\d+){0,2})\b/g, name: 'Elixir', family: 'erlang-vm' },
  { re: /\bErlang(?:\/OTP)?\s+(\d+(?:\.\d+){0,2})\b/g, name: 'Erlang', family: 'erlang-vm' },
  { re: /\bDart\s+(\d+(?:\.\d+){0,2})\b/g, name: 'Dart', family: 'flutter' },
  { re: /\bPerl\s+(\d+(?:\.\d+){0,2})\b/g, name: 'Perl', family: 'scripting' },
  { re: /\bLua\s+(\d+(?:\.\d+){0,2})\b/g, name: 'Lua', family: 'scripting' },
  { re: /\bR\s+(\d+(?:\.\d+){0,2})\b/g, name: 'R', family: 'stats' },
  { re: /\bJulia\s+(\d+(?:\.\d+){0,2})\b/g, name: 'Julia', family: 'stats' },
  { re: /\bHaskell(?:\s+GHC)?\s+(\d+(?:\.\d+){0,2})\b/g, name: 'Haskell', family: 'functional' },
  { re: /\bOCaml\s+(\d+(?:\.\d+){0,2})\b/g, name: 'OCaml', family: 'functional' },
  { re: /\bZig\s+(\d+(?:\.\d+){0,2})\b/g, name: 'Zig', family: 'compiled' },
  { re: /\bNim\s+(\d+(?:\.\d+){0,2})\b/g, name: 'Nim', family: 'compiled' },
  { re: /\bCrystal\s+(\d+(?:\.\d+){0,2})\b/g, name: 'Crystal', family: 'compiled' },
  { re: /\bBash\s+(\d+(?:\.\d+){0,2})\b/g, name: 'Bash', family: 'shell' },
];

function extractProgLangs(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = {};

  for (const { re, name, family } of LANG_PATTERNS) {
    if (entries.length >= MAX_PER_FILE) break;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body)) && entries.length < MAX_PER_FILE) {
      const version = m[1] || null;
      const key = `${name}:${version || 'unversioned'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ name, version, family });
      totals[family] = (totals[family] || 0) + 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildProgLangsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {};
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractProgLangs(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.name}:${e.version || ''}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      totals[e.family] = (totals[e.family] || 0) + 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderProgLangsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## PROGRAMMING LANGUAGES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      const v = e.version ? ` ${e.version}` : '';
      lines.push(`- ${e.name}${v} (${e.family})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractProgLangs,
  buildProgLangsForFiles,
  renderProgLangsBlock,
};

'use strict';

/**
 * document-browser-support.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects browser version requirement statements in compat tables / specs:
 *
 *   - "Chrome 100+" / "Chrome >= 90"
 *   - "Safari 16+ supports..."
 *   - "Firefox 119 / Edge 119"
 *   - "Opera 95, Vivaldi 5"
 *   - "iOS 17+" / "Android 12+"
 *
 * Public API:
 *   extractBrowserSupport(text)             → { entries, totals, total }
 *   buildBrowserSupportForFiles(files)      → { perFile, aggregate, totals }
 *   renderBrowserSupportBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4500;

const BROWSERS = [
  'Chrome', 'Firefox', 'Safari', 'Edge', 'Opera', 'Vivaldi', 'Brave',
  'Samsung Internet', 'UC Browser', 'Yandex',
  'iOS', 'iOS Safari', 'Android', 'Android WebView', 'Chrome Android',
  'Firefox Android', 'Samsung Browser',
  'Node\\.js', 'Deno', 'Bun',
];
const BROWSER_ALT = BROWSERS.join('|');
const VERSION_RE = new RegExp(`\\b(${BROWSER_ALT})\\s+(?:>=?\\s*|<=?\\s*)?(\\d+(?:\\.\\d+)?)(\\+|\\s*and\\s+(?:up|later)|\\s*or\\s+(?:later|newer))?`, 'g');
const CANIUSE_RE = /\bcaniuse\.com\/([a-z0-9.-]{3,40})/g;

function classifyBrowser(name) {
  const lower = name.toLowerCase();
  if (/^(?:ios|safari)/.test(lower)) return 'apple';
  if (/android|samsung|uc/.test(lower)) return 'mobile';
  if (/^(?:node|deno|bun)/.test(lower)) return 'runtime';
  return 'desktop';
}

function extractBrowserSupport(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { apple: 0, mobile: 0, desktop: 0, runtime: 0 };

  VERSION_RE.lastIndex = 0;
  let m;
  while ((m = VERSION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const browser = m[1].replace(/\\\./g, '.');
    const version = m[2];
    const trailing = m[3] || '';
    const lowerBound = /\+|up|later|newer/.test(trailing);
    const key = `${browser}:${version}:${lowerBound ? '+' : '='}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const family = classifyBrowser(browser);
    entries.push({ browser, version, lowerBound, family });
    if (totals[family] != null) totals[family] += 1;
  }

  CANIUSE_RE.lastIndex = 0;
  while ((m = CANIUSE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const feature = m[1];
    const key = `caniuse:${feature}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ browser: 'caniuse', version: feature, lowerBound: false, family: 'desktop' });
    totals.desktop += 1;
  }

  return { entries, totals, total: entries.length };
}

function buildBrowserSupportForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { apple: 0, mobile: 0, desktop: 0, runtime: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractBrowserSupport(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.browser}:${e.version}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.family] != null) totals[e.family] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderBrowserSupportBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## BROWSER SUPPORT MATRIX'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      lines.push(`- ${e.browser} ${e.version}${e.lowerBound ? '+' : ''} (${e.family})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractBrowserSupport,
  buildBrowserSupportForFiles,
  renderBrowserSupportBlock,
  _internal: { classifyBrowser },
};

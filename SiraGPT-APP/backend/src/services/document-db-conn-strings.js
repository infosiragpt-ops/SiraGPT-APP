'use strict';

/**
 * document-db-conn-strings.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects database connection strings — postgres / mysql / mongodb / redis /
 * elasticsearch / clickhouse / kafka. ALWAYS masks the password to first-2…
 * last-2 (or *** if shorter than 6). Username, host, and database are kept
 * unmasked so they remain useful for "which DB is this pointing at?".
 *
 * Public API:
 *   extractDbConnStrings(text)             → { entries, totals, total }
 *   buildDbConnStringsForFiles(files)      → { perFile, aggregate, totals }
 *   renderDbConnStringsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 12;
const MAX_AGGREGATE = 16;
const MAX_BLOCK_CHARS = 4500;

// scheme://user:password@host:port/db?params
const CONN_RE = /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis(?:s)?|amqps?|elasticsearch|clickhouse|kafka|mssql|sqlserver|oracle|cockroachdb|tidb):\/\/(?:([^:@\s/]*)(?::([^@\s/]+))?@)?([A-Za-z0-9_.-]+(?::\d{1,5})?)(?:\/([A-Za-z0-9_-]{1,40}))?/g;

function maskPassword(pwd) {
  if (typeof pwd !== 'string' || pwd.length === 0) return '';
  if (pwd.length < 6) return '****';
  return `${pwd.slice(0, 2)}…${pwd.slice(-2)}`;
}

function normaliseScheme(s) {
  const lower = s.toLowerCase();
  if (lower === 'postgres' || lower === 'postgresql') return 'postgres';
  if (lower === 'mongodb+srv') return 'mongodb';
  if (lower === 'rediss') return 'redis';
  if (lower === 'sqlserver') return 'mssql';
  return lower;
}

function extractDbConnStrings(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = {};

  CONN_RE.lastIndex = 0;
  let m;
  while ((m = CONN_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const [, scheme, user, password, hostPort, database] = m;
    const norm = normaliseScheme(scheme);
    // Build masked representation — KEY uniqueness derives from host + db, not pwd
    const key = `${norm}://${user || ''}@${hostPort}/${database || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const maskedPwd = password ? maskPassword(password) : null;
    const masked = `${norm}://${user || '<no-user>'}${maskedPwd ? `:${maskedPwd}` : ''}@${hostPort}${database ? `/${database}` : ''}`;
    entries.push({ scheme: norm, user: user || null, host: hostPort, database: database || null, masked });
    totals[norm] = (totals[norm] || 0) + 1;
  }

  return { entries, totals, total: entries.length };
}

function buildDbConnStringsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {};
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractDbConnStrings(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.masked)) continue;
      aggSeen.add(e.masked);
      aggregate.push(e);
      totals[e.scheme] = (totals[e.scheme] || 0) + 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderDbConnStringsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## DATABASE CONNECTION STRINGS', '- Passwords masked first-2…last-2 — never echo full credentials'];
  const t = report.totals || {};
  const parts = Object.keys(t).map((k) => `${k}: ${t[k]}`).slice(0, 8);
  if (parts.length) lines.push(`- Schemes: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 6)) {
      lines.push(`- \`${e.masked}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractDbConnStrings,
  buildDbConnStringsForFiles,
  renderDbConnStringsBlock,
  _internal: { maskPassword, normaliseScheme },
};

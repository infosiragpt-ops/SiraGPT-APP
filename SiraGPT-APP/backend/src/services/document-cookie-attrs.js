'use strict';

/**
 * document-cookie-attrs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Set-Cookie attributes and security flags. Useful for spotting
 * cookies missing HttpOnly / Secure / SameSite, or with overly long Max-Age.
 *
 * Targets:
 *   - HttpOnly / Secure / Partitioned (boolean flags)
 *   - SameSite=Strict | Lax | None
 *   - Path=/foo
 *   - Domain=example.com
 *   - Max-Age=3600
 *   - Expires=…
 *
 * Public API:
 *   extractCookieAttrs(text)             → { entries, totals, total }
 *   buildCookieAttrsForFiles(files)      → { perFile, aggregate, totals }
 *   renderCookieAttrsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 20;
const MAX_BLOCK_CHARS = 4500;

const COOKIE_LINE_RE = /(?:Set-Cookie\s*:\s*)?([A-Za-z][A-Za-z0-9_\-.]*=[^;\n\r]{1,120}(?:;\s*(?:HttpOnly|Secure|Partitioned|SameSite=(?:Strict|Lax|None)|Path=[^;\n\r]+|Domain=[^;\n\r]+|Max-Age=\d+|Expires=[^;\n\r]+))+)/gi;

const HTTPONLY_RE = /\bHttpOnly\b/g;
const SECURE_RE = /(?<![A-Za-z])Secure(?![A-Za-z])/g;
const PARTITIONED_RE = /\bPartitioned\b/g;
const SAMESITE_RE = /\bSameSite=(Strict|Lax|None)\b/g;
const MAXAGE_RE = /\bMax-Age=(\d{1,10})\b/g;

function extractCookieAttrs(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { httpOnly: 0, secure: 0, partitioned: 0, sameSite: 0, maxAge: 0 };

  COOKIE_LINE_RE.lastIndex = 0;
  let m;
  while ((m = COOKIE_LINE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const line = m[1].trim();
    if (line.length < 5) continue;
    const cookieName = line.split('=')[0];
    if (seen.has(cookieName)) continue;
    seen.add(cookieName);

    const attrs = {
      httpOnly: HTTPONLY_RE.test(line),
      secure: SECURE_RE.test(line),
      partitioned: PARTITIONED_RE.test(line),
      sameSite: null,
      maxAge: null,
    };
    HTTPONLY_RE.lastIndex = 0;
    SECURE_RE.lastIndex = 0;
    PARTITIONED_RE.lastIndex = 0;
    const ss = SAMESITE_RE.exec(line);
    if (ss) attrs.sameSite = ss[1];
    SAMESITE_RE.lastIndex = 0;
    const ma = MAXAGE_RE.exec(line);
    if (ma) attrs.maxAge = parseInt(ma[1], 10);
    MAXAGE_RE.lastIndex = 0;

    if (attrs.httpOnly) totals.httpOnly += 1;
    if (attrs.secure) totals.secure += 1;
    if (attrs.partitioned) totals.partitioned += 1;
    if (attrs.sameSite) totals.sameSite += 1;
    if (attrs.maxAge != null) totals.maxAge += 1;
    entries.push({ name: cookieName, attrs });
  }

  return { entries, totals, total: entries.length };
}

function buildCookieAttrsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { httpOnly: 0, secure: 0, partitioned: 0, sameSite: 0, maxAge: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractCookieAttrs(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.name)) continue;
      aggSeen.add(e.name);
      aggregate.push(e);
      if (e.attrs.httpOnly) totals.httpOnly += 1;
      if (e.attrs.secure) totals.secure += 1;
      if (e.attrs.partitioned) totals.partitioned += 1;
      if (e.attrs.sameSite) totals.sameSite += 1;
      if (e.attrs.maxAge != null) totals.maxAge += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderCookieAttrsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## COOKIE ATTRIBUTES'];
  const t = report.totals || {};
  const parts = [];
  if (t.httpOnly) parts.push(`HttpOnly: ${t.httpOnly}`);
  if (t.secure) parts.push(`Secure: ${t.secure}`);
  if (t.sameSite) parts.push(`SameSite: ${t.sameSite}`);
  if (t.partitioned) parts.push(`Partitioned: ${t.partitioned}`);
  if (t.maxAge) parts.push(`Max-Age: ${t.maxAge}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      const flags = [];
      if (e.attrs.httpOnly) flags.push('HttpOnly');
      if (e.attrs.secure) flags.push('Secure');
      if (e.attrs.sameSite) flags.push(`SameSite=${e.attrs.sameSite}`);
      if (e.attrs.maxAge != null) flags.push(`Max-Age=${e.attrs.maxAge}`);
      lines.push(`- \`${e.name}\` — ${flags.join(', ') || '(no flags)'}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractCookieAttrs,
  buildCookieAttrsForFiles,
  renderCookieAttrsBlock,
};

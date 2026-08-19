'use strict';

/**
 * document-email-headers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects RFC 5322 email headers (Message-Id, From, To, Cc, Subject, Date,
 * X-Mailer, Reply-To, In-Reply-To, References). Useful for triaging email
 * forwards / thread analysis without loading a full MIME parser.
 *
 * Public API:
 *   extractEmailHeaders(text)             → { entries, totals, total }
 *   buildEmailHeadersForFiles(files)      → { perFile, aggregate, totals }
 *   renderEmailHeadersBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4500;

const HEADERS = {
  'message-id': 'message-id',
  from: 'from',
  to: 'to',
  cc: 'cc',
  bcc: 'bcc',
  subject: 'subject',
  date: 'date',
  'reply-to': 'reply-to',
  'in-reply-to': 'in-reply-to',
  references: 'references',
  'x-mailer': 'x-mailer',
  'list-id': 'list-id',
  'return-path': 'return-path',
  'delivered-to': 'delivered-to',
};

const HEADER_NAMES = Object.keys(HEADERS).sort((a, b) => b.length - a.length);
const HEADER_ALT = HEADER_NAMES.map((n) => n.replace(/-/g, '[-]')).join('|');
const HEADER_RE = new RegExp(`^(${HEADER_ALT})\\s*:\\s*([^\\r\\n]{1,300})`, 'gim');

const EMAIL_RE = /<([^<>@\s]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,20})>|\b([^<>@\s,]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,20})\b/g;

function maskEmail(addr) {
  if (typeof addr !== 'string' || !addr.includes('@')) return '****';
  const [local, domain] = addr.split('@');
  const localMasked = local.length <= 3 ? local : `${local[0]}***${local[local.length - 1]}`;
  return `${localMasked}@${domain}`;
}

function classifyAndExtractEmails(value) {
  const out = [];
  EMAIL_RE.lastIndex = 0;
  let m;
  while ((m = EMAIL_RE.exec(value))) {
    const addr = m[1] || m[2];
    out.push(maskEmail(addr));
    if (out.length >= 5) break;
  }
  return out;
}

function extractEmailHeaders(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = {};

  HEADER_RE.lastIndex = 0;
  let m;
  while ((m = HEADER_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const headerLower = m[1].toLowerCase();
    const role = HEADERS[headerLower] || 'other';
    const raw = m[2].trim();
    const key = `${role}:${raw.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let value = raw.length > 100 ? `${raw.slice(0, 100)}…` : raw;
    if (role === 'from' || role === 'to' || role === 'cc' || role === 'reply-to' || role === 'return-path' || role === 'delivered-to') {
      const emails = classifyAndExtractEmails(raw);
      if (emails.length) value = emails.join(', ');
    }
    entries.push({ header: m[1], role, value });
    totals[role] = (totals[role] || 0) + 1;
  }

  return { entries, totals, total: entries.length };
}

function buildEmailHeadersForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {};
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractEmailHeaders(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.role}:${e.value}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      totals[e.role] = (totals[e.role] || 0) + 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderEmailHeadersBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## EMAIL HEADERS', '- Email addresses masked first-1…last-1 of local part'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- ${e.role}: \`${e.value}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractEmailHeaders,
  buildEmailHeadersForFiles,
  renderEmailHeadersBlock,
  _internal: { maskEmail, classifyAndExtractEmails },
};

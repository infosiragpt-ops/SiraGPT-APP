'use strict';

/**
 * document-user-agents.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects User-Agent strings and classifies them: browser / mobile / bot /
 * crawler / library. Useful for log triage ("which UAs hit this endpoint?")
 * and security analysis ("any bots hitting /admin?").
 *
 * Public API:
 *   extractUserAgents(text)             → { entries, totals, total }
 *   buildUserAgentsForFiles(files)      → { perFile, aggregate, totals }
 *   renderUserAgentsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 18;
const MAX_BLOCK_CHARS = 4500;

// Classic Mozilla/5.0 UA strings or other recognised library UAs
const UA_RE = /\b(Mozilla\/[0-9.]+(?:\s*\([^)]{0,250}\))?(?:\s+[A-Za-z][A-Za-z0-9._-]*\/[0-9._]+(?:\s*\([^)]{0,80}\))?){0,6}|curl\/[0-9._]+|axios\/[0-9._]+|node-fetch\/[0-9._]+|python-requests\/[0-9._]+|okhttp\/[0-9._]+|GuzzleHttp\/[0-9._]+|libwww-perl\/[0-9._]+|Java\/[0-9._]+|Go-http-client\/[0-9._]+)/g;

// Bot/crawler detectors (case-sensitive on the bot keyword for fewer false positives)
const BOT_KEYWORDS = [
  'Googlebot', 'Bingbot', 'DuckDuckBot', 'Baiduspider', 'YandexBot',
  'Slurp', 'Applebot', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot',
  'SemrushBot', 'AhrefsBot', 'MJ12bot', 'DotBot', 'CCBot',
  'GPTBot', 'ClaudeBot', 'Claude-Web', 'PerplexityBot', 'YouBot', 'Anthropic',
];
const BOT_RE = new RegExp(`\\b(${BOT_KEYWORDS.join('|')})\\b`, 'gi');

function classify(ua) {
  const lower = ua.toLowerCase();
  if (/bot|crawl|spider|scrape/i.test(ua)) return 'bot';
  if (/curl\/|axios\/|node-fetch|python-requests|okhttp|guzzle|libwww|Java\/|Go-http-client/i.test(ua)) return 'library';
  if (/mobile|iPhone|iPad|Android/i.test(ua)) return 'mobile';
  if (/Chrome|Firefox|Safari|Edge|Opera|Vivaldi/i.test(ua)) return 'browser';
  return 'other';
}

function nameOf(ua) {
  if (/Chrome\/[\d.]+/.test(ua) && !/Edg\//.test(ua)) return 'Chrome';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Firefox\/[\d.]+/.test(ua)) return 'Firefox';
  if (/Safari\/[\d.]+/.test(ua) && !/Chrome/.test(ua)) return 'Safari';
  if (/Opera\/[\d.]+|OPR\//.test(ua)) return 'Opera';
  const m = /^([A-Za-z][A-Za-z_-]+)\//.exec(ua.trim());
  return m ? m[1] : 'unknown';
}

function extractUserAgents(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { browser: 0, mobile: 0, bot: 0, library: 0, other: 0 };

  // Mozilla/curl/etc UA strings
  UA_RE.lastIndex = 0;
  let m;
  while ((m = UA_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const ua = m[1].trim();
    if (ua.length < 6) continue;
    const truncated = ua.length > 200 ? `${ua.slice(0, 200)}…` : ua;
    if (seen.has(truncated)) continue;
    seen.add(truncated);
    const kind = classify(ua);
    entries.push({ ua: truncated, kind, name: nameOf(ua) });
    if (totals[kind] != null) totals[kind] += 1;
  }

  // Bare bot keywords (when there's no full UA string nearby)
  if (entries.length < MAX_PER_FILE) {
    BOT_RE.lastIndex = 0;
    while ((m = BOT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const bot = m[1];
      if (seen.has(bot)) continue;
      seen.add(bot);
      entries.push({ ua: bot, kind: 'bot', name: bot });
      totals.bot += 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildUserAgentsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { browser: 0, mobile: 0, bot: 0, library: 0, other: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractUserAgents(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.ua)) continue;
      aggSeen.add(e.ua);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderUserAgentsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## USER-AGENT STRINGS'];
  const t = report.totals || {};
  const parts = [];
  if (t.browser) parts.push(`browser: ${t.browser}`);
  if (t.mobile) parts.push(`mobile: ${t.mobile}`);
  if (t.bot) parts.push(`bot: ${t.bot}`);
  if (t.library) parts.push(`library: ${t.library}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 6)) {
      lines.push(`- [${e.kind}] ${e.name}: \`${e.ua.length > 120 ? e.ua.slice(0, 120) + '…' : e.ua}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractUserAgents,
  buildUserAgentsForFiles,
  renderUserAgentsBlock,
  _internal: { classify, nameOf },
};

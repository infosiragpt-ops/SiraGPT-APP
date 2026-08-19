'use strict';

/**
 * document-bot-tokens.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects messenger-bot API tokens. All values MASKED — surface the presence
 * and platform without leaking the secret.
 *
 *   - Telegram bot:   <bot-id>:<35-alphanumeric>
 *   - Slack bot:      xoxb-<digits>-<digits>-<random>
 *   - Slack user:     xoxp-<digits>-<digits>-<random>
 *   - Slack app:      xapp-<digits>-<id>-<random>
 *   - Discord bot:    <60-72 base64 chars> (in DISCORD_TOKEN context)
 *
 * Public API:
 *   extractBotTokens(text)             → { entries, totals, total }
 *   buildBotTokensForFiles(files)      → { perFile, aggregate, totals }
 *   renderBotTokensBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 12;
const MAX_AGGREGATE = 16;
const MAX_BLOCK_CHARS = 4500;

const TELEGRAM_RE = /\b(\d{8,12}:[A-Za-z0-9_-]{30,40})\b/g;
const SLACK_BOT_RE = /\b(xoxb-\d{6,15}-\d{8,15}-[A-Za-z0-9]{20,40})\b/g;
const SLACK_USER_RE = /\b(xoxp-\d{6,15}-\d{8,15}-\d{8,15}-[A-Za-z0-9]{20,40})\b/g;
const SLACK_APP_RE = /\b(xapp-\d{1,4}-[A-Z0-9]{8,15}-\d{8,15}-[A-Za-z0-9]{40,80})\b/g;
const DISCORD_LABELED_RE = /\b(?:DISCORD[_-]?TOKEN|DISCORD[_-]?BOT[_-]?TOKEN)\s*[:=]\s*['"]?([A-Za-z0-9_-]{50,80}(?:\.[A-Za-z0-9_-]{5,10})?(?:\.[A-Za-z0-9_-]{20,40})?)['"]?/gi;

function maskToken(t) {
  if (typeof t !== 'string' || t.length < 8) return '****';
  return `${t.slice(0, 4)}…${t.slice(-4)} (${t.length} chars)`;
}

function extractBotTokens(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { telegram: 0, slackBot: 0, slackUser: 0, slackApp: 0, discord: 0 };

  function push(platform, raw) {
    const masked = maskToken(raw);
    const key = `${platform}:${masked}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ platform, masked });
    if (totals[platform] != null) totals[platform] += 1;
  }

  TELEGRAM_RE.lastIndex = 0;
  let m;
  while ((m = TELEGRAM_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('telegram', m[1]);
  }
  if (entries.length < MAX_PER_FILE) {
    SLACK_BOT_RE.lastIndex = 0;
    while ((m = SLACK_BOT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('slackBot', m[1]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    SLACK_USER_RE.lastIndex = 0;
    while ((m = SLACK_USER_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('slackUser', m[1]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    SLACK_APP_RE.lastIndex = 0;
    while ((m = SLACK_APP_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('slackApp', m[1]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    DISCORD_LABELED_RE.lastIndex = 0;
    while ((m = DISCORD_LABELED_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('discord', m[1]);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildBotTokensForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { telegram: 0, slackBot: 0, slackUser: 0, slackApp: 0, discord: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractBotTokens(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.platform}:${e.masked}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.platform] != null) totals[e.platform] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderBotTokensBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## BOT API TOKENS', '- Tokens masked first-4…last-4 — never echo full values'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 6)) {
      lines.push(`- ⚠ ${e.platform}: \`${e.masked}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractBotTokens,
  buildBotTokensForFiles,
  renderBotTokensBlock,
  _internal: { maskToken },
};

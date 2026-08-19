'use strict';

/**
 * document-chat-permalinks.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects permalink URLs to messages in chat platforms:
 *
 *   - Slack:   https://workspace.slack.com/archives/CXXX/pYYYYYY
 *   - Discord: https://discord.com/channels/<server>/<channel>/<message>
 *   - Notion:  https://www.notion.so/<workspace>/<page-id>
 *   - MS Teams: https://teams.microsoft.com/l/message/<conv>/<msg>
 *   - Telegram: https://t.me/<channel>/<id>
 *
 * Public API:
 *   extractChatPermalinks(text)             → { entries, totals, total }
 *   buildChatPermalinksForFiles(files)      → { perFile, aggregate, totals }
 *   renderChatPermalinksBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 20;
const MAX_BLOCK_CHARS = 4500;

const SLACK_RE = /\bhttps?:\/\/([a-z0-9-]+)\.slack\.com\/archives\/([A-Z0-9]{8,12})\/p(\d{16})/g;
const SLACK_THREAD_RE = /\bhttps?:\/\/([a-z0-9-]+)\.slack\.com\/archives\/([A-Z0-9]{8,12})\/p(\d{16})\?thread_ts=(\d+\.\d+)/g;
const DISCORD_RE = /\bhttps?:\/\/discord(?:app)?\.com\/channels\/(\d{15,25}|@me)\/(\d{15,25})\/(\d{15,25})/g;
const NOTION_RE = /\bhttps?:\/\/(?:www\.)?notion\.so\/([a-z0-9-]+)\/([A-Za-z0-9_-]{12,80})(?:[?#]|$|\s)/gi;
const TEAMS_RE = /\bhttps?:\/\/teams\.microsoft\.com\/l\/message\/([0-9:_@a-zA-Z.-]{10,150})\/(\d+)/g;
const TELEGRAM_RE = /\bhttps?:\/\/t\.me\/([a-zA-Z][a-zA-Z0-9_]{1,40})\/(\d{1,8})/g;

function extractChatPermalinks(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { slack: 0, discord: 0, notion: 0, teams: 0, telegram: 0 };

  function push(platform, ref, ctx) {
    if (seen.has(ref)) return;
    seen.add(ref);
    entries.push({ platform, ref, context: ctx });
    if (totals[platform] != null) totals[platform] += 1;
  }

  SLACK_THREAD_RE.lastIndex = 0;
  let m;
  while ((m = SLACK_THREAD_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('slack', `${m[1]}/archives/${m[2]}/p${m[3]}?thread_ts=${m[4]}`, 'thread');
  }
  SLACK_RE.lastIndex = 0;
  while ((m = SLACK_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('slack', `${m[1]}/archives/${m[2]}/p${m[3]}`, 'message');
  }

  if (entries.length < MAX_PER_FILE) {
    DISCORD_RE.lastIndex = 0;
    while ((m = DISCORD_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('discord', `${m[1]}/${m[2]}/${m[3]}`, m[1] === '@me' ? 'dm' : 'channel');
    }
  }

  if (entries.length < MAX_PER_FILE) {
    NOTION_RE.lastIndex = 0;
    while ((m = NOTION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('notion', `${m[1]}/${m[2]}`, 'page');
    }
  }

  if (entries.length < MAX_PER_FILE) {
    TEAMS_RE.lastIndex = 0;
    while ((m = TEAMS_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('teams', `${m[1].slice(0, 30)}…/${m[2]}`, 'message');
    }
  }

  if (entries.length < MAX_PER_FILE) {
    TELEGRAM_RE.lastIndex = 0;
    while ((m = TELEGRAM_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('telegram', `${m[1]}/${m[2]}`, 'channel-post');
    }
  }

  return { entries, totals, total: entries.length };
}

function buildChatPermalinksForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { slack: 0, discord: 0, notion: 0, teams: 0, telegram: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractChatPermalinks(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.ref)) continue;
      aggSeen.add(e.ref);
      aggregate.push(e);
      if (totals[e.platform] != null) totals[e.platform] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderChatPermalinksBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## CHAT PLATFORM PERMALINKS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- ${e.platform} (${e.context}): \`${e.ref}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractChatPermalinks,
  buildChatPermalinksForFiles,
  renderChatPermalinksBlock,
};

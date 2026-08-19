'use strict';

/**
 * document-webhook-urls.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects webhook URLs and MASKS the secret/token portion so the document
 * surfaces "we use a Slack webhook here" without leaking the actual token.
 *
 * Targets:
 *   - Slack:    https://hooks.slack.com/services/T<x>/B<x>/<token>
 *   - Discord:  https://discord.com/api/webhooks/<id>/<token>
 *   - Teams:    https://outlook.office.com/webhook/<guid>/IncomingWebhook/<id>/<token>
 *   - GitHub:   https://api.github.com/repos/<o>/<r>/hooks                  (no token in URL)
 *   - Generic:  /webhook/<32+hex>            (best-effort, masked)
 *
 * Output ALWAYS masks any token-shaped tail to `XXX…YYY`.
 *
 * Public API:
 *   extractWebhookUrls(text)            → { entries, totals, total }
 *   buildWebhookUrlsForFiles(files)     → { perFile, aggregate, totals }
 *   renderWebhookUrlsBlock(report)      → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 12;
const MAX_AGGREGATE = 16;
const MAX_BLOCK_CHARS = 4500;

const SLACK_RE = /\bhttps?:\/\/hooks\.slack\.com\/services\/(T[A-Z0-9]{2,15})\/(B[A-Z0-9]{2,15})\/([A-Za-z0-9]{15,40})/g;
const DISCORD_RE = /\bhttps?:\/\/discord(?:app)?\.com\/api\/webhooks\/(\d{15,25})\/([A-Za-z0-9_-]{40,90})/g;
const TEAMS_RE = /\bhttps?:\/\/outlook\.office\.com\/webhook\/([0-9a-f-]{20,40})\/IncomingWebhook\/([0-9a-f]{20,40})\/([0-9a-f-]{20,40})/gi;
const GH_HOOK_RE = /\bhttps?:\/\/api\.github\.com\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/hooks(?:\/(\d{1,12}))?/g;
const GENERIC_RE = /\bhttps?:\/\/[a-z0-9.-]+\/(?:webhook|hook)s?\/([A-Za-z0-9_-]{16,80})/gi;

function maskToken(t) {
  if (typeof t !== 'string' || t.length < 8) return '****';
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

function extractWebhookUrls(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { slack: 0, discord: 0, teams: 0, github: 0, generic: 0 };

  function push(provider, masked, ctx) {
    if (seen.has(masked)) return;
    seen.add(masked);
    entries.push({ provider, masked, context: ctx });
    if (totals[provider] != null) totals[provider] += 1;
  }

  SLACK_RE.lastIndex = 0;
  let m;
  while ((m = SLACK_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const masked = `https://hooks.slack.com/services/${m[1]}/${m[2]}/${maskToken(m[3])}`;
    push('slack', masked, 'incoming');
  }

  if (entries.length < MAX_PER_FILE) {
    DISCORD_RE.lastIndex = 0;
    while ((m = DISCORD_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const masked = `https://discord.com/api/webhooks/${m[1]}/${maskToken(m[2])}`;
      push('discord', masked, 'incoming');
    }
  }

  if (entries.length < MAX_PER_FILE) {
    TEAMS_RE.lastIndex = 0;
    while ((m = TEAMS_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const masked = `https://outlook.office.com/webhook/${maskToken(m[1])}/IncomingWebhook/${maskToken(m[2])}/${maskToken(m[3])}`;
      push('teams', masked, 'incoming');
    }
  }

  if (entries.length < MAX_PER_FILE) {
    GH_HOOK_RE.lastIndex = 0;
    while ((m = GH_HOOK_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const masked = `https://api.github.com/repos/${m[1]}/${m[2]}/hooks${m[3] ? '/' + m[3] : ''}`;
      push('github', masked, m[3] ? 'specific' : 'list');
    }
  }

  if (entries.length < MAX_PER_FILE) {
    GENERIC_RE.lastIndex = 0;
    while ((m = GENERIC_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      // Only count generic if not already matched as slack/discord/teams
      if (/hooks\.slack\.com|discord\.com|outlook\.office\.com/.test(m[0])) continue;
      const masked = m[0].replace(m[1], maskToken(m[1]));
      push('generic', masked.slice(0, 120), 'best-effort');
    }
  }

  return { entries, totals, total: entries.length };
}

function buildWebhookUrlsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { slack: 0, discord: 0, teams: 0, github: 0, generic: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractWebhookUrls(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.masked)) continue;
      aggSeen.add(e.masked);
      aggregate.push(e);
      if (totals[e.provider] != null) totals[e.provider] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderWebhookUrlsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## WEBHOOK URLs', '- Token portions masked first-4…last-4 — never echo full secrets'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 6)) {
      lines.push(`- ${e.provider} (${e.context}): \`${e.masked}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractWebhookUrls,
  buildWebhookUrlsForFiles,
  renderWebhookUrlsBlock,
  _internal: { maskToken },
};

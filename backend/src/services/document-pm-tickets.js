'use strict';

/**
 * document-pm-tickets.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects project-management ticket identifiers:
 *
 *   - Jira / Linear / Confluence: PROJ-123 (uppercase project key + dash + N)
 *   - Linear URL: https://linear.app/<team>/issue/<KEY>-<N>
 *   - Asana URL: https://app.asana.com/0/<project>/<task>
 *   - Monday.com URL: https://*.monday.com/boards/<board>/pulses/<pulse>
 *   - Trello URL: https://trello.com/c/<id>/<slug>
 *   - ClickUp URL: https://app.clickup.com/t/<id>
 *   - ShortCut URL: https://app.shortcut.com/<org>/story/<id>
 *
 * Public API:
 *   extractPmTickets(text)             → { entries, totals, total }
 *   buildPmTicketsForFiles(files)      → { perFile, aggregate, totals }
 *   renderPmTicketsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

// Generic PROJECT-N pattern (Jira/Linear short form)
const TICKET_RE = /(?<![A-Za-z0-9-])([A-Z]{2,8})-(\d{1,6})(?![A-Za-z0-9-])/g;
// Reserved English ALL-CAPS words to filter out
const RESERVED = new Set([
  'HTTP', 'HTTPS', 'API', 'URL', 'URI', 'JSON', 'XML', 'YAML', 'TOML',
  'CSS', 'HTML', 'SQL', 'AWS', 'GCP', 'CI', 'CD', 'CDN', 'TLS', 'SSL',
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD',
  'OK', 'IO', 'NS', 'EU', 'US', 'UK', 'NPR', 'BBC', 'CNN', 'FYI',
  'TODO', 'FIXME', 'NOTE', 'HACK', 'XXX', 'WIP',
  'UTC', 'GMT', 'EST', 'PST', 'CET', 'IST',
  'PDF', 'CSV', 'TSV', 'PNG', 'JPG', 'SVG', 'GIF', 'WEBP', 'MP4', 'MP3',
  'RFC', 'ISBN', 'ISO', 'IEEE', 'ANSI', 'WCAG',
]);

const LINEAR_URL_RE = /\bhttps?:\/\/linear\.app\/([a-z0-9-]+)\/issue\/([A-Z]{2,8}-\d{1,6})/g;
const ASANA_URL_RE = /\bhttps?:\/\/app\.asana\.com\/0\/(\d{10,20})\/(\d{10,20})/g;
const MONDAY_URL_RE = /\bhttps?:\/\/[a-z0-9-]+\.monday\.com\/boards\/(\d{6,15})\/pulses\/(\d{6,15})/g;
const TRELLO_URL_RE = /\bhttps?:\/\/trello\.com\/c\/([A-Za-z0-9]{6,12})(?:\/([a-z0-9-]+))?/g;
const CLICKUP_URL_RE = /\bhttps?:\/\/app\.clickup\.com\/t\/([0-9a-z]{6,15})/gi;
const SHORTCUT_URL_RE = /\bhttps?:\/\/app\.shortcut\.com\/([a-z0-9-]+)\/story\/(\d{1,8})/gi;

function classifyTicket(prefix) {
  // Heuristic: 2-4 letter prefix is likely Jira/Linear style
  if (prefix.length >= 2 && prefix.length <= 6) return 'project-key';
  return 'other';
}

function extractPmTickets(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { jira: 0, linear: 0, asana: 0, monday: 0, trello: 0, clickup: 0, shortcut: 0 };

  function push(tool, ref, ctx) {
    const key = `${tool}:${ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ tool, ref, context: ctx });
    if (totals[tool] != null) totals[tool] += 1;
  }

  // Linear URLs (more specific — try first)
  LINEAR_URL_RE.lastIndex = 0;
  let m;
  while ((m = LINEAR_URL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('linear', `${m[1]}/${m[2]}`, 'url');
  }

  if (entries.length < MAX_PER_FILE) {
    ASANA_URL_RE.lastIndex = 0;
    while ((m = ASANA_URL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('asana', `${m[1]}/${m[2]}`, 'url');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    MONDAY_URL_RE.lastIndex = 0;
    while ((m = MONDAY_URL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('monday', `${m[1]}/${m[2]}`, 'url');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    TRELLO_URL_RE.lastIndex = 0;
    while ((m = TRELLO_URL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('trello', m[1], 'card');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    CLICKUP_URL_RE.lastIndex = 0;
    while ((m = CLICKUP_URL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('clickup', m[1], 'task');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    SHORTCUT_URL_RE.lastIndex = 0;
    while ((m = SHORTCUT_URL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('shortcut', `${m[1]}/${m[2]}`, 'story');
    }
  }

  // Generic PROJECT-N
  if (entries.length < MAX_PER_FILE) {
    TICKET_RE.lastIndex = 0;
    while ((m = TICKET_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const prefix = m[1];
      const num = m[2];
      if (RESERVED.has(prefix)) continue;
      const ref = `${prefix}-${num}`;
      push('jira', ref, 'short-key');
    }
  }

  return { entries, totals, total: entries.length };
}

function buildPmTicketsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { jira: 0, linear: 0, asana: 0, monday: 0, trello: 0, clickup: 0, shortcut: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractPmTickets(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.tool}:${e.ref}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.tool] != null) totals[e.tool] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderPmTicketsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## PM TICKET REFERENCES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      lines.push(`- ${e.tool} (${e.context}): \`${e.ref}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractPmTickets,
  buildPmTicketsForFiles,
  renderPmTicketsBlock,
  _internal: { classifyTicket, RESERVED },
};

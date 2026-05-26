'use strict';

/**
 * document-social-urls.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects social-media platform URLs with handles in body text:
 *
 *   - Twitter/X: twitter.com/user, x.com/user, t.me/user
 *   - Instagram: instagram.com/user
 *   - LinkedIn: linkedin.com/in/user
 *   - GitHub: github.com/user, github.com/org/repo
 *   - YouTube: youtube.com/@user, youtube.com/channel/X
 *   - TikTok: tiktok.com/@user
 *   - Facebook: facebook.com/user
 *   - Reddit: reddit.com/u/user, reddit.com/r/sub
 *   - Discord/Telegram/WhatsApp invites
 *
 * Different from document-urls (general URLs) by surfacing platform + handle.
 *
 * Public API:
 *   extractSocialUrls(text)         → SocialReport
 *   buildSocialUrlsForFiles(files)  → { perFile, aggregate, totals }
 *   renderSocialUrlsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;
const MAX_VALUE_LEN = 100;

const PATTERNS = [
  { kind: 'twitter', re: /\b(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]{1,30})/g },
  { kind: 'instagram', re: /\b(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-zA-Z0-9_.]{1,30})/g },
  { kind: 'linkedin', re: /\b(?:https?:\/\/)?(?:www\.)?linkedin\.com\/(?:in|company|pub)\/([a-zA-Z0-9\-]{1,80})/g },
  { kind: 'github', re: /\b(?:https?:\/\/)?(?:www\.)?github\.com\/([a-zA-Z0-9\-_]{1,40}(?:\/[a-zA-Z0-9\-_.]+)?)/g },
  { kind: 'youtube', re: /\b(?:https?:\/\/)?(?:www\.)?youtube\.com\/(@[a-zA-Z0-9_\-]{1,40}|channel\/[A-Za-z0-9_\-]+|c\/[a-zA-Z0-9_\-]+)/g },
  { kind: 'tiktok', re: /\b(?:https?:\/\/)?(?:www\.)?tiktok\.com\/(@[a-zA-Z0-9_.]{1,30})/g },
  { kind: 'facebook', re: /\b(?:https?:\/\/)?(?:www\.)?facebook\.com\/([a-zA-Z0-9.]{2,50})/g },
  { kind: 'reddit', re: /\b(?:https?:\/\/)?(?:www\.)?reddit\.com\/(u|r|user)\/([a-zA-Z0-9_]{1,30})/g },
  { kind: 'telegram', re: /\b(?:https?:\/\/)?t\.me\/([a-zA-Z0-9_]{1,40})/g },
  { kind: 'discord', re: /\b(?:https?:\/\/)?discord\.gg\/([a-zA-Z0-9]{3,16})/g },
];

const KINDS = PATTERNS.map((p) => p.kind);

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipValue(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_VALUE_LEN) return t;
  return `${t.slice(0, MAX_VALUE_LEN - 1)}…`;
}

function emptyTotals() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  return r;
}

function extractSocialUrls(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = emptyTotals();

  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of head.matchAll(re)) {
      if (entries.length >= MAX_PER_FILE) break;
      const handle = kind === 'reddit' ? `${m[1]}/${m[2]}` : m[1];
      const value = clipValue(m[0]);
      const key = `${kind}|${handle.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind, handle, url: value });
      totals[kind] += 1;
    }
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildSocialUrlsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractSocialUrls(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, totals: r.totals });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    for (const k of KINDS) totals[k] += r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- [${e.kind}] **${e.handle}** ← \`${e.url}\`${file}`;
}

function renderSocialUrlsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## SOCIAL MEDIA URLS / HANDLES
Social-media platform URLs with extracted handles: Twitter/X, Instagram, LinkedIn, GitHub, YouTube, TikTok, Facebook, Reddit (user/sub), Telegram, Discord. Different from generic URL extractor by surfacing platform + handle pair. Routes "what social accounts?" / "what handles?" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate social URLs across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...social URLs block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractSocialUrls,
  buildSocialUrlsForFiles,
  renderSocialUrlsBlock,
  _internal: {
    PATTERNS,
    KINDS,
  },
};

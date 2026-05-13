'use strict';

/**
 * document-hashtags.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects social-media-style hashtags and handles in documents:
 *
 *   - Hashtags: #ai, #LaunchDay, #🎯event (alpha + emoji)
 *   - Handles: @username (Twitter/Mastodon-style), @org.bsky.social,
 *     @user@instance.example (Fediverse)
 *
 * Different from document-env-vars (#FOO_BAR or SCREAMING_SNAKE),
 * document-pii-detector (which catches PII handles in safety context),
 * and document-headings (markdown headers). Routes "what hashtags?",
 * "who's mentioned?" to a citeable list.
 *
 * Public API:
 *   extractHashtags(text)          → HashtagReport
 *   buildHashtagsForFiles(files)   → { perFile, aggregate, totals }
 *   renderHashtagsBlock(report)    → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_KIND = 16;
const MAX_PER_FILE = 30;
const MAX_AGGREGATE = 36;
const MAX_BLOCK_CHARS = 5000;
const MAX_VALUE_LEN = 50;

// #tag: must start with #, then alpha/digit/underscore, length 2-50
// Exclude pure-digit tags (#1, #2 are not real hashtags) and CSS color #ff5733
const HASHTAG_RE = /(?:^|[\s`'"<>(,;:])#([\p{L}_][\p{L}\p{N}_]{1,49})(?=[\s`'"<>):,;.!?]|$)/gu;
// @handle: @user, @user.subdomain, @user@instance.tld
const HANDLE_RE = /(?:^|[\s`'"<>(,;:])(@[a-zA-Z0-9_]{2,30}(?:\.[a-zA-Z0-9_]{2,30})*(?:@[a-zA-Z0-9_.\-]{3,80})?)(?=[\s`'"<>):,;.!?]|$)/g;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipValue(v) {
  const s = String(v || '').trim();
  if (s.length <= MAX_VALUE_LEN) return s;
  return `${s.slice(0, MAX_VALUE_LEN - 1)}…`;
}

function emptyTotals() {
  return { hashtag: 0, handle: 0 };
}

function extractHashtags(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = emptyTotals();

  function add(kind, value) {
    if (entries.length >= MAX_PER_FILE) return;
    if (totals[kind] >= MAX_PER_KIND) return;
    const v = clipValue(value);
    if (!v) return;
    const key = `${kind}|${v.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, value: v });
    totals[kind] += 1;
  }

  for (const m of head.matchAll(HASHTAG_RE)) {
    add('hashtag', `#${m[1]}`);
  }
  for (const m of head.matchAll(HANDLE_RE)) {
    add('handle', m[1]);
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildHashtagsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractHashtags(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, totals: r.totals });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    for (const k of Object.keys(totals)) totals[k] += r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- [${e.kind}] \`${e.value}\`${file}`;
}

function renderHashtagsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = Object.keys(totals)
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## HASHTAGS & HANDLES
Social-style hashtags (#tag) and handles (@user, @user.example.bsky, @user@instance.tld for Fediverse) detected in the document(s). Different from env vars and PII handles in safety context. Routes "what hashtags?" / "who's mentioned?" to a citeable list.

**Totals:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate hashtags/handles across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...hashtags block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractHashtags,
  buildHashtagsForFiles,
  renderHashtagsBlock,
  _internal: {
    HASHTAG_RE,
    HANDLE_RE,
  },
};
